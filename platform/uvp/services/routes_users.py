"""Console accounts and two-factor setup.

  GET    /api/auth/setup            is first-run signup still open? (public)
  POST   /api/auth/signup           create the FIRST account only (becomes super admin) -> session token
  GET    /api/users                 accounts + 2FA / lockout state (admin)
  POST   /api/users                 create an account (super admin)
  PATCH  /api/users/{username}      role / departments / cameras / active / password / super (super admin)
  DELETE /api/users/{username}      remove an account and its MFA state (super admin)
  GET    /api/auth/mfa/status       my 2FA state
  POST   /api/auth/mfa/disable      turn my 2FA off (needs a current code; refused when my role requires 2FA)

Login itself stays in api.py: password -> if the account has 2FA enrolled (or its role requires it) a 5-minute
challenge token (purpose "mfa", not usable as a session) -> /api/auth/mfa/verify -> session JWT; otherwise the
session JWT directly. Enrolment: /api/auth/mfa/enrol (QR + secret) -> /api/auth/mfa/confirm (first code) -> backup codes.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import auth as A
from ..db import AccessGrant, SessionLocal, Users, audit, utcnow
from ..inbox import push
from .deps import _ip, current_user, need

log = logging.getLogger("uvp.users")
router = APIRouter()


class SignupIn(BaseModel):
    username: str
    password: str


class UserIn(BaseModel):
    username: str
    password: str
    role: str = "viewer"
    departments: list[str] = ["*"]
    cameras: list[str] = []
    is_super: bool = False
    tenant: str = ""


class UserPatch(BaseModel):
    role: str | None = None
    departments: list[str] | None = None
    cameras: list[str] | None = None
    is_active: bool | None = None
    is_super: bool | None = None
    password: str | None = None


class CodeIn(BaseModel):
    code: str


def need_super(u: A.User = Depends(current_user)) -> A.User:
    """Super admin: the account created at signup, or one later marked is_super by another super admin."""
    if not u.is_super:
        raise HTTPException(403, "super admin only")
    with SessionLocal() as s:                       # the flag is re-checked against the database, not only the token
        row = A.db_user_row(s, u.username)
        if row is None or not row.is_active or not row.is_super:
            raise HTTPException(403, "super admin only")
    return u


def _session(s, u: A.User, request: Request) -> dict:
    from .api import _session_response
    return _session_response(s, u, request)


def _mfa_state(row: Users | None) -> str:
    return row.mfa_state if row is not None else "off"


# ----------------------------------------------------------------------------- first-run signup
@router.get("/api/auth/setup")
def setup_status():
    with SessionLocal() as s:
        exists = A.db_users_exist(s)
        return {"needs_setup": not exists, "yaml_users": A.yaml_users_active(s),
                "password_rules": f"at least {A.MIN_PASSWORD_LEN} characters, one uppercase letter, one digit"}


@router.post("/api/auth/signup")
def signup(body: SignupIn, request: Request):
    """Only while the users table is empty. The account becomes the super admin; afterwards this endpoint is closed
    and only a super admin can add accounts (POST /api/users)."""
    with SessionLocal() as s:
        if A.db_users_exist(s):
            audit(s, body.username.strip().lower()[:64], "signup_refused", "accounts already exist", ip=_ip(request))
            s.commit()
            raise HTTPException(409, "sign-up is closed: an administrator already exists. Ask a super admin to create your account.")
        try:
            row = A.create_account(s, body.username, body.password, "admin", ["*"], is_super=True, created_by="signup")
        except A.AccountError as e:
            raise HTTPException(400, str(e))
        u = A.User(row.username, "admin", ["*"], provider="db", is_super=True)
        A.note_login(s, u.username, True)
        audit(s, u.username, "signup_super_admin", ip=_ip(request))
        out = _session(s, u, request)
        out["mfa_setup_recommended"] = True
        s.commit()
        log.warning("first account created: %s is the super admin; users.yaml demo accounts are now disabled", u.username)
        return out


# ----------------------------------------------------------------------------- account management
def _row_out(r: Users, grants: int) -> dict:
    return {"username": r.username, "provider": r.provider, "role": r.role, "departments": list(r.departments or []),
            "cameras": list(r.cameras or []), "is_super": bool(r.is_super), "is_active": bool(r.is_active),
            "tenant": r.tenant or "", "created_by": r.created_by, "created_at": r.created_at.isoformat() if r.created_at else None,
            "mfa": r.mfa_state, "mfa_enrolled": r.mfa_enrolled, "mfa_required": A.mfa_required_for(r.role),
            "backup_codes_left": len(r.backup_codes or []),
            "locked_until": r.locked_until.isoformat() if r.locked_until else None,
            "last_login": r.last_login.isoformat() if r.last_login else None, "active_grants": grants}


@router.get("/api/users")
def list_accounts(u: A.User = Depends(need("admin")), all: bool = False):
    """Password accounts (provider db). ?all=1 also lists the directory / demo rows that hold 2FA + lockout state."""
    with SessionLocal() as s:
        rows = s.scalars(select(Users).order_by(Users.username)).all()
        yaml_on = A.yaml_users_active(s)
        grants: dict[str, int] = {}
        for g in s.scalars(select(AccessGrant).where(AccessGrant.revoked_at.is_(None))):
            if g.expires_at is None or g.expires_at > utcnow():
                grants[g.username] = grants.get(g.username, 0) + 1
        return [_row_out(r, grants.get(r.username, 0)) for r in rows
                if r.provider == "db" or (all and (yaml_on or r.provider != "users.yaml"))]


@router.post("/api/users", status_code=201)
def create_account(body: UserIn, request: Request, u: A.User = Depends(need_super)):
    with SessionLocal() as s:
        try:
            row = A.create_account(s, body.username, body.password, body.role, body.departments, body.cameras,
                                   is_super=body.is_super, created_by=u.username, tenant=body.tenant)
        except A.AccountError as e:
            raise HTTPException(400, str(e))
        audit(s, u.username, "user_create", row.username, f"role={row.role} super={row.is_super} depts={row.departments}", _ip(request))
        push("security", f"Account {row.username} created ({row.role})", f"departments {', '.join(row.departments)} · by {u.username}", ref_id=row.username,
             link="admin", feature="admin", session=s)
        s.commit()
        return _row_out(row, 0)


@router.patch("/api/users/{username}")
def patch_account(username: str, body: UserPatch, request: Request, u: A.User = Depends(need_super)):
    with SessionLocal() as s:
        try:
            row = A.update_account(s, username, role=body.role, departments=body.departments, cameras=body.cameras,
                                   is_active=body.is_active, is_super=body.is_super, password=body.password, actor=u.username)
        except A.AccountError as e:
            raise HTTPException(400, str(e))
        changed = [k for k, v in body.model_dump().items() if v is not None]
        audit(s, u.username, "user_update", row.username, ", ".join("password" if c == "password" else f"{c}={getattr(row, c)}" for c in changed), _ip(request))
        if any(c in ("role", "is_super", "is_active") for c in changed):
            push("security", f"Account {row.username} changed", ", ".join(f"{c}={getattr(row, c)}" for c in changed if c != "password") + f" · by {u.username}",
                 severity="warn", ref_id=row.username, link="admin", feature="admin", session=s)
        if body.is_active is False:
            A.note_login(s, row.username, True)          # clear any lockout so the state is unambiguous
        s.commit()
        return _row_out(row, 0)


@router.delete("/api/users/{username}")
def delete_account(username: str, request: Request, u: A.User = Depends(need_super)):
    with SessionLocal() as s:
        try:
            A.delete_account(s, username, actor=u.username)
        except A.AccountError as e:
            raise HTTPException(400, str(e))
        audit(s, u.username, "user_delete", username.strip().lower(), ip=_ip(request))
        push("security", f"Account {username.strip().lower()} removed", f"by {u.username}", severity="warn", ref_id=username.strip().lower(), link="admin", feature="admin", session=s)
        s.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- my 2FA
@router.get("/api/auth/mfa/status")
def mfa_status(u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        row = s.get(Users, u.username)
        return {"state": _mfa_state(row), "required": A.mfa_required_for(u.role), "session_mfa": u.mfa,
                "backup_codes_left": len((row.backup_codes or []) if row else [])}


@router.post("/api/auth/mfa/disable")
def mfa_disable(body: CodeIn, request: Request, u: A.User = Depends(current_user)):
    """Turn off my own 2FA. Requires a current code (proves possession of the device) and is refused when the
    role must have 2FA. An admin can always clear a lost device with POST /api/auth/mfa/reset/{username}."""
    if A.mfa_required_for(u.role):
        raise HTTPException(403, "two-factor sign-in is required for your role and cannot be turned off")
    with SessionLocal() as s:
        if not A.mfa_verify(s, u.username, body.code):
            audit(s, u.username, "mfa_disable_failed", ip=_ip(request))
            s.commit()
            raise HTTPException(401, "wrong code")
        A.mfa_reset(s, u.username)
        audit(s, u.username, "mfa_disabled", ip=_ip(request))
        u.mfa = False
        out = _session(s, u, request)
        s.commit()
        return out
