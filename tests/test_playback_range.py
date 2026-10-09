"""Custom time-range playback: list the segments between two times, combine them into one MP4, play and download it."""
import datetime as dt
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
DATA = HERE / "_pbr_data"
DB_URL = f"sqlite:///{HERE / '_pbr_test.db'}"
os.environ.setdefault("RELAY_API", "http://127.0.0.1:1")
T0 = dt.datetime(2026, 10, 9, 4, 30, tzinfo=dt.timezone.utc)        # 10:00 IST
SEG = 10                                                            # seconds per test segment


def _mp4(path: Path, seconds: float, colour: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={colour}:s=320x180:r=15:d={seconds}",
                    "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path)], check=True)


def _dur(p) -> float:
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                                capture_output=True, text=True).stdout.strip())


@pytest.fixture(scope="module")
def client():
    import shutil
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_pbr_test.db").unlink(missing_ok=True)
    from uvp import db, storage
    from uvp.config import settings
    mp = pytest.MonkeyPatch()
    mp.setattr(settings, "database_url", DB_URL)
    mp.setattr(settings, "object_storage", "local")
    mp.setattr(settings, "relay_api", "http://127.0.0.1:1")
    mp.setattr(settings, "relay_playback", "http://127.0.0.1:1")
    mp.setattr(settings, "data_dir", DATA)
    mp.setattr(settings, "signing_key_file", DATA / "signing.key")
    mp.setattr(settings, "auth_file", ROOT / "config" / "auth.yaml")
    db.rebind(DB_URL)
    mp.setattr(storage, "_store", None)
    from fastapi.testclient import TestClient
    from uvp.services.api import app
    with TestClient(app) as c:
        seed()
        yield c
    mp.undo()
    shutil.rmtree(DATA, ignore_errors=True)
    (HERE / "_pbr_test.db").unlink(missing_ok=True)


def seed():
    """Six 10 s segments from T0, with segment 3 missing (a 10 s gap): 0-10, 10-20, 20-30, [gap], 40-50, 50-60."""
    from uvp.db import Camera, Recording, SessionLocal, Source
    from uvp.storage import store
    st = store()
    DATA.mkdir(parents=True, exist_ok=True)
    with SessionLocal() as s:
        s.merge(Source(id="police", department="Police", name="P", adapter="rtsp"))
        s.merge(Camera(id="police-cam1", source_id="police", department="Police", name="Toll lane 1", anpr_enabled=True))
        s.merge(Camera(id="police-cam2", source_id="police", department="Police", name="Not recorded", anpr_enabled=False))
        s.flush()
        for j, colour in enumerate(["red", "green", "blue", None, "yellow", "white"]):
            if colour is None:
                continue
            seg = DATA / f"seg{j}.mp4"
            _mp4(seg, SEG, colour)
            start = T0 + dt.timedelta(seconds=SEG * j)
            key = f"recordings/Police/police-cam1/main/{start:%Y-%m-%d}/{start:%H-%M-%S}.mp4"
            st.put_file(seg, key, "video/mp4")
            s.add(Recording(camera_id="police-cam1", department="Police", profile="main", start_ts=start, duration_s=SEG, key=key,
                            bytes=seg.stat().st_size))
        s.commit()


def tok(client, user="admin", pw="admin123"):
    r = client.post("/api/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200 and "token" in r.json(), r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def _wait(client, h, name, cam="police-cam1"):
    for _ in range(120):
        st = client.get(f"/api/cameras/{cam}/recordings/combined/{name}/status", headers=h).json()
        if st["status"] in ("ready", "failed"):
            return st
        time.sleep(0.25)
    raise AssertionError("combine did not finish")


def test_parse_time():
    from uvp import combine as C
    u = int(T0.timestamp())
    assert C.parse_time(u) == C.parse_time(str(u)) == C.parse_time(u * 1000) == T0
    assert C.parse_time("2026-10-09T10:00:00+05:30") == C.parse_time("2026-10-09T04:30:00Z") == T0
    assert C.parse_time("2026-10-09T10:00:00") == T0                     # no zone -> IST
    with pytest.raises(ValueError):
        C.parse_time("yesterday")


def test_range_lists_segments_and_gaps(client):
    h = tok(client)
    u = int(T0.timestamp())
    r = client.get(f"/api/cameras/police-cam1/recordings/range?from={u + 5}&to={u + 55}", headers=h)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["count"] == 5 and j["requested_s"] == 50 and j["recorded_s"] == 40
    assert len(j["gaps"]) == 1 and j["gaps"][0]["seconds"] == 10
    assert j["from_unix"] == u + 5 and all(x["url"] for x in j["segments"])
    # ISO works the same; an empty window is not an error
    iso = client.get("/api/cameras/police-cam1/recordings/range", headers=h,
                     params={"from": "2026-10-09T10:00:05+05:30", "to": "2026-10-09T10:00:55+05:30"}).json()
    assert iso["count"] == 5
    assert client.get(f"/api/cameras/police-cam1/recordings/range?from={u + 3600}&to={u + 3700}", headers=h).json()["count"] == 0


def test_range_validation(client):
    h = tok(client)
    u = int(T0.timestamp())
    assert client.get(f"/api/cameras/police-cam1/recordings/range?from={u + 10}&to={u}", headers=h).status_code == 400
    assert client.get(f"/api/cameras/police-cam1/recordings/range?from={u}&to={u + 10 * 86400}", headers=h).status_code == 400
    assert client.get(f"/api/cameras/police-cam1/recordings/range?from=nope&to={u}", headers=h).status_code == 400
    assert client.get(f"/api/cameras/nope/recordings/range?from={u}&to={u + 10}", headers=h).status_code == 404
    assert client.post("/api/cameras/police-cam2/recordings/combine", headers=h, json={"from": u, "to": u + 30}).status_code == 404


def test_combine_play_download(client):
    h = tok(client)
    u = int(T0.timestamp())
    # 10:00:05 .. 10:00:28 lies inside the first three contiguous segments
    r = client.post("/api/cameras/police-cam1/recordings/combine", headers=h, json={"from": u + 5, "to": u + 28})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["count"] == 3 and j["name"].startswith(f"{u + 5}-{u + 28}-") and j["status"] in ("queued", "building", "ready")
    st = _wait(client, h, j["name"])
    assert st["status"] == "ready", st
    assert 22 <= st["duration_s"] <= 24.5, st                   # trimmed to the requested 23 s (key frame every 1 s)
    assert st["filename"] == "police-cam1_2026-10-09_10-00-05_to_2026-10-09_10-00-28_IST.mp4"

    # play: whole file and a byte range (seeking), with the token in the query string as the <video> tag sends it
    t = h["Authorization"][7:]
    full = client.get(st["url"], params={"token": t})
    assert full.status_code == 200 and full.headers["content-type"] == "video/mp4" and len(full.content) == st["bytes"]
    part = client.get(st["url"], params={"token": t}, headers={"Range": "bytes=0-99"})
    assert part.status_code == 206 and len(part.content) == 100
    out = DATA / "dl.mp4"
    out.write_bytes(full.content)
    assert abs(_dur(out) - st["duration_s"]) < 0.2

    # download: attachment with a readable name
    d = client.get(f'{st["download_url"]}&token={t}')
    assert d.status_code == 200 and "attachment" in d.headers["content-disposition"] and st["filename"] in d.headers["content-disposition"]

    # same range again -> same file, immediately ready
    again = client.post("/api/cameras/police-cam1/recordings/combine", headers=h, json={"from": u + 5, "to": u + 28}).json()
    assert again["name"] == j["name"] and again["status"] == "ready"

    with __import__("uvp.db", fromlist=["SessionLocal"]).SessionLocal() as s:
        from uvp.db import AuditLog
        from sqlalchemy import select
        acts = {a for (a,) in s.execute(select(AuditLog.action))}
    assert {"combine_recordings", "download_recording"} <= acts


def test_combine_across_gap(client):
    h = tok(client)
    u = int(T0.timestamp())
    j = client.post("/api/cameras/police-cam1/recordings/combine", headers=h, json={"from": u, "to": u + 60}).json()
    assert j["count"] == 5 and j["recorded_s"] == 50 and len(j["gaps"]) == 1
    st = _wait(client, h, j["name"])
    assert st["status"] == "ready" and 49 <= st["duration_s"] <= 51, st    # the recorded parts, joined back to back


def test_unknown_name_and_auth(client):
    h = tok(client)
    assert client.get("/api/cameras/police-cam1/recordings/combined/1-2-zz.mp4/status", headers=h).status_code == 404
    assert client.get("/api/cameras/police-cam1/recordings/combined/1791000000-1791000060-0123456789.mp4/status", headers=h).json()["status"] == "failed"
    assert client.get("/api/cameras/police-cam1/recordings/combined/1791000000-1791000060-0123456789.mp4", headers=h).status_code == 404
    assert client.get("/api/cameras/police-cam1/recordings/range?from=1&to=2").status_code == 401
