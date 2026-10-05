from __future__ import annotations

from .base import Adapter
from .onvif import OnvifAdapter
from .rtsp import RtspAdapter
from .rtsp_template import RtspTemplateAdapter
from .push import PushAdapter
from .sdk_bridge import SdkBridgeAdapter
from .vendor_rest import VendorRestAdapter

ADAPTERS: dict[str, type[Adapter]] = {
    "onvif": OnvifAdapter,
    "vendor_rest": VendorRestAdapter,
    "rtsp": RtspAdapter,
    "rtsp_template": RtspTemplateAdapter,
    "push": PushAdapter,
    "sdk_bridge": SdkBridgeAdapter,
}


def presets() -> dict:
    from ..config import load_yaml, settings
    raw = (load_yaml(settings.vendors_file) or {}).get("presets") or {}
    out: dict = {}
    for name, p in raw.items():
        base = dict(raw.get(p.get("extends"), {})) if p.get("extends") else {}
        out[name] = {**base, **{k: v for k, v in p.items() if k != "extends"}}
    return out


def resolve(cfg: dict) -> dict:
    """Merge a vendor preset (`vendor: hikvision`) under the source's own keys."""
    v = cfg.get("vendor")
    if not v:
        return cfg
    p = presets().get(v)
    if not p:
        raise ValueError(f"unknown vendor preset '{v}' (config/vendors.yaml)")
    merged = {k: val for k, val in p.items() if k != "notes"}
    if "api" in p and "api" in cfg:
        merged["api"] = {**p["api"], **cfg["api"]}
    merged.update({k: val for k, val in cfg.items() if k != "api" or "api" not in p})
    return merged


def build(cfg: dict) -> Adapter:
    cfg = resolve(cfg)
    try:
        return ADAPTERS[cfg["adapter"]](cfg)
    except KeyError as e:
        raise ValueError(f"unknown adapter '{cfg.get('adapter')}' for source {cfg.get('id')}") from e
