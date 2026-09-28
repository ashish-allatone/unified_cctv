"""Object storage for video: event clips, plate crops and recorded segments.

Two backends, selected by OBJECT_STORAGE:
  s3     any S3-compatible service. Tested against Oracle Cloud Object Storage's
         Amazon S3 Compatibility API (path-style addressing, customer secret keys),
         also works with AWS S3, MinIO, Ceph, Wasabi.
  local  files under DATA_DIR/archive (default; single-host pilot without a bucket)

Keys are laid out so that per-department retention is one prefix delete:
  recordings/<department>/<camera>/<profile>/<YYYY-MM-DD>/<start>.mp4
  clips/<department>/<camera>/<YYYY-MM-DD>/<event>.mp4
  crops/<department>/<camera>/<YYYY-MM-DD>/<event>_plate.jpg
"""
from __future__ import annotations

import datetime as dt
import logging
import mimetypes
import shutil
from pathlib import Path
from typing import Iterator

from .config import settings

log = logging.getLogger("uvp.storage")


class LocalStore:
    name = "local"

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _p(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root.resolve() not in p.parents:
            raise ValueError("bad key")
        return p

    def put_file(self, local: Path, key: str, content_type: str | None = None) -> int:
        dst = self._p(key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(local, dst)
        return dst.stat().st_size

    def put_bytes(self, data: bytes, key: str, content_type: str | None = None) -> int:
        dst = self._p(key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
        return len(data)

    def exists(self, key: str) -> bool:
        return self._p(key).exists()

    def url(self, key: str, ttl_s: int = 900) -> str:
        # served by the API from /archive/<key> (authenticated); no presigning needed
        return f"/archive/{key}"

    def local_path(self, key: str) -> Path | None:
        p = self._p(key)
        return p if p.exists() else None

    def list(self, prefix: str) -> Iterator[tuple[str, int, dt.datetime]]:
        base = self._p(prefix) if prefix else self.root
        if not base.exists():
            return
        for p in sorted(base.rglob("*")):
            if p.is_file():
                st = p.stat()
                yield (str(p.relative_to(self.root)).replace("\\", "/"), st.st_size,
                       dt.datetime.fromtimestamp(st.st_mtime, dt.timezone.utc))

    def delete(self, key: str) -> None:
        p = self._p(key)
        if p.exists():
            p.unlink()


def _s3_config():
    """boto3 >= 1.36 sends uploads as aws-chunked with CRC32 checksums by default; Oracle Object Storage,
    MinIO and other S3-compatible stores answer 'NotImplemented: AWS chunked encoding not supported'.
    Only compute checksums when an operation requires them (the older behaviour)."""
    from botocore.config import Config
    kw = dict(s3={"addressing_style": "path" if settings.s3_path_style else "auto"},
              signature_version="s3v4", retries={"max_attempts": 4, "mode": "standard"})
    try:
        return Config(request_checksum_calculation="when_required", response_checksum_validation="when_required", **kw)
    except TypeError:                      # botocore older than 1.36: the defaults are already the compatible ones
        return Config(**kw)


class S3Store:
    name = "s3"

    def __init__(self):
        import boto3
        from botocore.config import Config

        self.bucket = settings.s3_bucket
        self.prefix = settings.s3_prefix.strip("/")
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint or None,
            region_name=settings.s3_region or None,
            aws_access_key_id=settings.s3_access_key or None,
            aws_secret_access_key=settings.s3_secret_key or None,
            config=_s3_config(),
        )

    def _k(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    def _extra(self, ct: str) -> dict:
        extra = {"ContentType": ct}
        if settings.s3_sse:                       # server-side encryption at rest (AES256 or aws:kms)
            extra["ServerSideEncryption"] = settings.s3_sse
        return extra

    def put_file(self, local: Path, key: str, content_type: str | None = None) -> int:
        ct = content_type or mimetypes.guess_type(str(local))[0] or "application/octet-stream"
        self.client.upload_file(str(local), self.bucket, self._k(key), ExtraArgs=self._extra(ct))
        return local.stat().st_size

    def put_bytes(self, data: bytes, key: str, content_type: str | None = None) -> int:
        ct = content_type or mimetypes.guess_type(key)[0] or "application/octet-stream"
        self.client.put_object(Bucket=self.bucket, Key=self._k(key), Body=data, **self._extra(ct))
        return len(data)

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._k(key))
            return True
        except self.client.exceptions.ClientError:
            return False

    def url(self, key: str, ttl_s: int = 900) -> str:
        """Time-limited link the browser can play directly from the bucket."""
        return self.client.generate_presigned_url("get_object", Params={"Bucket": self.bucket, "Key": self._k(key)},
                                                  ExpiresIn=ttl_s)

    def local_path(self, key: str) -> Path | None:
        return None

    def list(self, prefix: str) -> Iterator[tuple[str, int, dt.datetime]]:
        pag = self.client.get_paginator("list_objects_v2")
        for page in pag.paginate(Bucket=self.bucket, Prefix=self._k(prefix)):
            for o in page.get("Contents", []):
                k = o["Key"][len(self.prefix) + 1:] if self.prefix else o["Key"]
                yield k, o["Size"], o["LastModified"]

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=self._k(key))

    def delete_many(self, keys: list[str]) -> None:
        for i in range(0, len(keys), 1000):
            chunk = [{"Key": self._k(k)} for k in keys[i:i + 1000]]
            self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": chunk, "Quiet": True})


_store = None


def store():
    global _store
    if _store is None:
        if settings.object_storage == "s3":
            _store = S3Store()
        else:
            _store = LocalStore(settings.data_dir / "archive")
        log.info("object storage: %s", describe())
    return _store


def describe() -> str:
    if settings.object_storage == "s3":
        return f"s3 bucket={settings.s3_bucket} endpoint={settings.s3_endpoint or 'aws'} prefix={settings.s3_prefix or '-'}"
    return f"local {settings.data_dir / 'archive'}"


def delete_prefix(prefix: str, older_than: dt.datetime) -> int:
    """Remove every object under `prefix` last modified before `older_than`. Returns count."""
    s = store()
    victims = [k for k, _, ts in s.list(prefix) if ts < older_than]
    if hasattr(s, "delete_many"):
        s.delete_many(victims)
    else:
        for k in victims:
            s.delete(k)
    return len(victims)
