"""Platform API + web UI host.

  /api/auth/login               token for the web UI
  /api/cameras                  unified camera registry (filtered by the user's departments)
  /api/sources                  departmental source health
  /api/events                   ANPR event search (plate / wildcard / fuzzy / camera / time / tag)
  /api/vehicles/{plate}/movements   time-ordered sightings across all departments
  /api/stats                    dashboard figures
  /api/tags                     manual event tags from operators
  /api/watchlist                vehicles of interest
  /api/alerts (+ /ws/alerts)    watchlist hits, pushed live
  /api/layouts                  saved video-wall layouts
  /api/audit                    who did what (admin)
  /api/events/{id}/clip         playable link to the archived event clip (object storage)
  /api/cameras/{id}/recordings  archived segments of a recorded camera for one day
  /api/archive/stats            what the archive holds, per department
  /archive/{key}                serves archive objects when OBJECT_STORAGE=local
  /internal/events              ANPR -> indexer (no-Kafka mode)
  /internal/relay-auth          relay asks: may this viewer read this stream?
"""
from __future__ import annotations

import asyncio
import datetime as dt
import csv
import io
import json
import os
import logging
import secrets
import shutil
import tempfile
import threading
import time
import zipfile
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import func, select, true

from .. import auth as A
from ..config import settings
from ..db import (AccessGrant, AnprEvent, Alert, AuditLog, Camera, EventTag, LegalHold, Recording, SessionLocal,
                  Source, Users, WatchlistEntry, audit, init_db, new_id, utcnow, verify_audit_chain)
from .. import camperms, inbox, pii, rbac, signing
from ..notify import notify
from .. import metrics as M
from ..plates import correct, normalise
from ..relay import relay
from ..search import Query as SQ
from ..search import backend
from ..storage import describe as storage_describe
from ..storage import store
from .indexer import Indexer

log = logging.getLogger("uvp.api")
app = FastAPI(title="Unified CCTV Viewing Platform", version="0.1.0")
init_db()
indexer = Indexer()


@app.middleware("http")
async def _metrics_mw(request: Request, call_next):
    t0 = time.perf_counter()
    resp = await call_next(request)
    route = M.route_label(request.url.path)
    if route.startswith(("/api", "/internal", "/media", "/archive")):
        M.HTTP_LATENCY.labels(route, request.method).observe(time.perf_counter() - t0)
        M.HTTP_REQUESTS.labels(route, request.method, str(resp.status_code)).inc()
    return resp


@app.get("/metrics")
def metrics():
    from fastapi import Response
    body, ctype = M.latest()
    return Response(body, media_type=ctype)


@app.get("/healthz", include_in_schema=False)
def healthz():
    """Liveness: the process answers HTTP. No dependencies are checked."""
    return {"ok": True, "version": _version()}


@app.get("/readyz", include_in_schema=False)
def readyz():
    """Readiness: the database answers (hard requirement) and the search index / relay are reported (soft)."""
    from fastapi import Response
    from sqlalchemy import text
    out = {"ok": True, "version": _version(), "database": "ok", "search": "ok", "relay": "ok"}
    try:
        with SessionLocal() as s:
            s.execute(text("SELECT 1"))
    except Exception as e:  # noqa: BLE001
        out["ok"], out["database"] = False, f"error: {str(e)[:120]}"
    try:
        backend().ping()
    except Exception as e:  # noqa: BLE001
        out["search"] = f"degraded: {str(e)[:120]}"
    try:
        out["relay"] = "ok" if any(r.healthy for r in relay.relays.values()) else "no healthy relay"
    except Exception as e:  # noqa: BLE001
        out["relay"] = f"unknown: {str(e)[:120]}"
    return out if out["ok"] else Response(json.dumps(out), status_code=503, media_type="application/json")


def _version() -> str:
    return str(getattr(settings, "version", "") or "unknown")


# ----------------------------------------------------------------------------- auth helpers (shared with routers)
from .deps import _ip, current_user, dept_filter, internal, need  # noqa: E402

# ----------------------------------------------------------------------------- live alert fan-out
class Hub:
    def __init__(self):
        self.clients: dict[WebSocket, A.User] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    async def send(self, msg: dict) -> None:
        dead = []
        for ws, u in list(self.clients.items()):
            if msg.get("type") == "inbox":
                if not inbox.allowed_for(u, msg):
                    continue
            else:
                dept = msg.get("department", "")
                if dept not in ("", "*") and not u.sees(dept) and msg.get("camera_id", "") not in (u.cameras or []):
                    continue
            try:
                if msg.get("type") == "dets" and not u.has("plate_search"):
                    msg = {**msg, "boxes": [[("plate" if str(b[0]).startswith("plate:") else b[0]), *b[1:]] for b in msg.get("boxes", [])]}
                await ws.send_json(pii.mask_event(msg, u) if msg.get("type") in ("event", "alert") else msg)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.clients.pop(ws, None)

    def send_threadsafe(self, msg: dict) -> None:
        if self.loop:
            asyncio.run_coroutine_threadsafe(self.send(msg), self.loop)


hub = Hub()


_dept_cache: dict[str, str] = {}


def _store_traffic(row: dict) -> None:
    """Periodic traffic-count row from the analytics worker (vehicles in view by class, peak, line flow)."""
    from ..db import TrafficCount
    with SessionLocal() as s:
        cam = s.get(Camera, row["camera_id"])
        s.add(TrafficCount(camera_id=row["camera_id"], department=cam.department if cam else "", ts=dt.datetime.fromisoformat(row["ts"]),
                           window_s=int(row.get("window_s", 60)), frames=int(row.get("frames", 0)), avg_vehicles=float(row.get("avg_vehicles", 0)),
                           peak_vehicles=int(row.get("peak_vehicles", 0)), avg=row.get("avg") or {}, flow=row.get("flow")))
        s.commit()


def broadcast_dets(m: dict) -> None:
    """Live boxes for the wall overlay: console fan-out only (no notifications, nothing stored)."""
    cid = m.get("camera_id", "")
    if cid not in _dept_cache:
        with SessionLocal() as s:
            c = s.get(Camera, cid)
            _dept_cache[cid] = c.department if c else ""
    try:
        from .routes_persons import note_dets
        note_dets(m)                                      # live counts for /api/counts and the Overview
    except Exception:  # noqa: BLE001
        pass
    hub.send_threadsafe({"type": "dets", "department": _dept_cache[cid], **m})


def broadcast(kind: str, payload: dict) -> None:
    """Push to operator consoles (WebSocket) and to outbound integrations (notify routes + webhooks)."""
    wtype = {"anpr.event": "event", "camera.health": "camera_health"}.get(kind, kind)
    hub.send_threadsafe({"type": wtype, **payload})
    try:
        notify(kind, payload)
    except Exception:  # noqa: BLE001
        log.exception("notify failed")
    if kind != "anpr.event":
        inbox.from_event(kind, payload)


@app.on_event("startup")
async def _startup() -> None:
    hub.loop = asyncio.get_running_loop()
    inbox.set_sink(hub.send_threadsafe)
    threading.Thread(target=_refresh_live_paths, daemon=True).start()
    if settings.bus == "kafka":
        from ..bus import TOPIC_ALERTS, TOPIC_ANPR, TOPIC_DETS, TOPIC_INCIDENTS, consume

        def on_msg(topic: str, m: dict) -> None:
            if topic == TOPIC_ALERTS:
                broadcast("alert", m)
            elif topic == TOPIC_DETS:
                broadcast_dets(m)
            elif topic == TOPIC_INCIDENTS:
                from .routes_analytics import _inc_dict, ingest_incident
                if m.get("type") == "traffic":
                    _store_traffic(m)
                    broadcast("traffic", m)
                    return
                inc, alerts = ingest_incident(m)
                broadcast("incident", _inc_dict(inc))
                for a in alerts:
                    broadcast("alert", a)
            else:  # live ticker
                broadcast("anpr.event", {"id": m["id"], "plate": m["plate"], "camera_id": m["camera_id"],
                                         "department": m["department"], "ts": m["ts"],
                                         "crop_url": f"/media/{m.get('crop_path', '')}", "tags": m.get("tags", []),
                                         "attrs": m.get("attrs", {})})
        threading.Thread(target=consume, args=([TOPIC_ALERTS, TOPIC_ANPR, TOPIC_INCIDENTS, TOPIC_DETS], "uvp-api-live", on_msg),
                         daemon=True).start()


@app.websocket("/ws/alerts")
async def ws_alerts(ws: WebSocket, token: str = ""):
    u = A.verify_token(token)
    if not u:
        await ws.close(code=4401)
        return
    await ws.accept()
    hub.clients[ws] = u
    M.WS_CLIENTS.set(len(hub.clients))
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        hub.clients.pop(ws, None)
        M.WS_CLIENTS.set(len(hub.clients))


# ----------------------------------------------------------------------------- auth + config
class Login(BaseModel):
    username: str
    password: str


class MfaIn(BaseModel):
    mfa_token: str = ""
    code: str


class BreakGlassIn(BaseModel):
    reason: str


def _session_response(s, u: A.User, request: Request) -> dict:
    u = A.with_effective_access(s, u)
    audit(s, u.username, "login", u.provider, f"mfa={u.mfa}", _ip(request))
    return {"token": A.issue_token(u), "user": _me(u)}


def _me(u: A.User) -> dict:
    from ..tenancy import branding
    return {"username": u.username, "role": u.role, "departments": u.departments, "features": u.features,
            "cameras": u.cameras, "mfa": u.mfa, "break_glass": u.break_glass, "provider": u.provider,
            "is_super": bool(u.is_super), "tenant": u.tenant, "branding": branding(u.tenant) if u.tenant else {}}


@app.get("/api/auth/me")
def auth_me(u: A.User = Depends(current_user)):
    """The signed-in user's current effective access (follows role edits without a new sign-in)."""
    return _me(u) | {"roles_version": rbac.roles_version()}


@app.get("/api/auth/providers")
def auth_providers():
    prov = A.auth_cfg().get("providers") or {}
    oidc = prov.get("oidc") or {}
    with SessionLocal() as s:
        needs_setup = not A.db_users_exist(s)
        yaml_users = A.yaml_users_active(s)
    return {"local": (prov.get("local") or {"enabled": True}).get("enabled", True),
            "ldap": bool((prov.get("ldap") or {}).get("enabled")),
            "oidc": {"enabled": bool(oidc.get("enabled")), "name": oidc.get("name", "SSO")},
            "break_glass": bool((A.auth_cfg().get("break_glass") or {}).get("enabled")),
            "needs_setup": needs_setup, "yaml_users": yaml_users}


@app.post("/api/auth/login")
def login(body: Login, request: Request):
    name = body.username.strip()[:64]
    with SessionLocal() as s:
        if A.is_locked(s, name):
            audit(s, name, "login_locked", ip=_ip(request))
            s.commit()
            raise HTTPException(423, "account temporarily locked after repeated failures")
        u = A.authenticate(name, body.password)
        A.note_login(s, name, bool(u), u.provider if u else None)
        if not u:
            audit(s, name, "login_failed", ip=_ip(request))
            if A.is_locked(s, name):
                inbox.push("security", f"Account {name} locked after repeated failed sign-ins", f"from {_ip(request)}", severity="warn",
                           ref_id=name, link="admin", feature="admin", session=s)
            s.commit()
            raise HTTPException(401, "invalid username or password")
        enrolled = A.mfa_enrolled(s, u.username)
        must = A.mfa_required_for(u.role)
        if enrolled or must:
            grace = int((A.auth_cfg().get("mfa") or {}).get("grace_logins", 3))
            sec = A._sec(s, u.username)
            if not enrolled and must and sec.grace_logins_used < grace:
                sec.grace_logins_used += 1
                out = _session_response(s, u, request)
                out["mfa_enrol_required"] = True
                out["grace_left"] = grace - sec.grace_logins_used
                s.commit()
                return out
            step = A.issue_token(u, ttl_s=300, purpose="mfa")
            audit(s, u.username, "login_mfa_pending", u.provider, ip=_ip(request))
            s.commit()
            return {"mfa_required": True, "mfa_token": step, "enrol": not enrolled}
        out = _session_response(s, u, request)
        s.commit()
        return out


@app.post("/api/auth/mfa/verify")
def mfa_verify(body: MfaIn, request: Request):
    u = A.verify_token(body.mfa_token, purpose="mfa")
    if not u:
        raise HTTPException(401, "mfa step expired; log in again")
    with SessionLocal() as s:
        if not A.mfa_verify(s, u.username, body.code):
            A.note_login(s, u.username, False)
            audit(s, u.username, "mfa_failed", ip=_ip(request))
            s.commit()
            raise HTTPException(401, "wrong code")
        u.mfa = True
        out = _session_response(s, u, request)
        s.commit()
        return out


def _user_from_session_or_mfa(authorization: str = Header(default=""), token: str = Query(default="")) -> A.User:
    tok = authorization[7:] if authorization.startswith("Bearer ") else token
    return A.verify_token(tok) or A.verify_token(tok, purpose="mfa") or (_ for _ in ()).throw(HTTPException(401))


@app.post("/api/auth/mfa/enrol")
def mfa_enrol(u: A.User = Depends(_user_from_session_or_mfa)):
    with SessionLocal() as s:
        out = A.mfa_begin_enrol(s, u.username)
        s.commit()
    return out


@app.post("/api/auth/mfa/confirm")
def mfa_confirm(body: MfaIn, request: Request, u: A.User = Depends(_user_from_session_or_mfa)):
    with SessionLocal() as s:
        codes = A.mfa_confirm_enrol(s, u.username, body.code)
        if codes is None:
            raise HTTPException(400, "code did not match; scan the QR again")
        u.mfa = True
        audit(s, u.username, "mfa_enrolled", ip=_ip(request))
        out = _session_response(s, u, request)
        out["backup_codes"] = codes
        s.commit()
    return out


@app.post("/api/auth/mfa/reset/{username}")
def mfa_reset(username: str, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        A.mfa_reset(s, username)
        audit(s, u.username, "mfa_reset", username, ip=_ip(request))
        s.commit()
    return {"ok": True}


_oidc_state: dict[str, tuple[str, float]] = {}


@app.get("/api/auth/oidc/start")
def oidc_start():
    if not A.oidc_cfg():
        raise HTTPException(404, "OIDC not enabled")
    state, nonce = secrets.token_urlsafe(16), secrets.token_urlsafe(16)
    _oidc_state[state] = (nonce, time.time())
    return RedirectResponse(A.oidc_login_url(state, nonce))


@app.get("/api/auth/oidc/callback")
def oidc_callback(request: Request, code: str = "", state: str = "", error: str = ""):
    if error or state not in _oidc_state:
        return RedirectResponse("/#sso_error=" + (error or "state"))
    nonce, _ = _oidc_state.pop(state)
    try:
        u = A.oidc_exchange(code, nonce)
    except Exception as e:  # noqa: BLE001
        log.exception("oidc exchange failed")
        return RedirectResponse("/#sso_error=" + type(e).__name__)
    if not u:
        return RedirectResponse("/#sso_error=not_authorised")
    with SessionLocal() as s:
        if A.mfa_required_for(u.role) and not u.mfa and A.mfa_enrolled(s, u.username):
            step = A.issue_token(u, ttl_s=300, purpose="mfa")
            s.commit()
            return RedirectResponse("/#mfa=" + step)
        out = _session_response(s, u, request)
        s.commit()
    return RedirectResponse("/#sso=" + out["token"])


@app.post("/api/auth/refresh")
def refresh(request: Request, u: A.User = Depends(current_user)):
    """Re-read grants (a new grant or a break-glass expiry takes effect here or at next login)."""
    with SessionLocal() as s:
        u = A.with_effective_access(s, u)
        return {"token": A.issue_token(u), "user": _me(u)}


@app.post("/api/auth/break-glass")
def break_glass(body: BreakGlassIn, request: Request, u: A.User = Depends(current_user)):
    cfg = A.auth_cfg().get("break_glass") or {}
    if not cfg.get("enabled") or u.role not in (cfg.get("roles") or []):
        raise HTTPException(403, "break-glass not permitted for this role")
    if len(body.reason.strip()) < 10:
        raise HTTPException(400, "a justification of at least 10 characters is required")
    ttl = int(cfg.get("ttl_minutes", 60))
    with SessionLocal() as s:
        for g in rbac.active_grants(s, u.username):
            if g.kind == "break_glass":
                raise HTTPException(409, "break-glass already active")
        g = AccessGrant(username=u.username, kind="break_glass", value="*", reason=body.reason.strip()[:1000],
                        granted_by=u.username, expires_at=utcnow() + dt.timedelta(minutes=ttl))
        s.add(g)
        s.flush()
        grants = cfg.get("grants") or {}
        u2 = A.with_effective_access(s, u)
        u2.departments = sorted(set(u2.departments) | set(grants.get("departments", [])))
        u2.features = sorted(set(u2.features) | set(grants.get("features", [])))
        u2.break_glass = g.id
        audit(s, u.username, "break_glass", g.id, body.reason.strip()[:1000], _ip(request))
        s.commit()
        broadcast("break_glass", {"user": u.username, "reason": body.reason.strip()[:300], "until": g.expires_at.isoformat(),
                                  "department": "*", "ts": utcnow().isoformat(), "notify_roles": cfg.get("notify_roles", ["admin"])})
        return {"token": A.issue_token(u2, ttl_s=ttl * 60), "user": _me(u2), "until": g.expires_at.isoformat()}


@app.post("/api/auth/break-glass/end")
def break_glass_end(request: Request, u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        for g in rbac.active_grants(s, u.username):
            if g.kind == "break_glass":
                g.revoked_at, g.revoked_by = utcnow(), u.username
                audit(s, u.username, "break_glass_end", g.id, ip=_ip(request))
        u.break_glass = None
        u = A.with_effective_access(s, u)
        s.commit()
        return {"token": A.issue_token(u), "user": _me(u)}


@app.get("/api/me")
def me(u: A.User = Depends(current_user)):
    return _me(u)


@app.get("/api/config")
def config():
    return {"relay": {"host": settings.relay_public_host, "webrtc_port": settings.relay_webrtc_port,
                      "hls_port": settings.relay_hls_port, "base": settings.relay_public_base},
            "search_backend": backend().name, "bus": settings.bus, "mask_plates": settings.pii_mask_plates,
            "relays": {n: {"public_host": r.public_host, "healthy": r.healthy} for n, r in relay.relays.items()}}


# ----------------------------------------------------------------------------- registry
def _cam(c: Camera) -> dict:
    return {"id": c.id, "source_id": c.source_id, "department": c.department, "name": c.name, "lat": c.lat,
            "lon": c.lon, "heading": c.heading, "fov": c.fov, "range_m": c.range_m, "profiles": c.profiles,
            "anpr_enabled": c.anpr_enabled, "status": c.status, "registry_only": c.registry_only,
            "camera_type": c.camera_type or "", "maintenance_status": c.maintenance_status or ""}


@app.get("/api/cameras")
def cameras(u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        rows = s.scalars(select(Camera).order_by(Camera.department, Camera.id)).all()
    live = {p["name"]: p for p in _safe_live_paths()}
    out = []
    for c in rows:
        if not u.sees_camera(c.id, c.department):
            continue
        d = _cam(c)
        d["perms"] = [p for p in camperms.PERMS if u.allows(c.id, c.department, p)]
        d["pulling"] = {p: bool(live.get(f"{c.id}/{p}", {}).get("ready")) for p in ("main", "sub")}
        d["relay"] = c.relay or ""
        r = relay.get(c.relay)
        d["relay_host"] = r.public_host if len(relay.relays) > 1 else ""
        d["relay_webrtc_port"], d["relay_hls_port"] = r.public_webrtc_port, r.public_hls_port
        d["viewers"] = sum(len(live.get(f"{c.id}/{p}", {}).get("readers", [])) for p in ("main", "sub"))
        out.append(d)
    return out


_LIVE: dict = {"items": [], "at": 0.0}


def _refresh_live_paths() -> None:
    """Background snapshot of the relay's runtime state (every 2 s).

    Request handlers — above all /internal/relay-auth, which the relay calls synchronously —
    read this snapshot and never call the relay inline. That avoids a relay -> API -> relay
    round trip on every stream start.
    """
    tick = 0
    while True:
        try:
            _LIVE["items"] = relay.live_paths(0)
            _LIVE["at"] = time.time()
            tick += 1
            if tick % 10 == 0:
                _refresh_gauges(_LIVE["items"])
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)


def _refresh_gauges(live: list[dict]) -> None:
    """Fleet gauges for Prometheus (every ~20 s)."""
    with SessionLocal() as s:
        cams = s.scalars(select(Camera)).all()
        srcs = s.scalars(select(Source)).all()
    counts: dict[tuple[str, str], int] = {}
    for c in cams:
        counts[(c.department, c.status)] = counts.get((c.department, c.status), 0) + 1
    for (d, st), n in counts.items():
        M.CAMERAS.labels(d, st).set(n)
    by_src = {}
    for c in cams:
        by_src.setdefault(c.source_id, set()).add(c.id)
    viewers: dict[str, int] = {}
    dept_of = {c.id: c.department for c in cams}
    for p in live:
        cid = p["name"].split("/")[0]
        viewers[dept_of.get(cid, "?")] = viewers.get(dept_of.get(cid, "?"), 0) + len(p.get("readers", []))
    for d, n in viewers.items():
        M.VIEWERS.labels(d).set(n)
    for x in srcs:
        ids = by_src.get(x.id, set())
        M.RELAY_PULLS.labels(x.id).set(sum(1 for p in live if p["name"].split("/")[0] in ids and _is_departmental_pull(p)))
        M.RELAY_CAP.labels(x.id).set(x.max_concurrent_pulls)
    for n, r in relay.relays.items():
        M.RELAY_UP.labels(n).set(1 if r.healthy else 0)


def _safe_live_paths() -> list[dict]:
    return _LIVE["items"]


def _is_departmental_pull(p: dict) -> bool:
    """True for relay paths that pull from a departmental system (<camera>/main|sub).
    Compatibility transcodes (<camera>/<profile>-h264 / -vp8) read the relay itself and are not counted."""
    parts = p["name"].split("/")
    return len(parts) == 2 and parts[1] in ("main", "sub") and bool(p.get("ready"))


@app.get("/api/sources")
def sources(u: A.User = Depends(need("sources"))):
    live = _safe_live_paths()
    with SessionLocal() as s:
        srcs = [x for x in s.scalars(select(Source)).all() if x.id != "registry"]   # inventory-only entries are not a video source
        cams = s.scalars(select(Camera)).all()
    by_src: dict[str, list[str]] = {}
    for c in cams:
        by_src.setdefault(c.source_id, []).append(c.id)
    out = []
    for x in srcs:
        if not u.sees(x.department):
            continue
        ids = set(by_src.get(x.id, []))
        pulls = [p for p in live if p["name"].split("/")[0] in ids and _is_departmental_pull(p)]
        viewers = sum(len(p.get("readers", [])) for p in live if p["name"].split("/")[0] in ids and p.get("ready"))
        out.append({"id": x.id, "department": x.department, "name": x.name, "adapter": x.adapter,
                    "status": x.status, "detail": x.status_detail,
                    "checked_at": x.checked_at.isoformat() if x.checked_at else None,
                    "cameras": len(ids), "active_pulls": len(pulls), "max_concurrent_pulls": x.max_concurrent_pulls,
                    "viewers": viewers})
    return out


# ----------------------------------------------------------------------------- search
from .deps import _parse_time  # noqa: E402


@app.get("/api/events")
def events(request: Request, plate: str = "", fuzzy: bool = False, camera: str = "", tag: str = "",
           vehicle_type: str = "", colour: str = "", since: str | None = None, until: str | None = None, limit: int = 200,
           u: A.User = Depends(need("search"))):
    if plate and not u.has("plate_search"):
        raise HTTPException(403, "searching by plate requires plate_search")
    q = SQ(plate=plate, fuzzy=fuzzy, camera_id=camera, tag=tag, vehicle_type=vehicle_type, vehicle_colour=colour,
           departments=dept_filter(u), since=_parse_time(since), until=_parse_time(until), limit=min(limit, 1000))
    res = [pii.mask_event(e, u) for e in backend().search(q)]
    if plate:
        with SessionLocal() as s:
            audit(s, u.username, "search_plate", plate, f"fuzzy={fuzzy} results={len(res)}",
                  request.client.host if request.client else "")
            s.commit()
    return {"backend": backend().name, "count": len(res), "events": res}


@app.get("/api/vehicles/{plate}/movements")
def movements(plate: str, request: Request, fuzzy: bool = False, since: str | None = None,
              u: A.User = Depends(need("movement"))):
    if not u.has("plate_search"):
        raise HTTPException(403, "tracing a vehicle requires plate_search")
    p = normalise(plate)
    q = SQ(plate=p, fuzzy=fuzzy, departments=dept_filter(u), since=_parse_time(since), limit=1000)
    evs = sorted(backend().search(q), key=lambda e: e["ts"])
    with SessionLocal() as s:
        cams = {c.id: c for c in s.scalars(select(Camera)).all()}
        audit(s, u.username, "vehicle_movement", p, f"sightings={len(evs)}",
              request.client.host if request.client else "")
        s.commit()
    points = []
    for e in evs:
        c = cams.get(e["camera_id"])
        points.append({**e, "camera_name": c.name if c else e["camera_id"], "lat": c.lat if c else None,
                       "lon": c.lon if c else None})
    return {"plate": p, "valid_format": correct(p).valid, "sightings": points,
            "departments": sorted({e["department"] for e in evs}),
            "cameras": sorted({e["camera_id"] for e in evs})}


@app.get("/api/stats")
def stats(hours: int = 24, u: A.User = Depends(current_user)):
    since = utcnow() - dt.timedelta(hours=hours)
    depts = dept_filter(u)
    with SessionLocal() as s:
        rows = s.execute(select(AnprEvent.camera_id, AnprEvent.department, AnprEvent.ts, AnprEvent.plate)
                         .where(AnprEvent.ts >= since)
                         .where(true() if depts is None else AnprEvent.department.in_(depts))).all()
        alerts_open = s.scalar(select(func.count()).select_from(Alert).where(Alert.ack_at.is_(None))
                               .where(true() if depts is None else Alert.department.in_(depts)))
        wl = s.scalar(select(func.count()).select_from(WatchlistEntry))
        cams = s.scalars(select(Camera)).all()
    per_cam: dict[str, int] = {}
    per_min: dict[str, int] = {}
    for cid, _d, ts, _p in rows:
        per_cam[cid] = per_cam.get(cid, 0) + 1
        key = ts.astimezone(dt.timezone(dt.timedelta(minutes=330))).strftime("%H:%M")
        per_min[key] = per_min.get(key, 0) + 1
    visible = [c for c in cams if u.sees(c.department)]
    return {"events": len(rows), "unique_plates": len({r[3] for r in rows}), "alerts_open": alerts_open,
            "watchlist": wl, "cameras": len(visible), "anpr_cameras": sum(c.anpr_enabled for c in visible),
            "cameras_online": sum(c.status in ("online", "live") for c in visible),
            "per_camera": per_cam, "per_minute": dict(sorted(per_min.items())[-60:])}


# ----------------------------------------------------------------------------- tags
class TagIn(BaseModel):
    camera_id: str
    tag: str
    note: str = ""
    ts: str | None = None


@app.post("/api/tags")
def add_tag(body: TagIn, u: A.User = Depends(need("tags"))):
    with SessionLocal() as s:
        cam = s.get(Camera, body.camera_id)
        if not cam or not u.sees(cam.department):
            raise HTTPException(404, "camera not found")
        t = EventTag(camera_id=cam.id, department=cam.department, tag=body.tag.strip().lower()[:64],
                     note=body.note[:500], user_id=u.username, ts=_parse_time(body.ts) or utcnow())
        s.add(t)
        audit(s, u.username, "tag_event", cam.id, t.tag)
        s.commit()
        return {"id": t.id}


@app.get("/api/tags")
def list_tags(camera: str = "", limit: int = 200, u: A.User = Depends(need("search"))):
    with SessionLocal() as s:
        q = select(EventTag).order_by(EventTag.ts.desc()).limit(limit)
        if camera:
            q = q.where(EventTag.camera_id == camera)
        rows = [t for t in s.scalars(q).all() if u.sees(t.department)]
    return [{"id": t.id, "camera_id": t.camera_id, "department": t.department, "ts": t.ts.isoformat(),
             "tag": t.tag, "note": t.note, "user": t.user_id} for t in rows]


# ----------------------------------------------------------------------------- watchlist + alerts
class WatchIn(BaseModel):
    plate: str
    reason: str = ""
    priority: str = "high"
    days: int = 30


@app.get("/api/watchlist")
def watchlist(u: A.User = Depends(need("search"))):
    with SessionLocal() as s:
        rows = s.scalars(select(WatchlistEntry).order_by(WatchlistEntry.added_at.desc())).all()
    return [{"plate": w.plate, "reason": w.reason, "priority": w.priority, "added_by": w.added_by,
             "added_at": w.added_at.isoformat(), "expires_at": w.expires_at.isoformat() if w.expires_at else None}
            for w in rows]


@app.post("/api/watchlist")
def add_watch(body: WatchIn, u: A.User = Depends(need("watchlist"))):
    p = correct(body.plate).plate
    if len(p) < 6:
        raise HTTPException(400, "plate too short")
    with SessionLocal() as s:
        s.merge(WatchlistEntry(plate=p, reason=body.reason[:300], priority=body.priority, added_by=u.username,
                               added_at=utcnow(), expires_at=utcnow() + dt.timedelta(days=max(1, body.days))))
        audit(s, u.username, "watchlist_add", p, body.reason)
        s.commit()
    return {"plate": p}


@app.delete("/api/watchlist/{plate}")
def del_watch(plate: str, u: A.User = Depends(need("watchlist"))):
    with SessionLocal() as s:
        w = s.get(WatchlistEntry, normalise(plate))
        if w:
            s.delete(w)
            audit(s, u.username, "watchlist_remove", w.plate)
            s.commit()
    return {"ok": True}


@app.get("/api/alerts")
def alerts(open_only: bool = False, limit: int = 100, u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        q = select(Alert).order_by(Alert.ts.desc()).limit(limit)
        if open_only:
            q = q.where(Alert.ack_at.is_(None))
        rows = [a for a in s.scalars(q).all() if u.sees(a.department)]
        evs = {e.id: e for e in s.scalars(select(AnprEvent).where(AnprEvent.id.in_([a.event_id for a in rows])))}
    return [pii.mask_event({"id": a.id, "event_id": a.event_id, "plate": a.plate, "watchlist_plate": a.watchlist_plate,
             "match": a.match, "camera_id": a.camera_id, "department": a.department, "ts": a.ts.isoformat(),
             "priority": a.priority, "reason": a.reason, "ack_by": a.ack_by,
             "crop_url": f"/media/{evs[a.event_id].crop_path}" if a.event_id in evs else ""}, u) for a in rows]


@app.post("/api/alerts/{aid}/ack")
def ack(aid: str, u: A.User = Depends(need("alerts_ack"))):
    with SessionLocal() as s:
        a = s.get(Alert, aid)
        if not a or not u.sees(a.department):
            raise HTTPException(404)
        a.ack_by, a.ack_at = u.username, utcnow()
        audit(s, u.username, "alert_ack", aid, a.plate)
        s.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- layouts
LAYOUTS = settings.data_dir / "layouts.json"


@app.get("/api/layouts")
def get_layouts(u: A.User = Depends(current_user)):
    return json.loads(LAYOUTS.read_text()) if LAYOUTS.exists() else {}


@app.put("/api/layouts/{name}")
def put_layout(name: str, body: dict, u: A.User = Depends(need("live"))):
    data = json.loads(LAYOUTS.read_text()) if LAYOUTS.exists() else {}
    data[name[:60]] = {"grid": body.get("grid", "2x2"), "cameras": body.get("cameras", [])[:64],
                       "saved_by": u.username}
    LAYOUTS.write_text(json.dumps(data, indent=1))
    return {"ok": True}


AUDIT_SORT = {"ts": AuditLog.ts, "id": AuditLog.id, "user": AuditLog.user_id, "action": AuditLog.action, "target": AuditLog.target, "ip": AuditLog.ip}


def _audit_row(r: AuditLog) -> dict:
    return {"id": r.id, "ts": r.ts.isoformat(), "user": r.user_id, "action": r.action, "target": r.target,
            "detail": r.detail, "ip": r.ip, "hash": (r.hash or "")[:12]}


def _audit_query(q: str = "", user: str = "", action: str = "", target: str = "", ip: str = "",
                 from_ts: str | None = None, to_ts: str | None = None, sort: str = "ts", order: str = "desc"):
    stmt = select(AuditLog)
    if user:
        stmt = stmt.where(AuditLog.user_id == user)
    if action:
        acts = [a.strip() for a in action.split(",") if a.strip()]
        stmt = stmt.where(AuditLog.action.in_(acts)) if len(acts) > 1 else stmt.where(AuditLog.action == acts[0]) if acts else stmt
    if target:
        stmt = stmt.where(AuditLog.target.ilike(f"%{target}%"))
    if ip:
        stmt = stmt.where(AuditLog.ip.ilike(f"{ip}%"))
    if from_ts:
        stmt = stmt.where(AuditLog.ts >= _parse_time(from_ts))
    if to_ts:
        stmt = stmt.where(AuditLog.ts <= _parse_time(to_ts))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(AuditLog.user_id.ilike(like) | AuditLog.action.ilike(like) | AuditLog.target.ilike(like)
                          | AuditLog.detail.ilike(like) | AuditLog.ip.ilike(like))
    col = AUDIT_SORT.get(sort, AuditLog.ts)
    stmt = stmt.order_by(col.asc() if order == "asc" else col.desc(), AuditLog.id.asc() if order == "asc" else AuditLog.id.desc())
    return stmt


@app.get("/api/audit")
def get_audit(limit: int | None = None, page: int | None = None, page_size: int = 50, q: str = "", user: str = "", action: str = "",
              target: str = "", ip: str = "", from_ts: str | None = Query(default=None, alias="from"),
              to_ts: str | None = Query(default=None, alias="to"), sort: str = "ts", order: str = "desc",
              u: A.User = Depends(need("audit"))):
    """Audit rows. `?limit=N` (legacy) returns a plain list of the newest N rows; `?page=` returns
    {items, total, page, pages, page_size} with filters (user, action, target, ip, from, to, q) and sorting
    (sort=ts|user|action|target|ip, order=asc|desc)."""
    stmt = _audit_query(q, user, action, target, ip, from_ts, to_ts, sort, order)
    with SessionLocal() as s:
        if page is None:
            rows = s.scalars(stmt.limit(min(int(limit or 200), 5000))).all()
            return [_audit_row(r) for r in rows]
        page = max(1, page)
        page_size = max(1, min(page_size, 500))
        total = int(s.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0)
        rows = s.scalars(stmt.offset((page - 1) * page_size).limit(page_size)).all()
        return {"items": [_audit_row(r) for r in rows], "total": total, "page": page, "page_size": page_size,
                "pages": max(1, -(-total // page_size)), "sort": sort if sort in AUDIT_SORT else "ts", "order": order}


@app.get("/api/audit/facets")
def audit_facets(u: A.User = Depends(need("audit"))):
    """Distinct users and actions (with counts) for the filter drop-downs."""
    with SessionLocal() as s:
        acts = s.execute(select(AuditLog.action, func.count()).group_by(AuditLog.action).order_by(func.count().desc())).all()
        users = s.execute(select(AuditLog.user_id, func.count()).group_by(AuditLog.user_id).order_by(func.count().desc())).all()
        first = s.scalar(select(func.min(AuditLog.ts)))
        total = s.scalar(select(func.count()).select_from(AuditLog)) or 0
    return {"actions": [{"action": a, "count": n} for a, n in acts], "users": [{"user": x, "count": n} for x, n in users],
            "total": int(total), "first_ts": first.isoformat() if first else None}


@app.get("/api/audit/export.csv")
def audit_export(request: Request, q: str = "", user: str = "", action: str = "", target: str = "", ip: str = "",
                 from_ts: str | None = Query(default=None, alias="from"), to_ts: str | None = Query(default=None, alias="to"),
                 sort: str = "ts", order: str = "desc", u: A.User = Depends(need("audit"))):
    """The filtered audit rows as CSV (max 50,000 rows); the export itself is audited."""
    import csv
    import io
    from fastapi.responses import Response
    stmt = _audit_query(q, user, action, target, ip, from_ts, to_ts, sort, order)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "time_utc", "user", "action", "target", "detail", "ip", "hash", "prev_hash"])
    with SessionLocal() as s:
        n = 0
        for r in s.scalars(stmt.limit(50000)):
            w.writerow([r.id, r.ts.isoformat(), r.user_id, r.action, r.target, r.detail, r.ip, r.hash, r.prev_hash])
            n += 1
        audit(s, u.username, "audit_export", "", f"rows={n} q={q!r} user={user!r} action={action!r} from={from_ts} to={to_ts}", _ip(request))
        s.commit()
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f"attachment; filename=audit-{utcnow().date()}.csv"})


@app.get("/api/audit/verify")
def audit_verify(request: Request, u: A.User = Depends(need("audit"))):
    with SessionLocal() as s:
        res = verify_audit_chain(s)
        audit(s, u.username, "audit_verify", "", json.dumps(res), _ip(request))
        s.commit()
    return res


# ----------------------------------------------------------------------------- media (plate crops)
@app.get("/media/crops/incidents/{day}/{name}")
def media_incident(day: str, name: str, u: A.User = Depends(current_user)):
    from ..db import Incident
    with SessionLocal() as s:
        i = s.get(Incident, name.split(".")[0])
    if not i or not u.sees(i.department):
        raise HTTPException(404)
    p = (settings.crops_dir / "incidents" / day / name).resolve()
    if settings.crops_dir.resolve() not in p.parents or not p.exists():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "private, max-age=3600"})


@app.get("/media/crops/{day}/{name}")
def media(day: str, name: str, u: A.User = Depends(current_user)):
    eid = name.split("_")[0]
    with SessionLocal() as s:
        e = s.get(AnprEvent, eid)
    if not e or not u.sees(e.department):
        raise HTTPException(404)
    p = (settings.crops_dir / day / name).resolve()
    if settings.crops_dir.resolve() not in p.parents or not p.exists():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "private, max-age=3600"})


# ----------------------------------------------------------------------------- video archive
def _archive_url(key: str) -> str:
    u = store().url(key, settings.s3_url_ttl_s)
    return u if u.startswith("http") else u  # local: /archive/<key>, the UI appends ?token=


@app.get("/api/events/{eid}/clip")
def event_clip(eid: str, request: Request, u: A.User = Depends(need("playback"))):
    """status: ready | pending (archiver has not processed it yet) | none (no recording for that camera)."""
    with SessionLocal() as s:
        e = s.get(AnprEvent, eid)
        if not e or not u.sees(e.department):
            raise HTTPException(404)
        out = pii.mask_event({"id": e.id, "plate": e.plate, "camera_id": e.camera_id, "ts": e.ts.isoformat()}, u)
        if e.clip_key == "":
            out["status"] = "pending"
        elif e.clip_key == "-":
            out["status"] = "none"
        else:
            out["status"] = "ready"
            out["url"] = _archive_url(e.clip_key)
            audit(s, u.username, "view_clip", e.id, f"{e.plate} {e.camera_id}", request.client.host if request.client else "")
            s.commit()
        for k in ("crop_key", "frame_key"):
            v = getattr(e, k)
            if v and v != "-":
                out[k.replace("_key", "_archive_url")] = _archive_url(v)
    return out


@app.get("/api/cameras/{cam_id}/recordings")
def camera_recordings(cam_id: str, request: Request, day: str = "", u: A.User = Depends(need("playback"))):
    with SessionLocal() as s:
        cam = s.get(Camera, cam_id)
        if not cam or not u.allows(cam.id, cam.department, "playback"):
            raise HTTPException(404)
        d = dt.date.fromisoformat(day) if day else utcnow().date()
        lo = dt.datetime.combine(d, dt.time.min, dt.timezone.utc)
        rows = s.scalars(select(Recording).where(Recording.camera_id == cam_id, Recording.start_ts >= lo,
                                                 Recording.start_ts < lo + dt.timedelta(days=1))
                         .order_by(Recording.start_ts)).all()
        audit(s, u.username, "list_recordings", cam_id, str(d), request.client.host if request.client else "")
        s.commit()
        return {"camera_id": cam_id, "day": d.isoformat(), "count": len(rows),
                "segments": [{"id": r.id, "start": r.start_ts.isoformat(), "duration_s": r.duration_s, "bytes": r.bytes,
                              "url": _archive_url(r.key)} for r in rows]}


@app.get("/api/archive/stats")
def archive_stats(u: A.User = Depends(need("sources"))):
    with SessionLocal() as s:
        rec = s.execute(select(Recording.department, func.count(), func.coalesce(func.sum(Recording.bytes), 0),
                               func.min(Recording.start_ts), func.max(Recording.start_ts)).group_by(Recording.department)).all()
        clips = s.execute(select(AnprEvent.department, func.count()).where(AnprEvent.clip_key != "", AnprEvent.clip_key != "-")
                          .group_by(AnprEvent.department)).all()
    clip_by = {d: n for d, n in clips}
    out = []
    for d, n, b, lo, hi in rec:
        if u.sees(d):
            out.append({"department": d, "segments": n, "bytes": int(b), "clips": clip_by.get(d, 0),
                        "from": lo.isoformat() if lo else None, "to": hi.isoformat() if hi else None})
    for d, n in clips:
        if d not in {o["department"] for o in out} and u.sees(d):
            out.append({"department": d, "segments": 0, "bytes": 0, "clips": n, "from": None, "to": None})
    return {"storage": storage_describe(), "record_mode": settings.record_mode, "departments": out}


@app.get("/archive/{key:path}")
def archive_object(key: str, u: A.User = Depends(need("playback"))):
    """Local-backend only: serve an archived object after checking the viewer may see its department."""
    p = store().local_path(key)
    if p is None:
        raise HTTPException(404)
    with SessionLocal() as s:
        if key.startswith("recordings/"):
            r = s.scalar(select(Recording).where(Recording.key == key))
            dept = r.department if r else None
        else:
            eid = Path(key).name.split("_")[0].split(".")[0]
            e = s.get(AnprEvent, eid)
            dept = e.department if e else None
    if dept is None or not u.sees(dept):
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "private, max-age=3600"})


# ----------------------------------------------------------------------------- admin: grants, legal holds, users
class GrantIn(BaseModel):
    username: str
    kind: str                 # feature | camera | department
    value: str
    reason: str = ""
    hours: float = 24


@app.get("/api/admin/grants")
def list_grants(username: str = "", active: bool = True, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        q = select(AccessGrant).order_by(AccessGrant.starts_at.desc()).limit(500)
        if username:
            q = q.where(AccessGrant.username == username)
        rows = s.scalars(q).all()
        now = utcnow()
        out = []
        for g in rows:
            live = g.revoked_at is None and (g.expires_at is None or g.expires_at > now)
            if active and not live:
                continue
            out.append({"id": g.id, "username": g.username, "kind": g.kind, "value": g.value, "reason": g.reason,
                        "granted_by": g.granted_by, "starts_at": g.starts_at.isoformat(),
                        "expires_at": g.expires_at.isoformat() if g.expires_at else None, "active": live,
                        "revoked_by": g.revoked_by})
    return out


@app.post("/api/admin/grants")
def add_grant(body: GrantIn, request: Request, u: A.User = Depends(need("admin"))):
    if body.kind not in ("feature", "camera", "department"):
        raise HTTPException(400, "kind must be feature | camera | department")
    if body.kind == "feature" and body.value not in rbac.FEATURES:
        raise HTTPException(400, f"unknown feature; one of {rbac.FEATURES}")
    with SessionLocal() as s:
        g = AccessGrant(username=body.username.strip(), kind=body.kind, value=body.value.strip(), reason=body.reason[:500],
                        granted_by=u.username,
                        expires_at=(utcnow() + dt.timedelta(hours=body.hours)) if body.hours > 0 else None)
        s.add(g)
        audit(s, u.username, "grant_add", f"{g.username}:{g.kind}:{g.value}", f"{body.hours}h {body.reason[:200]}", _ip(request))
        s.commit()
        return {"id": g.id}


@app.delete("/api/admin/grants/{gid}")
def revoke_grant(gid: str, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        g = s.get(AccessGrant, gid)
        if not g:
            raise HTTPException(404)
        g.revoked_at, g.revoked_by = utcnow(), u.username
        audit(s, u.username, "grant_revoke", f"{g.username}:{g.kind}:{g.value}", ip=_ip(request))
        s.commit()
    return {"ok": True}


class HoldIn(BaseModel):
    kind: str                 # plate | camera | event | case
    value: str
    reason: str = ""
    reference: str = ""
    from_ts: str | None = None
    to_ts: str | None = None


@app.get("/api/admin/holds")
def list_holds(active: bool = True, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        rows = s.scalars(select(LegalHold).order_by(LegalHold.created_at.desc()).limit(500)).all()
    return [{"id": h.id, "kind": h.kind, "value": h.value, "reason": h.reason, "reference": h.reference,
             "from_ts": h.from_ts.isoformat() if h.from_ts else None, "to_ts": h.to_ts.isoformat() if h.to_ts else None,
             "created_by": h.created_by, "created_at": h.created_at.isoformat(),
             "released_at": h.released_at.isoformat() if h.released_at else None}
            for h in rows if not active or h.released_at is None]


@app.post("/api/admin/holds")
def add_hold(body: HoldIn, request: Request, u: A.User = Depends(need("admin"))):
    if body.kind not in ("plate", "camera", "event", "case"):
        raise HTTPException(400, "kind must be plate | camera | event | case")
    val = normalise(body.value) if body.kind == "plate" else body.value.strip()
    with SessionLocal() as s:
        h = LegalHold(kind=body.kind, value=val, reason=body.reason[:1000], reference=body.reference[:128],
                      from_ts=_parse_time(body.from_ts), to_ts=_parse_time(body.to_ts), created_by=u.username)
        s.add(h)
        audit(s, u.username, "legal_hold_add", f"{h.kind}:{h.value}", body.reference, _ip(request))
        s.commit()
        return {"id": h.id}


@app.delete("/api/admin/holds/{hid}")
def release_hold(hid: str, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        h = s.get(LegalHold, hid)
        if not h:
            raise HTTPException(404)
        h.released_at, h.released_by = utcnow(), u.username
        audit(s, u.username, "legal_hold_release", f"{h.kind}:{h.value}", h.reference, _ip(request))
        s.commit()
    return {"ok": True}


@app.get("/api/admin/users")
def list_users(u: A.User = Depends(need("admin"))):
    """Local users plus the security state of everyone who has logged in (LDAP/OIDC users appear after first login)."""
    local = A._users()
    with SessionLocal() as s:
        sec = {r.username: r for r in s.scalars(select(Users)).all()}      # every row carries 2FA + lockout state
        grants = {}
        for g in s.scalars(select(AccessGrant).where(AccessGrant.revoked_at.is_(None))):
            if g.expires_at is None or g.expires_at > utcnow():
                grants[g.username] = grants.get(g.username, 0) + 1
        dbu = {n: r for n, r in sec.items() if r.provider == "db"}
        yaml_on = A.yaml_users_active(s)
    # security rows of users.yaml demo accounts are stale once db accounts exist: hide them instead of showing "directory"
    names = sorted(set(dbu) | (set(local) if yaml_on else set()) | {n for n in sec if yaml_on or n not in local})
    out = []
    for n in names:
        lu, se, r = local.get(n, {}), sec.get(n), dbu.get(n)
        if r is not None:
            role, depts, provider = r.role, list(r.departments or []), "db"
        elif n in local and yaml_on:
            role, depts, provider = lu.get("role", "-"), lu.get("departments", []), "users.yaml"
        else:
            role, depts, provider = "-", [], (se.provider if se and se.provider not in ("db", "users.yaml") else "directory")
        out.append({"username": n, "provider": provider, "role": role, "departments": depts,
                    "is_super": bool(r and r.is_super), "is_active": bool(r.is_active) if r else True,
                    "mfa_enrolled": bool(se and se.mfa_enrolled),
                    "mfa_required": A.mfa_required_for(role),
                    "locked_until": se.locked_until.isoformat() if se and se.locked_until else None,
                    "last_login": se.last_login.isoformat() if se and se.last_login else None,
                    "active_grants": grants.get(n, 0)})
    return out


@app.post("/api/admin/users/{username}/unlock")
def unlock_user(username: str, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        A.note_login(s, username, True)
        audit(s, u.username, "user_unlock", username, ip=_ip(request))
        s.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- signed, watermarked exports
def _bundle(files: dict[str, Path], kind: str, u: A.User, extra: dict) -> Path:
    """Zip files + manifest.json + manifest.sig; returns the zip path (in a temp dir)."""
    tmp = Path(tempfile.mkdtemp(prefix="uvp-export-"))
    manifest = signing.build_manifest(files, u.username, kind, extra)
    sig = signing.sign_manifest(manifest)
    zpath = tmp / f"{kind}.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for name, p in files.items():
            z.write(p, name)
        z.writestr("manifest.json", json.dumps(manifest, indent=1))
        z.writestr("manifest.sig", sig)
        z.writestr("public_key.pem", signing.public_key_pem())
        z.writestr("README.txt", "Verify: POST manifest.json + manifest.sig to /api/verify on the platform, or check the\n"
                   "Ed25519 signature over the canonical (sorted, compact) JSON with public_key.pem.\n"
                   "Each file's SHA-256 is listed in manifest.json.\n")
    return zpath


@app.get("/api/events/{eid}/export")
def export_event(eid: str, request: Request, u: A.User = Depends(need("export"))):
    """Evidence bundle for one event: watermarked frame + crop + watermarked clip, signed manifest."""
    with SessionLocal() as s:
        e = s.get(AnprEvent, eid)
        if not e or not u.allows(e.camera_id, e.department, "export"):
            raise HTTPException(404)
        cam = s.get(Camera, e.camera_id)
        info = {"event_id": e.id, "plate": e.plate, "camera_id": e.camera_id, "camera_name": cam.name if cam else "",
                "department": e.department, "ts": e.ts.isoformat(), "confidence": e.confidence, "reads": e.reads,
                "tags": e.tags or [], "watermark": pii.watermark_text(u.username, extra=e.plate)}
        crop_p, frame_p, clip_k = e.crop_path, e.frame_path, e.clip_key
        audit(s, u.username, "export_event", e.id, e.plate, _ip(request))
        s.commit()
    tmp = Path(tempfile.mkdtemp(prefix="uvp-ev-"))
    files: dict[str, Path] = {}
    wm = info["watermark"]
    fp = settings.data_dir / frame_p if frame_p else None
    if fp and fp.exists():
        pii.watermark_image(fp, tmp / "frame.jpg", wm)
        files["frame.jpg"] = tmp / "frame.jpg"
    cp = settings.data_dir / crop_p if crop_p else None
    if cp and cp.exists():
        shutil.copyfile(cp, tmp / "plate.jpg")
        files["plate.jpg"] = tmp / "plate.jpg"
    if clip_k and clip_k != "-":
        src = store().local_path(clip_k)
        if src is None:  # S3: fetch to temp
            import requests
            r = requests.get(store().url(clip_k, 300), timeout=120)
            if r.ok:
                (tmp / "clip_src.mp4").write_bytes(r.content)
                src = tmp / "clip_src.mp4"
        if src is not None:
            try:
                pii.watermark_video(src, tmp / "clip.mp4", wm)
                files["clip.mp4"] = tmp / "clip.mp4"
            except Exception as ex:  # noqa: BLE001
                log.warning("clip watermark failed: %s", ex)
    (tmp / "event.json").write_text(json.dumps(info, indent=1))
    files["event.json"] = tmp / "event.json"
    z = _bundle(files, f"event_{eid[:8]}", u, {"event": info})
    return FileResponse(z, filename=f"evidence_{info['plate']}_{eid[:8]}.zip", media_type="application/zip")


@app.get("/api/events/export.csv")
def export_csv(request: Request, plate: str = "", camera: str = "", tag: str = "", since: str | None = None,
               until: str | None = None, limit: int = 5000, u: A.User = Depends(need("export"))):
    """Signed CSV of the current search (zip: records.csv + manifest + signature)."""
    q = SQ(plate=plate, camera_id=camera, tag=tag, departments=dept_filter(u), since=_parse_time(since),
           until=_parse_time(until), limit=min(limit, 20000))
    rows = backend().search(q)
    tmp = Path(tempfile.mkdtemp(prefix="uvp-csv-"))
    with open(tmp / "records.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time_utc", "plate", "camera", "department", "confidence", "reads", "direction", "tags", "event_id",
                    "exported_by"])
        for e in rows:
            w.writerow([e["ts"], e["plate"], e["camera_id"], e["department"], e["confidence"], e["reads"],
                        e["direction"], "|".join(e.get("tags") or []), e["id"], u.username])
    with SessionLocal() as s:
        audit(s, u.username, "export_csv", plate or camera or tag or "*", f"rows={len(rows)}", _ip(request))
        s.commit()
    z = _bundle({"records.csv": tmp / "records.csv"}, "records", u, {"query": {"plate": plate, "camera": camera, "tag": tag,
                                                                       "since": since, "until": until}, "rows": len(rows)})
    return FileResponse(z, filename="anpr_records_signed.zip", media_type="application/zip")


class VerifyIn(BaseModel):
    manifest: dict
    signature: str


@app.post("/api/verify")
def verify_export(body: VerifyIn):
    """Public: confirms a manifest + signature were produced by this platform's signing key."""
    return {"valid": signing.verify_manifest(body.manifest, body.signature), "public_key": signing.public_key_pem()}


@app.get("/api/signing/public-key")
def public_key():
    return {"algorithm": "Ed25519", "public_key_pem": signing.public_key_pem()}


# ----------------------------------------------------------------------------- compliance: DPDP, CERT-In
def _holds_for_plate(s, plate: str) -> list:
    return [h for h in s.scalars(select(LegalHold).where(LegalHold.released_at.is_(None), LegalHold.kind == "plate",
                                                        LegalHold.value == plate))]


@app.get("/api/dpdp/subject-access")
def subject_access(plate: str, request: Request, u: A.User = Depends(need("admin"))):
    """DPDP Act s.11: everything the platform holds about one vehicle registration."""
    p = normalise(plate)
    with SessionLocal() as s:
        evs = s.scalars(select(AnprEvent).where(AnprEvent.plate == p).order_by(AnprEvent.ts)).all()
        alerts = s.scalars(select(Alert).where(Alert.plate == p)).all()
        wl = s.get(WatchlistEntry, p)
        holds = _holds_for_plate(s, p)
        audit(s, u.username, "dpdp_subject_access", p, f"events={len(evs)}", _ip(request))
        s.commit()
        return {"plate": p, "events": [{"id": e.id, "ts": e.ts.isoformat(), "camera_id": e.camera_id,
                                        "department": e.department, "tags": e.tags, "has_clip": e.clip_key not in ("", "-")}
                                       for e in evs],
                "alerts": [{"id": a.id, "ts": a.ts.isoformat(), "reason": a.reason} for a in alerts],
                "watchlist": bool(wl), "legal_holds": [h.reference or h.reason for h in holds],
                "retention_days": {k: v for k, v in _retention_default().items()}}


def _retention_default() -> dict:
    from .archiver import retention_policy
    return retention_policy()["default"]


@app.post("/api/dpdp/erase")
def erase(plate: str, request: Request, reason: str = "", u: A.User = Depends(need("admin"))):
    """Erase a vehicle's records (events, alerts, archive objects) unless a legal hold or watchlist entry applies."""
    p = normalise(plate)
    with SessionLocal() as s:
        if _holds_for_plate(s, p):
            raise HTTPException(409, "legal hold in force for this plate")
        if s.get(WatchlistEntry, p):
            raise HTTPException(409, "plate is on the watchlist; remove it first")
        evs = s.scalars(select(AnprEvent).where(AnprEvent.plate == p)).all()
        st = store()
        n_obj = 0
        for e in evs:
            for k in (e.clip_key, e.crop_key, e.frame_key):
                if k and k != "-":
                    try:
                        st.delete(k)
                        n_obj += 1
                    except Exception:  # noqa: BLE001
                        pass
            for rel in (e.crop_path, e.frame_path):
                if rel and (settings.data_dir / rel).exists():
                    (settings.data_dir / rel).unlink()
            s.delete(e)
        n_alerts = 0
        for a in s.scalars(select(Alert).where(Alert.plate == p)):
            s.delete(a)
            n_alerts += 1
        try:
            backend().delete_plate(p)
        except Exception:  # noqa: BLE001
            pass
        audit(s, u.username, "dpdp_erase", p, f"events={len(evs)} alerts={n_alerts} objects={n_obj} {reason[:200]}", _ip(request))
        s.commit()
        return {"plate": p, "events_erased": len(evs), "alerts_erased": n_alerts, "objects_erased": n_obj}


_OWN_FILE_VARS = {"SIGNING_KEY_FILE", "SOURCES_FILE", "USERS_FILE", "RULES_FILE", "AUTH_FILE"}


def _secrets_source() -> str:
    if os.environ.get("VAULT_ADDR"):
        return "vault"
    if any(k.endswith("_FILE") and k not in _OWN_FILE_VARS and os.path.isfile(v) for k, v in os.environ.items()):
        return "files (docker/k8s secrets)"
    return "env (.env) - use files or Vault in production"


@app.get("/api/compliance/status")
def compliance_status(u: A.User = Depends(need("admin"))):
    from .archiver import retention_policy
    cfg = A.auth_cfg()
    prov = cfg.get("providers") or {}
    with SessionLocal() as s:
        chain = verify_audit_chain(s)
        oldest = s.scalar(select(func.min(AuditLog.ts)))
        holds = s.scalar(select(func.count()).select_from(LegalHold).where(LegalHold.released_at.is_(None)))
    pol = retention_policy()
    return {
        "identity": {"local": bool((prov.get("local") or {"enabled": True}).get("enabled", True)),
                     "ldap": bool((prov.get("ldap") or {}).get("enabled")), "oidc": bool((prov.get("oidc") or {}).get("enabled")),
                     "mfa_required_roles": (cfg.get("mfa") or {}).get("required_roles", []),
                     "lockout": {"failures": settings.login_max_failures, "seconds": settings.login_lockout_s}},
        "audit": {"hash_chain": chain, "oldest_entry": oldest.isoformat() if oldest else None,
                  "retention_days": pol["default"].get("audit_days", 180), "certin_180_days": pol["default"].get("audit_days", 180) >= 180},
        "retention": pol, "legal_holds_active": holds,
        "pii": {"mask_plates": settings.pii_mask_plates, "blur_faces": settings.pii_blur_faces},
        "encryption": {"object_storage_sse": settings.s3_sse or "none (set S3_SSE=AES256)",
                       "tls_proxy": bool(settings.relay_public_base), "secrets": _secrets_source()},
        "exports": {"signed": True, "watermarked": True, "public_key": signing.public_key_pem()},
        "dpdp": {"subject_access": "/api/dpdp/subject-access?plate=", "erasure": "/api/dpdp/erase?plate=",
                 "purpose": "traffic enforcement and public safety; access scoped by department and audited"},
    }


# ----------------------------------------------------------------------------- internal
def _store_inline_media(ev: dict) -> None:
    """Edge workers ship crop/frame JPEGs inline (crop_b64 / frame_b64); write them where the API serves them."""
    import base64
    for key in ("crop", "frame"):
        b64 = ev.pop(f"{key}_b64", None)
        if not b64:
            continue
        rel = ev.get(f"{key}_path") or f"crops/{ev['ts'][:10]}/{ev['id']}_{'plate' if key == 'crop' else 'frame'}.jpg"
        p = settings.data_dir / rel
        if not p.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
            try:
                p.write_bytes(base64.b64decode(b64))
            except (ValueError, OSError):
                continue
        ev[f"{key}_path"] = rel


@app.post("/internal/events", dependencies=[Depends(internal)])
def ingest(ev: dict):
    _store_inline_media(ev)
    alerts = indexer.handle(ev)
    broadcast("anpr.event", {"id": ev["id"], "plate": ev["plate"], "camera_id": ev["camera_id"], "department": ev["department"],
                             "ts": ev["ts"], "crop_url": f"/media/{ev.get('crop_path', '')}", "tags": ev.get("tags", []),
                             "attrs": ev.get("attrs", {}), "confidence": ev.get("confidence"), "direction": ev.get("direction")})
    for alert in alerts:
        broadcast("alert", alert)
    return {"ok": True, "alert": bool(alerts), "alerts": len(alerts)}


_view_audit: dict[tuple[str, str], float] = {}
_pub_cache: dict = {"at": 0.0, "keys": {}}


def _publish_keys() -> dict[str, str]:
    """camera id -> publish key for every push source (sources.yaml + console devices), cached 30 s."""
    if time.time() - _pub_cache["at"] > 30:
        keys: dict[str, str] = {}
        try:
            from ..adapters.registry import build
            from .adapter_service import all_sources
            for scfg in all_sources().get("sources", []):
                if scfg.get("adapter") != "push":
                    continue
                ad = build(scfg)
                k = ad.publish_key()
                if k:
                    for c in ad.list_cameras():
                        keys[f"{scfg.get('id_prefix', '')}{c.native_id}"] = k
        except Exception:  # noqa: BLE001
            log.exception("publish keys")
        _pub_cache.update({"at": time.time(), "keys": keys})
    return _pub_cache["keys"]


_deny_seen: dict[str, float] = {}


def _deny_log(path: str, why: str) -> None:
    """One WARNING per stream per 30 s saying *why* the relay was told 403 (the access log shows only the status)."""
    now = time.time()
    if now - _deny_seen.get(path, 0) > 30:
        _deny_seen[path] = now
        log.warning("relay-auth 403 for %s: %s", path, why)


@app.post("/internal/relay-auth")
def relay_auth(b: dict):
    """Called by MediaMTX for every read/publish/api request. 200 = allow, 401/403 = deny.

    Deliberately a sync handler (thread pool): it calls back into the relay's API, and the
    relay in turn authenticates that call here, so it must never block the event loop."""
    action, path, proto = b.get("action"), b.get("path", ""), b.get("protocol", "")
    if b.get("user") == settings.relay_internal_user and b.get("password") == settings.relay_internal_pass:
        return JSONResponse({"ok": True})
    if action == "publish":
        # a site connector pushing a camera's stream: user "site", password = the push source's publish key
        cam_id = path.split("/")[0]
        key = _publish_keys().get(cam_id)
        if key is None and time.time() - _pub_cache["at"] > 5:      # a device connected seconds ago: refresh now
            _pub_cache["at"] = 0
            key = _publish_keys().get(cam_id)
        if key and b.get("password") == key and path.endswith("/main"):
            return JSONResponse({"ok": True})
        return JSONResponse({"error": "publish denied"}, status_code=401)
    if action not in ("read", "playback") or proto not in ("webrtc", "hls"):
        return JSONResponse({"error": "denied"}, status_code=401)
    qs = dict(x.split("=", 1) for x in (b.get("query") or "").split("&") if "=" in x)
    u = A.verify_token(qs.get("token") or b.get("token") or b.get("password") or "")
    if not u:
        return JSONResponse({"error": "no valid token"}, status_code=401)
    cam_id = path.split("/")[0]
    with SessionLocal() as s:
        cam = s.get(Camera, cam_id)
        src = s.get(Source, cam.source_id) if cam else None
        cam_ids = {c for (c,) in s.execute(select(Camera.id).where(Camera.source_id == cam.source_id))} if cam else set()
    if not cam or not u.has("live") or not u.allows(cam.id, cam.department, "live"):
        _deny_log(path, f"{u.username} may not view {cam_id}" + ("" if cam else " (unknown camera)"))
        return JSONResponse({"error": "not permitted"}, status_code=403)
    # Non-interference control: cap concurrent pulls per departmental source.
    live = _safe_live_paths()
    base = path.removesuffix("-vp8").removesuffix("-h264")  # a transcode reads the base path, which is the real departmental pull
    already = any(p["name"] == base and _is_departmental_pull(p) for p in live)
    active = sum(1 for p in live if _is_departmental_pull(p) and p["name"].split("/")[0] in cam_ids)
    if not already and src and active >= src.max_concurrent_pulls:
        _deny_log(path, f"source {src.id} at its cap of {src.max_concurrent_pulls} concurrent streams ({active} pulling) - {u.username} asked for {cam_id}")
        return JSONResponse({"error": f"source {src.id} at its cap of {src.max_concurrent_pulls} streams"},
                            status_code=403)
    key = (u.username, path)
    if time.time() - _view_audit.get(key, 0) > 300:
        _view_audit[key] = time.time()
        with SessionLocal() as s:
            audit(s, u.username, "view_live", path, proto + (" break_glass" if u.break_glass else ""), b.get("ip", ""))
            s.commit()
    return JSONResponse({"ok": True})


# ----------------------------------------------------------------------------- routers
from .routes_investigation import router as investigation_router  # noqa: E402
from .routes_analytics import router as analytics_router  # noqa: E402
from .routes_ops import router as ops_router  # noqa: E402
from .routes_users import router as users_router  # noqa: E402
from .routes_persons import router as persons_router  # noqa: E402
from .routes_analysis import router as analysis_router  # noqa: E402
from .routes_registry import router as registry_router  # noqa: E402
from .routes_devices import router as devices_router  # noqa: E402
from .routes_ops2 import router as ops2_router  # noqa: E402
from .routes_corridors import router as corridors_router  # noqa: E402
from .routes_perms import router as perms_router  # noqa: E402
app.include_router(investigation_router)
app.include_router(analytics_router)
app.include_router(ops_router)
app.include_router(users_router)
app.include_router(persons_router)
app.include_router(analysis_router)
app.include_router(registry_router)
app.include_router(devices_router)
app.include_router(ops2_router)
app.include_router(corridors_router)
app.include_router(perms_router)


# ----------------------------------------------------------------------------- web UI
WEB = Path(settings.web_dir)
REACT = Path(settings.web_react_dir)


def _legacy_html():
    """Legacy console entry: assets carry the build version so a new build is never served from a stale browser cache."""
    from fastapi import Response
    html = (WEB / "index.html").read_text(encoding="utf-8")
    v = settings.version
    html = html.replace('href="styles.css"', f'href="styles.css?v={v}"').replace('src="app.js"', f'src="app.js?v={v}"')
    return Response(html, media_type="text/html", headers={"Cache-Control": "no-store"})


if WEB.exists() and (REACT / "index.html").exists():
    # React console (platform/web-react, built with `npm run build`) at /, the legacy console at /legacy/ (pages the
    # React shell has not rebuilt yet open it in an iframe). /m/ (field app) and /legacy/brand keep their paths.
    @app.get("/legacy/", include_in_schema=False)
    def _legacy_index():
        return _legacy_html()

    @app.get("/legacy", include_in_schema=False)
    def _legacy_redirect():
        return RedirectResponse("/legacy/")

    app.mount("/legacy", StaticFiles(directory=WEB, html=True), name="legacy")
    if (WEB / "m").exists():
        app.mount("/m", StaticFiles(directory=WEB / "m", html=True), name="field-app")
    app.mount("/assets", StaticFiles(directory=REACT / "assets"), name="react-assets")

    @app.get("/{path:path}", include_in_schema=False)
    def _spa(path: str):
        """React routes (/admin/permissions, /notifications, ...) all load index.html; real files in dist are served as-is."""
        from fastapi import Response
        f = (REACT / path) if path else None
        if f and f.is_file() and REACT in f.resolve().parents:
            return FileResponse(f)
        if path.startswith(("api/", "ws/", "media/", "archive/", "internal/")):
            raise HTTPException(404)
        return Response((REACT / "index.html").read_text(encoding="utf-8"), media_type="text/html", headers={"Cache-Control": "no-store"})
elif WEB.exists():
    @app.get("/", include_in_schema=False)
    def _index():
        return _legacy_html()

    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
