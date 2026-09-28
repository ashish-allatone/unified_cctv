"""Phase-4 operations & integration: API keys, subscriber webhooks with HMAC, notification routing
(email via a fake SMTP, SMS/WhatsApp via HTTP gateway, CAD webhook), camera health SLA from status
transitions, image-quality verdicts, tenancy clipping, vendor presets + rtsp_template adapter,
Vahan connector, PWA files."""
import datetime as dt
import hashlib
import hmac
import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
DB_URL = f"sqlite:///{HERE / '_ops_test.db'}"
DATA = HERE / "_ops_data"


@pytest.fixture(scope="module")
def client():
    import shutil
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_ops_test.db").unlink(missing_ok=True)
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
            s.merge(Source(id="municipal", department="Municipal", name="M", adapter="rtsp"))
            s.merge(Camera(id="police-cam1", source_id="police", department="Police", name="Toll", anpr_enabled=True, status="online"))
            s.merge(Camera(id="muni-cam1", source_id="municipal", department="Municipal", name="Gate", anpr_enabled=True, status="online"))
            s.commit()
        yield c
    mp.undo()
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_ops_test.db").unlink(missing_ok=True)


def tok(client, user="admin", pw="admin123"):
    r = client.post("/api/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200 and "token" in r.json(), r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


# ----------------------------------------------------------------------------- API keys
def test_api_keys_scope_and_revocation(client):
    h = tok(client)
    r = client.post("/api/admin/api-keys", json={"name": "traffic-erp", "features": ["search"], "departments": ["Police"], "days": 30}, headers=h)
    assert r.status_code == 200 and r.json()["key"].startswith("uvp_")
    key = r.json()["key"]
    kh = {"X-API-Key": key}
    me = client.get("/api/me", headers=kh).json()
    assert me["provider"] == "apikey" and me["departments"] == ["Police"] and me["features"] == ["search"]
    assert client.get("/api/events", headers=kh).status_code == 200
    assert client.get("/api/events?plate=MH12", headers=kh).status_code == 403     # no plate_search
    assert client.get("/api/audit", headers=kh).status_code == 403
    assert client.post("/api/admin/api-keys", json={"name": "x", "features": ["admin"]}, headers=h).status_code == 400
    assert client.get("/api/me", headers={"X-API-Key": "uvp_wrong"}).status_code == 401
    kid = r.json()["id"]
    assert client.delete(f"/api/admin/api-keys/{kid}", headers=h).status_code == 200
    assert client.get("/api/me", headers=kh).status_code == 401
    lst = client.get("/api/admin/api-keys", headers=h).json()
    assert lst[0]["revoked"] is True and lst[0]["prefix"] == key[:10]


# ----------------------------------------------------------------------------- webhooks + notifications
def test_webhooks_signed_delivery_and_routing(client, monkeypatch):
    import uvp.notify as N
    h = tok(client)
    sent = []

    class R:
        def __init__(self, code=200, text="ok"):
            self.status_code, self.text, self.ok = code, text, code < 300

    def fake_post(url, data=None, headers=None, timeout=0, json=None):
        sent.append({"url": url, "body": data, "headers": headers})
        return R(500 if "dead" in url else 200)
    monkeypatch.setattr(N.requests, "post", fake_post)
    monkeypatch.setattr(N.time, "sleep", lambda s: None)
    w = client.post("/api/admin/webhooks", json={"name": "cad", "url": "http://cad.example/in", "kinds": ["alert", "incident"], "secret": "s3"}, headers=h).json()
    dead = client.post("/api/admin/webhooks", json={"name": "dead", "url": "http://dead.example/in", "kinds": ["alert"]}, headers=h).json()
    N.deliver_now("alert", {"id": "a1", "plate": "MH12AB1234", "department": "Police", "priority": "high", "match": "exact",
                            "watchlist_plate": "MH12AB1234", "reason": "stolen", "camera_id": "police-cam1", "ts": "2026-09-22T10:00:00+00:00"})
    cad = [x for x in sent if x["url"] == "http://cad.example/in"]
    assert len(cad) == 1
    body = cad[0]["body"]
    assert cad[0]["headers"]["X-UVP-Signature"] == hmac.new(b"s3", body, hashlib.sha256).hexdigest()
    assert json.loads(body)["data"]["plate"] == "MH12AB1234" and cad[0]["headers"]["X-UVP-Kind"] == "alert"
    hooks = {x["name"]: x for x in client.get("/api/admin/webhooks", headers=h).json()["webhooks"]}
    assert hooks["cad"]["last_status"] == "HTTP 200" and hooks["cad"]["failures"] == 0
    assert hooks["dead"]["failures"] == 1 and hooks["dead"]["last_status"] == "HTTP 500"
    # incidents go only to the hook subscribed to them; department filter respected
    client.post("/api/admin/webhooks", json={"name": "muni-only", "url": "http://muni.example/in", "kinds": ["alert"], "departments": ["Municipal"]}, headers=h)
    sent.clear()
    N.deliver_now("alert", {"id": "a2", "department": "Police", "priority": "low", "ts": "2026-09-22T10:00:00+00:00"})
    assert {x["url"] for x in sent} == {"http://cad.example/in", "http://dead.example/in"}
    # toggle + test endpoint
    assert client.patch(f"/api/admin/webhooks/{dead['id']}?active=false", headers=h).json()["active"] is False
    t = client.post(f"/api/admin/webhooks/{w['id']}/test", headers=h).json()
    assert t["last_status"] == "HTTP 200"


def test_notification_channels_email_sms_whatsapp(client, monkeypatch, tmp_path):
    import uvp.notify as N
    from uvp.config import settings
    h = tok(client)
    cfg = tmp_path / "notify.yaml"
    cfg.write_text("""
channels:
  mail: {type: email, host: smtp.test, port: 25, tls: false, from: cctv@test}
  sms:  {type: sms, url: http://sms.test/send, headers: {Authorization: "Bearer k"}, body: {to: "{to}", message: "{text}"}}
  wa:   {type: whatsapp, url: http://wa.test/msg, body: {messaging_product: whatsapp, to: "{to}", type: text, text: {body: "{text}"}}}
  cad:  {type: webhook, url: http://cad.test/in, secret: abc}
routes:
  - {kind: alert, subkind: exact, priority: high, channel: sms, to: ["+911"]}
  - {kind: alert, channel: mail, to: ["noc@test"]}
  - {kind: incident, priority: high, channel: wa, to: ["+912"]}
  - {kind: incident, channel: cad}
""")
    monkeypatch.setattr(settings, "notify_file", cfg)
    mails, https = [], []

    class FakeSMTP:
        def __init__(self, host, port, timeout=0):
            self.host = host
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def starttls(self):
            pass
        def login(self, u, p):
            pass
        def send_message(self, msg):
            mails.append((msg["To"], msg["Subject"], msg.get_content()))
    monkeypatch.setattr(N.smtplib, "SMTP", FakeSMTP)

    class R:
        ok, status_code, text = True, 200, "queued"

    def fake_request(method, url, json=None, headers=None, timeout=0):
        https.append({"url": url, "json": json, "headers": headers})
        return R()
    monkeypatch.setattr(N.requests, "request", fake_request)
    monkeypatch.setattr(N.requests, "post", lambda url, data=None, headers=None, timeout=0: (https.append({"url": url, "data": data, "headers": headers}) or R()))
    N.deliver_now("alert", {"id": "a9", "plate": "MH12AB1234", "department": "Police", "priority": "high", "match": "exact",
                            "watchlist_plate": "MH12AB1234", "reason": "stolen vehicle", "camera_id": "police-cam1", "ts": "2026-09-22T10:00:00+00:00"})
    assert mails and mails[0][0] == "noc@test" and "MH12AB1234" in mails[0][1] and "stolen vehicle" in mails[0][2]
    sms = [x for x in https if x["url"] == "http://sms.test/send"]
    assert sms and sms[0]["json"]["to"] == "+911" and "MH12AB1234" in sms[0]["json"]["message"] and sms[0]["headers"]["Authorization"] == "Bearer k"
    N.deliver_now("incident", {"id": "i1", "kind": "intrusion", "label": "Intrusion", "department": "Municipal", "priority": "high",
                               "camera_id": "muni-cam1", "zone": "fence", "detail": {"class": "person"}, "ts": "2026-09-22T10:00:00+00:00"})
    wa = [x for x in https if x["url"] == "http://wa.test/msg"]
    assert wa and wa[0]["json"]["to"] == "+912" and wa[0]["json"]["text"]["body"].startswith("[CCTV] Intrusion")
    cad = [x for x in https if x["url"] == "http://cad.test/in"]
    assert cad and cad[0]["headers"]["X-UVP-Signature"] == hmac.new(b"abc", cad[0]["data"], hashlib.sha256).hexdigest()
    lg = client.get("/api/admin/notifications", headers=h).json()
    assert {x["channel"] for x in lg["log"]} >= {"email", "sms", "whatsapp", "webhook"} and all(x["status"] == "sent" for x in lg["log"][:4])
    assert [c["name"] for c in lg["channels"]] == ["mail", "sms", "wa", "cad"]


# ----------------------------------------------------------------------------- health SLA + quality
def test_sla_from_status_transitions_and_quality(client, monkeypatch):
    from uvp.db import Camera, CameraStatusLog, SessionLocal, utcnow
    from uvp.services.adapter_service import _set_status
    h = tok(client)
    now = utcnow()
    with SessionLocal() as s:
        # police-cam1: down for 2 of the last 24 hours
        s.add(CameraStatusLog(camera_id="police-cam1", ts=now - dt.timedelta(hours=30), status="online"))
        s.add(CameraStatusLog(camera_id="police-cam1", ts=now - dt.timedelta(hours=10), status="offline", detail="rtsp timeout"))
        s.add(CameraStatusLog(camera_id="police-cam1", ts=now - dt.timedelta(hours=8), status="online"))
        s.commit()
    r = client.get("/api/health/sla?days=1", headers=h).json()
    cams = {c["camera_id"]: c for c in r["cameras"]}
    p = cams["police-cam1"]
    assert 91 <= p["uptime_pct"] <= 92.1 and p["outages"] == 1 and 118 <= p["downtime_min"] <= 122 and p["sla_met"] is False
    assert cams["muni-cam1"]["uptime_pct"] == 100.0 and cams["muni-cam1"]["sla_met"] is True
    # transitions are recorded by the adapter helper only when up/down flips
    posted = []
    monkeypatch.setattr("uvp.services.adapter_service._emit_health", lambda cam, status, detail: posted.append((cam.id, status)))
    with SessionLocal() as s:
        cam = s.get(Camera, "muni-cam1")
        _set_status(s, cam, "live")          # online -> live: no transition
        _set_status(s, cam, "offline", "source unreachable")
        _set_status(s, cam, "online")
        s.commit()
        n = s.query(CameraStatusLog).filter(CameraStatusLog.camera_id == "muni-cam1").count()
    assert n == 2 and posted == [("muni-cam1", "offline"), ("muni-cam1", "online")]
    # quality samples
    from uvp.services.analytics_worker import quality_sample
    dark = quality_sample("q", np.zeros((180, 320, 3), np.uint8))
    assert dark["verdict"] == "dark"
    rng = np.random.default_rng(1)
    noisy = rng.integers(0, 255, (180, 320, 3), dtype=np.uint8)
    assert quality_sample("q2", noisy)["verdict"] == "ok"
    assert quality_sample("q2", noisy)["verdict"] == "frozen"
    blurry = np.full((180, 320, 3), 128, np.uint8)
    assert quality_sample("q3", blurry)["verdict"] == "blurry"
    assert quality_sample("q4", None)["verdict"] == "no_signal"
    secret = {"X-Internal-Secret": "change-me-internal"}
    rq = client.post("/internal/quality", json={**dark, "camera_id": "police-cam1"}, headers=secret)
    assert rq.status_code == 200 and rq.json()["changed"] is True, rq.text
    assert client.post("/internal/quality", json={**dark, "camera_id": "police-cam1"}, headers=secret).json()["changed"] is False
    q = client.get("/api/health/sla?days=1", headers=h).json()
    assert {c["camera_id"]: c for c in q["cameras"]}["police-cam1"]["quality"]["verdict"] == "dark"
    hist = client.get("/api/health/quality/police-cam1", headers=h).json()
    assert len(hist) == 2


# ----------------------------------------------------------------------------- tenancy
def test_tenancy_clips_departments(client):
    from uvp.tenancy import clip_departments, tenant_for
    assert tenant_for(["Police"]) == "city-a" and tenant_for(["Traffic"]) == "city-b" and tenant_for(["*"]) == "central"
    assert clip_departments(["*"], "city-a") == ["Municipal", "Police"]
    assert clip_departments(["Police", "Traffic"], "city-a") == ["Police"]
    me = client.get("/api/me", headers=tok(client, "police_op", "police123")).json()
    assert me["tenant"] == "city-a" and me["branding"]["title"] == "City A CCTV"
    admin = client.get("/api/me", headers=tok(client)).json()
    assert admin["tenant"] == "central"
    t = client.get("/api/tenants", headers=tok(client, "police_op", "police123")).json()
    assert [x["id"] for x in t["tenants"]] == ["city-a"]
    assert len(client.get("/api/tenants", headers=tok(client)).json()["tenants"]) == 3


# ----------------------------------------------------------------------------- vendor presets + rtsp_template
def test_vendor_presets_and_rtsp_template_adapter(client):
    from uvp.adapters.registry import build, presets, resolve
    p = presets()
    assert p["cpplus"]["main"] == p["dahua"]["main"] and p["milestone"]["api"]["login_mode"] == "form"
    cfg = resolve({"id": "hq", "department": "Police", "vendor": "hikvision", "host": "10.0.0.5", "channels": 2,
                   "username_env": "HQ_USER", "password_env": "HQ_PASS"})
    assert cfg["adapter"] == "rtsp_template" and cfg["onvif_port"] == 80
    os.environ["HQ_USER"], os.environ["HQ_PASS"] = "viewer", "p@ss"
    ad = build(cfg)
    cams = ad.list_cameras()
    assert [c.native_id for c in cams] == ["hq-ch1", "hq-ch2"]
    assert cams[0].profiles["main"].url == "rtsp://viewer:p%40ss@10.0.0.5:554/Streaming/Channels/101"
    assert cams[1].profiles["sub"].url.endswith("/Streaming/Channels/202")
    d = build(resolve({"id": "d", "department": "Police", "vendor": "dahua", "host": "10.0.0.6",
                       "channels": [{"channel": 3, "id": "gate", "name": "Main gate", "lat": 1.0, "lon": 2.0}]}))
    c = d.list_cameras()[0]
    assert c.native_id == "gate" and c.name == "Main gate" and "channel=3&subtype=0" in c.profiles["main"].url and c.lat == 1.0
    with pytest.raises(ValueError):
        resolve({"id": "x", "vendor": "nonexistent"})
    v = client.get("/api/admin/vendors", headers=tok(client)).json()
    assert {"hikvision", "dahua", "cpplus", "uniview", "axis", "honeywell", "bosch", "milestone", "genetec"} <= set(v)


# ----------------------------------------------------------------------------- Vahan connector + PWA
def test_vahan_lookup_connector(client, monkeypatch):
    from uvp.config import settings
    import uvp.services.routes_ops as RO
    h = tok(client)
    assert client.get("/api/vehicles/MP04ZR7493/registration", headers=h).status_code == 501
    monkeypatch.setattr(settings, "vahan_url", "http://vahan.test/{plate}")
    monkeypatch.setattr(settings, "vahan_headers", json.dumps({"X-API-Key": "k"}))
    calls = []

    class R:
        ok = True
        def raise_for_status(self):
            pass
        def json(self):
            return {"regn_no": "MP04ZR7493", "maker_model": "HERO SPLENDOR", "status": "ACTIVE"}

    def fake_get(url, headers=None, timeout=0):
        calls.append((url, headers))
        return R()
    monkeypatch.setattr(RO.requests, "get", fake_get)
    r = client.get("/api/vehicles/mp04 zr 7493/registration", headers=h).json()
    assert r["registration"]["maker_model"] == "HERO SPLENDOR" and calls[0] == ("http://vahan.test/MP04ZR7493", {"X-API-Key": "k"})
    client.get("/api/vehicles/MP04ZR7493/registration", headers=h)
    assert len(calls) == 1                                                # cached
    assert client.get("/api/vehicles/MP04ZR7493/registration", headers=tok(client, "viewer", "viewer123")).status_code == 403
    audit = client.get("/api/audit?limit=5", headers=h).json()
    assert any(a["action"] == "vahan_lookup" and a["target"] == "MP04ZR7493" for a in audit)


def test_pwa_is_served(client):
    assert client.get("/m/").status_code == 200 and "manifest" in client.get("/m/").text
    m = client.get("/m/manifest.json").json()
    assert m["display"] == "standalone" and m["start_url"] == "/m/"
    assert "serviceWorker" in client.get("/m/app.js").text and client.get("/m/sw.js").status_code == 200
