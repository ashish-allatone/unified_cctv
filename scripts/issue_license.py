#!/usr/bin/env python3
"""Vendor tool: issue a signed licence file.

  python scripts/issue_license.py --customer "City A Smart City SPV" --tenant city-a --cameras 500 \
      --anpr 120 --analytics 40 --expires 2027-03-31 --out config/license.json

The vendor private key lives in deploy/licensing/vendor_private.pem (created on first run; keep it out of
customer deployments - only vendor_public.pem ships with the product).
"""
import argparse
import base64
import datetime as dt
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

ROOT = Path(__file__).resolve().parents[1]
PRIV = ROOT / "deploy" / "licensing" / "vendor_private.pem"
PUB = ROOT / "deploy" / "licensing" / "vendor_public.pem"


def keys():
    if not PRIV.exists():
        k = ed25519.Ed25519PrivateKey.generate()
        PRIV.parent.mkdir(parents=True, exist_ok=True)
        PRIV.write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        PUB.write_bytes(k.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
        print(f"generated vendor key pair in {PRIV.parent}", file=sys.stderr)
    return serialization.load_pem_private_key(PRIV.read_bytes(), password=None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--customer", required=True)
    ap.add_argument("--tenant", default="")
    ap.add_argument("--cameras", type=int, default=100)
    ap.add_argument("--anpr", type=int, default=20)
    ap.add_argument("--analytics", type=int, default=10)
    ap.add_argument("--features", default="*", help="comma list or * (e.g. live,search,playback,cases,analytics)")
    ap.add_argument("--expires", default=(dt.date.today() + dt.timedelta(days=365)).isoformat())
    ap.add_argument("--out", default=str(ROOT / "config" / "license.json"))
    a = ap.parse_args()
    payload = {"customer": a.customer, "tenant": a.tenant, "cameras": a.cameras, "anpr_channels": a.anpr,
               "analytics_channels": a.analytics, "features": ["*"] if a.features == "*" else [f.strip() for f in a.features.split(",")],
               "expires": a.expires, "issued": dt.date.today().isoformat()}
    sig = keys().sign(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    Path(a.out).write_text(json.dumps({"license": payload, "signature": base64.b64encode(sig).decode()}, indent=1))
    print(f"licence for {a.customer} written to {a.out} (expires {a.expires})")


if __name__ == "__main__":
    main()
