"""Archiver: moves video into object storage and enforces retention.

Three loops in one process:

  clips     every ANPR event gets a short MP4 (CLIP_BEFORE_S before the first read to
            CLIP_AFTER_S after it) cut by the relay's playback server from its on-disk
            segment buffer, plus the plate crop and annotated frame. Keys are written back
            to the event row (clip_key / crop_key / frame_key) so the API can hand out links.
  segments  completed recording segments on the relay's local buffer are copied to
            recordings/<department>/<camera>/<profile>/<day>/<start>.mp4 and registered in
            the `recordings` table. The relay deletes its local copy after RECORD_LOCAL_KEEP.
  retention hourly: objects older than the department's retention (config/rules.yaml
            `retention:`) are deleted from the bucket and from the tables.

Nothing here talks to a departmental system: it reads only the platform's own relay and
the platform's own files.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import re
import subprocess
import threading
import time
from pathlib import Path

from sqlalchemy import select

from ..config import load_yaml, settings
from ..db import AnprEvent, AuditLog, Camera, LegalHold, Recording, SessionLocal, audit, init_db, utcnow
from ..relay import path_name, relay
from .. import metrics as M
from ..storage import delete_prefix, describe, store

log = logging.getLogger("uvp.archiver")

SEG_RE = re.compile(r"(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})\.mp4$")   # relay runs with TZ=UTC


def _safe(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", s)


# ----------------------------------------------------------------------------- event clips
def archive_events(limit: int = 50) -> int:
    """Attach clip/crop/frame objects to events that do not have them yet."""
    st = store()
    # a clip can only be cut once the segment covering it has been flushed: wait a little
    ready_before = utcnow() - dt.timedelta(seconds=settings.clip_after_s + 8)
    done = 0
    with SessionLocal() as s:
        rows = s.scalars(select(AnprEvent).where(AnprEvent.clip_key == "", AnprEvent.ts < ready_before)
                         .order_by(AnprEvent.ts.desc()).limit(limit)).all()
        cams = {c.id: c for c in s.scalars(select(Camera)).all()}
        for ev in rows:
            day = ev.ts.strftime("%Y-%m-%d")
            base = f"{_safe(ev.department)}/{_safe(ev.camera_id)}/{day}/{ev.id}"
            for attr, path_attr, suffix in (("crop_key", "crop_path", "_plate.jpg"), ("frame_key", "frame_path", "_frame.jpg")):
                local = settings.data_dir / getattr(ev, path_attr) if getattr(ev, path_attr) else None
                if local and local.exists():
                    key = f"crops/{base}{suffix}"
                    st.put_file(local, key, "image/jpeg")
                    setattr(ev, attr, key)
                else:
                    setattr(ev, attr, "-")
            cam = cams.get(ev.camera_id)
            ev.clip_key = "-"
            if cam is not None:  # live camera (file-mode analysis has nothing to cut a clip from)
                start = ev.ts - dt.timedelta(seconds=settings.clip_before_s)
                dur = settings.clip_before_s + settings.clip_after_s + 2
                try:
                    data = relay.clip(path_name(ev.camera_id, "main"), start, dur)
                except Exception as e:  # noqa: BLE001
                    log.warning("clip for %s failed: %s", ev.id, e)
                    data = None
                if data:
                    key = f"clips/{base}.mp4"
                    st.put_bytes(data, key, "video/mp4")
                    ev.clip_key = key
                    M.ARCHIVE_OBJECTS.labels("clip").inc()
                    M.ARCHIVE_BYTES.labels("clip").inc(len(data))
            done += 1
        backlog = s.query(AnprEvent).filter(AnprEvent.clip_key == "").count()
        M.ARCHIVE_BACKLOG.set(backlog)
        s.commit()
    if done:
        log.info("archived %d events", done)
    return done


# ----------------------------------------------------------------------------- recorded segments
def _segment_start(name: str) -> dt.datetime | None:
    m = SEG_RE.search(name)
    if not m:
        return None
    d, hh, mm, ss, us = m.groups()
    return dt.datetime.fromisoformat(f"{d}T{hh}:{mm}:{ss}.{us}").replace(tzinfo=dt.timezone.utc)


def _probe_duration(p: Path) -> float:
    """Segment length via ffprobe when available, else the configured segment duration."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                             capture_output=True, text=True, timeout=20).stdout.strip()
        if out:
            return round(float(out), 3)
    except Exception:  # noqa: BLE001
        pass
    return float(settings.record_segment_s)


def archive_segments() -> int:
    """Copy completed segments from the relay buffer to object storage (idempotent)."""
    root = settings.recordings_dir
    if not root.exists():
        return 0
    st = store()
    settle = settings.record_segment_s + 15     # a file older than one segment length is complete
    now = time.time()
    done = 0
    with SessionLocal() as s:
        known = {k for (k,) in s.execute(select(Recording.key))}
        cams = {c.id: c for c in s.scalars(select(Camera)).all()}
        for f in sorted(root.rglob("*.mp4")):
            start = _segment_start(f.name)
            if start is None or now - f.stat().st_mtime < settle:
                continue
            rel = f.relative_to(root).parts            # <camera>/<profile>/<file>  or  <relay>/<camera>/<profile>/<file> (cluster)
            if len(rel) == 4:
                rel = rel[1:]
            if len(rel) != 3:
                continue
            cam_id, profile = rel[0], rel[1]
            cam = cams.get(cam_id)
            dept = cam.department if cam else "unknown"
            key = f"recordings/{_safe(dept)}/{_safe(cam_id)}/{profile}/{start:%Y-%m-%d}/{start:%H-%M-%S}.mp4"
            if key in known:
                continue
            size = st.put_file(f, key, "video/mp4")
            M.ARCHIVE_OBJECTS.labels("recording").inc()
            M.ARCHIVE_BYTES.labels("recording").inc(size)
            s.add(Recording(camera_id=cam_id, department=dept, profile=profile, start_ts=start,
                            duration_s=_probe_duration(f), key=key, bytes=size))
            s.commit()
            known.add(key)
            done += 1
    if done:
        log.info("archived %d segments", done)
    return done


# ----------------------------------------------------------------------------- retention + legal hold
def retention_policy() -> dict:
    cfg = load_yaml(settings.rules_file).get("retention") or {}
    default = {"recordings_days": 30, "clips_days": 90, "crops_days": 90, "events_days": 90, "audit_days": 180,
               **(cfg.get("default") or {})}
    default["audit_days"] = max(180, int(default["audit_days"]))   # CERT-In direction 2022: logs kept >= 180 days
    return {"default": default, **{k: {**default, **(v or {})} for k, v in cfg.items() if k != "default"}}


def _active_holds(s) -> list:
    return list(s.scalars(select(LegalHold).where(LegalHold.released_at.is_(None))))


def _event_held(ev: AnprEvent, holds: list) -> bool:
    for h in holds:
        if h.kind == "plate" and h.value == ev.plate:
            return True
        if h.kind == "event" and h.value == ev.id:
            return True
        if h.kind == "camera" and h.value == ev.camera_id and (h.from_ts is None or ev.ts >= h.from_ts) and \
                (h.to_ts is None or ev.ts <= h.to_ts):
            return True
    return False


def _recording_held(r: Recording, holds: list) -> bool:
    for h in holds:
        if h.kind == "camera" and h.value == r.camera_id and (h.from_ts is None or r.start_ts + dt.timedelta(seconds=r.duration_s) >= h.from_ts) \
                and (h.to_ts is None or r.start_ts <= h.to_ts):
            return True
    return False


def apply_retention() -> dict:
    """Delete what is older than the department's policy, except records under legal hold."""
    pol = retention_policy()
    now = utcnow()
    removed: dict[str, int] = {}
    st = store()
    with SessionLocal() as s:
        holds = _active_holds(s)
        depts = {d for (d,) in s.execute(select(Camera.department).distinct())}
        depts |= {d for (d,) in s.execute(select(AnprEvent.department).distinct())}
        for dept in depts:
            p = pol.get(dept, pol["default"])
            # recordings
            cutoff = now - dt.timedelta(days=float(p["recordings_days"]))
            for r in s.scalars(select(Recording).where(Recording.department == dept, Recording.start_ts < cutoff)):
                if _recording_held(r, holds):
                    continue
                try:
                    st.delete(r.key)
                except Exception:  # noqa: BLE001
                    pass
                s.delete(r)
                removed[f"{dept}/recordings"] = removed.get(f"{dept}/recordings", 0) + 1
            # clips / crops on events that stay, then whole events
            cut_clip = now - dt.timedelta(days=float(p["clips_days"]))
            cut_crop = now - dt.timedelta(days=float(p["crops_days"]))
            cut_ev = now - dt.timedelta(days=float(p["events_days"]))
            oldest = min(cut_clip, cut_crop, cut_ev)
            for ev in s.scalars(select(AnprEvent).where(AnprEvent.department == dept, AnprEvent.ts < oldest)):
                if _event_held(ev, holds):
                    continue
                if ev.ts < cut_ev:
                    for k in (ev.clip_key, ev.crop_key, ev.frame_key):
                        if k and k != "-":
                            try:
                                st.delete(k)
                            except Exception:  # noqa: BLE001
                                pass
                    for rel in (ev.crop_path, ev.frame_path):
                        fp = settings.data_dir / rel if rel else None
                        if fp and fp.exists():
                            fp.unlink()
                    s.delete(ev)
                    removed[f"{dept}/events"] = removed.get(f"{dept}/events", 0) + 1
                    continue
                if ev.ts < cut_clip and ev.clip_key not in ("", "-"):
                    try:
                        st.delete(ev.clip_key)
                    except Exception:  # noqa: BLE001
                        pass
                    ev.clip_key = "-"
                    removed[f"{dept}/clips"] = removed.get(f"{dept}/clips", 0) + 1
                if ev.ts < cut_crop:
                    for attr in ("crop_key", "frame_key"):
                        k = getattr(ev, attr)
                        if k and k != "-":
                            try:
                                st.delete(k)
                            except Exception:  # noqa: BLE001
                                pass
                            setattr(ev, attr, "-")
                            removed[f"{dept}/crops"] = removed.get(f"{dept}/crops", 0) + 1
        # events index (Elasticsearch) and audit log
        try:
            from ..search import backend
            backend().delete_older_than(now - dt.timedelta(days=float(pol["default"]["events_days"])))
        except Exception:  # noqa: BLE001
            pass
        cut_audit = now - dt.timedelta(days=float(pol["default"]["audit_days"]))
        n = s.query(AuditLog).filter(AuditLog.ts < cut_audit).count()
        if n:
            # keep the chain verifiable: only trim from the head, and record the trim itself
            for r in s.scalars(select(AuditLog).where(AuditLog.ts < cut_audit)):
                s.delete(r)
            removed["audit"] = n
            audit(s, "archiver", "audit_trim", "", f"rows={n} older_than={cut_audit.date()}")
        s.commit()
    if removed:
        for k, n in removed.items():
            M.RETENTION_REMOVED.labels(k.split("/")[-1]).inc(n)
        log.info("retention removed %s", removed)
    return removed


# ----------------------------------------------------------------------------- main
def _loop(fn, every: float) -> None:
    while True:
        try:
            fn()
        except Exception:  # noqa: BLE001
            log.exception("%s failed", fn.__name__)
        time.sleep(every)


_last_weekly = ""
_last_usage = ""


def scheduled_reports() -> None:
    """Monday: last week's ANPR accuracy report (+ notification route kind 'report'); daily: licence usage."""
    global _last_weekly, _last_usage
    today = utcnow().date()
    key = today.isoformat()
    if today.weekday() == 0 and _last_weekly != key:
        _last_weekly = key
        from ..notify import notify
        from ..reports import save_weekly
        p = save_weekly(1)
        rep = json.loads(p.read_text())
        notify("report", {"id": p.stem, "department": "*", "ts": utcnow().isoformat(), "priority": "low",
                          "subject": f"ANPR weekly report {rep['week_start']}", "reads": rep["reads"], "reviewed": rep["reviewed"],
                          "accuracy_pct": rep["accuracy_pct"], "path": str(p)})
        log.info("weekly ANPR report written: %s", p)
    if _last_usage != key:
        _last_usage = key
        from .. import licensing
        licensing.report_usage()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    init_db()
    M.serve()
    threading.Thread(target=_loop, args=(scheduled_reports, 600), daemon=True).start()
    log.info("archiver: %s; recordings buffer %s; record mode %s", describe(), settings.recordings_dir,
             settings.record_mode)
    threading.Thread(target=_loop, args=(archive_events, settings.archive_interval_s), daemon=True).start()
    threading.Thread(target=_loop, args=(archive_segments, settings.archive_interval_s), daemon=True).start()
    _loop(apply_retention, 3600)


if __name__ == "__main__":
    main()
