"""Daily operations report: one row per calendar day (IST) with everything the control room is asked about.

  plate reads, unique plates, alerts (by priority, acknowledged), incidents (by kind), challans (drafted / approved),
  traffic (average and peak vehicles, peak hour), people (peak persons), camera availability (offline minutes,
  uptime %), uploads analysed, sign-ins, audit actions, notifications.

Scoped to the departments the user may see. Used by GET /api/reports/daily (table, charts, CSV) and the
Reports tab; a day's figures are computed from the rows themselves, so they stay correct after archival only
for the retained window - the Archival page shows how long that is.
"""
from __future__ import annotations

import datetime as dt
from collections import defaultdict

from sqlalchemy import func, select

from .db import (Alert, AnprEvent, AuditLog, Camera, CameraStatusLog, Challan, Inbox, Incident, TrafficCount, utcnow)

IST = dt.timezone(dt.timedelta(minutes=330))


def day_bounds(days: int, end: dt.date | None = None) -> tuple[dt.datetime, dt.datetime, list[dt.date]]:
    """[start, end) in UTC covering `days` IST calendar days ending with `end` (default today)."""
    today = end or utcnow().astimezone(IST).date()
    first = today - dt.timedelta(days=days - 1)
    start = dt.datetime.combine(first, dt.time.min, IST).astimezone(dt.timezone.utc)
    stop = dt.datetime.combine(today + dt.timedelta(days=1), dt.time.min, IST).astimezone(dt.timezone.utc)
    return start, stop, [first + dt.timedelta(days=i) for i in range(days)]


def _day(ts: dt.datetime) -> str:
    return ts.astimezone(IST).date().isoformat()


def _dept_clause(col, departments: list[str] | None):
    return col.in_(departments) if departments else None


def daily(s, days: int = 14, departments: list[str] | None = None, end: dt.date | None = None, camera_id: str = "") -> dict:
    days = max(1, min(int(days), 92))
    start, stop, dates = day_bounds(days, end)
    rows: dict[str, dict] = {d.isoformat(): _blank(d.isoformat()) for d in dates}

    def q(stmt, model_dept=None):
        if departments and model_dept is not None:
            stmt = stmt.where(model_dept.in_(departments))
        return stmt

    # cameras in scope (for uptime)
    cams = s.scalars(q(select(Camera).where(Camera.source_id != "registry"), Camera.department)).all()
    if camera_id:
        cams = [c for c in cams if c.id == camera_id]
    cam_ids = {c.id for c in cams}
    if not camera_id:        # cameras that logged status but have no registry row yet (edge / removed devices)
        known = {c.id for c in s.scalars(select(Camera))}
        extra = {cid for (cid,) in s.execute(select(CameraStatusLog.camera_id).where(CameraStatusLog.ts >= start, CameraStatusLog.ts < stop).distinct())}
        if departments is None:
            cam_ids |= extra - known

    # plate reads + unique plates per day, and per-camera busiest
    ev_stmt = q(select(AnprEvent.ts, AnprEvent.plate, AnprEvent.camera_id).where(AnprEvent.ts >= start, AnprEvent.ts < stop), AnprEvent.department)
    if camera_id:
        ev_stmt = ev_stmt.where(AnprEvent.camera_id == camera_id)
    plates: dict[str, set] = defaultdict(set)
    cam_reads: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    hour_reads: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    for ts, plate, cam in s.execute(ev_stmt):
        d = _day(ts)
        if d in rows:
            rows[d]["reads"] += 1
            plates[d].add(plate)
            cam_reads[d][cam] += 1
            hour_reads[d][ts.astimezone(IST).hour] += 1
    for d, ps in plates.items():
        rows[d]["unique_plates"] = len(ps)
        if cam_reads[d]:
            top = max(cam_reads[d].items(), key=lambda kv: kv[1])
            rows[d]["busiest_camera"], rows[d]["busiest_camera_reads"] = top
        if hour_reads[d]:
            rows[d]["peak_hour"] = max(hour_reads[d].items(), key=lambda kv: kv[1])[0]

    # alerts
    al_stmt = q(select(Alert.ts, Alert.priority, Alert.ack_at, Alert.match).where(Alert.ts >= start, Alert.ts < stop), Alert.department)
    if camera_id:
        al_stmt = al_stmt.where(Alert.camera_id == camera_id)
    for ts, pr, ack, match in s.execute(al_stmt):
        d = _day(ts)
        if d in rows:
            r = rows[d]
            r["alerts"] += 1
            r["alerts_by_priority"][pr or "medium"] = r["alerts_by_priority"].get(pr or "medium", 0) + 1
            if ack:
                r["alerts_acked"] += 1
            if match == "rule":
                r["challan_suggestions"] += 1
            else:
                r["watchlist_hits"] += 1

    # incidents
    in_stmt = q(select(Incident.ts, Incident.kind, Incident.priority, Incident.ack_at).where(Incident.ts >= start, Incident.ts < stop), Incident.department)
    if camera_id:
        in_stmt = in_stmt.where(Incident.camera_id == camera_id)
    for ts, kind, pr, ack in s.execute(in_stmt):
        d = _day(ts)
        if d in rows:
            r = rows[d]
            r["incidents"] += 1
            r["incidents_by_kind"][kind] = r["incidents_by_kind"].get(kind, 0) + 1
            if pr in ("high", "critical"):
                r["incidents_high"] += 1
            if ack:
                r["incidents_acked"] += 1

    # challans
    ch_stmt = q(select(Challan.created_at, Challan.status, Challan.fine_inr).where(Challan.created_at >= start, Challan.created_at < stop), Challan.department)
    for ts, status, fine in s.execute(ch_stmt):
        d = _day(ts)
        if d in rows:
            r = rows[d]
            r["challans"] += 1
            if status in ("approved", "sent"):
                r["challans_approved"] += 1
                r["challan_fines_inr"] += int(fine or 0)

    # traffic / crowd counts
    tc_stmt = q(select(TrafficCount.ts, TrafficCount.avg_vehicles, TrafficCount.peak_vehicles, TrafficCount.avg, TrafficCount.camera_id)
                .where(TrafficCount.ts >= start, TrafficCount.ts < stop), TrafficCount.department)
    if camera_id:
        tc_stmt = tc_stmt.where(TrafficCount.camera_id == camera_id)
    veh_sum: dict[str, list] = defaultdict(lambda: [0.0, 0])
    veh_hour: dict[str, dict] = defaultdict(lambda: defaultdict(float))
    for ts, avg_v, peak_v, avg, cam in s.execute(tc_stmt):
        d = _day(ts)
        if d not in rows:
            continue
        r = rows[d]
        veh_sum[d][0] += float(avg_v or 0)
        veh_sum[d][1] += 1
        r["peak_vehicles"] = max(r["peak_vehicles"], int(peak_v or 0))
        persons = float((avg or {}).get("person", 0) or 0)
        r["peak_persons"] = max(r["peak_persons"], int(round(persons)))
        veh_hour[d][ts.astimezone(IST).hour] += float(avg_v or 0)
        r["count_windows"] += 1
    for d, (tot, n) in veh_sum.items():
        rows[d]["avg_vehicles"] = round(tot / n, 1) if n else 0
        if veh_hour[d]:
            rows[d]["peak_traffic_hour"] = max(veh_hour[d].items(), key=lambda kv: kv[1])[0]

    # camera availability: offline minutes from status transitions within each day
    if cam_ids:
        st_stmt = select(CameraStatusLog.camera_id, CameraStatusLog.ts, CameraStatusLog.status).where(
            CameraStatusLog.camera_id.in_(list(cam_ids)), CameraStatusLog.ts >= start - dt.timedelta(days=1), CameraStatusLog.ts < stop).order_by(CameraStatusLog.ts)
        by_cam: dict[str, list] = defaultdict(list)
        for cid, ts, status in s.execute(st_stmt):
            by_cam[cid].append((ts, status))
        now = utcnow()
        for cid in cam_ids:
            trans = by_cam.get(cid, [])
            # state at `start`
            state = "online"
            for ts, st in trans:
                if ts < start:
                    state = st
            idx = 0
            while idx < len(trans) and trans[idx][0] < start:
                idx += 1
            for d in dates:
                d0 = dt.datetime.combine(d, dt.time.min, IST).astimezone(dt.timezone.utc)
                d1 = min(d0 + dt.timedelta(days=1), now)
                if d1 <= d0:
                    continue
                t = d0
                off = 0.0
                went_off = 0
                while idx < len(trans) and trans[idx][0] < d1:
                    ts, st = trans[idx]
                    if state == "offline":
                        off += (ts - t).total_seconds()
                    if st == "offline" and state != "offline":
                        went_off += 1
                    state, t = st, ts
                    idx += 1
                if state == "offline":
                    off += (d1 - t).total_seconds()
                r = rows[d.isoformat()]
                r["camera_minutes"] += (d1 - d0).total_seconds() / 60
                r["offline_minutes"] += off / 60
                r["offline_events"] += went_off
                if off >= (d1 - d0).total_seconds() * 0.5:
                    r["cameras_mostly_offline"] += 1
    for r in rows.values():
        r["cameras"] = len(cam_ids)
        r["uptime_pct"] = round(100 * (1 - r["offline_minutes"] / r["camera_minutes"]), 1) if r["camera_minutes"] else None
        r["offline_minutes"] = int(round(r["offline_minutes"]))
        r.pop("camera_minutes", None)

    # uploads / sign-ins / audit actions (not department scoped: they are user actions)
    au_stmt = select(AuditLog.ts, AuditLog.action).where(AuditLog.ts >= start, AuditLog.ts < stop)
    for ts, action in s.execute(au_stmt):
        d = _day(ts)
        if d in rows:
            r = rows[d]
            r["audit_actions"] += 1
            if action == "login":
                r["logins"] += 1
            elif action == "login_failed":
                r["failed_logins"] += 1
            elif action == "analysis_upload":
                r["uploads"] += 1
            elif action.startswith("export") or action.endswith("_export") or action == "device_bundle":
                r["exports"] += 1

    nb_stmt = q(select(Inbox.ts, Inbox.severity).where(Inbox.ts >= start, Inbox.ts < stop), None)
    if departments:
        nb_stmt = nb_stmt.where(Inbox.department.in_(["*", *departments]))
    for ts, sev in s.execute(nb_stmt):
        d = _day(ts)
        if d in rows:
            rows[d]["notifications"] += 1
            if sev == "critical":
                rows[d]["notifications_critical"] += 1

    out = [rows[d.isoformat()] for d in dates]
    return {"days": days, "from": dates[0].isoformat(), "to": dates[-1].isoformat(), "rows": out, "totals": _totals(out),
            "departments": departments or ["*"], "camera_id": camera_id}


def _blank(day: str) -> dict:
    return {"day": day, "reads": 0, "unique_plates": 0, "busiest_camera": "", "busiest_camera_reads": 0, "peak_hour": None,
            "alerts": 0, "alerts_acked": 0, "alerts_by_priority": {}, "watchlist_hits": 0, "challan_suggestions": 0,
            "incidents": 0, "incidents_high": 0, "incidents_acked": 0, "incidents_by_kind": {},
            "challans": 0, "challans_approved": 0, "challan_fines_inr": 0,
            "avg_vehicles": 0, "peak_vehicles": 0, "peak_persons": 0, "peak_traffic_hour": None, "count_windows": 0,
            "cameras": 0, "offline_minutes": 0, "offline_events": 0, "cameras_mostly_offline": 0, "uptime_pct": None, "camera_minutes": 0.0,
            "uploads": 0, "exports": 0, "logins": 0, "failed_logins": 0, "audit_actions": 0, "notifications": 0, "notifications_critical": 0}


def _totals(rows: list[dict]) -> dict:
    keys = ["reads", "alerts", "alerts_acked", "watchlist_hits", "challan_suggestions", "incidents", "incidents_high", "challans",
            "challans_approved", "challan_fines_inr", "offline_minutes", "offline_events", "uploads", "exports", "logins", "failed_logins",
            "audit_actions", "notifications", "notifications_critical"]
    t = {k: sum(r[k] for r in rows) for k in keys}
    t["unique_plates_max_day"] = max((r["unique_plates"] for r in rows), default=0)
    t["peak_vehicles"] = max((r["peak_vehicles"] for r in rows), default=0)
    t["peak_persons"] = max((r["peak_persons"] for r in rows), default=0)
    ups = [r["uptime_pct"] for r in rows if r["uptime_pct"] is not None]
    t["uptime_pct"] = round(sum(ups) / len(ups), 1) if ups else None
    kinds: dict[str, int] = {}
    for r in rows:
        for k, n in r["incidents_by_kind"].items():
            kinds[k] = kinds.get(k, 0) + n
    t["incidents_by_kind"] = kinds
    half = len(rows) // 2
    if half:
        prev, cur = rows[:half], rows[-half:]
        t["trend"] = {k: {"previous": sum(r[k] for r in prev), "current": sum(r[k] for r in cur)} for k in ("reads", "alerts", "incidents", "offline_minutes")}
    return t


def csv_bytes(rep: dict) -> bytes:
    import csv
    import io
    buf = io.StringIO()
    cols = ["day", "reads", "unique_plates", "busiest_camera", "busiest_camera_reads", "peak_hour", "alerts", "alerts_acked", "watchlist_hits",
            "challan_suggestions", "incidents", "incidents_high", "incidents_acked", "challans", "challans_approved", "challan_fines_inr",
            "avg_vehicles", "peak_vehicles", "peak_persons", "peak_traffic_hour", "cameras", "uptime_pct", "offline_minutes", "offline_events",
            "cameras_mostly_offline", "uploads", "exports", "logins", "failed_logins", "audit_actions", "notifications", "notifications_critical"]
    w = csv.writer(buf)
    w.writerow(cols + ["incidents_by_kind", "alerts_by_priority"])
    for r in rep["rows"]:
        w.writerow([r.get(c, "") if r.get(c) is not None else "" for c in cols]
                   + ["; ".join(f"{k}={v}" for k, v in sorted(r["incidents_by_kind"].items())), "; ".join(f"{k}={v}" for k, v in sorted(r["alerts_by_priority"].items()))])
    return buf.getvalue().encode()
