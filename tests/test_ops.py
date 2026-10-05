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


# ----------------------------------------------------------------------------- voice call channel (BulkOBD dialer)
def test_voice_call_channel_and_ack_callback(client, monkeypatch, tmp_path):
    import uvp.notify as N
    from uvp.config import settings
    from uvp.db import Alert, Notification, SessionLocal, utcnow
    h = tok(client)
    cfg = tmp_path / "notify.yaml"
    cfg.write_text("""
channels:
  voice: {type: voice, url: http://obd.test/OBDSEA, username: acc, password: pw, ack_digit: "1", max_call_s: 40, tts: dialer}
routes:
  - {kind: alert, priority: high, channel: voice, to: ["9876543210"]}
""")
    monkeypatch.setattr(settings, "notify_file", cfg)
    monkeypatch.setattr(settings, "voice_callback_key", "k123")
    calls = []

    class R:
        ok, status_code, text = True, 200, '{"status":"queued","campid":"5551"}'
    monkeypatch.setattr(N.requests, "post", lambda url, json=None, data=None, files=None, headers=None, timeout=0: (calls.append({"url": url, "json": json or {k: (int(v[1]) if v[1].lstrip("-").isdigit() else v[1]) for k, v in (files or {}).items()}}) or R()))
    with SessionLocal() as s:
        s.add(Alert(id="al" + "0" * 30, event_id="e", plate="GJ01AB1234", watchlist_plate="GJ01AB1234", camera_id="police-cam1", department="Police",
                    ts=utcnow(), priority="high", reason="stolen vehicle"))
        s.commit()
    N.deliver_now("alert", {"id": "al" + "0" * 30, "plate": "GJ01AB1234", "department": "Police", "priority": "high", "match": "exact",
                            "watchlist_plate": "GJ01AB1234", "reason": "stolen vehicle", "camera_id": "police-cam1", "ts": "2026-09-22T10:00:00+00:00"})
    assert calls and calls[0]["url"] == "http://obd.test/OBDSEA/voiceBlast"
    body = calls[0]["json"]
    assert body["numbers"].startswith("919876543210,arg1:") and body["camp_type"] == 4 and body["soundId"] == 0 and str(body["valid_option"]) == "1"
    assert body["tts_text"] == "{var1}" and body["var1"] == body["numbers"].split("arg1:", 1)[1]
    spoken = body["var1"]
    assert "G J 0 1 A B 1 2 3 4" in spoken and "Press 1 to acknowledge" in spoken and "15 30" in spoken
    assert not any(c in spoken for c in "<>,:;{}")
    assert body["campname"].startswith("uvp-") and body["maxcallTimeSec"] == 40 and body["username"] == "acc"
    with SessionLocal() as s:
        n = s.scalar(N.select(Notification).where(Notification.channel == "voice").order_by(Notification.ts.desc()).limit(1))
        assert n.status == "sent" and "call queued to 919876543210" in n.detail
        nid = n.id
    # the dialer reports the result: answered, pressed 1 -> alert acknowledged by phone
    assert client.post("/api/integrations/voice/callback?key=wrong", json={"campid": f"uvp-{nid}"}).status_code == 403
    r = client.post("/api/integrations/voice/callback?key=k123", json={"campid": f"uvp-{nid}", "number": "919876543210", "response": "1",
                                                                       "duration": "22", "dialstatus": "ANSWERED", "callanswertime": "2026-09-22 15:30:05"})
    assert r.status_code == 200 and r.json() == {"matched": True, "acknowledged": True}
    with SessionLocal() as s:
        assert s.get(Notification, nid).status == "answered"
        a = s.get(Alert, "al" + "0" * 30)
        assert a.ack_at is not None and a.ack_by == "voice:919876543210"
    # form-encoded callback, matched by number when campid is the provider's own id
    r = client.post("/api/integrations/voice/callback?key=k123", data={"campid": "5551", "number": "9876543210", "dialstatus": "NO ANSWER", "response": ""})
    assert r.json()["matched"] is True
    with SessionLocal() as s:
        assert s.get(Notification, nid).status == "no_answer"
    # admin test call
    t = client.post("/api/admin/notifications/test?channel=voice&to=9876543210", headers=h).json()
    assert t["status"] == "sent" and "test call" in calls[-1]["json"]["var1"].lower()
    # HTTP 200 but refused by the dialer (outside its calling window) must show as failed, with the reason
    class Refused:
        ok, status_code, text = True, 200, '{"response":"Campaign Can schedule between 9 AM to 7 PM","error_code":400,"status":"failed"}'
        def json(self): return {"response": "Campaign Can schedule between 9 AM to 7 PM", "error_code": 400, "status": "failed"}
    monkeypatch.setattr(N.requests, "post", lambda url, json=None, data=None, files=None, headers=None, timeout=0: Refused())
    monkeypatch.setattr(N.time, "sleep", lambda s: None)
    t = client.post("/api/admin/notifications/test?channel=voice&to=9876543210", headers=h).json()
    assert t["status"] == "failed" and "between 9 AM to 7 PM" in t["detail"] and "24x7" in t["detail"]


def test_notification_routes_and_channel_toggle_from_console(client, monkeypatch, tmp_path):
    import uvp.notify as N
    from uvp.config import settings
    from uvp.db import Setting, SessionLocal
    h = tok(client)
    cfg = tmp_path / "notify.yaml"
    cfg.write_text("""
channels:
  sms:   {type: sms, enabled: false, url: http://sms.test/send, body: {to: "{to}", message: "{text}"}}
  voice: {type: voice, url: http://obd.test/OBDSEA, username: acc, password: pw, tts: dialer}
routes:
  - {kind: alert, priority: high, channel: sms, to: ["+911"]}
""")
    monkeypatch.setattr(settings, "notify_file", cfg)
    with SessionLocal() as s:                                   # start from the yaml
        for k in ("notify_routes", "notify_channels"):
            row = s.get(Setting, k)
            if row: s.delete(row)
        s.commit()
    st = client.get("/api/admin/notifications", headers=h).json()
    assert st["routes_source"] == "yaml" and st["routes"][0]["to"] == ["+911"] and st["routes"][0]["id"] == "y1"
    assert {c["name"]: c["enabled"] for c in st["channels"]} == {"sms": False, "voice": True}
    # change the number + add a voice route from the console
    r = client.put("/api/admin/notifications/routes", json={"routes": [
        {"kind": "alert", "priority": "high", "channel": "sms", "to": "98765 43210, +91 9876543211"},
        {"kind": "alert", "priority": "high", "subkind": "exact", "channel": "voice", "to": ["9123456789"]},
        {"kind": "camera.health", "channel": "voice", "to": ["9123456789"], "enabled": False}]}, headers=h)
    assert r.status_code == 200 and r.json()["routes"][0]["to"] == ["9876543210", "+919876543211"]
    assert client.put("/api/admin/notifications/routes", json={"routes": [{"kind": "alert", "channel": "voice", "to": ["12"]}]}, headers=h).status_code == 400
    assert client.put("/api/admin/notifications/routes", json={"routes": [{"kind": "alert", "channel": "nope", "to": ["9123456789"]}]}, headers=h).status_code == 400
    # channel switch from the console
    assert client.patch("/api/admin/notifications/channels/sms", json={"enabled": True}, headers=h).json()["enabled"] is True
    assert client.patch("/api/admin/notifications/channels/zzz", json={"enabled": True}, headers=h).status_code == 404
    c = N.cfg()
    assert c["channels"]["sms"]["enabled"] is True and c["routes_source"] == "console"
    assert [r["channel"] for r in c["routes"]] == ["sms", "voice"]           # the disabled route is left out
    assert c["routes"][0]["to"] == ["9876543210", "+919876543211"]
    calls = []

    class R:
        ok, status_code, text = True, 200, "ok"
    monkeypatch.setattr(N.requests, "request", lambda method, url, json=None, headers=None, timeout=0: (calls.append(("sms", json["to"])) or R()))
    monkeypatch.setattr(N.requests, "post", lambda url, json=None, data=None, files=None, headers=None, timeout=0: (calls.append(("voice", ((files or {}).get("numbers") or (None, ""))[1].split(",")[0])) or R()))
    N.deliver_now("alert", {"id": "a1", "plate": "GJ01AB0001", "department": "Police", "priority": "high", "match": "exact", "camera_id": "police-cam1", "ts": "2026-10-05T10:00:00+00:00"})
    assert ("sms", "9876543210") in calls and ("sms", "+919876543211") in calls and ("voice", "919123456789") in calls
    # back to yaml
    assert client.delete("/api/admin/notifications/routes", headers=h).json()["ok"]
    assert client.get("/api/admin/notifications", headers=h).json()["routes_source"] == "yaml"
    acts = [a["action"] for a in client.get("/api/audit?limit=10", headers=h).json()]
    assert "notify_routes" in acts and "notify_channel" in acts


def test_voice_local_tts_clip_is_uploaded_and_played(client, monkeypatch, tmp_path):
    """When the dialer's own TTS is silent: speak locally (espeak-ng), upload the MP3, play it by soundId."""
    import uvp.notify as N
    from uvp.config import settings
    h = tok(client)
    cfg = tmp_path / "notify.yaml"
    cfg.write_text("""
channels:
  voice: {type: voice, url: http://obd.test/OBDSEA, username: acc, password: pw, ack_digit: "1"}
routes: []
""")
    monkeypatch.setattr(settings, "notify_file", cfg)
    monkeypatch.setattr(N, "_tts_mp3", lambda text, ch: b"ID3fake-mp3" if "test call" in text.lower() and "press 1" in text.lower() else None)
    posts = []

    class Up:
        ok, status_code, text = True, 200, '{"sounid":4471,"response":"Sound successfully upload","status":"success"}'

    class Blast:
        ok, status_code, text = True, 200, '{"CampaignId":586301,"response":"Your Campaign has schedule","status":"success"}'

    def fake_post(url, json=None, data=None, files=None, headers=None, timeout=0):
        posts.append({"url": url, "data": data, "files": files})
        return Up() if url.endswith("/uploadSound") else Blast()
    monkeypatch.setattr(N.requests, "post", fake_post)
    t = client.post("/api/admin/notifications/test?channel=voice&to=9876543210", headers=h).json()
    assert t["status"] == "sent" and "sound 4471" in t["detail"] and "campaign 586301" in t["detail"]
    up = posts[0]
    assert up["url"] == "http://obd.test/OBDSEA/uploadSound" and up["data"]["username"] == "acc" and up["files"]["file"][1] == b"ID3fake-mp3"
    blast = {k: v[1] for k, v in posts[1]["files"].items()}
    assert blast["soundId"] == "4471" and blast["camp_type"] == "2" and blast["tts_text"] == "NA" and blast["numbers"] == "919876543210" and blast["valid_option"] == "1"
    # real espeak-ng output is a playable MP3 when the tool is present
    import shutil
    if shutil.which("espeak-ng") and shutil.which("ffmpeg"):
        monkeypatch.undo()
        mp3 = N._tts_mp3("Unified CCTV alert. Watch list vehicle G J 0 1 A B 1 2 3 4 seen at Toll.", {})
        assert mp3 and len(mp3) > 2000
