"""Centralised CCTV registry: manual / API onboarding, CSV bulk import (dry run + apply), filters, export,
audit trail, stats and the coverage gap analysis."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
DB_URL = f"sqlite:///{HERE / '_reg_test.db'}"
DATA = HERE / "_reg_data"


@pytest.fixture(scope="module")
def client():
    import shutil
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_reg_test.db").unlink(missing_ok=True)
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
            s.merge(Source(id="corp8", department="Corp8", name="Corp8", adapter="rtsp_template", max_concurrent_pulls=30))
            # an integrated camera with a live feed, heading east, at Ellis Bridge
            s.merge(Camera(id="cam01", source_id="corp8", department="Corp8", name="Ellis Bridge", status="online", relay="relay",
                           lat=23.0225, lon=72.5714, heading=90, fov=70, range_m=120, profiles={"main": {}}, install_date="2018-01-15"))
            s.commit()
        yield c
    mp.undo()


def tok(client, user="supervisor", pw="super123"):
    return {"Authorization": "Bearer " + client.post("/api/auth/login", json={"username": user, "password": pw}).json()["token"]}


def test_manual_onboarding_edit_history_and_delete(client):
    h = tok(client)
    body = {"name": "Law Garden gate", "department": "Municipal", "lat": 23.0281, "lon": 72.5589, "camera_type": "dome",
            "ownership": "department", "connectivity": "fibre", "storage_type": "nvr", "storage_days": 15,
            "install_date": "2024-02-01", "maintenance_status": "ok", "zone": "West", "tags": ["garden", "gate"]}
    r = client.post("/api/registry", json=body, headers=h)
    assert r.status_code == 201, r.text
    row = r.json()
    assert row["id"] == "reg-municipal-law-garden-gate" and row["registry_only"] is True and row["health"] == "not-integrated"
    # duplicate id refused, invalid enum refused
    assert client.post("/api/registry", json=body, headers=h).status_code == 409
    bad = dict(body, name="x", camera_type="spycam")
    assert "camera_type" in client.post("/api/registry", json=bad, headers=h).json()["detail"]
    # list + filters
    rows = client.get("/api/registry", headers=h).json()
    assert {x["id"] for x in rows} == {"cam01", row["id"]}
    assert [x["id"] for x in client.get("/api/registry?integrated=no", headers=h).json()] == [row["id"]]
    assert [x["id"] for x in client.get("/api/registry?q=ellis", headers=h).json()] == ["cam01"]
    assert client.get("/api/registry?camera_type=dome", headers=h).json()[0]["id"] == row["id"]
    # edit -> audited history
    r = client.patch(f"/api/registry/{row['id']}", json={"maintenance_status": "due", "storage_days": 30}, headers=h)
    assert r.status_code == 200 and r.json()["maintenance_status"] == "due"
    hist = client.get(f"/api/registry/{row['id']}/history", headers=h).json()
    acts = [c["action"] for c in hist["changes"]]
    assert "registry_create" in acts and "registry_update" in acts
    assert any("maintenance_status" in c["detail"] for c in hist["changes"])
    # feed-managed camera: metadata editable, but cannot be deleted through the registry
    assert client.patch("/api/registry/cam01", json={"ownership": "department", "camera_type": "anpr"}, headers=h).status_code == 200
    assert client.delete("/api/registry/cam01", headers=h).status_code == 409
    # viewer can read, not write
    v = tok(client, "viewer", "viewer123")
    assert client.get("/api/registry", headers=v).status_code == 200
    assert client.post("/api/registry", json=body | {"name": "nope"}, headers=v).status_code == 403
    assert client.delete(f"/api/registry/{row['id']}", headers=h).status_code == 200
    assert client.get(f"/api/registry/{row['id']}", headers=h).status_code == 404


def test_csv_bulk_import_dry_run_then_apply_and_export(client):
    h = tok(client)
    tpl = client.get("/api/registry/template.csv", headers=h).text
    assert tpl.splitlines()[0].startswith("id,name,department,lat,lon")
    csv_text = (
        "id,name,department,lat,lon,heading,fov,range_m,camera_type,ownership,connectivity,storage_type,storage_days,install_date,maintenance_status,zone,tags,pole_no\n"
        "amc-01,Paldi cross roads,Municipal,23.0117,72.5606,0,90,100,bullet,department,fibre,nvr,30,2019-06-01,ok,West,junction;signal,P-77\n"
        ",Nehru bridge west,Municipal,23.0270,72.5760,,,,fixed,vendor-managed,4g,dvr,7,2016-03-10,due,Central,,\n"
        "rto-01,RTO gate ANPR,Transport,23.0500,72.5900,180,60,80,anpr,department,lan,nvr,90,2025-01-20,ok,North,,\n"
        "bad-01,Missing dept,,23.0,72.5,,,,dome,,,,,,,,,\n"
        "bad-02,Bad enum,Police,23.0,72.5,,,,webcam,,,,,2020-13-40,,,,\n"
    )
    files = {"file": ("cams.csv", csv_text.encode(), "text/csv")}
    dry = client.post("/api/registry/import?apply=0", files=files, headers=h).json()
    assert dry["rows"] == 5 and dry["valid"] == 3 and len(dry["errors"]) == 2 and dry["created"] == 0
    assert dry["errors"][0]["row"] == 5 and "department is required" in dry["errors"][0]["errors"]
    assert any("camera_type" in e for e in dry["errors"][1]["errors"]) and any("install_date" in e for e in dry["errors"][1]["errors"])
    # apply with errors present: nothing written
    res = client.post("/api/registry/import?apply=1", files=files, headers=h).json()
    assert res["created"] == 0 and "nothing was written" in res["note"]
    assert len(client.get("/api/registry?integrated=no", headers=h).json()) == 0
    # clean file -> created; second run -> unchanged; changed row -> updated
    good = "\n".join(csv_text.splitlines()[:4]) + "\n"
    files = {"file": ("cams.csv", good.encode(), "text/csv")}
    res = client.post("/api/registry/import?apply=1", files=files, headers=h).json()
    assert res["created"] == 3 and res["errors"] == []
    rows = {r["id"]: r for r in client.get("/api/registry?integrated=no", headers=h).json()}
    assert set(rows) == {"amc-01", "reg-municipal-nehru-bridge-west", "rto-01"}
    assert rows["amc-01"]["tags"] == ["junction", "signal"] and rows["amc-01"]["meta"] == {"pole_no": "P-77"}
    assert rows["reg-municipal-nehru-bridge-west"]["lat"] == 23.027 and rows["reg-municipal-nehru-bridge-west"]["age_years"] > 9
    res = client.post("/api/registry/import?apply=1", files=files, headers=h).json()
    assert res["unchanged"] == 3 and res["created"] == 0
    changed = good.replace("30,2019-06-01,ok", "60,2019-06-01,under_repair")
    res = client.post("/api/registry/import?apply=1", files={"file": ("cams.csv", changed.encode(), "text/csv")}, headers=h).json()
    assert res["updated"] == 1 and res["unchanged"] == 2
    # export carries every column and the derived fields; audited
    exp = client.get("/api/registry/export.csv?department=Municipal", headers=h).text
    lines = exp.splitlines()
    assert lines[0].startswith("id,name,department") and "integrated" in lines[0] and len(lines) == 3
    audit = client.get("/api/audit?limit=50", headers=tok(client, "admin", "admin123")).json()
    acts = [a["action"] for a in (audit if isinstance(audit, list) else audit.get("rows", audit.get("items", [])))]
    assert "registry_import" in acts and "registry_export" in acts


def test_stats_and_gap_analysis(client):
    h = tok(client)
    st = client.get("/api/registry/stats", headers=h).json()
    assert st["total"] == 4 and st["registry_only"] == 3 and st["integrated"] == 1
    assert st["by_department"]["Municipal"] == 2 and st["by_type"]["anpr"] == 2
    assert st["ageing"] >= 2 and st["maintenance_due"] == 2 and st["storage_below_policy"] == 1   # nehru: due, amc-01: under_repair
    rep = client.get("/api/registry/gaps?cell_m=100", headers=h).json()
    assert rep["cameras"] == 4 and rep["located"] == 4 and rep["cells"] > 20
    assert 0 < rep["coverage_pct"] < 100 and rep["covered"] + rep["uncovered"] == rep["cells"]
    assert rep["gaps"][0]["nearest_m"] >= rep["gaps"][-1]["nearest_m"]       # biggest holes first
    assert [a["id"] for a in rep["ageing"]][:1] == ["reg-municipal-nehru-bridge-west"]
    assert rep["storage_below_policy"][0]["id"] == "reg-municipal-nehru-bridge-west"
    assert {m["id"] for m in rep["maintenance"]} == {"amc-01", "reg-municipal-nehru-bridge-west"}
    # a camera under repair does not count as covering its cell
    assert rep["working_cameras"] == 3
    csv_out = client.get("/api/registry/gaps?format=csv", headers=h).text
    assert csv_out.splitlines()[0] == "lat,lon,nearest_camera,nearest_department,nearest_m"
    html = client.get("/api/registry/gaps?format=html", headers=h).text
    assert "<h1>CCTV coverage gap analysis</h1>" in html and "Nehru bridge west" in html and "amc-01" in html
    # the map exposes registry cameras with their type for the GIS layers
    m = client.get("/api/map", headers=h).json()["cameras"]
    assert any(c["registry_only"] and c["camera_type"] == "anpr" for c in m)
    # registry-only cameras never count towards the licence
    from uvp.db import Camera, SessionLocal
    with SessionLocal() as s:
        assert sum(1 for c in s.query(Camera) if not c.registry_only) == 1


def test_geocode_from_names_review_then_apply(client, monkeypatch):
    """Cameras without coordinates are looked up by name (geocoder stubbed); dry run lists candidates, apply writes
    the best one and audits it; cameras that already have coordinates are left alone."""
    from uvp.services import routes_registry as R
    calls = []
    def fake(q):
        calls.append(q)
        if "Paldi" in q:
            return [{"lat": 23.0117, "lon": 72.5606, "label": "Paldi Circle, Ahmedabad, Gujarat, India", "score": 0.6, "type": "junction"}]
        return [{"error": "no result"}]
    monkeypatch.setattr(R, "geocode", fake)
    monkeypatch.setattr(R.time, "sleep", lambda s: None)
    h = tok(client)
    client.post("/api/registry", json={"name": "cam 04 - Paldi Circle", "department": "Municipal"}, headers=h)
    client.post("/api/registry", json={"name": "Unknown place xyz", "department": "Municipal"}, headers=h)
    r = client.post("/api/registry/geocode", json={}, headers=h).json()
    ids = {x["id"]: x for x in r["rows"]}
    assert "reg-municipal-cam-04-paldi-circle" in ids and ids["reg-municipal-cam-04-paldi-circle"]["query"] == "Paldi Circle"
    assert ids["reg-municipal-cam-04-paldi-circle"]["best"]["lat"] == 23.0117 and ids["reg-municipal-unknown-place-xyz"]["best"] is None
    assert r["applied"] == 0 and "cam01" not in ids                      # cam01 already has coordinates
    r = client.post("/api/registry/geocode", json={"apply": True}, headers=h).json()
    assert r["applied"] == 1 and r["remaining_without_coordinates"] == 1
    row = client.get("/api/registry/reg-municipal-cam-04-paldi-circle", headers=h).json()
    assert row["lat"] == 23.0117 and row["meta"]["geocoded_from"] == "Paldi Circle"
    hist = client.get("/api/registry/reg-municipal-cam-04-paldi-circle/history", headers=h).json()
    assert any(c["action"] == "registry_geocode" for c in hist["changes"])
    # free-text lookup
    assert client.post("/api/registry/geocode", json={"query": "Paldi Circle"}, headers=h).json()["candidates"][0]["lat"] == 23.0117
    # viewer cannot geocode
    assert client.post("/api/registry/geocode", json={}, headers=tok(client, "viewer", "viewer123")).status_code == 403
