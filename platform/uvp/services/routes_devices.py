"""Connect CCTV devices from the console (no yaml editing).

  GET    /api/devices/types        device types + vendor presets for the form
  POST   /api/devices/test         try one stream with the given host / credentials before saving
  GET    /api/devices              console-managed devices (credentials never returned)
  POST   /api/devices              connect a device: stored encrypted, adapters pick it up within seconds
  PATCH  /api/devices/{id}         change host / channels / credentials (blank password keeps the old one)
  DELETE /api/devices/{id}         disconnect: relay paths removed, its cameras leave the registry

Reading needs `sources`; connecting / changing / removing needs `admin`. Every change is audited.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import auth as A
from ..adapters.registry import presets
from ..db import Camera, SessionLocal, Source, audit
from ..inbox import push
from ..relay import path_name, relay
from . import devices as D
from .deps import _ip, need

log = logging.getLogger("uvp.devices")
router = APIRouter()


class DeviceBody(BaseModel):
    type: str = "nvr"
    id: str | None = None
    name: str
    department: str
    vendor: str | None = None
    host: str | None = None
    rtsp_port: int | None = None
    onvif_port: int | None = None
    username: str | None = None
    password: str | None = None
    channels: int | list | None = None
    id_prefix: str | None = None
    main_url: str | None = None
    sub_url: str | None = None
    main_template: str | None = None
    sub_template: str | None = None
    camera_id: str | None = None
    lat: float | None = None
    lon: float | None = None
    heading: float | None = None
    fov: float | None = None
    range_m: float | None = None
    anpr: bool = False
    record: str | None = None
    max_concurrent_pulls: int | None = None
    persistent_pull: bool | None = None


class TestBody(DeviceBody):
    channel: int = 1


@router.get("/api/devices/types")
def device_types(u: A.User = Depends(need("sources"))):
    vend = {k: {"adapter": v.get("adapter"), "notes": v.get("notes", ""), "main": v.get("main", ""), "onvif_port": v.get("onvif_port")}
            for k, v in presets().items() if v.get("adapter") in ("rtsp_template", "onvif")}
    return {"types": D.DEVICE_TYPES, "vendors": vend}


@router.post("/api/devices/test")
def device_test(body: TestBody, u: A.User = Depends(need("admin"))):
    d = body.model_dump()
    try:
        cfg = D.build_config(d)
    except ValueError as e:
        raise HTTPException(400, str(e))
    url = D.probe_url(cfg, d.get("username") or "", d.get("password") or "", channel=body.channel)
    res = D.test_stream(url)
    res["url"] = D.redact(url) if url else ""
    res["cameras"] = len(cfg.get("channels") or cfg.get("streams") or [])
    return res


@router.get("/api/devices")
def list_devices(u: A.User = Depends(need("sources"))):
    with SessionLocal() as s:
        rows = s.scalars(select(Source).where(Source.managed.is_(True)).order_by(Source.department, Source.id)).all()
        cams = {}
        for c in s.query(Camera):
            cams[c.source_id] = cams.get(c.source_id, 0) + 1
        return [D.public_row(r) | {"cameras": cams.get(r.id, 0)} for r in rows if u.sees(r.department)]


@router.post("/api/devices", status_code=201)
def create_device(body: DeviceBody, request: Request, u: A.User = Depends(need("admin"))):
    d = body.model_dump()
    if not u.sees(d["department"]):
        raise HTTPException(403, "not your department")
    try:
        r = D.save_device(d, u.username)
    except ValueError as e:
        raise HTTPException(400, str(e))
    with SessionLocal() as s:
        audit(s, u.username, "device_connect", r.id, f"{r.adapter} {d.get('vendor') or ''} {d.get('host') or d.get('main_url') or ''} ({r.department})".strip(), _ip(request))
        push("device", f"Device connected: {d.get('name') or r.id}", f"{r.adapter} {d.get('vendor') or ''} {d.get('host') or ''} · {r.department} · by {u.username}".strip(),
             department=r.department, ref_id=r.id, link="sources", feature="sources", session=s)
        s.commit()
    return D.public_row(r)


@router.patch("/api/devices/{sid}")
def update_device(sid: str, body: DeviceBody, request: Request, u: A.User = Depends(need("admin"))):
    d = body.model_dump()
    try:
        r = D.save_device(d, u.username, device_id=sid)
    except KeyError:
        raise HTTPException(404, "no such console-managed device")
    except ValueError as e:
        raise HTTPException(400, str(e))
    with SessionLocal() as s:
        audit(s, u.username, "device_update", sid, f"{r.adapter} {d.get('host') or ''}", _ip(request))
        push("device", f"Device changed: {d.get('name') or sid}", f"{r.adapter} {d.get('host') or ''} · by {u.username}".strip(), department=r.department,
             ref_id=sid, link="sources", feature="sources", session=s)
        s.commit()
    return D.public_row(r)


@router.delete("/api/devices/{sid}")
def delete_device(sid: str, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        r = s.get(Source, sid)
        if r is None or not r.managed:
            raise HTTPException(404, "no such console-managed device (sources.yaml entries are removed in the file)")
        cams = s.scalars(select(Camera).where(Camera.source_id == sid)).all()
        for c in cams:
            for prof in ("main", "sub"):
                try:
                    relay.delete_path(path_name(c.id, prof), c.relay or None)
                except Exception:  # noqa: BLE001
                    pass
            s.delete(c)
        s.delete(r)
        audit(s, u.username, "device_disconnect", sid, f"{len(cams)} camera(s) removed", _ip(request))
        push("device", f"Device disconnected: {r.name or sid}", f"{len(cams)} camera(s) removed · by {u.username}", department=r.department, severity="warn",
             ref_id=sid, link="sources", feature="sources", session=s)
        s.commit()
    return {"ok": True, "cameras_removed": len(cams)}


@router.get("/api/devices/{sid}/site-connector.zip")
def site_connector(sid: str, request: Request, u: A.User = Depends(need("admin"))):
    """The site-connector bundle for a push device (docker-compose + cameras list + key), as a zip."""
    import io
    import zipfile
    from fastapi.responses import Response
    with SessionLocal() as s:
        r = s.get(Source, sid)
        if r is None or not r.managed or (r.config or {}).get("adapter") != "push":
            raise HTTPException(404, "no such push device")
        host = relay.get(None).public_host or request.headers.get("x-forwarded-host", "").split(":")[0] or request.url.hostname or "SERVER-IP"
        files = D.site_connector_bundle(r, host)
        audit(s, u.username, "device_bundle", sid, "site connector downloaded", _ip(request))
        s.commit()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in files.items():
            z.writestr(f"site-connector-{sid}/{name}", body)
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f"attachment; filename=site-connector-{sid}.zip"})
