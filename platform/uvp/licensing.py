"""Licensing: an Ed25519-signed licence file sets the customer, tenant, camera / ANPR / analytics channel
limits, enabled features and expiry. Without a valid file the platform runs in evaluation mode (8 cameras,
2 ANPR channels, 2 analytics channels, all features) so a pilot never stops working; after expiry there is a
14-day grace period with a banner, then the limits fall back to evaluation mode.

Usage is counted from the registry (cameras, ANPR-enabled, analytics-configured) and can be reported daily to
the vendor (LICENSE_REPORT_URL, signed with the platform's own key).

Vendor side: scripts/issue_license.py creates the file with the vendor's private key; the matching public key
is embedded below (replace with your own when you take the product to market).
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import logging
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from .config import ROOT, settings

log = logging.getLogger("uvp.license")

# Vendor licence-signing public key (Ed25519, PEM). scripts/issue_license.py generates a pair on first use and
# prints the public key to paste here; the pilot key below matches deploy/licensing/vendor_public.pem.
VENDOR_PUBLIC_KEY_FILE = ROOT / "deploy" / "licensing" / "vendor_public.pem"

EVALUATION = {"customer": "Evaluation", "tenant": "", "cameras": 8, "anpr_channels": 2, "analytics_channels": 2,
              "features": ["*"], "expires": None, "issued": None, "mode": "evaluation"}
GRACE_DAYS = 14


def _public_key():
    pem = VENDOR_PUBLIC_KEY_FILE.read_bytes() if VENDOR_PUBLIC_KEY_FILE.exists() else None
    return serialization.load_pem_public_key(pem) if pem else None


def canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def load() -> dict:
    """Validated licence with `mode`: licensed | grace | expired | invalid | evaluation, plus `status` text."""
    p = Path(settings.license_file)
    if not p.exists():
        return {**EVALUATION, "status": "no licence file: evaluation limits apply"}
    try:
        doc = json.loads(p.read_text())
        payload, sig = doc["license"], base64.b64decode(doc["signature"])
        pub = _public_key()
        if pub is None:
            return {**EVALUATION, "mode": "invalid", "status": "vendor public key missing (deploy/licensing/vendor_public.pem)"}
        pub.verify(sig, canonical(payload))
    except Exception as e:  # noqa: BLE001
        return {**EVALUATION, "mode": "invalid", "status": f"licence invalid: {type(e).__name__}"}
    lic = {**EVALUATION, **payload, "mode": "licensed", "status": "licensed"}
    if lic.get("expires"):
        exp = dt.date.fromisoformat(lic["expires"])
        today = dt.date.today()
        if today > exp + dt.timedelta(days=GRACE_DAYS):
            return {**EVALUATION, "customer": lic["customer"], "mode": "expired",
                    "status": f"licence expired on {exp} (grace period over): evaluation limits apply"}
        if today > exp:
            lic["mode"], lic["status"] = "grace", f"licence expired on {exp}: {(exp + dt.timedelta(days=GRACE_DAYS) - today).days} days of grace left"
    return lic


def feature_allowed(lic: dict, feature: str) -> bool:
    f = lic.get("features") or []
    return "*" in f or feature in f


def usage() -> dict:
    from sqlalchemy import select
    from .config import load_yaml
    from .db import Camera, SessionLocal
    with SessionLocal() as s:
        allc = s.scalars(select(Camera)).all()
        registry_only = sum(1 for c in allc if c.registry_only)
        cams = [c for c in allc if not c.registry_only]        # inventory-only entries are not licensed seats
    zones = (load_yaml(settings.analytics_file) or {}).get("cameras") or {}
    keys = ("intrusion", "abandoned_object", "crowd", "no_parking", "red_light")
    return {"cameras": sum(1 for c in cams if c.status != "unlicensed"), "cameras_total": len(cams), "registry_only": registry_only,
            "anpr_channels": sum(1 for c in cams if c.anpr_enabled and c.status != "unlicensed"),
            "analytics_channels": sum(1 for cid, cfg in zones.items() if any(k in (cfg or {}) for k in keys))}


def allowed_cameras(lic: dict, camera_ids: list[str]) -> set[str]:
    """Deterministic subset within the camera limit (sorted ids), so every service agrees which are licensed."""
    limit = int(lic.get("cameras") or 0)
    if limit <= 0:
        return set(camera_ids)
    return set(sorted(camera_ids)[:limit])


def allowed_anpr(lic: dict, camera_ids: list[str]) -> set[str]:
    limit = int(lic.get("anpr_channels") or 0)
    if limit <= 0:
        return set(camera_ids)
    return set(sorted(camera_ids)[:limit])


def report_usage() -> dict | None:
    """Daily usage report to the vendor (LICENSE_REPORT_URL); signed with the platform's Ed25519 key."""
    if not settings.license_report_url:
        return None
    import requests
    from . import signing
    lic = load()
    body = {"customer": lic.get("customer"), "tenant": lic.get("tenant"), "mode": lic["mode"], "usage": usage(),
            "limits": {k: lic.get(k) for k in ("cameras", "anpr_channels", "analytics_channels")},
            "version": settings.version, "at": dt.datetime.now(dt.timezone.utc).isoformat()}
    body["signature"] = signing.sign_manifest(body)
    body["public_key"] = signing.public_key_pem()
    try:
        r = requests.post(settings.license_report_url, json=body, timeout=15)
        log.info("usage report sent: HTTP %s", r.status_code)
    except requests.RequestException as e:
        log.warning("usage report failed: %s", e)
    return body
