"""Phase-5 HA & scale: relay pool assignment + failover (fake relays), ANPR sharding, edge outbox
store-and-forward, inline media ingest, Prometheus metrics endpoint, capacity report, k8s manifests."""
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
DB_URL = f"sqlite:///{HERE / '_ha_test.db'}"
DATA = HERE / "_ha_data"


@pytest.fixture(scope="module")
def client():
    import shutil
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_ha_test.db").unlink(missing_ok=True)
    from uvp import db, storage
    from uvp.config import settings
    mp = pytest.MonkeyPatch()
    mp.setattr(settings, "database_url", DB_URL)
    mp.setattr(settings, "data_dir", DATA)
    mp.setattr(settings, "signing_key_file", DATA / "signing.key")
    mp.setattr(settings, "auth_file", ROOT / "config" / "auth.yaml")
    mp.setattr(settings, "object_storage", "local")
    mp.setattr(settings, "relay_api", "http://127.0.0.1:1")
    db.rebind(DB_URL)
    mp.setattr(storage, "_store", None)
    from fastapi.testclient import TestClient
    from uvp.services.api import app
    with TestClient(app) as c:
        from uvp.db import Camera, SessionLocal, Source
        with SessionLocal() as s:
            s.merge(Source(id="police", department="Police", name="P", adapter="rtsp", max_concurrent_pulls=8))
            s.merge(Camera(id="police-cam1", source_id="police", department="Police", name="Toll", anpr_enabled=True, status="online", relay="relay"))
            s.merge(Camera(id="police-cam2", source_id="police", department="Police", name="Ring", anpr_enabled=False, status="offline", relay="relay"))
            s.commit()
        yield c
    mp.undo()
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_ha_test.db").unlink(missing_ok=True)


def tok(client, user="admin", pw="admin123"):
    r = client.post("/api/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200 and "token" in r.json(), r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


# ----------------------------------------------------------------------------- relay pool
def make_pool(names):
    from uvp.config import settings
    from uvp.relay import RelayPool
    mp = pytest.MonkeyPatch()
    mp.setattr(settings, "relay_apis", ",".join(f"{n}=http://{n}:9997" for n in names))
    mp.setattr(settings, "relay_rtsps", ",".join(f"{n}=rtsp://{n}:8554" for n in names))
    mp.setattr(settings, "relay_public_hosts", ",".join(f"{n}={n}.example" for n in names))
    pool = RelayPool()
    mp.undo()
    return pool


def test_rendezvous_assignment_is_stable_and_fails_over():
    pool = make_pool(["relay-a", "relay-b", "relay-c"])
    cams = [f"cam-{i}" for i in range(60)]
    before = {c: pool.assign(c).name for c in cams}
    assert len(set(before.values())) == 3 and min(list(before.values()).count(n) for n in ("relay-a", "relay-b", "relay-c")) >= 10
    # same result from another process (pure hashing)
    assert {c: make_pool(["relay-a", "relay-b", "relay-c"]).assign(c).name for c in cams} == before
    # relay-b dies: only its cameras move, everyone else stays put
    pool.relays["relay-b"].healthy = False
    after = {c: pool.assign(c).name for c in cams}
    moved = [c for c in cams if before[c] != after[c]]
    assert all(before[c] == "relay-b" for c in moved) and "relay-b" not in after.values()
    assert all(after[c] == before[c] for c in cams if before[c] != "relay-b")
    # relay-b returns: its cameras come back
    pool.relays["relay-b"].healthy = True
    assert {c: pool.assign(c).name for c in cams} == before
    assert pool.get("relay-b").public_host == "relay-b.example" and pool.get("nope").name == "relay-a"


def test_single_relay_config_is_backward_compatible():
    from uvp.relay import RelayPool
    pool = RelayPool()
    assert list(pool.relays) == ["relay"] and pool.for_camera("anything").name == "relay"


def test_anpr_sharding_partitions_cameras(monkeypatch):
    from uvp.config import settings
    from uvp.services.anpr_worker import _in_shard
    cams = [f"cam-{i}" for i in range(40)]
    owned = {}
    for i in range(3):
        monkeypatch.setattr(settings, "anpr_shard", f"{i}/3")
        owned[i] = {c for c in cams if _in_shard(c)}
    assert owned[0] | owned[1] | owned[2] == set(cams)
    assert not (owned[0] & owned[1]) and not (owned[1] & owned[2]) and not (owned[0] & owned[2])
    monkeypatch.setattr(settings, "anpr_shard", "0/1")
    assert all(_in_shard(c) for c in cams)


# ----------------------------------------------------------------------------- edge outbox + inline media
def test_outbox_store_and_forward_preserves_order(tmp_path):
    from uvp.bus import Outbox
    ob = Outbox(tmp_path / "outbox.db")
    for i in range(5):
        ob.put("anpr.events", {"id": i})
    assert ob.pending() == 5
    seen, fail_at = [], {2}

    def send(topic, msg):
        if msg["id"] in fail_at:
            return False
        seen.append(msg["id"])
        return True
    assert ob.drain(send) == 2 and ob.pending() == 3 and seen == [0, 1]     # stops at the first failure
    fail_at.clear()
    assert ob.drain(send) == 3 and ob.pending() == 0 and seen == [0, 1, 2, 3, 4]


def test_edge_events_with_inline_media_are_stored(client):
    import base64
    import cv2
    import numpy as np
    h = tok(client)
    ok, jpg = cv2.imencode(".jpg", np.full((40, 120, 3), 200, np.uint8))
    b64 = base64.b64encode(jpg.tobytes()).decode()
    ev = {"id": "e" * 32, "camera_id": "edge-junction-7", "department": "Police", "ts": "2026-09-22T06:00:00+00:00", "plate": "MP04ZR7493",
          "plate_raw": "MP04ZR7493", "plate_valid": True, "confidence": 0.95, "reads": 4, "direction": "away", "tags": [],
          "crop_b64": b64, "frame_b64": b64}
    r = client.post("/internal/events", json=ev, headers={"X-Internal-Secret": "change-me-internal"})
    assert r.status_code == 200
    e = client.get("/api/events?plate=MP04ZR7493", headers=h).json()["events"][0]
    assert e["crop_url"].startswith("/media/crops/2026-09-22/") and (DATA / e["crop_url"][7:]).exists()
    assert client.get(e["crop_url"], headers=h).status_code == 200


# ----------------------------------------------------------------------------- metrics + capacity + k8s
def test_metrics_endpoint_and_route_labels(client):
    h = tok(client)
    client.get("/api/cameras", headers=h)
    m = client.get("/metrics").text
    assert "uvp_http_requests_total" in m and 'route="/api/cameras"' in m and "uvp_events_ingested_total" in m
    from uvp.metrics import route_label
    assert route_label("/api/cases/0123456789abcdef0123456789abcdef/items") == "/api/cases/{id}/items"
    assert route_label("/api/cameras/police-cam1/recordings") == "/api/cameras/police-cam1/recordings"


def test_capacity_report(client):
    h = tok(client)
    c = client.get("/api/capacity", headers=h).json()
    d = {x["department"]: x for x in c["departments"]}["Police"]
    assert d["cameras"] == 2 and d["online"] == 1 and d["anpr_channels"] == 1 and d["pull_cap"] == 8 and d["relays"] == {"relay": 2}
    assert d["storage_estimate_gb_per_day"] == 24.0 and "relay" in c["relays"]
    assert client.get("/api/capacity", headers=tok(client, "viewer", "viewer123")).status_code == 200


def test_k8s_manifests_render_and_validate():
    sys.path.insert(0, str(ROOT / "deploy" / "k8s"))
    import render as R
    docs = R.render(R.load_values())
    assert R.check(docs) == []
    kinds = [d["kind"] for d in docs]
    assert kinds.count("StatefulSet") == 2 and "HorizontalPodAutoscaler" in kinds and "Ingress" in kinds and "ScaledObject" in kinds
    relay = [d for d in docs if d["kind"] == "StatefulSet" and d["metadata"]["name"] == "relay"][0]
    assert relay["spec"]["replicas"] == 2
    api = [d for d in docs if d["kind"] == "Deployment" and d["metadata"]["name"] == "api"][0]
    env = {e["name"]: e.get("value") for e in api["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["RELAY_APIS"].startswith("relay-0=http://relay-0.relay.unified-cctv.svc:9997,relay-1=")
    anpr = [d for d in docs if d["kind"] == "StatefulSet" and d["metadata"]["name"] == "anpr"][0]
    assert "ANPR_SHARD=${HOSTNAME##*-}/2" in anpr["spec"]["template"]["spec"]["containers"][0]["command"][-1]
