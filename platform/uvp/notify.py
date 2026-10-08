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


def yaml_cfg() -> dict:
    return load_yaml(settings.notify_file) or {}


def cfg() -> dict:
    """notify.yaml merged with what was changed in the console (settings keys notify_channels / notify_routes).
    Channel credentials always come from the yaml / .env; the console only switches channels on or off and owns
    the routing table (who gets called / messaged for which event) once it has been edited there."""
    c = yaml_cfg()
    try:
        from .db import get_setting
        with SessionLocal() as s:
            chan_over = get_setting(s, "notify_channels", {})
            routes = get_setting(s, "notify_routes", {})
    except Exception:  # noqa: BLE001
        return c
    channels = dict(c.get("channels") or {})
    for name, ov in (chan_over or {}).items():
        if name in channels and isinstance(ov, dict) and "enabled" in ov:
            channels[name] = {**channels[name], "enabled": bool(ov["enabled"])}
    out = {**c, "channels": channels}
    if isinstance(routes, dict) and isinstance(routes.get("routes"), list):
        out["routes"] = [{k: v for k, v in r.items() if k != "id" and v not in (None, "", [])} for r in routes["routes"] if r.get("enabled", True)]
        out["routes_source"] = "console"
    else:
        out["routes_source"] = "yaml"
    return out


ROUTE_KINDS = ["alert", "incident", "camera.health", "break_glass", "challan", "report", "*"]


def routes_for_console(s) -> list[dict]:
    """The editable routing table: the console copy if it exists, else notify.yaml's routes with generated ids."""
    from .db import get_setting
    st = get_setting(s, "notify_routes", {})
    if isinstance(st, dict) and isinstance(st.get("routes"), list):
        return st["routes"]
    out = []
    for i, r in enumerate(yaml_cfg().get("routes") or []):
        to = r.get("to") or []
        out.append({"id": f"y{i + 1}", "kind": r.get("kind", "*"), "subkind": r.get("subkind", ""), "priority": r.get("priority", ""),
                    "departments": r.get("departments") or [], "channel": r.get("channel", ""), "to": to if isinstance(to, list) else [to], "enabled": True})
    return out


def save_routes_for_console(s, routes: list[dict], actor: str) -> list[dict]:
    """Validate and store the routing table. Raises ValueError with a user-facing message."""
    import re
    from .db import set_setting
    channels = yaml_cfg().get("channels") or {}
    clean = []
    for i, r in enumerate(routes):
        kind = str(r.get("kind") or "*")
        if kind not in ROUTE_KINDS:
            raise ValueError(f"route {i + 1}: unknown event kind {kind!r}")
        ch = str(r.get("channel") or "")
        if ch not in channels:
            raise ValueError(f"route {i + 1}: unknown channel {ch!r} (channels are defined in config/notify.yaml)")
        ctype = channels[ch].get("type")
        to_raw = r.get("to") or []
        if isinstance(to_raw, str):
            to_raw = re.split(r"[,;\n]+", to_raw)
        to = []
        for t in to_raw:
            t = str(t).strip()
            if not t:
                continue
            if ctype in ("sms", "whatsapp", "voice"):
                digits = "".join(c for c in t if c.isdigit())
                if len(digits) < 10:
                    raise ValueError(f"route {i + 1}: {t!r} is not a phone number")
                t = ("+" if t.startswith("+") else "") + digits
            elif ctype == "email" and "@" not in t:
                raise ValueError(f"route {i + 1}: {t!r} is not an email address")
            to.append(t)
        if ctype in ("sms", "whatsapp", "voice", "email") and not to:
            raise ValueError(f"route {i + 1}: {ch} needs at least one recipient")
        pr = r.get("priority") or ""
        if isinstance(pr, list):
            pr = [p for p in pr if p]
        clean.append({"id": str(r.get("id") or f"r{i + 1}")[:16], "kind": kind, "subkind": str(r.get("subkind") or "")[:32], "priority": pr,
                      "departments": [str(d) for d in (r.get("departments") or []) if d], "channel": ch, "to": to, "enabled": bool(r.get("enabled", True))})
    set_setting(s, "notify_routes", {"routes": clean}, actor)
    s.flush()
    return clean


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


# ----------------------------------------------------------------------------- voice call (BulkOBD outbound dialer)
def speak_text(kind: str, payload: dict) -> str:
    """What the automated call says: short, plain, plate spelt out digit by digit, no symbols the TTS would read aloud."""
    p = payload
    ist = dt.timezone(dt.timedelta(minutes=330))
    try:
        t = dt.datetime.fromisoformat(p.get("ts")).astimezone(ist)
        when = f"{t.hour} {t.minute:02d}"          # "14 05": a colon would be read as a field separator by the dialer
    except Exception:  # noqa: BLE001
        when = ""
    cam = p.get("camera_name") or ""
    if not cam and p.get("camera_id"):
        try:
            from .db import Camera
            with SessionLocal() as s:
                c = s.get(Camera, p["camera_id"])
                cam = c.name if c else p["camera_id"].replace("-", " ")
        except Exception:  # noqa: BLE001
            cam = p["camera_id"].replace("-", " ")
    cam = cam or "a camera"
    spell = lambda v: " ".join(str(v or "").upper())  # noqa: E731
    if kind == "alert":
        what = "challan suggested for" if p.get("match") == "rule" else "watch list vehicle"
        txt = f"Unified CCTV alert. {what} {spell(p.get('plate'))} seen at {cam} at {when}. {p.get('reason', '')}."
    elif kind == "incident":
        txt = f"Unified CCTV alert. {p.get('label') or p.get('kind', 'incident')} detected at {cam} at {when}. Priority {p.get('priority', '')}."
    elif kind == "camera.health":
        txt = f"Unified CCTV notice. Camera {cam} is {p.get('status', '')} since {when}."
    elif kind == "break_glass":
        txt = f"Unified CCTV security notice. Break glass access was used by {p.get('user', '')}."
    elif kind == "test":
        txt = "This is a test call from the Unified CCTV platform. The voice channel is working."
    else:
        txt = f"Unified CCTV notification. {p.get('subject') or kind}."
    # the dialer's record format uses , : < > as separators, so none of those may appear in spoken text
    for bad in ("<>", "<", ">", ",", ":", ";", '"', "{", "}", "|"):
        txt = txt.replace(bad, " ")
    return " ".join(txt.split())[:300]


def _tts_mp3(text: str, ch: dict, fmt: str | None = None) -> bytes | None:
    """Speak `text` with the local espeak-ng voice and return the clip bytes: WAV (8 kHz 16-bit mono, telephony) by
    default or MP3 (44.1 kHz 128k) with clip_format: mp3. Used when the dialer's own text-to-speech is unavailable
    ("local" TTS). None when espeak-ng / ffmpeg are missing."""
    import shutil
    import subprocess
    import tempfile
    if not shutil.which("espeak-ng") or not shutil.which("ffmpeg"):
        return None
    voice = str(ch.get("voice") or "en-us")
    speed = str(ch.get("speed") or 150)
    with tempfile.TemporaryDirectory() as d:
        wav, out = f"{d}/say.wav", f"{d}/say.out"
        fmt = str(fmt or ch.get("clip_format") or "wav").lower()
        try:
            subprocess.run(["espeak-ng", "-v", voice, "-s", speed, "-p", "45", "-a", "180", "-g", "6", "-w", wav, text], check=True, timeout=30, capture_output=True)
            if fmt == "mp3":
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ar", "44100", "-ac", "1", "-b:a", "128k", "-f", "mp3", out], check=True, timeout=30, capture_output=True)
            else:
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ar", "8000", "-ac", "1", "-acodec", "pcm_s16le", "-f", "wav", out], check=True, timeout=30, capture_output=True)
            return open(out, "rb").read()
        except Exception:  # noqa: BLE001
            log.exception("local TTS failed")
            return None


def _server_error_text(text: str) -> str:
    """Turn a Tomcat / Spring HTML error page into its one-line message ('HTTP Status 500 - ... Message ...')."""
    import html
    import re
    t = text or ""
    if "<html" not in t.lower():
        return " ".join(t.split())[:200]
    bits = []
    for key in ("message", "description", "exception"):
        m = re.search(rf"<b>\s*{key}\s*</b>\s*(?:<u>)?\s*(.*?)\s*(?:</u>)?\s*</p>", t, flags=re.I | re.S)
        if m and re.sub("<[^>]+>", "", m.group(1)).strip():
            bits.append(f"{key}: " + " ".join(html.unescape(re.sub('<[^>]+>', '', m.group(1))).split()))
    if not bits:
        m = re.search(r"<h1>(.*?)</h1>", t, flags=re.I | re.S)
        bits.append(" ".join(re.sub("<[^>]+>", "", m.group(1)).split()) if m else "server error page")
    return "; ".join(bits)[:200]


def _upload_sound(ch: dict, base: str, data: bytes, name: str) -> int:
    """POST /uploadSound (multipart) -> soundId. Response shape is not documented, so any integer-ish id field is accepted."""
    ext, ctype = ("mp3", "audio/mpeg") if data[:3] == b"ID3" or data[:2] == b"\xff\xfb" else ("wav", "audio/wav")
    r = requests.post(f"{base}/uploadSound", data={"username": ch["username"], "password": ch.get("password", ""), "soundName": name},
                      files={"file": (f"{name}.{ext}", data, ctype)}, headers=ch.get("headers") or {}, timeout=60)
    if not r.ok:
        raise RuntimeError(f"uploadSound HTTP {r.status_code} ({ext}, {len(data) // 1024} KB): {_server_error_text(r.text)}")
    try:
        j = json.loads(r.text or "{}")
    except ValueError:
        j = {}
    if isinstance(j, dict):
        if str(j.get("status", "")).lower() in ("failed", "error"):
            raise RuntimeError(f"uploadSound refused: {str(j.get('response') or j)[:200]}")
        for k, v in j.items():                          # the dialer answers {"sounid": 50944, ...} (sic)
            if k.lower().startswith("soun") or k.lower() in ("id", "fileid", "file_id"):
                try:
                    return int(str(v).strip())
                except ValueError:
                    continue
        for v in j.values():
            if isinstance(v, dict):
                for k2, v2 in v.items():
                    if "sound" in k2.lower() or k2.lower() == "id":
                        try:
                            return int(str(v2).strip())
                        except ValueError:
                            continue
    import re
    m = re.search(r"\d{2,}", r.text or "")
    if m:
        return int(m.group())
    raise RuntimeError(f"uploadSound: no soundId in reply {r.text[:160]!r}")


_SOUND_CACHE_KEY = "voice_sounds"


def _cached_sound(base: str, text: str) -> tuple[str, int | None]:
    """Clips are uploaded once per sentence: the dialer keeps them, we keep the id (settings voice_sounds)."""
    key = hashlib.sha1(f"{base}|{text}".encode()).hexdigest()[:16]
    try:
        from .db import get_setting
        with SessionLocal() as s:
            v = (get_setting(s, _SOUND_CACHE_KEY, {}) or {}).get(key)
            return key, int(v["id"]) if isinstance(v, dict) and v.get("id") else None
    except Exception:  # noqa: BLE001
        return key, None


def _remember_sound(key: str, sound: int, text: str) -> None:
    try:
        from .db import get_setting, set_setting
        with SessionLocal() as s:
            d = dict(get_setting(s, _SOUND_CACHE_KEY, {}) or {})
            d[key] = {"id": int(sound), "text": text[:120], "at": utcnow().isoformat()}
            if len(d) > 500:                                # keep the newest 500 sentences
                for k in sorted(d, key=lambda k: d[k].get("at", ""))[: len(d) - 500]:
                    d.pop(k, None)
            set_setting(s, _SOUND_CACHE_KEY, d, "voice")
            s.commit()
    except Exception:  # noqa: BLE001
        log.exception("could not remember voice clip id")


def _local_clip(ch: dict, base: str, text: str, nid: str) -> tuple[int | None, str]:
    """Speak `text` locally and upload it (or reuse the clip uploaded for the same sentence earlier).
    Tries the configured clip format first (wav 8 kHz), then the other one (mp3) when the dialer's upload service
    fails - its Tomcat answers a bare HTTP 500 for a format or size it does not like. Returns (soundId, note)."""
    key, cached = _cached_sound(base, text)
    if cached:
        return cached, f" (voice clip, sound {cached}, reused)"
    first = str(ch.get("clip_format") or "wav").lower()
    fmts = [first] + [f for f in ("wav", "mp3") if f != first]
    digits = "".join(c for c in nid if c.isalnum())[:12] or "clip"
    errors = []
    for i, fmt in enumerate(fmts):
        data = _tts_mp3(text, ch, fmt)
        if not data:
            return None, " (local TTS unavailable; dialer TTS)"
        for name in (f"uvp{digits}", f"uvp{digits}{fmt}"):
            try:
                sound = _upload_sound(ch, base, data, name)
                _remember_sound(key, sound, text)
                return sound, f" (local voice clip, sound {sound}{'' if i == 0 else ', ' + fmt})"
            except Exception as e:  # noqa: BLE001
                errors.append(str(e)[:160])
                log.warning("voice clip upload failed (%s, %s): %s", fmt, name, e)
                if "refused" in str(e) and "exist" not in str(e).lower():
                    break                                   # the account rejected it; a new name will not help
    return None, " (clip upload failed: " + " | ".join(dict.fromkeys(errors))[:220] + "; dialer TTS)"


def _send_voice(ch: dict, to: str, kind: str, payload: dict, nid: str) -> str:
    """Place an automated voice call through a BulkOBD-compatible dialer (POST <url>/voiceBlast, JSON).

    Channel keys: url (base, e.g. http://host:8096/OBDSEA), username, password, language ("1"), max_call_s (45),
    sound_id (a pre-recorded clip id -> played instead of TTS), ack_digit ("1": the call asks to press it and the
    dialer's webhook acknowledges the alert), retries (1), retry_after ("00:01:00").
    The campaign name carries our notification id (uvp-<id>) so the result webhook can be matched back."""
    base = (ch.get("url") or "").rstrip("/")
    if not base or not ch.get("username"):
        raise RuntimeError("voice channel needs url, username and password")
    text = ch.get("tts_text") or speak_text(kind, payload)
    ack = str(ch.get("ack_digit") or "").strip()
    sound = ch.get("sound_id")
    note = ""
    if (ch.get("tts") or "local") == "local" and not sound:
        # speak it here, upload the clip, play that: works even when the dialer's own TTS is silent
        sound, note = _local_clip(ch, base, text + (f" Press {ack} to acknowledge." if ack else ""), nid)
    if sound:                                   # pre-recorded clip
        camp_type, sound_id, tts = (2 if ack else 1), int(sound), "NA"
    else:                                       # dynamic text-to-speech
        if ack:
            text += f" Press {ack} to acknowledge."
        camp_type, sound_id, tts = (4 if ack else 3), 0, "{var1}"
    number = "".join(c for c in str(to) if c.isdigit())
    if len(number) == 10:
        number = "91" + number
    # TTS campaigns need the spoken text as a dynamic variable: numbers = "<number>,arg1:<text>", tts_text = "{var1}"
    numbers = number if sound else f"{number},arg1:{text}"
    body = {"campname": f"uvp-{nid}", "username": ch["username"], "password": ch.get("password", ""), "numbers": numbers,
            "metadata": f"{kind}:{payload.get('id', '')}", "soundId": sound_id, "camp_type": camp_type, "tts_text": tts, "sch_date": "NA",
            "valid_audio": str(ch.get("ack_sound_id") or "NA"), "invalid_audio": "NA", "no_Response_audio": "NA",
            "no_of_retry": "1", "waiting_time": str(ch.get("wait_s", 6)), "valid_option": ack or "NA", "unique_name": f"uvp-{kind}",
            "retry_on": "YES" if int(ch.get("retries", 1)) else "NO", "dnid_number": str(ch.get("caller_id") or "NA"),
            "max_retry": int(ch.get("retries", 1)), "retry_time": str(ch.get("retry_after", "00:01:00")),
            "retry_hangup_cause": "NO ANSWER,BUSY,NOT REACHABLE", "var1": "NA" if sound else text, "var2": "NA", "var3": "NA", "var4": "NA",
            "language": str(ch.get("language", "1")), "maxcallTimeSec": int(ch.get("max_call_s", 45))}
    # multipart/form-data: the dialer's JSON path rejects TTS campaigns ("Pass Dynamic Text"), the form path accepts them
    if (ch.get("format") or "form") == "json":
        r = requests.post(f"{base}/voiceBlast", json=body, headers={"Content-Type": "application/json", **(ch.get("headers") or {})}, timeout=20)
    else:
        r = requests.post(f"{base}/voiceBlast", files={k: (None, str(v)) for k, v in body.items()}, headers=ch.get("headers") or {}, timeout=20)
    if not r.ok:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    # the dialer answers HTTP 200 even when it refuses: {"response": "...", "error_code": 400, "status": "failed"}
    try:
        j = json.loads(r.text or "{}")
    except ValueError:
        j = {}
    if isinstance(j, dict) and (str(j.get("status", "")).lower() in ("failed", "error", "fail") or int(j.get("error_code") or 0) >= 400):
        msg = str(j.get("response") or j.get("message") or j)[:200]
        hint = " - the dialer only places calls in that window; ask the provider to allow 24x7 calling for alerts, or route night alerts to SMS/WhatsApp" \
            if "between" in msg.lower() and ("am" in msg.lower() or "pm" in msg.lower()) else ""
        raise RuntimeError(f"dialer refused: {msg}{hint}")
    camp = (j.get("CampaignId") or j.get("campid") or j.get("campaign_id") or j.get("id")) if isinstance(j, dict) else None
    return f"call queued to {number}" + (f" (campaign {camp})" if camp else "") + note + f": {r.text[:120]}"


def voice_callback(data: dict) -> dict:
    """Result webhook from the dialer (registered with the provider as <server>/api/integrations/voice/callback?key=...).
    Updates the delivery log row and, when the ack digit was pressed, acknowledges the alert."""
    from .db import Alert
    camp = str(data.get("campid") or data.get("campname") or "")
    number = "".join(c for c in str(data.get("number") or "") if c.isdigit())
    status = str(data.get("dialstatus") or "").upper()
    resp = str(data.get("response") or "").strip()
    out = {"matched": False, "acknowledged": False}
    with SessionLocal() as s:
        n = None
        if camp.startswith("uvp-"):
            n = s.get(Notification, camp[4:])
        if n is None and number:
            n = s.scalar(select(Notification).where(Notification.channel == "voice", Notification.recipient.like(f"%{number[-10:]}"))
                         .order_by(Notification.ts.desc()).limit(1))
        if n is None:
            return out
        out["matched"] = True
        n.status = "answered" if status == "ANSWERED" else ("sent" if not status else status.lower().replace(" ", "_"))
        n.detail = (f"{status} duration={data.get('duration', '')}s pressed={resp or '-'} at {data.get('callanswertime') or data.get('campcalltime') or ''}")[:500]
        ack_digit = _voice_ack_digit()
        if n.kind == "alert" and resp and ack_digit and resp == ack_digit and n.ref_id:
            a = s.get(Alert, n.ref_id)
            if a is not None and a.ack_at is None:
                a.ack_by, a.ack_at = f"voice:{number or 'call'}", utcnow()
                out["acknowledged"] = True
        s.commit()
    if out["acknowledged"]:
        try:
            from .inbox import push
            push("alert", f"Alert acknowledged by phone ({number})", f"notification {n.id}", severity="info", ref_id=n.ref_id, link="alerts")
        except Exception:  # noqa: BLE001
            pass
    return out


def _voice_ack_digit() -> str:
    for ch in (cfg().get("channels") or {}).values():
        if ch.get("type") == "voice" and ch.get("ack_digit"):
            return str(ch["ack_digit"]).strip()
    return ""


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
            elif t == "voice":
                res = _send_voice(ch, to, kind, payload, nid)
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
