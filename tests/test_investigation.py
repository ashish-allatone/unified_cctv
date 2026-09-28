"""Phase-2 investigation tooling: cases + custody chain + signed bundle with PDF, timeline + stitched
clip, bookmarks cut from archived segments, coverage geometry and nearest-camera search."""
import datetime as dt
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
os.environ["DATABASE_URL"] = f"sqlite:///{HERE / '_inv_test.db'}"
os.environ["RELAY_API"] = "http://127.0.0.1:1"
os.environ["RELAY_PLAYBACK"] = "http://127.0.0.1:1"
os.environ["OBJECT_STORAGE"] = "local"
os.environ["DATA_DIR"] = str(HERE / "_inv_data")
os.environ["SIGNING_KEY_FILE"] = str(HERE / "_inv_data" / "signing.key")
os.environ["AUTH_FILE"] = str(ROOT / "config" / "auth.yaml")   # MFA optional here


def _mp4(path: Path, seconds: float, colour: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={colour}:s=320x180:r=15:d={seconds}",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path)], check=True)


@pytest.fixture(scope="module")
def client():
    import shutil
    shutil.rmtree(HERE / "_inv_data", ignore_errors=True)
    (HERE / "_inv_test.db").unlink(missing_ok=True)
    from uvp import db, storage
    from uvp.config import settings
    mp = pytest.MonkeyPatch()
    mp.setattr(settings, "database_url", f"sqlite:///{Path(__file__).parent / '_inv_test.db'}")
    mp.setattr(settings, "object_storage", "local")
    mp.setattr(settings, "relay_api", "http://127.0.0.1:1")
    mp.setattr(settings, "relay_playback", "http://127.0.0.1:1")
    mp.setattr(settings, "data_dir", Path(__file__).parent / "_inv_data")
    mp.setattr(settings, "signing_key_file", Path(__file__).parent / "_inv_data" / "signing.key")
    mp.setattr(settings, "auth_file", ROOT / "config" / "auth.yaml")   # explicit: module-level env is shared across test modules
    db.rebind(settings.database_url)
    mp.setattr(storage, "_store", None)
    from fastapi.testclient import TestClient
    from uvp.services.api import app
    with TestClient(app) as c:
        seed()
        yield c
    mp.undo()
    shutil.rmtree(HERE / "_inv_data", ignore_errors=True)
    (HERE / "_inv_test.db").unlink(missing_ok=True)


def seed():
    from uvp.db import AnprEvent, Camera, Recording, SessionLocal, Source
    from uvp.storage import store
    import cv2
    import numpy as np
    st = store()
    t0 = dt.datetime(2026, 9, 22, 6, 0, tzinfo=dt.timezone.utc)
    with SessionLocal() as s:
        s.merge(Source(id="police", department="Police", name="P", adapter="rtsp"))
        s.merge(Source(id="municipal", department="Municipal", name="M", adapter="rtsp"))
        s.merge(Camera(id="police-cam1", source_id="police", department="Police", name="Toll lane 1", lat=19.076, lon=72.8777, heading=45, fov=60, range_m=120, anpr_enabled=True))
        s.merge(Camera(id="muni-cam1", source_id="municipal", department="Municipal", name="Market gate", lat=19.079, lon=72.880, heading=180, fov=90, range_m=100, anpr_enabled=True))
        s.merge(Camera(id="police-cam3", source_id="police", department="Police", name="No geo", anpr_enabled=False))
        s.flush()
        for i, cam in enumerate(["police-cam1", "muni-cam1", "police-cam1"]):
            eid = f"{i:032x}"
            ts = t0 + dt.timedelta(minutes=5 * i)
            day = ts.strftime("%Y-%m-%d")
            crops = (HERE / "_inv_data") / "crops" / day
            crops.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(crops / f"{eid}_plate.jpg"), np.full((40, 120, 3), 200, np.uint8))
            cv2.imwrite(str(crops / f"{eid}_frame.jpg"), np.full((180, 320, 3), 60, np.uint8))
            clip = (HERE / "_inv_data") / f"clip{i}.mp4"
            _mp4(clip, 2, ["red", "green", "blue"][i])
            key = f"clips/{'Police' if cam.startswith('police') else 'Municipal'}/{cam}/{day}/{eid}.mp4"
            st.put_file(clip, key, "video/mp4")
            s.add(AnprEvent(id=eid, camera_id=cam, department="Police" if cam.startswith("police") else "Municipal", ts=ts,
                            plate="MP04ZR7493", plate_raw="MP04ZR7493", confidence=0.9, reads=3,
                            crop_path=f"crops/{day}/{eid}_plate.jpg", frame_path=f"crops/{day}/{eid}_frame.jpg", clip_key=key,
                            crop_key="-", frame_key="-", tags=[]))
        # two archived 60 s segments for bookmark cutting (no live relay in tests)
        for j in range(2):
            seg = (HERE / "_inv_data") / f"seg{j}.mp4"
            _mp4(seg, 60, "gray")
            start = dt.datetime(2026, 9, 22, 7, 0, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=60 * j)
            key = f"recordings/Police/police-cam1/main/2026-09-22/{start:%H-%M-%S}.mp4"
            st.put_file(seg, key, "video/mp4")
            s.add(Recording(camera_id="police-cam1", department="Police", profile="main", start_ts=start, duration_s=60, key=key, bytes=seg.stat().st_size))
        s.commit()


def tok(client, user="admin", pw="admin123"):
    r = client.post("/api/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200 and "token" in r.json(), r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_geometry():
    from uvp import investigation as I
    poly = I.coverage_polygon(19.076, 72.8777, 45, 60, 120)
    assert poly[0] == [19.076, 72.8777] and poly[-1] == poly[0] and len(poly) == 15
    assert 100 < I.haversine_m(19.076, 72.8777, *poly[7]) < 121   # centre ray reaches range
    circle = I.coverage_polygon(19.0, 72.0, None, None, 50)
    assert len(circle) == 18


def test_map_and_nearest(client):
    h = tok(client)
    m = client.get("/api/map", headers=h).json()
    assert {c["id"] for c in m["cameras"]} == {"police-cam1", "muni-cam1"} and len(m["cameras"][0]["coverage"]) > 10
    # a point 60 m north-east of police-cam1 is inside its 45 deg / 60 deg cone
    from uvp.investigation import _offset
    lat, lon = _offset(19.076, 72.8777, 45, 60)
    n = client.get(f"/api/map/nearest?lat={lat}&lon={lon}&n=3", headers=h).json()["cameras"]
    assert n[0]["id"] == "police-cam1" and n[0]["covers_point"] is True and n[0]["distance_m"] == 60
    lat2, lon2 = _offset(19.076, 72.8777, 225, 60)   # behind the camera: near but not covered
    n2 = client.get(f"/api/map/nearest?lat={lat2}&lon={lon2}&n=3", headers=h).json()["cameras"]
    assert n2[0]["id"] == "police-cam1" and n2[0]["covers_point"] is False
    # department scoping
    pol = tok(client, "police_op", "police123")
    ids = {c["id"] for c in client.get("/api/map", headers=pol).json()["cameras"]}
    assert ids == {"police-cam1"}


def test_timeline_and_stitch(client, tmp_path):
    h = tok(client)
    t = client.get("/api/vehicles/MP04ZR7493/timeline", headers=h).json()
    assert len(t["sightings"]) == 3 and t["clips_available"] == 3 and len(t["legs"]) == 2
    assert t["legs"][0]["seconds"] == 300 and t["legs"][0]["kmh"] is not None
    r = client.get("/api/vehicles/MP04ZR7493/stitch", headers=h)
    assert r.status_code == 200 and r.headers["content-type"] == "video/mp4"
    out = tmp_path / "t.mp4"
    out.write_bytes(r.content)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
                               capture_output=True, text=True).stdout.strip())
    assert 5.5 <= dur <= 6.6     # 3 x 2 s clips
    # analysts without export cannot stitch; viewers cannot see the timeline
    pol = tok(client, "police_op", "police123")
    assert client.get("/api/vehicles/MP04ZR7493/stitch", headers=pol).status_code == 403
    assert client.get("/api/vehicles/MP04ZR7493/timeline", headers=pol).json()["clips_available"] == 2   # police clips only


def test_bookmark_cut_from_archive(client):
    h = tok(client)
    b = client.post("/api/bookmarks", json={"camera_id": "police-cam1", "ts": "2026-09-22T07:00:50+00:00", "label": "scuffle at gate",
                                            "before_s": 5, "after_s": 20}, headers=h)
    assert b.status_code == 200 and b.json()["clip"] == "pending"
    c = client.post(f"/api/bookmarks/{b.json()['id']}/cut", headers=h)
    assert c.status_code == 200 and c.json()["clip"] == "ready", c.text
    assert c.json()["play_url"].startswith("/archive/bookmarks/Police/police-cam1/")
    lst = client.get("/api/bookmarks?camera=police-cam1", headers=h).json()
    assert lst and lst[0]["label"] == "scuffle at gate"


def test_case_lifecycle_custody_and_export(client, tmp_path):
    h = tok(client)
    c = client.post("/api/cases", json={"title": "Hit and run, Ring Road", "reference": "FIR 88/2026", "priority": "high",
                                        "department": "Police"}, headers=h).json()
    assert c["number"].startswith("CASE-2026-") and c["status"] == "open"
    cid = c["id"]
    ev = client.get("/api/events?plate=MP04ZR7493", headers=h).json()["events"]
    for e in ev[:2]:
        assert client.post(f"/api/cases/{cid}/items", json={"kind": "event", "ref_id": e["id"], "note": "vehicle of interest"}, headers=h).status_code == 200
    bm = client.get("/api/bookmarks", headers=h).json()[0]
    assert client.post(f"/api/cases/{cid}/items", json={"kind": "bookmark", "ref_id": bm["id"]}, headers=h).status_code == 200
    assert client.post(f"/api/cases/{cid}/items", json={"kind": "note", "note": "Witness statement collected 22/09."}, headers=h).status_code == 200
    st = client.get(f"/api/vehicles/MP04ZR7493/stitch?case_id={cid}", headers=h)
    assert st.status_code == 200
    d = client.get(f"/api/cases/{cid}", headers=h).json()
    assert d["items"] == 5 or len(d["items"]) == 5
    kinds = [i["kind"] for i in d["items"]]
    assert kinds.count("event") == 2 and "bookmark" in kinds and "note" in kinds and "stitch" in kinds
    assert d["custody_chain"]["ok"] and len(d["custody"]) >= 6
    # assignment + close/reopen are recorded in the custody chain
    assert client.patch(f"/api/cases/{cid}", json={"owner": "police_op", "status": "closed"}, headers=h).json()["status"] == "closed"
    assert client.post(f"/api/cases/{cid}/items", json={"kind": "note", "note": "late"}, headers=h).status_code == 409
    client.patch(f"/api/cases/{cid}", json={"status": "open"}, headers=h)
    # export bundle
    r = client.get(f"/api/cases/{cid}/export", headers=h)
    assert r.status_code == 200
    z = tmp_path / "case.zip"
    z.write_bytes(r.content)
    with zipfile.ZipFile(z) as zf:
        names = zf.namelist()
        assert "report.pdf" in names and "manifest.json" in names and "manifest.sig" in names and "case.json" in names
        assert any(n.endswith("_clip.mp4") for n in names) and any(n.endswith("_frame.jpg") for n in names)
        assert any(n.startswith("05_stitch") or n.startswith("04_stitch") for n in names)
        manifest = json.loads(zf.read("manifest.json"))
        sig = zf.read("manifest.sig").decode()
        assert zf.read("report.pdf")[:5] == b"%PDF-"
        assert manifest["custody_chain_head"]
    assert client.post("/api/verify", json={"manifest": manifest, "signature": sig}).json()["valid"] is True
    d2 = client.get(f"/api/cases/{cid}", headers=h).json()
    assert d2["custody"][-1]["action"] == "exported" and d2["custody_chain"]["ok"]
    # the assigned officer (police_op, analyst) sees the case; a municipal analyst does not
    assert client.get(f"/api/cases/{cid}", headers=tok(client, "police_op", "police123")).status_code == 200
    assert client.get(f"/api/cases/{cid}", headers=tok(client, "muni_op", "muni123")).status_code == 404
