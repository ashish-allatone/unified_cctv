"""Static RTSP adapter: for NVRs/VMS that publish fixed RTSP URLs and nothing else.

Camera list comes from sources.yaml. Health is an RTSP OPTIONS probe to
each distinct host (a read-only request that opens no media session).
"""
from __future__ import annotations

import os
import socket
from urllib.parse import urlsplit

from .base import Adapter, CameraInfo, StreamProfile, with_credentials


def rtsp_options(url: str, timeout: float = 4.0) -> bool:
    u = urlsplit(url)
    with socket.create_connection((u.hostname, u.port or 554), timeout=timeout) as s:
        req = f"OPTIONS rtsp://{u.hostname}:{u.port or 554}{u.path or '/'} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: uvp\r\n\r\n"
        s.sendall(req.encode())
        return s.recv(64).startswith(b"RTSP/1.0")


class RtspAdapter(Adapter):
    kind = "rtsp"

    def __init__(self, cfg: dict):
        super().__init__(cfg)
        self.user = os.environ.get(cfg.get("username_env", ""), cfg.get("username", ""))
        self.password = os.environ.get(cfg.get("password_env", ""), cfg.get("password", ""))

    def list_cameras(self) -> list[CameraInfo]:
        cams = []
        for c in self.cfg.get("streams", []):
            profiles = {}
            for key in ("main", "sub"):
                if c.get(key):
                    profiles[key] = StreamProfile(with_credentials(c[key], self.user, self.password))
            if "sub" not in profiles and "main" in profiles:
                profiles["sub"] = profiles["main"]
            cams.append(CameraInfo(native_id=c["id"], name=c.get("name", c["id"]), lat=c.get("lat"),
                                   lon=c.get("lon"), profiles=profiles))
        return self.apply_overrides(cams)

    def health(self) -> tuple[bool, str]:
        hosts = {}
        for c in self.cfg.get("streams", []):
            u = urlsplit(c.get("main") or c.get("sub"))
            hosts[(u.hostname, u.port or 554)] = c.get("main") or c.get("sub")
        bad = []
        for (h, p), url in hosts.items():
            try:
                if not rtsp_options(url):
                    bad.append(f"{h}:{p}")
            except OSError as e:
                bad.append(f"{h}:{p} ({e})")
        return (not bad), ("ok" if not bad else "unreachable: " + ", ".join(bad))
