"""VIP routes / road corridors, and external lookup APIs (Vahan, Sarathi) configured from the console.

Routes (read: any signed-in user, scoped to the cameras they may see; write: registry_edit)
  GET    /api/routes                        all routes with camera counts
  POST   /api/routes                        {name, waypoints: ["Amroha", "Delhi"] | [{lat, lon, name}], buffer_m, road, area, department, priority, follow_roads}
  GET    /api/routes/{id}                   route + ordered cameras (km from start)
  PATCH  /api/routes/{id}
  DELETE /api/routes/{id}
  POST   /api/routes/preview                same body as POST -> cameras without saving (editor live preview)
  GET    /api/routes/geocode?q=Amroha       place -> candidates (Nominatim / GEOCODE_URL, biased to the camera area)
  GET    /api/routes/places?q=&geocode=     drop-down choices: camera areas, saved places, geofence centres, camera sites (+ map search)

External APIs (Admin -> External APIs; lookups need plate_search)
  GET    /api/integrations                  vahan / sarathi / custom with masked secrets + last test
  PUT    /api/integrations/{name}           {enabled, url, method, auth, header_name, username, secret, extra_headers, body, timeout_s, cache_s, notes}
  POST   /api/integrations/{name}/test      ?value=GJ01AB1234 -> live call, result recorded as last_test
  GET    /api/lookup/vahan/{plate}          registration details (also served at /api/vehicles/{plate}/registration)
  GET    /api/lookup/sarathi/{dl}           driving licence details
  GET    /api/lookup/custom/{value}
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import auth as A
from .. import corridors, geofences, inbox, integrations
from ..db import Geofence, Route, SessionLocal, audit
from ..plates import normalise
from .deps import _ip, current_user, need

log = logging.getLogger("uvp.corridors")
router = APIRouter()


# ----------------------------------------------------------------------------- routes
class RouteBody(BaseModel):
    name: str | None = None
    description: str | None = None
    waypoints: list | None = None
    follow_roads: bool = True
    buffer_m: int | None = None
    road: str | None = None
    area: str | None = None
    department: str | None = None
    priority: str | None = None
    camera_ids: list[str] | None = None
    exclude_ids: list[str] | None = None
    active_from: str | None = None
    active_to: str | None = None


_CENTRE: dict = {"at": 0.0, "pt": None}


def _near() -> tuple[float, float] | None:
    """Centroid of the registered cameras (cached 10 min): the geocoder prefers places near the deployment,
    so 'Janpath' in an Ahmedabad installation is Janpath, Ahmedabad - not the one in New Delhi."""
    import time
    if time.time() - _CENTRE["at"] > 600:
        try:
            with SessionLocal() as s:
                _CENTRE["pt"] = corridors.camera_centre(corridors.visible_cameras(s))
        except Exception:  # noqa: BLE001
            _CENTRE["pt"] = None
        _CENTRE["at"] = time.time()
    return _CENTRE["pt"]


def _geocode(q: str):
    from .routes_registry import geocode
    return geocode(q, near=_near())


@router.get("/api/routes")
def list_routes(u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        rows = s.scalars(select(Route).order_by(Route.priority.desc(), Route.name)).all()
        return [corridors.full_dict(s, r, u) for r in rows]


@router.post("/api/routes", status_code=201)
def create_route(body: RouteBody, request: Request, u: A.User = Depends(need("registry_edit"))):
    d = {k: v for k, v in body.model_dump().items() if v is not None}
    with SessionLocal() as s:
        try:
            r = corridors.build_route(d, _geocode, actor=u.username)
        except ValueError as e:
            raise HTTPException(400, str(e))
        s.add(r)
        s.flush()
        cams = corridors.cameras_for(s, r, u)
        audit(s, u.username, "route_create", r.id, f"{r.name}: {len(cams)} camera(s), {len(r.waypoints or [])} waypoint(s), road={r.road!r} area={r.area!r}", _ip(request))
        s.commit()
        d = corridors.route_dict(r, cams)
        d["nearest"] = corridors.nearest_for(s, r, cams, u)
        return d


@router.post("/api/routes/preview")
def preview_route(body: RouteBody, u: A.User = Depends(current_user)):
    d = {k: v for k, v in body.model_dump().items() if v is not None}
    d.setdefault("name", "preview")
    with SessionLocal() as s:
        try:
            return corridors.preview(s, d, _geocode, u)
        except ValueError as e:
            raise HTTPException(400, str(e))


@router.get("/api/routes/geocode")
def geocode_place(q: str, u: A.User = Depends(current_user)):
    if not q.strip():
        raise HTTPException(400, "q required")
    return {"query": q, "candidates": _geocode(q)}


@router.get("/api/routes/places")
def route_places(q: str = "", geocode: bool = False, limit: int = 60, u: A.User = Depends(current_user)):
    """Choices for the Source / Destination / Via drop-downs of the route editor: the areas the cameras are in,
    saved route places, geofence centres and every camera site (all with coordinates, so no geocoding is needed).
    With geocode=true and a query of 3+ characters, map search results (biased to the deployment area) are appended."""
    with SessionLocal() as s:
        cams = corridors.visible_cameras(s, u)
        routes = s.scalars(select(Route)).all()
        fences = s.scalars(select(Geofence)).all()
        items = corridors.places(cams, q, routes, fences, limit=max(1, min(limit, 200)))
    if geocode and len(q.strip()) >= 3:
        have = {(round(p["lat"], 3), round(p["lon"], 3)) for p in items}
        for c in _geocode(q.strip()):
            if "lat" in c and (round(c["lat"], 3), round(c["lon"], 3)) not in have:
                items.append({"kind": "map", "name": (c.get("label") or q).split(",")[0][:80], "label": (c.get("label") or "")[:120],
                              "lat": c["lat"], "lon": c["lon"], "count": 0})
    return {"query": q, "items": items}


@router.get("/api/routes/{rid}")
def get_route(rid: str, u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        r = s.get(Route, rid)
        if r is None:
            raise HTTPException(404, "no such route")
        return corridors.full_dict(s, r, u)


@router.patch("/api/routes/{rid}")
def update_route(rid: str, body: RouteBody, request: Request, u: A.User = Depends(need("registry_edit"))):
    d = {k: v for k, v in body.model_dump().items() if v is not None}
    with SessionLocal() as s:
        r = s.get(Route, rid)
        if r is None:
            raise HTTPException(404, "no such route")
        try:
            corridors.build_route(d, _geocode, existing=r, actor=u.username)
        except ValueError as e:
            raise HTTPException(400, str(e))
        cams = corridors.cameras_for(s, r, u)
        audit(s, u.username, "route_update", r.id, f"{r.name}: {len(cams)} camera(s)", _ip(request))
        s.commit()
        d = corridors.route_dict(r, cams)
        d["nearest"] = corridors.nearest_for(s, r, cams, u)
        return d


@router.delete("/api/routes/{rid}")
def delete_route(rid: str, request: Request, u: A.User = Depends(need("registry_edit"))):
    with SessionLocal() as s:
        r = s.get(Route, rid)
        if r is None:
            raise HTTPException(404, "no such route")
        s.delete(r)
        audit(s, u.username, "route_delete", rid, r.name, _ip(request))
        s.commit()
        return {"ok": True}


# ----------------------------------------------------------------------------- external APIs
class IntegrationBody(BaseModel):
    enabled: bool = False
    url: str = ""
    method: str = "GET"
    auth: str = "header"
    header_name: str = "X-API-Key"
    username: str = ""
    secret: str = ""
    clear_secret: bool = False
    extra_headers: dict | str = {}
    body: str = ""
    timeout_s: int = 15
    cache_s: int = 3600
    notes: str = ""


@router.get("/api/integrations")
def list_integrations(u: A.User = Depends(need("admin"))):
    return {"integrations": [integrations.load(n) for n in integrations.KINDS], "auth_types": list(integrations.AUTH_TYPES)}


@router.put("/api/integrations/{name}")
def save_integration(name: str, body: IntegrationBody, request: Request, u: A.User = Depends(need("admin"))):
    try:
        out = integrations.save(name, body.model_dump(), u.username)
    except ValueError as e:
        raise HTTPException(400, str(e))
    with SessionLocal() as s:
        audit(s, u.username, "integration_update", name, f"enabled={out['enabled']} url={out['url']} auth={out['auth']}" + (" secret=changed" if body.secret or body.clear_secret else ""), _ip(request))
        s.commit()
    return out


@router.post("/api/integrations/{name}/test")
def test_integration(name: str, request: Request, value: str = "", u: A.User = Depends(need("admin"))):
    if name not in integrations.KINDS:
        raise HTTPException(404, "unknown integration")
    value = value or integrations.KINDS[name]["sample"]
    try:
        res = integrations.lookup(name, value, use_cache=False)
        integrations.record_test(name, True, f"HTTP OK in {res['ms']} ms for {value}")
        out = {"ok": True, "ms": res["ms"], "value": value, "rows": integrations.flatten(res["data"])[:60], "data": res["data"]}
    except RuntimeError as e:
        integrations.record_test(name, False, str(e))
        out = {"ok": False, "error": str(e), "value": value}
    with SessionLocal() as s:
        audit(s, u.username, "integration_test", name, f"{value}: {'ok' if out['ok'] else out.get('error', '')[:120]}", _ip(request))
        s.commit()
    return out


@router.get("/api/lookup/{name}/{value}")
def lookup(name: str, value: str, request: Request, u: A.User = Depends(need("plate_search"))):
    if name not in integrations.KINDS:
        raise HTTPException(404, "unknown integration")
    v = normalise(value) if name == "vahan" else value.replace(" ", "").upper()
    try:
        res = integrations.lookup(name, v)
    except RuntimeError as e:
        raise HTTPException(501 if "not configured" in str(e) else 502, str(e))
    with SessionLocal() as s:
        audit(s, u.username, f"{name}_lookup", v, "cached" if res.get("cached") else "", _ip(request))
        s.commit()
    return {**res, "rows": integrations.flatten(res["data"])[:80]}


# ----------------------------------------------------------------------------- geofences
class FenceBody(BaseModel):
    name: str | None = None
    description: str | None = None
    kind: str | None = None
    lat: float | None = None
    lon: float | None = None
    radius_m: int | None = None
    polygon: list | None = None
    department: str | None = None
    notify_kinds: list[str] | None = None
    severity: str | None = None
    active: bool | None = None


@router.get("/api/geofences")
def list_geofences(u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        rows = s.scalars(select(Geofence).order_by(Geofence.name)).all()
        return [geofences.fence_dict(f, geofences.cameras_for(s, f, u)) for f in rows]


@router.post("/api/geofences", status_code=201)
def create_geofence(body: FenceBody, request: Request, u: A.User = Depends(need("registry_edit"))):
    d = {k: v for k, v in body.model_dump().items() if v is not None}
    with SessionLocal() as s:
        try:
            f = geofences.build(d, actor=u.username)
        except ValueError as e:
            raise HTTPException(400, str(e))
        s.add(f)
        s.flush()
        cams = geofences.cameras_for(s, f, u)
        audit(s, u.username, "geofence_create", f.id, f"{f.name}: {f.kind}, {len(cams)} camera(s)", _ip(request))
        s.commit()
        return geofences.fence_dict(f, cams)


@router.post("/api/geofences/preview")
def preview_geofence(body: FenceBody, u: A.User = Depends(current_user)):
    d = {k: v for k, v in body.model_dump().items() if v is not None}
    d.setdefault("name", "preview")
    with SessionLocal() as s:
        try:
            f = geofences.build(d, actor="preview")
        except ValueError as e:
            raise HTTPException(400, str(e))
        cams = geofences.cameras_for(s, f, u)
        return {"cameras": cams, "camera_count": len(cams), "area_km2": geofences.area_km2(f)}


@router.get("/api/geofences/{fid}")
def get_geofence(fid: str, u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        f = s.get(Geofence, fid)
        if f is None:
            raise HTTPException(404, "no such geofence")
        return geofences.fence_dict(f, geofences.cameras_for(s, f, u))


@router.patch("/api/geofences/{fid}")
def update_geofence(fid: str, body: FenceBody, request: Request, u: A.User = Depends(need("registry_edit"))):
    d = {k: v for k, v in body.model_dump().items() if v is not None}
    with SessionLocal() as s:
        f = s.get(Geofence, fid)
        if f is None:
            raise HTTPException(404, "no such geofence")
        try:
            geofences.build(d, existing=f, actor=u.username)
        except ValueError as e:
            raise HTTPException(400, str(e))
        cams = geofences.cameras_for(s, f, u)
        audit(s, u.username, "geofence_update", f.id, f"{f.name}: {len(cams)} camera(s)", _ip(request))
        s.commit()
        return geofences.fence_dict(f, cams)


@router.delete("/api/geofences/{fid}")
def delete_geofence(fid: str, request: Request, u: A.User = Depends(need("registry_edit"))):
    with SessionLocal() as s:
        f = s.get(Geofence, fid)
        if f is None:
            raise HTTPException(404, "no such geofence")
        s.delete(f)
        audit(s, u.username, "geofence_delete", fid, f.name, _ip(request))
        s.commit()
    geofences._invalidate()
    return {"ok": True}


# ----------------------------------------------------------------------------- notification preferences (per user)
class PrefsBody(BaseModel):
    kinds: list[str] | None = None
    min_severity: str | None = None
    toast: bool | None = None
    speak: bool | None = None
    speak_min_severity: str | None = None
    badge: bool | None = None


@router.get("/api/notifications/preferences")
def get_prefs(u: A.User = Depends(current_user)):
    return {"preferences": inbox.preferences(u.username), "kinds": inbox.KINDS, "severities": inbox.SEVERITIES}


@router.put("/api/notifications/preferences")
def put_prefs(body: PrefsBody, request: Request, u: A.User = Depends(current_user)):
    cur = inbox.preferences(u.username)
    cur.update({k: v for k, v in body.model_dump().items() if v is not None})
    p = inbox.save_preferences(u.username, cur)
    with SessionLocal() as s:
        audit(s, u.username, "notify_prefs", "", f"kinds={len(p['kinds'])} min={p['min_severity']} speak={p['speak']}", _ip(request))
        s.commit()
    return {"preferences": p}
