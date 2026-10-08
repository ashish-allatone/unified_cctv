"""Find and add new channels on template sources (gateways / NVRs without a camera-list API, e.g. Corp8).

A `rtsp_template` source says `channels: 30`; when the client adds cam31, cam32 ... nothing tells us. This module
probes the next channel numbers one at a time (one extra RTSP session, short timeout, so a gateway with a session
cap is not pushed into 401 lock-out) and, when streams answer, raises the channel count. Overrides are stored in
the settings table (`source_overrides`), so sources.yaml is never rewritten and the change survives redeploys;
console-connected devices are updated in their own config.

  scan(sid, start, stop)      probe channels start..stop -> [{channel, ok, codec, size, error}]
  set_channels(sid, count)    make the source expose `count` channels (adapters pick it up on the next sync)
  auto_scan_tick()            called by the adapters service: for sources with auto_scan on, probe the next few
                              channels once per `auto_scan_interval_s` and extend automatically
"""
from __future__ import annotations

import logging
import threading
import time

from ..config import settings
from ..db import SessionLocal, get_setting, set_setting, utcnow

log = logging.getLogger("uvp.scan")
_lock = threading.Lock()
_last_auto: dict[str, float] = {}


def overrides() -> dict:
    with SessionLocal() as s:
        return dict(get_setting(s, "source_overrides", {}))


def overrides_version() -> float:
    from ..db import Setting
    with SessionLocal() as s:
        row = s.get(Setting, "source_overrides")
        return row.updated_at.timestamp() if row and row.updated_at else 0.0


def apply_overrides(cfg: dict) -> dict:
    """Merge console overrides (channel count, auto-scan flag) into a loaded sources.yaml config."""
    ov = overrides()
    if not ov:
        return cfg
    for sc in cfg.get("sources", []):
        o = ov.get(sc.get("id"))
        if not o:
            continue
        if "channels" in o and isinstance(sc.get("channels", 1), int):
            sc["channels"] = max(int(sc.get("channels", 1)), int(o["channels"]))
        elif "channels" in o and isinstance(sc.get("channels"), list):
            have = {int(c.get("channel", 0)) for c in sc["channels"]}
            for n in range(1, int(o["channels"]) + 1):
                if n not in have:
                    sc["channels"].append({"channel": n})
        if "auto_scan" in o:
            sc["auto_scan"] = bool(o["auto_scan"])
    return cfg


def _source_cfg(sid: str) -> dict | None:
    from .adapter_service import all_sources
    from ..adapters.registry import resolve
    for sc in all_sources().get("sources", []):
        if sc.get("id") == sid:
            return resolve(dict(sc))
    return None


def _creds(cfg: dict) -> tuple[str, str]:
    import os
    u = os.environ.get(cfg.get("username_env", ""), cfg.get("username", "") or "")
    p = os.environ.get(cfg.get("password_env", ""), cfg.get("password", "") or "")
    return u, p


def channel_count(cfg: dict) -> int:
    ch = cfg.get("channels", 1)
    if isinstance(ch, int):
        return ch
    return max((int(c.get("channel", 0)) for c in ch), default=0)


def describe(sid: str) -> dict:
    cfg = _source_cfg(sid)
    if cfg is None:
        raise KeyError(sid)
    ov = overrides().get(sid, {})
    return {"id": sid, "adapter": cfg.get("adapter"), "scannable": cfg.get("adapter") == "rtsp_template", "channels": channel_count(cfg),
            "auto_scan": bool(cfg.get("auto_scan") or ov.get("auto_scan")), "override": ov, "managed": bool(cfg.get("managed")),
            "template": cfg.get("main", "")}


def probe(cfg: dict, channel: int, timeout_s: int = 8) -> dict:
    """ffprobe one channel of a template source (credentials from env / vault / device secret)."""
    import shutil
    import subprocess
    from ..adapters.base import with_credentials
    from .devices import redact
    url = with_credentials(cfg["main"].format(host=cfg["host"], rtsp_port=cfg.get("rtsp_port", 554), channel=channel), *_creds(cfg))
    if not shutil.which("ffprobe"):
        return {"channel": channel, "ok": False, "error": "ffprobe missing"}
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-rw_timeout", str(timeout_s * 1_000_000),
                            "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", url], capture_output=True, text=True, timeout=timeout_s + 4)
    except subprocess.TimeoutExpired:
        return {"channel": channel, "ok": False, "error": "timeout"}
    if p.returncode == 0 and p.stdout.strip():
        first = p.stdout.strip().splitlines()[0].split(",")
        return {"channel": channel, "ok": True, "codec": first[0], "size": f"{first[1]}x{first[2]}" if len(first) >= 3 and first[1] else "", "error": ""}
    err = p.stderr.strip()
    kind = "401 (credentials / session cap)" if "401" in err or "Unauthorized" in err else "404 (no such channel)" if "404" in err else redact(err)[:120] or "no answer"
    return {"channel": channel, "ok": False, "error": kind}


def scan(sid: str, start: int | None = None, stop: int | None = None, timeout_s: int = 8) -> dict:
    """Probe channels start..stop (default: the next 10 after the current count), one at a time."""
    cfg = _source_cfg(sid)
    if cfg is None:
        raise KeyError(sid)
    if cfg.get("adapter") != "rtsp_template":
        raise ValueError(f"{sid} is a {cfg.get('adapter')} source: its camera list comes from the device / VMS API and refreshes by itself")
    cur = channel_count(cfg)
    start = int(start or cur + 1)
    stop = int(stop or start + 9)
    if stop - start > 60:
        raise ValueError("scan at most 60 channels at a time")
    with _lock:                                  # one probe at a time platform-wide: a gateway session cap must not be exceeded
        results = []
        misses = 0
        for ch in range(start, stop + 1):
            r = probe(cfg, ch, timeout_s)
            results.append(r)
            if r["ok"]:
                misses = 0
            else:
                misses += 1
                if r["error"].startswith("401"):
                    break                        # credentials / lock-out: stop immediately, do not make it worse
                if misses >= 5 and not any(x["ok"] for x in results):
                    break                        # five dead channels in a row from the start: nothing new here
            time.sleep(0.5)
    found = [r["channel"] for r in results if r["ok"]]
    return {"id": sid, "current_channels": cur, "scanned": [start, results[-1]["channel"] if results else start], "results": results,
            "found": found, "suggested_channels": max(cur, max(found)) if found else cur,
            "stopped_early": bool(results and results[-1]["error"].startswith("401"))}


def set_channels(sid: str, count: int, actor: str, auto_scan: bool | None = None) -> dict:
    """Raise (or set) the channel count of a template source. Yaml sources get a console override; console
    devices are edited directly. The adapters pick it up within one sync."""
    cfg = _source_cfg(sid)
    if cfg is None:
        raise KeyError(sid)
    if cfg.get("adapter") != "rtsp_template":
        raise ValueError("only template sources have a channel count")
    count = int(count)
    if not 1 <= count <= 512:
        raise ValueError("channels must be 1-512")
    if cfg.get("managed"):
        from sqlalchemy import select
        from ..db import Source
        with SessionLocal() as s:
            row = s.get(Source, sid)
            c = dict(row.config or {})
            ch = c.get("channels", 1)
            if isinstance(ch, list):
                have = {int(x.get("channel", 0)) for x in ch}
                ch = ch + [{"channel": n} for n in range(1, count + 1) if n not in have]
            else:
                ch = count
            c["channels"] = ch
            if auto_scan is not None:
                c["auto_scan"] = bool(auto_scan)
            row.config, row.updated_at = c, utcnow()
            s.commit()
    with SessionLocal() as s:
        ov = dict(get_setting(s, "source_overrides", {}))
        o = dict(ov.get(sid, {}))
        o["channels"] = count
        if auto_scan is not None:
            o["auto_scan"] = bool(auto_scan)
        o["updated_by"], o["updated_at"] = actor, utcnow().isoformat()
        ov[sid] = o
        set_setting(s, "source_overrides", ov, actor)
        s.commit()
    return describe(sid)


def set_auto_scan(sid: str, on: bool, actor: str) -> dict:
    cfg = _source_cfg(sid)
    if cfg is None:
        raise KeyError(sid)
    with SessionLocal() as s:
        ov = dict(get_setting(s, "source_overrides", {}))
        o = dict(ov.get(sid, {}))
        o["auto_scan"] = bool(on)
        o["updated_by"], o["updated_at"] = actor, utcnow().isoformat()
        ov[sid] = o
        set_setting(s, "source_overrides", ov, actor)
        s.commit()
    return describe(sid)


def auto_scan_tick(cfg_all: dict) -> list[dict]:
    """Adapters service: for template sources with auto_scan, probe the next `auto_scan_probe` channels once per
    interval; extend the channel count when any answer. Returns what changed."""
    changed = []
    now = time.time()
    from ..adapters.registry import resolve
    for sc in cfg_all.get("sources", []):
        if not sc.get("auto_scan"):
            continue
        try:
            if resolve(dict(sc)).get("adapter") != "rtsp_template":
                continue
        except ValueError:
            continue
        sid = sc.get("id")
        if now - _last_auto.get(sid, 0.0) < settings.auto_scan_interval_s:
            continue
        _last_auto[sid] = now
        try:
            cur = channel_count(_source_cfg(sid) or sc)
            res = scan(sid, cur + 1, cur + settings.auto_scan_probe, timeout_s=6)
            if res["found"]:
                set_channels(sid, res["suggested_channels"], "auto-scan")
                changed.append({"id": sid, "from": cur, "to": res["suggested_channels"], "found": res["found"]})
                log.info("auto-scan %s: new channels %s -> channels %d", sid, res["found"], res["suggested_channels"])
                try:
                    from ..inbox import push
                    push("device", f"{sid}: {len(res['found'])} new camera channel(s) found", f"channels {', '.join(map(str, res['found']))} added automatically (now {res['suggested_channels']})",
                         department=sc.get("department", "*"), ref_id=sid, link="sources", feature="sources")
                except Exception:  # noqa: BLE001
                    pass
        except Exception as e:  # noqa: BLE001
            log.warning("auto-scan %s failed: %s", sid, e)
    return changed
