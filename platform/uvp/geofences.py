"""Geofences: areas picked on the map (a circle around a point, or a polygon) that group the cameras inside them
and raise a notification when an alert / incident / camera event happens inside.

  cameras_in(fence, cams)      cameras whose position is inside the fence
  fences_for_camera(cam_id)    active fences containing that camera (cached 30 s) - used by inbox.from_event
"""
from __future__ import annotations

import logging
import math
import threading
import time

from sqlalchemy import select

from .corridors import haversine_m
from .db import Camera, Geofence, SessionLocal, utcnow

log = logging.getLogger("uvp.geofences")
_cache: dict = {"at": 0.0, "by_cam": {}}
_lock = threading.Lock()


def point_in_polygon(lat: float, lon: float, poly: list[list[float]]) -> bool:
    """Ray casting on [lat, lon] pairs."""
    inside = False
    n = len(poly)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        yi, xi = poly[i][0], poly[i][1]
        yj, xj = poly[j][0], poly[j][1]
        if (xi > lon) != (xj > lon):
            x_at = (yj - yi) * (lon - xi) / ((xj - xi) or 1e-12) + yi
            if lat < x_at:
                inside = not inside
        j = i
    return inside


def contains(f: Geofence | dict, lat: float | None, lon: float | None) -> bool:
    if lat is None or lon is None:
        return False
    kind = f.kind if isinstance(f, Geofence) else f.get("kind")
    if kind == "polygon":
        poly = f.polygon if isinstance(f, Geofence) else f.get("polygon")
        return point_in_polygon(lat, lon, poly or [])
    clat = f.lat if isinstance(f, Geofence) else f.get("lat")
    clon = f.lon if isinstance(f, Geofence) else f.get("lon")
    r = f.radius_m if isinstance(f, Geofence) else f.get("radius_m")
    if clat is None or clon is None:
        return False
    return haversine_m(lat, lon, clat, clon) <= float(r or 0)


def polygon_area_km2(poly: list[list[float]]) -> float:
    if len(poly) < 3:
        return 0.0
    lat0 = poly[0][0]
    pts = [(math.radians(p[1]) * 6371000 * math.cos(math.radians(lat0)), math.radians(p[0]) * 6371000) for p in poly]
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2 / 1e6


def area_km2(f: Geofence) -> float:
    if f.kind == "polygon":
        return round(polygon_area_km2(f.polygon or []), 3)
    return round(math.pi * (f.radius_m / 1000) ** 2, 3)


def cameras_in(f: Geofence, cams: list[Camera]) -> list[dict]:
    out = []
    for c in cams:
        if f.department and c.department != f.department:
            continue
        if contains(f, c.lat, c.lon):
            d = haversine_m(c.lat, c.lon, f.lat, f.lon) if f.kind == "circle" and f.lat is not None else None
            out.append({"id": c.id, "name": c.name, "department": c.department, "lat": c.lat, "lon": c.lon, "status": c.status,
                        "registry_only": c.registry_only, "anpr_enabled": c.anpr_enabled, "distance_m": int(round(d)) if d is not None else None})
    out.sort(key=lambda x: (x["distance_m"] if x["distance_m"] is not None else 0, x["name"]))
    return out


def fence_dict(f: Geofence, cameras: list[dict] | None = None) -> dict:
    d = {"id": f.id, "name": f.name, "description": f.description, "kind": f.kind, "lat": f.lat, "lon": f.lon, "radius_m": f.radius_m,
         "polygon": f.polygon or [], "department": f.department, "notify_kinds": f.notify_kinds or [], "severity": f.severity, "active": f.active,
         "area_km2": area_km2(f), "created_by": f.created_by, "updated_at": f.updated_at.isoformat() if f.updated_at else None}
    if cameras is not None:
        d["cameras"], d["camera_count"] = cameras, len(cameras)
    return d


def build(body: dict, existing: Geofence | None = None, actor: str = "") -> Geofence:
    f = existing or Geofence(created_by=actor)
    name = str(body.get("name") or f.name or "").strip()
    if not name:
        raise ValueError("geofence needs a name")
    f.name = name[:120]
    f.description = str(body.get("description") or "")[:300]
    kind = str(body.get("kind") or f.kind or "circle")
    if kind not in ("circle", "polygon"):
        raise ValueError("kind must be circle or polygon")
    f.kind = kind
    if kind == "circle":
        lat, lon = body.get("lat", f.lat), body.get("lon", f.lon)
        if lat is None or lon is None:
            raise ValueError("pick a centre on the map (lat / lon)")
        f.lat, f.lon = float(lat), float(lon)
        f.radius_m = max(20, min(int(body.get("radius_m") or f.radius_m or 500), 50000))
        f.polygon = []
    else:
        poly = body.get("polygon", f.polygon) or []
        pts = []
        for p in poly:
            try:
                pts.append([float(p[0]), float(p[1])])
            except Exception:  # noqa: BLE001
                raise ValueError("polygon points must be [lat, lon] pairs")
        if len(pts) < 3:
            raise ValueError("a polygon needs at least three points")
        f.polygon = pts[:500]
        f.lat = sum(p[0] for p in pts) / len(pts)
        f.lon = sum(p[1] for p in pts) / len(pts)
    f.department = str(body.get("department") or "")[:64]
    kinds = body.get("notify_kinds")
    if kinds is not None:
        f.notify_kinds = [k for k in kinds if k in ("alert", "incident", "camera")]
    sev = body.get("severity")
    if sev in ("info", "warn", "critical"):
        f.severity = sev
    if "active" in body:
        f.active = bool(body["active"])
    f.updated_by, f.updated_at = actor, utcnow()
    _invalidate()
    return f


def cameras_for(s, f: Geofence, user=None) -> list[dict]:
    cams = [c for c in s.scalars(select(Camera)) if c.lat is not None and (user is None or user.sees_camera(c.id, c.department))]
    return cameras_in(f, cams)


def _invalidate() -> None:
    with _lock:
        _cache["at"] = 0.0


def fences_for_camera(camera_id: str) -> list[dict]:
    """Active fences containing the camera (membership recomputed every 30 s)."""
    now = time.time()
    with _lock:
        fresh = now - _cache["at"] < 30
    if not fresh:
        by_cam: dict[str, list[dict]] = {}
        try:
            with SessionLocal() as s:
                fences = [f for f in s.scalars(select(Geofence)) if f.active]
                cams = [c for c in s.scalars(select(Camera)) if c.lat is not None]
                for f in fences:
                    fd = fence_dict(f)
                    for c in cameras_in(f, cams):
                        by_cam.setdefault(c["id"], []).append(fd)
        except Exception:  # noqa: BLE001
            log.debug("geofence refresh failed", exc_info=True)
        with _lock:
            _cache.update(at=now, by_cam=by_cam)
    with _lock:
        return list(_cache["by_cam"].get(camera_id, []))
