"""Archival policy system: how long each class of data is kept, and what happens to it afterwards.

Policies (table archival_policies, edited from Admin -> Archival) say per data class, optionally per department:
  keep_days   how long rows / objects stay hot
  action      delete  - remove rows and objects
              archive - copy objects to the cold prefix (`<ARCHIVAL_COLD_PREFIX>/...`, optional cold storage class)
                        and write the removed rows as gzip JSON-lines under `<prefix>/<class>/<date>/<run>.jsonl.gz`
                        in object storage before removing them from the database
  enabled     a disabled class is left alone

Defaults come from config/rules.yaml `retention:` (the pre-1.6 mechanism, still honoured) and the table below.
Legal holds always win: a held plate / event / camera window is skipped and counted in the run's `held`.
The audit log is never trimmed below 180 days (CERT-In directions, 2022) and every trim is itself audited.

The archiver service runs `tick()` every few minutes and executes one run per day at ARCHIVAL_HOUR_IST (02:00
by default); Admin -> Archival -> "Run now" executes `run("manual", user)` in the API process. Every run is
recorded in archival_runs (what was removed / archived / held, errors) and ends with a notification.
"""
from __future__ import annotations

import datetime as dt
import gzip
import io
import json
import logging
import threading

from sqlalchemy import func, select

from . import metrics as M
from .config import load_yaml, settings
from .db import (Alert, AnprEvent, ArchivalPolicy, ArchivalRun, AuditLog, Camera, CameraQuality, CameraStatusLog, Inbox,
                 InboxRead, Incident, LegalHold, Notification, Recording, SessionLocal, TrafficCount, audit, get_setting,
                 set_setting, utcnow)
from .storage import store

log = logging.getLogger("uvp.archival")
IST = dt.timezone(dt.timedelta(minutes=330))
AUDIT_MIN_DAYS = 180

# data class -> defaults. `yaml` = key in rules.yaml retention; `objects` = has object-storage payload
CLASSES: dict[str, dict] = {
    "recordings":    {"label": "Recorded video segments", "detail": "Continuous recordings of cameras with record: on (object storage)", "days": 30, "yaml": "recordings_days", "objects": True, "archive": True},
    "clips":         {"label": "Event clips", "detail": "10-second clip saved with each plate read / incident", "days": 90, "yaml": "clips_days", "objects": True, "archive": True},
    "crops":         {"label": "Plate crops & evidence frames", "detail": "Plate crop and full frame JPEGs of each read", "days": 90, "yaml": "crops_days", "objects": True, "archive": True},
    "events":        {"label": "Plate-read events", "detail": "ANPR metadata rows (plate, camera, time, attributes) and the search index", "days": 365, "yaml": "events_days", "objects": False, "archive": True},
    "alerts":        {"label": "Alerts", "detail": "Watchlist hits and challan suggestions", "days": 365, "objects": False, "archive": True},
    "incidents":     {"label": "Analytics incidents", "detail": "Crowd, intrusion, parking, red-light and other incidents with snapshots", "days": 180, "objects": False, "archive": True},
    "counts":        {"label": "Traffic & crowd counts", "detail": "Per-minute vehicle / person counts per camera", "days": 365, "objects": False, "archive": True},
    "camera_logs":   {"label": "Camera status & quality samples", "detail": "Online / offline transitions and image-quality samples", "days": 90, "objects": False, "archive": False},
    "uploads":       {"label": "Uploaded media & analyses", "detail": "Videos / photos analysed in Upload & recognise, with their crops", "days": 30, "objects": False, "archive": False},
    "notifications": {"label": "Notifications", "detail": "In-console notifications and the email / SMS / webhook delivery log", "days": 90, "objects": False, "archive": False},
    "audit":         {"label": "Audit log", "detail": f"Hash-chained audit trail; never below {AUDIT_MIN_DAYS} days (CERT-In)", "days": 365, "yaml": "audit_days", "objects": False, "archive": True, "min_days": AUDIT_MIN_DAYS},
}
ACTIONS = ("delete", "archive")
_run_lock = threading.Lock()
_last_tick_day = ""


# ----------------------------------------------------------------------------- policies
def _yaml_defaults() -> dict:
    cfg = load_yaml(settings.rules_file).get("retention") or {}
    base = dict(cfg.get("default") or {})
    per_dept = {k: dict(v or {}) for k, v in cfg.items() if k != "default"}
    return {"default": base, "departments": per_dept}


def policies(s) -> list[dict]:
    """Effective policy rows: one per class for '*' plus any department overrides. Each says where it came from."""
    y = _yaml_defaults()
    rows = {(r.data_class, r.department): r for r in s.scalars(select(ArchivalPolicy))}
    out = []
    for cls, meta in CLASSES.items():
        days = int(y["default"].get(meta.get("yaml", ""), meta["days"]))
        base = {"data_class": cls, "department": "*", "keep_days": days, "action": "delete", "enabled": True, "source": "default",
                "label": meta["label"], "detail": meta["detail"], "min_days": meta.get("min_days", 1), "can_archive": meta["archive"],
                "objects": meta["objects"], "updated_by": "", "updated_at": None}
        r = rows.get((cls, "*"))
        if r is not None:
            base.update(keep_days=r.keep_days, action=r.action, enabled=bool(r.enabled), source="console", updated_by=r.updated_by,
                        updated_at=r.updated_at.isoformat() if r.updated_at else None)
        base["keep_days"] = max(base["min_days"], base["keep_days"])
        out.append(base)
        seen = set()
        for (c, d), r in rows.items():
            if c == cls and d != "*":
                seen.add(d)
                out.append({**base, "department": d, "keep_days": max(base["min_days"], r.keep_days), "action": r.action, "enabled": bool(r.enabled),
                            "source": "console", "updated_by": r.updated_by, "updated_at": r.updated_at.isoformat() if r.updated_at else None})
        for d, v in y["departments"].items():
            if d not in seen and meta.get("yaml") in v:
                out.append({**base, "department": d, "keep_days": max(base["min_days"], int(v[meta["yaml"]])), "source": "rules.yaml"})
    return out


def policy_for(pols: list[dict], cls: str, dept: str) -> dict:
    by = {(p["data_class"], p["department"]): p for p in pols}
    return by.get((cls, dept)) or by[(cls, "*")]


def set_policy(s, cls: str, *, keep_days: int, action: str = "delete", enabled: bool = True, department: str = "*", actor: str = "") -> dict:
    if cls not in CLASSES:
        raise ValueError(f"unknown data class {cls!r}; one of {', '.join(CLASSES)}")
    if action not in ACTIONS:
        raise ValueError("action must be delete or archive")
    meta = CLASSES[cls]
    if action == "archive" and not meta["archive"]:
        raise ValueError(f"{meta['label']} cannot be archived, only deleted")
    lo = meta.get("min_days", 1)
    if keep_days < lo:
        raise ValueError(f"{meta['label']}: keep at least {lo} days")
    if keep_days > 3650:
        raise ValueError("keep_days: at most 3650 (10 years)")
    department = (department or "*").strip() or "*"
    r = s.get(ArchivalPolicy, (cls, department))
    if r is None:
        r = ArchivalPolicy(data_class=cls, department=department)
        s.add(r)
    r.keep_days, r.action, r.enabled, r.updated_by, r.updated_at = int(keep_days), action, bool(enabled), actor, utcnow()
    s.flush()
    return policy_for(policies(s), cls, department)


def delete_policy(s, cls: str, department: str) -> bool:
    """Remove a console override (falls back to defaults). Returns whether a row existed."""
    r = s.get(ArchivalPolicy, (cls, department or "*"))
    if r is None:
        return False
    s.delete(r)
    s.flush()
    return True


# ----------------------------------------------------------------------------- usage + preview
def _cutoff(days: float) -> dt.datetime:
    return utcnow() - dt.timedelta(days=float(days))


def usage(s) -> dict:
    """What is held per class right now: rows, oldest, bytes where known."""
    def one(model, ts_col):
        n, oldest = s.execute(select(func.count(), func.min(ts_col)).select_from(model)).one()
        return {"rows": int(n or 0), "oldest": oldest.isoformat() if oldest else None}
    rec = one(Recording, Recording.start_ts)
    rec["bytes"] = int(s.scalar(select(func.coalesce(func.sum(Recording.bytes), 0))) or 0)
    ev = one(AnprEvent, AnprEvent.ts)
    clips = int(s.scalar(select(func.count()).select_from(AnprEvent).where(AnprEvent.clip_key.not_in(["", "-"]))) or 0)
    crops = int(s.scalar(select(func.count()).select_from(AnprEvent).where(AnprEvent.crop_key.not_in(["", "-"]))) or 0)
    cam_logs = one(CameraStatusLog, CameraStatusLog.ts)
    cam_logs["rows"] += int(s.scalar(select(func.count()).select_from(CameraQuality)) or 0)
    notif = one(Inbox, Inbox.ts)
    notif["rows"] += int(s.scalar(select(func.count()).select_from(Notification)) or 0)
    up_rows, up_oldest, up_bytes = _uploads_usage()
    return {"recordings": rec, "clips": {"rows": clips, "oldest": ev["oldest"]}, "crops": {"rows": crops, "oldest": ev["oldest"]},
            "events": ev, "alerts": one(Alert, Alert.ts), "incidents": one(Incident, Incident.ts), "counts": one(TrafficCount, TrafficCount.ts),
            "camera_logs": cam_logs, "uploads": {"rows": up_rows, "oldest": up_oldest, "bytes": up_bytes}, "notifications": notif,
            "audit": one(AuditLog, AuditLog.ts)}


def _uploads_usage():
    d = settings.data_dir / "analyses"
    if not d.exists():
        return 0, None, 0
    n, oldest, total = 0, None, 0
    for j in d.iterdir():
        if not j.is_dir():
            continue
        n += 1
        m = j.stat().st_mtime
        oldest = m if oldest is None or m < oldest else oldest
        total += sum(f.stat().st_size for f in j.rglob("*") if f.is_file())
    return n, dt.datetime.fromtimestamp(oldest, dt.timezone.utc).isoformat() if oldest else None, total


def preview(s) -> dict:
    """Rows a run would act on now, per class (holds are evaluated during the run itself)."""
    pols = policies(s)
    depts = {d for (d,) in s.execute(select(Camera.department).distinct())} | {d for (d,) in s.execute(select(AnprEvent.department).distinct())}
    out: dict[str, dict] = {}

    def add(cls, n, action):
        o = out.setdefault(cls, {"due": 0, "action": action, "enabled": True})
        o["due"] += int(n or 0)

    for cls in CLASSES:
        p = policy_for(pols, cls, "*")
        out[cls] = {"due": 0, "action": p["action"], "enabled": p["enabled"], "keep_days": p["keep_days"]}
    for dept in depts or {"*"}:
        for cls, model, col, extra in (("recordings", Recording, Recording.start_ts, Recording.department),
                                        ("events", AnprEvent, AnprEvent.ts, AnprEvent.department),
                                        ("alerts", Alert, Alert.ts, Alert.department), ("incidents", Incident, Incident.ts, Incident.department),
                                        ("counts", TrafficCount, TrafficCount.ts, TrafficCount.department)):
            p = policy_for(pols, cls, dept)
            if not p["enabled"]:
                continue
            n = s.scalar(select(func.count()).select_from(model).where(extra == dept, col < _cutoff(p["keep_days"])))
            add(cls, n, p["action"])
        for cls, key in (("clips", AnprEvent.clip_key), ("crops", AnprEvent.crop_key)):
            p = policy_for(pols, cls, dept)
            if not p["enabled"]:
                continue
            n = s.scalar(select(func.count()).select_from(AnprEvent).where(AnprEvent.department == dept, AnprEvent.ts < _cutoff(p["keep_days"]), key.not_in(["", "-"])))
            add(cls, n, p["action"])
    for cls, models in (("camera_logs", ((CameraStatusLog, CameraStatusLog.ts), (CameraQuality, CameraQuality.ts))),
                        ("notifications", ((Inbox, Inbox.ts), (Notification, Notification.ts))), ("audit", ((AuditLog, AuditLog.ts),))):
        p = policy_for(pols, cls, "*")
        if p["enabled"]:
            for model, col in models:
                add(cls, s.scalar(select(func.count()).select_from(model).where(col < _cutoff(p["keep_days"]))), p["action"])
    p = policy_for(pols, "uploads", "*")
    if p["enabled"]:
        add("uploads", len(_old_uploads(p["keep_days"])), p["action"])
    return out


def _old_uploads(days: float) -> list:
    d = settings.data_dir / "analyses"
    if not d.exists():
        return []
    cut = (utcnow() - dt.timedelta(days=float(days))).timestamp()
    return [j for j in d.iterdir() if j.is_dir() and j.stat().st_mtime < cut]


# ----------------------------------------------------------------------------- holds
def _active_holds(s) -> list:
    return list(s.scalars(select(LegalHold).where(LegalHold.released_at.is_(None))))


def _event_held(ev: AnprEvent, holds: list) -> bool:
    for h in holds:
        if h.kind == "plate" and h.value == ev.plate:
            return True
        if h.kind == "event" and h.value == ev.id:
            return True
        if h.kind == "camera" and h.value == ev.camera_id and (h.from_ts is None or ev.ts >= h.from_ts) and (h.to_ts is None or ev.ts <= h.to_ts):
            return True
    return False


def _recording_held(r: Recording, holds: list) -> bool:
    for h in holds:
        if h.kind == "camera" and h.value == r.camera_id and (h.from_ts is None or r.start_ts + dt.timedelta(seconds=r.duration_s) >= h.from_ts) \
                and (h.to_ts is None or r.start_ts <= h.to_ts):
            return True
    return False


def _row_held(row, holds: list) -> bool:
    plate = getattr(row, "plate", "") or ""
    cam = getattr(row, "camera_id", "") or ""
    ts = getattr(row, "ts", None)
    for h in holds:
        if h.kind == "plate" and plate and h.value == plate:
            return True
        if h.kind == "camera" and cam and h.value == cam and (h.from_ts is None or ts is None or ts >= h.from_ts) and (h.to_ts is None or ts is None or ts <= h.to_ts):
            return True
    return False


# ----------------------------------------------------------------------------- the run
class _Run:
    def __init__(self, run_id: str):
        self.id = run_id
        self.removed: dict[str, int] = {}
        self.archived: dict[str, int] = {}
        self.held = 0
        self.errors: list[str] = []
        self.st = store()
        self.day = utcnow().date().isoformat()
        self._jsonl: dict[str, list] = {}

    def count(self, bucket: dict, key: str, n: int = 1) -> None:
        bucket[key] = bucket.get(key, 0) + n

    def cold_key(self, key: str) -> str:
        return f"{settings.archival_cold_prefix.strip('/')}/{key}"

    def move_object(self, key: str, cls: str, dept: str, archive: bool) -> None:
        """Delete an object, copying it to the cold prefix first when archiving."""
        if not key or key == "-":
            return
        try:
            if archive and self.st.copy(key, self.cold_key(key)):
                self.count(self.archived, f"{dept}/{cls}")
            self.st.delete(key)
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"{cls} {key}: {e}"[:200])

    def export_row(self, cls: str, row) -> None:
        """Queue one row for the JSON-lines export of this class (written at flush)."""
        d = {}
        for c in row.__table__.columns:
            v = getattr(row, c.name)
            d[c.name] = v.isoformat() if isinstance(v, dt.datetime) else v
        self._jsonl.setdefault(cls, []).append(d)

    def flush_exports(self) -> None:
        for cls, rows in self._jsonl.items():
            if not rows:
                continue
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
                for d in rows:
                    gz.write((json.dumps(d, default=str) + "\n").encode())
            key = f"{settings.archival_cold_prefix.strip('/')}/{cls}/{self.day}/{self.id}.jsonl.gz"
            try:
                self.st.put_bytes(buf.getvalue(), key, "application/gzip")
                self.count(self.archived, f"rows/{cls}", len(rows))
            except Exception as e:  # noqa: BLE001
                self.errors.append(f"export {cls}: {e}"[:200])
        self._jsonl.clear()


def run(trigger: str = "schedule", by: str = "archiver") -> dict:
    """Apply every enabled policy once. Returns the run as a dict (also stored in archival_runs)."""
    with _run_lock:
        with SessionLocal() as s:
            rr = ArchivalRun(trigger=trigger, by=by)
            s.add(rr)
            s.commit()
            run_id = rr.id
        R = _Run(run_id)
        try:
            _execute(R)
            status = "ok" if not R.errors else "error"
        except Exception as e:  # noqa: BLE001
            log.exception("archival run failed")
            R.errors.append(str(e)[:300])
            status = "error"
        with SessionLocal() as s:
            rr = s.get(ArchivalRun, run_id)
            rr.finished_at, rr.status, rr.removed, rr.archived, rr.held = utcnow(), status, R.removed, R.archived, R.held
            rr.detail = "\n".join(R.errors[:50])
            # keep one year of run history
            for old in s.scalars(select(ArchivalRun).where(ArchivalRun.started_at < _cutoff(365))):
                s.delete(old)
            s.commit()
            out = run_dict(rr)
        for k, n in R.removed.items():
            try:
                M.RETENTION_REMOVED.labels(k.split("/")[-1]).inc(n)
            except Exception:  # noqa: BLE001
                pass
        total = sum(R.removed.values())
        if total or R.errors or trigger == "manual":
            try:
                from .inbox import push
                push("archival", f"Archival run {'finished' if status == 'ok' else 'finished with errors'}: {total} record(s) removed",
                     ", ".join(f"{k} {v}" for k, v in sorted(R.removed.items())[:12]) + (f" · {R.held} held by legal hold" if R.held else "")
                     + (f" · {len(R.errors)} error(s)" if R.errors else ""), severity="warn" if R.errors else "info", ref_id=run_id,
                     link="admin", feature="admin")
            except Exception:  # noqa: BLE001
                pass
        log.info("archival run %s (%s): removed=%s archived=%s held=%d errors=%d", run_id, trigger, R.removed, R.archived, R.held, len(R.errors))
        return out


def run_dict(r: ArchivalRun) -> dict:
    return {"id": r.id, "started_at": r.started_at.isoformat(), "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "trigger": r.trigger, "by": r.by, "status": r.status, "removed": r.removed or {}, "archived": r.archived or {}, "held": r.held,
            "detail": r.detail or "", "removed_total": sum((r.removed or {}).values())}


def _execute(R: _Run) -> None:
    with SessionLocal() as s:
        pols = policies(s)
        holds = _active_holds(s)
        depts = {d for (d,) in s.execute(select(Camera.department).distinct())} | {d for (d,) in s.execute(select(AnprEvent.department).distinct())}
        depts |= {d for (d,) in s.execute(select(Incident.department).distinct())} | {d for (d,) in s.execute(select(Recording.department).distinct())}
        for dept in sorted(depts):
            _dept_classes(s, R, pols, holds, dept)
            s.commit()
        # department-less classes
        p = policy_for(pols, "camera_logs", "*")
        if p["enabled"]:
            cut = _cutoff(p["keep_days"])
            for model in (CameraStatusLog, CameraQuality):
                n = s.query(model).filter(model.ts < cut).delete(synchronize_session=False)
                if n:
                    R.count(R.removed, "camera_logs", n)
        p = policy_for(pols, "notifications", "*")
        if p["enabled"]:
            cut = _cutoff(p["keep_days"])
            old_ids = [i for (i,) in s.execute(select(Inbox.id).where(Inbox.ts < cut))]
            if old_ids:
                for i in range(0, len(old_ids), 500):
                    chunk = old_ids[i:i + 500]
                    s.query(InboxRead).filter(InboxRead.inbox_id.in_(chunk)).delete(synchronize_session=False)
                    s.query(Inbox).filter(Inbox.id.in_(chunk)).delete(synchronize_session=False)
                R.count(R.removed, "notifications", len(old_ids))
            n = s.query(Notification).filter(Notification.ts < cut).delete(synchronize_session=False)
            if n:
                R.count(R.removed, "notifications", n)
        p = policy_for(pols, "uploads", "*")
        if p["enabled"]:
            import shutil
            for j in _old_uploads(p["keep_days"]):
                try:
                    shutil.rmtree(j)
                    R.count(R.removed, "uploads")
                except Exception as e:  # noqa: BLE001
                    R.errors.append(f"uploads {j.name}: {e}"[:200])
        # search index follows the default events policy
        try:
            from .search import backend
            backend().delete_older_than(_cutoff(policy_for(pols, "events", "*")["keep_days"]))
        except Exception:  # noqa: BLE001
            pass
        # audit: trim only from the head, export first when archiving, and record the trim itself
        p = policy_for(pols, "audit", "*")
        if p["enabled"]:
            cut = _cutoff(max(AUDIT_MIN_DAYS, p["keep_days"]))
            rows = s.scalars(select(AuditLog).where(AuditLog.ts < cut).order_by(AuditLog.id)).all()
            if rows:
                if p["action"] == "archive":
                    for r in rows:
                        R.export_row("audit", r)
                    R.flush_exports()
                for r in rows:
                    s.delete(r)
                R.count(R.removed, "audit", len(rows))
                audit(s, "archiver", "audit_trim", "", f"rows={len(rows)} older_than={cut.date()} run={R.id} action={p['action']}")
        s.commit()
        R.flush_exports()


def _dept_classes(s, R: _Run, pols: list[dict], holds: list, dept: str) -> None:
    # recordings
    p = policy_for(pols, "recordings", dept)
    if p["enabled"]:
        arch = p["action"] == "archive"
        for r in s.scalars(select(Recording).where(Recording.department == dept, Recording.start_ts < _cutoff(p["keep_days"]))):
            if _recording_held(r, holds):
                R.held += 1
                continue
            R.move_object(r.key, "recordings", dept, arch)
            if arch:
                R.export_row("recordings", r)
            s.delete(r)
            R.count(R.removed, f"{dept}/recordings")
    # plate events: clips / crops first, then whole events
    pe, pc, pk = policy_for(pols, "events", dept), policy_for(pols, "clips", dept), policy_for(pols, "crops", dept)
    cuts = [c for c, p in ((_cutoff(pe["keep_days"]), pe), (_cutoff(pc["keep_days"]), pc), (_cutoff(pk["keep_days"]), pk)) if p["enabled"]]
    if cuts:
        oldest = min(cuts)
        cut_ev = _cutoff(pe["keep_days"]) if pe["enabled"] else None
        cut_clip = _cutoff(pc["keep_days"]) if pc["enabled"] else None
        cut_crop = _cutoff(pk["keep_days"]) if pk["enabled"] else None
        for ev in s.scalars(select(AnprEvent).where(AnprEvent.department == dept, AnprEvent.ts < oldest)):
            if _event_held(ev, holds):
                R.held += 1
                continue
            if cut_ev is not None and ev.ts < cut_ev:
                R.move_object(ev.clip_key, "clips", dept, pc["action"] == "archive")
                for k in (ev.crop_key, ev.frame_key):
                    R.move_object(k, "crops", dept, pk["action"] == "archive")
                for rel in (ev.crop_path, ev.frame_path):
                    fp = settings.data_dir / rel if rel else None
                    if fp and fp.exists():
                        fp.unlink()
                if pe["action"] == "archive":
                    R.export_row("events", ev)
                s.delete(ev)
                R.count(R.removed, f"{dept}/events")
                continue
            if cut_clip is not None and ev.ts < cut_clip and ev.clip_key not in ("", "-"):
                R.move_object(ev.clip_key, "clips", dept, pc["action"] == "archive")
                ev.clip_key = "-"
                R.count(R.removed, f"{dept}/clips")
            if cut_crop is not None and ev.ts < cut_crop:
                for attr in ("crop_key", "frame_key"):
                    k = getattr(ev, attr)
                    if k and k != "-":
                        R.move_object(k, "crops", dept, pk["action"] == "archive")
                        setattr(ev, attr, "-")
                        R.count(R.removed, f"{dept}/crops")
    # alerts, incidents, counts
    for cls, model, col in (("alerts", Alert, Alert.ts), ("incidents", Incident, Incident.ts), ("counts", TrafficCount, TrafficCount.ts)):
        p = policy_for(pols, cls, dept)
        if not p["enabled"]:
            continue
        arch = p["action"] == "archive"
        for row in s.scalars(select(model).where(model.department == dept, col < _cutoff(p["keep_days"]))):
            if cls != "counts" and _row_held(row, holds):
                R.held += 1
                continue
            if arch:
                R.export_row(cls, row)
            if cls == "incidents" and row.snapshot_path:
                fp = settings.data_dir / row.snapshot_path
                if fp.exists():
                    try:
                        fp.unlink()
                    except OSError:
                        pass
            s.delete(row)
            R.count(R.removed, f"{dept}/{cls}")
    R.flush_exports()


# ----------------------------------------------------------------------------- scheduling
def last_runs(s, limit: int = 20) -> list[dict]:
    return [run_dict(r) for r in s.scalars(select(ArchivalRun).order_by(ArchivalRun.started_at.desc()).limit(limit))]


def schedule(s) -> dict:
    st = get_setting(s, "archival_schedule", {})
    return {"hour_ist": int(st.get("hour_ist", settings.archival_hour_ist)), "enabled": bool(st.get("enabled", True)),
            "cold_prefix": settings.archival_cold_prefix, "cold_class": settings.s3_cold_class or "default"}


def set_schedule(s, hour_ist: int, enabled: bool, actor: str) -> dict:
    if not 0 <= int(hour_ist) <= 23:
        raise ValueError("hour must be 0-23")
    set_setting(s, "archival_schedule", {"hour_ist": int(hour_ist), "enabled": bool(enabled)}, actor)
    s.flush()
    return schedule(s)


def tick() -> dict | None:
    """Called by the archiver every few minutes: run once per day after the configured hour (IST)."""
    global _last_tick_day
    now = utcnow().astimezone(IST)
    with SessionLocal() as s:
        sch = schedule(s)
        last = s.scalar(select(func.max(ArchivalRun.started_at)).where(ArchivalRun.trigger == "schedule"))
    if not sch["enabled"] or now.hour < sch["hour_ist"]:
        return None
    today = now.date().isoformat()
    if _last_tick_day == today or (last is not None and last.astimezone(IST).date().isoformat() == today):
        return None
    _last_tick_day = today
    return run("schedule", "archiver")
