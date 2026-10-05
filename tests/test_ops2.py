"""v1.6 console additions: paginated / filtered audit log, in-console notifications, daily reports,
custom roles with live permissions, archival policies and runs."""
import datetime as dt
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
DB_URL = f"sqlite:///{HERE / '_ops2_test.db'}"
DATA = HERE / "_ops2_data"


@pytest.fixture(scope="module")
def client():
    import shutil
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_ops2_test.db").unlink(missing_ok=True)
    from uvp import db, storage
    from uvp.config import settings
    mp = pytest.MonkeyPatch()
    mp.setattr(settings, "database_url", DB_URL)
    mp.setattr(settings, "data_dir", DATA)
    mp.setattr(settings, "signing_key_file", DATA / "signing.key")
    mp.setattr(settings, "auth_file", ROOT / "config" / "auth.yaml")
    mp.setattr(settings, "object_storage", "local")
    mp.setattr(settings, "relay_api", "http://127.0.0.1:1")
    mp.setattr(settings, "sources_file", DATA / "no-sources.yaml")
    db.rebind(DB_URL)
    mp.setattr(storage, "_store", None)
    from uvp import auth as A
    cfg = dict(A.auth_cfg())
    cfg["providers"] = {**(cfg.get("providers") or {}), "local": {**((cfg.get("providers") or {}).get("local") or {}), "enabled": True, "keep_yaml_users": True}}
    mp.setattr(A, "auth_cfg", lambda: cfg)                  # demo accounts stay valid next to the database accounts created below
    from fastapi.testclient import TestClient
    from uvp.services.api import app
    with TestClient(app) as c:
        yield c
    mp.undo()


def tok(client, user="admin", pw="admin123"):
    r = client.post("/api/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


# ----------------------------------------------------------------------------- audit log
def test_audit_pagination_filters_sorting_and_export(client):
    h = tok(client)
    for _ in range(3):
        tok(client, "viewer", "viewer123")
    client.post("/api/auth/login", json={"username": "viewer", "password": "wrong"})
    legacy = client.get("/api/audit?limit=5", headers=h).json()
    assert isinstance(legacy, list) and len(legacy) == 5                                    # old shape still works
    page = client.get("/api/audit?page=1&page_size=3&sort=ts&order=desc", headers=h).json()
    assert set(page) >= {"items", "total", "page", "pages", "page_size"} and len(page["items"]) == 3 and page["pages"] >= 2
    p2 = client.get("/api/audit?page=2&page_size=3", headers=h).json()
    assert p2["items"][0]["id"] not in {r["id"] for r in page["items"]}
    asc = client.get("/api/audit?page=1&page_size=3&sort=ts&order=asc", headers=h).json()["items"]
    assert asc[0]["id"] < asc[-1]["id"]
    only_viewer = client.get("/api/audit?page=1&user=viewer", headers=h).json()
    assert only_viewer["total"] >= 4 and all(r["user"] == "viewer" for r in only_viewer["items"])
    failed = client.get("/api/audit?page=1&action=login_failed", headers=h).json()
    assert failed["total"] >= 1 and all(r["action"] == "login_failed" for r in failed["items"])
    multi = client.get("/api/audit?page=1&action=login,login_failed", headers=h).json()
    assert multi["total"] >= failed["total"] + 3
    q = client.get("/api/audit?page=1&q=viewer", headers=h).json()
    assert q["total"] >= 4
    since = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).isoformat()
    assert client.get(f"/api/audit?page=1&from={since}", headers=h).json()["total"] == 0
    facets = client.get("/api/audit/facets", headers=h).json()
    assert any(a["action"] == "login" for a in facets["actions"]) and any(u["user"] == "viewer" for u in facets["users"])
    csv = client.get("/api/audit/export.csv?user=viewer", headers=h)
    assert csv.status_code == 200 and csv.text.startswith("id,time_utc,user,action") and "login_failed" in csv.text
    assert client.get("/api/audit?page=1", headers=tok(client, "viewer", "viewer123")).status_code == 403
    acts = [a["action"] for a in client.get("/api/audit?limit=3", headers=h).json()]
    assert "audit_export" in acts                                                            # the export is itself audited


# ----------------------------------------------------------------------------- notifications
def test_notifications_scope_read_state_and_summary(client):
    from uvp.inbox import push
    push("camera", "Camera police-cam1 offline", "no RTSP answer", department="Police", severity="warn", ref_id="police-cam1", link="sources", feature="sources")
    push("alert", "Watchlist hit: MP04ZR7493", "stolen vehicle", department="Municipal", severity="critical", link="alerts")
    push("detection", "AI detection global OFF by admin", "", severity="warn", link="wall")
    push("security", "Account x created", "", feature="admin", link="admin")
    admin, police = tok(client), tok(client, "police_op", "police123")
    a = client.get("/api/notifications?page=1", headers=admin).json()
    assert a["total"] >= 4 and all(not r["read"] for r in a["items"])
    p = client.get("/api/notifications?page=1", headers=police).json()
    kinds = {r["kind"] for r in p["items"]}
    assert "camera" in kinds and "detection" in kinds and "alert" not in kinds           # Municipal alert hidden
    assert "security" not in kinds                                                        # admin-only feature gate
    un = client.get("/api/notifications/unread", headers=police).json()["unread"]
    assert un == p["total"]
    first = p["items"][0]["id"]
    r = client.post("/api/notifications/read", json={"ids": [first]}, headers=police).json()
    assert r["marked"] == 1 and r["unread"] == un - 1
    assert client.get("/api/notifications?page=1&unread=1", headers=police).json()["total"] == un - 1
    assert client.get("/api/notifications?page=1&kind=camera&q=offline", headers=police).json()["total"] == 1
    assert client.post("/api/notifications/unread", json={"ids": [first]}, headers=police).json()["unread"] == un
    r = client.post("/api/notifications/read", json={"all": True}, headers=police).json()
    assert r["unread"] == 0
    assert client.get("/api/notifications/unread", headers=admin).json()["unread"] >= 4        # per-user read state
    sm = client.get("/api/notifications/summary?days=7", headers=admin).json()
    assert sm["today"] >= 4 and sm["by_kind"]["camera"] >= 1 and sm["by_severity"]["critical"] >= 1 and len(sm["per_day"]) == 7
    # break-glass / alert broadcasts become notifications through the API's fan-out
    from uvp.services.api import broadcast
    broadcast("alert", {"id": "a1", "plate": "GJ01AB1234", "camera_id": "police-cam1", "department": "Police", "priority": "high", "reason": "test", "match": "exact"})
    assert client.get("/api/notifications?page=1&kind=alert", headers=police).json()["total"] == 1


# ----------------------------------------------------------------------------- daily reports
def test_daily_report_rows_totals_and_csv(client):
    from uvp.db import Alert, AnprEvent, CameraStatusLog, Incident, SessionLocal, TrafficCount, utcnow
    now = utcnow()
    ist = dt.timezone(dt.timedelta(minutes=330))
    midnight = now.astimezone(ist).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(dt.timezone.utc)
    base = now if now - midnight > dt.timedelta(hours=1) else midnight + dt.timedelta(hours=1)   # all rows inside today (IST)
    m = lambda k: base - dt.timedelta(minutes=k)  # noqa: E731
    with SessionLocal() as s:
        for i in range(5):
            s.add(AnprEvent(id=f"r{i:031d}", camera_id="police-cam1", department="Police", ts=m(5 * i + 1), plate=f"GJ01AB{i:04d}",
                            plate_raw="x", confidence=0.9, reads=1, clip_key="-", crop_key="-", frame_key="-"))
        s.add(AnprEvent(id="y" * 32, camera_id="police-cam1", department="Police", ts=midnight - dt.timedelta(hours=2), plate="GJ01AB0000",
                        plate_raw="x", confidence=0.9, reads=1, clip_key="-", crop_key="-", frame_key="-"))
        s.add(Alert(event_id="r" + "0" * 31, plate="GJ01AB0000", watchlist_plate="GJ01AB0000", camera_id="police-cam1", department="Police",
                    ts=m(10), priority="high", reason="t", ack_at=now))
        s.add(Incident(camera_id="police-cam1", department="Police", ts=m(10), kind="crowd", priority="high"))
        s.add(TrafficCount(camera_id="police-cam1", department="Police", ts=m(20), avg_vehicles=4.0, peak_vehicles=9, avg={"person": 12.0}))
        s.add(CameraStatusLog(camera_id="police-cam1", ts=m(40), status="offline"))
        s.add(CameraStatusLog(camera_id="police-cam1", ts=m(30), status="online"))
        s.commit()
    h = tok(client)
    rep = client.get("/api/reports/daily?days=3", headers=h).json()
    assert rep["days"] == 3 and len(rep["rows"]) == 3 and rep["rows"][-1]["day"] == rep["to"]
    today = rep["rows"][-1]
    assert today["reads"] == 5 and today["unique_plates"] == 5 and today["busiest_camera"] == "police-cam1"
    assert today["alerts"] == 1 and today["alerts_acked"] == 1 and today["watchlist_hits"] == 1
    assert today["incidents"] == 1 and today["incidents_by_kind"] == {"crowd": 1} and today["incidents_high"] == 1
    assert today["peak_vehicles"] == 9 and today["peak_persons"] == 12 and today["avg_vehicles"] == 4.0
    assert today["offline_events"] >= 1 and 8 <= today["offline_minutes"] <= 12 and today["uptime_pct"] is not None
    assert today["logins"] >= 1 and today["audit_actions"] >= 1
    assert rep["totals"]["reads"] == 6 and rep["totals"]["incidents_by_kind"]["crowd"] == 1
    muni = client.get("/api/reports/daily?days=3&department=Municipal", headers=h).json()
    assert muni["totals"]["reads"] == 0
    police_op = tok(client, "police_op", "police123")
    assert client.get("/api/reports/daily?days=3&department=Municipal", headers=police_op).status_code == 403
    assert client.get("/api/reports/daily?days=3", headers=tok(client, "viewer", "viewer123")).status_code == 403   # no `reports` feature
    csv = client.get("/api/reports/daily.csv?days=3", headers=h)
    assert csv.status_code == 200 and csv.text.startswith("day,reads,unique_plates") and csv.text.count("\n") == 4


# ----------------------------------------------------------------------------- roles
def test_custom_roles_and_live_permissions(client):
    from uvp import rbac
    admin = tok(client)
    roles = client.get("/api/roles", headers=admin).json()
    names = {r["name"] for r in roles["roles"]}
    assert {"viewer", "analyst", "supervisor", "admin"} <= names and any(f["id"] == "reports" for f in roles["features"])
    r = client.post("/api/roles", json={"name": "traffic_analyst", "description": "counts + reports only", "features": ["live", "reports", "search"]}, headers=admin)
    assert r.status_code == 201 and r.json()["features"] == ["live", "reports", "search"]
    assert client.post("/api/roles", json={"name": "traffic_analyst", "features": []}, headers=admin).status_code == 400   # duplicate
    assert client.post("/api/roles", json={"name": "Bad Name!", "features": []}, headers=admin).status_code == 400
    assert client.post("/api/roles", json={"name": "x_role", "features": ["fly"]}, headers=admin).status_code == 400          # unknown feature
    # a user with the custom role
    from uvp.db import SessionLocal
    from uvp import auth as A
    with SessionLocal() as s:
        A.create_account(s, "ta.user", "Password1x", "traffic_analyst", ["Police"], created_by="test")
        A.create_account(s, "root.admin", "Password1x", "admin", is_super=True, created_by="test")
        with pytest.raises(A.AccountError):
            A.create_account(s, "tb.user", "Password1x", "no_such_role")
        s.commit()
    ta = tok(client, "ta.user", "Password1x")
    assert client.patch("/api/roles/traffic_analyst", json={"features": ["live"]}, headers=admin).status_code == 403   # database accounts exist: super admin only
    admin = tok(client, "root.admin", "Password1x")
    assert client.get("/api/reports/daily?days=1", headers=ta).status_code == 200
    assert client.get("/api/audit?page=1", headers=ta).status_code == 403
    # change the role: the existing token follows without a new sign-in
    r = client.patch("/api/roles/traffic_analyst", json={"features": ["live", "reports", "search", "audit"]}, headers=admin)
    assert r.status_code == 200 and "audit" in r.json()["features"]
    rbac.invalidate()
    assert client.get("/api/audit?page=1", headers=ta).status_code == 200
    me = client.get("/api/auth/me", headers=ta).json()
    assert "audit" in me["features"] and me["role"] == "traffic_analyst"
    r = client.patch("/api/roles/traffic_analyst", json={"features": ["live"]}, headers=admin)
    rbac.invalidate()
    assert client.get("/api/reports/daily?days=1", headers=ta).status_code == 403
    # built-ins: admin keeps admin, viewer can be adjusted, none can be deleted; custom role in use cannot be deleted
    assert client.patch("/api/roles/admin", json={"features": ["live"]}, headers=admin).status_code == 400
    assert client.patch("/api/roles/viewer", json={"features": ["live", "sources", "registry", "reports"]}, headers=admin).status_code == 200
    rbac.invalidate()
    assert client.get("/api/reports/daily?days=1", headers=tok(client, "viewer", "viewer123")).status_code == 200
    client.patch("/api/roles/viewer", json={"features": ["live", "sources", "registry"]}, headers=admin)
    assert client.delete("/api/roles/viewer", headers=admin).status_code == 409
    assert client.delete("/api/roles/traffic_analyst", headers=admin).status_code == 409
    with SessionLocal() as s:
        A.update_account(s, "ta.user", role="viewer", actor="test")
        s.commit()
    assert client.delete("/api/roles/traffic_analyst", headers=admin).status_code == 200
    rbac.invalidate()
    assert "traffic_analyst" not in client.get("/api/roles", headers=admin).json()["roles"][0].get("name", "") and not rbac.is_role("traffic_analyst")
    acts = [a["action"] for a in client.get("/api/audit?limit=30", headers=admin).json()]
    assert {"role_create", "role_update", "role_delete"} <= set(acts)


# ----------------------------------------------------------------------------- archival
def test_archival_policies_preview_run_and_holds(client):
    from uvp.db import AnprEvent, Inbox, SessionLocal, TrafficCount, utcnow
    admin = tok(client)
    st = client.get("/api/archival", headers=admin).json()
    classes = {p["data_class"] for p in st["policies"] if p["department"] == "*"}
    assert {"recordings", "clips", "events", "audit", "notifications", "counts", "uploads"} <= classes
    audit_pol = next(p for p in st["policies"] if p["data_class"] == "audit" and p["department"] == "*")
    assert audit_pol["keep_days"] >= 180 and audit_pol["min_days"] == 180
    assert "usage" in st and "preview" in st and st["schedule"]["hour_ist"] in range(24)
    # validation
    assert client.put("/api/archival/policies/audit", json={"keep_days": 30}, headers=admin).status_code == 400
    assert client.put("/api/archival/policies/uploads", json={"keep_days": 30, "action": "archive"}, headers=admin).status_code == 400
    assert client.put("/api/archival/policies/nope", json={"keep_days": 30}, headers=admin).status_code == 400
    r = client.put("/api/archival/policies/counts", json={"keep_days": 7, "action": "archive"}, headers=admin)
    assert r.status_code == 200 and r.json()["source"] == "console" and r.json()["action"] == "archive"
    r = client.put("/api/archival/policies/events", json={"keep_days": 400, "department": "Police"}, headers=admin)
    assert r.status_code == 200 and r.json()["department"] == "Police"
    # data: old counts (archive), an old held event, an old unheld event, old notifications
    old = utcnow() - dt.timedelta(days=500)
    with SessionLocal() as s:
        s.add(TrafficCount(camera_id="police-cam1", department="Police", ts=utcnow() - dt.timedelta(days=10), avg_vehicles=1, peak_vehicles=2))
        s.add(AnprEvent(id="h" * 32, camera_id="police-cam1", department="Police", ts=old, plate="MP04ZR7493", plate_raw="x", confidence=0.9, reads=1, clip_key="-", crop_key="-", frame_key="-"))
        s.add(AnprEvent(id="g" * 32, camera_id="police-cam1", department="Police", ts=old, plate="MP70ZC2426", plate_raw="x", confidence=0.9, reads=1, clip_key="-", crop_key="-", frame_key="-"))
        s.add(Inbox(kind="system", title="old", ts=old))
        s.commit()
    hold = client.post("/api/admin/holds", json={"kind": "plate", "value": "MP04ZR7493", "reason": "FIR 1/2026", "reference": "FIR 1/2026"}, headers=admin).json()
    pv = client.get("/api/archival/preview", headers=admin).json()
    assert pv["counts"]["due"] == 1 and pv["events"]["due"] == 2 and pv["notifications"]["due"] >= 1
    run = client.post("/api/archival/run?wait=1", headers=admin).json()
    assert run["status"] == "ok" and run["removed"].get("Police/counts") == 1 and run["removed"].get("Police/events") == 1 and run["held"] == 1
    assert run["archived"].get("rows/counts") == 1 and run["removed"].get("notifications", 0) >= 1
    with SessionLocal() as s:
        assert s.get(AnprEvent, "h" * 32) is not None and s.get(AnprEvent, "g" * 32) is None
    from uvp.storage import store
    assert any(k.startswith("cold/counts/") for k, _, _ in store().list("cold/"))
    runs = client.get("/api/archival/runs", headers=admin).json()
    assert runs[0]["id"] == run["id"] and runs[0]["trigger"] == "manual"
    assert client.get("/api/notifications?page=1&kind=archival", headers=admin).json()["total"] >= 1
    client.delete(f"/api/admin/holds/{hold['id']}", headers=admin)
    assert client.delete("/api/archival/policies/counts", headers=admin).status_code == 200
    assert client.delete("/api/archival/policies/counts", headers=admin).status_code == 404
    r = client.put("/api/archival/schedule", json={"hour_ist": 3, "enabled": True}, headers=admin)
    assert r.status_code == 200 and r.json()["hour_ist"] == 3
    assert client.get("/api/archival", headers=tok(client, "viewer", "viewer123")).status_code == 403
