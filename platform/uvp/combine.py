"""Combined playback: one MP4 for any time range of a recorded camera.

Recording keeps writing 60 s segments (RECORD_SEGMENT_S) to object storage; nothing changes there.
For playback the operator picks a camera and a from / to time. Every archived segment overlapping
the range is fetched, joined without re-encoding (ffmpeg concat, stream copy) and trimmed to the
requested times. The result is stored as

    playback/<department>/<camera>/<from_unix>-<to_unix>-<sig>.mp4

next to a small `<name>.json` status object. Keeping the state in object storage (not in memory)
means any API replica can answer "is it ready?" and serve the file. `sig` is a hash of the
segments used, so asking for the same range again reuses the file, while a range that has gained
new segments since is rebuilt. Combined videos are short-lived: PLAYBACK_KEEP_H (default 24 h).

Where the range has gaps (camera offline, stream dropped) the recorded parts are joined back to
back; the gaps are reported to the caller so the UI can show them.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import re
import shutil
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from sqlalchemy import select

from .config import settings
from .db import Recording
from .storage import delete_prefix, store

log = logging.getLogger("uvp.combine")

PREFIX = "playback"
NAME_RE = re.compile(r"^(\d{9,11})-(\d{9,11})-([0-9a-f]{10})\.mp4$")
GAP_S = 2.0            # a hole between two segments shorter than this is not reported as a gap
HEARTBEAT_S = 15       # a job rewrites its status this often while it works ...
STALE_S = 90           # ... so a "building" status older than this belongs to a replica that died
IST = dt.timezone(dt.timedelta(minutes=330))

_slots = threading.BoundedSemaphore(max(1, settings.playback_jobs))
_running: set[str] = set()
_lock = threading.Lock()
_last_cleanup = 0.0


def _safe(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", s)


def parse_time(v) -> dt.datetime:
    """Unix timestamp (seconds or milliseconds) or ISO 8601. An ISO time without a zone is read as IST."""
    if v is None or str(v).strip() == "":
        raise ValueError("time is required")
    v = str(v).strip()
    if re.fullmatch(r"\d+(\.\d+)?", v):
        n = float(v)
        if n > 1e11:                                           # milliseconds
            n /= 1000.0
        return dt.datetime.fromtimestamp(n, dt.timezone.utc)
    v = re.sub(r" (\d\d:\d\d)$", r"+\1", v)                    # a '+' in a query string arrives as a space
    try:
        t = dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"bad time {v!r}: use a Unix timestamp or ISO 8601, e.g. 2026-10-09T10:00:00+05:30")
    return (t if t.tzinfo else t.replace(tzinfo=IST)).astimezone(dt.timezone.utc)


def _end(r: Recording) -> dt.datetime:
    return r.start_ts + dt.timedelta(seconds=float(r.duration_s or 0))


def segments_in_range(s, cam_id: str, start: dt.datetime, end: dt.datetime) -> list[Recording]:
    """Archived segments of the camera overlapping [start, end), oldest first. One profile only (main preferred)."""
    look_back = dt.timedelta(seconds=max(3600, 2 * settings.record_segment_s))     # a segment that began before `start`
    rows = s.scalars(select(Recording).where(Recording.camera_id == cam_id, Recording.start_ts < end,
                                             Recording.start_ts >= start - look_back).order_by(Recording.start_ts)).all()
    rows = [r for r in rows if _end(r) > start]
    profiles = {r.profile for r in rows}
    if len(profiles) > 1:
        keep = "main" if "main" in profiles else sorted(profiles)[0]
        rows = [r for r in rows if r.profile == keep]
    return rows


def coverage(rows: list[Recording], start: dt.datetime, end: dt.datetime) -> dict:
    """How much of [start, end) is actually recorded, and where the holes are."""
    gaps, recorded, cur = [], 0.0, start
    for r in rows:
        a, b = max(r.start_ts, start), min(_end(r), end)
        if (a - cur).total_seconds() > GAP_S:
            gaps.append({"from": cur.isoformat(), "to": a.isoformat(), "seconds": round((a - cur).total_seconds())})
        if b > cur:
            recorded += (b - max(a, cur)).total_seconds()
            cur = b
    if rows and (end - cur).total_seconds() > GAP_S:
        gaps.append({"from": cur.isoformat(), "to": end.isoformat(), "seconds": round((end - cur).total_seconds())})
    return {"requested_s": round((end - start).total_seconds()), "recorded_s": round(recorded),
            "bytes": int(sum(r.bytes or 0 for r in rows)), "gaps": gaps,
            "first": rows[0].start_ts.isoformat() if rows else None, "last": _end(rows[-1]).isoformat() if rows else None}


def export_name(start: dt.datetime, end: dt.datetime, rows: list[Recording]) -> str:
    sig = hashlib.sha256("|".join(r.id for r in rows).encode()).hexdigest()[:10]
    return f"{int(start.timestamp())}-{int(end.timestamp())}-{sig}.mp4"


def export_key(department: str, cam_id: str, name: str) -> str:
    if not NAME_RE.match(name):
        raise ValueError("bad name")
    return f"{PREFIX}/{_safe(department)}/{_safe(cam_id)}/{name}"


def download_filename(cam_id: str, name: str) -> str:
    """cam06_2026-10-09_10-00-00_to_2026-10-09_10-30-00_IST.mp4"""
    m = NAME_RE.match(name)
    a, b = (dt.datetime.fromtimestamp(int(x), IST) for x in m.groups()[:2])
    return f"{_safe(cam_id)}_{a:%Y-%m-%d_%H-%M-%S}_to_{b:%Y-%m-%d_%H-%M-%S}_IST.mp4"


# ----------------------------------------------------------------------------- status object
def read_state(key: str) -> dict | None:
    try:
        raw = store().get_bytes(key + ".json")
        st = json.loads(raw) if raw else None
    except Exception:  # noqa: BLE001
        st = None
    if st and st.get("status") in ("queued", "building") and time.time() - float(st.get("updated", 0)) > STALE_S:
        st = {**st, "status": "failed", "error": "the server stopped while preparing this video; please try again"}
    return st


def _write_state(key: str, st: dict) -> None:
    st["updated"] = time.time()
    try:
        store().put_bytes(json.dumps(st).encode(), key + ".json", "application/json")
    except Exception as e:  # noqa: BLE001
        log.warning("combine: cannot write status for %s: %s", key, e)


def _cleanup() -> None:
    """Drop combined videos older than PLAYBACK_KEEP_H. At most once an hour per replica."""
    global _last_cleanup
    if time.time() - _last_cleanup < 3600:
        return
    _last_cleanup = time.time()
    try:
        n = delete_prefix(PREFIX + "/", dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=settings.playback_keep_h))
        if n:
            log.info("combine: removed %d expired playback objects", n)
    except Exception as e:  # noqa: BLE001
        log.warning("combine: cleanup failed: %s", e)


# ----------------------------------------------------------------------------- build
def start(key: str, segs: list[dict], start_ts: dt.datetime, end_ts: dt.datetime, user: str) -> dict:
    """Make sure the combined video `key` exists or is being built. Returns its status object.
    segs: [{id, key, start (datetime), duration_s}] oldest first."""
    st = read_state(key)
    if st and st["status"] == "ready" and store().exists(key):
        return st
    if st and st["status"] in ("queued", "building"):
        return st
    with _lock:
        if key in _running:                                  # this replica is already on it
            return read_state(key) or {"status": "queued", "progress": 0}
        _running.add(key)
    st = {"status": "queued", "progress": 0, "segments": len(segs), "requested_by": user,
          "from": start_ts.isoformat(), "to": end_ts.isoformat()}
    _write_state(key, st)
    threading.Thread(target=_job, args=(key, segs, start_ts, end_ts, dict(st)), daemon=True, name="uvp-combine").start()
    return st


def _job(key: str, segs: list[dict], start_ts: dt.datetime, end_ts: dt.datetime, st: dict) -> None:
    stop = threading.Event()

    def beat():
        while not stop.wait(HEARTBEAT_S):
            _write_state(key, st)
    threading.Thread(target=beat, daemon=True).start()
    tmp = Path(tempfile.mkdtemp(prefix="uvp-pb-"))
    try:
        with _slots:
            _cleanup()
            st["status"] = "building"
            _write_state(key, st)
            t0 = time.time()
            info = _build(segs, start_ts, end_ts, tmp, st)
            st["progress"] = 95
            size = store().put_file(info["path"], key, "video/mp4")
            st.update(status="ready", progress=100, bytes=size, duration_s=info["duration_s"], used=info["used"],
                      reencoded=info["reencoded"], built_s=round(time.time() - t0, 1))
            log.info("combine: %s ready (%d segments, %.0f s, %.1f MB, built in %.1f s)", key, info["used"], info["duration_s"],
                     size / 1048576, st["built_s"])
    except Exception as e:  # noqa: BLE001
        log.exception("combine: %s failed", key)
        st.update(status="failed", error=str(e)[:300])
    finally:
        stop.set()
        _write_state(key, st)
        shutil.rmtree(tmp, ignore_errors=True)
        with _lock:
            _running.discard(key)


def _fetch(key: str, dst: Path) -> Path | None:
    """One archived segment to a local file."""
    s = store()
    p = s.local_path(key)
    if p is not None:
        return p                                             # local backend: read it in place
    for attempt in range(3):
        try:
            if hasattr(s, "download_file"):
                if s.download_file(key, dst) and dst.stat().st_size > 0:
                    return dst
            else:
                with requests.get(s.url(key, 600), timeout=120, stream=True) as r:
                    if r.ok:
                        with dst.open("wb") as f:
                            for chunk in r.iter_content(1 << 20):
                                f.write(chunk)
                        return dst
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5 * (attempt + 1))
    return None


def _ffmpeg(args: list[str], timeout: int = 3600) -> None:
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "ffmpeg failed").strip().splitlines()[-1][:300])


def _duration(p: Path) -> float:
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        return round(float(out), 3)
    except Exception:  # noqa: BLE001
        return 0.0


def _build(segs: list[dict], start_ts: dt.datetime, end_ts: dt.datetime, tmp: Path, st: dict) -> dict:
    # 1. fetch the segments (in parallel: on S3 this is most of the time)
    done = 0

    def get(i_seg):
        nonlocal done
        i, sg = i_seg
        p = _fetch(sg["key"], tmp / f"s{i:05d}.mp4")
        done += 1
        st["progress"] = int(70 * done / len(segs))
        return sg, p
    with ThreadPoolExecutor(max_workers=8) as ex:
        got = [(sg, p) for sg, p in ex.map(get, enumerate(segs)) if p is not None]
    if not got:
        raise RuntimeError("the recorded segments for this time range could not be read from object storage")

    # 2. join without re-encoding
    lst = tmp / "list.txt"
    lst.write_text("".join("file '{}'\n".format(str(p).replace("'", "'\\''")) for _, p in got))
    joined, out, reencoded = tmp / "joined.mp4", tmp / "out.mp4", False
    st["progress"] = 75
    try:
        _ffmpeg(["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(joined)])
    except (RuntimeError, subprocess.TimeoutExpired) as e:
        # segments that cannot be stream-copied together (the camera changed codec or resolution mid-range): re-encode once
        log.warning("combine: stream copy failed (%s); re-encoding", e)
        reencoded = True
        _ffmpeg(["-f", "concat", "-safe", "0", "-i", str(lst), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264",
                 "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", str(joined)], timeout=7200)

    # 3. trim to the requested times (stream copy: the cut starts on the nearest key frame at or before `from`)
    st["progress"] = 88
    first, last = got[0][0], got[-1][0]
    off = max(0.0, (start_ts - first["start"]).total_seconds())
    total = _duration(joined)
    tail = max(0.0, (last["start"] + dt.timedelta(seconds=last["duration_s"]) - end_ts).total_seconds())
    keep = max(1.0, total - off - tail) if total else None
    args = (["-ss", f"{off:.3f}"] if off > 0.05 else []) + ["-i", str(joined)]
    if keep and tail > 0.05:
        args += ["-t", f"{keep:.3f}"]
    _ffmpeg(args + ["-c", "copy", "-movflags", "+faststart", "-avoid_negative_ts", "make_zero", str(out)])
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError("the combined video came out empty")
    return {"path": out, "duration_s": _duration(out), "used": len(got), "reencoded": reencoded}
