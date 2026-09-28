"""Outbound integrations: notification channels (email, SMS, WhatsApp, CAD/112 webhook) with routing
rules from config/notify.yaml, and subscriber webhooks (signed JSON) from the webhooks table.

Everything is queued and delivered by a background thread with retries; every attempt is logged in the
notifications table so a control room can prove what was sent when.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import logging
import queue
import smtplib
import threading
import time
from email.message import EmailMessage

import requests
from sqlalchemy import select

from .config import load_yaml, settings
from . import metrics as M
from .db import Notification, SessionLocal, Webhook, utcnow

log = logging.getLogger("uvp.notify")
_q: "queue.Queue[tuple[str, dict]]" = queue.Queue()
_started = False
_lock = threading.Lock()


def cfg() -> dict:
    return load_yaml(settings.notify_file) or {}


# ----------------------------------------------------------------------------- channels
def _send_email(ch: dict, to: str, subject: str, body: str) -> str:
    msg = EmailMessage()
    msg["From"] = ch.get("from", "cctv@example.gov.in")
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    host, port = ch.get("host", "localhost"), int(ch.get("port", 587))
    if ch.get("tls", True) and port != 25:
        with smtplib.SMTP(host, port, timeout=15) as s:
            s.starttls()
            if ch.get("user"):
                s.login(ch["user"], ch.get("password", ""))
            s.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=15) as s:
            if ch.get("user"):
                s.login(ch["user"], ch.get("password", ""))
            s.send_message(msg)
    return "sent"


def _send_http_template(ch: dict, to: str, text: str) -> str:
    """Generic HTTP gateway (SMS / WhatsApp): url, method, headers, body template with {to} and {text}."""
    body = json.loads(json.dumps(ch.get("body", {"to": "{to}", "text": "{text}"})).replace("{to}", to).replace("{text}", json.dumps(text)[1:-1]))
    r = requests.request(ch.get("method", "POST"), ch["url"], json=body, headers=ch.get("headers") or {}, timeout=15)
    if not r.ok:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    return r.text[:200]


def _send_webhook(ch: dict, payload: dict) -> str:
    body = json.dumps(payload, sort_keys=True, default=str).encode()
    headers = {"Content-Type": "application/json", **(ch.get("headers") or {})}
    if ch.get("secret"):
        headers["X-UVP-Signature"] = hmac.new(ch["secret"].encode(), body, hashlib.sha256).hexdigest()
    r = requests.post(ch["url"], data=body, headers=headers, timeout=15)
    if not r.ok:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    return r.text[:200]


# ----------------------------------------------------------------------------- routing
def _matches(rule: dict, kind: str, payload: dict) -> bool:
    if rule.get("kind") not in (None, "*", kind):
        return False
    pr = rule.get("priority")
    if pr and payload.get("priority") not in (pr if isinstance(pr, list) else [pr]):
        return False
    dp = rule.get("departments")
    if dp and payload.get("department") not in dp and "*" not in dp:
        return False
    sub = rule.get("subkind")       # e.g. alert match=rule / watchlist, incident kind
    if sub and payload.get("match") != sub and payload.get("kind") != sub and payload.get("watchlist_plate") != sub:
        return False
    return True


def render(kind: str, payload: dict) -> tuple[str, str]:
    p = payload
    ist = dt.timezone(dt.timedelta(minutes=330))
    try:
        when = dt.datetime.fromisoformat(p.get("ts")).astimezone(ist).strftime("%d %b %H:%M:%S")
    except Exception:  # noqa: BLE001
        when = ""
    if kind == "alert":
        head = f"[CCTV] {p.get('watchlist_plate', 'ALERT')} {p.get('plate', '')} at {p.get('camera_id', '')}"
        return head[:120], f"{p.get('reason', '')}\nCamera {p.get('camera_id')} ({p.get('department')}) at {when} IST. Priority {p.get('priority')}."
    if kind == "incident":
        return f"[CCTV] {p.get('label', p.get('kind'))} at {p.get('camera_id')}"[:120], f"Zone {p.get('zone', '-')}, {when} IST, {json.dumps(p.get('detail') or {})}"
    if kind == "camera.health":
        return f"[CCTV] Camera {p.get('camera_id')} {p.get('status')}"[:120], f"{p.get('detail', '')} at {when} IST"
    if kind == "break_glass":
        return f"[CCTV] Break-glass by {p.get('user')}"[:120], f"{p.get('reason', '')} until {p.get('until', '')}"
    return f"[CCTV] {kind}"[:120], json.dumps(p, default=str)[:1000]


def notify(kind: str, payload: dict) -> None:
    """Queue notifications and webhook deliveries for one event. Non-blocking."""
    _ensure_worker()
    _q.put((kind, payload))


def _ensure_worker() -> None:
    global _started
    with _lock:
        if not _started:
            threading.Thread(target=_worker, daemon=True, name="uvp-notify").start()
            _started = True


def _worker() -> None:
    while True:
        kind, payload = _q.get()
        try:
            _route(kind, payload)
        except Exception:  # noqa: BLE001
            log.exception("notification routing failed")
        try:
            _webhooks(kind, payload)
        except Exception:  # noqa: BLE001
            log.exception("webhook delivery failed")


def _route(kind: str, payload: dict) -> None:
    c = cfg()
    channels = c.get("channels") or {}
    for rule in c.get("routes") or []:
        if not _matches(rule, kind, payload):
            continue
        ch = channels.get(rule.get("channel"))
        if not ch or not ch.get("enabled", True):
            continue
        subject, body = render(kind, payload)
        for to in rule.get("to") or [""]:
            _deliver(ch, rule.get("channel"), to, kind, payload, subject, body)


def _deliver(ch: dict, name: str, to: str, kind: str, payload: dict, subject: str, body: str) -> None:
    with SessionLocal() as s:
        n = Notification(channel=ch.get("type", name), recipient=to or ch.get("url", ""), kind=kind, ref_id=str(payload.get("id", "")),
                         subject=subject)
        s.add(n)
        s.commit()
        nid = n.id
    for attempt in range(3):
        try:
            t = ch.get("type")
            if t == "email":
                res = _send_email(ch, to, subject, body)
            elif t in ("sms", "whatsapp", "http"):
                res = _send_http_template(ch, to, f"{subject}\n{body}")
            elif t == "webhook":
                res = _send_webhook(ch, {"kind": kind, "subject": subject, "text": body, "event": payload})
            else:
                raise RuntimeError(f"unknown channel type {t}")
            with SessionLocal() as s:
                n = s.get(Notification, nid)
                n.status, n.detail, n.attempts = "sent", res[:500], attempt + 1
                s.commit()
            M.NOTIFICATIONS.labels(ch.get("type", name), "sent").inc()
            return
        except Exception as e:  # noqa: BLE001
            err = str(e)[:500]
            with SessionLocal() as s:
                n = s.get(Notification, nid)
                n.status, n.detail, n.attempts = "failed", err, attempt + 1
                s.commit()
            time.sleep(2 * (attempt + 1))
    M.NOTIFICATIONS.labels(ch.get("type", name), "failed").inc()
    log.warning("notification %s via %s failed: %s", kind, name, err)


def _webhooks(kind: str, payload: dict) -> None:
    with SessionLocal() as s:
        hooks = [w for w in s.scalars(select(Webhook).where(Webhook.active.is_(True)))
                 if kind in (w.kinds or []) and ("*" in (w.departments or ["*"]) or payload.get("department") in (w.departments or []))]
        hooks = [(w.id, w.url, w.secret) for w in hooks]
    for wid, url, secret in hooks:
        body = json.dumps({"kind": kind, "sent_at": utcnow().isoformat(), "data": payload}, sort_keys=True, default=str).encode()
        headers = {"Content-Type": "application/json", "X-UVP-Kind": kind}
        if secret:
            headers["X-UVP-Signature"] = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        status = ""
        for attempt in range(3):
            try:
                r = requests.post(url, data=body, headers=headers, timeout=10)
                status = f"HTTP {r.status_code}"
                if r.ok:
                    break
            except requests.RequestException as e:
                status = str(e)[:150]
            time.sleep(1 + attempt)
        M.WEBHOOK_DELIVERIES.labels("ok" if status.startswith("HTTP 2") else "failed").inc()
        with SessionLocal() as s:
            w = s.get(Webhook, wid)
            if w:
                w.last_status, w.last_delivery = status[:200], utcnow()
                w.failures = 0 if status.startswith("HTTP 2") else w.failures + 1
                if w.failures >= 50:
                    w.active = False       # stop hammering a dead endpoint; admin re-enables
                s.commit()


def deliver_now(kind: str, payload: dict) -> None:
    """Synchronous variant for tests and CLI checks."""
    _route(kind, payload)
    _webhooks(kind, payload)
