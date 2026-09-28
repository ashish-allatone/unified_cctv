"""Phase-1 security: providers (local, mocked LDAP), TOTP MFA, lockout, JWT sessions, RBAC grants,
break-glass, plate masking, signed exports, hash-chained audit, legal holds and DPDP erasure.
Runs against an in-memory SQLite and the FastAPI test client; no network."""
import datetime as dt
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
os.environ["DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / '_sec_test.db'}"
os.environ["RELAY_API"] = "http://127.0.0.1:1"
os.environ["OBJECT_STORAGE"] = "local"
os.environ["SIGNING_KEY_FILE"] = str(Path(__file__).parent / "_sec_test_signing.key")
os.environ["AUTH_FILE"] = str(Path(__file__).parent / "auth_test.yaml")   # MFA required for admin + supervisor


@pytest.fixture(scope="module")
def client():
    for f in ("_sec_test.db", "_sec_test_signing.key"):
        p = Path(__file__).parent / f
        if p.exists():
            p.unlink()
    from uvp import db, storage
    from uvp.config import settings
    mp = pytest.MonkeyPatch()
    mp.setattr(settings, "database_url", f"sqlite:///{Path(__file__).parent / '_sec_test.db'}")
    mp.setattr(settings, "object_storage", "local")
    mp.setattr(settings, "relay_api", "http://127.0.0.1:1")
    mp.setattr(settings, "relay_playback", "http://127.0.0.1:1")
    mp.setattr(settings, "signing_key_file", Path(__file__).parent / "_sec_test_signing.key")
    mp.setattr(settings, "auth_file", Path(__file__).parent / "auth_test.yaml")   # explicit: module-level env is shared across test modules
    db.rebind(settings.database_url)
    mp.setattr(storage, "_store", None)
    from fastapi.testclient import TestClient
    from uvp.services.api import app
    with TestClient(app) as c:
        yield c
    mp.undo()
    for f in ("_sec_test.db", "_sec_test_signing.key"):
        p = Path(__file__).parent / f
        if p.exists():
            p.unlink()


def login(client, user, pw):
    return client.post("/api/auth/login", json={"username": user, "password": pw})


def hdr(tok):
    return {"Authorization": f"Bearer {tok}"}


_SECRETS: dict[str, str] = {}


def session(client, user, pw):
    """Login that completes the MFA step (enrolling on first need) - what the UI does."""
    import pyotp
    r = login(client, user, pw)
    assert r.status_code == 200, r.text
    j = r.json()
    if not j.get("mfa_required"):
        return j["token"]
    if j["enrol"]:
        e = client.post("/api/auth/mfa/enrol", headers=hdr(j["mfa_token"])).json()
        _SECRETS[user] = e["secret"]
        c = client.post("/api/auth/mfa/confirm", json={"code": pyotp.TOTP(e["secret"]).now()}, headers=hdr(j["mfa_token"]))
        assert c.status_code == 200, c.text
        return c.json()["token"]
    v = client.post("/api/auth/mfa/verify", json={"mfa_token": j["mfa_token"], "code": pyotp.TOTP(_SECRETS[user]).now()})
    assert v.status_code == 200, v.text
    return v.json()["token"]


# ----------------------------------------------------------------------------- providers
def test_local_login_and_effective_features(client):
    r = login(client, "police_op", "police123")
    assert r.status_code == 200, r.text
    me = r.json()["user"]
    assert me["role"] == "analyst" and "search" in me["features"] and "export" not in me["features"]
    r = login(client, "police_op", "wrong")
    assert r.status_code == 401


def test_lockout_after_repeated_failures(client):
    for _ in range(5):
        login(client, "viewer", "bad")
    r = login(client, "viewer", "viewer123")
    assert r.status_code == 423
    admin = session(client, "admin", "admin123")
    assert client.post("/api/admin/users/viewer/unlock", headers=hdr(admin)).status_code == 200
    assert login(client, "viewer", "viewer123").status_code == 200


def test_ldap_group_mapping_with_mock_server():
    import ldap3
    from uvp import auth as A
    # the mock strategy only binds DNs, so this uses an OpenLDAP-style DN template; AD uses "{username}@domain"
    cfg = {"server": "ldap://mock", "bind_template": "cn={username},dc=police,dc=gov,dc=in", "base_dn": "dc=police,dc=gov,dc=in",
           "user_filter": "(sAMAccountName={username})", "group_attr": "memberOf",
           "group_map": {"CN=CCTV-Operators,OU=Groups,DC=police,DC=gov,DC=in": {"role": "analyst", "departments": ["Police"]}}}

    def factory(server, user, password, **kw):
        conn = ldap3.Connection(server, user=user, password=password, client_strategy=ldap3.MOCK_SYNC)
        conn.strategy.add_entry("cn=ravi,dc=police,dc=gov,dc=in",
                                {"sAMAccountName": "ravi", "userPassword": "pw1", "objectClass": "person",
                                 "memberOf": ["CN=CCTV-Operators,OU=Groups,DC=police,DC=gov,DC=in"]})
        conn.bind()
        if not conn.bound:
            raise ldap3.core.exceptions.LDAPBindError("invalid credentials")
        return conn

    u = A._ldap("ravi", "pw1", cfg, connection_factory=factory)
    assert u and u.role == "analyst" and u.departments == ["Police"] and u.provider == "ldap"
    assert A._ldap("ravi", "nope", cfg, connection_factory=factory) is None


# ----------------------------------------------------------------------------- MFA
def test_totp_enrolment_and_login(client):
    import pyotp
    # supervisor is in mfa.required_roles: gets grace logins first, then must enrol
    r = login(client, "supervisor", "super123").json()
    assert r.get("mfa_enrol_required") is True
    tok = r["token"]
    e = client.post("/api/auth/mfa/enrol", headers=hdr(tok)).json()
    assert e["uri"].startswith("otpauth://totp/") and e["qr"].startswith("data:image/png")
    code = pyotp.TOTP(e["secret"]).now()
    _SECRETS["supervisor"] = e["secret"]
    c = client.post("/api/auth/mfa/confirm", json={"code": code}, headers=hdr(tok)).json()
    assert len(c["backup_codes"]) == 8 and c["user"]["mfa"] is True
    # next login now needs the second step
    r = login(client, "supervisor", "super123").json()
    assert r["mfa_required"] is True and r["enrol"] is False
    bad = client.post("/api/auth/mfa/verify", json={"mfa_token": r["mfa_token"], "code": "000000"})
    assert bad.status_code == 401
    good = client.post("/api/auth/mfa/verify", json={"mfa_token": r["mfa_token"], "code": pyotp.TOTP(e["secret"]).now()})
    assert good.status_code == 200 and good.json()["user"]["mfa"] is True
    # a backup code works once
    r = login(client, "supervisor", "super123").json()
    ok = client.post("/api/auth/mfa/verify", json={"mfa_token": r["mfa_token"], "code": c["backup_codes"][0]})
    assert ok.status_code == 200
    r = login(client, "supervisor", "super123").json()
    again = client.post("/api/auth/mfa/verify", json={"mfa_token": r["mfa_token"], "code": c["backup_codes"][0]})
    assert again.status_code == 401
    # the mfa step token cannot be used as a session
    assert client.get("/api/me", headers=hdr(r["mfa_token"])).status_code == 401


# ----------------------------------------------------------------------------- RBAC + grants + break-glass
def test_feature_guards_and_grants(client):
    viewer = login(client, "viewer", "viewer123").json()["token"]
    assert client.get("/api/events", headers=hdr(viewer)).status_code == 403
    assert client.get("/api/audit", headers=hdr(viewer)).status_code == 403
    admin = session(client, "admin", "admin123")
    g = client.post("/api/admin/grants", json={"username": "viewer", "kind": "feature", "value": "search",
                                              "reason": "control-room shift cover", "hours": 8}, headers=hdr(admin))
    assert g.status_code == 200
    # grants apply at refresh / next login
    viewer2 = client.post("/api/auth/refresh", headers=hdr(viewer)).json()["token"]
    assert client.get("/api/events", headers=hdr(viewer2)).status_code == 200
    assert client.get("/api/events?plate=MH12", headers=hdr(viewer2)).status_code == 403   # no plate_search
    client.delete(f"/api/admin/grants/{g.json()['id']}", headers=hdr(admin))
    viewer3 = client.post("/api/auth/refresh", headers=hdr(viewer2)).json()["token"]
    assert client.get("/api/events", headers=hdr(viewer3)).status_code == 403


def test_break_glass_elevates_and_is_audited(client):
    muni = login(client, "muni_op", "muni123").json()["token"]
    assert client.post("/api/auth/break-glass", json={"reason": "vehicle pursuit crossing city limits"},
                       headers=hdr(muni)).status_code == 403     # analysts may not
    admin = session(client, "admin", "admin123")
    short = client.post("/api/auth/break-glass", json={"reason": "short"}, headers=hdr(admin))
    assert short.status_code == 400
    bg = client.post("/api/auth/break-glass", json={"reason": "Court order 12/2026: trace vehicle across departments"},
                     headers=hdr(admin))
    assert bg.status_code == 200 and bg.json()["user"]["break_glass"]
    again = client.post("/api/auth/break-glass", json={"reason": "second attempt should be refused"}, headers=hdr(admin))
    assert again.status_code == 409
    audit = client.get("/api/audit?limit=20", headers=hdr(admin)).json()
    assert any(a["action"] == "break_glass" for a in audit)
    end = client.post("/api/auth/break-glass/end", headers=hdr(bg.json()["token"]))
    assert end.status_code == 200 and end.json()["user"]["break_glass"] is None


# ----------------------------------------------------------------------------- masking, audit chain, signing
def test_plate_masking_for_users_without_plate_search():
    from uvp import pii
    from uvp.auth import User
    assert pii.mask_plate("MP04ZR7493") == "MP04****93"
    ev = {"plate": "MP04ZR7493", "plate_raw": "MP04ZR7493", "camera_id": "c"}
    viewer = User("v", "viewer", ["*"], features=["live", "search"])
    analyst = User("a", "analyst", ["*"], features=["search", "plate_search"])
    assert pii.mask_event(ev, viewer)["plate"] == "MP04****93" and pii.mask_event(ev, viewer)["plate_masked"]
    assert pii.mask_event(ev, analyst)["plate"] == "MP04ZR7493"


def test_audit_chain_verifies_and_detects_tampering(client):
    admin = session(client, "admin", "admin123")
    v = client.get("/api/audit/verify", headers=hdr(admin)).json()
    assert v["ok"] is True and v["rows"] > 5
    from uvp.db import AuditLog, SessionLocal, verify_audit_chain
    with SessionLocal() as s:
        row = s.query(AuditLog).order_by(AuditLog.id.desc()).offset(3).first()
        row.detail = "edited after the fact"
        s.commit()
        bad = verify_audit_chain(s)
        assert bad["ok"] is False and bad["first_bad_id"] == row.id
        row.detail = row.detail  # leave it; later tests only need the endpoint to respond


def test_signed_csv_export_and_verify(client, tmp_path):
    import zipfile
    admin = session(client, "admin", "admin123")
    r = client.get("/api/events/export.csv", headers=hdr(admin))
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = tmp_path / "x.zip"
    z.write_bytes(r.content)
    with zipfile.ZipFile(z) as zf:
        names = set(zf.namelist())
        assert {"records.csv", "manifest.json", "manifest.sig", "public_key.pem"} <= names
        manifest = json.loads(zf.read("manifest.json"))
        sig = zf.read("manifest.sig").decode()
    ok = client.post("/api/verify", json={"manifest": manifest, "signature": sig}).json()
    assert ok["valid"] is True
    manifest["exported_by"] = "someone else"
    assert client.post("/api/verify", json={"manifest": manifest, "signature": sig}).json()["valid"] is False


def test_watermark_image_and_face_blur(tmp_path):
    import cv2
    import numpy as np
    from uvp import pii
    img = np.full((360, 640, 3), 90, np.uint8)
    src = tmp_path / "f.jpg"
    cv2.imwrite(str(src), img)
    pii.watermark_image(src, tmp_path / "w.jpg", pii.watermark_text("officer7", extra="MP04ZR7493"))
    out = cv2.imread(str(tmp_path / "w.jpg"))
    assert out is not None and out.shape == img.shape and (out != img).any()
    blurred, n = pii.blur_faces(img)
    assert blurred.shape == img.shape and n == 0


# ----------------------------------------------------------------------------- legal hold + DPDP + retention
def test_legal_hold_blocks_erasure_and_retention(client):
    from uvp.db import AnprEvent, SessionLocal, utcnow
    from uvp.services.archiver import apply_retention
    admin = session(client, "admin", "admin123")
    old = utcnow() - dt.timedelta(days=400)
    with SessionLocal() as s:
        s.add(AnprEvent(id="e" * 32, camera_id="police-cam1", department="Police", ts=old, plate="MP04ZR7493",
                        plate_raw="MP04ZR7493", confidence=0.9, reads=3, clip_key="-", crop_key="-", frame_key="-"))
        s.add(AnprEvent(id="f" * 32, camera_id="police-cam1", department="Police", ts=old, plate="MP70ZC2426",
                        plate_raw="MP70ZC2426", confidence=0.9, reads=3, clip_key="-", crop_key="-", frame_key="-"))
        s.commit()
    h = client.post("/api/admin/holds", json={"kind": "plate", "value": "MP04 ZR 7493", "reason": "FIR 88/2026",
                                             "reference": "FIR 88/2026"}, headers=hdr(admin))
    assert h.status_code == 200
    r = client.post("/api/dpdp/erase?plate=MP04ZR7493", headers=hdr(admin))
    assert r.status_code == 409
    removed = apply_retention()
    with SessionLocal() as s:
        assert s.get(AnprEvent, "e" * 32) is not None      # held
        assert s.get(AnprEvent, "f" * 32) is None          # older than events_days, purged
    assert removed.get("Police/events") == 1
    client.delete(f"/api/admin/holds/{h.json()['id']}", headers=hdr(admin))
    sa = client.get("/api/dpdp/subject-access?plate=MP04ZR7493", headers=hdr(admin)).json()
    assert sa["plate"] == "MP04ZR7493" and len(sa["events"]) == 1
    r = client.post("/api/dpdp/erase?plate=MP04ZR7493&reason=data principal request", headers=hdr(admin))
    assert r.status_code == 200 and r.json()["events_erased"] == 1


def test_compliance_status(client):
    admin = session(client, "admin", "admin123")
    c = client.get("/api/compliance/status", headers=hdr(admin)).json()
    assert c["audit"]["certin_180_days"] is True and c["exports"]["signed"] is True
    assert "plate_search" in c["identity"]["mfa_required_roles"] or c["identity"]["mfa_required_roles"] == ["admin", "supervisor"]
