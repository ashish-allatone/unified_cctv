"""External government / third-party lookup APIs configured from the console (Admin -> External APIs):

  vahan    vehicle registration (owner, make, class, fitness ...) by plate
  sarathi  driving licence (holder, validity, class) by DL number
  custom   any other GET/POST JSON API with one `{value}` placeholder

Each integration row is stored in the `settings` table (key `integration:<name>`) with the API key / password
encrypted (Fernet, TOKEN_SECRET), so nothing has to be put in `.env` or a yaml file to switch a connector on.
`VAHAN_URL` / `VAHAN_HEADERS` from the environment are still honoured as a fallback when nothing was saved
in the console. Every lookup is audited by the caller and cached for an hour.
"""
from __future__ import annotations

import json
import logging
import threading
import time

import requests

from .config import settings
from .db import SessionLocal, get_setting, set_setting, utcnow

log = logging.getLogger("uvp.integrations")

KINDS: dict[str, dict] = {
    "vahan": {"label": "Vahan - vehicle registration", "placeholder": "{plate}", "sample": "GJ01AB1234",
              "help": "NIC Vahan / state transport API. URL must contain {plate}; the key goes in the header you name."},
    "sarathi": {"label": "Sarathi - driving licence", "placeholder": "{dl}", "sample": "GJ0120200012345",
                "help": "NIC Sarathi / state RTO API. URL must contain {dl} (licence number without spaces)."},
    "custom": {"label": "Custom lookup", "placeholder": "{value}", "sample": "", "help": "Any JSON API with {value} in the URL or body."},
}
AUTH_TYPES = ("none", "header", "bearer", "basic", "query")
_cache: dict[tuple[str, str], tuple[float, dict]] = {}
_lock = threading.Lock()


def _fernet():
    from .services.devices import _fernet as f
    return f()


def _enc(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode() if secret else ""


def _dec(blob: str) -> str:
    if not blob:
        return ""
    try:
        return _fernet().decrypt(blob.encode()).decode()
    except Exception:  # noqa: BLE001
        return ""


def defaults(name: str) -> dict:
    k = KINDS.get(name, KINDS["custom"])
    return {"name": name, "label": k["label"], "enabled": False, "url": "", "method": "GET", "auth": "header", "header_name": "X-API-Key",
            "username": "", "extra_headers": {}, "body": "", "timeout_s": 15, "cache_s": 3600, "notes": "", "updated_by": "", "updated_at": None,
            "last_test": None, "has_secret": False, "placeholder": k["placeholder"], "sample": k["sample"], "help": k["help"]}


def load(name: str, with_secret: bool = False) -> dict:
    """The saved configuration (secret masked unless with_secret). Falls back to VAHAN_URL / VAHAN_HEADERS for vahan."""
    with SessionLocal() as s:
        st = get_setting(s, f"integration:{name}", {})
    d = defaults(name)
    if st:
        d.update({k: v for k, v in st.items() if k in d or k == "secret_enc"})
        d["has_secret"] = bool(st.get("secret_enc"))
        d["source"] = "console"
    elif name == "vahan" and settings.vahan_url:
        hdrs = {}
        try:
            hdrs = json.loads(settings.vahan_headers) if settings.vahan_headers else {}
        except ValueError:
            pass
        d.update(enabled=True, url=settings.vahan_url, auth="none", extra_headers=hdrs, source="env")
    else:
        d["source"] = "none"
    if with_secret:
        d["secret"] = _dec(st.get("secret_enc", "")) if st else ""
    d.pop("secret_enc", None)
    return d


def save(name: str, body: dict, actor: str) -> dict:
    """Validate + store. `secret` blank keeps the old secret; `clear_secret` removes it. Raises ValueError."""
    if name not in KINDS:
        raise ValueError(f"unknown integration {name!r}; one of {', '.join(KINDS)}")
    with SessionLocal() as s:
        cur = get_setting(s, f"integration:{name}", {})
        ph = KINDS[name]["placeholder"]
        url = str(body.get("url") or "").strip()
        if body.get("enabled") and not url:
            raise ValueError("URL is required to enable the integration")
        if url and not url.startswith(("http://", "https://")):
            raise ValueError("URL must start with http:// or https://")
        method = str(body.get("method") or "GET").upper()
        if method not in ("GET", "POST"):
            raise ValueError("method must be GET or POST")
        if url and ph not in url and ph not in str(body.get("body") or ""):
            raise ValueError(f"the URL (or POST body) must contain the placeholder {ph}")
        auth = str(body.get("auth") or "header")
        if auth not in AUTH_TYPES:
            raise ValueError(f"auth must be one of {', '.join(AUTH_TYPES)}")
        extra = body.get("extra_headers") or {}
        if isinstance(extra, str):
            try:
                extra = json.loads(extra) if extra.strip() else {}
            except ValueError:
                raise ValueError("extra headers must be JSON, e.g. {\"Accept\": \"application/json\"}")
        if not isinstance(extra, dict):
            raise ValueError("extra headers must be a JSON object")
        secret_enc = cur.get("secret_enc", "")
        if body.get("clear_secret"):
            secret_enc = ""
        elif body.get("secret"):
            secret_enc = _enc(str(body["secret"]))
        if auth != "none" and not secret_enc and body.get("enabled"):
            raise ValueError("an API key / password is needed for this auth type (or choose auth 'none')")
        row = {"enabled": bool(body.get("enabled")), "url": url, "method": method, "auth": auth,
               "header_name": str(body.get("header_name") or "X-API-Key")[:64], "username": str(body.get("username") or "")[:120],
               "extra_headers": {str(k)[:64]: str(v)[:500] for k, v in extra.items()}, "body": str(body.get("body") or "")[:4000],
               "timeout_s": max(3, min(int(body.get("timeout_s") or 15), 60)), "cache_s": max(0, min(int(body.get("cache_s") or 3600), 86400)),
               "notes": str(body.get("notes") or "")[:500], "secret_enc": secret_enc, "updated_by": actor, "updated_at": utcnow().isoformat(),
               "last_test": cur.get("last_test")}
        set_setting(s, f"integration:{name}", row, actor)
        s.commit()
    with _lock:
        for k in [k for k in _cache if k[0] == name]:
            _cache.pop(k, None)
    return load(name)


def lookup(name: str, value: str, use_cache: bool = True) -> dict:
    """Call the integration for one value. Raises RuntimeError (not configured / HTTP error) with a user message."""
    cfg = load(name, with_secret=True)
    if not cfg.get("enabled") or not cfg.get("url"):
        raise RuntimeError(f"{KINDS.get(name, {}).get('label', name)} is not configured - Admin -> External APIs")
    value = str(value or "").strip()
    if not value:
        raise RuntimeError("nothing to look up")
    key = (name, value.upper())
    if use_cache and cfg.get("cache_s"):
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < cfg["cache_s"]:
            return {**hit[1], "cached": True}
    ph = cfg["placeholder"]
    url = cfg["url"].replace(ph, requests.utils.quote(value, safe=""))
    headers = {"Accept": "application/json", **cfg.get("extra_headers", {})}
    params: dict = {}
    auth = None
    secret = cfg.get("secret", "")
    if cfg["auth"] == "header":
        headers[cfg["header_name"] or "X-API-Key"] = secret
    elif cfg["auth"] == "bearer":
        headers["Authorization"] = f"Bearer {secret}"
    elif cfg["auth"] == "basic":
        auth = (cfg.get("username", ""), secret)
    elif cfg["auth"] == "query":
        params[cfg["header_name"] or "api_key"] = secret
    t0 = time.time()
    try:
        if cfg["method"] == "POST":
            body_txt = (cfg.get("body") or "{}").replace(ph, value)
            try:
                payload = json.loads(body_txt)
            except ValueError:
                payload = body_txt
            r = requests.post(url, json=payload if isinstance(payload, (dict, list)) else None, data=None if isinstance(payload, (dict, list)) else payload,
                              headers=headers, params=params, auth=auth, timeout=cfg["timeout_s"])
        else:
            r = requests.get(url, headers=headers, params=params, auth=auth, timeout=cfg["timeout_s"])
    except requests.RequestException as e:
        raise RuntimeError(f"{name} unreachable: {str(e)[:160]}")
    ms = int((time.time() - t0) * 1000)
    if not r.ok:
        raise RuntimeError(f"{name} answered HTTP {r.status_code}: {r.text[:200]}")
    try:
        data = r.json()
    except ValueError:
        data = {"raw": r.text[:2000]}
    out = {"integration": name, "value": value, "data": data, "ms": ms, "fetched_at": utcnow().isoformat()}
    with _lock:
        _cache[key] = (time.time(), out)
    return out


def record_test(name: str, ok: bool, detail: str) -> None:
    with SessionLocal() as s:
        st = dict(get_setting(s, f"integration:{name}", {}))
        if st:
            st["last_test"] = {"ok": ok, "detail": detail[:300], "at": utcnow().isoformat()}
            set_setting(s, f"integration:{name}", st, "test")
            s.commit()


def flatten(data, prefix: str = "", out: list | None = None, depth: int = 0) -> list[tuple[str, str]]:
    """Nested JSON -> [(label, value)] rows for the console."""
    out = out if out is not None else []
    if depth > 4:
        return out
    if isinstance(data, dict):
        for k, v in data.items():
            flatten(v, f"{prefix}{k}" if not prefix else f"{prefix} / {k}", out, depth + 1)
    elif isinstance(data, list):
        for i, v in enumerate(data[:20]):
            flatten(v, f"{prefix}[{i}]", out, depth + 1)
    else:
        out.append((prefix or "value", "" if data is None else str(data)))
    return out
