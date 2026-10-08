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


def test_health_and_readiness_endpoints(client):
    h = client.get("/healthz").json()
    assert h["ok"] is True and h["version"]
    r = client.get("/readyz")
    assert r.status_code == 200 and r.json()["database"] == "ok" and "relay" in r.json()


# ----------------------------------------------------------------------------- external APIs from the console
def test_integrations_configured_from_console(client, monkeypatch):
    import uvp.integrations as I
    admin = tok(client)
    st = client.get("/api/integrations", headers=admin).json()
    names = {i["name"]: i for i in st["integrations"]}
    assert {"vahan", "sarathi", "custom"} <= set(names) and names["sarathi"]["enabled"] is False and names["sarathi"]["has_secret"] is False
    # validation
    assert client.put("/api/integrations/sarathi", json={"enabled": True, "url": "https://sarathi.test/dl"}, headers=admin).status_code == 400   # no {dl}
    assert client.put("/api/integrations/sarathi", json={"enabled": True, "url": "https://sarathi.test/{dl}", "auth": "bearer"}, headers=admin).status_code == 400  # no secret
    assert client.put("/api/integrations/nope", json={"enabled": False}, headers=admin).status_code == 400
    r = client.put("/api/integrations/sarathi", json={"enabled": True, "url": "https://sarathi.test/api/{dl}", "auth": "bearer", "secret": "tok-123",
                                                      "extra_headers": '{"X-Client": "uvp"}', "cache_s": 60}, headers=admin)
    assert r.status_code == 200 and r.json()["has_secret"] is True and r.json()["source"] == "console" and "secret" not in r.json()
    assert client.get("/api/integrations", headers=admin).json()["integrations"][1]["extra_headers"] == {"X-Client": "uvp"}
    calls = []

    class R:
        ok, status_code, text = True, 200, "{}"
        def json(self):
            return {"holder": {"name": "RAM KUMAR"}, "valid_till": "2031-05-01", "classes": ["LMV", "MCWG"]}
    monkeypatch.setattr(I.requests, "get", lambda url, headers=None, params=None, auth=None, timeout=0: (calls.append((url, headers)) or R()))
    t = client.post("/api/integrations/sarathi/test?value=GJ01 2020 0012345", headers=admin).json()
    assert t["ok"] and calls[0][0] == "https://sarathi.test/api/GJ01%202020%200012345" and calls[0][1]["Authorization"] == "Bearer tok-123" and calls[0][1]["X-Client"] == "uvp"
    assert ("holder / name", "RAM KUMAR") in [tuple(x) for x in t["rows"]]
    assert client.get("/api/integrations", headers=admin).json()["integrations"][1]["last_test"]["ok"] is True
    # lookup by an investigator, cached, audited; viewer refused
    lk = client.get("/api/lookup/sarathi/GJ01 2020 0012345", headers=admin).json()
    assert lk["data"]["valid_till"] == "2031-05-01" and len(calls) == 2
    client.get("/api/lookup/sarathi/GJ0120200012345", headers=admin)
    assert len(calls) == 2
    assert client.get("/api/lookup/sarathi/x", headers=tok(client, "viewer", "viewer123")).status_code == 403
    assert client.get("/api/lookup/vahan/GJ01AB1234", headers=admin).status_code == 501     # vahan still unconfigured
    # keep secret when blank, clear on request, disable
    r = client.put("/api/integrations/sarathi", json={"enabled": True, "url": "https://sarathi.test/api/{dl}", "auth": "bearer"}, headers=admin).json()
    assert r["has_secret"] is True
    r = client.put("/api/integrations/sarathi", json={"enabled": False, "url": "https://sarathi.test/api/{dl}", "auth": "bearer", "clear_secret": True}, headers=admin).json()
    assert r["has_secret"] is False and r["enabled"] is False
    assert client.get("/api/lookup/sarathi/GJ0120200012345", headers=admin).status_code == 501
    acts = [a["action"] for a in client.get("/api/audit?limit=20", headers=admin).json()]
    assert {"integration_update", "integration_test", "sarathi_lookup"} <= set(acts)


# ----------------------------------------------------------------------------- VIP routes / corridors
def test_routes_corridor_and_road_filter(client, monkeypatch):
    from uvp import corridors
    from uvp.db import Camera, SessionLocal
    import uvp.services.routes_corridors as RC
    admin = tok(client)
    # cameras: along NH24 Amroha->Delhi (roughly a line), one in Delhi off the highway, one far away in Ahmedabad
    cams = [("nh24-amroha", "NH24 Amroha toll", 28.905, 78.470, "Amroha", "NH-24 toll plaza, Amroha"),
            ("nh24-garhmukteshwar", "NH24 Garhmukteshwar bridge", 28.790, 78.100, "Hapur", "NH24 Ganga bridge"),
            ("nh24-hapur", "NH24 Hapur bypass", 28.730, 77.780, "Hapur", "NH 24 bypass"),
            ("nh24-ghaziabad", "NH24 Ghaziabad", 28.645, 77.430, "Ghaziabad", "NH-24, Vijay Nagar"),
            ("nh24-delhi-nizamuddin", "NH24 Nizamuddin bridge", 28.595, 77.255, "Delhi", "NH24 Sarai Kale Khan, Delhi"),
            ("delhi-cp", "Connaught Place", 28.631, 77.219, "Delhi", "Outer circle, CP, New Delhi"),
            ("amd-paldi", "Paldi circle", 23.015, 72.560, "Ahmedabad", "Paldi, Ahmedabad")]
    with SessionLocal() as s:
        for cid, name, lat, lon, zone, addr in cams:
            s.add(Camera(id=cid, name=name, department="Police", source_id="registry", lat=lat, lon=lon, zone=zone, address=addr, status="registered"))
        s.commit()
    # no internet in tests: geocoder + router are stubbed
    places = {"amroha": (28.903, 78.467), "delhi": (28.613, 77.209)}
    monkeypatch.setattr(RC, "_geocode", lambda q: [{"lat": places[q.lower()][0], "lon": places[q.lower()][1], "label": q}] if q.lower() in places else [])
    monkeypatch.setattr(corridors.settings, "routing_url", "")        # straight line
    # 1. corridor Amroha -> Delhi with a wide buffer: the highway cameras in order, not CP, not Ahmedabad
    r = client.post("/api/routes", json={"name": "VIP: Amroha to Delhi", "waypoints": ["Amroha", "Delhi"], "buffer_m": 8000, "priority": "vip"}, headers=admin)
    assert r.status_code == 201, r.text
    rt = r.json()
    ids = [c["id"] for c in rt["cameras"]]
    assert ids[0] == "nh24-amroha" and ids[1] == "nh24-garhmukteshwar" and "amd-paldi" not in ids
    assert {"nh24-ghaziabad", "nh24-delhi-nizamuddin"} <= set(ids)                  # CP (2 km from the Delhi end point) may be in too
    assert rt["cameras"][0]["km"] == 0.0 and rt["cameras"][-1]["km"] > 100 and rt["length_km"] > 100
    assert len(rt["path"]) == 2 and rt["waypoints"][0]["name"] == "Amroha"
    # 2. road + area filter only: NH24 cameras in Delhi
    r = client.post("/api/routes", json={"name": "NH24 in Delhi", "road": "NH24, NH-24, NH 24", "area": "Delhi"}, headers=admin)
    assert r.status_code == 201 and [c["id"] for c in r.json()["cameras"]] == ["nh24-delhi-nizamuddin"]
    # 3. combined: corridor + road keyword, excluding one, forcing CP in
    r = client.post("/api/routes", json={"name": "NH24 corridor", "waypoints": ["Amroha", "Delhi"], "buffer_m": 8000, "road": "NH24",
                                         "exclude_ids": ["nh24-hapur"], "camera_ids": ["delhi-cp"]}, headers=admin).json()
    ids = [c["id"] for c in r["cameras"]]
    assert "nh24-hapur" not in ids and "delhi-cp" in ids and "nh24-ghaziabad" in ids
    assert next(c for c in r["cameras"] if c["id"] == "delhi-cp")["reason"] == "added"
    # preview without saving, validation, geocode failure
    pv = client.post("/api/routes/preview", json={"waypoints": ["Amroha", "Delhi"], "buffer_m": 1000}, headers=admin).json()
    assert pv["camera_count"] >= 1 and pv["length_km"] > 100
    one = client.post("/api/routes", json={"name": "Around Amroha toll", "waypoints": ["Amroha"], "buffer_m": 3000}, headers=admin)
    assert one.status_code == 201 and [c["id"] for c in one.json()["cameras"]] == ["nh24-amroha"] and one.json()["description"].startswith("around Amroha")
    assert client.post("/api/routes", json={"name": "x"}, headers=admin).status_code == 400
    assert client.post("/api/routes", json={"name": "x", "waypoints": ["Nowhere"]}, headers=admin).status_code == 400
    # list, update buffer, delete; viewer may read but not write
    lst = client.get("/api/routes", headers=admin).json()
    assert [x["name"] for x in lst][0] == "VIP: Amroha to Delhi" and lst[0]["camera_count"] >= 4
    up = client.patch(f"/api/routes/{rt['id']}", json={"buffer_m": 100}, headers=admin).json()
    assert up["camera_count"] < rt["camera_count"]
    viewer = tok(client, "viewer", "viewer123")
    assert client.get(f"/api/routes/{rt['id']}", headers=viewer).status_code == 200
    assert client.patch(f"/api/routes/{rt['id']}", json={"buffer_m": 50}, headers=viewer).status_code == 403
    # a route that matches nothing says which camera is nearest and what buffer would include it
    far = client.post("/api/routes", json={"name": "Nowhere near", "waypoints": [{"name": "Lucknow", "lat": 26.85, "lon": 80.95}], "buffer_m": 500}, headers=admin).json()
    assert far["camera_count"] == 0 and far["nearest"]["id"] == "nh24-amroha" and far["nearest"]["suggest_buffer_m"] == 20000
    pv = client.post("/api/routes/preview", json={"waypoints": [{"name": "near toll", "lat": 28.92, "lon": 78.47}], "buffer_m": 500}, headers=admin).json()
    assert pv["camera_count"] == 0 and pv["nearest"]["id"] == "nh24-amroha" and 1600 <= pv["nearest"]["suggest_buffer_m"] <= 2000
    assert rt["nearest"] is None
    # drop-down catalogue: areas (from zone / address), saved places, camera sites - all with coordinates; q filters; geocode appends map hits
    pl = client.get("/api/routes/places", headers=viewer).json()["items"]
    kinds = {p["kind"] for p in pl}
    assert {"area", "place", "camera"} <= kinds and all(p["lat"] is not None for p in pl)
    delhi = next(p for p in pl if p["kind"] == "area" and p["name"] == "Delhi")
    assert delhi["count"] == 2 and 28.59 < delhi["lat"] < 28.64
    assert any(p["kind"] == "place" and p["name"] == "Amroha" for p in pl)
    q = client.get("/api/routes/places?q=hapur", headers=viewer).json()["items"]
    assert q and all("hapur" in (p["name"] + p["label"]).lower() for p in q) and {"area", "camera"} <= {p["kind"] for p in q}
    monkeypatch.setattr(RC, "_geocode", lambda q: [{"lat": 28.6, "lon": 77.2, "label": "Janpath, New Delhi, Delhi, India"}])
    g = client.get("/api/routes/places?q=janpath&geocode=true", headers=viewer).json()["items"]
    assert g[-1]["kind"] == "map" and g[-1]["name"] == "Janpath" and g[-1]["lat"] == 28.6
    assert not any(p["kind"] == "map" for p in client.get("/api/routes/places?q=ja&geocode=true", headers=viewer).json()["items"])   # 3+ letters for the map
    assert client.delete(f"/api/routes/{rt['id']}", headers=admin).status_code == 200
    assert client.get(f"/api/routes/{rt['id']}", headers=admin).status_code == 404
    # geometry helper: distance to a polyline and chainage
    d, ch = corridors.distance_to_path(28.79, 78.10, [[28.903, 78.467], [28.613, 77.209]])
    assert d < 8000 and 30000 < ch < 60000


# ----------------------------------------------------------------------------- camera-only accounts, permission-aware notifications, preferences
def test_camera_only_user_sees_only_her_cameras_and_notifications(client):
    from uvp import auth as A
    from uvp.db import Camera, SessionLocal
    from uvp.inbox import push, allowed_for
    with SessionLocal() as s:
        for cid, dept in (("gate-a", "Police"), ("gate-b", "Police"), ("muni-x", "Municipal")):
            if s.get(Camera, cid) is None:
                s.add(Camera(id=cid, name=cid.upper(), department=dept, source_id="registry", status="registered", lat=23.0, lon=72.5))
        A.create_account(s, "guard.a", "Password1x", "viewer", departments=[], cameras=["gate-a"], created_by="test")   # no department, one camera
        s.commit()
    g = tok(client, "guard.a", "Password1x")
    cams = {c["id"] for c in client.get("/api/cameras", headers=g).json()}
    assert "gate-a" in cams and "gate-b" not in cams and "muni-x" not in cams
    me = client.get("/api/auth/me", headers=g).json()
    assert me["departments"] == [] and me["cameras"] == ["gate-a"]
    push("alert", "Watchlist hit at gate A", "", department="Police", severity="critical", link="alerts", camera_id="gate-a")
    push("alert", "Watchlist hit at gate B", "", department="Police", severity="critical", link="alerts", camera_id="gate-b")
    push("detection", "AI detection note", "", severity="info", link="wall")
    titles = [n["title"] for n in client.get("/api/notifications?page=1", headers=g).json()["items"]]
    assert "Watchlist hit at gate A" in titles and "Watchlist hit at gate B" not in titles and "AI detection note" in titles
    u = A.verify_token(g["Authorization"][7:])
    assert allowed_for(u, {"kind": "alert", "department": "Police", "camera_id": "gate-a", "severity": "critical"}) is True
    assert allowed_for(u, {"kind": "alert", "department": "Police", "camera_id": "gate-b", "severity": "critical"}) is False
    # preferences: only critical alerts, nothing else
    p = client.put("/api/notifications/preferences", json={"kinds": ["alert"], "min_severity": "critical", "speak": True}, headers=g).json()["preferences"]
    assert p["kinds"] == ["alert"] and p["min_severity"] == "critical" and p["speak"] is True
    titles = [n["title"] for n in client.get("/api/notifications?page=1", headers=g).json()["items"]]
    assert titles == ["Watchlist hit at gate A"]
    assert allowed_for(u, {"kind": "detection", "department": "*", "severity": "info"}) is False
    assert client.get("/api/notifications/preferences", headers=g).json()["preferences"]["min_severity"] == "critical"
    client.put("/api/notifications/preferences", json={"kinds": [], "min_severity": "info"}, headers=g)      # [] = all kinds again
    assert len(client.get("/api/notifications?page=1", headers=g).json()["items"]) >= 2


# ----------------------------------------------------------------------------- Admin -> Permissions (camera permission table)
def test_camera_permissions_table_applies_live_and_scopes_actions(client):
    from uvp import auth as A
    from uvp.db import Camera, SessionLocal
    admin = tok(client)
    with SessionLocal() as s:
        for cid, dept in (("gate-a", "Police"), ("gate-b", "Police"), ("muni-x", "Municipal"), ("muni-y", "Municipal")):
            if s.get(Camera, cid) is None:
                s.add(Camera(id=cid, name=cid.upper(), department=dept, source_id="registry", status="registered", lat=23.0, lon=72.5))
        A.create_account(s, "guard.p", "Password1x", "viewer", departments=[], cameras=[], created_by="test")   # sees nothing on his own
        s.commit()
    g = tok(client, "guard.p", "Password1x")
    assert client.get("/api/cameras", headers=g).json() == []
    opts = client.get("/api/permissions/options", headers=admin).json()
    assert {"gate-a", "muni-x"} <= {c["id"] for c in opts["cameras"]} and "Police" in opts["departments"]
    assert any(u["username"] == "guard.p" for u in opts["users"]) and any(r["name"] == "viewer" for r in opts["roles"])
    assert [p["id"] for p in opts["perms"]] == ["live", "playback", "export", "search", "alerts", "edit"]
    # 1. user grant on one camera, live + playback: applies to the existing session at once (no re-login)
    r = client.post("/api/permissions", json={"scope_kind": "camera", "scope_value": "gate-a", "grantee_kind": "user", "grantee": "guard.p",
                                              "perms": ["live", "playback"], "reason": "night shift"}, headers=admin)
    assert r.status_code == 201, r.text
    row = r.json()
    assert row["status"] == "active" and row["scope_label"] == "GATE-A" and row["perms"] == ["live", "playback"]
    cams = {c["id"]: c for c in client.get("/api/cameras", headers=g).json()}
    assert set(cams) == {"gate-a"} and cams["gate-a"]["perms"] == ["live", "playback"]
    mine = client.get("/api/permissions/mine", headers=g).json()
    assert mine["cameras"] == {"gate-a": ["live", "playback"]}
    # playback allowed on gate-a (the feature came with the permission), export is not
    assert client.get("/api/cameras/gate-a/recordings", headers=g).status_code == 200
    assert client.get("/api/cameras/gate-b/recordings", headers=g).status_code == 404
    me = client.get("/api/auth/me", headers=g).json()
    assert "playback" in me["features"] and "export" not in me["features"]
    # 2. role grant on a department: every viewer sees Municipal cameras, live only
    r2 = client.post("/api/permissions", json={"scope_kind": "department", "scope_value": "Municipal", "grantee_kind": "role", "grantee": "viewer",
                                               "perms": ["live"]}, headers=admin).json()
    cams = {c["id"]: c for c in client.get("/api/cameras", headers=g).json()}
    assert {"gate-a", "muni-x", "muni-y"} <= set(cams) and cams["muni-x"]["perms"] == ["live"] and cams["gate-a"]["perms"] == ["live", "playback"]
    assert client.get("/api/cameras/muni-x/recordings", headers=g).status_code == 404
    # an admin's own cameras are untouched by the table (everything the role allows)
    adm = {c["id"]: c for c in client.get("/api/cameras", headers=admin).json()}
    assert set(adm["gate-b"]["perms"]) == set(opts and ["live", "playback", "export", "search", "alerts", "edit"])
    # 3. granting the same scope again replaces the set; patch changes expiry; list filters; validation
    r3 = client.post("/api/permissions", json={"scope_kind": "camera", "scope_value": "gate-a", "grantee_kind": "user", "grantee": "guard.p",
                                               "perms": ["live", "export"]}, headers=admin)
    assert r3.status_code == 201 and r3.json()["id"] == row["id"] and r3.json()["perms"] == ["live", "export"]
    assert client.get("/api/cameras/gate-a/recordings", headers=g).status_code in (403, 404)     # playback feature gone with the permission
    lst = client.get("/api/permissions", headers=admin).json()
    assert lst["total"] == 2 and {x["grantee_kind"] for x in lst["items"]} == {"user", "role"}
    assert client.get("/api/permissions?grantee_kind=role", headers=admin).json()["total"] == 1
    assert client.get("/api/permissions?q=guard", headers=admin).json()["total"] == 1
    assert client.get("/api/permissions?scope=department", headers=admin).json()["items"][0]["scope_value"] == "Municipal"
    soon = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=2)).isoformat()
    up = client.patch(f"/api/permissions/{row['id']}", json={"expires_at": soon}, headers=admin).json()
    assert up["expires_at"] and up["status"] == "active"
    assert client.post("/api/permissions", json={"scope_kind": "camera", "scope_value": "nope", "grantee_kind": "user", "grantee": "guard.p", "perms": ["live"]}, headers=admin).status_code == 404
    assert client.post("/api/permissions", json={"scope_kind": "all", "grantee_kind": "role", "grantee": "ghost", "perms": ["live"]}, headers=admin).status_code == 404
    assert client.post("/api/permissions", json={"scope_kind": "all", "grantee_kind": "user", "grantee": "guard.p", "perms": []}, headers=admin).status_code == 400
    assert client.post("/api/permissions", json={"scope_kind": "all", "grantee_kind": "user", "grantee": "guard.p", "perms": ["fly"]}, headers=admin).status_code == 400
    assert client.get("/api/permissions", headers=g).status_code == 403
    # 4. revoke -> history; access gone immediately
    assert client.delete(f"/api/permissions/{row['id']}", headers=admin).json()["ok"] is True
    assert client.delete(f"/api/permissions/{r2['id']}", headers=admin).json()["ok"] is True
    assert client.get("/api/permissions", headers=admin).json()["total"] == 0
    hist = client.get("/api/permissions?status=history", headers=admin).json()
    assert hist["total"] == 2 and all(x["status"] == "revoked" and x["revoked_by"] == "admin" for x in hist["items"])
    assert client.get("/api/cameras", headers=g).json() == []
    acts = [a["action"] for a in client.get("/api/audit?limit=50", headers=admin).json()]
    assert {"perm_grant", "perm_update", "perm_revoke"} <= set(acts)
    # 5. several scopes at once (two cameras + a department) -> one row each; 'all' swallows the rest
    m = client.post("/api/permissions", json={"scopes": [{"scope_kind": "camera", "scope_value": "gate-a"}, {"scope_kind": "camera", "scope_value": "gate-b"},
                                              {"scope_kind": "department", "scope_value": "Municipal"}], "grantee_kind": "user", "grantee": "guard.p", "perms": ["live"]}, headers=admin)
    assert m.status_code == 201 and m.json()["count"] == 3 and {x["scope_value"] for x in m.json()["items"]} == {"gate-a", "gate-b", "Municipal"}
    assert {c["id"] for c in client.get("/api/cameras", headers=g).json()} == {"gate-a", "gate-b", "muni-x", "muni-y"}
    a = client.post("/api/permissions", json={"scopes": [{"scope_kind": "all"}, {"scope_kind": "camera", "scope_value": "gate-a"}], "grantee_kind": "user", "grantee": "guard.p", "perms": ["live"]}, headers=admin).json()
    assert a["count"] == 1 and a["items"][0]["scope_kind"] == "all"
    for x in client.get("/api/permissions", headers=admin).json()["items"]:
        client.delete(f"/api/permissions/{x['id']}", headers=admin)
    # 6. a VIP route as scope: follows the route's cameras
    with SessionLocal() as s:
        for cid, lat, lon in (("rt-1", 28.905, 78.470), ("rt-2", 28.790, 78.100)):
            if s.get(Camera, cid) is None:
                s.add(Camera(id=cid, name=cid.upper(), department="Police", source_id="registry", status="registered", lat=lat, lon=lon))
        s.commit()
    rt = client.post("/api/routes", json={"name": "Escort NH24", "waypoints": [{"name": "A", "lat": 28.905, "lon": 78.470}, {"name": "B", "lat": 28.790, "lon": 78.100}],
                                          "buffer_m": 2000, "follow_roads": False}, headers=admin).json()
    assert {"rt-1", "rt-2"} <= {c["id"] for c in rt["cameras"]}          # (other tests' NH24 cameras may be on the line too)
    opts = client.get("/api/permissions/options", headers=admin).json()
    assert any(r["id"] == rt["id"] and r["camera_count"] >= 2 for r in opts["routes"])
    pr = client.post("/api/permissions", json={"scope_kind": "route", "scope_value": rt["id"], "grantee_kind": "user", "grantee": "guard.p", "perms": ["live", "playback"]}, headers=admin)
    assert pr.status_code == 201 and pr.json()["scope_label"] == "Route: Escort NH24"
    cams = {c["id"]: c for c in client.get("/api/cameras", headers=g).json()}
    assert {"rt-1", "rt-2"} <= set(cams) and "gate-a" not in cams and cams["rt-1"]["perms"] == ["live", "playback"]
    assert client.get("/api/cameras/rt-2/recordings", headers=g).status_code == 200
    assert client.post("/api/permissions", json={"scope_kind": "route", "scope_value": "nope", "grantee_kind": "user", "grantee": "guard.p", "perms": ["live"]}, headers=admin).status_code == 404
    client.delete(f"/api/permissions/{pr.json()['id']}", headers=admin)
    assert client.get("/api/cameras", headers=g).json() == []
    titles = [n["title"] for n in client.get("/api/notifications?page=1&kind=security", headers=admin).json()["items"]]
    assert any(t.startswith("Camera permission granted") for t in titles) and any(t.startswith("Camera permission revoked") for t in titles)


# ----------------------------------------------------------------------------- geofences
def test_geofences_circle_polygon_and_event_notification(client):
    from uvp import geofences as G
    from uvp.db import Camera, SessionLocal
    from uvp.inbox import from_event
    admin = tok(client)
    with SessionLocal() as s:
        for cid, lat, lon in (("gf-in-1", 23.0300, 72.5800), ("gf-in-2", 23.0310, 72.5790), ("gf-out", 23.0900, 72.6500)):
            if s.get(Camera, cid) is None:
                s.add(Camera(id=cid, name=cid, department="Police", source_id="registry", status="registered", lat=lat, lon=lon))
        s.commit()
    pv = client.post("/api/geofences/preview", json={"kind": "circle", "lat": 23.0305, "lon": 72.5795, "radius_m": 300}, headers=admin).json()
    assert {c["id"] for c in pv["cameras"]} == {"gf-in-1", "gf-in-2"} and pv["area_km2"] > 0
    r = client.post("/api/geofences", json={"name": "Paldi circle zone", "kind": "circle", "lat": 23.0305, "lon": 72.5795, "radius_m": 300,
                                            "notify_kinds": ["alert", "incident"], "severity": "critical"}, headers=admin)
    assert r.status_code == 201 and r.json()["camera_count"] == 2
    fid = r.json()["id"]
    poly = client.post("/api/geofences", json={"name": "East box", "kind": "polygon", "notify_kinds": [], "polygon": [[23.08, 72.64], [23.10, 72.64], [23.10, 72.66], [23.08, 72.66]]}, headers=admin).json()
    assert [c["id"] for c in poly["cameras"]] == ["gf-out"] and poly["lat"] is not None
    assert client.post("/api/geofences", json={"name": "bad", "kind": "polygon", "polygon": [[1, 2]]}, headers=admin).status_code == 400
    assert client.post("/api/geofences", json={"name": "bad", "kind": "circle"}, headers=admin).status_code == 400
    assert G.point_in_polygon(23.09, 72.65, poly["polygon"]) and not G.point_in_polygon(23.0, 72.5, poly["polygon"])
    # an alert inside the circle raises a geofence notification; outside does not
    G._invalidate()
    from_event("alert", {"id": "a-gf", "plate": "GJ01AB1234", "camera_id": "gf-in-1", "department": "Police", "priority": "high", "match": "exact", "reason": "stolen"})
    from_event("alert", {"id": "a-gf2", "plate": "GJ01AB9999", "camera_id": "gf-out", "department": "Police", "priority": "high", "match": "exact", "reason": "stolen"})
    gf = client.get("/api/notifications?page=1&kind=geofence", headers=admin).json()["items"]
    assert len(gf) == 1 and gf[0]["title"].startswith("Paldi circle zone: watchlist hit GJ01AB1234") and gf[0]["severity"] == "critical" and gf[0]["camera_id"] == "gf-in-1"
    assert len(client.get("/api/geofences", headers=admin).json()) >= 2
    up = client.patch(f"/api/geofences/{fid}", json={"radius_m": 50}, headers=admin).json()
    assert up["camera_count"] == 0
    assert client.delete(f"/api/geofences/{fid}", headers=tok(client, "viewer", "viewer123")).status_code == 403
    assert client.delete(f"/api/geofences/{fid}", headers=admin).json()["ok"]
    acts = [a["action"] for a in client.get("/api/audit?limit=15", headers=admin).json()]
    assert {"geofence_create", "geofence_update", "geofence_delete"} <= set(acts)


def test_geocode_is_biased_to_the_camera_area(monkeypatch):
    """Nominatim gets a viewbox around the cameras, and a hit inside it wins over a 'more important' one far away."""
    import requests
    import uvp.services.routes_registry as RR
    seen = {}

    class R:
        def raise_for_status(self):
            pass

        def json(self):
            return [{"lat": "28.6256", "lon": "77.2190", "display_name": "Janpath, New Delhi", "importance": 0.7},
                    {"lat": "23.0300", "lon": "72.5700", "display_name": "Janpath, Ahmedabad", "importance": 0.2}]

    def fake_get(url, params=None, headers=None, timeout=0):
        seen.update(params)
        return R()
    monkeypatch.setattr(requests, "get", fake_get)
    out = RR.geocode("Janpath", near=(23.02, 72.57))
    assert "viewbox" in seen and seen["bounded"] == 0
    assert out[0]["label"].endswith("Ahmedabad") and out[1]["label"].endswith("New Delhi")
    seen.clear()
    out = RR.geocode("Janpath")
    assert "viewbox" not in seen and out[0]["label"].endswith("New Delhi")
