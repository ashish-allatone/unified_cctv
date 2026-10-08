"""VIP routes and road corridors: which cameras cover a journey or a stretch of road.

A route is either
  * a corridor between places - waypoints (geocoded names or coordinates) joined by the road geometry from a
    routing service (OSRM, ROUTING_URL) or, without one, straight lines; every camera within `buffer_m` of the
    path is on the route, ordered by chainage (km from the start); and / or
  * a keyword filter - `road` (e.g. "NH24") matched against the camera's address / tags / pole id / name and
    `area` (e.g. "Delhi") matched against zone / ward / address / department / name.
Both can be combined ("NH24 cameras between Amroha and Delhi"). Explicit `camera_ids` are always included,
`exclude_ids` never. The result feeds the Map (polyline + highlighted cameras), the video wall ("open on wall",
in route order) and the search filters.
"""
from __future__ import annotations

import logging
import math
import re

import requests
from sqlalchemy import select

from .config import settings
from .db import Camera, Route, SessionLocal, utcnow

log = logging.getLogger("uvp.corridors")
EARTH = 6371000.0


# ----------------------------------------------------------------------------- geometry
def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH * math.asin(math.sqrt(a))


def _xy(lat: float, lon: float, lat0: float) -> tuple[float, float]:
    """Local equirectangular metres - good enough for a few hundred km."""
    return (math.radians(lon) * EARTH * math.cos(math.radians(lat0)), math.radians(lat) * EARTH)


def distance_to_path(lat: float, lon: float, path: list[list[float]]) -> tuple[float, float]:
    """(distance to the polyline in metres, chainage along it in metres at the nearest point)."""
    if not path:
        return float("inf"), 0.0
    if len(path) == 1:
        return haversine_m(lat, lon, path[0][0], path[0][1]), 0.0
    lat0 = path[0][0]
    px, py = _xy(lat, lon, lat0)
    best, best_ch, ch = float("inf"), 0.0, 0.0
    ax, ay = _xy(path[0][0], path[0][1], lat0)
    for i in range(1, len(path)):
        bx, by = _xy(path[i][0], path[i][1], lat0)
        dx, dy = bx - ax, by - ay
        seg = math.hypot(dx, dy)
        t = 0.0 if seg == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (seg * seg)))
        qx, qy = ax + t * dx, ay + t * dy
        d = math.hypot(px - qx, py - qy)
        if d < best:
            best, best_ch = d, ch + t * seg
        ch += seg
        ax, ay = bx, by
    return best, best_ch


def path_length_m(path: list[list[float]]) -> float:
    return sum(haversine_m(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]) for i in range(1, len(path)))


# ----------------------------------------------------------------------------- routing (road geometry)
def road_path(points: list[tuple[float, float]]) -> tuple[list[list[float]], str]:
    """Road geometry through the points from an OSRM-compatible router (ROUTING_URL). Falls back to straight lines.
    Returns (path [[lat, lon], ...], source 'routing' | 'straight')."""
    pts = [(float(a), float(b)) for a, b in points]
    if len(pts) < 2:
        return [[a, b] for a, b in pts], "straight"
    url = (settings.routing_url or "").rstrip("/")
    if url:
        coords = ";".join(f"{lon},{lat}" for lat, lon in pts)
        try:
            r = requests.get(f"{url}/route/v1/driving/{coords}", params={"overview": "full", "geometries": "geojson", "steps": "false"},
                             headers={"User-Agent": "UnifiedCCTV-Routes/1.7"}, timeout=20)
            r.raise_for_status()
            j = r.json()
            geom = j["routes"][0]["geometry"]["coordinates"]
            path = [[float(lat), float(lon)] for lon, lat in geom]
            if len(path) >= 2:
                return _thin(path), "routing"
        except Exception as e:  # noqa: BLE001
            log.warning("routing failed (%s); using straight lines", str(e)[:120])
    return [[a, b] for a, b in pts], "straight"


def _thin(path: list[list[float]], max_points: int = 2000) -> list[list[float]]:
    if len(path) <= max_points:
        return path
    step = len(path) / max_points
    out = [path[int(i * step)] for i in range(max_points)]
    out.append(path[-1])
    return out


# ----------------------------------------------------------------------------- matching
def _kw(s: str) -> list[str]:
    return [k.strip().lower() for k in re.split(r"[,;|]", s or "") if k.strip()]


def _norm(v: str) -> str:
    return re.sub(r"[\s\-_./]", "", (v or "").lower())


def _text_road(c: Camera) -> str:
    return " ".join([c.address or "", c.name or "", c.pole_id or "", c.notes or "", " ".join(c.tags or []) if isinstance(c.tags, list) else str(c.tags or "")])


def _text_area(c: Camera) -> str:
    return " ".join([c.zone or "", c.ward or "", c.address or "", c.department or "", c.name or "", " ".join(c.tags or []) if isinstance(c.tags, list) else ""])


def _matches_kw(text: str, keywords: list[str]) -> bool:
    if not keywords:
        return True
    t, tn = text.lower(), _norm(text)
    return any(k in t or _norm(k) in tn for k in keywords)


def match_cameras(cams: list[Camera], *, path: list[list[float]] | None, buffer_m: int, road: str = "", area: str = "", department: str = "",
                  camera_ids: list[str] | None = None, exclude_ids: list[str] | None = None) -> list[dict]:
    """Cameras on the route, ordered by chainage then name. Each: {id, name, department, lat, lon, status, registry_only,
    distance_m, km, reason}."""
    road_k, area_k = _kw(road), _kw(area)
    forced, excluded = set(camera_ids or []), set(exclude_ids or [])
    out = []
    for c in cams:
        if c.id in excluded:
            continue
        reason = []
        if c.id in forced:
            reason.append("added")
        else:
            if department and c.department != department:
                continue
            if not _matches_kw(_text_road(c), road_k):
                continue
            if not _matches_kw(_text_area(c), area_k):
                continue
            if road_k:
                reason.append("road")
            if area_k:
                reason.append("area")
        dist, ch = (float("inf"), 0.0)
        if path and c.lat is not None and c.lon is not None:
            dist, ch = distance_to_path(c.lat, c.lon, path)
        if path and c.id not in forced:
            if c.lat is None or dist > buffer_m:
                continue
            reason.append("corridor")
        if not path and not road_k and not area_k and c.id not in forced:
            continue                                       # an empty route matches nothing, not everything
        out.append({"id": c.id, "name": c.name, "department": c.department, "lat": c.lat, "lon": c.lon, "status": c.status,
                    "registry_only": c.registry_only, "anpr_enabled": c.anpr_enabled, "address": c.address or "", "zone": c.zone or "",
                    "distance_m": None if dist == float("inf") else int(round(dist)), "km": round(ch / 1000, 1) if path else None,
                    "reason": "+".join(reason) or "match"})
    out.sort(key=lambda x: (x["km"] if x["km"] is not None else 1e9, x["name"]))
    return out


# ----------------------------------------------------------------------------- place catalogue (route editor drop-downs)
def camera_centre(cams: list[Camera]) -> tuple[float, float] | None:
    """Centroid of the cameras that have coordinates - used to bias the geocoder towards the deployment area."""
    pts = [(c.lat, c.lon) for c in cams if c.lat is not None and c.lon is not None]
    if not pts:
        return None
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def _area_parts(c: Camera) -> list[str]:
    parts = [c.zone or "", getattr(c, "ward", "") or ""]
    addr = c.address or ""
    if addr:
        # 'Ellis Bridge, Ahmedabad, Gujarat 380006' -> 'Ellis Bridge', 'Ahmedabad'
        for bit in addr.split(",")[:3]:
            bit = " ".join(w for w in bit.split() if not w.isdigit()).strip()
            if 2 < len(bit) <= 40:
                parts.append(bit)
    uniq: dict[str, str] = {}
    for p in parts:
        if p and p.strip() and p.strip().lower() not in uniq:
            uniq[p.strip().lower()] = p.strip()
    return list(uniq.values())


def places(cams: list[Camera], q: str = "", routes: list | None = None, fences: list | None = None, limit: int = 60) -> list[dict]:
    """Choices for the Source / Destination drop-downs: camera sites, the areas / localities the cameras are in
    (centroid of their cameras), the places of saved routes and geofence centres. Each: {kind, name, label, lat, lon, count}.
    `q` filters by substring; without it the whole catalogue (capped) comes back, areas first."""
    ql = _norm(q)
    out: list[dict] = []
    areas: dict[str, list[tuple[float, float]]] = {}
    for c in cams:
        if c.lat is None or c.lon is None:
            continue
        for a in _area_parts(c):
            areas.setdefault(a, []).append((c.lat, c.lon))
    for a, pts in sorted(areas.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        out.append({"kind": "area", "name": a, "label": f"{len(pts)} camera{'s' if len(pts) != 1 else ''}",
                    "lat": round(sum(p[0] for p in pts) / len(pts), 6), "lon": round(sum(p[1] for p in pts) / len(pts), 6), "count": len(pts)})
    key = lambda lat, lon: (round(float(lat), 4), round(float(lon), 4))  # noqa: E731
    seen = {key(p["lat"], p["lon"]) for p in out}
    for w in [w for r in (routes or []) for w in (r.waypoints or [])]:
        if not w.get("name") or w.get("lat") is None:
            continue
        k = key(w["lat"], w["lon"])
        if k in seen:
            continue                                        # the same spot as an area / earlier place: list it once
        seen.add(k)
        lbl = str(w.get("label") or "")
        out.append({"kind": "place", "name": str(w["name"]), "label": (lbl if lbl and "camera" not in lbl else "used in a route")[:80],
                    "lat": float(w["lat"]), "lon": float(w["lon"]), "count": 0})
    for g in fences or []:
        if getattr(g, "lat", None) is not None and key(g.lat, g.lon) not in seen:
            seen.add(key(g.lat, g.lon))
            out.append({"kind": "geofence", "name": g.name, "label": "geofence centre", "lat": float(g.lat), "lon": float(g.lon), "count": 0})
    for c in sorted(cams, key=lambda c: c.name or ""):
        if c.lat is None or c.lon is None:
            continue
        out.append({"kind": "camera", "name": c.name, "label": (c.address or c.zone or c.department or "")[:80], "lat": c.lat, "lon": c.lon, "count": 1,
                    "camera_id": c.id, "department": c.department})
    if ql:
        out = [p for p in out if ql in _norm(p["name"]) or ql in _norm(p.get("label", ""))]
    return out[:limit]


def nearest_camera(cams: list[Camera], path: list[list[float]]) -> dict | None:
    """The camera closest to a path that matched nothing - so the editor can say 'nearest camera is 3.4 km away'."""
    best = None
    for c in cams:
        if c.lat is None or c.lon is None or not path:
            continue
        d, _ = distance_to_path(c.lat, c.lon, path)
        if best is None or d < best[0]:
            best = (d, c)
    if not best:
        return None
    d, c = best
    return {"id": c.id, "name": c.name, "distance_m": int(round(d)), "suggest_buffer_m": int(min(20000, (int(d) // 100 + 2) * 100))}


# ----------------------------------------------------------------------------- CRUD helpers
def route_dict(r: Route, cameras: list[dict] | None = None) -> dict:
    d = {"id": r.id, "name": r.name, "description": r.description, "waypoints": r.waypoints or [], "path": r.path or [],
         "buffer_m": r.buffer_m, "road": r.road, "area": r.area, "department": r.department, "priority": r.priority,
         "camera_ids": r.camera_ids or [], "exclude_ids": r.exclude_ids or [], "length_km": round(path_length_m(r.path or []) / 1000, 1) if r.path else None,
         "active_from": r.active_from.isoformat() if r.active_from else None, "active_to": r.active_to.isoformat() if r.active_to else None,
         "created_by": r.created_by, "updated_by": r.updated_by, "updated_at": r.updated_at.isoformat() if r.updated_at else None,
         "active": _is_active(r)}
    if cameras is not None:
        d["cameras"] = cameras
        d["camera_count"] = len(cameras)
    return d


def _is_active(r: Route) -> bool:
    now = utcnow()
    return (r.active_from is None or r.active_from <= now) and (r.active_to is None or r.active_to >= now)


def resolve_waypoints(waypoints: list, geocode) -> list[dict]:
    """Fill lat/lon for waypoints given by name using the geocoder (callable name -> candidates)."""
    out = []
    for w in waypoints:
        if isinstance(w, str):
            w = {"name": w}
        w = dict(w)
        try:
            if w.get("lat") is not None and w.get("lon") is not None:
                w["lat"], w["lon"] = float(w["lat"]), float(w["lon"])
            elif w.get("name"):
                cands = [c for c in geocode(w["name"]) if "lat" in c]
                if not cands:
                    raise ValueError(f"could not locate {w['name']!r}")
                w["lat"], w["lon"], w["label"] = cands[0]["lat"], cands[0]["lon"], cands[0].get("label", "")
            else:
                raise ValueError("waypoint needs a name or lat/lon")
        except ValueError:
            raise
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"waypoint {w.get('name', '')!r}: {e}")
        out.append({"name": str(w.get("name") or f"{w['lat']:.4f},{w['lon']:.4f}")[:80], "lat": w["lat"], "lon": w["lon"], "label": str(w.get("label") or "")[:200]})
    return out


def build_route(body: dict, geocode, existing: Route | None = None, actor: str = "") -> Route:
    """Validate a route body and return a (new or updated) Route row, not yet committed."""
    r = existing or Route(created_by=actor)
    name = str(body.get("name") or r.name or "").strip()
    if not name:
        raise ValueError("route needs a name")
    r.name = name[:120]
    r.description = str(body.get("description") or "")[:300]
    r.road = str(body.get("road") or "")[:120]
    r.area = str(body.get("area") or "")[:120]
    r.department = str(body.get("department") or "")[:64]
    r.priority = "vip" if str(body.get("priority") or "normal") == "vip" else "normal"
    r.buffer_m = max(50, min(int(body.get("buffer_m") or 500), 20000))
    r.camera_ids = [str(x) for x in (body.get("camera_ids") or [])][:500]
    r.exclude_ids = [str(x) for x in (body.get("exclude_ids") or [])][:500]
    for k in ("active_from", "active_to"):
        v = body.get(k)
        if v in (None, ""):
            setattr(r, k, None)
        else:
            import datetime as dt
            t = dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
            setattr(r, k, t if t.tzinfo else t.replace(tzinfo=dt.timezone(dt.timedelta(minutes=330))))
    if "waypoints" in body:
        wps = resolve_waypoints(body.get("waypoints") or [], geocode)
        r.waypoints = wps
        if len(wps) == 1:                       # one place = every camera within buffer_m of that point (a venue, bridge, junction)
            r.path = [[wps[0]["lat"], wps[0]["lon"]]]
            r.description = r.description or f"around {wps[0]['name']} (within {r.buffer_m} m)"
        elif wps:
            path, src = road_path([(w["lat"], w["lon"]) for w in wps]) if body.get("follow_roads", True) else ([[w["lat"], w["lon"]] for w in wps], "straight")
            r.path = path
            r.description = r.description or (f"{wps[0]['name']} -> {wps[-1]['name']} ({src})")
        else:
            r.path = []
    if not (r.path or r.road or r.area or r.camera_ids):
        raise ValueError("give at least two places, or a road / area keyword, or pick cameras")
    r.updated_by, r.updated_at = actor, utcnow()
    return r


def visible_cameras(s, user=None) -> list[Camera]:
    return [c for c in s.scalars(select(Camera)) if user is None or user.sees_camera(c.id, c.department)]


def cameras_for(s, r: Route, user=None) -> list[dict]:
    cams = visible_cameras(s, user)
    return match_cameras(cams, path=r.path or None, buffer_m=r.buffer_m, road=r.road, area=r.area, department=r.department,
                         camera_ids=r.camera_ids, exclude_ids=r.exclude_ids)


def full_dict(s, r: Route, user=None) -> dict:
    """route_dict with the cameras and, when nothing matched, the nearest-camera hint."""
    cams = cameras_for(s, r, user)
    d = route_dict(r, cams)
    d["nearest"] = nearest_for(s, r, cams, user)
    return d


def nearest_for(s, r: Route, cams: list[dict], user=None) -> dict | None:
    """Only when the route matched nothing and has a path: the closest camera and a buffer that would include it."""
    if cams or not r.path:
        return None
    return nearest_camera(visible_cameras(s, user), r.path)


def preview(s, body: dict, geocode, user=None) -> dict:
    """Cameras for a route body that is not saved yet (the editor's live preview)."""
    tmp = build_route(body, geocode, actor="preview")
    cams = cameras_for(s, tmp, user)
    return {"waypoints": tmp.waypoints, "path": tmp.path, "length_km": round(path_length_m(tmp.path) / 1000, 1) if tmp.path else None,
            "cameras": cams, "camera_count": len(cams), "nearest": nearest_for(s, tmp, cams, user)}
