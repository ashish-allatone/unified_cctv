"""FastAPI dependencies shared by the API and its routers."""
from __future__ import annotations

import datetime as dt

from fastapi import Depends, Header, HTTPException, Query, Request

from .. import auth as A
from .. import rbac
from ..config import settings


def current_user(authorization: str = Header(default=""), token: str = Query(default=""),
                 x_api_key: str = Header(default="")) -> A.User:
    """Session JWT (Authorization: Bearer / ?token=) or a machine API key (X-API-Key)."""
    if x_api_key:
        u = api_key_user(x_api_key)
        if not u:
            raise HTTPException(401, "invalid or expired API key")
        return u
    tok = authorization[7:] if authorization.startswith("Bearer ") else token
    u = A.verify_token(tok) if tok else None
    if not u:
        raise HTTPException(401, "login required")
    return u


def api_key_user(key: str) -> A.User | None:
    import hashlib
    import datetime as _dt
    from sqlalchemy import select
    from ..db import ApiKey, SessionLocal
    h = hashlib.sha256(key.encode()).hexdigest()
    with SessionLocal() as s:
        k = s.scalar(select(ApiKey).where(ApiKey.key_hash == h))
        if not k or k.revoked_at or (k.expires_at and k.expires_at < _dt.datetime.now(_dt.timezone.utc)):
            return None
        k.last_used = _dt.datetime.now(_dt.timezone.utc)
        s.commit()
        return A.User(f"apikey:{k.name}", "api", list(k.departments or ["*"]), features=list(k.features or []), provider="apikey")


def need(feature: str):
    """Route guard on an effective feature (see uvp.rbac). Old role names still work."""
    def dep(u: A.User = Depends(current_user)) -> A.User:
        ok = u.can(feature) if feature in rbac.ROLE_RANK else u.has(feature)
        if not ok:
            raise HTTPException(403, f"requires {feature}")
        return u
    return dep


def _ip(request: Request) -> str:
    return request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else "")


def dept_filter(u: A.User) -> list[str] | None:
    return None if "*" in u.departments else u.departments


def internal(x_internal_secret: str = Header(default="")) -> None:
    if x_internal_secret != settings.internal_secret:
        raise HTTPException(403)




def _parse_time(v: str | None) -> dt.datetime | None:
    if not v:
        return None
    t = dt.datetime.fromisoformat(v)
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone(dt.timedelta(minutes=330)))


