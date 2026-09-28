#!/usr/bin/env python3
"""Check the object-storage settings in .env (Oracle Object Storage / S3 / MinIO): connect, list the bucket,
write a test object, read it back, delete it, and report what the archiver would write.

  python scripts/check_storage.py
  docker compose run --rm archiver python scripts/check_storage.py
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
env_file = ROOT / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

OK, BAD = "\033[32mOK\033[0m ", "\033[31mFAIL\033[0m"


def main() -> int:
    from uvp.config import settings
    print(f"\nOBJECT_STORAGE={settings.object_storage}")
    if settings.object_storage not in ("local", "s3"):
        print(f"  [{BAD}] '{settings.object_storage}' is not a valid value. Use OBJECT_STORAGE=local (archive on the data volume) or OBJECT_STORAGE=s3 (Oracle Object Storage / S3 / MinIO via the S3_* settings).")
        return 1
    if settings.object_storage != "s3":
        print(f"  [{OK}] local mode: archive goes to {settings.data_dir}/archive. Set OBJECT_STORAGE=s3 plus S3_* in .env for Oracle.")
        return 0
    for k in ("s3_endpoint", "s3_region", "s3_bucket", "s3_access_key", "s3_secret_key"):
        v = getattr(settings, k, "")
        shown = (v[:4] + "…" + v[-2:]) if k.endswith("key") and v else v
        print(f"  {'[' + OK + ']' if v else '[' + BAD + ']'} {k.upper()} = {shown or '(missing)'}")
        if not v:
            print("        set it in .env (Oracle: Identity -> Users -> your user -> Customer Secret Keys)")
            return 1
    if ".compat.objectstorage." not in settings.s3_endpoint and "oraclecloud" in settings.s3_endpoint:
        print(f"  [{BAD}] Oracle endpoint must be the S3-compatibility one: https://<namespace>.compat.objectstorage.<region>.oraclecloud.com")
        return 1
    if "oraclecloud" in settings.s3_endpoint and not settings.s3_path_style:
        print(f"  [{BAD}] Oracle needs S3_PATH_STYLE=1")
        return 1
    import botocore
    from uvp.storage import store
    st = store()
    key = f"{settings.s3_prefix + '/' if settings.s3_prefix else ''}_healthcheck/{int(time.time())}.txt"
    try:
        st.client.head_bucket(Bucket=settings.s3_bucket)
        print(f"  [{OK}] bucket '{settings.s3_bucket}' reachable at {settings.s3_endpoint}")
    except botocore.exceptions.ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        hint = {"404": "bucket does not exist in this compartment/namespace", "NoSuchBucket": "bucket does not exist",
                "403": "access key not allowed on this bucket (IAM policy / wrong compartment)", "InvalidAccessKeyId": "wrong S3_ACCESS_KEY",
                "SignatureDoesNotMatch": "wrong S3_SECRET_KEY or wrong S3_REGION"}.get(code, "")
        print(f"  [{BAD}] cannot access bucket: {code} {hint}")
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"  [{BAD}] cannot reach {settings.s3_endpoint}: {str(e)[:200]}")
        return 1
    try:
        st.client.put_object(Bucket=settings.s3_bucket, Key=key, Body=b"uvp storage check", ContentType="text/plain",
                             **({"ServerSideEncryption": settings.s3_sse} if getattr(settings, "s3_sse", "") else {}))
        body = st.client.get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read()
        assert body == b"uvp storage check"
        st.client.delete_object(Bucket=settings.s3_bucket, Key=key)
        print(f"  [{OK}] write / read / delete of a test object works (key {key})")
    except Exception as e:  # noqa: BLE001
        print(f"  [{BAD}] write/read test failed: {str(e)[:300]}")
        return 1
    n = 0
    try:
        resp = st.client.list_objects_v2(Bucket=settings.s3_bucket, Prefix=(settings.s3_prefix + "/") if settings.s3_prefix else "", MaxKeys=1000)
        n = resp.get("KeyCount", 0)
    except Exception:  # noqa: BLE001
        pass
    print(f"  [{OK}] bucket currently holds {n} object(s) under prefix '{settings.s3_prefix or ''}'")
    print(f"\nThe archiver will write:  {settings.s3_prefix + '/' if settings.s3_prefix else ''}recordings/<dept>/<camera>/main/<date>/<time>.mp4,  clips/…,  crops/…")
    print(f"Record mode {settings.record_mode}: {'ANPR cameras' if settings.record_mode == 'anpr' else settings.record_mode} are recorded; local buffer {settings.record_local_keep}.")
    print("Restart to apply: docker compose up -d archiver api")
    return 0


if __name__ == "__main__":
    sys.exit(main())
