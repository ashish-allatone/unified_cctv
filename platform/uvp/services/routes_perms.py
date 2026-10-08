"""Admin -> Permissions: the camera permission table (who may do what on which cameras) and its history.

  GET    /api/permissions?scope=&grantee_kind=&status=active|history&q=   rows (+ camera / user display names)
  GET    /api/permissions/options                                          cameras, departments, users, roles, perms (for the Grant dialog)
  POST   /api/permissions          {scope_kind, scope_value, grantee_kind, grantee, perms[], expires_at?, reason?}
  PATCH  /api/permissions/{id}     {perms?, expires_at?, reason?}
  DELETE /api/permissions/{id}     revoke (row kept for History)
  GET    /api/permissions/mine     the signed-in account's effective camera permissions (for the console)

Rows apply immediately to every signed-in session (tokens carry a permissions version); each change is audited
(perm_grant / perm_update / perm_revoke) and raises a security notification.
"""
from __future__ import annotations

import datetime as dt
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import auth as A
from .. import camperms, corridors, inbox, rbac
from ..db import Camera, CameraPermission, Route, SessionLocal, Users, audit, utcnow
from .deps import _ip, _parse_time, current_user, need

log = logging.getLogger("uvp.perms")
router = APIRouter()


class PermIn(BaseModel):
    scope_kind: str = "camera"           # camera | department | route | all
    scope_value: str = "*"
    scopes: list[dict] | None = None     # several at once: [{scope_kind, scope_value}, ...] -> one row each
    grantee_kind: str = "user"           # user | role
    grantee: str
    perms: list[str] = []
    expires_at: str | None = None
    reason: str = ""


class PermPatch(BaseModel):
    perms: list[str] | None = None
    expires_at: str | None = None        # "" clears
    reason: str | None = None


def _names(s) -> dict[str, str]:
    d = {c.id: c.name for c in s.scalars(select(Camera))}
    d.update({r.id: f"Route: {r.name}" for r in s.scalars(select(Route))})
    return d


def _notify(s, action: str, r: CameraPermission, actor: str, names: dict | None = None) -> None:
    who = f"{'role' if r.grantee_kind == 'role' else 'user'} {r.grantee}"
    where = "all cameras" if r.scope_kind == "all" else f"{r.scope_kind} {names.get(r.scope_value, r.scope_value) if names else r.scope_value}"
    inbox.push("security", f"Camera permission {action}", f"{actor}: {who} — {', '.join(r.perms or []) or 'none'} on {where}",
               severity="info", ref_id=r.id, link="admin", feature="admin", session=s)


def _validate(body: PermIn, s) -> None:
    if body.scope_kind not in camperms.SCOPES:
        raise HTTPException(400, "scope_kind must be camera | department | route | all")
    if body.grantee_kind not in ("user", "role"):
        raise HTTPException(400, "grantee_kind must be user | role")
    if not body.grantee.strip():
        raise HTTPException(400, "choose a user or a role")
    bad = [p for p in body.perms if p not in camperms.PERMS]
    if bad:
        raise HTTPException(400, f"unknown permission(s) {bad}; one of {camperms.PERMS}")
    if not body.perms:
        raise HTTPException(400, "tick at least one permission")
    if body.scope_kind == "camera" and s.get(Camera, body.scope_value) is None:
        raise HTTPException(404, f"camera {body.scope_value!r} not found")
    if body.scope_kind == "route" and s.get(Route, body.scope_value) is None:
        raise HTTPException(404, f"route {body.scope_value!r} not found")
    if body.scope_kind == "department" and not body.scope_value.strip():
        raise HTTPException(400, "department required")
    if body.grantee_kind == "role" and not rbac.is_role(body.grantee):
        raise HTTPException(404, f"role {body.grantee!r} not found")
    if body.grantee_kind == "user" and s.get(Users, body.grantee.strip()) is None:
        try:
            ok = body.grantee.strip() in A._users()           # demo accounts in config/users.yaml
        except Exception:  # noqa: BLE001
            ok = False
        if not ok:
            raise HTTPException(404, f"user {body.grantee!r} not found")


def _expiry(v: str | None) -> dt.datetime | None:
    if v in (None, ""):
        return None
    t = _parse_time(v)
    if not t:
        raise HTTPException(400, "expires_at must be an ISO time")
    if t <= utcnow():
        raise HTTPException(400, "expiry is in the past")
    return t


@router.get("/api/permissions/options")
def perm_options(u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        cams = [{"id": c.id, "name": c.name, "department": c.department} for c in s.scalars(select(Camera).order_by(Camera.department, Camera.name))]
        users = [{"username": r.username, "role": r.role} for r in s.scalars(select(Users).order_by(Users.username)) if r.provider == "db" and r.is_active]
        routes = [{"id": r.id, "name": r.name, "priority": r.priority, "camera_count": len(corridors.cameras_for(s, r))} for r in s.scalars(select(Route).order_by(Route.priority.desc(), Route.name))]
    depts = sorted({c["department"] for c in cams if c["department"]})
    roles = [{"name": n, "description": r.get("description", "")} for n, r in rbac.roles().items()]
    return {"cameras": cams, "departments": depts, "routes": routes, "users": users, "roles": roles,
            "perms": [{"id": p, "label": camperms.PERM_LABELS[p], "help": camperms.PERM_HELP[p]} for p in camperms.PERMS]}


@router.get("/api/permissions")
def list_perms(scope: str = "", grantee_kind: str = "", status: str = "active", q: str = "", u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        rows = s.scalars(select(CameraPermission).order_by(CameraPermission.created_at.desc())).all()
        names = _names(s)
    out = []
    ql = q.strip().lower()
    for r in rows:
        d = camperms.row_dict(r, names)
        if status == "active" and d["status"] != "active":
            continue
        if status == "history" and d["status"] == "active":
            continue
        if scope and not (scope == d["scope_kind"] or scope == d["scope_value"] or scope == f"{d['scope_kind']}:{d['scope_value']}"):
            continue
        if grantee_kind and d["grantee_kind"] != grantee_kind:
            continue
        if ql and ql not in f"{d['grantee']} {d['scope_label']} {d['scope_value']} {d['reason']}".lower():
            continue
        out.append(d)
    return {"items": out, "total": len(out), "perms": camperms.PERMS, "labels": camperms.PERM_LABELS}


def _grant_one(s, body: PermIn, u, request, names) -> tuple[CameraPermission, str]:
    exp = _expiry(body.expires_at)
    value = "*" if body.scope_kind == "all" else body.scope_value.strip()
    # one live row per (scope, grantee): granting again replaces the permission set
    live = s.scalars(select(CameraPermission).where(CameraPermission.revoked_at.is_(None), CameraPermission.scope_kind == body.scope_kind,
                                                    CameraPermission.scope_value == value, CameraPermission.grantee_kind == body.grantee_kind,
                                                    CameraPermission.grantee == body.grantee.strip())).all()
    dup = next((r for r in live if camperms.is_live(r)), None)
    if dup:
        dup.perms = [p for p in camperms.PERMS if p in body.perms]
        dup.expires_at, dup.reason = exp, (body.reason or dup.reason)[:300]
        dup.updated_at, dup.updated_by = utcnow(), u.username
        r, action = dup, "perm_update"
    else:
        r = CameraPermission(scope_kind=body.scope_kind, scope_value=value, grantee_kind=body.grantee_kind, grantee=body.grantee.strip(),
                             perms=[p for p in camperms.PERMS if p in body.perms], reason=body.reason[:300], granted_by=u.username, expires_at=exp)
        s.add(r)
        s.flush()
        action = "perm_grant"
    audit(s, u.username, action, r.id, f"{r.grantee_kind}:{r.grantee} {','.join(r.perms)} on {r.scope_kind}:{r.scope_value}"
          + (f" until {exp.isoformat()}" if exp else ""), _ip(request))
    return r, action


@router.post("/api/permissions", status_code=201)
def grant_perm(body: PermIn, request: Request, u: A.User = Depends(need("admin"))):
    """One scope, or several at once (`scopes`: cameras, departments, VIP routes - one row each).
    Returns the single row, or {items: [...], count} for several."""
    with SessionLocal() as s:
        scopes = body.scopes if body.scopes else [{"scope_kind": body.scope_kind, "scope_value": body.scope_value}]
        if len(scopes) > 200:
            raise HTTPException(400, "at most 200 scopes at once")
        if any(sc.get("scope_kind") == "all" for sc in scopes):
            scopes = [{"scope_kind": "all", "scope_value": "*"}]           # 'all cameras' makes the rest redundant
        bodies = []
        for sc in scopes:
            b = body.model_copy(update={"scope_kind": str(sc.get("scope_kind") or "camera"), "scope_value": str(sc.get("scope_value") or "*"), "scopes": None})
            _validate(b, s)
            bodies.append(b)
        names = _names(s)
        rows = [_grant_one(s, b, u, request, names) for b in bodies]
        camperms.bump(s, u.username)
        for r, action in rows:
            _notify(s, "granted" if action == "perm_grant" else "changed", r, u.username, names)
        s.commit()
        out = [camperms.row_dict(r, names) for r, _ in rows]
        return out[0] if not body.scopes else {"items": out, "count": len(out)}


@router.patch("/api/permissions/{pid}")
def update_perm(pid: str, body: PermPatch, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        r = s.get(CameraPermission, pid)
        if not r or r.revoked_at is not None:
            raise HTTPException(404, "permission not found")
        if body.perms is not None:
            bad = [p for p in body.perms if p not in camperms.PERMS]
            if bad or not body.perms:
                raise HTTPException(400, f"permissions must be a non-empty subset of {camperms.PERMS}")
            r.perms = [p for p in camperms.PERMS if p in body.perms]
        if body.expires_at is not None:
            r.expires_at = _expiry(body.expires_at)
        if body.reason is not None:
            r.reason = body.reason[:300]
        r.updated_at, r.updated_by = utcnow(), u.username
        audit(s, u.username, "perm_update", r.id, f"{r.grantee_kind}:{r.grantee} {','.join(r.perms)} on {r.scope_kind}:{r.scope_value}", _ip(request))
        camperms.bump(s, u.username)
        names = _names(s)
        _notify(s, "changed", r, u.username, names)
        s.commit()
        return camperms.row_dict(r, names)


@router.delete("/api/permissions/{pid}")
def revoke_perm(pid: str, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        r = s.get(CameraPermission, pid)
        if not r:
            raise HTTPException(404, "permission not found")
        if r.revoked_at is None:
            r.revoked_at, r.revoked_by = utcnow(), u.username
            audit(s, u.username, "perm_revoke", r.id, f"{r.grantee_kind}:{r.grantee} on {r.scope_kind}:{r.scope_value}", _ip(request))
            camperms.bump(s, u.username)
            _notify(s, "revoked", r, u.username, _names(s))
            s.commit()
        return {"ok": True, "id": r.id}


@router.get("/api/permissions/mine")
def my_perms(u: A.User = Depends(current_user)):
    """The signed-in account's camera permissions: {camera_id: [perms]} for every camera it sees (the console hides
    Playback / Export / Edit buttons it may not use)."""
    with SessionLocal() as s:
        cams = [c for c in s.scalars(select(Camera)) if u.sees_camera(c.id, c.department)]
    return {"cameras": {c.id: [p for p in camperms.PERMS if u.allows(c.id, c.department, p)] for c in cams},
            "rows": u.camera_perms, "perms": camperms.PERMS}
