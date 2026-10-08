"""Camera permissions (Admin -> Permissions): a bucket-style table of *who* may do *what* on *which cameras*.

A row grants a user or a role a set of permissions on one camera, a department or all cameras, optionally until a
date. Rows are additive on top of the role: they never take anything away from what the role already allows on
the cameras the account sees through its departments / explicit camera list. For cameras an account can see ONLY
because of a permission row, exactly the row's permissions apply (User.allows()).

    PERMS            live, playback, export, search, alerts, edit
    version()        bumps on every change; tokens carry it and re-read their access when it moves (no re-login)
    for_user()       {scope-key: set(perms)} in force for a user (own rows + rows of the user's role)
"""
from __future__ import annotations

import datetime as dt
import threading
import time

from sqlalchemy import select

PERMS = ["live", "playback", "export", "search", "alerts", "edit"]
PERM_LABELS = {"live": "Live", "playback": "Playback", "export": "Export", "search": "Search", "alerts": "Alerts", "edit": "Edit"}
PERM_HELP = {"live": "watch the live stream on the wall / map", "playback": "recordings, clips and bookmarks",
             "export": "evidence bundles and downloads", "search": "plate reads and vehicle movement from the camera",
             "alerts": "see and acknowledge its alerts", "edit": "change its registry entry"}
# a camera permission also needs the console feature behind it; granting the permission grants that feature too
PERM_FEATURES = {"live": {"live"}, "playback": {"playback"}, "export": {"export"}, "search": {"search", "plate_search", "movement"},
                 "alerts": {"alerts_ack"}, "edit": {"registry", "registry_edit"}}
SCOPES = ("camera", "department", "route", "all")

_cache = {"v": None, "ts": 0.0}
_lock = threading.Lock()
CACHE_TTL = 10.0


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def version() -> int:
    """Current permissions version (setting camperms_version), cached a few seconds."""
    now = time.monotonic()
    with _lock:
        if _cache["v"] is not None and now - _cache["ts"] < CACHE_TTL:
            return _cache["v"]
    try:
        from .db import SessionLocal, get_setting
        with SessionLocal() as s:
            v = int(get_setting(s, "camperms_version", {"v": 0}).get("v", 0))
    except Exception:  # noqa: BLE001
        v = _cache["v"] or 0
    with _lock:
        _cache.update(v=v, ts=now)
    return v


def bump(session, actor: str = "") -> int:
    from .db import get_setting, set_setting
    v = int(get_setting(session, "camperms_version", {"v": 0}).get("v", 0)) + 1
    set_setting(session, "camperms_version", {"v": v}, actor)
    with _lock:
        _cache.update(v=v, ts=time.monotonic())
    return v


def is_live(r, now: dt.datetime | None = None) -> bool:
    now = now or _now()
    return r.revoked_at is None and (r.expires_at is None or r.expires_at > now)


def status(r, now: dt.datetime | None = None) -> str:
    now = now or _now()
    if r.revoked_at is not None:
        return "revoked"
    if r.expires_at is not None and r.expires_at <= now:
        return "expired"
    return "active"


def scope_key(r) -> str:
    return "*" if r.scope_kind == "all" else (f"dept:{r.scope_value}" if r.scope_kind == "department" else r.scope_value)


def route_cameras(session, route_id: str) -> list[str]:
    """Camera ids on a VIP route right now (its path / keywords / allocated cameras) - a route scope follows the route."""
    try:
        from . import corridors
        from .db import Route
        r = session.get(Route, route_id)
        if not r:
            return []
        return [c["id"] for c in corridors.cameras_for(session, r)]
    except Exception:  # noqa: BLE001
        return []


def for_user(session, username: str, role: str) -> dict[str, set[str]]:
    """Permissions in force for one account: {camera id | 'dept:<name>' | '*': {perms}}.
    Route scopes are expanded to the route's cameras (so the key is always a camera / department / '*')."""
    from .db import CameraPermission
    now = _now()
    out: dict[str, set[str]] = {}
    rows = session.scalars(select(CameraPermission).where(CameraPermission.revoked_at.is_(None),
                                                          CameraPermission.grantee.in_([username, role]))).all()
    for r in rows:
        if (r.grantee_kind == "user" and r.grantee != username) or (r.grantee_kind == "role" and r.grantee != role):
            continue
        if not is_live(r, now):
            continue
        ps = {p for p in (r.perms or []) if p in PERMS}
        if r.scope_kind == "route":
            for cid in route_cameras(session, r.scope_value):
                out.setdefault(cid, set()).update(ps)
        else:
            out.setdefault(scope_key(r), set()).update(ps)
    return out


def allows(perms: dict[str, set[str]] | dict[str, list[str]], camera_id: str, department: str, perm: str) -> bool:
    got: set[str] = set()
    for k in (camera_id, f"dept:{department}", "*"):
        got.update(perms.get(k) or ())
    return perm in got


def row_dict(r, names: dict[str, str] | None = None) -> dict:
    names = names or {}
    return {"id": r.id, "scope_kind": r.scope_kind, "scope_value": r.scope_value,
            "scope_label": "All cameras" if r.scope_kind == "all" else (names.get(r.scope_value, r.scope_value) if r.scope_kind in ("camera", "route") else r.scope_value),
            "grantee_kind": r.grantee_kind, "grantee": r.grantee, "perms": [p for p in PERMS if p in (r.perms or [])],
            "reason": r.reason, "granted_by": r.granted_by, "created_at": r.created_at.isoformat() if r.created_at else None,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None, "updated_by": r.updated_by,
            "expires_at": r.expires_at.isoformat() if r.expires_at else None, "revoked_at": r.revoked_at.isoformat() if r.revoked_at else None,
            "revoked_by": r.revoked_by, "status": status(r)}
