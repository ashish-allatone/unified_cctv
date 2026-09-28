"""Object-storage backends and archive retention (S3 is mocked with moto; no network)."""
import datetime as dt
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "platform"))
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")


def _reset(monkeypatch, **env):
    from uvp import storage
    from uvp.config import settings
    for k, v in env.items():
        monkeypatch.setattr(settings, k, v)
    storage._store = None
    monkeypatch.setattr(storage, "_store", None)   # restored (to None) after the test, so no backend leaks
    return storage


def test_local_backend_roundtrip(tmp_path, monkeypatch):
    storage = _reset(monkeypatch, object_storage="local", data_dir=tmp_path)
    st = storage.store()
    st.put_bytes(b"abc", "clips/Police/cam1/2026-09-22/e1.mp4", "video/mp4")
    assert st.exists("clips/Police/cam1/2026-09-22/e1.mp4")
    assert st.url("clips/Police/cam1/2026-09-22/e1.mp4").startswith("/archive/")
    assert [k for k, _, _ in st.list("clips/Police/")] == ["clips/Police/cam1/2026-09-22/e1.mp4"]
    with pytest.raises(ValueError):
        st.put_bytes(b"x", "../escape.txt")


def test_s3_backend_oracle_style(monkeypatch):
    moto = pytest.importorskip("moto")
    with moto.mock_aws():
        import boto3
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="uvp-video")
        storage = _reset(monkeypatch, object_storage="s3", s3_bucket="uvp-video", s3_region="us-east-1",
                         s3_endpoint="", s3_access_key="k", s3_secret_key="s", s3_prefix="pilot", s3_path_style=True)
        st = storage.store()
        assert st.name == "s3"
        st.put_bytes(b"video", "clips/Police/cam1/2026-09-22/e1.mp4", "video/mp4")
        assert st.exists("clips/Police/cam1/2026-09-22/e1.mp4")
        url = st.url("clips/Police/cam1/2026-09-22/e1.mp4", 60)
        assert "uvp-video" in url and "pilot/clips/Police" in url and "X-Amz-Signature" in url
        assert [k for k, _, _ in st.list("clips/")] == ["clips/Police/cam1/2026-09-22/e1.mp4"]
        # retention: nothing older than "now - 1 day" yet; everything older than "now + 1 day"
        assert storage.delete_prefix("clips/Police/", dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)) == 0
        assert storage.delete_prefix("clips/Police/", dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)) == 1
        assert not st.exists("clips/Police/cam1/2026-09-22/e1.mp4")


def test_segment_name_parsing():
    from uvp.services.archiver import _segment_start
    t = _segment_start("2026-09-22_06-49-30-669676.mp4")
    assert t == dt.datetime(2026, 9, 22, 6, 49, 30, 669676, tzinfo=dt.timezone.utc)
    assert _segment_start("junk.mp4") is None


def test_retention_policy_merges_defaults(tmp_path, monkeypatch):
    from uvp.config import settings
    from uvp.services.archiver import retention_policy
    f = tmp_path / "rules.yaml"
    f.write_text("retention:\n  default: {recordings_days: 10}\n  Police: {clips_days: 5}\n")
    monkeypatch.setattr(settings, "rules_file", f)
    pol = retention_policy()
    assert pol["default"] == {"recordings_days": 10, "clips_days": 90, "crops_days": 90, "events_days": 90, "audit_days": 180}
    assert pol["Police"]["clips_days"] == 5 and pol["Police"]["recordings_days"] == 10
    f.write_text("retention:\n  default: {audit_days: 30}\n")
    assert retention_policy()["default"]["audit_days"] == 180     # CERT-In floor
