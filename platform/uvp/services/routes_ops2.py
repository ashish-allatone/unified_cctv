"""Operations console additions (v1.6): notifications, daily reports, roles & permissions, archival policies.

Notifications (any signed-in user; rows scoped by department and feature)
  GET    /api/notifications                 ?kind=&severity=&unread=1&q=&page=&page_size=  -> {items, total, page, pages}
  GET    /api/notifications/unread          -> {unread}  (the bell / menu badge; polled every 30 s and pushed over the WebSocket)
  GET    /api/notifications/summary         ?days=7 -> dashboard numbers (unread, today, by kind / severity, per day)
  POST   /api/notifications/read            {ids:[...]} | {all:true}
  POST   /api/notifications/unread          {ids:[...]}

Daily reports (feature `reports`)
  GET    /api/reports/daily                 ?days=14&end=YYYY-MM-DD&department=&camera_id= -> rows per day + totals
  GET    /api/reports/daily.csv             same filters, CSV download (audited)

Roles & permissions (read: admin; write: super admin)
  GET    /api/roles                         roles with features, users per role, feature catalogue
  POST   /api/roles                         {name, description, features[]} -> new custom role
  PATCH  /api/roles/{name}                  {description?, features?}  (built-ins can be adjusted; admin keeps `admin`)
  DELETE /api/roles/{name}                  custom role without users only

Archival (admin)
  GET    /api/archival                      policies (effective, with source), usage per class, schedule, last runs, preview
  PUT    /api/archival/policies/{class}     {keep_days, action, enabled, department?}
  DELETE /api/archival/policies/{class}     ?department=  remove a console override (back to defaults)
  PUT    /api/archival/schedule             {hour_ist, enabled}
  POST   /api/archival/run                  run now (background thread) -> {started: true}
  GET    /api/archival/runs                 run history
"""
from __future__ import annotations

import datetime as dt
import logging
import threading

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import func, select

from .. import archival, inbox, rbac, reports_daily
from .. import auth as A
from ..db import SessionLocal, Users, audit, utcnow
from .deps import _ip, current_user, dept_filter, need

log = logging.getLogger("uvp.ops2")
router = APIRouter()


# ----------------------------------------------------------------------------- notifications
class ReadBody(BaseModel):
    ids: list[str] = []
    all: bool = False


@router.get("/api/notifications")
def list_notifications(kind: str = "", severity: str = "", unread: int = 0, q: str = "", since_hours: int = 0, page: int = 1, page_size: int = 50,
                       u: A.User = Depends(current_user)):
    since = utcnow() - dt.timedelta(hours=since_hours) if since_hours else None
    with SessionLocal() as s:
        return inbox.list_rows(s, u, kind=kind, severity=severity, unread_only=bool(unread), q=q, since=since, page=page, page_size=page_size)


@router.get("/api/notifications/unread")
def unread(u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        return {"unread": inbox.unread_count(s, u)}


@router.get("/api/notifications/summary")
def notif_summary(days: int = 7, u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        return inbox.summary(s, u, max(1, min(days, 31)))


@router.post("/api/notifications/read")
def mark_read(body: ReadBody, u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        n = inbox.mark_read(s, u, body.ids, all_visible=body.all)
        s.commit()
        return {"marked": n, "unread": inbox.unread_count(s, u)}


@router.post("/api/notifications/unread")
def mark_unread(body: ReadBody, u: A.User = Depends(current_user)):
    with SessionLocal() as s:
        n = inbox.mark_unread(s, u, body.ids)
        s.commit()
        return {"marked": n, "unread": inbox.unread_count(s, u)}


# ----------------------------------------------------------------------------- daily reports
def _report_scope(u: A.User, department: str) -> list[str] | None:
    depts = dept_filter(u)
    if department:
        if depts is not None and department not in depts:
            raise HTTPException(403, "not your department")
        return [department]
    return depts


@router.get("/api/reports/daily")
def daily_report(days: int = 14, end: str = "", department: str = "", camera_id: str = "", u: A.User = Depends(need("reports"))):
    end_d = dt.date.fromisoformat(end) if end else None
    with SessionLocal() as s:
        return reports_daily.daily(s, days, _report_scope(u, department), end_d, camera_id)


@router.get("/api/reports/daily.csv")
def daily_report_csv(request: Request, days: int = 14, end: str = "", department: str = "", camera_id: str = "", u: A.User = Depends(need("reports"))):
    end_d = dt.date.fromisoformat(end) if end else None
    with SessionLocal() as s:
        rep = reports_daily.daily(s, days, _report_scope(u, department), end_d, camera_id)
        audit(s, u.username, "report_export", "daily", f"days={days} end={end or 'today'} department={department or '*'}", _ip(request))
        s.commit()
    return Response(reports_daily.csv_bytes(rep), media_type="text/csv",
                    headers={"Content-Disposition": f"attachment; filename=daily-report-{rep['from']}_{rep['to']}.csv"})


# ----------------------------------------------------------------------------- roles
class RoleBody(BaseModel):
    name: str = ""
    description: str = ""
    features: list[str] | None = None


def need_super(u: A.User = Depends(need("admin"))) -> A.User:
    """Roles are changed by a super admin; while the console still runs on config/users.yaml accounts (no database
    accounts yet) any admin may, so the demo can show it."""
    with SessionLocal() as s:
        if not A.db_users_exist(s):
            return u
    from .routes_users import need_super as _ns
    return _ns(u)


def _roles_payload(s) -> dict:
    counts = {r: n for r, n in s.execute(select(Users.role, func.count()).group_by(Users.role))}
    out = []
    for name, r in sorted(rbac.roles(force=True).items(), key=lambda kv: (not kv[1]["builtin"], rbac.ROLE_RANK.get(kv[0], 9), kv[0])):
        out.append({**r, "users": int(counts.get(name, 0)), "rank": rbac.role_rank(name)})
    return {"roles": out, "features": [{"id": f, "label": rbac.FEATURE_LABELS.get(f, f)} for f in rbac.FEATURES], "version": rbac.roles_version()}


@router.get("/api/roles")
def list_roles(u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        return _roles_payload(s)


@router.post("/api/roles", status_code=201)
def create_role(body: RoleBody, request: Request, u: A.User = Depends(need_super)):
    with SessionLocal() as s:
        try:
            r = rbac.save_role(s, body.name, body.features or [], body.description, u.username, create=True)
        except ValueError as e:
            raise HTTPException(400, str(e))
        audit(s, u.username, "role_create", r["name"], ", ".join(r["features"]), _ip(request))
        inbox.push("security", f"Role '{r['name']}' created by {u.username}", ", ".join(r["features"]) or "no permissions", ref_id=r["name"], link="admin", feature="admin", session=s)
        s.commit()
        return r


@router.patch("/api/roles/{name}")
def update_role(name: str, body: RoleBody, request: Request, u: A.User = Depends(need_super)):
    with SessionLocal() as s:
        cur = rbac.roles(force=True).get(name)
        if cur is None:
            raise HTTPException(404, "no such role")
        feats = body.features if body.features is not None else cur["features"]
        desc = body.description if body.description else cur["description"]
        try:
            r = rbac.save_role(s, name, feats, desc, u.username)
        except KeyError:
            raise HTTPException(404, "no such role")
        except ValueError as e:
            raise HTTPException(400, str(e))
        added = sorted(set(r["features"]) - set(cur["features"]))
        removed = sorted(set(cur["features"]) - set(r["features"]))
        change = (f"+{','.join(added)} " if added else "") + (f"-{','.join(removed)}" if removed else "")
        audit(s, u.username, "role_update", name, change.strip() or "description", _ip(request))
        if change.strip():
            n_users = s.scalar(select(func.count()).select_from(Users).where(Users.role == name)) or 0
            inbox.push("security", f"Permissions of role '{name}' changed by {u.username}", f"{change.strip()} · applies to {n_users} account(s) at once",
                       severity="warn", ref_id=name, link="admin", feature="admin", session=s)
        s.commit()
        return r


@router.delete("/api/roles/{name}")
def remove_role(name: str, request: Request, u: A.User = Depends(need_super)):
    with SessionLocal() as s:
        try:
            rbac.delete_role(s, name, u.username)
        except KeyError:
            raise HTTPException(404, "no such role")
        except ValueError as e:
            raise HTTPException(409, str(e))
        audit(s, u.username, "role_delete", name, "", _ip(request))
        s.commit()
        return {"ok": True}


# ----------------------------------------------------------------------------- archival
class PolicyBody(BaseModel):
    keep_days: int
    action: str = "delete"
    enabled: bool = True
    department: str = "*"


class ScheduleBody(BaseModel):
    hour_ist: int = 2
    enabled: bool = True


_run_thread: threading.Thread | None = None


@router.get("/api/archival")
def archival_state(u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        pols = archival.policies(s)
        return {"policies": pols, "usage": archival.usage(s), "schedule": archival.schedule(s), "runs": archival.last_runs(s, 10),
                "preview": archival.preview(s), "classes": [{"id": k, **{kk: vv for kk, vv in v.items() if kk != "yaml"}} for k, v in archival.CLASSES.items()],
                "running": bool(_run_thread and _run_thread.is_alive()), "actions": list(archival.ACTIONS), "audit_min_days": archival.AUDIT_MIN_DAYS}


@router.get("/api/archival/preview")
def archival_preview(u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        return archival.preview(s)


@router.put("/api/archival/policies/{cls}")
def set_policy(cls: str, body: PolicyBody, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        try:
            p = archival.set_policy(s, cls, keep_days=body.keep_days, action=body.action, enabled=body.enabled, department=body.department, actor=u.username)
        except ValueError as e:
            raise HTTPException(400, str(e))
        audit(s, u.username, "archival_policy", f"{cls}/{body.department or '*'}", f"keep={body.keep_days}d action={body.action} enabled={body.enabled}", _ip(request))
        s.commit()
        return p


@router.delete("/api/archival/policies/{cls}")
def reset_policy(cls: str, request: Request, department: str = "*", u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        if not archival.delete_policy(s, cls, department):
            raise HTTPException(404, "no console override for that class / department")
        audit(s, u.username, "archival_policy_reset", f"{cls}/{department}", "", _ip(request))
        s.commit()
        return {"ok": True}


@router.put("/api/archival/schedule")
def set_schedule(body: ScheduleBody, request: Request, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        try:
            sch = archival.set_schedule(s, body.hour_ist, body.enabled, u.username)
        except ValueError as e:
            raise HTTPException(400, str(e))
        audit(s, u.username, "archival_schedule", "", f"hour_ist={body.hour_ist} enabled={body.enabled}", _ip(request))
        s.commit()
        return sch


@router.post("/api/archival/run", status_code=202)
def run_now(request: Request, wait: int = 0, u: A.User = Depends(need("admin"))):
    """Start a run (in the background unless ?wait=1, used by tests and scripts)."""
    global _run_thread
    if _run_thread and _run_thread.is_alive():
        raise HTTPException(409, "an archival run is already in progress")
    with SessionLocal() as s:
        audit(s, u.username, "archival_run", "", "manual", _ip(request))
        s.commit()
    if wait:
        return archival.run("manual", u.username)
    _run_thread = threading.Thread(target=archival.run, args=("manual", u.username), daemon=True, name="uvp-archival")
    _run_thread.start()
    return {"started": True}


@router.get("/api/archival/runs")
def runs(limit: int = 50, u: A.User = Depends(need("admin"))):
    with SessionLocal() as s:
        return archival.last_runs(s, max(1, min(limit, 500)))
