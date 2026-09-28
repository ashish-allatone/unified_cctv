"""Ed25519 signing of exports so a recipient (court, another department) can verify that a
CSV, evidence bundle or clip came from this platform and was not altered.

Key: SIGNING_KEY_FILE (PEM, generated on first use; back it up, it is the platform's identity).
Every export gets a manifest.json {files: {name: sha256}, exported_by, exported_at, ...} and a
manifest.sig (base64 Ed25519 signature over the canonical manifest JSON). /api/verify checks both.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from .config import settings

_key: ed25519.Ed25519PrivateKey | None = None


def private_key() -> ed25519.Ed25519PrivateKey:
    global _key
    if _key is None:
        p = Path(settings.signing_key_file)
        if p.exists():
            _key = serialization.load_pem_private_key(p.read_bytes(), password=None)
        else:
            _key = ed25519.Ed25519PrivateKey.generate()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                             serialization.NoEncryption()))
            try:
                p.chmod(0o600)
            except OSError:
                pass
    return _key


def public_key_pem() -> str:
    return private_key().public_key().public_bytes(serialization.Encoding.PEM,
                                                   serialization.PublicFormat.SubjectPublicKeyInfo).decode()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical(manifest: dict) -> bytes:
    return json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()


def sign_manifest(manifest: dict) -> str:
    return base64.b64encode(private_key().sign(canonical(manifest))).decode()


def verify_manifest(manifest: dict, signature_b64: str, public_pem: str | None = None) -> bool:
    pub = (serialization.load_pem_public_key(public_pem.encode()) if public_pem else private_key().public_key())
    try:
        pub.verify(base64.b64decode(signature_b64), canonical(manifest))
        return True
    except Exception:  # noqa: BLE001
        return False


def build_manifest(files: dict[str, Path], exported_by: str, kind: str, extra: dict | None = None) -> dict:
    return {"kind": kind, "exported_by": exported_by, "exported_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "platform": "Unified CCTV Viewing Platform", "files": {n: sha256_file(p) for n, p in files.items()},
            **(extra or {})}
