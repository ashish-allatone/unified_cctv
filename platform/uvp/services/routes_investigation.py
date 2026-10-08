"""Investigation routes: cases, evidence items, chain of custody, bookmarks, timeline stitching, GIS map."""
from __future__ import annotations

import datetime as dt
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select

from .. import auth as A
from .. import investigation as INV
from .. import pii
from ..db import (AnprEvent, Bookmark, Camera, Case, CaseItem, CustodyLog, Recording, SessionLocal, audit, custody, utcnow,
                  verify_custody_chain)
from ..plates import normalise
from ..storage import store
from .deps import _ip, _parse_time, current_user, dept_filter, need

router = APIRouter()


def _case_dict(c: Case, n_items: int = 0) -> dict:
    return {"id": c.id, "number": c.number, "title": c.title, "description": c.description, "reference": c.reference,
            "status": c.status, "priority": c.priority, "department": c.department, "owner": c.owner,
            "created_by": c.created_by, "created_at": c.created_at.isoformat(), "updated_at": c.updated_at.isoformat(),
            "closed_at": c.closed_at.isoformat() if c.closed_at else None, "items": n_items}


def _item_dict(it: CaseItem, u: A.User) -> dict:
    meta = dict(it.meta or {})
    if it.kind == "event":
        meta = pii.mask_event(meta, u)
        meta["crop_url"] = f"/media/{meta['crop_path']}" if meta.get("crop_path") else ""
        meta["frame_url"] = f"/media/{meta['frame_path']}" if meta.get("frame_path") else ""
    for k in ("clip_key", "key"):
        if meta.get(k) and meta[k] != "-":
            meta["play_url"] = store().url(meta[k])
    return {"id": it.id, "kind": it.kind, "ref_id": it.ref_id, "note": it.note, "meta": meta, "added_by": it.added_by,
            "added_at": it.added_at.isoformat()}


def _get_case(s, cid: str, u: A.User) -> Case:
    c = s.get(Case, cid)
    if not c or (c.department and not u.sees(c.department) and c.owner != u.username and c.created_by != u.username):
        raise HTTPException(404, "case not found")
    return c


# ----------------------------------------------------------------------------- cases
class CaseIn(BaseModel):
    title: str
    description: str = ""
    reference: str = ""
    priority: str = "medium"
    department: str = ""
    owner: str = ""


@router.get("/api/cases")
def list_cases(status: str = "", mine: bool = False, u: A.User = Depends(need("cases"))):
    with SessionLocal() as s:
        q = select(Case).order_by(Case.updated_at.desc()).limit(300)
        if status:
            q = q.where(Case.status == status)
        rows = s.scalars(q).all()
        counts = {cid: n for cid, n in s.execute(select(CaseItem.case_id, func.count()).group_by(CaseItem.case_id))}
        out = []
        for c in rows:
            if c.department and not u.sees(c.department) and c.owner != u.username and c.created_by != u.username:
                continue
            if mine and u.username not in (c.owner, c.created_by):
                continue
            out.append(_case_dict(c, counts.get(c.id, 0)))
    return out


@router.post("/api/cases")
def create_case(body: CaseIn, request: Request, u: A.User = Depends(need("cases"))):
    with SessionLocal() as s:
        c = Case(number=INV.case_number(s), title=body.title.strip()[:200], description=body.description[:5000],
                 reference=body.reference[:128], priority=body.priority, department=body.department or (u.departments[0] if u.departments and u.departments[0] != "*" else ""),
                 owner=body.owner or u.username, created_by=u.username)
        s.add(c)
        s.flush()
        custody(s, c.id, "opened", u.username, "", f"{c.number} {c.title}")
        audit(s, u.username, "case_open", c.number, c.title, _ip(request))
        s.commit()
        return _case_dict(c)


@router.get("/api/cases/{cid}")
def get_case(cid: str, u: A.User = Depends(need("cases"))):
    with SessionLocal() as s:
        c = _get_case(s, cid, u)
        items = s.scalars(select(CaseItem).where(CaseItem.case_id == c.id).order_by(CaseItem.added_at)).all()
        chain = s.scalars(select(CustodyLog).where(CustodyLog.case_id == c.id).order_by(CustodyLog.id)).all()
        return {**_case_dict(c, len(items)), "items": [_item_dict(i, u) for i in items],
                "custody": [{"ts": r.ts.isoformat(), "action": r.action, "user": r.user_id, "item_id": r.item_id, "detail": r.detail,
                             "sha256": r.sha256, "hash": r.hash[:16]} for r in chain],
                "custody_chain": verify_custody_chain(s, c.id)}


class CasePatch(BaseModel):
    title: str | None = None
    description: str | None = None
    reference: str | None = None
    priority: str | None = None
    owner: str | None = None
    status: str | None = None


@router.patch("/api/cases/{cid}")
def patch_case(cid: str, body: CasePatch, request: Request, u: A.User = Depends(need("cases"))):
    with SessionLocal() as s:
        c = _get_case(s, cid, u)
        changes = []
        for k, v in body.model_dump(exclude_none=True).items():
            if getattr(c, k) != v:
                changes.append(f"{k}: {getattr(c, k)!r} -> {v!r}")
                setattr(c, k, v)
        if body.status == "closed" and not c.closed_at:
            c.closed_at = utcnow()
        if body.status == "open":
            c.closed_at = None
        c.updated_at = utcnow()
        if changes:
            custody(s, c.id, "updated", u.username, "", "; ".join(changes)[:1000])
            audit(s, u.username, "case_update", c.number, "; ".join(changes)[:400], _ip(request))
        s.commit()
        return _case_dict(c)


class ItemIn(BaseModel):
    kind: str            # event | recording | bookmark | note
    ref_id: str = ""
    note: str = ""


@router.post("/api/cases/{cid}/items")
def add_item(cid: str, body: ItemIn, request: Request, u: A.User = Depends(need("cases"))):
    with SessionLocal() as s:
        c = _get_case(s, cid, u)
        if c.status == "closed":
            raise HTTPException(409, "case is closed")
        meta, sha = {}, ""
        if body.kind == "event":
            e = s.get(AnprEvent, body.ref_id)
            if not e or not u.sees(e.department):
                raise HTTPException(404, "event not found")
            meta = INV.snapshot_event(e, s.get(Camera, e.camera_id))
            lp = store().local_path(e.clip_key) if e.clip_key not in ("", "-") else None
            if lp:
                from .. import signing
                sha = signing.sha256_file(lp)
        elif body.kind == "recording":
            r = s.get(Recording, body.ref_id)
            if not r or not u.sees(r.department):
                raise HTTPException(404, "recording not found")
            meta = {"camera_id": r.camera_id, "department": r.department, "start": r.start_ts.isoformat(), "duration_s": r.duration_s, "key": r.key, "bytes": r.bytes}
        elif body.kind == "bookmark":
            b = s.get(Bookmark, body.ref_id)
            if not b or not u.sees(b.department):
                raise HTTPException(404, "bookmark not found")
            meta = {"camera_id": b.camera_id, "department": b.department, "ts": b.ts.isoformat(), "label": b.label, "clip_key": b.clip_key,
                    "before_s": b.before_s, "after_s": b.after_s}
        elif body.kind == "note":
            if not body.note.strip():
                raise HTTPException(400, "empty note")
        else:
            raise HTTPException(400, "kind must be event | recording | bookmark | note")
        it = CaseItem(case_id=c.id, kind=body.kind, ref_id=body.ref_id, note=body.note[:5000], meta=meta, added_by=u.username)
        s.add(it)
        s.flush()
        custody(s, c.id, "added", u.username, it.id, f"{body.kind} {body.ref_id} {body.note[:100]}".strip(), sha)
        c.updated_at = utcnow()
        audit(s, u.username, "case_item_add", c.number, f"{body.kind}:{body.ref_id}", _ip(request))
        s.commit()
        return _item_dict(it, u)


@router.delete("/api/cases/{cid}/items/{iid}")
def remove_item(cid: str, iid: str, request: Request, u: A.User = Depends(need("cases"))):
    with SessionLocal() as s:
        c = _get_case(s, cid, u)
        it = s.get(CaseItem, iid)
        if not it or it.case_id != c.id:
            raise HTTPException(404)
        custody(s, c.id, "removed", u.username, it.id, f"{it.kind} {it.ref_id}")
        s.delete(it)
        c.updated_at = utcnow()
        audit(s, u.username, "case_item_remove", c.number, f"{it.kind}:{it.ref_id}", _ip(request))
        s.commit()
    return {"ok": True}


@router.get("/api/cases/{cid}/export")
def export_case(cid: str, request: Request, u: A.User = Depends(need("export"))):
    with SessionLocal() as s:
        c = _get_case(s, cid, u)
        z = INV.export_case(s, c, u.username)
        audit(s, u.username, "case_export", c.number, z.name, _ip(request))
        s.commit()
        return FileResponse(z, filename=z.name, media_type="application/zip")


# ----------------------------------------------------------------------------- vehicles seen on several cameras
@router.get("/api/vehicles/multi-camera")
def multi_camera(since: str | None = None, until: str | None = None, min_cameras: int = 2, cameras: str = "", department: str = "",
                 vehicle_type: str = "", plate: str = "", limit: int = 200, request: Request = None, u: A.User = Depends(need("movement"))):
    """Which number plates were read on more than one camera in the window (default: last 24 h; any length - a whole
    year is fine, the grouping is done in the database). `cameras=a,b` narrows to plates seen on EVERY one of those
    cameras (e.g. entered at A and left at B); `min_cameras` (default 2) is the minimum number of distinct cameras
    otherwise. Plates are masked for users without plate_search. Sorted by number of cameras, then most recent."""
    lo = _parse_time(since) or (utcnow() - dt.timedelta(hours=24))
    hi = _parse_time(until) or utcnow()
    if hi <= lo:
        raise HTTPException(400, "until must be after since")
    want = {c.strip() for c in cameras.split(",") if c.strip()}
    limit = max(1, min(limit, 1000))
    with SessionLocal() as s:
        cams = {c.id: c for c in s.scalars(select(Camera)) if u.sees_camera(c.id, c.department)}
        if want and not want <= set(cams):
            return {"since": lo.isoformat(), "until": hi.isoformat(), "min_cameras": max(2, min_cameras), "cameras": sorted(want), "total": 0, "items": []}
        base = [AnprEvent.ts >= lo, AnprEvent.ts < hi, AnprEvent.plate_valid.is_(True), AnprEvent.plate != "",
                AnprEvent.camera_id.in_(list(want) if want else list(cams))]
        if department:
            base.append(AnprEvent.department == department)
        if vehicle_type:
            base.append(AnprEvent.vehicle_type == vehicle_type)
        if plate.strip():                                      # GJ01*, *1234, GJ01AB1234 (needs plate_search)
            if not u.has("plate_search"):
                raise HTTPException(403, "filtering by plate requires plate_search")
            base.append(AnprEvent.plate.like("%".join(normalise(x) for x in plate.strip().split("*"))) if "*" in plate else AnprEvent.plate == normalise(plate.strip()))
        # step 1 (in the database): the plates that qualify - distinct cameras >= N, or == every wanted camera
        need_n = len(want) if want else max(2, min_cameras)
        pq = select(AnprEvent.plate, func.count(func.distinct(AnprEvent.camera_id)).label("n"), func.max(AnprEvent.ts).label("last")) \
            .where(*base).group_by(AnprEvent.plate).having(func.count(func.distinct(AnprEvent.camera_id)) >= need_n) \
            .order_by(func.count(func.distinct(AnprEvent.camera_id)).desc(), func.max(AnprEvent.ts).desc())
        total = s.execute(select(func.count()).select_from(pq.subquery())).scalar() or 0
        plates = [row[0] for row in s.execute(pq.limit(limit)).all()]
        rows = []
        if plates:
            # step 2: per-camera detail for just those plates (all the user's cameras, so the order of passage is complete)
            dq = select(AnprEvent.plate, AnprEvent.camera_id, func.count(AnprEvent.id), func.min(AnprEvent.ts), func.max(AnprEvent.ts)) \
                .where(AnprEvent.ts >= lo, AnprEvent.ts < hi, AnprEvent.plate_valid.is_(True), AnprEvent.plate.in_(plates),
                       AnprEvent.camera_id.in_(list(cams))).group_by(AnprEvent.plate, AnprEvent.camera_id)
            rows = s.execute(dq).all()
        if request is not None:
            audit(s, u.username, "multi_camera_query", "", f"{lo.isoformat()}..{hi.isoformat()} min={min_cameras} cams={','.join(sorted(want))} plates={total}", _ip(request))
            s.commit()
    by_plate: dict[str, dict] = {p: {"plate": p, "cameras": {}, "sightings": 0} for p in plates}
    for plate, cid, n, first, last in rows:
        d = by_plate[plate]
        c = cams[cid]
        d["cameras"][cid] = {"id": cid, "name": c.name, "department": c.department, "sightings": int(n), "first": first, "last": last}
        d["sightings"] += int(n)
    out = []
    for p in plates:                                              # keep the database order (most cameras, newest)
        d = by_plate[p]
        cl = sorted(d["cameras"].values(), key=lambda x: x["first"])
        if not cl:
            continue
        first, last = cl[0]["first"], max(x["last"] for x in cl)
        item = {"plate": d["plate"], "camera_count": len(cl), "sightings": d["sightings"], "first_seen": first.isoformat(), "last_seen": last.isoformat(),
                "span_min": int((last - first).total_seconds() // 60),
                "cameras": [{**x, "first": x["first"].isoformat(), "last": x["last"].isoformat()} for x in cl]}
        out.append(pii.mask_event(item, u))
    return {"since": lo.isoformat(), "until": hi.isoformat(), "min_cameras": need_n, "cameras": sorted(want),
            "total": int(total), "items": out, "truncated": total > len(out)}


# ----------------------------------------------------------------------------- timeline reconstruction
@router.get("/api/vehicles/{plate}/timeline")
def timeline(plate: str, since: str | None = None, until: str | None = None, u: A.User = Depends(need("movement"))):
    if not u.has("plate_search"):
        raise HTTPException(403, "requires plate_search")
    p = normalise(plate)
    with SessionLocal() as s:
        evs = INV.timeline_for_plate(s, p, _parse_time(since), _parse_time(until), dept_filter(u))
        cams = {c.id: c for c in s.scalars(select(Camera))}
        out = []
        for e in evs:
            cam = cams.get(e.camera_id)
            out.append({"id": e.id, "ts": e.ts.isoformat(), "camera_id": e.camera_id, "camera_name": cam.name if cam else e.camera_id,
                        "department": e.department, "lat": cam.lat if cam else None, "lon": cam.lon if cam else None,
                        "has_clip": e.clip_key not in ("", "-"), "confidence": e.confidence,
                        "crop_url": f"/media/{e.crop_path}" if e.crop_path else ""})
        gaps = []
        for a, b in zip(out, out[1:]):
            secs = (dt.datetime.fromisoformat(b["ts"]) - dt.datetime.fromisoformat(a["ts"])).total_seconds()
            dist = INV.haversine_m(a["lat"], a["lon"], b["lat"], b["lon"]) if None not in (a["lat"], a["lon"], b["lat"], b["lon"]) else None
            gaps.append({"from": a["camera_id"], "to": b["camera_id"], "seconds": round(secs), "metres": round(dist) if dist is not None else None,
                         "kmh": round(dist / secs * 3.6, 1) if dist and secs > 0 else None})
        return {"plate": p, "sightings": out, "legs": gaps, "clips_available": sum(x["has_clip"] for x in out)}


@router.get("/api/vehicles/{plate}/stitch")
def stitch(plate: str, request: Request, since: str | None = None, until: str | None = None, case_id: str = "",
           u: A.User = Depends(need("export"))):
    """One MP4 of every archived clip of the plate in the window, captioned per camera. Optionally filed into a case."""
    p = normalise(plate)
    with SessionLocal() as s:
        evs = INV.timeline_for_plate(s, p, _parse_time(since), _parse_time(until), dept_filter(u))
        if not any(e.clip_key not in ("", "-") for e in evs):
            raise HTTPException(404, "no archived clips for this plate in the window")
        out = Path(tempfile.mkdtemp(prefix="uvp-st-")) / f"timeline_{p}.mp4"
        try:
            used = INV.stitch_plate(s, p, evs, u.username, out)
        except RuntimeError as e:
            raise HTTPException(404, str(e))
        audit(s, u.username, "timeline_stitch", p, f"clips={len(used)} case={case_id}", _ip(request))
        if case_id:
            c = _get_case(s, case_id, u)
            key = f"stitches/{c.number}/{p}_{utcnow():%Y%m%d%H%M%S}.mp4"
            store().put_file(out, key, "video/mp4")
            it = CaseItem(case_id=c.id, kind="stitch", ref_id=p, note=f"{len(used)} clips {since or ''}..{until or ''}",
                          meta={"plate": p, "segments": len(used), "clip_key": key, "used": used}, added_by=u.username)
            s.add(it)
            s.flush()
            from .. import signing
            custody(s, c.id, "stitched", u.username, it.id, f"{p}: {len(used)} clips", signing.sha256_file(out))
            c.updated_at = utcnow()
        s.commit()
        return FileResponse(out, filename=out.name, media_type="video/mp4")


# ----------------------------------------------------------------------------- bookmarks
class BookmarkIn(BaseModel):
    camera_id: str
    ts: str | None = None       # default now
    label: str = ""
    note: str = ""
    before_s: int = 10
    after_s: int = 10


def _bm_dict(b: Bookmark, cams: dict) -> dict:
    cam = cams.get(b.camera_id)
    return {"id": b.id, "camera_id": b.camera_id, "camera_name": cam.name if cam else b.camera_id, "department": b.department,
            "ts": b.ts.isoformat(), "before_s": b.before_s, "after_s": b.after_s, "label": b.label, "note": b.note,
            "created_by": b.created_by, "created_at": b.created_at.isoformat(),
            "clip": "ready" if b.clip_key not in ("", "-") else ("none" if b.clip_key == "-" else "pending"),
            "play_url": store().url(b.clip_key) if b.clip_key not in ("", "-") else ""}


@router.get("/api/bookmarks")
def list_bookmarks(camera: str = "", u: A.User = Depends(need("playback"))):
    with SessionLocal() as s:
        q = select(Bookmark).order_by(Bookmark.ts.desc()).limit(300)
        if camera:
            q = q.where(Bookmark.camera_id == camera)
        cams = {c.id: c for c in s.scalars(select(Camera))}
        return [_bm_dict(b, cams) for b in s.scalars(q) if u.sees(b.department)]


@router.post("/api/bookmarks")
def add_bookmark(body: BookmarkIn, request: Request, u: A.User = Depends(need("playback"))):
    with SessionLocal() as s:
        cam = s.get(Camera, body.camera_id)
        if not cam or not u.sees_camera(cam.id, cam.department):
            raise HTTPException(404, "camera not found")
        ts = _parse_time(body.ts) or utcnow()
        b = Bookmark(camera_id=cam.id, department=cam.department, ts=ts, before_s=max(1, min(120, body.before_s)),
                     after_s=max(1, min(120, body.after_s)), label=body.label[:200], note=body.note[:2000], created_by=u.username)
        s.add(b)
        s.flush()
        audit(s, u.username, "bookmark_add", cam.id, f"{ts.isoformat()} {body.label}", _ip(request))
        s.commit()
        return _bm_dict(b, {cam.id: cam})


@router.post("/api/bookmarks/{bid}/cut")
def cut_bookmark(bid: str, u: A.User = Depends(need("playback"))):
    """Cut (or re-cut) the bookmark's clip from the recording buffer / archive."""
    with SessionLocal() as s:
        b = s.get(Bookmark, bid)
        if not b or not u.sees(b.department):
            raise HTTPException(404)
        if b.ts + dt.timedelta(seconds=b.after_s + 8) > utcnow():
            raise HTTPException(409, "the window has not finished recording yet; try again in a few seconds")
        b.clip_key = INV.cut_bookmark(s, b)
        s.commit()
        cams = {b.camera_id: s.get(Camera, b.camera_id)}
        return _bm_dict(b, cams)


@router.delete("/api/bookmarks/{bid}")
def delete_bookmark(bid: str, u: A.User = Depends(need("playback"))):
    with SessionLocal() as s:
        b = s.get(Bookmark, bid)
        if not b or not u.sees(b.department):
            raise HTTPException(404)
        if b.clip_key not in ("", "-"):
            try:
                store().delete(b.clip_key)
            except Exception:  # noqa: BLE001
                pass
        s.delete(b)
        s.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- GIS map
@router.get("/api/map")
def map_data(u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        cams = [c for c in s.scalars(select(Camera)) if u.sees_camera(c.id, c.department) and c.lat is not None]
    return {"cameras": [{"id": c.id, "name": c.name, "department": c.department, "lat": c.lat, "lon": c.lon, "heading": c.heading,
                         "fov": c.fov, "range_m": c.range_m, "status": c.status, "anpr_enabled": c.anpr_enabled,
                         "camera_type": c.camera_type or "", "registry_only": c.registry_only, "ownership": c.ownership or "",
                         "connectivity": c.connectivity or "", "maintenance_status": c.maintenance_status or "",
                         "install_date": c.install_date or "", "zone": c.zone or "",
                         "coverage": INV.coverage_polygon(c.lat, c.lon, c.heading, c.fov, c.range_m)} for c in cams]}


@router.get("/api/map/nearest")
def map_nearest(lat: float, lon: float, n: int = 5, u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        cams = [c for c in s.scalars(select(Camera)) if u.sees_camera(c.id, c.department)]
    return {"lat": lat, "lon": lon, "cameras": INV.nearest_cameras(cams, lat, lon, n)}
