"""401 back-off: a direct-RTSP source whose pulls all fail with Unauthorized gets its relay paths removed for
AUTH_BACKOFF_S and is marked in the registry, instead of retrying every camera until the vendor locks the account.
Also covers the parallel camera pool used by the ANPR / analytics workers."""
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
HERE = Path(__file__).parent
DB_URL = f"sqlite:///{HERE / '_backoff_test.db'}"


@pytest.fixture(scope="module")
def db_ready():
    (HERE / "_backoff_test.db").unlink(missing_ok=True)
    from uvp import db
    from uvp.config import settings
    mp = pytest.MonkeyPatch()
    mp.setattr(settings, "database_url", DB_URL)
    mp.setattr(settings, "auth_backoff_s", 600)
    db.rebind(DB_URL)
    db.init_db()
    from uvp.db import Camera, SessionLocal, Source
    with SessionLocal() as s:
        s.merge(Source(id="corp8", department="Corp8", name="Corp8", adapter="rtsp_template", max_concurrent_pulls=30, status="ok"))
        for i in (1, 2):
            s.merge(Camera(id=f"cam0{i}", source_id="corp8", department="Corp8", name=f"cam {i}", anpr_enabled=True, status="online", relay="relay"))
        s.commit()
    yield
    mp.undo()


SCFG = {"id": "corp8", "adapter": "rtsp_template", "department": "Corp8", "host": "203.0.113.9", "rtsp_port": 8554,
        "main": "rtsp://{host}:{rtsp_port}/stream/cam{channel:02d}", "username": "u@x.in", "password": "secret",
        "channels": [{"channel": 1, "id": "cam01"}, {"channel": 2, "id": "cam02"}]}


def test_401_pauses_source_and_removes_relay_paths(db_ready, monkeypatch):
    from uvp.services import adapter_service as A
    from uvp.db import Camera, SessionLocal, Source
    deleted = []
    monkeypatch.setattr(A.relay, "delete_path", lambda name, relay_name=None: deleted.append(name))
    monkeypatch.setattr(A, "_probe_auth", lambda url: "401")
    A._paused_until.clear(); A._last_probe.clear()
    configured = {"cam01/main": ("rtsp://x/1", True, True), "cam01/sub": ("rtsp://x/1", False, False), "cam02/main": ("rtsp://x/2", True, True)}
    live = {"cam01/main": {"name": "cam01/main", "ready": False, "readers": []}, "cam02/main": {"name": "cam02/main", "ready": False, "readers": []}}
    A.auth_backoff(SCFG, live, configured)
    assert A.source_paused("corp8")
    assert sorted(deleted) == ["cam01/main", "cam01/sub", "cam02/main"]
    with SessionLocal() as s:
        src = s.get(Source, "corp8")
        assert src.status == "error" and "401" in src.status_detail and "paused" in src.status_detail
        assert all(c.status == "offline" for c in s.query(Camera).filter(Camera.source_id == "corp8"))
    # while paused: no second probe, no more deletes
    deleted.clear()
    A._last_probe.clear()
    A.auth_backoff(SCFG, live, configured)
    assert deleted == []
    # pause expiry -> eligible again
    A._paused_until["corp8"] = time.time() - 1
    assert not A.source_paused("corp8")


def test_no_pause_when_a_pull_is_ready_or_nothing_is_requested(db_ready, monkeypatch):
    from uvp.services import adapter_service as A
    probes = []
    monkeypatch.setattr(A, "_probe_auth", lambda url: probes.append(url) or "401")
    A._paused_until.clear(); A._last_probe.clear()
    configured = {"cam01/main": ("rtsp://x/1", True)}
    A.auth_backoff(SCFG, {"cam01/main": {"ready": True, "readers": []}}, configured)     # one pull works
    assert probes == [] and not A.source_paused("corp8")
    A.auth_backoff(SCFG, {"cam01/main": {"ready": False, "readers": []}}, {"cam01/main": ("rtsp://x/1", False)})  # on-demand, idle
    assert probes == [] and not A.source_paused("corp8")
    A.auth_backoff({**SCFG, "adapter": "vendor_rest"}, {"cam01/main": {"ready": False, "readers": [1]}}, configured)  # not direct RTSP
    assert probes == []


def test_other_errors_do_not_pause(db_ready, monkeypatch):
    from uvp.services import adapter_service as A
    monkeypatch.setattr(A, "_probe_auth", lambda url: "timeout")
    A._paused_until.clear(); A._last_probe.clear()
    A.auth_backoff(SCFG, {"cam01/main": {"ready": False, "readers": [1]}}, {"cam01/main": ("rtsp://x/1", False)})
    assert not A.source_paused("corp8")


def test_camera_pool_one_in_flight_per_camera():
    from uvp.services.parallel import CameraPool, worker_count
    assert worker_count(0, 2, cameras=100) >= 1
    assert worker_count(4, 2, cameras=2) == 2 and worker_count(4, 2) == 4
    pool = CameraPool(3, "t")
    seen, hold = [], time.time() + 0.3
    def step(cid, frame, ts):
        while time.time() < hold:
            time.sleep(0.01)
        seen.append(cid)
    assert pool.submit("a", step, None, 0.0) and pool.submit("b", step, None, 0.0)
    assert not pool.submit("a", step, None, 0.0)          # a is still in flight
    assert pool.busy("a") and pool.pending() == 2
    while pool.pending():
        time.sleep(0.01)
    assert sorted(seen) == ["a", "b"]
    assert pool.submit("a", step, None, 0.0)               # free again
    while pool.pending():
        time.sleep(0.01)
    pool.shutdown()


def test_single_stream_camera_sub_reads_relay_main_not_gateway(db_ready, monkeypatch, tmp_path):
    """Corp8 gives one URL per camera: the relay must open ONE gateway session per camera, with `sub` re-reading
    the relay's own `main` path (loopback), not a second pull from the gateway."""
    import yaml
    from uvp.services import adapter_service as A
    from uvp.config import settings
    sf = tmp_path / "sources.yaml"
    sf.write_text(yaml.safe_dump({"sources": [SCFG]}))
    monkeypatch.setattr(settings, "sources_file", sf)
    monkeypatch.setattr(settings, "license_file", tmp_path / "none.json", raising=False)
    monkeypatch.setattr(A.licensing, "load", lambda: {})
    upserts = {}
    fake_relay = A.relay.assign("cam01")
    monkeypatch.setattr(fake_relay, "upsert_path", lambda name, url, record=False, persistent=False: upserts.__setitem__(name, (url, record, persistent)) or "added")
    monkeypatch.setattr(A.settings, "relay_add_stagger_s", 0.0)
    monkeypatch.setattr(fake_relay, "delete_path", lambda name: None)
    monkeypatch.setattr(A.relay, "ping_all", lambda: None)
    monkeypatch.setattr(A.relay, "live_paths", lambda max_age=0: [])
    monkeypatch.setattr(A.relay, "configured_by_relay", lambda: {})
    monkeypatch.setattr(A, "record_wanted", lambda scfg, nid, anpr: True)
    monkeypatch.setattr(A, "auth_backoff", lambda *a, **k: None)
    A._paused_until.clear()
    A.sync_once()
    assert upserts["cam01/main"][0].startswith("rtsp://u%40x.in:secret@203.0.113.9:8554/stream/cam01") or "203.0.113.9" in upserts["cam01/main"][0]
    assert upserts["cam01/main"][1] is True and upserts["cam01/main"][2] is True   # 2 cameras <= cap -> steady session
    sub_url, sub_rec, sub_persist = upserts["cam01/sub"]
    assert sub_persist is False
    assert "203.0.113.9" not in sub_url and sub_url.endswith("@127.0.0.1:8554/cam01/main") and sub_rec is False
    assert upserts["cam02/sub"].endswith("@127.0.0.1:8554/cam02/main") if isinstance(upserts["cam02/sub"], str) else upserts["cam02/sub"][0].endswith("/cam02/main")
    # a camera with a real, different sub stream keeps its own gateway pull
    upserts.clear()
    cfg2 = dict(SCFG, sub="rtsp://{host}:{rtsp_port}/stream/cam{channel:02d}_low")
    sf.write_text(yaml.safe_dump({"sources": [cfg2]}))
    A.sync_once()
    assert "203.0.113.9" in upserts["cam01/sub"][0] and upserts["cam01/sub"][0].endswith("/stream/cam01_low")


def test_steady_sessions_bounded_by_cap(db_ready, monkeypatch, tmp_path):
    """max_concurrent_pulls: 1 with 2 cameras -> only the first camera keeps a steady session, the other is on demand."""
    import yaml
    from uvp.services import adapter_service as A
    from uvp.config import settings
    sf = tmp_path / "sources.yaml"
    sf.write_text(yaml.safe_dump({"sources": [dict(SCFG, max_concurrent_pulls=1)]}))
    monkeypatch.setattr(settings, "sources_file", sf)
    monkeypatch.setattr(A.licensing, "load", lambda: {})
    monkeypatch.setattr(A.settings, "relay_add_stagger_s", 0.0)
    ups = {}
    fake = A.relay.assign("cam01")
    monkeypatch.setattr(fake, "upsert_path", lambda name, url, record=False, persistent=False: ups.__setitem__(name, (record, persistent)) or "added")
    monkeypatch.setattr(fake, "delete_path", lambda name: None)
    monkeypatch.setattr(A.relay, "ping_all", lambda: None)
    monkeypatch.setattr(A.relay, "live_paths", lambda max_age=0: [])
    monkeypatch.setattr(A.relay, "configured_by_relay", lambda: {})
    monkeypatch.setattr(A, "record_wanted", lambda scfg, nid, anpr: False)
    monkeypatch.setattr(A, "auth_backoff", lambda *a, **k: None)
    monkeypatch.setattr(A, "db_sources_changed", lambda: False)
    A._paused_until.clear()
    A.sync_once()
    assert ups["cam01/main"] == (False, True) and ups["cam02/main"] == (False, False)
    assert ups["cam01/sub"] == (False, False)


def test_learned_session_cap_demotes_refused_steady_pulls(db_ready, monkeypatch):
    """3 steady pulls configured, only 2 come up within the grace period -> the third becomes on demand, the source
    remembers cap 2, and the next sync ranks only 2 cameras as steady."""
    import time as _t
    from uvp.services import adapter_service as A
    from uvp.db import Camera, SessionLocal, Source
    with SessionLocal() as s:
        s.merge(Camera(id="cam03", source_id="corp8", department="Corp8", name="cam 3", status="online", relay="relay"))
        s.commit()
    A._effective_cap.clear(); A._steady_since.clear()
    configured = {f"cam0{i}/main": (f"rtsp://x/{i}", False, True) for i in (1, 2, 3)}
    live = {"cam01/main": {"ready": True}, "cam02/main": {"ready": True}, "cam03/main": {"ready": False}}
    demoted = []
    fake = A.relay.for_camera("cam03")
    monkeypatch.setattr(fake, "upsert_path", lambda name, url, record=False, persistent=False: demoted.append((name, persistent)) or "updated")
    # within the grace period: nothing happens
    A._steady_since["cam03/main"] = _t.time()
    A.learn_session_cap(SCFG, live, configured)
    assert demoted == [] and "corp8" not in A._effective_cap
    # after the grace period: demoted, cap learned, operators can read why on the Sources page
    A._steady_since["cam03/main"] = _t.time() - 200
    A.learn_session_cap(SCFG, live, configured)
    assert demoted == [("cam03/main", False)] and A._effective_cap["corp8"] == 2
    with SessionLocal() as s:
        assert "accepted 2 steady sessions" in s.get(Source, "corp8").status_detail
    # everything failed is not a cap problem (401 back-off handles it): no demotion
    demoted.clear(); A._effective_cap.clear()
    A._steady_since.update({n: _t.time() - 200 for n in configured})
    A.learn_session_cap(SCFG, {n: {"ready": False} for n in configured}, configured)
    assert demoted == [] and "corp8" not in A._effective_cap
    with SessionLocal() as s:
        s.delete(s.get(Camera, "cam03")); s.commit()
