"""Persons of interest (face recognition) and live counts.

  GET    /api/persons                      enrolled persons with last sighting (search feature)
  POST   /api/persons                      enrol: multipart name, category, priority, reason, reference, days, photos[] (watchlist feature)
  POST   /api/persons/{id}/photos          add more photos to an existing person
  PATCH  /api/persons/{id}                 active / priority / category / reason
  DELETE /api/persons/{id}                 remove person, photos and embeddings
  GET    /api/persons/{id}/sightings       person_match incidents for this person
  GET    /media/persons/{pid}/{name}       enrolment photo (scoped by department)
  GET    /api/counts                       live vehicle / person / face counts per camera from the last detections

Enrolment accepts one photo or several; each photo must contain a clear face (the largest face is used when a
photo shows more than one). Every enrolment, change and match is written to the audit log.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import time
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select

from .. import auth as A
from ..analytics.faces import engine
from ..config import settings
from ..db import Incident, Person, SessionLocal, audit, new_id, utcnow
from .deps import _ip, current_user, need

log = logging.getLogger("uvp.persons")
router = APIRouter()
CATEGORIES = ("wanted", "missing", "suspect", "other")


def persons_dir() -> Path:
    return settings.data_dir / "persons"


def _out(p: Person) -> dict:
    return {"id": p.id, "name": p.name, "category": p.category, "priority": p.priority, "reason": p.reason,
            "reference": p.reference, "departments": list(p.departments or ["*"]), "photos": len(p.photos or []),
            "photo_urls": [f"/media/{x}" for x in (p.photos or [])], "added_by": p.added_by,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "expires_at": p.expires_at.isoformat() if p.expires_at else None, "active": bool(p.active),
            "last_seen_at": p.last_seen_at.isoformat() if p.last_seen_at else None, "last_seen_camera": p.last_seen_camera,
            "sightings": int(p.sightings or 0)}


def _embed_photo(data: bytes, filename: str) -> tuple[np.ndarray, np.ndarray]:
    """Decode an uploaded photo, return (embedding, face crop for the thumbnail)."""
    eng = engine()
    if eng is None:
        raise HTTPException(503, "face recognition is disabled (FACE_ENABLED) or the models are missing")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, f"{filename}: not an image")
    if max(img.shape[:2]) > 2000:                       # phone photos: shrink for speed, faces stay large
        f = 2000 / max(img.shape[:2])
        img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    try:
        emb, (x1, y1, x2, y2), found = eng.enrol_image(img)
    except ValueError as e:
        raise HTTPException(400, f"{filename}: {e}")
    m = int((x2 - x1) * 0.35)
    crop = img[max(0, y1 - m):y2 + m, max(0, x1 - m):x2 + m]
    if crop.shape[0] < 160:
        crop = cv2.resize(crop, None, fx=160 / crop.shape[0], fy=160 / crop.shape[0], interpolation=cv2.INTER_CUBIC)
    return emb, crop


def _save_photos(pid: str, files: list[UploadFile], start: int) -> tuple[list[str], list[list[float]]]:
    paths, embs = [], []
    folder = persons_dir() / pid
    folder.mkdir(parents=True, exist_ok=True)
    for i, up in enumerate(files):
        data = up.file.read()
        if len(data) > 12 * 1024 * 1024:
            raise HTTPException(400, f"{up.filename}: photo larger than 12 MB")
        emb, crop = _embed_photo(data, up.filename or f"photo{i}")
        name = f"{start + i}.jpg"
        cv2.imwrite(str(folder / name), crop, [cv2.IMWRITE_JPEG_QUALITY, 88])
        paths.append(f"persons/{pid}/{name}")
        embs.append([round(float(v), 5) for v in emb])
    return paths, embs


@router.get("/api/persons")
def list_persons(u: A.User = Depends(need("search"))):
    with SessionLocal() as s:
        rows = s.scalars(select(Person).order_by(Person.created_at.desc())).all()
        return [_out(p) for p in rows if "*" in (p.departments or ["*"]) or any(u.sees(d) for d in p.departments)]


@router.post("/api/persons", status_code=201)
def enrol_person(request: Request, name: str = Form(...), category: str = Form("wanted"), priority: str = Form("high"),
                 reason: str = Form(""), reference: str = Form(""), days: int = Form(90), departments: str = Form("*"),
                 photos: list[UploadFile] = File(...), u: A.User = Depends(need("watchlist"))):
    name = name.strip()[:120]
    if len(name) < 2:
        raise HTTPException(400, "name is required")
    if category not in CATEGORIES:
        raise HTTPException(400, f"category must be one of {', '.join(CATEGORIES)}")
    if not photos:
        raise HTTPException(400, "at least one photo is required")
    pid = new_id()
    paths, embs = _save_photos(pid, photos, 1)
    depts = [d.strip() for d in departments.split(",") if d.strip()] or ["*"]
    with SessionLocal() as s:
        p = Person(id=pid, name=name, category=category, priority=priority if priority in ("high", "medium", "low") else "high",
                   reason=reason[:1000], reference=reference[:120], departments=depts, photos=paths, embeddings=embs,
                   added_by=u.username, expires_at=(utcnow() + dt.timedelta(days=days)) if days > 0 else None)
        s.add(p)
        audit(s, u.username, "person_enrol", pid, f"{name} ({category}) {len(paths)} photo(s) ref={reference}", _ip(request))
        s.commit()
        return _out(p)


@router.post("/api/persons/{pid}/photos")
def add_photos(pid: str, request: Request, photos: list[UploadFile] = File(...), u: A.User = Depends(need("watchlist"))):
    with SessionLocal() as s:
        p = s.get(Person, pid)
        if p is None:
            raise HTTPException(404, "no such person")
        paths, embs = _save_photos(pid, photos, len(p.photos or []) + 1)
        p.photos = list(p.photos or []) + paths
        p.embeddings = list(p.embeddings or []) + embs
        audit(s, u.username, "person_photos", pid, f"+{len(paths)} photo(s)", _ip(request))
        s.commit()
        return _out(p)


class PersonPatch(BaseModel):
    active: bool | None = None
    priority: str | None = None
    category: str | None = None
    reason: str | None = None
    reference: str | None = None
    days: int | None = None


@router.patch("/api/persons/{pid}")
def patch_person(pid: str, body: PersonPatch, request: Request, u: A.User = Depends(need("watchlist"))):
    with SessionLocal() as s:
        p = s.get(Person, pid)
        if p is None:
            raise HTTPException(404, "no such person")
        if body.category is not None and body.category not in CATEGORIES:
            raise HTTPException(400, "bad category")
        for k in ("active", "priority", "category", "reason", "reference"):
            v = getattr(body, k)
            if v is not None:
                setattr(p, k, v)
        if body.days is not None:
            p.expires_at = (utcnow() + dt.timedelta(days=body.days)) if body.days > 0 else None
        audit(s, u.username, "person_update", pid, json.dumps(body.model_dump(exclude_none=True)), _ip(request))
        s.commit()
        return _out(p)


@router.delete("/api/persons/{pid}")
def delete_person(pid: str, request: Request, u: A.User = Depends(need("watchlist"))):
    with SessionLocal() as s:
        p = s.get(Person, pid)
        if p is None:
            raise HTTPException(404, "no such person")
        for rel in p.photos or []:
            try:
                (settings.data_dir / rel).unlink(missing_ok=True)
            except OSError:
                pass
        s.delete(p)
        audit(s, u.username, "person_delete", pid, p.name, _ip(request))
        s.commit()
    return {"ok": True}


@router.get("/api/persons/{pid}/sightings")
def sightings(pid: str, limit: int = 100, u: A.User = Depends(need("search"))):
    with SessionLocal() as s:
        rows = s.scalars(select(Incident).where(Incident.kind == "person_match").order_by(Incident.ts.desc()).limit(2000)).all()
        out = []
        for i in rows:
            if (i.detail or {}).get("person_id") != pid or not u.sees(i.department):
                continue
            out.append({"id": i.id, "camera_id": i.camera_id, "department": i.department, "ts": i.ts.isoformat(),
                        "score": (i.detail or {}).get("score"), "face_px": (i.detail or {}).get("face_px"),
                        "snapshot_url": f"/media/{i.snapshot_path}" if i.snapshot_path else "", "ack_by": i.ack_by})
            if len(out) >= limit:
                break
        return out


@router.get("/media/persons/{pid}/{name}")
def person_photo(pid: str, name: str, u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        p = s.get(Person, pid)
    if p is None or not ("*" in (p.departments or ["*"]) or any(u.sees(d) for d in p.departments)):
        raise HTTPException(404)
    f = (persons_dir() / pid / name).resolve()
    if persons_dir().resolve() not in f.parents or not f.exists():
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "private, max-age=3600"})


# ----------------------------------------------------------------------------- live counts
_last_dets: dict[str, dict] = {}     # camera -> {"ts", "vehicles", "persons", "faces", "plates", "kind"}
VEHICLES = {"car", "bus", "truck", "motorcycle", "bicycle"}


def note_dets(m: dict) -> None:
    """Called by the API for every live detection message: keeps the latest counts per camera in memory."""
    cid = m.get("camera_id")
    if not cid:
        return
    cur = _last_dets.setdefault(cid, {"vehicles": 0, "persons": 0, "faces": 0, "plates": 0, "ts": 0.0})
    kind = m.get("kind", "objects")
    boxes = m.get("boxes") or []
    if kind == "plate":
        cur["plates"] = len(boxes)
    elif kind == "face":
        cur["faces"] = len(boxes)
        cur["known"] = [b[0][5:] for b in boxes if str(b[0]).startswith("face:")]
    else:
        cur["vehicles"] = sum(1 for b in boxes if b[0] in VEHICLES)
        cur["persons"] = sum(1 for b in boxes if b[0] == "person")
    cur["ts"] = time.time()
    if kind not in ("plate", "face"):
        cur["objects_ts"] = cur["ts"]                  # last message from the analytics (object) detector


@router.get("/api/counts/status")
def counts_status(u: A.User = Depends(current_user)):
    """Is counting actually running? Which cameras should count, which have sent object detections in the last
    15 s, when the last per-minute row arrived - with a plain-language hint when something is missing."""
    import datetime as _dt
    from sqlalchemy import func, select
    from ..db import Camera, TrafficCount
    now = time.time()
    try:
        from .analytics_worker import zone_cameras
        expected = sorted(zone_cameras())
    except Exception as e:  # noqa: BLE001
        expected, err = [], str(e)[:120]
    else:
        err = ""
    recent = sorted(cid for cid, d in _last_dets.items() if now - d.get("objects_ts", 0) <= 15)
    with SessionLocal() as s:
        last = s.scalar(select(func.max(TrafficCount.ts)))
        since = _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(minutes=5)
        rows5 = s.scalar(select(func.count()).select_from(TrafficCount).where(TrafficCount.ts >= since)) or 0
        cams5 = s.scalar(select(func.count(func.distinct(TrafficCount.camera_id))).where(TrafficCount.ts >= since)) or 0
        pulled = [c.id for c in s.query(Camera) if not c.registry_only and c.status in ("online", "live")]
    last_age = round(now - last.timestamp(), 0) if last else None
    if err:
        hint = f"could not evaluate the counting set: {err}"
    elif not expected:
        hint = "no camera is selected for counting: ANALYTICS_COUNT_ALL=1 (docker-compose.yml) or a traffic:/crowd: entry in config/analytics.yaml, and the licence's analytics channels"
    elif not recent:
        hint = ("no object detections are arriving from the analytics worker: run  docker compose ps analytics  and  docker compose logs analytics --tail 40  "
                "- typical causes: container not restarted after the update, detector model missing (yolox_nano.onnx), relay sub-streams not readable")
    elif cams5 == 0 and (last_age is None or last_age > 240):      # rows carry the window START time (up to 2 min behind)
        hint = "detections arrive but no per-minute rows are stored: the analytics worker publishes them on the bus every 60 s - check  docker compose logs api | grep -i traffic  and Kafka health"
    else:
        hint = ""
    return {"expected": expected, "expected_count": len(expected), "pulled_online": len(pulled), "detecting_now": recent,
            "detecting_count": len(recent), "last_row_at": last.isoformat() if last else None, "last_row_age_s": last_age,
            "rows_last_5min": rows5, "cameras_last_5min": cams5, "hint": hint}


@router.get("/api/counts")
def live_counts(u: A.User = Depends(current_user)):
    """Latest vehicle / person / face counts per camera (from the last detection message, <= 10 s old)."""
    from ..db import Camera
    now = time.time()
    with SessionLocal() as s:
        cams = {c.id: c for c in s.query(Camera).all()}
    out = []
    for cid, d in _last_dets.items():
        c = cams.get(cid)
        if c is None or not u.sees(c.department):
            continue
        out.append({"camera_id": cid, "name": c.name, "department": c.department, "age_s": round(now - d["ts"], 1),
                    "stale": now - d["ts"] > 10, "vehicles": d["vehicles"], "persons": d["persons"], "faces": d.get("faces", 0),
                    "plates": d.get("plates", 0), "known": d.get("known", [])})
    out.sort(key=lambda r: (-(r["vehicles"] + r["persons"]), r["name"]))
    total = {"vehicles": sum(r["vehicles"] for r in out if not r["stale"]), "persons": sum(r["persons"] for r in out if not r["stale"]),
             "cameras": sum(1 for r in out if not r["stale"])}
    return {"total": total, "cameras": out}
