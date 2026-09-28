"""Clients for the MediaMTX relay(s).

Single relay: RELAY_API / RELAY_RTSP / RELAY_PLAYBACK / RELAY_PUBLIC_HOST.
Cluster:       RELAY_APIS="a=http://relay-a:9997,b=http://relay-b:9997" (+ RELAY_RTSPS, RELAY_PLAYBACKS,
               RELAY_PUBLIC_HOSTS with the same names). Cameras are assigned to relays by rendezvous hashing
               over the healthy relays (adapter service), so a failed relay's cameras move to the others and
               move back when it returns. The assignment lives in cameras.relay.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
import threading
import time

import requests

from .config import settings

log = logging.getLogger("uvp.relay")


def _parse(spec: str) -> dict[str, str]:
    out = {}
    for part in (spec or "").split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


class Relay:
    def __init__(self, name: str, api: str, rtsp: str, playback: str, public_host: str = ""):
        # public_host may carry ports: "host" | "host:webrtc_port" | "host:webrtc_port:hls_port"
        parts = (public_host or "").split(":")
        self.public_host = parts[0]
        self.public_webrtc_port = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else settings.relay_webrtc_port
        self.public_hls_port = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else settings.relay_hls_port
        self.name, self.base, self.rtsp, self.playback = name, api.rstrip("/"), rtsp, playback
        self.auth = (settings.relay_internal_user, settings.relay_internal_pass)
        self._paths_cache: tuple[float, list] = (0.0, [])
        self.healthy = True
        self.last_ok = 0.0

    def _req(self, method: str, path: str, **kw):
        return requests.request(method, self.base + path, auth=self.auth, timeout=5, **kw)

    def upsert_path(self, name: str, source_url: str, record: bool = False, persistent: bool = False) -> str:
        # a recorded or persistent path is pulled all the time; the rest only while someone reads it
        conf = {"source": source_url, "sourceOnDemand": not (record or persistent), "sourceOnDemandStartTimeout": "10s",
                "sourceOnDemandCloseAfter": "10s", "rtspTransport": "tcp", "record": record,
                "recordFormat": "fmp4", "recordSegmentDuration": f"{settings.record_segment_s}s",
                "recordDeleteAfter": settings.record_local_keep}
        r = self._req("POST", f"/v3/config/paths/add/{name}", json=conf)
        if r.status_code == 200:
            return "added"
        if r.status_code == 400 and "already exists" in r.text:
            r2 = self._req("PATCH", f"/v3/config/paths/patch/{name}", json=conf)
            r2.raise_for_status()
            return "updated"
        r.raise_for_status()
        return "?"

    def delete_path(self, name: str) -> None:
        try:
            self._req("DELETE", f"/v3/config/paths/delete/{name}")
        except requests.RequestException:
            pass

    def configured_paths(self) -> dict[str, tuple[str, bool, bool]]:
        r = self._req("GET", "/v3/config/paths/list?itemsPerPage=5000")
        r.raise_for_status()
        return {p["name"]: (p.get("source", ""), bool(p.get("record")), not p.get("sourceOnDemand", True)) for p in r.json().get("items", [])}

    def live_paths(self, max_age: float = 1.0) -> list[dict]:
        ts, items = self._paths_cache
        if time.time() - ts < max_age:
            return items
        r = self._req("GET", "/v3/paths/list?itemsPerPage=5000")
        r.raise_for_status()
        items = [{**p, "relay": self.name} for p in r.json().get("items", [])]
        self._paths_cache = (time.time(), items)
        return items

    def ping(self) -> bool:
        try:
            ok = self._req("GET", "/v3/config/global/get").status_code == 200
        except requests.RequestException:
            ok = False
        if ok:
            self.last_ok = time.time()
        self.healthy = ok
        return ok

    # ---- recordings (playback server)
    def _pb(self, route: str, **params):
        return requests.get(self.playback.rstrip("/") + route, params=params, auth=self.auth, timeout=60)

    def recording_ranges(self, path: str) -> list[dict]:
        r = self._pb("/list", path=path)
        return r.json() if r.status_code == 200 else []

    def clip(self, path: str, start: dt.datetime, duration_s: float) -> bytes | None:
        r = self._pb("/get", path=path, start=start.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                     duration=str(duration_s), format="mp4")
        return r.content if r.status_code == 200 and r.content else None


class RelayPool:
    """All relays plus camera -> relay lookup. Backward compatible with the single-relay API."""

    def __init__(self):
        apis = _parse(settings.relay_apis)
        if not apis:
            self.relays = {"relay": Relay("relay", settings.relay_api, settings.relay_rtsp, settings.relay_playback,
                                          settings.relay_public_host)}
        else:
            rtsps, pbs, hosts = _parse(settings.relay_rtsps), _parse(settings.relay_playbacks), _parse(settings.relay_public_hosts)
            self.relays = {n: Relay(n, a, rtsps.get(n, settings.relay_rtsp), pbs.get(n, settings.relay_playback), hosts.get(n, ""))
                           for n, a in apis.items()}
        self._assign_cache: dict[str, tuple[float, str]] = {}
        self._lock = threading.Lock()

    # ---- topology
    @property
    def primary(self) -> Relay:
        return next(iter(self.relays.values()))

    def get(self, name: str | None) -> Relay:
        return self.relays.get(name or "", None) or self.primary

    def healthy(self) -> list[Relay]:
        return [r for r in self.relays.values() if r.healthy]

    def ping(self) -> bool:
        return any(r.ping() for r in self.relays.values())

    def ping_all(self) -> dict[str, bool]:
        return {n: r.ping() for n, r in self.relays.items()}

    def assign(self, camera_id: str) -> Relay:
        """Rendezvous hashing: the healthy relay with the highest hash(camera, relay) wins; stable across
        additions/removals of other relays and identical on every service."""
        cands = self.healthy() or list(self.relays.values())
        return max(cands, key=lambda r: hashlib.sha256(f"{camera_id}|{r.name}".encode()).hexdigest())

    def for_camera(self, camera_id: str) -> Relay:
        """Relay currently holding the camera (from cameras.relay, cached 30 s)."""
        if len(self.relays) == 1:
            return self.primary
        hit = self._assign_cache.get(camera_id)
        if hit and time.time() - hit[0] < 30:
            return self.get(hit[1])
        try:
            from .db import Camera, SessionLocal
            with SessionLocal() as s:
                cam = s.get(Camera, camera_id)
                name = cam.relay if cam and cam.relay else ""
        except Exception:  # noqa: BLE001
            name = ""
        if not name:
            name = self.assign(camera_id).name
        self._assign_cache[camera_id] = (time.time(), name)
        return self.get(name)

    # ---- aggregate views (single-relay compatible)
    def live_paths(self, max_age: float = 1.0) -> list[dict]:
        out: list[dict] = []
        for r in self.relays.values():
            try:
                out += r.live_paths(max_age)
            except requests.RequestException:
                r.healthy = False
        return out

    def configured_paths(self) -> dict[str, tuple[str, bool, bool]]:
        out: dict[str, tuple[str, bool, bool]] = {}
        for r in self.relays.values():
            try:
                out.update(r.configured_paths())
            except requests.RequestException:
                r.healthy = False
        return out

    def configured_by_relay(self) -> dict[str, dict[str, tuple[str, bool, bool]]]:
        out = {}
        for n, r in self.relays.items():
            try:
                out[n] = r.configured_paths()
            except requests.RequestException:
                r.healthy = False
                out[n] = {}
        return out

    def upsert_path(self, name: str, source_url: str, record: bool = False, relay_name: str | None = None, persistent: bool = False) -> str:
        return self.get(relay_name).upsert_path(name, source_url, record, persistent)

    def delete_path(self, name: str, relay_name: str | None = None) -> None:
        self.get(relay_name).delete_path(name)

    def recording_ranges(self, path: str) -> list[dict]:
        return self.for_camera(path.split("/")[0]).recording_ranges(path)

    def clip(self, path: str, start: dt.datetime, duration_s: float) -> bytes | None:
        return self.for_camera(path.split("/")[0]).clip(path, start, duration_s)


relay = RelayPool()


def path_name(camera_id: str, profile: str) -> str:
    return f"{camera_id}/{profile}"


def internal_rtsp_url(camera_id: str, profile: str) -> str:
    r = relay.for_camera(camera_id)
    base = r.rtsp.replace("rtsp://", "")
    return f"rtsp://{settings.relay_internal_user}:{settings.relay_internal_pass}@{base}/{path_name(camera_id, profile)}"
