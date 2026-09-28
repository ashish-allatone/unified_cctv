"""Role-based access with fine-grained overrides.

A user's effective access = role defaults + active grants (time-bound, from the access_grants
table) + break-glass elevation if one is in force. Features are checked per API route; cameras
are checked per stream / clip / recording.

Features
  live          watch live streams on the wall
  search        the search dashboard (plates masked unless plate_search)
  playback      archived clips and recordings
  export        CSV / evidence bundles / clip download
  plate_search  full plate numbers in search, alerts and ticker (others see masked plates)
  movement      cross-department vehicle route
  tags          manual event tags
  watchlist     manage watchlist entries
  alerts_ack    acknowledge alerts
  cases         investigation cases (phase 2)
  sources       departmental source health page
  audit         read the audit log
  admin         users, grants, legal holds, compliance
  registry      the camera registry (inventory, GIS layers, gap analysis, export)
  registry_edit onboard / edit / import / remove registry cameras
"""
from __future__ import annotations

import datetime as dt

FEATURES = ["live", "search", "playback", "export", "plate_search", "movement", "tags", "watchlist", "alerts_ack",
            "cases", "sources", "audit", "admin", "registry", "registry_edit"]

ROLE_FEATURES = {
    "viewer":     {"live", "sources", "registry"},
    "analyst":    {"live", "search", "playback", "plate_search", "movement", "tags", "cases", "sources", "registry"},
    "supervisor": {"live", "search", "playback", "export", "plate_search", "movement", "tags", "watchlist",
                   "alerts_ack", "cases", "sources", "registry", "registry_edit"},
    "admin":      set(FEATURES),
}

# Backward compatibility with the role ladder used by the first pilot build
ROLE_RANK = {"viewer": 0, "analyst": 1, "supervisor": 2, "admin": 3}


def role_features(role: str) -> set[str]:
    return set(ROLE_FEATURES.get(role, set()))


def active_grants(session, username: str, now: dt.datetime | None = None) -> list:
    """Grants in force for a user right now."""
    from sqlalchemy import select
    from .db import AccessGrant
    now = now or dt.datetime.now(dt.timezone.utc)
    rows = session.scalars(select(AccessGrant).where(AccessGrant.username == username,
                                                     AccessGrant.revoked_at.is_(None))).all()
    return [g for g in rows if g.starts_at <= now and (g.expires_at is None or g.expires_at > now)]


def effective(session, username: str, role: str, departments: list[str], cameras: list[str] | None = None) -> dict:
    """Compute {features, departments, cameras, break_glass} from role + grants."""
    feats = role_features(role)
    depts = set(departments)
    cams = set(cameras or [])
    bg = None
    for g in active_grants(session, username):
        if g.kind == "feature":
            feats.add(g.value)
        elif g.kind == "department":
            depts.add(g.value)
        elif g.kind == "camera":
            cams.add(g.value)
        elif g.kind == "break_glass":
            bg = g
    return {"features": sorted(feats), "departments": sorted(depts), "cameras": sorted(cams),
            "break_glass": bg.id if bg else None,
            "break_glass_until": bg.expires_at.isoformat() if bg and bg.expires_at else None}
