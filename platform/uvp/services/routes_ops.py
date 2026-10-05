"""Operations & integration routes: API keys, subscriber webhooks, notification log, camera health SLA
and image quality, Vahan registration lookup, tenants, vendor presets, ticketing."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import secrets
import time

import requests
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select

from .. import auth as A
from .. import rbac
from ..config import settings
from ..db import (ApiKey, Camera, CameraQuality, CameraStatusLog, Notification, SessionLocal, Webhook, audit, utcnow)
from ..plates import normalise
from ..tenancy import branding, tenants
from .deps import _ip, current_user, dept_filter, internal, need

log = logging.getLogger("uvp.ops")
router = APIRouter()
WEBHOOK_KINDS = ["anpr.event", "alert", "incident", "challan", "camera.health", "break_glass"]


# ----------------------------------------------------------------------------- API keys
class KeyIn(BaseModel):
    name: str
    features: list[str] = ["search", "playback"]
    departments: list[str] = ["*"]
    days: int = 365


def _key_dict(k: ApiKey) -> dict:
    return {"id": k.id, "name": k.name, "prefix": k.prefix, "features": k.features, "departments": k.departments,
            "created_by": k.created_by, "created_at": k.created_at.isoformat(),
            "expires_at": k.expires_at.isoformat() if k.expires_at else None,
            "last_used": k.last_used.isoformat() if k.last_used else None, "revoked": bool(k.revoked_at)}


@router.get("/api/admin/api-keys")
def list_keys(u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        return [_key_dict(k) for k in s.scalars(select(ApiKey).order_by(ApiKey.created_at.desc()))]


@router.post("/api/admin/api-keys")
def create_key(body: KeyIn, request: Request, u: A.User = Depends(need("admin"))):
    bad = [f for f in body.features if f not in rbac.FEATURES]
    if bad:
        raise HTTPException(400, f"unknown features {bad}")
    if "admin" in body.features:
        raise HTTPException(400, "API keys cannot carry the admin feature")
    raw = "uvp_" + secrets.token_urlsafe(32)
    with SessionLocal() as s:
        k = ApiKey(name=body.name.strip()[:100], prefix=raw[:10], key_hash=hashlib.sha256(raw.encode()).hexdigest(),
                   features=body.features, departments=body.departments, tenant=u.tenant, created_by=u.username,
                   expires_at=utcnow() + dt.timedelta(days=body.days) if body.days > 0 else None)
        s.add(k)
        audit(s, u.username, "api_key_create", k.name, f"{body.features} {body.departments}", _ip(request))
        s.commit()
        return {**_key_dict(k), "key": raw, "note": "Store this key now; it is shown once."}


@router.delete("/api/admin/api-keys/{kid}")
def revoke_key(kid: str, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        k = s.get(ApiKey, kid)
        if not k:
            raise HTTPException(404)
        k.revoked_at = utcnow()
        audit(s, u.username, "api_key_revoke", k.name, ip=_ip(request))
        s.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- webhooks
class HookIn(BaseModel):
    name: str
    url: str
    kinds: list[str] = ["alert"]
    departments: list[str] = ["*"]
    secret: str = ""


def _hook_dict(w: Webhook) -> dict:
    return {"id": w.id, "name": w.name, "url": w.url, "kinds": w.kinds, "departments": w.departments, "active": w.active,
            "has_secret": bool(w.secret), "created_by": w.created_by, "failures": w.failures, "last_status": w.last_status,
            "last_delivery": w.last_delivery.isoformat() if w.last_delivery else None}


@router.get("/api/admin/webhooks")
def list_hooks(u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        return {"kinds": WEBHOOK_KINDS, "webhooks": [_hook_dict(w) for w in s.scalars(select(Webhook).order_by(Webhook.created_at.desc()))]}


@router.post("/api/admin/webhooks")
def create_hook(body: HookIn, request: Request, u: A.User = Depends(need("admin"))):
    bad = [k for k in body.kinds if k not in WEBHOOK_KINDS]
    if bad or not body.url.startswith(("http://", "https://")):
        raise HTTPException(400, f"unknown kinds {bad}" if bad else "url must be http(s)")
    with SessionLocal() as s:
        w = Webhook(name=body.name.strip()[:100], url=body.url.strip(), secret=body.secret or secrets.token_hex(16), kinds=body.kinds,
                    departments=body.departments, created_by=u.username)
        s.add(w)
        audit(s, u.username, "webhook_create", w.name, body.url, _ip(request))
        s.commit()
        return {**_hook_dict(w), "secret": w.secret}


@router.post("/api/admin/webhooks/{wid}/test")
def test_hook(wid: str, u: A.User = Depends(need("admin"))):
    from ..notify import _webhooks
    with SessionLocal() as s:
        w = s.get(Webhook, wid)
        if not w:
            raise HTTPException(404)
        kind = (w.kinds or ["alert"])[0]
    _webhooks(kind, {"id": "test", "test": True, "department": "*", "ts": utcnow().isoformat(), "plate": "TEST0000",
                     "camera_id": "test-cam", "reason": "webhook test from the Unified CCTV platform", "priority": "low"})
    with SessionLocal() as s:
        return _hook_dict(s.get(Webhook, wid))


@router.patch("/api/admin/webhooks/{wid}")
def toggle_hook(wid: str, active: bool, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        w = s.get(Webhook, wid)
        if not w:
            raise HTTPException(404)
        w.active, w.failures = active, 0
        audit(s, u.username, "webhook_toggle", w.name, str(active), _ip(request))
        s.commit()
        return _hook_dict(w)


@router.delete("/api/admin/webhooks/{wid}")
def delete_hook(wid: str, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        w = s.get(Webhook, wid)
        if w:
            s.delete(w)
            audit(s, u.username, "webhook_delete", w.name, ip=_ip(request))
            s.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- notifications log + channels
@router.get("/api/admin/notifications")
def notifications(limit: int = 200, u: A.User = Depends(need("admin"))):
    from ..notify import ROUTE_KINDS, cfg, routes_for_console
    c = cfg()
    with SessionLocal() as s:
        rows = s.scalars(select(Notification).order_by(Notification.ts.desc()).limit(min(limit, 1000))).all()
        routes = routes_for_console(s)
    return {"channels": [{"name": n, "type": ch.get("type"), "enabled": ch.get("enabled", True), "configured": bool(ch.get("url") or ch.get("host")) and
                          (ch.get("type") not in ("voice",) or bool(ch.get("username")))} for n, ch in (c.get("channels") or {}).items()],
            "routes": routes, "routes_source": c.get("routes_source", "yaml"), "kinds": ROUTE_KINDS,
            "log": [{"ts": n.ts.isoformat(), "channel": n.channel, "recipient": n.recipient, "kind": n.kind, "subject": n.subject,
                     "status": n.status, "detail": n.detail[:200], "attempts": n.attempts} for n in rows]}


class RoutesBody(BaseModel):
    routes: list[dict]


@router.put("/api/admin/notifications/routes")
def save_routes(body: RoutesBody, request: Request, u: A.User = Depends(need("admin"))):
    """Replace the notification routing table (who is called / messaged for which event). Credentials stay in
    config/notify.yaml + .env; this only changes recipients, filters and which channel each event goes to."""
    from ..notify import save_routes_for_console
    with SessionLocal() as s:
        try:
            routes = save_routes_for_console(s, body.routes, u.username)
        except ValueError as e:
            raise HTTPException(400, str(e))
        audit(s, u.username, "notify_routes", "", f"{len(routes)} route(s): " + "; ".join(f"{r['kind']}->{r['channel']} {','.join(r['to'])}" for r in routes)[:900], _ip(request))
        s.commit()
    return {"routes": routes, "routes_source": "console"}


@router.delete("/api/admin/notifications/routes")
def reset_routes(request: Request, u: A.User = Depends(need("admin"))):
    """Forget the console routing table and go back to config/notify.yaml."""
    from ..db import Setting
    with SessionLocal() as s:
        row = s.get(Setting, "notify_routes")
        if row is not None:
            s.delete(row)
        audit(s, u.username, "notify_routes_reset", "", "", _ip(request))
        s.commit()
    return {"ok": True}


class ChannelBody(BaseModel):
    enabled: bool


@router.patch("/api/admin/notifications/channels/{name}")
def toggle_channel(name: str, body: ChannelBody, request: Request, u: A.User = Depends(need("admin"))):
    from ..db import get_setting, set_setting
    from ..notify import yaml_cfg
    if name not in (yaml_cfg().get("channels") or {}):
        raise HTTPException(404, "unknown channel (channels are defined in config/notify.yaml)")
    with SessionLocal() as s:
        ov = dict(get_setting(s, "notify_channels", {}))
        ov[name] = {"enabled": body.enabled}
        set_setting(s, "notify_channels", ov, u.username)
        audit(s, u.username, "notify_channel", name, "on" if body.enabled else "off", _ip(request))
        s.commit()
    return {"name": name, "enabled": body.enabled}


@router.post("/api/integrations/voice/callback")
async def voice_callback(request: Request, key: str = ""):
    """Result webhook of the voice-call dialer (BulkOBD). Register
    `https://<server>/api/integrations/voice/callback?key=<VOICE_CALLBACK_KEY>` with the provider; it POSTs
    number / dialstatus / response / duration / campid after every call attempt (JSON or form)."""
    from ..notify import voice_callback as _cb
    if not settings.voice_callback_key or key != settings.voice_callback_key:
        raise HTTPException(403, "bad key")
    ctype = request.headers.get("content-type", "")
    if "json" in ctype:
        data = await request.json()
    else:
        form = await request.form()
        data = dict(form)
        if not data:
            try:
                data = await request.json()
            except Exception:  # noqa: BLE001
                data = {}
    return _cb(data if isinstance(data, dict) else {})


@router.post("/api/admin/notifications/test")
def notifications_test(channel: str, to: str = "", u: A.User = Depends(need("admin"))):
    from ..notify import _deliver, cfg
    ch = (cfg().get("channels") or {}).get(channel)
    if not ch:
        raise HTTPException(404, "unknown channel")
    _deliver(ch, channel, to, "test", {"id": "test", "department": "*", "ts": utcnow().isoformat()},
             "[CCTV] test notification", f"Sent by {u.username} from the Unified CCTV platform.")
    with SessionLocal() as s:
        n = s.scalar(select(Notification).order_by(Notification.ts.desc()).limit(1))
        return {"status": n.status, "detail": n.detail}


# ----------------------------------------------------------------------------- camera health SLA + quality
@router.get("/api/health/sla")
def sla(days: int = 7, u: A.User = Depends(need("sources"))):
    """Per-camera uptime over the window from status transitions, plus latest quality verdict."""
    since = utcnow() - dt.timedelta(days=days)
    now = utcnow()
    with SessionLocal() as s:
        cams = [c for c in s.scalars(select(Camera)) if u.sees_camera(c.id, c.department)]
        logs: dict[str, list[CameraStatusLog]] = {}
        for r in s.scalars(select(CameraStatusLog).where(CameraStatusLog.ts >= since - dt.timedelta(days=1)).order_by(CameraStatusLog.ts)):
            logs.setdefault(r.camera_id, []).append(r)
        quality = {}
        for q in s.scalars(select(CameraQuality).order_by(CameraQuality.ts.desc()).limit(5000)):
            quality.setdefault(q.camera_id, q)
        out = []
        for c in cams:
            rows = logs.get(c.id, [])
            # state at window start = last transition before `since`, else current status
            state = next((r.status for r in reversed(rows) if r.ts < since), c.status)
            t = since
            up = down = 0.0
            outages = 0
            longest = 0.0
            for r in [r for r in rows if r.ts >= since] + [None]:
                end = r.ts if r else now
                span = max(0.0, (end - t).total_seconds())
                if state == "offline":
                    down += span
                    longest = max(longest, span)
                else:
                    up += span
                if r:
                    if r.status == "offline" and state != "offline":
                        outages += 1
                    state, t = r.status, r.ts
            total = up + down or 1.0
            q = quality.get(c.id)
            out.append({"camera_id": c.id, "name": c.name, "department": c.department, "status": c.status,
                        "uptime_pct": round(100 * up / total, 2), "outages": outages, "downtime_min": round(down / 60),
                        "longest_outage_min": round(longest / 60), "sla_met": (100 * up / total) >= 99.0,
                        "quality": {"verdict": q.verdict, "sharpness": round(q.sharpness), "brightness": round(q.brightness),
                                    "ts": q.ts.isoformat()} if q else None})
        fleet = round(sum(o["uptime_pct"] for o in out) / len(out), 2) if out else 0
        return {"days": days, "fleet_uptime_pct": fleet, "cameras": sorted(out, key=lambda o: o["uptime_pct"])}


@router.get("/api/health/quality/{cam_id}")
def quality_history(cam_id: str, hours: int = 24, u: A.User = Depends(need("sources"))):
    with SessionLocal() as s:
        cam = s.get(Camera, cam_id)
        if not cam or not u.sees_camera(cam.id, cam.department):
            raise HTTPException(404)
        rows = s.scalars(select(CameraQuality).where(CameraQuality.camera_id == cam_id, CameraQuality.ts >= utcnow() - dt.timedelta(hours=hours))
                         .order_by(CameraQuality.ts)).all()
    return [{"ts": q.ts.isoformat(), "sharpness": round(q.sharpness, 1), "brightness": round(q.brightness, 1), "frozen": q.frozen,
             "tampered": q.tampered, "verdict": q.verdict} for q in rows]


@router.post("/internal/quality", dependencies=[Depends(internal)])
def internal_quality(body: dict):
    """Analytics worker posts one sample per camera; degradations raise camera.health events."""
    from .api import broadcast
    with SessionLocal() as s:
        cam = s.get(Camera, body["camera_id"])
        if not cam:
            raise HTTPException(404)
        prev = s.scalar(select(CameraQuality).where(CameraQuality.camera_id == cam.id).order_by(CameraQuality.ts.desc()).limit(1))
        q = CameraQuality(camera_id=cam.id, sharpness=float(body.get("sharpness", 0)), brightness=float(body.get("brightness", 0)),
                          frozen=bool(body.get("frozen")), tampered=bool(body.get("tampered")), verdict=body.get("verdict", "ok"))
        s.add(q)
        s.commit()
        changed = (prev.verdict if prev else "ok") != q.verdict
        dept = cam.department
    if changed and q.verdict != "ok":
        broadcast("camera.health", {"id": f"quality:{cam.id}:{int(time.time())}", "camera_id": cam.id, "department": dept,
                                    "status": q.verdict, "detail": f"image quality: {q.verdict} (sharpness {q.sharpness:.0f}, brightness {q.brightness:.0f})",
                                    "ts": utcnow().isoformat(), "priority": "medium"})
        _ticket(cam.id, dept, f"Image quality {q.verdict}", f"sharpness {q.sharpness:.0f}, brightness {q.brightness:.0f}")
    return {"ok": True, "changed": changed}


@router.post("/internal/camera-health", dependencies=[Depends(internal)])
def internal_camera_health(body: dict):
    from .api import broadcast
    broadcast("camera.health", {"id": f"health:{body['camera_id']}:{int(time.time())}", **body,
                                "priority": "high" if body.get("status") == "offline" else "low"})
    return {"ok": True}


def _ticket(camera_id: str, department: str, summary: str, detail: str) -> None:
    """Open a ticket in the vendor's helpdesk (generic JSON; map fields in the receiving system)."""
    if not settings.ticket_webhook_url:
        return
    body = json.dumps({"summary": f"[CCTV] {camera_id}: {summary}", "description": detail, "camera_id": camera_id,
                       "department": department, "priority": "P3", "source": "unified-cctv", "ts": utcnow().isoformat()}).encode()
    headers = {"Content-Type": "application/json"}
    if settings.ticket_webhook_secret:
        import hmac
        headers["X-UVP-Signature"] = hmac.new(settings.ticket_webhook_secret.encode(), body, hashlib.sha256).hexdigest()
    try:
        requests.post(settings.ticket_webhook_url, data=body, headers=headers, timeout=10)
    except requests.RequestException as e:
        log.warning("ticket webhook failed: %s", e)


# ----------------------------------------------------------------------------- capacity per department
@router.get("/api/capacity")
def capacity(u: A.User = Depends(need("sources"))):
    """What each department consumes: cameras, ANPR channels, pulls vs cap, events/h, archive size and growth."""
    from ..db import AnprEvent, Recording, Source
    from ..relay import relay
    from .api import _is_departmental_pull, _safe_live_paths
    since = utcnow() - dt.timedelta(hours=24)
    live = _safe_live_paths()
    with SessionLocal() as s:
        cams = [c for c in s.scalars(select(Camera)) if u.sees(c.department)]
        srcs = {x.id: x for x in s.scalars(select(Source))}
        ev24 = dict(s.execute(select(AnprEvent.department, func.count()).where(AnprEvent.ts >= since).group_by(AnprEvent.department)).all())
        rec = {d: (n, b) for d, n, b in s.execute(select(Recording.department, func.count(), func.coalesce(func.sum(Recording.bytes), 0)).group_by(Recording.department)).all()}
        rec24 = dict(s.execute(select(Recording.department, func.coalesce(func.sum(Recording.bytes), 0)).where(Recording.archived_at >= since).group_by(Recording.department)).all())
    out: dict[str, dict] = {}
    for c in cams:
        d = out.setdefault(c.department, {"department": c.department, "cameras": 0, "online": 0, "anpr_channels": 0, "recorded": 0,
                                           "pulls": 0, "pull_cap": 0, "viewers": 0, "events_24h": int(ev24.get(c.department, 0)),
                                           "archive_gb": round(rec.get(c.department, (0, 0))[1] / 1e9, 2),
                                           "archive_gb_per_day": round(rec24.get(c.department, 0) / 1e9, 2), "relays": {}})
        d["cameras"] += 1
        d["online"] += c.status in ("online", "live")
        d["anpr_channels"] += bool(c.anpr_enabled)
        d["relays"][c.relay or "relay"] = d["relays"].get(c.relay or "relay", 0) + 1
        src = srcs.get(c.source_id)
        if src and src.id not in d.setdefault("_srcs", set()):
            d["_srcs"].add(src.id)
            d["pull_cap"] += src.max_concurrent_pulls
    dept_of = {c.id: c.department for c in cams}
    for p in live:
        dep = dept_of.get(p["name"].split("/")[0])
        if dep in out:
            if _is_departmental_pull(p):
                out[dep]["pulls"] += 1
            out[dep]["viewers"] += len(p.get("readers", []))
    for d in out.values():
        d.pop("_srcs", None)
        d["recorded"] = {"anpr": d["anpr_channels"], "all": d["cameras"]}.get(settings.record_mode, 0)
        d["storage_estimate_gb_per_day"] = round(d["recorded"] * 24 * 1.0, 1)      # ~1 GB per camera-hour at 1080p H.264
    return {"relays": {n: {"healthy": r.healthy, "public_host": r.public_host} for n, r in relay.relays.items()},
            "record_mode": settings.record_mode, "departments": sorted(out.values(), key=lambda x: x["department"])}


# ----------------------------------------------------------------------------- Vahan lookup
_vahan_cache: dict[str, tuple[float, dict]] = {}


@router.get("/api/vehicles/{plate}/registration")
def registration(plate: str, request: Request, u: A.User = Depends(need("plate_search"))):
    """Registration details from the state Vahan connector (VAHAN_URL with {plate}); cached 1 h; audited."""
    p = normalise(plate)
    if not settings.vahan_url:
        raise HTTPException(501, "Vahan connector not configured (VAHAN_URL)")
    hit = _vahan_cache.get(p)
    if hit and time.time() - hit[0] < 3600:
        data = hit[1]
    else:
        headers = json.loads(settings.vahan_headers) if settings.vahan_headers else {}
        try:
            r = requests.get(settings.vahan_url.format(plate=p), headers=headers, timeout=15)
            r.raise_for_status()
            data = r.json()
        except requests.RequestException as e:
            raise HTTPException(502, f"Vahan lookup failed: {e}")
        _vahan_cache[p] = (time.time(), data)
    with SessionLocal() as s:
        audit(s, u.username, "vahan_lookup", p, "", _ip(request))
        s.commit()
    return {"plate": p, "registration": data}


# ----------------------------------------------------------------------------- licence + version
@router.get("/api/version")
def version():
    return {"version": settings.version, "product": "Unified CCTV by Allatone", "vendor": "Allatone"}


@router.get("/api/license")
def license_status(u: A.User = Depends(current_user)):
    from .. import licensing
    lic = licensing.load()
    use = licensing.usage()
    return {"customer": lic.get("customer"), "tenant": lic.get("tenant"), "mode": lic["mode"], "status": lic["status"],
            "expires": lic.get("expires"), "issued": lic.get("issued"), "features": lic.get("features"),
            "limits": {k: lic.get(k) for k in ("cameras", "anpr_channels", "analytics_channels")}, "usage": use,
            "over_limit": {k: use.get(k if k != "cameras" else "cameras_total", 0) > (lic.get(k) or 10**9) for k in ("cameras", "anpr_channels", "analytics_channels")},
            "version": settings.version}


@router.post("/api/license/report")
def license_report(u: A.User = Depends(need("admin"))):
    from .. import licensing
    body = licensing.report_usage()
    return {"sent": body is not None, "report": body}


# ----------------------------------------------------------------------------- tenants + vendors
@router.get("/api/tenants")
def list_tenants(u: A.User = Depends(current_user)):
    ts = tenants()
    if u.tenant and "*" not in (ts.get(u.tenant) or {}).get("departments", []):
        return {"current": branding(u.tenant), "tenants": [branding(u.tenant)]}
    return {"current": branding(u.tenant) if u.tenant else {}, "tenants": [branding(t) for t in ts]}


@router.get("/api/admin/vendors")
def vendors(u: A.User = Depends(need("admin"))):
    from ..adapters.registry import presets
    return {name: {k: v for k, v in p.items()} for name, p in presets().items()}
