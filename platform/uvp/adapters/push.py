"""Push source: cameras whose streams are *sent to* the relay by a site connector (a small box at the client's
site that reads the DVR / NVR over its LAN and pushes over one outbound RTSP connection). No inbound port on the
site's router, no vendor P2P cloud. The relay path is configured with `source: publisher`; the connector
authenticates with the source's publish key (checked by /internal/relay-auth).

sources.yaml:
  - id: junagadh-dvr
    adapter: push
    department: Police
    name: Junagadh CP Plus DVR (site connector)
    publish_key_env: SITE_KEY_JUNAGADH        # or publish_key (console devices store it encrypted)
    cameras:
      ch1: {name: "Gate", anpr: true, lat: 21.52, lon: 70.46}
      ch2: {name: "Parking"}
"""
from __future__ import annotations

import os

from .base import Adapter, CameraInfo, StreamProfile

PUBLISHER = "publisher"


class PushAdapter(Adapter):
    kind = "push"

    def publish_key(self) -> str:
        return os.environ.get(self.cfg.get("publish_key_env", ""), self.cfg.get("publish_key", "")) or ""

    def list_cameras(self) -> list[CameraInfo]:
        cams = []
        cameras = self.cfg.get("cameras") or {}
        if isinstance(cameras, list):
            cameras = {c.get("id") or f"ch{i + 1}": c for i, c in enumerate(cameras)}
        for cid, c in cameras.items():
            c = c or {}
            cams.append(CameraInfo(native_id=cid, name=c.get("name", cid), lat=c.get("lat"), lon=c.get("lon"),
                                   profiles={"main": StreamProfile(PUBLISHER), "sub": StreamProfile(PUBLISHER)},
                                   heading=c.get("heading"), fov=c.get("fov"), range_m=c.get("range_m")))
        return cams

    def health(self) -> tuple[bool, str]:
        return True, f"{len(self.list_cameras())} cameras expected from the site connector"

    def ping(self) -> tuple[bool, str]:
        return self.health()
