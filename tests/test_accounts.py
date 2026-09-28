"""Database accounts + 2FA end to end: first-run signup (once only), super-admin-only user management, the
users.yaml demo accounts switching off, and the challenge-token / session-token login split around TOTP."""
import sys
from pathlib import Path

import pyotp
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
DB_URL = f"sqlite:///{HERE / '_acc_test.db'}"
DATA = HERE / "_acc_data"


@pytest.fixture(scope="module")
def client():
    import shutil
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_acc_test.db").unlink(missing_ok=True)
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
        yield c
    mp.undo()


def hdr(tok):
    return {"Authorization": f"Bearer {tok}"}


def test_first_run_signup_then_closed(client):
    assert client.get("/api/auth/setup").json()["needs_setup"] is True
    # demo yaml account works while no db account exists
    assert client.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).status_code == 200
    # weak password refused
    r = client.post("/api/auth/signup", json={"username": "naresh", "password": "short"})
    assert r.status_code == 400 and "at least" in r.json()["detail"]
    r = client.post("/api/auth/signup", json={"username": "Naresh", "password": "Gujarat2026!x"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["user"]["username"] == "naresh" and j["user"]["role"] == "admin" and j["user"]["is_super"] is True
    assert j["mfa_setup_recommended"] is True
    # second signup is closed
    r = client.post("/api/auth/signup", json={"username": "other", "password": "Gujarat2026!x"})
    assert r.status_code == 409
    assert client.get("/api/auth/setup").json() == {**client.get("/api/auth/setup").json(), "needs_setup": False, "yaml_users": False}
    # yaml demo accounts are now ignored
    assert client.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).status_code == 401
    # db login works and goes straight to a session (no 2FA yet)
    r = client.post("/api/auth/login", json={"username": "naresh", "password": "Gujarat2026!x"})
    assert r.status_code == 200 and "token" in r.json() and not r.json().get("mfa_required")


def _super(client):
    return client.post("/api/auth/login", json={"username": "naresh", "password": "Gujarat2026!x"}).json()["token"]


def test_super_admin_manages_users_and_others_cannot(client):
    su = _super(client)
    r = client.post("/api/users", json={"username": "ops1", "password": "Operator2026", "role": "analyst", "departments": ["Corp8"]}, headers=hdr(su))
    assert r.status_code == 201, r.text
    assert r.json()["provider"] == "db" and r.json()["is_super"] is False
    # duplicate + bad role
    assert client.post("/api/users", json={"username": "ops1", "password": "Operator2026", "role": "analyst"}, headers=hdr(su)).status_code == 400
    assert client.post("/api/users", json={"username": "x1", "password": "Operator2026", "role": "god"}, headers=hdr(su)).status_code == 400
    # a plain admin (not super) cannot create or delete
    client.post("/api/users", json={"username": "admin2", "password": "Operator2026", "role": "admin"}, headers=hdr(su))
    a2 = client.post("/api/auth/login", json={"username": "admin2", "password": "Operator2026"}).json()["token"]
    assert client.post("/api/users", json={"username": "x2", "password": "Operator2026", "role": "viewer"}, headers=hdr(a2)).status_code == 403
    assert client.delete("/api/users/ops1", headers=hdr(a2)).status_code == 403
    assert client.get("/api/users", headers=hdr(a2)).status_code == 200                 # admins may list
    # ops1 (analyst) may not even list
    o = client.post("/api/auth/login", json={"username": "ops1", "password": "Operator2026"}).json()["token"]
    assert client.get("/api/users", headers=hdr(o)).status_code == 403
    # guards: cannot delete self / last super admin, cannot deactivate self
    assert client.delete("/api/users/naresh", headers=hdr(su)).status_code == 400
    assert client.patch("/api/users/naresh", json={"is_active": False}, headers=hdr(su)).status_code == 400
    # deactivate -> login refused; reactivate -> ok
    assert client.patch("/api/users/admin2", json={"is_active": False}, headers=hdr(su)).status_code == 200
    assert client.post("/api/auth/login", json={"username": "admin2", "password": "Operator2026"}).status_code == 401
    assert client.patch("/api/users/admin2", json={"is_active": True}, headers=hdr(su)).status_code == 200
    # set password
    assert client.patch("/api/users/admin2", json={"password": "Renewed2026x"}, headers=hdr(su)).status_code == 200
    assert client.post("/api/auth/login", json={"username": "admin2", "password": "Renewed2026x"}).status_code == 200
    names = [u["username"] for u in client.get("/api/users", headers=hdr(su)).json()]
    assert names == ["admin2", "naresh", "ops1"]
    # the legacy admin listing shows db accounts and no yaml demo users any more
    legacy = client.get("/api/admin/users", headers=hdr(su)).json()
    assert {u["provider"] for u in legacy} == {"db"} and any(u["is_super"] for u in legacy)


def test_two_factor_setup_challenge_and_disable(client):
    o = client.post("/api/auth/login", json={"username": "ops1", "password": "Operator2026"}).json()["token"]
    assert client.get("/api/auth/mfa/status", headers=hdr(o)).json()["state"] == "off"
    e = client.post("/api/auth/mfa/enrol", headers=hdr(o)).json()
    assert e["secret"] and e["uri"].startswith("otpauth://totp/")
    assert client.get("/api/auth/mfa/status", headers=hdr(o)).json()["state"] == "pending"
    # pending enrolment does not yet force the challenge
    assert "token" in client.post("/api/auth/login", json={"username": "ops1", "password": "Operator2026"}).json()
    # wrong code refused, right code activates and returns 8 backup codes
    assert client.post("/api/auth/mfa/confirm", json={"code": "000000"}, headers=hdr(o)).status_code == 400
    r = client.post("/api/auth/mfa/confirm", json={"code": pyotp.TOTP(e["secret"]).now()}, headers=hdr(o))
    assert r.status_code == 200 and len(r.json()["backup_codes"]) == 8 and r.json()["user"]["mfa"] is True
    backup = r.json()["backup_codes"][0]
    # login now returns a challenge token instead of a session
    r = client.post("/api/auth/login", json={"username": "ops1", "password": "Operator2026"}).json()
    assert r["mfa_required"] is True and r["enrol"] is False and "token" not in r
    # the challenge token is not a session
    assert client.get("/api/me", headers=hdr(r["mfa_token"])).status_code == 401
    assert client.post("/api/auth/mfa/verify", json={"mfa_token": r["mfa_token"], "code": "123456"}).status_code == 401
    ok = client.post("/api/auth/mfa/verify", json={"mfa_token": r["mfa_token"], "code": pyotp.TOTP(e["secret"]).now()})
    assert ok.status_code == 200 and ok.json()["user"]["mfa"] is True
    sess = ok.json()["token"]
    assert client.get("/api/me", headers=hdr(sess)).json()["mfa"] is True
    # backup code works once
    r2 = client.post("/api/auth/login", json={"username": "ops1", "password": "Operator2026"}).json()
    assert client.post("/api/auth/mfa/verify", json={"mfa_token": r2["mfa_token"], "code": backup}).status_code == 200
    r3 = client.post("/api/auth/login", json={"username": "ops1", "password": "Operator2026"}).json()
    assert client.post("/api/auth/mfa/verify", json={"mfa_token": r3["mfa_token"], "code": backup}).status_code == 401
    # user turns 2FA off with a current code -> next login is single step
    assert client.post("/api/auth/mfa/disable", json={"code": "000000"}, headers=hdr(sess)).status_code == 401
    assert client.post("/api/auth/mfa/disable", json={"code": pyotp.TOTP(e["secret"]).now()}, headers=hdr(sess)).status_code == 200
    assert "token" in client.post("/api/auth/login", json={"username": "ops1", "password": "Operator2026"}).json()


def test_delete_removes_account_and_mfa_state(client):
    su = _super(client)
    o = client.post("/api/auth/login", json={"username": "ops1", "password": "Operator2026"}).json()["token"]
    e = client.post("/api/auth/mfa/enrol", headers=hdr(o)).json()
    client.post("/api/auth/mfa/confirm", json={"code": pyotp.TOTP(e["secret"]).now()}, headers=hdr(o))
    assert client.delete("/api/users/ops1", headers=hdr(su)).status_code == 200
    from uvp.db import SessionLocal, Users
    with SessionLocal() as s:
        assert s.get(Users, "ops1") is None            # one row = account + 2FA + lockout, all gone
    # (a later failed login attempt recreates a bare lockout-tracking row, which is intended)
    assert client.post("/api/auth/login", json={"username": "ops1", "password": "Operator2026"}).status_code == 401
    # re-creating the same username starts clean (no leftover 2FA)
    assert client.post("/api/users", json={"username": "ops1", "password": "Operator2026", "role": "viewer"}, headers=hdr(su)).status_code == 201
    assert "token" in client.post("/api/auth/login", json={"username": "ops1", "password": "Operator2026"}).json()
