"""In-console notifications: the bell in the top bar, the badge on the navigation menu and the
Notifications page.

`push()` stores one row (table `inbox`) and hands it to an optional live sink (the API's WebSocket hub)
so open consoles update their count at once. Workers in other processes just store the row; consoles
poll the unread count every 30 s as well, so nothing is lost without a socket.

What becomes a notification (and for whom):
  alert        watchlist hit / challan suggestion          department of the camera
  incident     analytics incident (crowd, intrusion, ...)  department of the camera; high/critical only (others stay on the Alerts tab)
  camera       camera offline / back online                department; users with `sources`
  device       device connected / changed / disconnected   everyone with `sources`
  detection    AI detection switched on / off              everyone
  security     break-glass, lockouts, new accounts, role changes   users with `admin`
  archival     archival run finished / failed              users with `admin`
  report       scheduled report ready                      users with `reports`
"""
from __future__ import annotations

import datetime as dt
import logging
import threading
from typing import Callable

from sqlalchemy import func, select

from .db import Inbox, InboxRead, SessionLocal, utcnow

log = logging.getLogger("uvp.inbox")
KINDS = ["alert", "incident", "camera", "device", "detection", "security", "archival", "report", "geofence", "system"]
SEVERITIES = ["info", "warn", "critical"]
_sink: Callable[[dict], None] | None = None
_lock = threading.Lock()


def set_sink(fn: Callable[[dict], None] | None) -> None:
    """The API registers its WebSocket fan-out here; workers leave it unset."""
    global _sink
    _sink = fn


SEV_RANK = {"info": 0, "warn": 1, "critical": 2}


def row_dict(n: Inbox, read: bool | None = None) -> dict:
    d = {"id": n.id, "ts": n.ts.isoformat(), "kind": n.kind, "severity": n.severity, "title": n.title, "body": n.body,
         "department": n.department, "ref_id": n.ref_id, "link": n.link, "feature": n.feature, "camera_id": getattr(n, "camera_id", "") or ""}
    if read is not None:
        d["read"] = read
    return d


def push(kind: str, title: str, body: str = "", *, department: str = "*", severity: str = "info", ref_id: str = "",
         link: str = "", feature: str = "", camera_id: str = "", session=None) -> dict | None:
    """Store a notification and broadcast it. Never raises (a notification must not break the caller)."""
    kind = kind if kind in KINDS else "system"
    severity = severity if severity in SEVERITIES else "info"
    try:
        own = session is None
        s = session or SessionLocal()
        try:
            n = Inbox(kind=kind, severity=severity, title=(title or kind)[:200], body=(body or "")[:4000], department=department or "*",
                      ref_id=str(ref_id or "")[:64], link=(link or "")[:64], feature=feature or "", camera_id=str(camera_id or "")[:64])
            s.add(n)
            if own:
                s.commit()
            else:
                s.flush()
            d = row_dict(n, False)
        finally:
            if own:
                s.close()
    except Exception:  # noqa: BLE001
        log.exception("inbox push failed")
        return None
    if _sink is not None:
        try:
            _sink({"type": "inbox", **d})
        except Exception:  # noqa: BLE001
            log.debug("inbox sink failed", exc_info=True)
    return d


# ----------------------------------------------------------------------------- queries
def _visible(stmt, u, prefs: dict | None = None):
    """Rows this user may see: their departments (or everything for '*'), cameras they were granted explicitly,
    the feature gate, and their own notification preferences (kinds, minimum severity)."""
    if "*" not in u.departments:
        cond = Inbox.department.in_(["*", *u.departments])
        if u.cameras:
            cond = cond | Inbox.camera_id.in_(list(u.cameras))
        stmt = stmt.where(cond)
    allowed = [f for f in ("sources", "admin", "reports", "audit", "search", "watchlist", "alerts_ack") if u.has(f)]
    stmt = stmt.where(Inbox.feature.in_(["", *allowed]))
    prefs = prefs if prefs is not None else preferences(u.username)
    kinds = prefs.get("kinds")
    if isinstance(kinds, list) and kinds and set(kinds) != set(KINDS):
        stmt = stmt.where(Inbox.kind.in_(kinds))
    lo = SEV_RANK.get(prefs.get("min_severity", "info"), 0)
    if lo > 0:
        stmt = stmt.where(Inbox.severity.in_([k for k, v in SEV_RANK.items() if v >= lo]))
    return stmt


# ----------------------------------------------------------------------------- per-user preferences
DEFAULT_PREFS = {"kinds": list(KINDS), "min_severity": "info", "toast": True, "speak": False, "speak_min_severity": "critical", "badge": True}


def preferences(username: str) -> dict:
    from .db import get_setting
    try:
        with SessionLocal() as s:
            p = get_setting(s, f"notif_prefs:{username}", {})
    except Exception:  # noqa: BLE001
        p = {}
    return {**DEFAULT_PREFS, **(p or {})}


def save_preferences(username: str, body: dict) -> dict:
    from .db import set_setting
    kinds = [k for k in (body.get("kinds") or []) if k in KINDS] or list(KINDS)
    sev = body.get("min_severity") if body.get("min_severity") in SEVERITIES else "info"
    ssev = body.get("speak_min_severity") if body.get("speak_min_severity") in SEVERITIES else "critical"
    p = {"kinds": kinds, "min_severity": sev, "toast": bool(body.get("toast", True)), "speak": bool(body.get("speak", False)),
         "speak_min_severity": ssev, "badge": bool(body.get("badge", True))}
    with SessionLocal() as s:
        set_setting(s, f"notif_prefs:{username}", p, username)
        s.commit()
    return p


def allowed_for(u, n: dict) -> bool:
    """Live WebSocket fan-out: should this user receive notification dict `n`?"""
    dept = n.get("department", "*")
    if "*" not in u.departments and dept not in ("", "*") and dept not in u.departments and n.get("camera_id", "") not in (u.cameras or []):
        return False
    if n.get("feature") and not u.has(n["feature"]):
        return False
    p = preferences(u.username)
    if n.get("kind") not in (p.get("kinds") or KINDS):
        return False
    return SEV_RANK.get(n.get("severity", "info"), 0) >= SEV_RANK.get(p.get("min_severity", "info"), 0)


def unread_count(s, u) -> int:
    read_ids = select(InboxRead.inbox_id).where(InboxRead.username == u.username)
    stmt = _visible(select(func.count()).select_from(Inbox).where(Inbox.id.not_in(read_ids)), u)
    return int(s.scalar(stmt) or 0)


def list_rows(s, u, *, kind: str = "", severity: str = "", unread_only: bool = False, q: str = "",
              since: dt.datetime | None = None, page: int = 1, page_size: int = 50) -> dict:
    read_ids = select(InboxRead.inbox_id).where(InboxRead.username == u.username)
    stmt = _visible(select(Inbox), u)
    if kind:
        stmt = stmt.where(Inbox.kind == kind)
    if severity:
        stmt = stmt.where(Inbox.severity == severity)
    if unread_only:
        stmt = stmt.where(Inbox.id.not_in(read_ids))
    if since is not None:
        stmt = stmt.where(Inbox.ts >= since)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(Inbox.title.ilike(like) | Inbox.body.ilike(like) | Inbox.ref_id.ilike(like))
    total = int(s.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
    page = max(1, page)
    page_size = max(1, min(page_size, 200))
    rows = s.scalars(stmt.order_by(Inbox.ts.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    read = set(s.scalars(select(InboxRead.inbox_id).where(InboxRead.username == u.username, InboxRead.inbox_id.in_([r.id for r in rows]))).all()) if rows else set()
    return {"items": [row_dict(r, r.id in read) for r in rows], "total": total, "page": page, "page_size": page_size,
            "pages": max(1, -(-total // page_size))}


def summary(s, u, days: int = 7) -> dict:
    """Dashboard numbers: unread, today, last 7 days by kind and severity, per day."""
    now = utcnow()
    ist = dt.timezone(dt.timedelta(minutes=330))
    today0 = now.astimezone(ist).replace(hour=0, minute=0, second=0, microsecond=0)
    since = today0 - dt.timedelta(days=days - 1)
    rows = s.scalars(_visible(select(Inbox).where(Inbox.ts >= since), u)).all()
    by_kind: dict[str, int] = {}
    by_sev: dict[str, int] = {}
    per_day: dict[str, dict] = {}
    for i in range(days):
        d = (since + dt.timedelta(days=i)).date().isoformat()
        per_day[d] = {"day": d, "total": 0, "critical": 0, "warn": 0, "info": 0}
    today = 0
    for r in rows:
        by_kind[r.kind] = by_kind.get(r.kind, 0) + 1
        by_sev[r.severity] = by_sev.get(r.severity, 0) + 1
        d = r.ts.astimezone(ist).date().isoformat()
        if d in per_day:
            per_day[d]["total"] += 1
            per_day[d][r.severity if r.severity in ("critical", "warn", "info") else "info"] += 1
        if r.ts >= today0:
            today += 1
    return {"unread": unread_count(s, u), "today": today, "window_days": days, "total": len(rows), "by_kind": by_kind,
            "by_severity": by_sev, "per_day": list(per_day.values()), "kinds": KINDS, "severities": SEVERITIES}


def mark_read(s, u, ids: list[str] | None = None, all_visible: bool = False) -> int:
    """Mark the given notifications (or every visible one) read for this user. Returns rows marked."""
    read_ids = select(InboxRead.inbox_id).where(InboxRead.username == u.username)
    stmt = _visible(select(Inbox.id).where(Inbox.id.not_in(read_ids)), u)
    if not all_visible:
        if not ids:
            return 0
        stmt = stmt.where(Inbox.id.in_(ids))
    targets = s.scalars(stmt).all()
    now = utcnow()
    for i in targets:
        s.add(InboxRead(username=u.username, inbox_id=i, ts=now))
    s.flush()
    return len(targets)


def mark_unread(s, u, ids: list[str]) -> int:
    if not ids:
        return 0
    rows = s.scalars(select(InboxRead).where(InboxRead.username == u.username, InboxRead.inbox_id.in_(ids))).all()
    for r in rows:
        s.delete(r)
    s.flush()
    return len(rows)


# ----------------------------------------------------------------------------- event -> notification mapping
def from_event(kind: str, p: dict) -> None:
    """Called by the API's broadcast(): turns bus events into notifications where that is useful."""
    try:
        dept = p.get("department") or "*"
        cam = p.get("camera_id", "")
        if kind == "alert":
            what = "Challan suggested" if p.get("match") == "rule" else "Watchlist hit"
            sev = "critical" if p.get("priority") in ("critical", "high") else "warn"
            push("alert", f"{what}: {p.get('plate', '')}", f"{p.get('reason', '')} · camera {cam}".strip(" ·"), department=dept, severity=sev,
                 ref_id=p.get("id", ""), link="alerts", camera_id=cam)
            _geofence_hits("alert", p, dept, cam)
        elif kind == "incident":
            if p.get("priority") not in ("high", "critical"):
                return
            push("incident", f"{p.get('label') or p.get('kind', 'incident')} at {cam}", f"zone {p.get('zone') or '-'} · priority {p.get('priority')}",
                 department=dept, severity="critical" if p.get("priority") == "critical" else "warn", ref_id=p.get("id", ""), link="alerts", camera_id=cam)
            _geofence_hits("incident", p, dept, cam)
        elif kind == "camera.health":
            st = p.get("status", "")
            if st not in ("offline", "online", "live"):
                return
            push("camera", f"Camera {cam} {'back online' if st != 'offline' else 'offline'}", p.get("detail", ""), department=dept,
                 severity="warn" if st == "offline" else "info", ref_id=cam, link="sources", feature="sources", camera_id=cam)
            _geofence_hits("camera", p, dept, cam)
        elif kind == "break_glass":
            push("security", f"Break-glass by {p.get('user', '')}", f"{p.get('reason', '')} · until {p.get('until', '')}", severity="critical",
                 ref_id=p.get("user", ""), link="admin", feature="admin")
        elif kind == "report":
            push("report", p.get("subject") or "Report ready", f"accuracy {p.get('accuracy_pct', '')}% on {p.get('reads', '')} reads", severity="info",
                 ref_id=p.get("id", ""), link="reports", feature="reports")
    except Exception:  # noqa: BLE001
        log.debug("inbox from_event failed", exc_info=True)


def _geofence_hits(kind: str, p: dict, dept: str, cam: str) -> None:
    """An alert / incident / camera event inside an active geofence raises a geofence notification."""
    try:
        from .geofences import fences_for_camera
        for f in fences_for_camera(cam):
            if kind not in (f.get("notify_kinds") or []):
                continue
            what = {"alert": f"watchlist hit {p.get('plate', '')}", "incident": p.get("label") or p.get("kind", "incident"),
                    "camera": f"camera {p.get('status', '')}"}.get(kind, kind)
            push("geofence", f"{f['name']}: {what}", f"camera {p.get('camera_name') or cam} is inside geofence {f['name']}", department=dept,
                 severity=f.get("severity") or "warn", ref_id=f["id"], link="map", camera_id=cam)
    except Exception:  # noqa: BLE001
        log.debug("geofence check failed", exc_info=True)
