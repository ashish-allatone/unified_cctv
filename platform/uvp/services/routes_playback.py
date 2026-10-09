"""Playback of a custom time range: list the recorded segments between two times and get them as ONE video.

  GET  /api/cameras/{id}/recordings/range?from=&to=            segments + coverage (recorded time, gaps, size)
  POST /api/cameras/{id}/recordings/combine {from, to}         start (or reuse) the combined video -> {name, status}
  GET  /api/cameras/{id}/recordings/combined/{name}/status     queued | building (progress %) | ready | failed
  GET  /api/cameras/{id}/recordings/combined/{name}            the MP4: plays in the browser; ?download=1 saves it

`from` / `to` take a Unix timestamp (seconds or milliseconds) or ISO 8601. See uvp.combine.
"""
from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse

from .. import auth as A
from .. import combine as C
from ..config import settings
from ..db import Camera, SessionLocal, audit
from ..storage import store
from .deps import _ip, need

router = APIRouter()


def _camera(s, cam_id: str, u: A.User) -> Camera:
    cam = s.get(Camera, cam_id)
    if not cam or not u.allows(cam.id, cam.department, "playback"):
        raise HTTPException(404, "camera not found")
    return cam


def _window(frm, to) -> tuple[dt.datetime, dt.datetime]:
    try:
        a, b = C.parse_time(frm), C.parse_time(to)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if b <= a:
        raise HTTPException(400, "'to' must be later than 'from'")
    if (b - a).total_seconds() > settings.playback_max_range_s:
        raise HTTPException(400, f"time range too long: at most {settings.playback_max_range_s // 60} minutes per combined video "
                                 "(PLAYBACK_MAX_RANGE_S)")
    return a, b


def _url(key: str) -> str:
    return store().url(key, settings.s3_url_ttl_s)


def _range_dict(cam_id: str, a: dt.datetime, b: dt.datetime, rows: list) -> dict:
    return {"camera_id": cam_id, "from": a.isoformat(), "to": b.isoformat(), "from_unix": int(a.timestamp()), "to_unix": int(b.timestamp()),
            "count": len(rows), **C.coverage(rows, a, b)}


@router.get("/api/cameras/{cam_id}/recordings/range")
def recordings_range(cam_id: str, request: Request, u: A.User = Depends(need("playback"))):
    q = request.query_params
    a, b = _window(q.get("from"), q.get("to"))
    with SessionLocal() as s:
        _camera(s, cam_id, u)
        rows = C.segments_in_range(s, cam_id, a, b)
        audit(s, u.username, "list_recordings", cam_id, f"{a.isoformat()}..{b.isoformat()}", _ip(request))
        s.commit()
        return {**_range_dict(cam_id, a, b, rows), "max_range_s": settings.playback_max_range_s,
                "segments": [{"id": r.id, "start": r.start_ts.isoformat(), "duration_s": r.duration_s, "bytes": r.bytes,
                              "url": _url(r.key)} for r in rows]}


@router.post("/api/cameras/{cam_id}/recordings/combine")
async def combine(cam_id: str, request: Request, u: A.User = Depends(need("playback"))):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    return _combine(cam_id, (body or {}).get("from"), (body or {}).get("to"), u, _ip(request))


def _combine(cam_id: str, frm, to, u: A.User, ip: str) -> dict:
    a, b = _window(frm, to)
    with SessionLocal() as s:
        cam = _camera(s, cam_id, u)
        rows = C.segments_in_range(s, cam_id, a, b)
        if not rows:
            raise HTTPException(404, "no recording for this camera in that time range")
        name = C.export_name(a, b, rows)
        key = C.export_key(cam.department, cam.id, name)
        segs = [{"id": r.id, "key": r.key, "start": r.start_ts, "duration_s": float(r.duration_s or 0)} for r in rows]
        info = _range_dict(cam_id, a, b, rows)
        audit(s, u.username, "combine_recordings", cam_id, f"{a.isoformat()}..{b.isoformat()} segments={len(rows)}", ip)
        s.commit()
    st = C.start(key, segs, a, b, u.username)
    return {**info, "name": name, **_status_dict(cam_id, name, st)}


def _status_dict(cam_id: str, name: str, st: dict | None) -> dict:
    st = st or {"status": "failed", "error": "this combined video no longer exists; prepare it again"}
    out = {"status": st["status"], "progress": st.get("progress", 0)}
    if st["status"] == "ready":
        base = f"/api/cameras/{cam_id}/recordings/combined/{name}"
        out.update(url=base, download_url=base + "?download=1", bytes=st.get("bytes", 0), duration_s=st.get("duration_s", 0),
                   filename=C.download_filename(cam_id, name), reencoded=bool(st.get("reencoded")))
    elif st["status"] == "failed":
        out["error"] = st.get("error", "failed")
    return out


def _key(cam_id: str, name: str, u: A.User) -> str:
    with SessionLocal() as s:
        cam = _camera(s, cam_id, u)
        try:
            return C.export_key(cam.department, cam.id, name)
        except ValueError:
            raise HTTPException(404)


@router.get("/api/cameras/{cam_id}/recordings/combined/{name}/status")
def combined_status(cam_id: str, name: str, u: A.User = Depends(need("playback"))):
    return _status_dict(cam_id, name, C.read_state(_key(cam_id, name, u)))


@router.get("/api/cameras/{cam_id}/recordings/combined/{name}")
def combined_file(cam_id: str, name: str, request: Request, download: int = 0, u: A.User = Depends(need("playback"))):
    key = _key(cam_id, name, u)
    st = store()
    fname = C.download_filename(cam_id, name)
    if download:
        if not u.has("export"):
            raise HTTPException(403, "downloading video requires the export permission")
        with SessionLocal() as s:
            audit(s, u.username, "download_recording", cam_id, fname, _ip(request))
            s.commit()
    p = st.local_path(key)
    if p is not None:                                        # local backend: FileResponse answers Range requests (seeking)
        return FileResponse(p, media_type="video/mp4", filename=fname if download else None,
                            headers={"Cache-Control": "private, max-age=3600"})
    if not st.exists(key):
        raise HTTPException(404, "this combined video no longer exists; prepare it again")
    if not download:                                         # S3: the browser plays straight from the bucket
        return RedirectResponse(st.url(key, settings.s3_url_ttl_s), status_code=307)
    stream = st.open_stream(key)                             # S3 download: through the API so the file gets its name
    if stream is None:
        raise HTTPException(404)
    body, size = stream
    return StreamingResponse(body, media_type="video/mp4",
                             headers={"Content-Disposition": f'attachment; filename="{fname}"', "Content-Length": str(size)})
