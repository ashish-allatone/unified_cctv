"""Devices connected from the console (Sources -> Connect a device).

A device is a `sources` row with `managed=True`: the adapter config (vendor preset / RTSP template / plain RTSP
URLs, host, port, channels, options) in `config`, the read-only credentials encrypted with TOKEN_SECRET in
`secret_enc`. The adapter service merges these with sources.yaml on every sync (`adapter_service.all_sources`)
and re-syncs within seconds of a change (`db_sources_version`). Nothing here writes to sources.yaml or .env.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import re
import shutil
import subprocess

from sqlalchemy import func, select

from ..adapters.base import redact  # noqa: F401  (re-exported for the router)
from ..adapters.registry import presets
from ..config import settings
from ..db import REGISTRY_SOURCE, SessionLocal, Source, utcnow

DEVICE_TYPES = {
    "camera":   {"label": "Single IP camera (RTSP)", "adapter": "rtsp",
                 "help": "One camera or encoder with its own RTSP URL(s). Paste the main (and optional sub) stream URL without the user:pass part."},
    "nvr":      {"label": "NVR / DVR by vendor", "adapter": "rtsp_template",
                 "help": "Hikvision, Dahua / CP Plus, Uniview, Axis…: give the recorder's host, RTSP port and the channels; the vendor preset supplies the stream paths."},
    "template": {"label": "Custom RTSP template", "adapter": "rtsp_template",
                 "help": "Any recorder or gateway whose URLs follow a pattern per channel, e.g. rtsp://{host}:{rtsp_port}/stream/cam{channel:02d} (Corp8)."},
    "onvif":    {"label": "ONVIF Profile S device", "adapter": "onvif",
                 "help": "Discovers channels and stream URLs through ONVIF (port 80 by default)."},
}


def _fernet():
    from cryptography.fernet import Fernet
    key = base64.urlsafe_b64encode(hashlib.sha256(("devices:" + settings.token_secret).encode()).digest())
    return Fernet(key)


def encrypt_secret(username: str, password: str) -> str:
    return _fernet().encrypt(json.dumps({"u": username, "p": password}).encode()).decode()


def decrypt_secret(blob: str) -> tuple[str, str]:
    if not blob:
        return "", ""
    try:
        d = json.loads(_fernet().decrypt(blob.encode()).decode())
        return d.get("u", ""), d.get("p", "")
    except Exception:  # noqa: BLE001
        return "", ""


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:40] or "device"


def build_config(d: dict) -> dict:
    """Turn the console form into an adapter config (no secrets). Raises ValueError on bad input."""
    kind = d.get("type") or "nvr"
    if kind not in DEVICE_TYPES:
        raise ValueError(f"type must be one of {', '.join(DEVICE_TYPES)}")
    name, dept = (d.get("name") or "").strip(), (d.get("department") or "").strip()
    if not name or not dept:
        raise ValueError("name and department are required")
    cfg: dict = {"adapter": DEVICE_TYPES[kind]["adapter"], "department": dept, "name": name,
                 "max_concurrent_pulls": int(d.get("max_concurrent_pulls") or 16),
                 "record": d.get("record") or settings.record_mode}
    if d.get("persistent_pull") is not None:
        cfg["persistent_pull"] = bool(d["persistent_pull"])
    host = (d.get("host") or "").strip()
    if kind == "camera":
        main = (d.get("main_url") or "").strip()
        if not main.startswith("rtsp://"):
            raise ValueError("main stream URL must start with rtsp://")
        if "@" in main.split("/", 3)[2]:
            raise ValueError("leave the user:password out of the URL - put them in the credential fields")
        stream = {"id": d.get("camera_id") or slug(name), "name": name, "main": main}
        if (d.get("sub_url") or "").strip():
            stream["sub"] = d["sub_url"].strip()
        for k in ("lat", "lon", "heading", "fov", "range_m"):
            if d.get(k) not in (None, ""):
                stream[k] = float(d[k])
        if d.get("anpr"):
            stream["anpr"] = True
        cfg["streams"] = [stream]
        cfg["max_concurrent_pulls"] = max(1, int(d.get("max_concurrent_pulls") or 2))
        return cfg
    if not host:
        raise ValueError("host (IP or DNS name) is required")
    cfg["host"] = host
    if kind == "nvr":
        vendor = (d.get("vendor") or "").strip().lower()
        p = presets().get(vendor)
        if not p or p.get("adapter") not in ("rtsp_template", "onvif"):
            raise ValueError(f"vendor must be one of {', '.join(k for k, v in presets().items() if v.get('adapter') in ('rtsp_template', 'onvif'))}")
        cfg["vendor"] = vendor
        if p.get("adapter") == "onvif":
            cfg["adapter"] = "onvif"
            cfg["onvif_port"] = int(d.get("onvif_port") or p.get("onvif_port") or 80)
            return cfg
    elif kind == "template":
        main = (d.get("main_template") or "").strip()
        if "{host}" not in main or "{channel" not in main:
            raise ValueError("the main template must contain {host} and {channel} (e.g. rtsp://{host}:{rtsp_port}/stream/cam{channel:02d})")
        cfg["main"] = main
        if (d.get("sub_template") or "").strip():
            cfg["sub"] = d["sub_template"].strip()
    elif kind == "onvif":
        cfg["onvif_port"] = int(d.get("onvif_port") or 80)
        return cfg
    cfg["rtsp_port"] = int(d.get("rtsp_port") or 554)
    chans = d.get("channels")
    if isinstance(chans, list) and chans:
        out = []
        for i, c in enumerate(chans):
            if isinstance(c, dict):
                row = {"channel": int(c.get("channel") or i + 1)}
                for k in ("id", "name", "lat", "lon", "heading", "fov", "range_m", "anpr"):
                    if c.get(k) not in (None, ""):
                        row[k] = c[k]
                out.append(row)
            else:
                out.append({"channel": int(c)})
        cfg["channels"] = out
    else:
        n = int(chans or 1)
        if not 1 <= n <= 512:
            raise ValueError("channels must be 1-512")
        cfg["channels"] = [{"channel": i + 1, "id": f"{d.get('id_prefix') or slug(name)}-ch{i + 1}"} for i in range(n)]
    if d.get("anpr"):
        for c in cfg["channels"]:
            c["anpr"] = True
    cfg["max_concurrent_pulls"] = max(1, int(d.get("max_concurrent_pulls") or len(cfg["channels"])))
    if "persistent_pull" not in cfg and kind == "template" and "sub" not in cfg:
        cfg["persistent_pull"] = True
    return cfg


def probe_url(cfg: dict, username: str, password: str, channel: int = 1) -> str:
    """The first stream URL the config would produce, with credentials, for a connection test."""
    from ..adapters.base import with_credentials
    from ..adapters.registry import resolve
    c = resolve(dict(cfg, id=cfg.get("id", "probe")))
    if c["adapter"] == "rtsp":
        return with_credentials(c["streams"][0]["main"], username, password)
    if c["adapter"] == "rtsp_template":
        url = c["main"].format(host=c["host"], rtsp_port=c.get("rtsp_port", 554), channel=channel)
        return with_credentials(url, username, password)
    return ""


def test_stream(url: str) -> dict:
    """ffprobe one URL: {ok, codec, error}. '401' means the device rejected the credentials."""
    if not url:
        return {"ok": False, "codec": "", "error": "nothing to probe for this device type (ONVIF is checked on save)"}
    if not shutil.which("ffprobe"):
        return {"ok": False, "codec": "", "error": "ffprobe not installed in this container"}
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-show_entries", "stream=codec_name,width,height",
                            "-of", "csv=p=0", url], capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        return {"ok": False, "codec": "", "error": "timeout: no answer in 20 s (firewall, wrong host / port, or RTSP disabled on the device)"}
    if p.returncode == 0 and p.stdout.strip():
        first = p.stdout.strip().splitlines()[0].split(",")
        codec = first[0]
        size = f"{first[1]}x{first[2]}" if len(first) >= 3 and first[1] else ""
        note = " (HEVC: the wall will transcode to H.264 for browsers)" if codec in ("hevc", "h265") else ""
        return {"ok": True, "codec": codec, "size": size, "error": "", "note": note.strip()}
    err = p.stderr.strip()
    if "401" in err or "Unauthorized" in err:
        return {"ok": False, "codec": "", "error": "401 Unauthorized: the device rejected the username / password"}
    if "404" in err:
        return {"ok": False, "codec": "", "error": "404: stream path not found - wrong vendor preset / template or channel"}
    return {"ok": False, "codec": "", "error": redact(err)[:200] or "could not open the stream"}


# ----------------------------------------------------------------------------- storage
def db_sources() -> list[dict]:
    """Adapter configs for every console-managed device, credentials decrypted (in memory only)."""
    with SessionLocal() as s:
        rows = s.scalars(select(Source).where(Source.managed.is_(True))).all()
        out = []
        for r in rows:
            cfg = dict(r.config or {})
            u, p = decrypt_secret(r.secret_enc)
            cfg.update({"id": r.id, "department": r.department, "name": r.name, "username": u, "password": p})
            out.append(cfg)
        return out


def db_sources_version() -> float:
    """Changes whenever a managed device is added, edited or removed."""
    with SessionLocal() as s:
        n = s.scalar(select(func.count()).select_from(Source).where(Source.managed.is_(True))) or 0
        last = s.scalar(select(func.max(Source.updated_at)).where(Source.managed.is_(True)))
    return float(n) * 1e9 + (last.timestamp() if last else 0.0)


def public_row(r: Source) -> dict:
    u, _ = decrypt_secret(r.secret_enc)
    cfg = dict(r.config or {})
    return {"id": r.id, "name": r.name, "department": r.department, "adapter": r.adapter, "status": r.status,
            "status_detail": r.status_detail, "checked_at": r.checked_at.isoformat() if r.checked_at else None,
            "max_concurrent_pulls": r.max_concurrent_pulls, "config": cfg, "username": u, "created_by": r.created_by,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None, "managed": bool(r.managed),
            "channels": len(cfg.get("channels") or cfg.get("streams") or [])}


def save_device(d: dict, user: str, device_id: str | None = None) -> Source:
    cfg = build_config(d)
    with SessionLocal() as s:
        if device_id:
            r = s.get(Source, device_id)
            if r is None or not r.managed:
                raise KeyError(device_id)
            username, password = d.get("username"), d.get("password")
            if not password:                       # keep the stored credentials when the form left them blank
                u0, p0 = decrypt_secret(r.secret_enc)
                username, password = username or u0, p0
        else:
            sid = (d.get("id") or slug(d["name"])).strip()
            if sid == REGISTRY_SOURCE or s.get(Source, sid) is not None:
                raise ValueError(f"a source with id '{sid}' already exists")
            r = Source(id=sid, status="unknown", status_detail="connecting…", created_by=user, managed=True)
            s.add(r)
            username, password = d.get("username") or "", d.get("password") or ""
        r.department, r.name, r.adapter = cfg["department"], cfg["name"], cfg["adapter"]
        r.max_concurrent_pulls = cfg["max_concurrent_pulls"]
        r.config = cfg
        r.secret_enc = encrypt_secret(username or "", password or "")
        r.updated_at = utcnow()
        r.status, r.status_detail = "unknown", "connecting… (the adapters pick this up within a few seconds)"
        s.commit()
        s.refresh(r)
        s.expunge(r)
        return r
