"""Hotlist synchronisation: pulls external stolen / wanted vehicle lists (CSV, JSON, Vahan-style
feeds) into the watchlist on a schedule. Entries carry `source:<name>` in their reason so they can
be removed when the source drops them; manually added watchlist entries are never touched."""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
import logging
import os
import time
from pathlib import Path

import requests
from sqlalchemy import select

from ..config import load_yaml, settings
from ..db import SessionLocal, WatchlistEntry, init_db, utcnow
from ..plates import correct, normalise

log = logging.getLogger("uvp.hotlist")
_STATE: dict[str, dict] = {}


def _state_file() -> Path:
    return settings.data_dir / "hotlist_state.json"


def _save_state() -> None:
    try:
        _state_file().parent.mkdir(parents=True, exist_ok=True)
        _state_file().write_text(json.dumps(_STATE, indent=1))
    except OSError:
        pass


def _load_state() -> dict:
    try:
        return json.loads(_state_file().read_text())
    except (OSError, ValueError):
        return {}


def _fetch(src: dict) -> list[dict]:
    url = src["url"]
    headers = {}
    if src.get("auth_header") and src.get("auth_env"):
        headers[src["auth_header"]] = os.environ.get(src["auth_env"], "")
    if url.startswith("http"):
        r = requests.get(url, headers=headers, timeout=30)
        r.raise_for_status()
        text = r.text
    else:
        text = Path(url).read_text()
    if src["kind"] == "csv":
        rows = list(csv.DictReader(io.StringIO(text)))
    else:
        data = json.loads(text)
        for part in (src.get("json_path") or "vehicles").split("."):
            data = data.get(part, []) if isinstance(data, dict) else data
        rows = data or []
    f = src.get("fields") or {}
    out = []
    for r in rows:
        plate = r.get(f.get("plate", "plate"), "")
        if not plate:
            continue
        out.append({"plate": correct(normalise(str(plate))).plate, "reason": str(r.get(f.get("reason", "reason"), "") or ""),
                    "priority": str(r.get(f.get("priority", "priority"), "") or src.get("default_priority", "high")),
                    "expires": r.get(f.get("expires", "expires"))})
    return out


def sync_source(src: dict) -> dict:
    name = src["name"]
    rows = _fetch(src)
    tag = f"source:{name}"
    now = utcnow()
    added = updated = removed = 0
    with SessionLocal() as s:
        existing = {w.plate: w for w in s.scalars(select(WatchlistEntry)) if tag in (w.reason or "")}
        seen = set()
        for r in rows:
            p = r["plate"]
            if len(p) < 6:
                continue
            seen.add(p)
            exp = None
            if r.get("expires"):
                try:
                    exp = dt.datetime.fromisoformat(str(r["expires"]))
                    exp = exp if exp.tzinfo else exp.replace(tzinfo=dt.timezone.utc)
                except ValueError:
                    exp = None
            exp = exp or now + dt.timedelta(days=int(src.get("default_days", 30)))
            reason = f"{r['reason']} [{tag}]".strip()
            w = s.get(WatchlistEntry, p)
            if w is None:
                s.add(WatchlistEntry(plate=p, reason=reason, priority=r["priority"], added_by=f"hotlist:{name}", added_at=now, expires_at=exp))
                added += 1
            elif tag in (w.reason or ""):
                if (w.reason, w.priority) != (reason, r["priority"]):
                    w.reason, w.priority, w.expires_at = reason, r["priority"], exp
                    updated += 1
            # a manual entry for the same plate is left alone
        for p, w in existing.items():
            if p not in seen:
                s.delete(w)
                removed += 1
        s.commit()
    res = {"source": name, "entries": len(rows), "added": added, "updated": updated, "removed": removed, "at": now.isoformat()}
    _STATE[name] = {**res, "ok": True}
    _save_state()
    log.info("hotlist %s: %s", name, res)
    return res


def sync_all() -> dict:
    cfg = load_yaml(settings.hotlists_file) or {}
    out = {}
    for src in cfg.get("sources") or []:
        try:
            out[src["name"]] = sync_source(src)
        except Exception as e:  # noqa: BLE001
            _STATE[src["name"]] = {"source": src["name"], "ok": False, "error": str(e)[:300], "at": utcnow().isoformat()}
            out[src["name"]] = _STATE[src["name"]]
            _save_state()
            log.warning("hotlist %s failed: %s", src["name"], e)
    return out


def status() -> dict:
    cfg = load_yaml(settings.hotlists_file) or {}
    state = {**_load_state(), **_STATE}     # the sync service runs in its own process; read what it wrote
    return {"sources": [{"name": s["name"], "kind": s["kind"], "url": s["url"], "interval_minutes": s.get("interval_minutes", 15),
                         "last": state.get(s["name"])} for s in cfg.get("sources") or []]}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    init_db()
    from .. import metrics as M
    M.serve()                                   # /metrics on METRICS_PORT doubles as the liveness probe
    nxt: dict[str, float] = {}
    while True:
        cfg = load_yaml(settings.hotlists_file) or {}
        for src in cfg.get("sources") or []:
            if time.time() >= nxt.get(src["name"], 0):
                try:
                    sync_source(src)
                except Exception as e:  # noqa: BLE001
                    _STATE[src["name"]] = {"source": src["name"], "ok": False, "error": str(e)[:300], "at": utcnow().isoformat()}
                    _save_state()
                    log.warning("hotlist %s failed: %s", src["name"], e)
                nxt[src["name"]] = time.time() + 60 * float(src.get("interval_minutes", 15))
        time.sleep(30)


if __name__ == "__main__":
    main()
