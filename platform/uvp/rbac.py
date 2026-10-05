"""Role-based access with fine-grained overrides and console-defined roles.

A user's effective access = role features + active grants (time-bound, from the access_grants
table) + break-glass elevation if one is in force. Features are checked per API route; cameras
are checked per stream / clip / recording.

Roles live in the `roles` table (Admin -> Roles & permissions). The four built-in roles are seeded
from ROLE_FEATURES below and may be adjusted; custom roles ("traffic_analyst", "control_room_lead", ...)
are added with any combination of features. Role definitions are cached for CACHE_TTL seconds, and a
`roles_version` counter (settings table) lets live sessions pick up a changed role without signing in
again (see uvp.auth.verify_token).

Features
  live           watch live streams on the wall
  search         the search dashboard (plates masked unless plate_search)
  playback       archived clips and recordings
  export         CSV / evidence bundles / clip download
  plate_search   full plate numbers in search, alerts and ticker (others see masked plates)
  movement       cross-department vehicle route
  tags           manual event tags
  watchlist      manage watchlist entries
  alerts_ack     acknowledge alerts
  cases          investigation cases (phase 2)
  sources        departmental source health page
  audit          read the audit log
  reports        daily operations reports
  admin          users, roles, grants, legal holds, archival, compliance
  registry       the camera registry (inventory, GIS layers, gap analysis, export)
  registry_edit  onboard / edit / import / remove registry cameras
"""
from __future__ import annotations

import datetime as dt
import logging
import threading
import time

log = logging.getLogger("uvp.rbac")

FEATURES = ["live", "search", "playback", "export", "plate_search", "movement", "tags", "watchlist", "alerts_ack",
            "cases", "sources", "audit", "reports", "admin", "registry", "registry_edit"]

FEATURE_LABELS = {
    "live": "Live video wall", "search": "Search dashboard", "playback": "Playback & clips", "export": "Export / evidence bundles",
    "plate_search": "Full plate numbers", "movement": "Vehicle movement", "tags": "Event tags", "watchlist": "Manage watchlist",
    "alerts_ack": "Acknowledge alerts", "cases": "Investigation cases", "sources": "Sources & devices (read)", "audit": "Audit log",
    "reports": "Daily reports", "admin": "Administration", "registry": "Camera registry (read)", "registry_edit": "Camera registry (edit)",
}

ROLE_FEATURES = {
    "viewer":     {"live", "sources", "registry"},
    "analyst":    {"live", "search", "playback", "plate_search", "movement", "tags", "cases", "sources", "registry", "reports"},
    "supervisor": {"live", "search", "playback", "export", "plate_search", "movement", "tags", "watchlist",
                   "alerts_ack", "cases", "sources", "registry", "registry_edit", "reports"},
    "admin":      set(FEATURES),
}
ROLE_DESCRIPTIONS = {
    "viewer": "Watch live video; see source health and the registry.",
    "analyst": "Investigate: search, playback, vehicle movement, cases and reports.",
    "supervisor": "Analyst plus export, watchlist, alert acknowledgement and registry editing.",
    "admin": "Everything, including users, roles, grants, legal holds and archival.",
}

# Backward compatibility with the role ladder used by the first pilot build
ROLE_RANK = {"viewer": 0, "analyst": 1, "supervisor": 2, "admin": 3}
CACHE_TTL = 10.0

_cache: dict = {"ts": 0.0, "roles": None, "version": 0}
_lock = threading.Lock()


# ----------------------------------------------------------------------------- role store
def _builtin() -> dict:
    return {n: {"name": n, "description": ROLE_DESCRIPTIONS.get(n, ""), "features": sorted(f), "builtin": True}
            for n, f in ROLE_FEATURES.items()}


def _load() -> tuple[dict, int]:
    from sqlalchemy import select
    from .db import Role, SessionLocal, get_setting
    out = _builtin()
    with SessionLocal() as s:
        for r in s.scalars(select(Role)):
            out[r.name] = {"name": r.name, "description": r.description or "", "features": sorted(set(r.features or [])),
                           "builtin": bool(r.builtin), "updated_by": r.updated_by, "updated_at": r.updated_at.isoformat() if r.updated_at else None}
        ver = int(get_setting(s, "roles_version", {"v": 0}).get("v", 0))
    return out, ver


def roles(force: bool = False) -> dict:
    """All roles (built-in merged with the database), cached."""
    now = time.monotonic()
    with _lock:
        if not force and _cache["roles"] is not None and now - _cache["ts"] < CACHE_TTL:
            return _cache["roles"]
    try:
        data, ver = _load()
    except Exception:  # noqa: BLE001  (no database yet, e.g. tooling) -> built-in roles only
        data, ver = _builtin(), _cache["version"]
    with _lock:
        _cache.update(ts=now, roles=data, version=ver)
    return data


def roles_version() -> int:
    roles()
    return int(_cache["version"])


def invalidate() -> None:
    with _lock:
        _cache["ts"] = 0.0


def role_features(role: str) -> set[str]:
    r = roles().get(role)
    if r is not None:
        return set(r["features"])
    return set(ROLE_FEATURES.get(role, set()))


def is_role(role: str) -> bool:
    return role in roles()


def role_rank(role: str) -> int:
    """Ladder position of any role: built-ins keep theirs; a custom role ranks by what it may do."""
    if role in ROLE_RANK:
        return ROLE_RANK[role]
    f = role_features(role)
    if "admin" in f:
        return 3
    if {"export", "watchlist"} & f or "alerts_ack" in f:
        return 2
    if "search" in f or "playback" in f:
        return 1
    return 0 if f else -1


def seed_roles(session) -> None:
    """Make sure the four built-in roles exist as rows (so they can be adjusted from the console)."""
    from .db import Role
    for name, feats in ROLE_FEATURES.items():
        if session.get(Role, name) is None:
            session.add(Role(name=name, description=ROLE_DESCRIPTIONS.get(name, ""), features=sorted(feats), builtin=True,
                             created_by="system", updated_by="system"))
    session.flush()


def save_role(session, name: str, features: list[str], description: str = "", actor: str = "", create: bool = False) -> dict:
    """Create or update a role; bumps roles_version so live sessions follow. Raises ValueError with a user message."""
    import re
    from .db import Role, get_setting, set_setting, utcnow
    name = (name or "").strip().lower()
    if not re.match(r"^[a-z][a-z0-9_\-]{1,31}$", name):
        raise ValueError("role name: 2-32 characters, lowercase letters, digits, _ or -, starting with a letter")
    bad = sorted({f for f in features if f not in FEATURES})
    if bad:
        raise ValueError(f"unknown feature(s): {', '.join(bad)}")
    feats = sorted({f for f in features if f in FEATURES})
    if "registry_edit" in feats and "registry" not in feats:
        feats = sorted(set(feats) | {"registry"})
    row = session.get(Role, name)
    if row is None:
        if not create and name not in ROLE_FEATURES:
            raise KeyError(name)
        row = Role(name=name, builtin=name in ROLE_FEATURES, created_by=actor)
        session.add(row)
    elif create:
        raise ValueError("a role with that name already exists")
    if row.builtin and name == "admin" and "admin" not in feats:
        raise ValueError("the admin role keeps the admin feature")
    row.features, row.description, row.updated_by, row.updated_at = feats, (description or "")[:200], actor, utcnow()
    v = int(get_setting(session, "roles_version", {"v": 0}).get("v", 0)) + 1
    set_setting(session, "roles_version", {"v": v}, actor)
    session.flush()
    invalidate()
    return {"name": name, "description": row.description, "features": feats, "builtin": bool(row.builtin)}


def delete_role(session, name: str, actor: str = "") -> int:
    """Remove a custom role. Refused for built-ins and while accounts still use it. Returns users checked."""
    from sqlalchemy import select
    from .db import Role, Users, get_setting, set_setting
    row = session.get(Role, name)
    if row is None:
        raise KeyError(name)
    if row.builtin or name in ROLE_FEATURES:
        raise ValueError("built-in roles cannot be removed (adjust their permissions instead)")
    users = session.scalars(select(Users.username).where(Users.role == name)).all()
    if users:
        raise ValueError(f"{len(users)} account(s) still have this role: {', '.join(users[:5])}{' …' if len(users) > 5 else ''}")
    session.delete(row)
    v = int(get_setting(session, "roles_version", {"v": 0}).get("v", 0)) + 1
    set_setting(session, "roles_version", {"v": v}, actor)
    session.flush()
    invalidate()
    return len(users)


# ----------------------------------------------------------------------------- grants
def active_grants(session, username: str, now: dt.datetime | None = None) -> list:
    """Grants in force for a user right now."""
    from sqlalchemy import select
    from .db import AccessGrant
    now = now or dt.datetime.now(dt.timezone.utc)
    rows = session.scalars(select(AccessGrant).where(AccessGrant.username == username,
                                                     AccessGrant.revoked_at.is_(None))).all()
    return [g for g in rows if g.starts_at <= now and (g.expires_at is None or g.expires_at > now)]


def effective(session, username: str, role: str, departments: list[str], cameras: list[str] | None = None) -> dict:
    """Compute {features, grant_features, departments, cameras, break_glass} from role + grants."""
    feats = role_features(role)
    extra: set[str] = set()
    depts = set(departments)
    cams = set(cameras or [])
    bg = None
    for g in active_grants(session, username):
        if g.kind == "feature":
            extra.add(g.value)
        elif g.kind == "department":
            depts.add(g.value)
        elif g.kind == "camera":
            cams.add(g.value)
        elif g.kind == "break_glass":
            bg = g
    return {"features": sorted(feats | extra), "grant_features": sorted(extra), "departments": sorted(depts), "cameras": sorted(cams),
            "break_glass": bg.id if bg else None,
            "break_glass_until": bg.expires_at.isoformat() if bg and bg.expires_at else None}
