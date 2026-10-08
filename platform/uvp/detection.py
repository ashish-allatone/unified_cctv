"""The detection switch: AI detection (ANPR, counting / crowd, faces) runs only while it is ON.

State lives in the settings table (key "detection"): {"enabled": bool, "cameras": {camera_id: bool}} - per-camera
values override the global switch. Workers call allows(camera_id) before every frame; the value is refreshed
from the database every few seconds so a press in the console takes effect within ~5 s on every worker.
"""
from __future__ import annotations

import time

from .config import settings
from .db import SessionLocal, get_setting, set_setting

KEY = "detection"
_cache: dict = {"at": 0.0, "state": None}


def default_state() -> dict:
    return {"enabled": settings.detection_default, "cameras": {}}


def state(max_age: float = 5.0) -> dict:
    """Current switch state (cached max_age seconds). With DETECTION_LOCKED (default) detection is always on."""
    if settings.detection_locked:
        return {"enabled": True, "cameras": {}, "locked": True}
    now = time.time()
    if _cache["state"] is None or now - _cache["at"] > max_age:
        try:
            with SessionLocal() as s:
                _cache["state"] = get_setting(s, KEY, default_state()) or default_state()
        except Exception:  # noqa: BLE001
            _cache["state"] = _cache["state"] or default_state()
        _cache["at"] = now
    return _cache["state"]


def allows(camera_id: str) -> bool:
    if settings.detection_locked:
        return True
    st = state()
    per = st.get("cameras") or {}
    if camera_id in per:
        return bool(per[camera_id])
    return bool(st.get("enabled", True))


def update(user: str, enabled: bool | None = None, camera_id: str | None = None, on: bool | None = None, clear_cameras: bool = False) -> dict:
    if settings.detection_locked:
        raise PermissionError("AI detection is locked on for this deployment (DETECTION_LOCKED=1)")
    with SessionLocal() as s:
        st = get_setting(s, KEY, default_state()) or default_state()
        if enabled is not None:
            st["enabled"] = bool(enabled)
        if clear_cameras:
            st["cameras"] = {}
        if camera_id:
            cams = dict(st.get("cameras") or {})
            if on is None:
                cams.pop(camera_id, None)          # back to the global switch
            else:
                cams[camera_id] = bool(on)
            st["cameras"] = cams
        set_setting(s, KEY, st, user)
        s.commit()
    _cache["state"], _cache["at"] = st, time.time()
    return st
