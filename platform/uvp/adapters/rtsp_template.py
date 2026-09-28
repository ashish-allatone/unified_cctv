"""RTSP-template adapter: NVRs/DVRs whose stream URLs follow a vendor pattern per channel
(Hikvision, Dahua/CP Plus, Uniview, Axis...). Configure `host`, `channels` (a count or a list of
{channel, id, name, lat, lon}) and the vendor preset supplies `main` / `sub` templates."""
from __future__ import annotations

from .base import CameraInfo, StreamProfile, with_credentials
from .rtsp import RtspAdapter


class RtspTemplateAdapter(RtspAdapter):
    kind = "rtsp_template"

    def __init__(self, cfg: dict):
        super().__init__(cfg)
        self.host = cfg["host"]
        self.rtsp_port = int(cfg.get("rtsp_port", 554))
        self.main_t = cfg["main"]
        self.sub_t = cfg.get("sub") or cfg["main"]
        chans = cfg.get("channels", 1)
        if isinstance(chans, int):
            chans = [{"channel": i + 1} for i in range(chans)]
        self.channels = chans
        # materialise into the `streams` shape the parent understands
        prefix = cfg.get("id_prefix_native", cfg["id"])
        self.cfg["streams"] = []
        for c in self.channels:
            ch = c.get("channel", 1)
            cid = c.get("id", f"{prefix}-ch{ch}")
            # per-channel anpr / lat / lon / heading act like a `cameras:` override entry
            keys = ("anpr", "anpr_roi", "anpr_upscale", "anpr_fps", "lat", "lon", "heading", "fov", "range_m")
            if any(k in c for k in keys):
                self.overrides.setdefault(cid, {}).update({k: c[k] for k in keys if k in c})
            fmt = {"host": self.host, "rtsp_port": self.rtsp_port, "channel": ch}
            self.cfg["streams"].append({"id": cid, "name": c.get("name", f"Channel {ch}"), "lat": c.get("lat"), "lon": c.get("lon"),
                                        "main": self.main_t.format(**fmt), "sub": self.sub_t.format(**fmt)})

    def list_cameras(self) -> list[CameraInfo]:
        return super().list_cameras()
