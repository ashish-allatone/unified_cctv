"""Adapter service: departmental sources -> camera registry + relay paths + health.

Loop:
  1. for every source in sources.yaml build its adapter and list cameras
  2. upsert cameras (no credentials stored in the DB; stream URLs live only in the relay config)
  3. create/refresh relay paths <camera>/main and <camera>/sub (pulled on demand)
  4. record source + camera health; a failing source only marks its own cameras offline
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import time

from ..adapters.base import redact
from ..adapters.registry import build
from ..config import load_yaml, settings
from ..db import Camera, CameraStatusLog, SessionLocal, Source, init_db, utcnow
from .. import licensing
from .. import metrics as M
from ..relay import path_name, relay

log = logging.getLogger("uvp.adapters")
_adapters: dict[str, tuple[str, object]] = {}


def adapter_for(scfg: dict):
    """Reuse adapter instances (and their VMS login tokens) until the source config changes."""
    key = repr(sorted(scfg.items(), key=lambda kv: kv[0]))
    cached = _adapters.get(scfg["id"])
    if cached and cached[0] == key:
        return cached[1]
    ad = build(scfg)
    _adapters[scfg["id"]] = (key, ad)
    return ad


def record_wanted(scfg: dict, native_id: str, anpr: bool) -> bool:
    """Per camera `record:` override > per source `record:` > RECORD_MODE (none|anpr|all)."""
    cam_cfg = (scfg.get("cameras") or {}).get(native_id) or {}
    if "record" in cam_cfg:
        return bool(cam_cfg["record"])
    mode = str(scfg.get("record", settings.record_mode)).lower()
    if mode in ("true", "all"):
        return True
    if mode == "anpr":
        return anpr
    return False


_offline_since: dict[str, float] = {}
_ticketed: set[str] = set()
_paused_until: dict[str, float] = {}      # source id -> time until which its relay pulls stay removed (401 back-off)
_steady_since: dict[str, float] = {}      # relay path -> when it was (re)configured as a steady pull
_effective_cap: dict[str, int] = {}       # source id -> steady sessions the gateway actually accepted (learned)
STEADY_GRACE_S = 90                       # a steady pull that is not ready after this long is demoted to on demand
_last_probe: dict[str, float] = {}


def persistent_pull(scfg: dict, n_cameras: int) -> bool:
    """Pull every camera of this source all the time (one steady gateway session each) instead of opening and
    closing sessions as viewers and workers come and go. `persistent_pull: true|false` per source; the default is
    on for single-stream gateways (no `sub` template, e.g. Corp8) whose camera count fits `max_concurrent_pulls`:
    login churn is what trips their per-account limits, steady sessions are not."""
    if "persistent_pull" in scfg:
        return bool(scfg["persistent_pull"])
    single_stream = scfg.get("adapter") == "rtsp_template" and not scfg.get("sub")
    return single_stream            # bounded by max_concurrent_pulls in sync_once (steady sessions for the first N cameras)


def loopback_url(target, camera_id: str, profile: str) -> str:
    """RTSP URL a relay uses to read one of its own paths (inside its container: 127.0.0.1)."""
    port = target.rtsp.rsplit(":", 1)[-1].strip("/") if ":" in target.rtsp.replace("rtsp://", "") else "8554"
    return f"rtsp://{settings.relay_internal_user}:{settings.relay_internal_pass}@127.0.0.1:{port}/{path_name(camera_id, profile)}"


def source_paused(sid: str) -> bool:
    return _paused_until.get(sid, 0.0) > time.time()


def _probe_auth(url: str) -> str:
    """Open a stream once with ffprobe. Returns '' when it plays, '401' on credentials rejected, otherwise a short error."""
    if not shutil.which("ffprobe"):
        return ""
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-show_entries", "stream=codec_name",
                            "-of", "csv=p=0", url], capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        return "timeout"
    if p.returncode == 0 and p.stdout.strip():
        return ""
    err = p.stderr.strip()
    return "401" if ("401" in err or "Unauthorized" in err) else redact(err)[:120]


def auth_backoff(scfg: dict, live: dict[str, dict], configured: dict[str, tuple[str, bool, bool]]) -> None:
    """Stop hammering a gateway that rejects our credentials. When a direct-RTSP source has paths that should be
    pulling (recording, or a viewer waiting) but none is ready, probe one stream; on 401 remove the source's relay
    paths for AUTH_BACKOFF_S and mark the source, instead of retrying 30 cameras every few seconds until the
    vendor locks the account. Paths come back on the next sync after the pause."""
    sid = scfg["id"]
    if scfg.get("adapter") not in ("rtsp", "rtsp_template") or source_paused(sid):
        return
    if time.time() - _last_probe.get(sid, 0.0) < 60:
        return
    with SessionLocal() as s:
        cam_ids = [c.id for c in s.query(Camera).filter(Camera.source_id == sid) if c.status != "unlicensed"]
    wanted = [n for n in configured if n.split("/")[0] in cam_ids and (any(configured[n][1:]) or live.get(n, {}).get("readers"))]
    if not wanted or any(live.get(n, {}).get("ready") for n in wanted):
        return                                 # nothing is being pulled, or at least one pull works: credentials fine
    _last_probe[sid] = time.time()
    try:
        ad = adapter_for(scfg)
        cams = ad.list_cameras()
        url = next(c.profiles["main"].url for c in cams if f"{scfg.get('id_prefix', '')}{c.native_id}" in cam_ids)
    except Exception:  # noqa: BLE001
        return
    verdict = _probe_auth(url)
    if verdict != "401":
        return
    pause = int(settings.auth_backoff_s)
    _paused_until[sid] = time.time() + pause
    for n in configured:
        if n.split("/")[0] in cam_ids:
            try:
                relay.delete_path(n)
            except Exception:  # noqa: BLE001
                pass
    detail = (f"credentials rejected by the gateway (401 Unauthorized): pulls paused for {pause // 60} min to avoid an account "
              f"lockout. Check the username / access password in .env, then: docker compose restart adapters")
    with SessionLocal() as s:
        src = s.get(Source, sid)
        if src is not None:
            src.status, src.status_detail, src.checked_at = "error", detail, utcnow()
        for cam in s.query(Camera).filter(Camera.source_id == sid):
            _set_status(s, cam, "offline", "credentials rejected")
        s.commit()
    M.SOURCE_UP.labels(sid, scfg.get("department", sid)).set(0)
    log.error("source %s: %s", sid, detail)


def _set_status(s, cam: Camera, status: str, detail: str = "") -> None:
    """Record transitions (online/live count as up; offline as down) and raise camera.health events."""
    was_down = cam.status == "offline"
    is_down = status == "offline"
    if cam.status != status and (was_down != is_down or not cam.status or cam.status == "unknown"):
        s.add(CameraStatusLog(camera_id=cam.id, status=status, detail=detail[:200]))
        _emit_health(cam, status, detail)
    cam.status = status
    now = time.time()
    if is_down:
        _offline_since.setdefault(cam.id, now)
        if cam.id not in _ticketed and now - _offline_since[cam.id] >= 60 * settings.outage_ticket_minutes:
            _ticketed.add(cam.id)
            _ticket(cam, f"offline for {settings.outage_ticket_minutes}+ minutes", detail)
    else:
        _offline_since.pop(cam.id, None)
        _ticketed.discard(cam.id)


def _emit_health(cam: Camera, status: str, detail: str) -> None:
    try:
        import requests
        requests.post(f"{settings.api_url}/internal/camera-health", json={"camera_id": cam.id, "department": cam.department,
                      "status": status, "detail": detail, "ts": utcnow().isoformat()},
                      headers={"X-Internal-Secret": settings.internal_secret}, timeout=3)
    except Exception:  # noqa: BLE001
        pass


def _ticket(cam: Camera, summary: str, detail: str) -> None:
    from .routes_ops import _ticket as open_ticket
    open_ticket(cam.id, cam.department, summary, detail)


def all_sources() -> dict:
    """sources.yaml plus the devices connected from the console (stored in the sources table, credentials
    encrypted with TOKEN_SECRET). A console device with the same id as a yaml source is ignored."""
    cfg = load_yaml(settings.sources_file)
    if isinstance(cfg, list):          # file written without the top-level "sources:" key
        cfg = {"sources": cfg}
    cfg.setdefault("sources", [])
    ids = {sc.get("id") for sc in cfg["sources"]}
    try:
        from .devices import db_sources
        cfg["sources"] += [sc for sc in db_sources() if sc["id"] not in ids]
    except Exception:  # noqa: BLE001
        log.exception("could not load console-managed devices")
    return cfg


_db_sources_seen = 0.0


def db_sources_changed() -> bool:
    """True once when a console-managed device was added / changed / removed since the last full sync."""
    global _db_sources_seen
    try:
        from .devices import db_sources_version
        v = db_sources_version()
    except Exception:  # noqa: BLE001
        return False
    if v != _db_sources_seen:
        _db_sources_seen = v
        return True
    return False


def sync_once() -> dict:
    cfg = all_sources()
    db_sources_changed()
    report = {}
    relay.ping_all()
    live = {p["name"]: p for p in relay.live_paths(0)}
    by_relay = relay.configured_by_relay()
    lic = licensing.load()
    all_ids = sorted(f"{sc.get('id_prefix', '')}{cid}" for sc in cfg.get("sources", []) for cid in (sc.get("cameras") or {}))
    licensed: set[str] | None = None
    known: set[str] = set()
    if int(lic.get("cameras") or 0) > 0:
        # cap deterministically by sorted id over every camera the platform knows: the registry, the ids named
        # in sources.yaml, and (added below, as each source is listed) the ids the adapters discover
        with SessionLocal() as s0:
            known = {c.id for c in s0.query(Camera).all() if not c.registry_only} | set(all_ids)   # registry-only cameras are not pulled: not licensed seats
        licensed = licensing.allowed_cameras(lic, sorted(known))
    for scfg in cfg.get("sources", []):
        sid = scfg["id"]
        started = time.time()
        with SessionLocal() as s:
            src = s.get(Source, sid) or Source(id=sid)
            src.department = scfg.get("department", sid)
            src.name = scfg.get("name", sid)
            src.adapter = scfg["adapter"]
            src.max_concurrent_pulls = int(scfg.get("max_concurrent_pulls", 16))
            src = s.merge(src)
            s.flush()                  # source row must exist before its cameras (FK on PostgreSQL)
            try:
                ad = adapter_for(scfg)
                cams = ad.list_cameras()
                if licensed is not None:
                    known |= {f"{scfg.get('id_prefix', '')}{c.native_id}" for c in cams}
                    licensed = licensing.allowed_cameras(lic, sorted(known))
                # steady (always-on) gateway sessions are limited to max_concurrent_pulls: recorded cameras first, then
                # ANPR cameras, then the rest by id; cameras beyond the cap are pulled only while someone watches them
                cap = int(scfg.get("max_concurrent_pulls", 16))
                if sid in _effective_cap:
                    cap = min(cap, _effective_cap[sid])
                try:      # cameras with analytics / face rules in analytics.yaml deserve a steady session too
                    configured_analytics = set(((load_yaml(settings.analytics_file) or {}).get("cameras") or {}).keys())
                except Exception:  # noqa: BLE001
                    configured_analytics = set()
                pfx = scfg.get("id_prefix", "")
                ranked = sorted(cams, key=lambda x: (not record_wanted(scfg, x.native_id, ad.anpr_enabled(x.native_id)),
                                                    not ad.anpr_enabled(x.native_id), f"{pfx}{x.native_id}" not in configured_analytics,
                                                    not live.get(f"{pfx}{x.native_id}/main", {}).get("ready"),   # keep sessions the gateway already accepted
                                                    x.native_id))
                steady_ids = {f"{scfg.get('id_prefix', '')}{x.native_id}" for x in ranked[:cap]}
                if persistent_pull(scfg, len(cams)) and len(cams) > cap:
                    log.info("source %s: %d cameras, cap %d -> steady sessions for %s…, the rest on demand", sid, len(cams), cap, sorted(steady_ids)[:5])
                for c in cams:
                    cid = f"{scfg.get('id_prefix', '')}{c.native_id}"
                    cam = s.get(Camera, cid) or Camera(id=cid, source_id=sid)
                    cam.department = src.department
                    if not cam.name or not cam.updated_by:          # a name typed into the registry wins over the VMS name
                        cam.name = c.name
                    # the source's geo data wins when it has some; otherwise what was set in the registry stays
                    if c.lat is not None and c.lon is not None:
                        cam.lat, cam.lon = c.lat, c.lon
                    for k in ("heading", "fov", "range_m"):
                        if getattr(c, k) is not None:
                            setattr(cam, k, getattr(c, k))
                    cam.profiles = {k: v.public() for k, v in c.profiles.items()}
                    cam.anpr_enabled = ad.anpr_enabled(c.native_id)
                    cam.anpr_cfg = ad.anpr_cfg(c.native_id)
                    cam.updated_at = utcnow()
                    if licensed is not None and cid not in licensed:
                        # over the licence's camera limit: keep it in the registry, never touch the relay
                        cam.status = "unlicensed"
                        s.merge(cam)
                        continue
                    if source_paused(sid):     # 401 back-off: registry is kept current, relay paths stay removed
                        _set_status(s, cam, "offline", "credentials rejected")
                        s.merge(cam)
                        continue
                    rec = record_wanted(scfg, c.native_id, cam.anpr_enabled)
                    target = relay.assign(cid)
                    if cam.relay and cam.relay != target.name:
                        old = relay.relays.get(cam.relay)
                        if old is not None and old.healthy:
                            for prof in c.profiles:
                                old.delete_path(path_name(cid, prof))
                        log.info("camera %s moves relay %s -> %s", cid, cam.relay, target.name)
                    cam.relay = target.name
                    configured = by_relay.get(target.name, {})
                    main_url = c.profiles["main"].url if "main" in c.profiles else None
                    persist = persistent_pull(scfg, len(cams)) and cid in steady_ids
                    for prof, sp in c.profiles.items():
                        pn = path_name(cid, prof)
                        want_rec = rec and prof == "main"       # archive the main profile only
                        src_url = sp.url
                        if sp.url == "publisher" and prof != "main":
                            src_url = loopback_url(target, cid, "main")       # the site pushes one stream; sub re-reads it
                        elif prof != "main" and main_url and sp.url == main_url:
                            # single-stream camera (Corp8 gives one URL): the sub path re-reads the relay's own
                            # main path instead of opening a second session on the departmental gateway -
                            # halves the gateway's concurrent-session count (30 cameras -> 30 sessions, not 60)
                            src_url = loopback_url(target, cid, "main")
                        want_persist = (persist and prof == "main") or src_url == "publisher"   # a pushed stream is always "on"
                        if configured.get(pn) != (src_url, want_rec, want_rec or want_persist):  # only touch the relay when something changed
                            result = target.upsert_path(pn, src_url, record=want_rec, persistent=want_persist)
                            log.info("relay %s path %s -> %s record=%s persistent=%s (%s)", target.name, pn, redact(src_url), want_rec, want_persist, result)
                            if want_persist or want_rec:
                                _steady_since[pn] = time.time()
                            if want_persist and result == "added" and settings.relay_add_stagger_s > 0:
                                time.sleep(settings.relay_add_stagger_s)   # spread the gateway logins out instead of 30 at once
                    pulling = any(live.get(path_name(cid, p), {}).get("ready") for p in ("main", "sub"))
                    _set_status(s, cam, "live" if pulling else ("online" if c.online else "offline"))
                    s.merge(cam)
                if source_paused(sid):
                    raise RuntimeError(f"credentials rejected (401): pulls paused until "
                                       f"{time.strftime('%H:%M:%S', time.localtime(_paused_until[sid]))} - check the username / access password in .env")
                src.status = "ok"
                src.status_detail = f"{len(cams)} cameras via {ad.kind} in {time.time() - started:.1f}s"
                M.SOURCE_UP.labels(sid, src.department).set(1)
                M.SOURCE_SYNC_SECONDS.labels(sid).set(time.time() - started)
                report[sid] = {"ok": True, "cameras": len(cams),
                               "calls": getattr(getattr(ad, "http", None), "calls", [])[-6:]}
                log.info("source %s ok: %s", sid, src.status_detail)
            except Exception as e:  # noqa: BLE001
                src.status = "error"
                src.status_detail = redact(str(e))[:400]
                M.SOURCE_UP.labels(sid, src.department).set(0)
                for cam in s.query(Camera).filter(Camera.source_id == sid):
                    _set_status(s, cam, "offline", "source error")
                report[sid] = {"ok": False, "error": src.status_detail}
                log.warning("source %s failed: %s", sid, src.status_detail)
            src.checked_at = utcnow()
            s.merge(src)
            s.commit()
    return report


def learn_session_cap(scfg: dict, live: dict[str, dict], configured: dict[str, tuple[str, bool, bool]]) -> None:
    """A gateway that accepts fewer steady sessions than max_concurrent_pulls refuses the extra ones - and the relay
    would retry those every few seconds for ever (a login storm that ends in a lockout for every camera). When some
    steady pulls of a source are ready and others have not come up within STEADY_GRACE_S, demote the failed ones to
    on demand and remember the number that worked as the source's effective cap (until the adapters restart or
    max_concurrent_pulls is corrected in sources.yaml)."""
    sid = scfg["id"]
    if scfg.get("adapter") not in ("rtsp", "rtsp_template"):
        return
    with SessionLocal() as s:
        cam_ids = {c.id for c in s.query(Camera).filter(Camera.source_id == sid)}
    now = time.time()
    steady = [n for n, (_u, rec, persist) in configured.items() if n.endswith("/main") and persist and n.split("/")[0] in cam_ids]
    if not steady:
        return
    ready = [n for n in steady if live.get(n, {}).get("ready")]
    failed = [n for n in steady if not live.get(n, {}).get("ready") and now - _steady_since.get(n, now) > STEADY_GRACE_S]
    if not failed or not ready:
        return                     # nothing failed, or everything failed (that is the 401 back-off's job)
    for n in failed:
        try:
            r = relay.for_camera(n.split("/")[0])
            r.upsert_path(n, configured[n][0], record=False, persistent=False)
            _steady_since.pop(n, None)
        except Exception as e:  # noqa: BLE001
            log.warning("could not demote %s: %s", n, e)
    _effective_cap[sid] = len(ready)
    msg = (f"gateway accepted {len(ready)} steady sessions, refused {len(failed)}: those cameras are now pulled on demand only. "
           f"Set max_concurrent_pulls: {len(ready)} in config/sources.yaml (or ask the provider to raise the limit)")
    log.warning("source %s: %s (%s)", sid, msg, ", ".join(n.split("/")[0] for n in failed[:6]))
    with SessionLocal() as s:
        src = s.get(Source, sid)
        if src is not None:
            src.status_detail = msg
            s.commit()


def ping_once() -> None:
    """Light health check between full syncs: one request per source, no camera re-listing."""
    cfg = all_sources()
    if isinstance(cfg, list):
        cfg = {"sources": cfg}
    health = relay.ping_all()
    for n, ok in health.items():
        M.RELAY_UP.labels(n).set(1 if ok else 0)
    if any(health.values()):
        # a relay that restarted has no paths; a relay that died needs its cameras moved elsewhere
        with SessionLocal() as s:
            assigned = {c.id: c.relay for c in s.query(Camera).all() if c.status != "unlicensed" and not source_paused(c.source_id)}
        needs = False
        for n, ok in health.items():
            holds = [cid for cid, rn in assigned.items() if rn == n]
            if not ok and holds:
                log.warning("relay %s is down; %d cameras will move", n, len(holds))
                needs = True
            elif ok and holds:
                try:
                    have = relay.relays[n].configured_paths()
                    missing = [cid for cid in holds if path_name(cid, "main") not in have]
                    if missing:
                        log.info("relay %s is missing %d camera path(s) (restarted?), e.g. %s; re-registering", n, len(missing), missing[:3])
                        needs = True
                except Exception:  # noqa: BLE001
                    needs = True
        if needs or any(relay.assign(cid).name != rn for cid, rn in assigned.items() if rn):
            sync_once()
            return
    live = {p["name"]: p for p in (relay.live_paths(0) if relay.ping() else [])}
    configured = relay.configured_paths()
    for scfg in cfg.get("sources", []):
        auth_backoff(scfg, live, configured)
        if source_paused(scfg["id"]):
            continue
        learn_session_cap(scfg, live, configured)
        ok, detail = adapter_for(scfg).ping()
        with SessionLocal() as s:
            src = s.get(Source, scfg["id"])
            if src is None:
                continue
            was_ok = src.status == "ok"
            src.status = "ok" if ok else "error"
            if not ok:
                src.status_detail = redact(detail)
            src.checked_at = utcnow()
            for cam in s.query(Camera).filter(Camera.source_id == src.id):
                if not ok:
                    _set_status(s, cam, "offline", "source unreachable")
                else:
                    pulling = any(live.get(path_name(cam.id, p), {}).get("ready") for p in ("main", "sub"))
                    _set_status(s, cam, "live" if pulling else "online")
            s.commit()
        if ok and not was_ok:
            log.info("source %s recovered; running full sync", scfg["id"])
            sync_once()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    init_db()
    M.serve()
    while not relay.ping():
        log.info("waiting for a relay control API (%s)", ", ".join(r.base for r in relay.relays.values()))
        time.sleep(2)
    next_sync = 0.0
    while True:
        try:
            if time.time() >= next_sync or db_sources_changed():
                sync_once()
                next_sync = time.time() + settings.sync_interval_s
            else:
                ping_once()
        except Exception:  # noqa: BLE001
            log.exception("sync failed")
        time.sleep(settings.health_interval_s)


if __name__ == "__main__":
    main()
