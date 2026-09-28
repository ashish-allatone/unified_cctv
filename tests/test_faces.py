"""Persons of interest: enrolment API (photos -> embeddings), gallery matching, person_match incident -> alert
with last-seen bookkeeping, sightings listing, live counts endpoint. The face models are exercised for real
where a face can be synthesised; the enrolment API is tested with a stubbed engine so it runs anywhere."""
import io
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
DB_URL = f"sqlite:///{HERE / '_face_test.db'}"
DATA = HERE / "_face_data"


@pytest.fixture(scope="module")
def client():
    import shutil
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_face_test.db").unlink(missing_ok=True)
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
            s.merge(Camera(id="cam06", source_id="corp8", department="Corp8", name="Timbavadi gate", anpr_enabled=True, status="online", relay="relay"))
            s.commit()
        yield c
    mp.undo()


def tok(client, user="supervisor", pw="super123"):
    return {"Authorization": "Bearer " + client.post("/api/auth/login", json={"username": user, "password": pw}).json()["token"]}


def fake_jpeg() -> bytes:
    import cv2
    img = np.full((240, 200, 3), 200, np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    return buf.tobytes()


def test_gallery_matching_math():
    from uvp.analytics.faces import Gallery, cosine
    a = np.random.default_rng(1).normal(size=128).astype(np.float32)
    b = a + np.random.default_rng(2).normal(scale=0.15, size=128).astype(np.float32)   # same person, different photo
    c = np.random.default_rng(3).normal(size=128).astype(np.float32)                    # someone else
    g = Gallery([{"id": "p1", "name": "A", "embeddings": [a.tolist(), b.tolist()]}, {"id": "p2", "name": "B", "embeddings": [c.tolist()]}])
    assert len(g) == 3
    person, sim = g.match(a + 0.05 * c, threshold=0.5)
    assert person["id"] == "p1" and sim > 0.9
    person, sim = g.match(np.random.default_rng(9).normal(size=128).astype(np.float32), threshold=0.5)
    assert person is None and sim < 0.5
    assert abs(cosine(a, a) - 1.0) < 1e-6
    assert Gallery([]).match(a) == (None, 0.0)


def test_enrol_list_patch_delete_with_stubbed_engine(client, monkeypatch):
    from uvp.services import routes_persons as R
    emb = np.random.default_rng(5).normal(size=128).astype(np.float32)

    class Eng:
        def enrol_image(self, img, min_px=None):
            return emb, (40, 40, 140, 160), 1
    monkeypatch.setattr(R, "engine", lambda: Eng())
    h = tok(client)
    files = [("photos", ("a.jpg", fake_jpeg(), "image/jpeg")), ("photos", ("b.jpg", fake_jpeg(), "image/jpeg"))]
    r = client.post("/api/persons", data={"name": "Ravi Test", "category": "wanted", "priority": "high", "reference": "FIR 12/2026", "days": "30"}, files=files, headers=h)
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["photos"] == 2 and p["category"] == "wanted" and p["expires_at"] and p["active"] is True
    pid = p["id"]
    # photos stored under data/persons/<id> and served with auth
    assert client.get(p["photo_urls"][0], headers=h).status_code == 200
    assert client.get(p["photo_urls"][0]).status_code == 401
    # embeddings persisted
    from uvp.db import Person, SessionLocal
    with SessionLocal() as s:
        row = s.get(Person, pid)
        assert len(row.embeddings) == 2 and len(row.embeddings[0]) == 128
    # validation
    assert client.post("/api/persons", data={"name": "X", "category": "wanted"}, files=files, headers=h).status_code == 400
    assert client.post("/api/persons", data={"name": "Someone", "category": "alien"}, files=files, headers=h).status_code == 400
    # viewer can't enrol, analyst can list
    assert client.post("/api/persons", data={"name": "Nope", "category": "wanted"}, files=files, headers=tok(client, "viewer", "viewer123")).status_code == 403
    assert [x["name"] for x in client.get("/api/persons", headers=tok(client, "police_op", "police123")).json()] == ["Ravi Test"]
    # add a photo, pause, delete
    assert client.post(f"/api/persons/{pid}/photos", files=files[:1], headers=h).json()["photos"] == 3
    assert client.patch(f"/api/persons/{pid}", json={"active": False}, headers=h).json()["active"] is False
    assert client.delete(f"/api/persons/{pid}", headers=h).status_code == 200
    assert client.get("/api/persons", headers=h).json() == []
    # no face in photo -> 400 with the file name
    class NoFace:
        def enrol_image(self, img, min_px=None):
            raise ValueError("no face of at least 32 px found in the photo")
    monkeypatch.setattr(R, "engine", lambda: NoFace())
    r = client.post("/api/persons", data={"name": "Ghost", "category": "missing"}, files=files[:1], headers=h)
    assert r.status_code == 400 and "a.jpg" in r.json()["detail"]


def test_person_match_incident_becomes_alert_and_sighting(client, monkeypatch):
    from uvp.services import routes_persons as R
    emb = np.zeros(128, np.float32); emb[0] = 1

    class Eng:
        def enrol_image(self, img, min_px=None):
            return emb, (0, 0, 100, 100), 1
    monkeypatch.setattr(R, "engine", lambda: Eng())
    h = tok(client)
    pid = client.post("/api/persons", data={"name": "Meena Suspect", "category": "suspect", "priority": "high"},
                      files=[("photos", ("m.jpg", fake_jpeg(), "image/jpeg"))], headers=h).json()["id"]
    from uvp.config import settings
    secret = {"X-Internal-Secret": settings.internal_secret}
    ev = {"id": "f" * 32, "camera_id": "cam06", "department": "Corp8", "ts": "2026-09-27T09:00:00+00:00", "kind": "person_match",
          "zone": "", "priority": "high", "detail": {"person_id": pid, "name": "Meena Suspect", "category": "suspect", "score": 0.71, "face_px": 64},
          "bbox": [10, 10, 74, 90], "snapshot_path": ""}
    r = client.post("/internal/incidents", json=ev, headers=secret)
    assert r.status_code == 200 and r.json()["alerts"] == 1
    alerts = client.get("/api/alerts?open_only=true", headers=h).json()
    a = [x for x in alerts if x["watchlist_plate"] == "PERSON_MATCH"][0]
    assert a["match"] == "face" and "Meena Suspect" in a["reason"] and "0.71" in a["reason"] and a["camera_id"] == "cam06"
    # person bookkeeping + sightings endpoint
    p = [x for x in client.get("/api/persons", headers=h).json() if x["id"] == pid][0]
    assert p["sightings"] == 1 and p["last_seen_camera"] == "cam06"
    sg = client.get(f"/api/persons/{pid}/sightings", headers=h).json()
    assert len(sg) == 1 and sg[0]["score"] == 0.71 and sg[0]["camera_id"] == "cam06"
    # duplicate delivery is idempotent
    assert client.post("/internal/incidents", json=ev, headers=secret).json()["alerts"] == 0


def test_live_counts_from_detection_messages(client):
    from uvp.config import settings
    secret = {"X-Internal-Secret": settings.internal_secret}
    client.post("/internal/dets", json={"type": "dets", "camera_id": "cam06", "ts": "2026-09-27T09:00:00+00:00", "w": 1920, "h": 1080,
                                        "boxes": [["car", 0.9, 1, 1, 50, 50], ["truck", 0.8, 1, 1, 50, 50], ["person", 0.7, 1, 1, 20, 60]]}, headers=secret)
    client.post("/internal/dets", json={"type": "dets", "camera_id": "cam06", "ts": "2026-09-27T09:00:00+00:00", "w": 1920, "h": 1080, "kind": "face",
                                        "boxes": [["face:Meena Suspect 0.71", 0.9, 1, 1, 50, 50], ["face", 0.8, 1, 1, 50, 50]]}, headers=secret)
    r = client.get("/api/counts", headers=tok(client)).json()
    cam = [c for c in r["cameras"] if c["camera_id"] == "cam06"][0]
    assert cam["vehicles"] == 2 and cam["persons"] == 1 and cam["faces"] == 2 and cam["known"] == ["Meena Suspect 0.71"]
    assert r["total"]["vehicles"] == 2 and r["total"]["persons"] == 1


def test_real_models_detect_and_embed_when_present():
    """Smoke test of the bundled OpenCV Zoo models: they load and run; a synthetic frame has no face."""
    from uvp.analytics import faces
    if not faces.DET_MODEL.exists() or not faces.REC_MODEL.exists():
        pytest.skip("face models not bundled")
    eng = faces.FaceEngine()
    frame = np.zeros((360, 640, 3), np.uint8)
    assert eng.detect(frame) == []
    with pytest.raises(ValueError):
        eng.enrol_image(frame)


def test_video_analysis_finds_persons_matches_and_enrols(client, monkeypatch, tmp_path):
    """Two people appear in an uploaded clip; one of them is already enrolled. The analysis groups faces per
    person, reports the match, and can enrol the unknown one straight from the footage."""
    import cv2
    from uvp.services import routes_analysis as RA, routes_persons as RP
    from uvp.services import face_worker as FW
    ea = np.zeros(128, np.float32); ea[1] = 1                 # person A (already enrolled)
    eb = np.zeros(128, np.float32); eb[2] = 1                 # person B (unknown)

    class Eng:
        def detect(self, frame, max_width=960):               # frame index encoded in the top-left pixel
            k = int(round((int(frame[100, 100, 0]) - 40) / 25))   # brightness level survives lossy encoding
            ra = np.zeros(15, np.float32); ra[0] = 10; ra[14] = 0.95
            rb = np.zeros(15, np.float32); rb[0] = 200; rb[14] = 0.9
            faces = [{"bbox": (10, 10, 90, 100), "score": 0.95, "row": ra}]     # A in every frame
            if k % 2 == 0:
                faces.append({"bbox": (200, 20, 300, 130), "score": 0.9, "row": rb})   # B in even frames
            return faces
        def embed(self, frame, row):
            return ea if row[0] < 100 else eb
        def enrol_image(self, img, min_px=None):
            return ea, (10, 10, 90, 100), 1
    eng = Eng()
    monkeypatch.setattr(RA, "engine", lambda: eng)
    monkeypatch.setattr(RP, "engine", lambda: eng)
    h = tok(client)
    client.post("/api/persons", data={"name": "Known Person", "category": "wanted"}, files=[("photos", ("k.jpg", fake_jpeg(), "image/jpeg"))], headers=h)
    # 8-frame clip at 2 fps (sampled every frame)
    vid = tmp_path / "clip.mp4"
    w = cv2.VideoWriter(str(vid), cv2.VideoWriter_fourcc(*"mp4v"), 2, (320, 240))
    for k in range(8):
        fr = np.full((240, 320, 3), 40 + 25 * k, np.uint8)
        w.write(fr)
    w.release()
    r = client.post("/api/analyses", data={"plates": "0", "note": "complainant phone clip"}, files=[("files", ("clip.mp4", vid.read_bytes(), "video/mp4"))], headers=h)
    assert r.status_code == 202, r.text
    jid = r.json()["id"]
    import time
    for _ in range(100):
        a = client.get(f"/api/analyses/{jid}", headers=h).json()
        if a["status"] != "running":
            break
        time.sleep(0.1)
    assert a["status"] == "done", a
    assert a["frames"] == 8 and a["faces"] == 12
    assert len(a["persons"]) == 2
    known = [c for c in a["persons"] if c["match"]][0]
    unknown = [c for c in a["persons"] if not c["match"]][0]
    assert known["match"]["name"] == "Known Person" and known["count"] == 8
    assert unknown["count"] == 4 and unknown["best_crop_url"].startswith(f"/media/analyses/{jid}/")
    assert client.get(unknown["best_crop_url"], headers=h).status_code == 200
    # enrol the unknown person from the video
    r = client.post(f"/api/analyses/{jid}/enrol", json={"cluster": unknown["cluster"], "name": "Phone Video Suspect", "category": "suspect"}, headers=h)
    assert r.status_code == 201 and r.json()["embeddings"] >= 1
    names = [p["name"] for p in client.get("/api/persons", headers=h).json()]
    assert "Phone Video Suspect" in names
    assert client.get(f"/api/analyses/{jid}", headers=h).json()["persons"][unknown["rank"] - 1]["enrolled_person_id"]
    # listing + delete
    assert any(x["id"] == jid for x in client.get("/api/analyses", headers=h).json())
    assert client.delete(f"/api/analyses/{jid}", headers=h).status_code == 200
    assert client.get(f"/api/analyses/{jid}", headers=h).status_code == 404
    # unsupported file type
    assert client.post("/api/analyses", files=[("files", ("x.txt", b"hello", "text/plain"))], headers=h).status_code == 400
