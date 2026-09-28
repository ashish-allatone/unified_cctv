"""Generic vendor-VMS REST adapter.

Most commercial VMS (Milestone, Genetec, Hikvision/HikCentral, Dahua DSS,
Axis, Bosch...) expose an HTTP API with the same three steps:
  1. log in -> token
  2. list cameras
  3. ask for a live-stream URL per camera and profile

The endpoints and JSON field names differ per vendor, so they are set in
sources.yaml (see `api:` block) instead of code. Only the login POST is
allowlisted; everything else must be GET.
"""
from __future__ import annotations

import os
import time

from .base import Adapter, CameraInfo, ReadOnlyHTTP, StreamProfile, with_credentials


def _dig(obj, path: str, default=None):
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return cur


class VendorRestAdapter(Adapter):
    kind = "vendor_rest"

    DEFAULT_API = {
        "login_path": "/api/v1/auth/login",
        "login_body": {"username": "{user}", "password": "{password}"},
        "token_field": "token",
        "token_header": "Authorization",
        "token_prefix": "Bearer ",
        "cameras_path": "/api/v1/cameras",
        "cameras_list_field": "",            # "" = response is the list
        "id_field": "id",
        "name_field": "name",
        "lat_field": "location.lat",
        "lon_field": "location.lon",
        "online_field": "status",
        "online_value": "online",
        "stream_path": "/api/v1/cameras/{id}/live?profile={profile}",
        "stream_url_field": "rtsp_url",
        "profiles": {"main": "main", "sub": "sub"},
        "stream_needs_credentials": False,   # true if returned RTSP URL has no auth embedded
        # Alternatives for simpler portals (e.g. a MediaMTX-based catalogue):
        #   login_path: ""            -> no login call; send api_key_header: api_key_value instead
        #   stream_template: "rtsp://host:8554/stream/{id}"  -> build the URL from the catalogue id,
        #                              no per-camera request ({id}, {profile} and any catalogue field allowed)
        "api_key_header": "",
        "api_key_value": "",
        "login_mode": "json",                # json | form (OAuth2 password grant, e.g. Milestone API Gateway)
        # Cookie-session portals (the API is only served to a signed-in browser session): set token_field: ""
        # -> the login reply's cookies are kept and sent with every call; hidden inputs on login_page
        # (CSRF tokens) are copied into the form automatically.
        "login_page": "",                    # e.g. /auth/login (GET) when the form carries hidden fields
    }

    def __init__(self, cfg: dict):
        super().__init__(cfg)
        self.base = cfg["base_url"].rstrip("/")
        self.api = {**self.DEFAULT_API, **(cfg.get("api") or {})}
        self.user = os.environ.get(cfg.get("username_env", ""), cfg.get("username", ""))
        self.password = os.environ.get(cfg.get("password_env", ""), cfg.get("password", ""))
        self.http = ReadOnlyHTTP(allowed_posts={self.api["login_path"].split("?")[0]} if self.api["login_path"] else set(),
                                 verify=cfg.get("tls_verify", True))
        self._token: str | None = None
        self._token_at = 0.0

    def _subst(self, v: str) -> str:
        import base64
        basic = base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
        return v.format(user=self.user, password=self.password, basic=basic, host=self.host_only)

    @property
    def host_only(self) -> str:
        from urllib.parse import urlsplit
        return urlsplit(self.base).hostname or ""

    def _headers(self) -> dict:
        if not self.api["login_path"]:                       # API-key / basic / no-auth portal
            key = self._subst(self.api["api_key_value"])
            return {self.api["api_key_header"]: key} if self.api["api_key_header"] else {}
        if not self._token or time.time() - self._token_at > 600:
            body = {k: self._subst(v) if isinstance(v, str) else v for k, v in self.api["login_body"].items()}
            if self.api.get("login_page"):
                import re
                page = self.http.get(self.base + self.api["login_page"]).text
                for m in re.finditer(r'<input[^>]+type=["\']hidden["\'][^>]*>', page):
                    n = re.search(r'name=["\']([^"\']+)', m.group(0))
                    v = re.search(r'value=["\']([^"\']*)', m.group(0))
                    if n and n.group(1) not in body:
                        body[n.group(1)] = v.group(1) if v else ""
            if self.api.get("login_mode") == "form":
                r = self.http.post(self.base + self.api["login_path"], data=body)
            else:
                r = self.http.post(self.base + self.api["login_path"], json=body)
            r.raise_for_status()
            if not self.api["token_field"]:                  # cookie session: nothing to extract
                self._token = "cookie"
            else:
                self._token = _dig(r.json(), self.api["token_field"])
            self._token_at = time.time()
        if not self.api["token_field"]:
            return {}
        return {self.api["token_header"]: self.api["token_prefix"] + str(self._token)}

    def list_cameras(self) -> list[CameraInfo]:
        a = self.api
        r = self.http.get(self.base + a["cameras_path"], headers=self._headers())
        if a["login_path"] and (r.status_code in (401, 403) or "json" not in r.headers.get("content-type", "")):
            self._token = None                               # session expired: sign in again once
            r = self.http.get(self.base + a["cameras_path"], headers=self._headers())
        r.raise_for_status()
        if "session per ip" in r.text.lower():
            raise RuntimeError("gateway allows one session per IP and another client holds it (portal tab open?)")
        data = r.json()
        items = _dig(data, a["cameras_list_field"]) if a["cameras_list_field"] else data
        cams = []
        for it in items or []:
            cid = str(_dig(it, a["id_field"]))
            if not self.included(cid):
                continue
            profiles = {}
            for key, vendor_profile in a["profiles"].items():
                if a.get("stream_template"):                 # URL derived from the catalogue entry
                    fields = {k: v for k, v in it.items() if isinstance(v, (str, int, float))}
                    url = a["stream_template"].format(**{**fields, "id": cid, "profile": vendor_profile, "host": self.host_only})
                    sj = it
                elif a.get("stream_url_field") and _dig(it, a["stream_url_field"]) and not a.get("stream_path"):
                    url, sj = _dig(it, a["stream_url_field"]), it   # catalogue already carries the URL
                else:
                    sr = self.http.get(self.base + a["stream_path"].format(id=cid, profile=vendor_profile),
                                       headers=self._headers())
                    sr.raise_for_status()
                    sj = sr.json()
                    url = _dig(sj, a["stream_url_field"])
                if a["stream_needs_credentials"]:
                    url = with_credentials(url, self.user, self.password)
                profiles[key] = StreamProfile(url, sj.get("width"), sj.get("height"), sj.get("codec"))
            online = str(_dig(it, a["online_field"], a["online_value"])) == str(a["online_value"])
            cams.append(CameraInfo(native_id=cid, name=str(_dig(it, a["name_field"], cid)),
                                   lat=_dig(it, a["lat_field"]), lon=_dig(it, a["lon_field"]),
                                   profiles=profiles, online=online))
        return self.apply_overrides(cams)

    def ping(self) -> tuple[bool, str]:
        try:
            r = self.http.get(self.base + self.api["cameras_path"], headers=self._headers())
            r.raise_for_status()
            return True, "VMS API reachable"
        except Exception as e:  # noqa: BLE001
            self._token = None
            return False, str(e)[:300]
