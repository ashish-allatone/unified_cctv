"""Analytics routes: incident ingest + listing, challan review workflow and e-challan hand-off,
hotlist sources, face-search legal gate."""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import logging
import tempfile
from pathlib import Path

import requests
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select

from .. import auth as A
from .. import pii, signing
from ..analytics.rules import LABELS, challan_number, offences
from ..config import load_yaml, settings
from ..db import Alert, AnprEvent, Camera, Challan, Incident, SessionLocal, WatchlistEntry, audit, new_id, utcnow
from ..storage import store
from .deps import _ip, _parse_time, current_user, dept_filter, internal, need

log = logging.getLogger("uvp.analytics.api")
router = APIRouter()


# ----------------------------------------------------------------------------- incidents
def _inc_dict(i: Incident, u: A.User | None = None) -> dict:
    d = {"id": i.id, "camera_id": i.camera_id, "department": i.department, "ts": i.ts.isoformat(), "kind": i.kind,
         "zone": i.zone, "detail": i.detail or {}, "priority": i.priority, "plate": i.plate, "ack_by": i.ack_by,
         "snapshot_url": f"/media/{i.snapshot_path}" if i.snapshot_path else "", "label": LABELS.get(i.kind, i.kind.replace("_", " "))}
    return pii.mask_event(d, u) if u else d


def ingest_incident(ev: dict) -> tuple[Incident, list[dict]]:
    """Store an incident, associate a plate when an ANPR read on the same camera is close in time,
    raise an alert, and draft a challan for challan-able kinds when the plate is known."""
    ts = dt.datetime.fromisoformat(ev["ts"])
    alerts: list[dict] = []
    with SessionLocal() as s:
        if s.get(Incident, ev["id"]) is not None:
            return s.get(Incident, ev["id"]), []
        inc = Incident(id=ev["id"], camera_id=ev["camera_id"], department=ev["department"], ts=ts, kind=ev["kind"],
                       zone=ev.get("zone", ""), detail={**(ev.get("detail") or {}), "bbox": ev.get("bbox")},
                       snapshot_path=ev.get("snapshot_path", ""), priority=ev.get("priority", "medium"))
        if inc.kind in ("red_light", "illegal_parking"):
            near = s.scalars(select(AnprEvent).where(AnprEvent.camera_id == inc.camera_id,
                                                     AnprEvent.ts >= ts - dt.timedelta(seconds=20), AnprEvent.ts <= ts + dt.timedelta(seconds=20))
                             .order_by(AnprEvent.ts.desc()).limit(5)).all()
            bbox = ev.get("bbox")
            for e in near:
                if bbox and e.attrs and e.attrs.get("vehicle_bbox"):
                    vb = e.attrs["vehicle_bbox"]
                    ix = max(0, min(vb[2], bbox[2]) - max(vb[0], bbox[0]))
                    iy = max(0, min(vb[3], bbox[3]) - max(vb[1], bbox[1]))
                    if ix * iy <= 0:
                        continue
                inc.plate = e.plate
                inc.detail = {**inc.detail, "event_id": e.id}
                break
        s.add(inc)
        if inc.kind == "person_match":
            d = inc.detail or {}
            reason = f"{d.get('name', '?')} ({d.get('category', '')}) seen on {inc.camera_id}, similarity {d.get('score', 0):.2f}" + (f", ref {d['reference']}" if d.get("reference") else "")
            from ..db import Person
            person = s.get(Person, d.get("person_id", "")) if d.get("person_id") else None
            if person is not None:
                person.last_seen_at, person.last_seen_camera, person.sightings = ts, inc.camera_id, int(person.sightings or 0) + 1
            match = "face"
        else:
            reason = f"{LABELS.get(inc.kind, inc.kind)} in zone {inc.zone or '-'}: {json.dumps(ev.get('detail') or {})}"
            match = "rule"
        a = Alert(id=new_id(), event_id=inc.detail.get("event_id", "") or "", plate=inc.plate or "-", watchlist_plate=inc.kind.upper(),
                  match=match, camera_id=inc.camera_id, department=inc.department, ts=ts, priority=inc.priority, reason=reason)
        s.add(a)
        alerts.append({"id": a.id, "event_id": a.event_id, "plate": a.plate, "watchlist_plate": a.watchlist_plate, "match": match,
                       "camera_id": inc.camera_id, "department": inc.department, "ts": ts.isoformat(), "priority": inc.priority,
                       "reason": a.reason, "crop_url": f"/media/{inc.snapshot_path}" if inc.snapshot_path else "", "incident_id": inc.id,
                       "kind": inc.kind})
        off = offences().get(inc.kind)
        if off and off.get("challan", True) and inc.plate:
            repeat = s.scalar(select(Challan.id).where(Challan.plate == inc.plate, Challan.offence == inc.kind,
                                                       Challan.status.in_(("approved", "sent"))).limit(1)) is not None
            s.add(Challan(number=challan_number(s), event_id=inc.detail.get("event_id", ""), incident_id=inc.id, plate=inc.plate,
                          camera_id=inc.camera_id, department=inc.department, ts=ts, offence=inc.kind, section=off.get("section", ""),
                          fine_inr=int(off.get("repeat_inr" if repeat else "fine_inr", 0)), repeat=repeat,
                          detail=f"{LABELS.get(inc.kind, inc.kind)} zone {inc.zone}: {json.dumps(ev.get('detail') or {})}",
                          evidence={"snapshot_path": inc.snapshot_path, "incident_id": inc.id, "event_id": inc.detail.get("event_id", "")}))
        s.commit()
        return inc, alerts


@router.post("/internal/dets", dependencies=[Depends(internal)])
def internal_dets(msg: dict):
    """Live detection boxes from the workers: fanned out to consoles for the wall overlay, never stored."""
    from .api import broadcast_dets
    broadcast_dets(msg)
    return {"ok": True}


@router.post("/internal/incidents", dependencies=[Depends(internal)])
def internal_incident(ev: dict):
    from .api import broadcast
    if ev.get("type") == "traffic":                 # periodic traffic counts share the incidents topic
        from .api import _store_traffic
        _store_traffic(ev)
        broadcast("traffic", ev)
        return {"ok": True, "traffic": True}
    inc, alerts = ingest_incident(ev)
    broadcast("incident", _inc_dict(inc))
    for a in alerts:
        broadcast("alert", a)
    return {"ok": True, "id": inc.id, "alerts": len(alerts)}


@router.get("/api/traffic")
def traffic(camera_id: str = "", hours: int = 24, u: A.User = Depends(need("search"))):
    """Traffic counts per camera per window: average vehicles in view by class, peak, line-crossing flow."""
    from ..db import TrafficCount
    since = utcnow() - dt.timedelta(hours=max(1, min(hours, 24 * 30)))
    q = select(TrafficCount).where(TrafficCount.ts >= since).order_by(TrafficCount.ts.desc()).limit(5000)
    if camera_id:
        q = q.where(TrafficCount.camera_id == camera_id)
    depts = dept_filter(u)
    if depts is not None:
        q = q.where(TrafficCount.department.in_(depts))
    with SessionLocal() as s:
        rows = s.scalars(q).all()
        cams = {c.id: c.name for c in s.scalars(select(Camera))}
    out = [{"camera_id": r.camera_id, "camera_name": cams.get(r.camera_id, r.camera_id), "department": r.department, "ts": r.ts.isoformat(),
            "window_s": r.window_s, "avg_vehicles": r.avg_vehicles, "peak_vehicles": r.peak_vehicles, "avg": r.avg, "flow": r.flow} for r in rows]
    # per-camera summary for the period
    summary: dict[str, dict] = {}
    for r in rows:
        d = summary.setdefault(r.camera_id, {"camera_id": r.camera_id, "camera_name": cams.get(r.camera_id, r.camera_id), "windows": 0,
                                             "avg_vehicles": 0.0, "peak_vehicles": 0, "by_class": {}, "flow": {"a_to_b": 0, "b_to_a": 0}, "last": r.ts.isoformat()})
        d["windows"] += 1
        d["avg_vehicles"] += r.avg_vehicles
        d["peak_vehicles"] = max(d["peak_vehicles"], r.peak_vehicles)
        for k, v in (r.avg or {}).items():
            d["by_class"][k] = d["by_class"].get(k, 0.0) + v
        for k in ("a_to_b", "b_to_a"):
            d["flow"][k] += int((r.flow or {}).get(k, 0))
    for d in summary.values():
        n = max(1, d["windows"])
        d["avg_vehicles"] = round(d["avg_vehicles"] / n, 2)
        d["by_class"] = {k: round(v / n, 2) for k, v in d["by_class"].items()}
        d["avg_persons"] = d["by_class"].pop("person", 0.0)      # people are reported in their own column
    return {"hours": hours, "rows": out, "summary": sorted(summary.values(), key=lambda x: -x["avg_vehicles"])}


class DetectionBody(BaseModel):
    enabled: bool | None = None          # global switch
    camera_id: str | None = None         # per-camera override...
    on: bool | None = None               # ...true / false, or null to follow the global switch again
    clear_cameras: bool = False


@router.get("/api/detection")
def detection_state(u: A.User = Depends(current_user)):
    """AI detection switch: {enabled, cameras: {id: bool}} - workers run inference only where it allows."""
    from .. import detection as DETECT
    st = DETECT.state(max_age=0)
    return st | {"default": settings.detection_default}


@router.post("/api/detection")
def detection_set(body: DetectionBody, request: Request, u: A.User = Depends(need("supervisor"))):
    from .. import detection as DETECT
    try:
        st = DETECT.update(u.username, enabled=body.enabled, camera_id=body.camera_id, on=body.on, clear_cameras=body.clear_cameras)
    except PermissionError as e:
        raise HTTPException(423, str(e))
    with SessionLocal() as s:
        what = f"global {'ON' if st['enabled'] else 'OFF'}" if body.enabled is not None else (f"{body.camera_id} -> {body.on}" if body.camera_id else "reset overrides")
        audit(s, u.username, "detection_switch", body.camera_id or "global", what, _ip(request))
        from ..inbox import push
        push("detection", f"AI detection {what} by {u.username}", "ANPR, counting and face matching run only where detection is on",
             severity="warn" if (body.enabled is False or body.on is False) else "info", ref_id=body.camera_id or "global", link="wall", session=s)
        s.commit()
    from .api import broadcast
    broadcast("detection", st)
    return st


@router.get("/api/counts/timeline")
def counts_timeline(hours: int = 1, camera_id: str = "", u: A.User = Depends(current_user)):
    """Vehicles and persons in view per camera per minute (from the analytics worker's traffic windows) plus the
    crowd threshold, for the Counts tab: {cameras: [{camera_id, name, department, points: [[ts, vehicles, persons]],
    avg_vehicles, avg_persons, peak_vehicles, peak_persons, crowd_max}], since}."""
    from ..db import TrafficCount
    since = utcnow() - dt.timedelta(hours=max(1, min(hours, 24 * 7)))
    q = select(TrafficCount).where(TrafficCount.ts >= since).order_by(TrafficCount.ts.asc()).limit(20000)
    if camera_id:
        q = q.where(TrafficCount.camera_id == camera_id)
    depts = dept_filter(u)
    if depts is not None:
        q = q.where(TrafficCount.department.in_(depts))
    thresholds = {cid: int(((c or {}).get("crowd") or {}).get("max_persons") or settings.crowd_max_persons)
                  for cid, c in ((load_yaml(settings.analytics_file) or {}).get("cameras") or {}).items()}
    with SessionLocal() as s:
        rows = s.scalars(q).all()
        cams = {c.id: c for c in s.scalars(select(Camera))}
    out: dict[str, dict] = {}
    for x in rows:
        c = cams.get(x.camera_id)
        d = out.setdefault(x.camera_id, {"camera_id": x.camera_id, "name": c.name if c else x.camera_id, "department": x.department,
                                         "points": [], "peak_vehicles": 0, "peak_persons": 0, "_v": 0.0, "_p": 0.0,
                                         "crowd_max": thresholds.get(x.camera_id, settings.crowd_max_persons), "flow": {"a_to_b": 0, "b_to_a": 0}})
        persons = float((x.avg or {}).get("person", 0.0))
        d["points"].append([x.ts.isoformat(), round(x.avg_vehicles, 1), round(persons, 1)])
        d["peak_vehicles"] = max(d["peak_vehicles"], x.peak_vehicles)
        d["peak_persons"] = max(d["peak_persons"], int(round(persons)))
        d["_v"] += x.avg_vehicles; d["_p"] += persons
        for k in ("a_to_b", "b_to_a"):
            d["flow"][k] += int((x.flow or {}).get(k, 0))
    for d in out.values():
        n = max(1, len(d["points"]))
        d["avg_vehicles"] = round(d.pop("_v") / n, 1)
        d["avg_persons"] = round(d.pop("_p") / n, 1)
        d["windows"] = n
    return {"hours": hours, "since": since.isoformat(), "crowd_default": settings.crowd_max_persons,
            "cameras": sorted(out.values(), key=lambda d: -(d["avg_vehicles"] + d["avg_persons"]))}


@router.get("/api/incidents")
def list_incidents(kind: str = "", camera: str = "", open_only: bool = False, since: str | None = None, limit: int = 200,
                   u: A.User = Depends(need("search"))):
    with SessionLocal() as s:
        q = select(Incident).order_by(Incident.ts.desc()).limit(min(limit, 1000))
        if kind:
            q = q.where(Incident.kind == kind)
        if camera:
            q = q.where(Incident.camera_id == camera)
        if open_only:
            q = q.where(Incident.ack_at.is_(None))
        if since:
            q = q.where(Incident.ts >= _parse_time(since))
        rows = [i for i in s.scalars(q) if u.sees(i.department)]
    return [_inc_dict(i, u) for i in rows]


@router.post("/api/incidents/{iid}/ack")
def ack_incident(iid: str, request: Request, u: A.User = Depends(need("alerts_ack"))):
    with SessionLocal() as s:
        i = s.get(Incident, iid)
        if not i or not u.sees(i.department):
            raise HTTPException(404)
        i.ack_by, i.ack_at = u.username, utcnow()
        audit(s, u.username, "incident_ack", iid, i.kind, _ip(request))
        s.commit()
    return {"ok": True}


@router.get("/api/incidents/stats")
def incident_stats(hours: int = 24, u: A.User = Depends(need("search"))):
    since = utcnow() - dt.timedelta(hours=hours)
    depts = dept_filter(u)
    with SessionLocal() as s:
        q = select(Incident.kind, func.count()).where(Incident.ts >= since)
        if depts is not None:
            q = q.where(Incident.department.in_(depts))
        rows = s.execute(q.group_by(Incident.kind)).all()
        q2 = select(Challan.status, func.count())
        if depts is not None:
            q2 = q2.where(Challan.department.in_(depts))
        ch = s.execute(q2.group_by(Challan.status)).all()
    return {"incidents": {k: n for k, n in rows}, "challans": {k: n for k, n in ch}}


# ----------------------------------------------------------------------------- challans
def _ch_dict(c: Challan, u: A.User | None = None) -> dict:
    ev = c.evidence or {}
    d = {"id": c.id, "number": c.number, "event_id": c.event_id, "incident_id": c.incident_id, "plate": c.plate,
         "camera_id": c.camera_id, "department": c.department, "ts": c.ts.isoformat(), "offence": c.offence,
         "label": LABELS.get(c.offence, c.offence), "section": c.section, "fine_inr": c.fine_inr, "repeat": c.repeat,
         "detail": c.detail, "status": c.status, "created_at": c.created_at.isoformat(), "reviewed_by": c.reviewed_by,
         "reviewed_at": c.reviewed_at.isoformat() if c.reviewed_at else None, "remarks": c.remarks,
         "sent_at": c.sent_at.isoformat() if c.sent_at else None, "external_ref": c.external_ref,
         "crop_url": f"/media/{ev['crop_path']}" if ev.get("crop_path") else "",
         "frame_url": f"/media/{ev['frame_path']}" if ev.get("frame_path") else (f"/media/{ev['snapshot_path']}" if ev.get("snapshot_path") else "")}
    return pii.mask_event(d, u) if u else d


@router.get("/api/challans")
def list_challans(status: str = "draft", offence: str = "", plate: str = "", limit: int = 300, u: A.User = Depends(need("search"))):
    with SessionLocal() as s:
        q = select(Challan).order_by(Challan.ts.desc()).limit(min(limit, 2000))
        if status and status != "all":
            q = q.where(Challan.status == status)
        if offence:
            q = q.where(Challan.offence == offence)
        if plate:
            from ..plates import normalise
            q = q.where(Challan.plate == normalise(plate))
        rows = [c for c in s.scalars(q) if u.sees(c.department)]
    return [_ch_dict(c, u) for c in rows]


class ReviewIn(BaseModel):
    action: str          # approve | reject
    remarks: str = ""
    fine_inr: int | None = None


def _push_echallan(c: Challan) -> tuple[bool, str]:
    """Signed JSON to the state e-challan endpoint (contract in docs/analytics.md). Returns (ok, ref/error)."""
    if not settings.echallan_webhook_url:
        return False, "ECHALLAN_WEBHOOK_URL not configured"
    payload = {"challan_number": c.number, "plate": c.plate, "offence": c.offence, "label": LABELS.get(c.offence, c.offence),
               "section": c.section, "fine_inr": c.fine_inr, "repeat_offence": c.repeat, "occurred_at": c.ts.isoformat(),
               "camera_id": c.camera_id, "department": c.department, "detail": c.detail, "evidence": c.evidence,
               "approved_by": c.reviewed_by, "approved_at": c.reviewed_at.isoformat() if c.reviewed_at else None,
               "platform_signature": signing.sign_manifest({"challan": c.number, "plate": c.plate, "offence": c.offence,
                                                            "fine_inr": c.fine_inr, "occurred_at": c.ts.isoformat()})}
    body = json.dumps(payload, sort_keys=True).encode()
    headers = {"Content-Type": "application/json"}
    if settings.echallan_webhook_secret:
        headers["X-UVP-Signature"] = hmac.new(settings.echallan_webhook_secret.encode(), body, hashlib.sha256).hexdigest()
    try:
        r = requests.post(settings.echallan_webhook_url, data=body, headers=headers, timeout=15)
        if r.ok:
            try:
                return True, str(r.json().get("reference") or r.json().get("id") or r.text[:100])
            except Exception:  # noqa: BLE001
                return True, r.text[:100]
        return False, f"HTTP {r.status_code}: {r.text[:200]}"
    except requests.RequestException as e:
        return False, str(e)[:200]


@router.post("/api/challans/{cid}/review")
def review_challan(cid: str, body: ReviewIn, request: Request, u: A.User = Depends(need("alerts_ack"))):
    if body.action not in ("approve", "reject"):
        raise HTTPException(400, "action must be approve | reject")
    with SessionLocal() as s:
        c = s.get(Challan, cid)
        if not c or not u.sees(c.department):
            raise HTTPException(404)
        if c.status not in ("draft", "failed"):
            raise HTTPException(409, f"challan is {c.status}")
        c.reviewed_by, c.reviewed_at, c.remarks = u.username, utcnow(), body.remarks[:1000]
        if body.fine_inr is not None:
            c.fine_inr = int(body.fine_inr)
        if body.action == "reject":
            c.status = "rejected"
        else:
            c.status = "approved"
            ok, ref = _push_echallan(c)
            if ok:
                c.status, c.sent_at, c.external_ref = "sent", utcnow(), ref
            elif settings.echallan_webhook_url:
                c.status, c.remarks = "failed", (c.remarks + " | send failed: " + ref)[:1000]
        audit(s, u.username, f"challan_{body.action}", c.number, f"{c.plate} {c.offence} Rs {c.fine_inr} -> {c.status}", _ip(request))
        s.commit()
        out = _ch_dict(c, u)
    from ..notify import notify
    notify("challan", _ch_dict(c))
    return out


@router.get("/api/challans/{cid}/export")
def export_challan(cid: str, request: Request, u: A.User = Depends(need("export"))):
    """Signed evidence pack for one challan: PDF notice draft + watermarked evidence + manifest."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer
    import zipfile
    with SessionLocal() as s:
        c = s.get(Challan, cid)
        if not c or not u.sees(c.department):
            raise HTTPException(404)
        cam = s.get(Camera, c.camera_id)
        ev = s.get(AnprEvent, c.event_id) if c.event_id else None
        tmp = Path(tempfile.mkdtemp(prefix="uvp-ch-"))
        wm = pii.watermark_text(u.username, extra=c.number)
        files: dict[str, Path] = {}
        evd = c.evidence or {}
        for key, name in (("frame_path", "frame.jpg"), ("snapshot_path", "snapshot.jpg")):
            p = settings.data_dir / evd[key] if evd.get(key) else None
            if p and p.exists():
                pii.watermark_image(p, tmp / name, wm)
                files[name] = tmp / name
        if evd.get("crop_path") and (settings.data_dir / evd["crop_path"]).exists():
            import shutil
            shutil.copyfile(settings.data_dir / evd["crop_path"], tmp / "plate.jpg")
            files["plate.jpg"] = tmp / "plate.jpg"
        if ev is not None and ev.clip_key not in ("", "-"):
            from ..investigation import fetch_object
            src = fetch_object(ev.clip_key, tmp / "clip_src.mp4")
            if src:
                try:
                    pii.watermark_video(src, tmp / "clip.mp4", wm)
                    files["clip.mp4"] = tmp / "clip.mp4"
                except Exception:  # noqa: BLE001
                    pass
        ss = getSampleStyleSheet()
        doc = SimpleDocTemplate(str(tmp / "challan.pdf"), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm)
        ist = dt.timezone(dt.timedelta(minutes=330))
        el = [Paragraph(f"E-challan draft · {c.number}", ss["Title"]),
              Paragraph(f"<b>Offence:</b> {LABELS.get(c.offence, c.offence)} ({c.section})", ss["Normal"]),
              Paragraph(f"<b>Vehicle:</b> {c.plate} &nbsp; <b>Fine:</b> Rs {c.fine_inr}{' (repeat offence)' if c.repeat else ''}", ss["Normal"]),
              Paragraph(f"<b>When:</b> {c.ts.astimezone(ist):%d %b %Y %H:%M:%S} IST &nbsp; <b>Where:</b> {cam.name if cam else c.camera_id} ({c.department})", ss["Normal"]),
              Paragraph(f"<b>Detail:</b> {c.detail}", ss["Normal"]),
              Paragraph(f"<b>Status:</b> {c.status} · reviewed by {c.reviewed_by or '-'} · remarks: {c.remarks or '-'}", ss["Normal"]),
              Spacer(1, 8)]
        for name in ("frame.jpg", "snapshot.jpg", "plate.jpg"):
            if name in files:
                el.append(Image(str(files[name]), width=160 * mm, height=90 * mm, kind="proportional"))
                el.append(Spacer(1, 6))
        el.append(Paragraph("Generated by the Unified CCTV Viewing Platform. Fine amounts are the central MV Act defaults and must be "
                            "confirmed against the state notification before issue. Every file is SHA-256 hashed in manifest.json and "
                            "the manifest is Ed25519-signed (manifest.sig, public_key.pem).", ss["Italic"]))
        doc.build(el)
        files = {"challan.pdf": tmp / "challan.pdf", **files}
        manifest = signing.build_manifest(files, u.username, f"challan_{c.number}", {"challan": _ch_dict(c)})
        z = tmp / f"{c.number}.zip"
        with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
            for n, p in files.items():
                zf.write(p, n)
            zf.writestr("manifest.json", json.dumps(manifest, indent=1))
            zf.writestr("manifest.sig", signing.sign_manifest(manifest))
            zf.writestr("public_key.pem", signing.public_key_pem())
        audit(s, u.username, "challan_export", c.number, c.plate, _ip(request))
        s.commit()
        return FileResponse(z, filename=z.name, media_type="application/zip")


@router.get("/api/offences")
def list_offences(u: A.User = Depends(current_user)):
    return {k: {**v, "label": LABELS.get(k, k)} for k, v in offences().items()}


# ----------------------------------------------------------------------------- plate review + accuracy reports
class ReviewPlateIn(BaseModel):
    verdict: str                 # confirmed | corrected | unreadable
    true_plate: str = ""
    reason: str = ""


@router.post("/api/events/{eid}/review")
def review_plate(eid: str, body: ReviewPlateIn, request: Request, u: A.User = Depends(need("plate_search"))):
    """Operator verdict on a read. A correction rewrites the event's plate (old value kept in plate_raw/tags)."""
    from ..db import PlateReview
    from ..plates import correct, normalise
    from ..search import backend, event_dict
    if body.verdict not in ("confirmed", "corrected", "unreadable"):
        raise HTTPException(400, "verdict must be confirmed | corrected | unreadable")
    with SessionLocal() as s:
        e = s.get(AnprEvent, eid)
        if not e or not u.sees(e.department):
            raise HTTPException(404)
        truth = e.plate
        if body.verdict == "corrected":
            truth = normalise(body.true_plate)
            if len(truth) < 6 or truth == e.plate:
                raise HTTPException(400, "give the corrected plate (different from the read)")
        if body.verdict == "unreadable":
            truth = ""
        r = PlateReview(event_id=e.id, camera_id=e.camera_id, department=e.department, read_plate=e.plate, true_plate=truth,
                        verdict=body.verdict, reason=body.reason[:64], confidence=e.confidence, crop_path=e.crop_path, user_id=u.username)
        s.add(r)
        if body.verdict == "corrected":
            e.tags = sorted(set((e.tags or []) + ["corrected"]) - {"invalid_format", "non_standard_plate", "challan_suggested"})
            e.plate = truth
            e.plate_valid = correct(truth).valid
            e.confidence = 1.0
            for c in s.scalars(select(Challan).where(Challan.event_id == e.id, Challan.status == "draft")):
                if c.offence == "non_standard_plate":
                    c.status, c.remarks, c.reviewed_by, c.reviewed_at = "rejected", "plate corrected by operator", u.username, utcnow()
                else:
                    c.plate = truth
            for a in s.scalars(select(Alert).where(Alert.event_id == e.id)):
                a.plate = truth
        audit(s, u.username, f"plate_{body.verdict}", e.id, f"{r.read_plate} -> {truth} {body.reason}", _ip(request))
        s.commit()
        doc = event_dict(e)
    try:
        backend().index(doc)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "plate": doc["plate"], "verdict": body.verdict}


@router.get("/api/reports/anpr/review-queue")
def review_queue(limit: int = 50, u: A.User = Depends(need("plate_search"))):
    from ..reports import review_queue as rq
    from ..search import event_dict
    with SessionLocal() as s:
        rows = rq(s, dept_filter(u), limit)
        return [event_dict(e) for e in rows]


@router.get("/api/reports/anpr")
def anpr_report(weeks_ago: int = 0, u: A.User = Depends(need("search"))):
    from ..reports import weekly
    with SessionLocal() as s:
        return weekly(s, weeks_ago, dept_filter(u))


@router.get("/api/reports/anpr/training-set.zip")
def training_set(request: Request, days: int = 90, u: A.User = Depends(need("export"))):
    from fastapi.responses import Response
    from ..reports import training_set as ts
    with SessionLocal() as s:
        data = ts(s, dept_filter(u), days)
        audit(s, u.username, "training_set_export", "", f"days={days} bytes={len(data)}", _ip(request))
        s.commit()
    return Response(data, media_type="application/zip", headers={"Content-Disposition": "attachment; filename=anpr_training_set.zip"})


@router.get("/api/reports/anpr/history")
def anpr_report_history(u: A.User = Depends(need("search"))):
    d = settings.data_dir / "reports"
    out = []
    if d.exists():
        for p in sorted(d.glob("anpr_week_*.json"))[-12:]:
            try:
                j = json.loads(p.read_text())
                out.append({"week_start": j["week_start"], "reads": j["reads"], "reviewed": j["reviewed"], "accuracy_pct": j["accuracy_pct"]})
            except Exception:  # noqa: BLE001
                pass
    return out


# ----------------------------------------------------------------------------- hotlists
@router.get("/api/hotlists")
def hotlists(u: A.User = Depends(need("watchlist"))):
    from .hotlist_sync import status as hl_status
    return hl_status()


@router.post("/api/hotlists/sync")
def hotlists_sync(request: Request, u: A.User = Depends(need("watchlist"))):
    from .hotlist_sync import sync_all
    res = sync_all()
    with SessionLocal() as s:
        audit(s, u.username, "hotlist_sync", "", json.dumps(res)[:400], _ip(request))
        s.commit()
    return res


# ----------------------------------------------------------------------------- face search: legally gated, not implemented
@router.get("/api/face/{rest:path}")
@router.post("/api/face/{rest:path}")
def face_gate(rest: str, u: A.User = Depends(current_user)):
    cfg = (load_yaml(settings.analytics_file) or {}).get("face_search") or {}
    if not cfg.get("enabled") or not cfg.get("legal_clearance_ref"):
        raise HTTPException(451, "Face search is disabled: it requires a recorded legal clearance reference and a DPIA "
                                 "(config/analytics.yaml: face_search). No face data is processed by this platform.")
    raise HTTPException(501, "Face search module is not installed in this build.")
