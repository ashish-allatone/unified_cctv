"""Phase-6 product polish: licence verification / limits / grace / evaluation mode, camera and ANPR-channel
enforcement, plate review queue + corrections + weekly accuracy report + retraining set, i18n dictionaries,
version endpoint, installer scripts parse."""
import base64
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
DB_URL = f"sqlite:///{HERE / '_prod_test.db'}"
DATA = HERE / "_prod_data"


@pytest.fixture(scope="module")
def client():
    import shutil
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_prod_test.db").unlink(missing_ok=True)
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
            s.merge(Source(id="police", department="Police", name="P", adapter="rtsp"))
            for i in range(1, 5):
                s.merge(Camera(id=f"police-cam{i}", source_id="police", department="Police", name=f"Cam {i}", anpr_enabled=i <= 3, status="online"))
            s.commit()
        yield c
    mp.undo()
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_prod_test.db").unlink(missing_ok=True)


def tok(client, user="admin", pw="admin123"):
    r = client.post("/api/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200 and "token" in r.json(), r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def issue(tmp_path, **kw) -> Path:
    """Sign a licence with the vendor key in deploy/licensing (created by scripts/issue_license.py)."""
    from cryptography.hazmat.primitives import serialization
    priv = serialization.load_pem_private_key((ROOT / "deploy" / "licensing" / "vendor_private.pem").read_bytes(), password=None)
    payload = {"customer": "Test Corp", "tenant": "", "cameras": 100, "anpr_channels": 20, "analytics_channels": 10, "features": ["*"],
               "expires": (dt.date.today() + dt.timedelta(days=30)).isoformat(), "issued": dt.date.today().isoformat(), **kw}
    sig = priv.sign(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    p = tmp_path / "license.json"
    p.write_text(json.dumps({"license": payload, "signature": base64.b64encode(sig).decode()}))
    return p


# ----------------------------------------------------------------------------- licensing
def test_license_modes(client, tmp_path, monkeypatch):
    from uvp import licensing
    from uvp.config import settings
    monkeypatch.setattr(settings, "license_file", tmp_path / "missing.json")
    assert licensing.load()["mode"] == "evaluation" and licensing.load()["cameras"] == 8
    monkeypatch.setattr(settings, "license_file", issue(tmp_path))
    lic = licensing.load()
    assert lic["mode"] == "licensed" and lic["customer"] == "Test Corp" and lic["cameras"] == 100
    # tampered payload -> invalid -> evaluation limits
    doc = json.loads((tmp_path / "license.json").read_text())
    doc["license"]["cameras"] = 100000
    (tmp_path / "license.json").write_text(json.dumps(doc))
    lic = licensing.load()
    assert lic["mode"] == "invalid" and lic["cameras"] == 8
    # expired within grace / beyond grace
    monkeypatch.setattr(settings, "license_file", issue(tmp_path, expires=(dt.date.today() - dt.timedelta(days=3)).isoformat()))
    lic = licensing.load()
    assert lic["mode"] == "grace" and lic["cameras"] == 100 and "days of grace" in lic["status"]
    monkeypatch.setattr(settings, "license_file", issue(tmp_path, expires=(dt.date.today() - dt.timedelta(days=40)).isoformat()))
    lic = licensing.load()
    assert lic["mode"] == "expired" and lic["cameras"] == 8
    # API view
    monkeypatch.setattr(settings, "license_file", issue(tmp_path, cameras=3, anpr_channels=2))
    r = client.get("/api/license", headers=tok(client)).json()
    assert r["mode"] == "licensed" and r["usage"]["cameras_total"] == 4 and r["over_limit"]["cameras"] is True and r["over_limit"]["anpr_channels"] is True
    assert client.get("/api/version").json()["version"] == (ROOT / "VERSION").read_text().strip()


def test_camera_and_anpr_limits_are_deterministic(tmp_path, monkeypatch):
    from uvp import licensing
    from uvp.config import settings
    monkeypatch.setattr(settings, "license_file", issue(tmp_path, cameras=3, anpr_channels=2))
    lic = licensing.load()
    ids = ["police-cam4", "police-cam1", "police-cam3", "police-cam2"]
    assert licensing.allowed_cameras(lic, ids) == {"police-cam1", "police-cam2", "police-cam3"}
    assert licensing.allowed_anpr(lic, ids) == {"police-cam1", "police-cam2"}
    assert licensing.allowed_cameras({"cameras": 0}, ids) == set(ids)          # 0 = unlimited
    # the ANPR worker's camera selection honours the limit and the shard
    from uvp.services.anpr_worker import _in_shard
    monkeypatch.setattr(settings, "anpr_shard", "0/1")
    assert all(_in_shard(c) for c in ids)


# ----------------------------------------------------------------------------- review + accuracy report
def test_plate_review_corrections_and_weekly_report(client):
    from uvp.db import AnprEvent, SessionLocal, utcnow
    h = tok(client)
    now = utcnow()
    with SessionLocal() as s:
        for i, (plate, tags, conf) in enumerate([("MP04ZR7493", [], 0.95), ("MP02ZR7493", ["low_confidence"], 0.6), ("MP04????", ["non_standard_plate", "invalid_format"], 0.5),
                                                 ("KA05MN7788", ["night"], 0.9), ("MH12AB1234", [], 0.97)]):
            s.add(AnprEvent(id=f"{i:032x}", camera_id="police-cam1" if i < 3 else "police-cam2", department="Police", ts=now - dt.timedelta(hours=i + 1),
                            plate=plate, plate_raw=plate, plate_valid="?" not in plate, confidence=conf, reads=3, tags=tags, clip_key="-", crop_key="-", frame_key="-"))
        s.commit()
    q = client.get("/api/reports/anpr/review-queue?limit=10", headers=h).json()
    ids = {e["id"] for e in q}
    assert {"1" * 32 if False else f"{1:032x}", f"{2:032x}", f"{3:032x}"} <= ids      # hard cases always queued
    # confirm one, correct one, mark one unreadable
    assert client.post(f"/api/events/{0:032x}/review", json={"verdict": "confirmed"}, headers=h).json()["verdict"] == "confirmed"
    r = client.post(f"/api/events/{1:032x}/review", json={"verdict": "corrected", "true_plate": "MP04 ZR 7493", "reason": "two_line"}, headers=h).json()
    assert r["plate"] == "MP04ZR7493"
    assert client.post(f"/api/events/{2:032x}/review", json={"verdict": "unreadable", "reason": "decorative_font"}, headers=h).status_code == 200
    assert client.post(f"/api/events/{0:032x}/review", json={"verdict": "corrected", "true_plate": "MP04ZR7493"}, headers=h).status_code == 400
    assert client.post(f"/api/events/{0:032x}/review", json={"verdict": "confirmed"}, headers=tok(client, "viewer", "viewer123")).status_code == 403
    e = client.get(f"/api/events?plate=MP04ZR7493", headers=h).json()["events"]
    assert len(e) == 2 and any("corrected" in x["tags"] for x in e)
    # reviewed reads leave the queue
    ids = {x["id"] for x in client.get("/api/reports/anpr/review-queue?limit=10", headers=h).json()}
    assert not ({f"{0:032x}", f"{1:032x}", f"{2:032x}"} & ids)
    rep = client.get("/api/reports/anpr?weeks_ago=0", headers=h).json()
    assert rep["reads"] == 5 and rep["reviewed"] == 3 and rep["accuracy_pct"] == 33.3
    c1 = [c for c in rep["cameras"] if c["camera_id"] == "police-cam1"][0]
    assert c1["reviewed"] == 3 and c1["confirmed"] == 1 and c1["corrected"] == 1 and c1["unreadable"] == 1 and c1["top_reasons"][0][0] in ("two_line", "decorative_font")
    c2 = [c for c in rep["cameras"] if c["camera_id"] == "police-cam2"][0]
    assert c2["accuracy_pct"] is None and c2["night_pct"] == 50.0
    # department scoping + weekly file + training set
    assert client.get("/api/reports/anpr", headers=tok(client, "muni_op", "muni123")).json()["reads"] == 0
    from uvp.reports import save_weekly
    p = save_weekly(0)
    assert p.exists() and json.loads(p.read_text())["reads"] == 5
    assert client.get("/api/reports/anpr/history", headers=h).json()[-1]["reads"] == 5
    z = client.get("/api/reports/anpr/training-set.zip", headers=h)
    assert z.status_code == 200
    import io
    import zipfile
    with zipfile.ZipFile(io.BytesIO(z.content)) as zf:
        rows = zf.read("labels.csv").decode().splitlines()
        assert rows[0].startswith("file,event_id") and len(rows) == 4
        assert any(",corrected,two_line," in r for r in rows)


# ----------------------------------------------------------------------------- i18n, scripts, PWA lang
def test_i18n_dictionaries_complete_and_served(client):
    web = ROOT / "platform" / "webapp"
    en = json.loads((web / "public" / "i18n" / "en.json").read_text(encoding="utf-8"))
    hi = json.loads((web / "public" / "i18n" / "hi.json").read_text(encoding="utf-8"))
    assert set(en) == set(hi) and all(v.strip() for v in hi.values())
    src = "\n".join(p.read_text(encoding="utf-8") for p in (web / "src").rglob("*.js*"))
    import re
    keys = set(re.findall(r'\bt\("([a-z_]+\.[a-z_.]+)"', src)) | set(re.findall(r'\bkey: "([a-z_]+\.[a-z_]+)"', src))
    assert keys and keys <= set(en), keys - set(en)
    assert client.get("/i18n/hi.json").status_code == 200
    assert 'role="status"' in src and 'className="skip-link"' in src and 'aria-label="Close"' in src


def test_installer_scripts_are_valid_shell():
    for name in ("install.sh", "update.sh", "backup.sh"):
        assert subprocess.run(["bash", "-n", str(ROOT / "scripts" / name)], capture_output=True).returncode == 0, name
    assert (ROOT / "scripts" / "install.ps1").exists() and (ROOT / "VERSION").exists()
