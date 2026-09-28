"""Common adapter interface and the read-only guard every adapter uses.

An adapter must answer three questions about one departmental source:
  * which cameras exist                    -> list_cameras()
  * where is the live stream per profile   -> CameraInfo.profiles[...].url
  * is the source healthy                  -> health()

Non-interference is enforced in code, not only by policy: all HTTP traffic
goes through ReadOnlyHTTP, which refuses any method or SOAP action that is
not on an explicit read-only allowlist.
"""
from __future__ import annotations

import abc
import logging
from dataclasses import dataclass, field
from urllib.parse import quote, urlsplit, urlunsplit

import requests

log = logging.getLogger("uvp.adapters")


class WriteAttemptBlocked(RuntimeError):
    """Raised when code tries to call a departmental system with a non-read operation."""


@dataclass
class StreamProfile:
    url: str                 # full RTSP URL incl. credentials; never leaves the platform backend
    width: int | None = None
    height: int | None = None
    codec: str | None = None

    def public(self) -> dict:
        return {"width": self.width, "height": self.height, "codec": self.codec}


@dataclass
class CameraInfo:
    native_id: str
    name: str
    lat: float | None = None
    lon: float | None = None
    profiles: dict[str, StreamProfile] = field(default_factory=dict)  # keys: "main", "sub"
    online: bool = True
    heading: float | None = None      # degrees clockwise from north (map coverage cone)
    fov: float | None = None          # degrees
    range_m: float | None = None      # metres


class ReadOnlyHTTP:
    """requests wrapper that only allows read operations against a departmental system."""

    SAFE_METHODS = {"GET", "HEAD"}

    def __init__(self, allowed_posts: set[str] | None = None, allowed_soap_actions: set[str] | None = None,
                 timeout: float = 8.0, verify: bool | str = True):
        self.allowed_posts = allowed_posts or set()          # path suffixes, e.g. "/auth/login"
        self.allowed_soap = allowed_soap_actions or set()    # e.g. {"GetProfiles", "GetStreamUri"}
        self.timeout = timeout
        self.s = requests.Session()
        self.s.verify = verify
        self.calls: list[str] = []                           # kept for the non-interference report

    def request(self, method: str, url: str, *, soap_action: str | None = None, **kw) -> requests.Response:
        m = method.upper()
        path = urlsplit(url).path
        if m not in self.SAFE_METHODS:
            if soap_action is not None:
                if soap_action not in self.allowed_soap:
                    raise WriteAttemptBlocked(f"SOAP action {soap_action} is not read-only-allowlisted")
            elif not any(path.endswith(p) for p in self.allowed_posts):
                raise WriteAttemptBlocked(f"{m} {path} blocked: platform is read-only towards departmental systems")
        self.calls.append(f"{m} {path}" + (f" [{soap_action}]" if soap_action else ""))
        kw.setdefault("timeout", self.timeout)
        return self.s.request(m, url, **kw)

    def get(self, url: str, **kw):
        return self.request("GET", url, **kw)

    def post(self, url: str, **kw):
        return self.request("POST", url, **kw)


def with_credentials(url: str, user: str | None, password: str | None) -> str:
    if not user:
        return url
    p = urlsplit(url)
    host = p.hostname or ""
    if p.port:
        host = f"{host}:{p.port}"
    netloc = f"{quote(user, safe='')}:{quote(password or '', safe='')}@{host}"
    return urlunsplit((p.scheme, netloc, p.path, p.query, p.fragment))


def redact(url: str) -> str:
    p = urlsplit(url)
    if p.username:
        host = p.hostname + (f":{p.port}" if p.port else "")
        return urlunsplit((p.scheme, f"***:***@{host}", p.path, p.query, p.fragment))
    return url


class Adapter(abc.ABC):
    kind: str = "base"

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.source_id = cfg["id"]
        self.overrides: dict = cfg.get("cameras") or {}

    @abc.abstractmethod
    def list_cameras(self) -> list[CameraInfo]:
        ...

    def health(self) -> tuple[bool, str]:
        try:
            cams = self.list_cameras()
            return True, f"{len(cams)} cameras reachable"
        except Exception as e:  # noqa: BLE001
            return False, str(e)[:300]

    def ping(self) -> tuple[bool, str]:
        """Cheapest possible liveness probe (one request). Adapters override this."""
        return self.health()

    def apply_overrides(self, cams: list[CameraInfo]) -> list[CameraInfo]:
        """Location / naming overrides from sources.yaml (many VMS lack geo data)."""
        for c in cams:
            o = self.overrides.get(c.native_id) or {}
            c.lat = o.get("lat", c.lat)
            c.lon = o.get("lon", c.lon)
            c.name = o.get("name", c.name)
            c.heading, c.fov, c.range_m = o.get("heading", c.heading), o.get("fov", c.fov), o.get("range_m", c.range_m)
        return cams

    def anpr_enabled(self, native_id: str) -> bool:
        return bool((self.overrides.get(native_id) or {}).get("anpr", False))

    def anpr_cfg(self, native_id: str) -> dict:
        """Per-camera ANPR tuning from sources.yaml: anpr_roi [x, y, w, h] as fractions of the frame (the band
        of road where plates are largest), anpr_upscale (2 = enlarge the region 2x before detection, for wide
        overview cameras), anpr_fps (override the global sampling rate)."""
        o = self.overrides.get(native_id) or {}
        out = {}
        if o.get("anpr_roi"):
            out["roi"] = [float(v) for v in o["anpr_roi"]]
        if o.get("anpr_upscale"):
            out["upscale"] = float(o["anpr_upscale"])
        if o.get("anpr_fps"):
            out["fps"] = float(o["anpr_fps"])
        return out

    def included(self, native_id: str) -> bool:
        inc = self.cfg.get("include")
        return not inc or native_id in inc
