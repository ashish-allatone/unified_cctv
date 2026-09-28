"""Connect a device from the console: stored encrypted, merged with sources.yaml by the adapters, cameras
appear after a sync, disconnect removes them. Also the form -> adapter-config builder and the stream tester."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
DB_URL = f"sqlite:///{HERE / '_dev_test.db'}"
DATA = HERE / "_dev_data"


@pytest.fixture(scope="module")
def client():
    import shutil
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_dev_test.db").unlink(missing_ok=True)
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
    from fastapi.testclient import TestClient
    from uvp.services.api import app
    with TestClient(app) as c:
        yield c
    mp.undo()


def tok(client, user="admin", pw="admin123"):
    return {"Authorization": "Bearer " + client.post("/api/auth/login", json={"username": user, "password": pw}).json()["token"]}


def test_build_config_shapes():
    from uvp.services import devices as D
    nvr = D.build_config({"type": "nvr", "name": "Sola NVR", "department": "Police", "vendor": "hikvision", "host": "10.1.2.3", "channels": 4, "anpr": True})
    assert nvr["adapter"] == "rtsp_template" and nvr["vendor"] == "hikvision" and len(nvr["channels"]) == 4
    assert nvr["channels"][0] == {"channel": 1, "id": "sola-nvr-ch1", "anpr": True} and nvr["max_concurrent_pulls"] == 4
    cam = D.build_config({"type": "camera", "name": "Gate cam", "department": "Municipal", "main_url": "rtsp://10.0.0.9:554/live", "lat": 23.0, "lon": 72.5})
    assert cam["adapter"] == "rtsp" and cam["streams"][0]["main"] == "rtsp://10.0.0.9:554/live" and cam["streams"][0]["lat"] == 23.0
    tpl = D.build_config({"type": "template", "name": "Corp8 gateway", "department": "Corp8", "host": "203.0.113.9", "rtsp_port": 8554,
                          "main_template": "rtsp://{host}:{rtsp_port}/stream/cam{channel:02d}", "channels": 30})
    assert tpl["persistent_pull"] is True and tpl["channels"][29]["id"] == "corp8-gateway-ch30"
    with pytest.raises(ValueError):
        D.build_config({"type": "camera", "name": "x", "department": "d", "main_url": "rtsp://u:p@10.0.0.9/live"})   # creds in URL
    with pytest.raises(ValueError):
        D.build_config({"type": "nvr", "name": "x", "department": "d", "vendor": "acme", "host": "h"})
    url = D.probe_url(tpl, "user@x.in", "s3cret", channel=7)
    assert url == "rtsp://user%40x.in:s3cret@203.0.113.9:8554/stream/cam07"
    assert D.probe_url(nvr, "u", "p").endswith("/Streaming/Channels/101")
    # secrets round-trip
    assert D.decrypt_secret(D.encrypt_secret("u@x", "pw")) == ("u@x", "pw")
    assert D.decrypt_secret("garbage") == ("", "")


def test_connect_device_sync_and_disconnect(client, monkeypatch):
    from uvp.services import adapter_service as A, devices as D
    from uvp.db import Camera, SessionLocal, Source
    h = tok(client)
    assert client.get("/api/devices/types", headers=h).json()["vendors"]["dahua"]["adapter"] == "rtsp_template"
    # connection test with a stubbed probe
    monkeypatch.setattr(D, "test_stream", lambda url: {"ok": True, "codec": "hevc", "size": "1920x1080", "error": "", "note": "hevc"})
    r = client.post("/api/devices/test", json={"type": "nvr", "name": "Sola NVR", "department": "Police", "vendor": "dahua", "host": "10.1.2.3",
                                                "username": "viewer", "password": "pw", "channels": 2}, headers=h).json()
    assert r["ok"] and r["codec"] == "hevc" and "viewer" not in r["url"] and r["cameras"] == 2
    # supervisor may not connect devices
    assert client.post("/api/devices", json={"type": "nvr", "name": "x", "department": "Police", "vendor": "dahua", "host": "h"}, headers=tok(client, "supervisor", "super123")).status_code == 403
    r = client.post("/api/devices", json={"type": "nvr", "name": "Sola NVR", "department": "Police", "vendor": "dahua", "host": "10.1.2.3",
                                           "username": "viewer", "password": "pw", "channels": 2, "anpr": True}, headers=h)
    assert r.status_code == 201, r.text
    dev = r.json()
    assert dev["id"] == "sola-nvr" and dev["managed"] and dev["username"] == "viewer" and "password" not in dev and dev["channels"] == 2
    assert client.post("/api/devices", json={"type": "nvr", "name": "Sola NVR", "department": "Police", "vendor": "dahua", "host": "h"}, headers=h).status_code == 400
    # the adapters see it, credentials decrypted, merged with (empty) sources.yaml
    srcs = A.all_sources()["sources"]
    assert len(srcs) == 1 and srcs[0]["id"] == "sola-nvr" and srcs[0]["password"] == "pw" and srcs[0]["vendor"] == "dahua"
    assert A.db_sources_changed() is True and A.db_sources_changed() is False
    # a sync registers its cameras (relay stubbed)
    fake = A.relay.assign("sola-nvr-ch1")
    ups = {}
    monkeypatch.setattr(fake, "upsert_path", lambda name, url, record=False, persistent=False: ups.__setitem__(name, url) or "added")
    monkeypatch.setattr(fake, "delete_path", lambda name: None)
    monkeypatch.setattr(A.relay, "ping_all", lambda: None)
    monkeypatch.setattr(A.relay, "live_paths", lambda max_age=0: [])
    monkeypatch.setattr(A.relay, "configured_by_relay", lambda: {})
    monkeypatch.setattr(A.settings, "relay_add_stagger_s", 0.0)
    monkeypatch.setattr(A, "auth_backoff", lambda *a, **k: None)
    A._paused_until.clear()
    A.sync_once()
    with SessionLocal() as s:
        cams = sorted(c.id for c in s.query(Camera).filter(Camera.source_id == "sola-nvr"))
        src = s.get(Source, "sola-nvr")
        assert cams == ["sola-nvr-ch1", "sola-nvr-ch2"] and src.status == "ok" and src.managed and src.config["vendor"] == "dahua"
        assert all(s.get(Camera, c).anpr_enabled for c in cams)
    assert ups["sola-nvr-ch1/main"].endswith("/cam/realmonitor?channel=1&subtype=0") and "viewer:pw@10.1.2.3" in ups["sola-nvr-ch1/main"]
    # edit: blank password keeps the stored one; changing the host bumps the version so the adapters re-sync
    r = client.patch("/api/devices/sola-nvr", json={"type": "nvr", "name": "Sola NVR", "department": "Police", "vendor": "dahua", "host": "10.1.2.4", "channels": 2}, headers=h)
    assert r.status_code == 200 and r.json()["config"]["host"] == "10.1.2.4"
    assert A.all_sources()["sources"][0]["password"] == "pw" and A.db_sources_changed() is True
    # registry lists them as integrated, /api/devices shows the camera count
    assert [d["cameras"] for d in client.get("/api/devices", headers=h).json()] == [2]
    assert all(not r["registry_only"] for r in client.get("/api/registry?department=Police", headers=h).json())
    # disconnect removes the cameras
    r = client.delete("/api/devices/sola-nvr", headers=h).json()
    assert r["cameras_removed"] == 2
    with SessionLocal() as s:
        assert s.query(Camera).filter(Camera.source_id == "sola-nvr").count() == 0 and s.get(Source, "sola-nvr") is None
    acts = [a["action"] for a in client.get("/api/audit?limit=20", headers=h).json()]
    assert "device_connect" in acts and "device_disconnect" in acts
