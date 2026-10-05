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
    "push":     {"label": "Remote site (site connector pushes the streams)", "adapter": "push",
                 "help": "For a DVR / NVR behind a client's router with no port forwarding: a small connector box on the site's LAN reads the recorder and pushes the streams to this server over one outbound connection. Save, then download the connector bundle and run it at the site."},
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
    if kind == "push":
        n = int(d.get("channels") or 1)
        if not 1 <= n <= 512:
            raise ValueError("channels must be 1-512")
        prefix = d.get("id_prefix") or slug(name)
        cfg["cameras"] = {f"{prefix}-ch{i + 1}": {"name": f"{name} ch{i + 1}", **({"anpr": True} if d.get("anpr") else {})} for i in range(n)}
        cfg["site"] = {"vendor": (d.get("vendor") or "cpplus").strip().lower(), "host": host, "rtsp_port": int(d.get("rtsp_port") or 554),
                       "main_template": (d.get("main_template") or "").strip()}       # remembered for the connector bundle
        cfg["max_concurrent_pulls"] = n
        return cfg
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
            if cfg.get("adapter") == "push":
                cfg["publish_key"] = cfg.pop("password", "")   # the site connector's key lives in the encrypted secret
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
            "channels": len(cfg.get("channels") or cfg.get("streams") or cfg.get("cameras") or [])}


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
            if cfg["adapter"] == "push":
                import secrets as _secrets
                username, password = "site", _secrets.token_urlsafe(24)      # the connector's publish key
        r.department, r.name, r.adapter = cfg["department"], cfg["name"], cfg["adapter"]
        r.max_concurrent_pulls = cfg["max_concurrent_pulls"]
        r.config = cfg
        r.secret_enc = encrypt_secret(username or "", password or "")
        r.updated_at = utcnow()
        r.status, r.status_detail = "unknown", ("waiting for the site connector to push its streams" if cfg["adapter"] == "push"
                                                else "connecting… (the adapters pick this up within a few seconds)")
        s.commit()
        s.refresh(r)
        s.expunge(r)
        return r


# ----------------------------------------------------------------------------- site connector bundle
def site_connector_bundle(r: Source, public_host: str) -> dict[str, str]:
    """Files for the box at the client's site: docker-compose.yml + cameras.txt + README. The box reads the
    recorder over its LAN and pushes every channel to this server's relay (RTSP 8554, outbound only)."""
    from ..adapters.registry import presets
    cfg = dict(r.config or {})
    _u, key = decrypt_secret(r.secret_enc)
    site = cfg.get("site") or {}
    vendor = site.get("vendor") or "cpplus"
    tpl = site.get("main_template") or (presets().get(vendor) or {}).get("main") or "rtsp://{host}:{rtsp_port}/cam/realmonitor?channel={channel}&subtype=0"
    host, port = site.get("host") or "DVR-LAN-IP", site.get("rtsp_port") or 554
    lines = []
    for i, cid in enumerate(cfg.get("cameras") or {}):
        src = tpl.format(host="${DVR_HOST}", rtsp_port=port, channel=i + 1)
        lines.append(f"{cid}/main|{src}")
    cameras_txt = "# <relay path>|<recorder stream URL>   (user:pass are added from DVR_USER / DVR_PASS in .env)\n" + "\n".join(lines) + "\n"
    env = (f"RELAY_HOST={public_host}\nRELAY_PORT=8554\nSITE_KEY={key}\nDVR_HOST={host}\nDVR_USER=uvp\nDVR_PASS=CHANGE-ME\n")
    compose = """# Unified CCTV site connector: reads the recorder on this LAN and pushes each channel to the command centre.
# Needs: Docker on any small PC / mini-PC / Raspberry Pi 4 at the site; outbound TCP 8554 to the server. No inbound ports.
services:
  connector:
    image: bluenviron/mediamtx:1.15.1-ffmpeg
    entrypoint: ["/bin/sh", "/connector/run.sh"]
    env_file: .env
    volumes: [".:/connector:ro"]
    restart: unless-stopped
"""
    run_sh = r"""#!/bin/sh
# one ffmpeg per camera, copying the stream (no re-encode) to the relay; restarts on any failure
cd /connector
push() {
  path="$1"; src="$2"
  auth_src=$(echo "$src" | sed "s#rtsp://#rtsp://${DVR_USER}:${DVR_PASS}@#")
  while true; do
    echo "$(date '+%H:%M:%S') $path: pushing"
    ffmpeg -nostdin -loglevel warning -rtsp_transport tcp -i "$auth_src" -c copy -an -f rtsp -rtsp_transport tcp       "rtsp://site:${SITE_KEY}@${RELAY_HOST}:${RELAY_PORT}/$path"
    echo "$(date '+%H:%M:%S') $path: ended, retry in 5 s"; sleep 5
  done
}
grep -v '^#' cameras.txt | grep '|' | while IFS='|' read -r path src; do
  src=$(echo "$src" | sed "s#\${DVR_HOST}#${DVR_HOST}#")
  push "$path" "$src" &
  sleep 1
done
wait
"""
    readme = f"""Unified CCTV site connector for '{r.name}' ({r.id})

1. Copy this folder to a small PC on the same network as the recorder (Docker installed).
2. Edit .env: DVR_HOST (recorder LAN IP), DVR_USER / DVR_PASS (a viewer-only user on the recorder).
   RELAY_HOST and SITE_KEY are already filled in. Keep SITE_KEY secret - it lets this site publish its cameras.
3. Check cameras.txt: one line per channel (path|stream URL). Remove channels you do not want to send.
4. Run:  docker compose up -d      (logs: docker compose logs -f)
The cameras appear on the command centre's wall within ~10 s and are recorded / analysed there.
Only outbound TCP {public_host}:8554 is used; nothing is opened on the site's router.
"""
    run_ps1 = r"""# Unified CCTV site connector for Windows (no Docker): one ffmpeg per camera, restarted on failure.
# 1. Put ffmpeg.exe next to this file (https://www.gyan.dev/ffmpeg/builds/ -> "ffmpeg-release-essentials.zip" -> bin\ffmpeg.exe)
# 2. Edit .env (DVR_HOST, DVR_USER, DVR_PASS)   3. Right-click run.ps1 -> Run with PowerShell (keep the window open)
# To start automatically at boot: Task Scheduler -> Create Basic Task -> At log on -> Start a program:
#    powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "<path>\run.ps1"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
$env_ = @{}
Get-Content .env | Where-Object { $_ -match '=' -and $_ -notmatch '^#' } | ForEach-Object { $k, $v = $_ -split '=', 2; $env_[$k.Trim()] = $v.Trim() }
$ffmpeg = Join-Path $here 'ffmpeg.exe'
if (-not (Test-Path $ffmpeg)) { Write-Host 'ffmpeg.exe not found next to run.ps1 - see step 1'; Read-Host 'press Enter'; exit 1 }
$jobs = @()
Get-Content cameras.txt | Where-Object { $_ -match '\|' -and $_ -notmatch '^#' } | ForEach-Object {
  $path, $src = $_ -split '\|', 2
  $src = $src.Replace('${DVR_HOST}', $env_['DVR_HOST']).Replace('rtsp://', "rtsp://$($env_['DVR_USER']):$($env_['DVR_PASS'])@")
  $dst = "rtsp://site:$($env_['SITE_KEY'])@$($env_['RELAY_HOST']):$($env_['RELAY_PORT'])/$path"
  $jobs += Start-Job -ArgumentList $ffmpeg, $src, $dst, $path -ScriptBlock {
    param($ff, $src, $dst, $path)
    while ($true) {
      Write-Output "$(Get-Date -Format HH:mm:ss) $path pushing"
      & $ff -nostdin -loglevel warning -rtsp_transport tcp -i $src -c copy -an -f rtsp -rtsp_transport tcp $dst
      Write-Output "$(Get-Date -Format HH:mm:ss) $path ended, retry in 5 s"; Start-Sleep 5
    }
  }
  Start-Sleep 1
}
Write-Host "Pushing $($jobs.Count) camera(s) to $($env_['RELAY_HOST']). Leave this window open. Ctrl+C stops."
while ($true) { $jobs | Receive-Job; Start-Sleep 5 }
"""
    readme += """
Windows without Docker: use run.ps1 instead of docker compose (instructions at the top of run.ps1).
"""
    return {"docker-compose.yml": compose, "run.sh": run_sh, "run.ps1": run_ps1, "cameras.txt": cameras_txt, ".env": env, "README.txt": readme}
