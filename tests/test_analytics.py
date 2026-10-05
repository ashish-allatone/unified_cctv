"""Phase-3 analytics: COCO detector + vehicle attributes, traffic rules (wrong way, over-speed,
triple riding), zone analytics (intrusion, parking, red light, crowd, abandoned object), incident
ingest with plate association and challan drafting, challan review + e-challan hand-off, hotlist sync,
face-search legal gate."""
import datetime as dt
import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
DB_URL = f"sqlite:///{HERE / '_ana_test.db'}"
DATA = HERE / "_ana_data"
os.environ.setdefault("RELAY_API", "http://127.0.0.1:1")

from uvp.analytics.detector import Det  # noqa: E402
from uvp.analytics.zones import ZoneAnalyzer, Tracker, signal_is_red  # noqa: E402

T0 = dt.datetime(2026, 9, 22, 23, 0, tzinfo=dt.timezone.utc)   # 04:30 IST -> inside the 22:00-05:00 window


@pytest.fixture(scope="module")
def client():
    import shutil
    shutil.rmtree(HERE / "_ana_data", ignore_errors=True)
    (HERE / "_ana_test.db").unlink(missing_ok=True)
    from uvp import db, storage
    from uvp.config import settings
    mp = pytest.MonkeyPatch()
    mp.setattr(settings, "database_url", DB_URL)
    mp.setattr(settings, "data_dir", DATA)
    mp.setattr(settings, "signing_key_file", DATA / "signing.key")
    mp.setattr(settings, "auth_file", ROOT / "config" / "auth.yaml")
    mp.setattr(settings, "object_storage", "local")
    mp.setattr(settings, "relay_api", "http://127.0.0.1:1")
    db.rebind(settings.database_url)
    mp.setattr(storage, "_store", None)
    from fastapi.testclient import TestClient
    from uvp.services.api import app
    with TestClient(app) as c:
        from uvp.db import Camera, SessionLocal, Source
        with SessionLocal() as s:
            s.merge(Source(id="police", department="Police", name="P", adapter="rtsp"))
            s.merge(Source(id="municipal", department="Municipal", name="M", adapter="rtsp"))
            for cid, dep in (("police-cam1", "Police"), ("police-cam2", "Police"), ("muni-cam1", "Municipal"), ("muni-cam2", "Municipal")):
                s.merge(Camera(id=cid, source_id="police" if dep == "Police" else "municipal", department=dep, name=cid, anpr_enabled=True))
            s.commit()
        yield c
    mp.undo()
    shutil.rmtree(HERE / "_ana_data", ignore_errors=True)
    (HERE / "_ana_test.db").unlink(missing_ok=True)


def tok(client, user="admin", pw="admin123"):
    r = client.post("/api/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200 and "token" in r.json(), r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def ev(eid, cam, plate, ts, direction="unknown", attrs=None, dept=None):
    return {"id": eid, "camera_id": cam, "department": dept or ("Police" if cam.startswith("police") else "Municipal"),
            "ts": ts.isoformat(), "plate": plate, "plate_raw": plate, "plate_valid": "?" not in plate, "confidence": 0.9,
            "reads": 3, "direction": direction, "crop_path": "", "frame_path": "", "tags": [], "attrs": attrs or {}}


# ----------------------------------------------------------------------------- detector + attributes
def test_detector_and_attributes_on_real_photo():
    import cv2
    from uvp.analytics.attributes import colour_name, plate_colour, vehicle_attributes
    from uvp.analytics.detector import detector
    det = detector()
    assert det is not None, "bundled yolox_nano.onnx should load"
    img = cv2.imread(str(ROOT / "docs" / "test_assets" / "street.jpg"))
    dets = det(img)
    assert any(d.cls == "car" for d in dets) and any(d.cls == "bicycle" for d in dets)
    car = [d for d in dets if d.cls == "car"][0]
    x1, y1, x2, y2 = car.bbox
    pb = (x1 + (x2 - x1) // 3, y2 - 30, x2 - (x2 - x1) // 3, y2 - 8)
    a = vehicle_attributes(img, pb, img[pb[1]:pb[3], pb[0]:pb[2]])
    assert a["vehicle_type"] == "car" and a["type_source"] == "detector" and a["vehicle_colour"] in ("white", "silver", "grey")
    assert colour_name(np.full((20, 20, 3), (30, 30, 210), np.uint8))[0] == "red"
    assert plate_colour(np.full((30, 90, 3), (40, 200, 230), np.uint8)) == "yellow"
    # geometry fallback when no detection contains the plate
    b = vehicle_attributes(np.zeros((300, 300, 3), np.uint8), (100, 100, 150, 130), np.zeros((30, 50, 3), np.uint8))
    assert b["vehicle_type"] == "two_wheeler" and b["type_source"] == "plate_geometry"


# ----------------------------------------------------------------------------- traffic rules through the indexer
def test_wrong_way_over_speed_triple_riding_create_alerts_and_challans(client):
    h = tok(client)
    secret = {"X-Internal-Secret": "change-me-internal"}
    t = T0
    # police-cam1 allows "away"; a "towards" read is wrong-way
    r = client.post("/internal/events", json=ev("a" * 32, "police-cam1", "MH12AB1234", t, "towards"), headers=secret)
    assert r.status_code == 200 and r.json()["alerts"] == 1
    # same plate at police-cam2 60 s later over 1500 m -> 90 km/h > 60
    r = client.post("/internal/events", json=ev("b" * 32, "police-cam2", "MH12AB1234", t + dt.timedelta(seconds=60), "towards"), headers=secret)
    assert r.json()["alerts"] == 1
    # triple riding via attributes
    r = client.post("/internal/events", json=ev("c" * 32, "muni-cam1", "MP04ZR7493", t, "away",
                                                 {"vehicle_type": "two_wheeler", "riders": 3, "vehicle_colour": "red", "plate_colour": "white"}), headers=secret)
    assert r.json()["alerts"] == 1
    # non-standard plate still drafts a challan
    r = client.post("/internal/events", json=ev("d" * 32, "muni-cam1", "MP04????", t), headers=secret)
    assert r.json()["alerts"] == 1
    alerts = client.get("/api/alerts?limit=50", headers=h).json()
    kinds = {a["watchlist_plate"] for a in alerts}
    assert {"WRONG_WAY", "OVER_SPEED", "TRIPLE_RIDING", "NON_STANDARD_PLATE"} <= kinds
    drafts = client.get("/api/challans?status=draft", headers=h).json()
    by = {c["offence"]: c for c in drafts}
    assert by["over_speed"]["fine_inr"] == 1000 and "90 km/h" in by["over_speed"]["detail"]
    assert by["wrong_way"]["section"].startswith("s.184") and by["triple_riding"]["plate"] == "MP04ZR7493"
    assert all(c["number"].startswith("CH-2026-") for c in drafts)
    # attributes are searchable and tagged
    evs = client.get("/api/events?vehicle_type=two_wheeler&colour=red", headers=h).json()["events"]
    assert len(evs) == 1 and "type:two_wheeler" in evs[0]["tags"] and evs[0]["vehicle_colour"] == "red"
    evs = client.get("/api/events?tag=over_speed", headers=h).json()["events"]
    assert len(evs) == 1 and evs[0]["camera_id"] == "police-cam2"


def test_challan_review_and_echallan_handoff(client, monkeypatch):
    h = tok(client)
    drafts = client.get("/api/challans?status=draft", headers=h).json()
    over = [c for c in drafts if c["offence"] == "over_speed"][0]
    # viewer may not review
    v = tok(client, "viewer", "viewer123")
    assert client.post(f"/api/challans/{over['id']}/review", json={"action": "approve"}, headers=v).status_code == 403
    # reject one
    tr = [c for c in drafts if c["offence"] == "triple_riding"][0]
    r = client.post(f"/api/challans/{tr['id']}/review", json={"action": "reject", "remarks": "pillion is a child"}, headers=h)
    assert r.json()["status"] == "rejected"
    # approve with the e-challan webhook pointed at a fake receiver
    from uvp.config import settings
    sent = {}

    class R:
        ok, status_code, text = True, 200, "ok"

        def json(self):
            return {"reference": "ECH-TEST-1"}

    def fake_post(url, data=None, headers=None, timeout=0):
        sent["url"], sent["body"], sent["headers"] = url, json.loads(data), headers
        return R()
    monkeypatch.setattr(settings, "echallan_webhook_url", "http://echallan.example/api")
    monkeypatch.setattr(settings, "echallan_webhook_secret", "s3cret")
    import uvp.services.routes_analytics as RA
    monkeypatch.setattr(RA.requests, "post", fake_post)
    r = client.post(f"/api/challans/{over['id']}/review", json={"action": "approve", "remarks": "verified from clip"}, headers=h)
    assert r.status_code == 200 and r.json()["status"] == "sent" and r.json()["external_ref"] == "ECH-TEST-1"
    assert sent["body"]["challan_number"] == over["number"] and sent["body"]["fine_inr"] == 1000
    assert "X-UVP-Signature" in sent["headers"] and sent["body"]["platform_signature"]
    # a second over-speed for the same plate is now a repeat offence with the higher fine
    secret = {"X-Internal-Secret": "change-me-internal"}
    client.post("/internal/events", json=ev("e" * 32, "police-cam1", "MH12AB1234", T0 + dt.timedelta(minutes=10), "away"), headers=secret)
    client.post("/internal/events", json=ev("f" * 32, "police-cam2", "MH12AB1234", T0 + dt.timedelta(minutes=11), "towards"), headers=secret)
    rep = [c for c in client.get("/api/challans?status=draft&offence=over_speed", headers=h).json() if c["plate"] == "MH12AB1234"]
    assert rep and rep[0]["repeat"] is True and rep[0]["fine_inr"] == 2000
    # signed export pack
    z = client.get(f"/api/challans/{over['id']}/export", headers=h)
    assert z.status_code == 200 and z.headers["content-type"] == "application/zip"


# ----------------------------------------------------------------------------- zone analytics (pure logic)
def frame(w=640, h=360):
    return np.zeros((h, w, 3), np.uint8)


def test_intrusion_only_in_hours_and_zone():
    cfg = {"intrusion": {"zones": [{"name": "fence", "polygon": [[0.5, 0.2], [1, 0.2], [1, 0.8], [0.5, 0.8]], "hours": "22:00-05:00", "classes": ["person"]}]}}
    z = ZoneAnalyzer("cam", cfg)
    inside = [Det("person", 0.9, (500, 150, 540, 260))]
    outside = [Det("person", 0.9, (100, 150, 140, 260))]
    assert z.step(frame(), outside, T0) == []
    inc = z.step(frame(), inside, T0 + dt.timedelta(seconds=1))
    assert len(inc) == 1 and inc[0]["kind"] == "intrusion" and inc[0]["zone"] == "fence"
    assert z.step(frame(), inside, T0 + dt.timedelta(seconds=2)) == []            # cooldown
    day = dt.datetime(2026, 9, 22, 6, 30, tzinfo=dt.timezone.utc)                  # 12:00 IST: outside hours
    assert ZoneAnalyzer("cam", cfg).step(frame(), inside, day) == []


def test_illegal_parking_needs_stationary_time():
    cfg = {"no_parking": {"polygon": [[0, 0.5], [0.5, 0.5], [0.5, 1], [0, 1]], "min_seconds": 30}}
    z = ZoneAnalyzer("cam", cfg)
    car = [Det("car", 0.9, (60, 220, 200, 330))]
    out = []
    for i in range(0, 40, 2):
        out += z.step(frame(), car, T0 + dt.timedelta(seconds=i))
    assert len(out) == 1 and out[0]["kind"] == "illegal_parking" and out[0]["detail"]["stationary_s"] >= 30
    # a moving car never triggers
    z2 = ZoneAnalyzer("cam", cfg)
    moved = []
    for i in range(0, 40, 2):
        moved += z2.step(frame(), [Det("car", 0.9, (60 + i * 6, 220, 200 + i * 6, 330))], T0 + dt.timedelta(seconds=i))
    assert moved == []


def test_red_light_with_schedule_and_roi_signal():
    cfg = {"red_light": {"stop_line_y": 0.5, "signal": {"mode": "schedule", "cycle_s": 60, "red_from_s": 0, "red_to_s": 30, "epoch": T0.isoformat()}}}
    z = ZoneAnalyzer("cam", cfg)
    assert z.step(frame(), [Det("car", 0.9, (300, 100, 400, 160))], T0 + dt.timedelta(seconds=1)) == []          # above the line
    inc = z.step(frame(), [Det("car", 0.9, (300, 150, 400, 200))], T0 + dt.timedelta(seconds=2))                 # crossed y=180 while red
    assert len(inc) == 1 and inc[0]["kind"] == "red_light"
    z2 = ZoneAnalyzer("cam", cfg)
    z2.step(frame(), [Det("car", 0.9, (300, 100, 400, 160))], T0 + dt.timedelta(seconds=40))
    assert z2.step(frame(), [Det("car", 0.9, (300, 150, 400, 200))], T0 + dt.timedelta(seconds=41)) == []          # green phase
    # ROI signal detection
    f = frame()
    f[10:40, 590:630] = (0, 0, 255)      # red lamp lit (BGR)
    assert signal_is_red({"mode": "roi", "roi": [0.9, 0.0, 1.0, 0.2]}, f, T0) is True
    f[10:40, 590:630] = (0, 255, 0)
    assert signal_is_red({"mode": "roi", "roi": [0.9, 0.0, 1.0, 0.2]}, f, T0) is False
    assert signal_is_red({"mode": "roi", "roi": [0.9, 0.0, 1.0, 0.2]}, frame(), T0) is None


def test_crowd_and_abandoned_object():
    cfg = {"crowd": {"polygon": [[0, 0], [1, 0], [1, 1], [0, 1]], "max_persons": 3},
           "abandoned_object": {"polygon": [[0, 0], [1, 0], [1, 1], [0, 1]], "min_seconds": 10, "min_area": 0.001}}
    z = ZoneAnalyzer("cam", cfg)
    people = [Det("person", 0.9, (i * 60, 100, i * 60 + 40, 300)) for i in range(5)]
    inc = z.step(frame(), people, T0)
    assert any(i["kind"] == "crowd" and i["detail"]["persons"] == 5 for i in inc)
    # abandoned object: a bright static box appears on a black background and stays; no track explains it
    z2 = ZoneAnalyzer("cam", cfg)
    for i in range(20):
        z2.step(frame(), [], T0 + dt.timedelta(seconds=i))     # learn an empty background
    got = []
    for i in range(20, 60, 2):
        f = frame()
        f[200:260, 300:360] = 255
        got += z2.step(f, [], T0 + dt.timedelta(seconds=i))
    assert any(g["kind"] == "abandoned_object" and g["detail"]["static_s"] >= 10 for g in got)


def test_tracker_keeps_ids_across_frames():
    tr = Tracker()
    a = tr.update([Det("car", 0.9, (10, 10, 100, 80))], 0.0)
    b = tr.update([Det("car", 0.9, (14, 12, 104, 82))], 0.5)
    assert a[0].id == b[0].id and len(b[0].hist) == 2
    c = tr.update([Det("car", 0.9, (400, 10, 500, 80))], 1.0)
    assert c[0].id != a[0].id


# ----------------------------------------------------------------------------- incidents through the API
def test_incident_ingest_associates_plate_and_drafts_challan(client):
    h = tok(client)
    secret = {"X-Internal-Secret": "change-me-internal"}
    t = T0 + dt.timedelta(hours=1)
    client.post("/internal/events", json=ev("9" * 32, "police-cam2", "KA05MN7788", t, "towards",
                                             {"vehicle_type": "car", "vehicle_bbox": [300, 150, 400, 200]}), headers=secret)
    r = client.post("/internal/incidents", json={"id": "1" * 32, "camera_id": "police-cam2", "department": "Police", "ts": (t + dt.timedelta(seconds=3)).isoformat(),
                                                 "kind": "red_light", "zone": "stop_line", "priority": "high", "detail": {"signal": "red"},
                                                 "bbox": [305, 155, 405, 205], "snapshot_path": ""}, headers=secret)
    assert r.status_code == 200 and r.json()["alerts"] == 1
    inc = client.get("/api/incidents?kind=red_light", headers=h).json()
    assert len(inc) == 1 and inc[0]["plate"] == "KA05MN7788" and inc[0]["label"] == "Red-light violation"
    ch = [c for c in client.get("/api/challans?status=draft&offence=red_light", headers=h).json()]
    assert len(ch) == 1 and ch[0]["plate"] == "KA05MN7788" and ch[0]["incident_id"] == "1" * 32
    # incident without any nearby plate: alert + incident, no challan
    r = client.post("/internal/incidents", json={"id": "2" * 32, "camera_id": "muni-cam2", "department": "Municipal", "ts": t.isoformat(),
                                                 "kind": "intrusion", "zone": "depot_fence", "priority": "high", "detail": {"class": "person"},
                                                 "bbox": [1, 1, 10, 10], "snapshot_path": ""}, headers=secret)
    assert r.json()["alerts"] == 1
    assert client.get("/api/incidents?kind=intrusion", headers=tok(client, "police_op", "police123")).json() == []   # scoped
    assert client.post(f"/api/incidents/{'2' * 32}/ack", headers=h).status_code == 200
    st = client.get("/api/incidents/stats?hours=8760", headers=h).json()   # T0 is a fixed date
    assert st["incidents"]["red_light"] == 1 and st["challans"]["draft"] >= 1
    # duplicate delivery is idempotent
    r = client.post("/internal/incidents", json={"id": "2" * 32, "camera_id": "muni-cam2", "department": "Municipal", "ts": t.isoformat(),
                                                 "kind": "intrusion", "zone": "depot_fence", "detail": {}}, headers=secret)
    assert r.json()["alerts"] == 0


# ----------------------------------------------------------------------------- hotlists + face gate
def test_hotlist_sync_adds_updates_and_removes(client, monkeypatch, tmp_path):
    from uvp.config import settings
    from uvp.services import hotlist_sync as HS
    h = tok(client)
    cfg = tmp_path / "hotlists.yaml"
    feed = tmp_path / "stolen.json"
    feed.write_text(json.dumps({"vehicles": [{"plate": "MH 12 AB 1234", "reason": "Stolen FIR 1", "priority": "high"},
                                             {"plate": "DL3CAF0921", "reason": "Wanted", "priority": "medium", "expires": "2027-01-01"}]}))
    cfg.write_text(f"sources:\n  - name: ncrb\n    kind: json\n    url: {feed}\n    json_path: vehicles\n    interval_minutes: 5\n")
    monkeypatch.setattr(settings, "hotlists_file", cfg)
    # a manual entry for a plate on the feed is left alone
    client.post("/api/watchlist", json={"plate": "DL3CAF0921", "reason": "manual", "priority": "low", "days": 5}, headers=h)
    res = HS.sync_all()["ncrb"]
    assert res["added"] == 1 and res["entries"] == 2
    wl = {w["plate"]: w for w in client.get("/api/watchlist", headers=h).json()}
    assert "source:ncrb" in wl["MH12AB1234"]["reason"] and wl["DL3CAF0921"]["reason"] == "manual"
    feed.write_text(json.dumps({"vehicles": [{"plate": "KA01ZZ0001", "reason": "new", "priority": "high"}]}))
    res = HS.sync_all()["ncrb"]
    assert res["added"] == 1 and res["removed"] == 1
    wl = {w["plate"] for w in client.get("/api/watchlist", headers=h).json()}
    assert "MH12AB1234" not in wl and "KA01ZZ0001" in wl and "DL3CAF0921" in wl
    st = client.get("/api/hotlists", headers=h).json()
    assert st["sources"][0]["last"]["ok"] is True
    assert client.post("/api/hotlists/sync", headers=h).status_code == 200


def test_face_search_is_legally_gated(client):
    h = tok(client)
    r = client.get("/api/face/search?plate=x", headers=h)
    assert r.status_code == 451 and "legal clearance" in r.json()["detail"]


def test_counts_timeline_and_count_all_defaults(client, monkeypatch):
    """Every pulled camera counts by default (traffic + crowd), yaml overrides win, and /api/counts/timeline
    returns per-minute vehicles / persons with the crowd threshold."""
    import datetime as dt
    from uvp.services import analytics_worker as W
    from uvp.config import settings
    from uvp.db import Camera, SessionLocal, TrafficCount
    with SessionLocal() as s:
        cams = [c.id for c in s.query(Camera)]
    monkeypatch.setattr(settings, "analytics_count_all", True)
    from uvp import licensing, relay as R
    monkeypatch.setattr(licensing, "load", lambda: {})
    # the relay keeps every camera's main on a steady session -> all of them count
    monkeypatch.setattr(R.relay, "configured_paths", lambda: {f"{c}/main": ("rtsp://x", False, True) for c in cams})
    zones = W.zone_cameras()
    assert set(cams) <= set(zones)
    # only on-demand pulls -> counting must not force gateway sessions: nothing beyond the explicit yaml cameras
    monkeypatch.setattr(R.relay, "configured_paths", lambda: {f"{c}/main": ("rtsp://x", False, False) for c in cams})
    assert set(W.zone_cameras()) <= set(W.zone_cameras()) and cams[0] not in W.zone_cameras() or cams[0] in ((W.load_yaml(settings.analytics_file) or {}).get("cameras") or {})
    monkeypatch.setattr(R.relay, "configured_paths", lambda: {f"{c}/main": ("rtsp://x", False, True) for c in cams})
    any_cam = cams[0]
    assert zones[any_cam]["traffic"] == {"window_s": 60} and zones[any_cam]["crowd"]["max_persons"] == settings.crowd_max_persons
    # timeline
    now = dt.datetime.now(dt.timezone.utc)
    with SessionLocal() as s:
        dept = s.get(Camera, any_cam).department
        for i in range(3):
            s.add(TrafficCount(camera_id=any_cam, department=dept, ts=now - dt.timedelta(minutes=i), window_s=60, frames=100,
                               avg_vehicles=4.0 + i, peak_vehicles=9, avg={"car": 3.0 + i, "person": 12.0 + i}, flow=None))
        s.commit()
    h = tok(client)
    r = client.get("/api/counts/timeline?hours=1", headers=h).json()
    row = [c for c in r["cameras"] if c["camera_id"] == any_cam][0]
    assert len(row["points"]) == 3 and row["points"][0][2] == 14.0 and row["peak_persons"] == 14 and row["avg_vehicles"] == 5.0
    assert row["crowd_max"] == settings.crowd_max_persons and r["crowd_default"] == settings.crowd_max_persons


def test_detection_switch_api_and_worker_gate(client, monkeypatch):
    """The console switch turns AI detection off globally or per camera; workers consult detection.allows()."""
    from uvp import detection as D
    h = tok(client)
    st = client.get("/api/detection", headers=h).json()
    assert st["enabled"] is True and st["cameras"] == {}
    # viewer cannot switch, supervisor can
    assert client.post("/api/detection", json={"enabled": False}, headers=tok(client, "viewer", "viewer123")).status_code == 403
    st = client.post("/api/detection", json={"enabled": False}, headers=h).json()
    assert st["enabled"] is False
    assert D.allows("police-cam1") is False
    # per-camera override wins over the global switch
    st = client.post("/api/detection", json={"camera_id": "police-cam1", "on": True}, headers=h).json()
    assert st["cameras"] == {"police-cam1": True} and D.allows("police-cam1") is True and D.allows("police-cam2") is False
    # back to following the global switch, then global on again
    st = client.post("/api/detection", json={"camera_id": "police-cam1", "on": None}, headers=h).json()
    assert st["cameras"] == {} and D.allows("police-cam1") is False
    st = client.post("/api/detection", json={"enabled": True}, headers=h).json()
    assert D.allows("police-cam2") is True
    acts = [a["action"] for a in client.get("/api/audit?limit=10", headers=h).json()]
    assert "detection_switch" in acts
    # survives a "restart": a fresh cache read comes from the database
    D._cache["state"] = None
    assert D.state()["enabled"] is True
