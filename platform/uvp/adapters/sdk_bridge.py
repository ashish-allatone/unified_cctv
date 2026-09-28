"""Template for VMS that only offer a native SDK (no RTSP/ONVIF/REST).

Pattern: a small bridge process links the vendor SDK, logs in with a viewer
account, opens live view for a channel, and republishes the elementary H.264
stream to the platform relay as RTSP (e.g. `ffmpeg -f h264 -i pipe: -c copy
-f rtsp rtsp://relay:8554/<camera>/main`). The bridge must call only the
SDK's login, device-list and live-view functions; the allowlist below is
checked in code review and at runtime by `guard()`.

The adapter itself just reads the camera list the bridge exposes.
"""
from __future__ import annotations

from .base import Adapter, CameraInfo, StreamProfile, WriteAttemptBlocked

SDK_READ_ONLY_CALLS = {
    "Login", "Logout", "GetDeviceConfig.ChannelList", "RealPlay", "StopRealPlay", "GetDeviceStatus",
}


def guard(call_name: str) -> None:
    if call_name not in SDK_READ_ONLY_CALLS:
        raise WriteAttemptBlocked(f"SDK call {call_name} is not on the read-only allowlist")


class SdkBridgeAdapter(Adapter):
    kind = "sdk_bridge"

    def list_cameras(self) -> list[CameraInfo]:
        relay = self.cfg.get("bridge_rtsp_base", "rtsp://sdk-bridge:8554")
        cams = []
        for c in self.cfg.get("channels", []):
            cams.append(CameraInfo(
                native_id=c["id"], name=c.get("name", c["id"]),
                profiles={"main": StreamProfile(f"{relay}/{c['id']}/main"),
                          "sub": StreamProfile(f"{relay}/{c['id']}/sub")}))
        return self.apply_overrides(cams)
