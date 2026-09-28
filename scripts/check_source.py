#!/usr/bin/env python3
"""Check whether a departmental source (e.g. corp8) is reachable, whether login works, what the camera
catalogue returns, and whether one stream actually plays. Prints raw responses so a wrong path or field
name is obvious.

Set CHECK_CODECS=1 to also probe every camera's codec (H.264 vs H.265):
  docker compose run --rm -e CHECK_CODECS=1 api python scripts/check_source.py corp8

  python scripts/check_source.py corp8                  # from the unzipped folder, with .env present
  docker compose run --rm api python scripts/check_source.py corp8     # same, inside Docker

Read-only: only the login call is a POST; nothing on the vendor system is changed.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

def _find_root() -> Path:
    """The project folder: wherever config/sources.yaml is, looking up from the script and from the current dir."""
    for start in (Path(__file__).resolve().parent, Path.cwd()):
        for d in (start, *start.parents):
            if (d / "config" / "sources.yaml").exists():
                return d
    print("cannot find config/sources.yaml: run this from the unified-cctv folder")
    sys.exit(2)


ROOT = _find_root()
sys.path.insert(0, str(ROOT / "platform"))

# .env (Docker Compose style) so the script works outside compose too
env_file = ROOT / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

import requests  # noqa: E402

OK, BAD, WARN = "\033[32mOK\033[0m ", "\033[31mFAIL\033[0m", "\033[33mWARN\033[0m"


def step(status: str, msg: str) -> None:
    print(f"  [{status}] {msg}")


def short(text: str, n: int = 400) -> str:
    text = text.strip().replace("\n", " ")
    return text[:n] + (" …" if len(text) > n else "")


def main() -> int:
    from uvp.config import load_yaml
    cfg_all = load_yaml(ROOT / "config" / "sources.yaml")          # expands ${VAR:-default} like the platform does
    if isinstance(cfg_all, list):                                    # file lost its top-level "sources:" line
        print("WARNING: config/sources.yaml has no 'sources:' heading; the platform needs it. Add 'sources:' as the first line and indent every '- id:' under it.")
        cfg_all = {"sources": cfg_all}
    ids = [s["id"] for s in cfg_all.get("sources", [])]
    if len(sys.argv) < 2:
        real = [i for i in ids if i not in ("police", "municipal")]
        if len(real) == 1:
            sid = real[0]
            print(f"(no source given; checking '{sid}'. Usage: python {Path(sys.argv[0]).name} <source id>; sources: {ids})")
        else:
            print(f"Usage: python {Path(sys.argv[0]).name} <source id>\nSources in config/sources.yaml: {ids}")
            return 2
    else:
        sid = sys.argv[1]
    src = next((s for s in cfg_all.get("sources", []) if s["id"] == sid), None)
    if not src:
        print(f"source '{sid}' not found in config/sources.yaml; have: {[s['id'] for s in cfg_all.get('sources', [])]}")
        return 2
    print(f"\nSource {sid}: {src.get('name')} · adapter={src.get('adapter')} · base_url={src.get('base_url')}\n")

    # 1. credentials present?
    user = os.environ.get(src.get("username_env", ""), src.get("username", ""))
    pw = os.environ.get(src.get("password_env", ""), src.get("password", ""))
    api0 = src.get("api") or {}
    open_api = src.get("adapter") == "vendor_rest" and not api0.get("login_path", "x") and not api0.get("api_key_header", "x") and not api0.get("stream_needs_credentials")
    if user and pw:
        step(OK, f"credentials: {src.get('username_env')}={user}  {src.get('password_env')}=****{pw[-2:]}")
    elif open_api:
        step(OK, "no credentials needed: open catalogue and open streams")
    else:
        step(BAD, f"credentials missing: set {src.get('username_env')} and {src.get('password_env')} in .env")
        return 1

    if src.get("adapter") != "vendor_rest":
        return check_via_adapter(src)
    if len(sys.argv) > 2 and sys.argv[2] == "discover":
        return discover(src, user, pw)

    base = src["base_url"].rstrip("/")
    api = src.get("api") or {}
    verify = src.get("tls_verify", True)
    s = requests.Session()
    s.headers["User-Agent"] = "unified-cctv-check/1.0"

    # 2. host reachable?
    try:
        r = s.get(base, timeout=10, verify=verify, allow_redirects=True)
        step(OK, f"host reachable: GET {base} -> HTTP {r.status_code} ({r.headers.get('content-type', '?')})")
    except requests.exceptions.SSLError as e:
        step(BAD, f"TLS problem: {short(str(e), 200)}  -> if the certificate is self-signed, add 'tls_verify: false' to the source")
        return 1
    except requests.RequestException as e:
        step(BAD, f"cannot reach {base}: {short(str(e), 200)}  -> check DNS / firewall / VPN from this machine")
        return 1

    # 3. login (or API key)
    headers: dict[str, str] = {}
    login_path = api.get("login_path", "/api/v1/auth/login")
    if login_path:
        body_t = api.get("login_body") or {"username": "{user}", "password": "{password}"}
        body = {k: (v.format(user=user, password=pw) if isinstance(v, str) else v) for k, v in body_t.items()}
        if api.get("login_page"):
            body = {**hidden_inputs(s.get(base + api["login_page"], timeout=15, verify=verify).text), **body}
        url = base + login_path
        try:
            if api.get("login_mode") == "form":
                r = s.post(url, data=body, timeout=15, verify=verify)
            else:
                r = s.post(url, json=body, timeout=15, verify=verify)
        except requests.RequestException as e:
            step(BAD, f"login request failed: {e}")
            return 1
        ctype = r.headers.get("content-type", "")
        print(f"        POST {url}  body keys={list(body)}  -> HTTP {r.status_code} {ctype}")
        print(f"        reply: {short(r.text)}")
        if r.status_code == 404:
            step(BAD, "login path not found: the login_path in sources.yaml is wrong (check the vendor API doc)")
            return 1
        if r.status_code in (401, 403):
            step(BAD, "login rejected: wrong email/password, or the body field names differ (email vs username)")
            return 1
        if not api.get("token_field", "token"):              # cookie-session mode
            if s.cookies.get_dict():
                step(OK, f"login ok, session cookie(s): {list(s.cookies.get_dict())}")
            else:
                step(BAD, "login did not set any cookie: wrong field names or credentials (run 'discover' to find them)")
                return 1
            login_path = ""
        if login_path and "json" not in ctype:
            step(BAD, "login reply is not JSON (probably a web page): base_url or login_path points at the UI, not the API")
            return 1
    if login_path:
        try:
            j = r.json()
        except ValueError:
            step(BAD, "login reply could not be parsed as JSON")
            return 1
        token = j
        for part in (api.get("token_field") or "token").split("."):
            token = token.get(part) if isinstance(token, dict) else None
        if not token:
            step(BAD, f"login ok but no '{api.get('token_field', 'token')}' in the reply; top-level keys: {list(j)[:10]}  -> set token_field")
            return 1
        step(OK, f"login ok, token received ({str(token)[:12]}…)")
        headers[api.get("token_header", "Authorization")] = api.get("token_prefix", "Bearer ") + str(token)
    elif not api.get("login_path", "/api/v1/auth/login"):
        import base64
        basic = base64.b64encode(f"{user}:{pw}".encode()).decode()
        key = (api.get("api_key_value") or "").format(user=user, password=pw, basic=basic)
        if api.get("api_key_header"):
            headers[api["api_key_header"]] = key
        if api.get("api_key_header") == "Authorization" and key.startswith("Basic "):
            step(OK, f"HTTP Basic auth: user={user}, password=access token ****{pw[-2:]}")
        elif api.get("api_key_header"):
            step(WARN, f"no login_path: sending API key in header {api['api_key_header']}")
        else:
            step(OK, "no login: calling the catalogue without authentication")

    # 4. camera catalogue
    cams_url = base + api.get("cameras_path", "/api/v1/cameras")
    try:
        r = s.get(cams_url, headers=headers, timeout=15, verify=verify)
    except requests.RequestException as e:
        step(BAD, f"camera list request failed: {e}")
        return 1
    print(f"        GET {cams_url} -> HTTP {r.status_code} {r.headers.get('content-type', '')}")
    print(f"        reply: {short(r.text, 600)}")
    if "session per ip" in r.text.lower():
        step(BAD, "the gateway allows ONE session per public IP and another client (a browser tab on the portal, or the platform's adapter service) holds it: close it, wait 30 s, retry")
        return 1
    if r.status_code == 401:
        step(BAD, f"401 from the catalogue: Basic auth refused. Check .env: {src.get('username_env')} must be the portal email and {src.get('password_env')} the ACCESS TOKEN (not your website password). Server says: {r.headers.get('www-authenticate', '')}")
        return 1
    if r.status_code != 200 or "json" not in r.headers.get("content-type", ""):
        step(BAD, "camera list did not return JSON 200: cameras_path is wrong or the token header is not what the API expects")
        return 1
    data = r.json()
    items = data
    if api.get("cameras_list_field"):
        for part in api["cameras_list_field"].split("."):
            items = items.get(part) if isinstance(items, dict) else None
    if not isinstance(items, list):
        step(BAD, f"cameras_list_field='{api.get('cameras_list_field', '')}' does not point at a list; top-level keys: {list(data)[:10] if isinstance(data, dict) else type(data)}")
        return 1
    if not items:
        step(WARN, "login and catalogue work but the account sees 0 cameras: ask the vendor to share cameras with this user")
        return 0
    first = items[0]
    step(OK, f"{len(items)} cameras in the catalogue; first entry keys: {list(first)[:12] if isinstance(first, dict) else first}")
    idf, namef = api.get("id_field", "id"), api.get("name_field", "name")
    if isinstance(first, dict) and (idf not in first or namef not in first):
        step(WARN, f"id_field='{idf}' / name_field='{namef}' not both present in the entry; adjust to the keys above")
    for it in items[:5]:
        if isinstance(it, dict):
            print(f"        - {it.get(idf)}  {it.get(namef)}  {api.get('online_field', 'status')}={it.get(api.get('online_field', 'status'))}")

    # 5. one stream
    cid = str(first.get(idf)) if isinstance(first, dict) else str(first)
    tmpl = api.get("stream_template")
    if tmpl:
        fields = {k: v for k, v in first.items() if isinstance(v, (str, int, float))} if isinstance(first, dict) else {}
        url = tmpl.format(**{**fields, "id": cid, "profile": list((api.get("profiles") or {"main": "main"}).values())[0], "host": base.split("//")[-1].split(":")[0]})
    else:
        sp = api.get("stream_path", "/api/v1/cameras/{id}/live?profile={profile}").format(id=cid, profile="main")
        try:
            sr = s.get(base + sp, headers=headers, timeout=15, verify=verify)
            print(f"        GET {base + sp} -> HTTP {sr.status_code}: {short(sr.text, 300)}")
            url = sr.json().get(api.get("stream_url_field", "rtsp_url")) if sr.status_code == 200 else ""
        except (requests.RequestException, ValueError) as e:
            step(BAD, f"stream URL request failed: {e}")
            return 1
    if not url:
        step(BAD, "no stream URL for the first camera: check stream_path / stream_url_field / stream_template")
        return 1
    if api.get("stream_needs_credentials") and "@" not in url.split("://", 1)[-1].split("/")[0]:
        from urllib.parse import quote
        url = url.replace("rtsp://", f"rtsp://{quote(user, safe='')}:{quote(pw, safe='')}@", 1)   # @ in the email -> %40
    print(f"        stream URL: {url.replace(pw, '****') if pw else url}")
    if not shutil.which("ffprobe"):
        step(WARN, "ffprobe not installed here, cannot test the stream (run inside Docker to test it)")
        return 0
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-show_entries", "stream=codec_name,width,height",
                            "-of", "csv=p=0", url], capture_output=True, text=True, timeout=25)
    except subprocess.TimeoutExpired:
        step(BAD, "stream did not answer within 25 s: RTSP port blocked, or the URL needs a different form")
        return 1
    if p.returncode == 0 and p.stdout.strip():
        step(OK, f"stream plays: {p.stdout.strip().splitlines()[0]}")
    elif "401" in p.stderr or "Unauthorized" in p.stderr:
        step(BAD, "stream refused (401): the email is not on the approved access list for RTSP, or the access password differs")
        return 1
    elif "Connection refused" in p.stderr or "timed out" in p.stderr.lower() or "Connection timed out" in p.stderr:
        step(BAD, "cannot reach the RTSP gateway on port 8554: the network blocks it. Fallback: HLS (see below)")
        print("        HLS alternative: set stream_template to \"https://cctv.corp8.cloud/{id}/index.m3u8\" (works through firewalls; a few seconds more latency)")
        return 1
        print("\nEverything works. Restart the adapter service (docker compose restart adapters) and the cameras will appear in Sources.")
        return 0
    step(BAD, f"stream failed: {short(p.stderr, 300)}")
    return 1


def hidden_inputs(html: str) -> dict:
    import re
    out = {}
    for m in re.finditer(r'<input[^>]+type=["\']hidden["\'][^>]*>', html):
        n = re.search(r'name=["\']([^"\']+)', m.group(0))
        v = re.search(r'value=["\']([^"\']*)', m.group(0))
        if n:
            out[n.group(1)] = v.group(1) if v else ""
    return out


def form_fields(html: str) -> list[tuple[str, str]]:
    """(name, type) of every input on the page, so the login body can use the portal's own field names."""
    import re
    out = []
    for m in re.finditer(r"<input[^>]*>", html, re.I):
        n = re.search(r'name=["\']([^"\']+)', m.group(0)) or re.search(r'id=["\']([^"\']+)', m.group(0))
        t = re.search(r'type=["\']([^"\']+)', m.group(0))
        if n:
            out.append((n.group(1), t.group(1) if t else "text"))
    return out


def discover(src: dict, user: str, pw: str) -> int:
    """Find the portal's API: read its scripts for paths, try the usual login endpoints, print a config block."""
    import re
    base = src["base_url"].rstrip("/")
    verify = src.get("tls_verify", True)
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (unified-cctv discovery)"
    print("Discovery: reading the portal's pages and scripts for API paths\n")
    html = s.get(base, timeout=15, verify=verify).text
    scripts = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', html)
    texts = [html] + [t for t in re.findall(r"<script[^>]*>(.*?)</script>", html, re.S)]
    for sc in scripts[:20]:
        url = sc if sc.startswith("http") else base + ("/" if not sc.startswith("/") else "") + sc
        try:
            texts.append(s.get(url, timeout=20, verify=verify).text)
            print(f"  script: {url}")
        except requests.RequestException:
            pass
    words = ("api", "auth", "login", "token", "session", "stream", "camera", "hls", "whep", "webrtc", "rtsp", "m3u8", "ws")
    paths: dict[str, int] = {}
    for t in texts:
        for m in re.findall(r'["\'`](/[A-Za-z0-9_./\-]{2,80})["\'`]', t):
            if any(w in m.lower() for w in words) and not m.endswith((".js", ".css", ".png", ".svg", ".ico", ".woff", ".woff2")):
                paths[m] = paths.get(m, 0) + 1
        for m in re.findall(r'["\'`](https?://[A-Za-z0-9_.:/\-]{6,120})["\'`]', t):
            if any(w in m.lower() for w in words):
                paths[m] = paths.get(m, 0) + 1
    if paths:
        print("\n  API-looking paths in the portal code (most frequent first):")
        for pth, n in sorted(paths.items(), key=lambda kv: -kv[1])[:40]:
            print(f"    {n:3d}x  {pth}")
    else:
        print("\n  no API paths found in the scripts (the app may load them from a separate bundle)")
    # login form on the sign-in page: its input names are the body field names
    fields = form_fields(html)
    hidden = hidden_inputs(html)
    if fields:
        print(f"\n  sign-in form inputs: {fields}")
    email_names = [n for n, t in fields if t in ("email", "text") and n not in hidden] or ["email"]
    pw_names = [n for n, t in fields if t == "password"] or ["password"]
    # try login endpoints
    cands = [p_ for p_ in paths if any(w in p_.lower() for w in ("login", "auth", "session", "token"))]
    cands += ["/auth/login", "/api/auth/login", "/api/login", "/login", "/api/v1/auth/login", "/api/session", "/api/auth/token", "/auth/token"]
    seen = []
    print("\n  trying login endpoints with your email + access password:")
    for pth in cands:
        if pth in seen or pth.startswith("http"):
            continue
        seen.append(pth)
        bodies = [{en: user, pn: pw} for en in email_names for pn in pw_names]
        bodies += [{"email": user, "password": pw}, {"username": user, "password": pw}, {"email": user, "access_password": pw}, {"email": user, "code": pw}]
        for body in bodies:
            for mode in ("form", "json"):
                fb = {**hidden, **body} if mode == "form" else body
                s.cookies.clear()
                try:
                    r = s.post(base + pth, json=fb, timeout=15, verify=verify) if mode == "json" else s.post(base + pth, data=fb, timeout=15, verify=verify)
                except requests.RequestException:
                    break
                ctype = r.headers.get("content-type", "")
                if r.status_code == 404 or (r.status_code == 405 and mode == "json"):
                    break
                cookie = s.cookies.get_dict()
                if cookie and r.status_code < 400:
                    # cookie session: does the catalogue answer JSON now?
                    for cp in ["/api/ingest", "/api/cameras", "/api/streams", "/api/v1/cameras"]:
                        cr = s.get(base + cp, timeout=15, verify=verify)
                        if "session per ip" in cr.text.lower():
                            print(f"\n  signed in OK ({pth} {mode} fields {list(body)}), but {cp} says '{cr.text.strip()}': another client from this IP holds the session (close the portal tab, wait 30 s, rerun)")
                            return 1
                        if cr.status_code == 200 and "json" in cr.headers.get("content-type", ""):
                            print(f"\n  LOGIN WORKS (cookie session {list(cookie)}): {pth} {mode} fields {list(body)}")
                            print(f"  catalogue {cp} -> {short(cr.text, 700)}")
                            print(f"""
  Put this api: block in config/sources.yaml for the source:
    api:
      login_page: /auth/login
      login_path: {pth}
      login_mode: {mode}
      login_body: {{{list(body)[0]}: "{{user}}", {list(body)[1]}: "{{password}}"}}
      token_field: ""                   # cookie session
      cameras_path: {cp}
      cameras_list_field: ""            # or the key holding the list, from the reply above
      id_field: id
      name_field: name
      online_field: live                # from the reply above
      online_value: "True"
      stream_template: "rtsp://{base.split('//')[-1].split(':')[0]}:8554/stream/{{id}}"
      profiles: {{main: main}}
      stream_needs_credentials: false""")
                            return 0
                    print(f"    {pth} {mode} {list(body)} -> HTTP {r.status_code}, cookie {list(cookie)} but the catalogue still returns HTML")
                if "json" in ctype and r.status_code < 300:
                    j = r.json()
                    tokens = {k: v for k, v in (j.items() if isinstance(j, dict) else []) if any(w in k.lower() for w in ("token", "jwt", "session", "key", "access"))}
                    cookie = s.cookies.get_dict()
                    print(f"    {pth} {mode} {list(body)} -> HTTP {r.status_code} JSON keys={list(j)[:8] if isinstance(j, dict) else type(j)}")
                    if tokens or cookie:
                        print(f"\n  LOGIN WORKS. Token field(s): {list(tokens) or 'none'}; cookies: {list(cookie) or 'none'}")
                        headers = {"Authorization": "Bearer " + str(next(iter(tokens.values())))} if tokens else {}
                        # probe camera lists with this session
                        print("\n  probing camera/stream list endpoints with the token:")
                        cams = [p_ for p_ in paths if any(w in p_.lower() for w in ("camera", "stream", "device", "channel"))]
                        cams += ["/api/cameras", "/api/streams", "/api/v1/cameras", "/api/devices", "/api/channels", "/cameras", "/streams"]
                        for cp in dict.fromkeys(cams):
                            if cp.startswith("http") or "{" in cp:
                                continue
                            try:
                                cr = s.get(base + cp, headers=headers, timeout=15, verify=verify)
                            except requests.RequestException:
                                continue
                            if "json" in cr.headers.get("content-type", "") and cr.status_code == 200:
                                print(f"    {cp} -> JSON: {short(cr.text, 500)}")
                        tf = next(iter(tokens), "token")
                        print(f"""
  Suggested block for config/sources.yaml (adjust cameras_path to the endpoint above that listed cameras):
    api:
      login_path: {pth}
      login_mode: {mode}
      login_body: {{{list(body)[0]}: "{{user}}", {list(body)[1]}: "{{password}}"}}
      token_field: {tf}
      cameras_path: <endpoint above>
      cameras_list_field: ""            # or the key holding the list
      id_field: id
      name_field: name""")
                        return 0
                elif r.status_code in (401, 403):
                    print(f"    {pth} {mode} {list(body)} -> HTTP {r.status_code} rejected ({short(r.text, 120)})")
                elif "json" in ctype:
                    print(f"    {pth} {mode} {list(body)} -> HTTP {r.status_code} {short(r.text, 120)}")
    print("\n  no login endpoint answered with JSON. Sign in once in Chrome with F12 -> Network open and tell me the request")
    print("  that appears when you press Sign in (its URL, method and the reply), or ask Corp8 for their API document.")
    return 1


def codec_survey(cams) -> None:
    """Probe every camera's main stream and report the codec: browsers play H.264 natively; H.265 (HEVC),
    MPEG-4 or MJPEG cameras are shown through the relay's on-demand H.264 transcode (~1 core per stream)."""
    import concurrent.futures as cf
    print(f"\n  codec survey of {len(cams)} cameras (this takes a minute):")

    def probe(c):
        try:
            p = subprocess.run(["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
                                "-show_entries", "stream=codec_name,width,height,r_frame_rate", "-of", "csv=p=0",
                                c.profiles["main"].url], capture_output=True, text=True, timeout=25)
            return c.native_id, (p.stdout.strip().splitlines() or [""])[0], p.returncode
        except subprocess.TimeoutExpired:
            return c.native_id, "", -1
    rows = list(cf.ThreadPoolExecutor(6).map(probe, cams))
    by: dict[str, list[str]] = {}
    for cid, info, rc in rows:
        codec = info.split(",")[0] if info else ("timeout" if rc == -1 else "error")
        by.setdefault(codec, []).append(cid)
        print(f"    {cid:8s} {info or codec}")
    for codec, ids in by.items():
        if codec == "h264":
            step(OK, f"{len(ids)} camera(s) in H.264: play natively in every browser")
        elif codec in ("hevc", "h265"):
            step(WARN, f"{len(ids)} camera(s) in H.265/HEVC: browsers get the relay's H.264 transcode automatically ({', '.join(ids)}); "
                       f"budget ~1 CPU core per stream being viewed, or ask the vendor for an H.264 profile")
        elif codec in ("timeout", "error"):
            step(WARN, f"{len(ids)} camera(s) did not answer: {', '.join(ids)}")
        else:
            step(WARN, f"{len(ids)} camera(s) in {codec}: shown via the H.264 transcode ({', '.join(ids)})")


def check_via_adapter(src: dict) -> int:
    """onvif / rtsp / rtsp_template / sdk sources: list cameras through the adapter, then play the first stream."""
    from uvp.adapters.base import redact
    from uvp.adapters.registry import build, resolve
    try:
        ad = build(resolve(src))
        cams = ad.list_cameras()
    except Exception as e:  # noqa: BLE001
        step(BAD, f"{type(e).__name__}: {e}")
        return 1
    if not cams:
        step(BAD, "the adapter lists no cameras: check the channels / streams list in sources.yaml")
        return 1
    step(OK, f"{len(cams)} cameras via {ad.kind}: {[c.native_id for c in cams][:6]}{' …' if len(cams) > 6 else ''}")
    anpr = [c.native_id for c in cams if ad.anpr_enabled(c.native_id)]
    print(f"        ANPR enabled on: {anpr or 'none'}")
    try:
        ok, msg = ad.health()
        step(OK if ok else WARN, f"gateway health: {msg}")
    except Exception as e:  # noqa: BLE001
        step(WARN, f"health probe failed: {e}")
    first = cams[0]
    url = first.profiles["main"].url
    print(f"        first stream: {redact(url)}")
    if not shutil.which("ffprobe"):
        step(WARN, "ffprobe not installed here, cannot play the stream (run inside Docker: docker compose run --rm api python scripts/check_source.py " + src["id"] + ")")
        return 0
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-show_entries", "stream=codec_name,width,height",
                            "-of", "csv=p=0", url], capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        step(BAD, "stream did not answer within 30 s: port 8554 is blocked from this network, or the gateway is down")
        return 1
    if p.returncode == 0 and p.stdout.strip():
        step(OK, f"stream {first.native_id} plays: {p.stdout.strip().splitlines()[0]}")
        if os.environ.get("CHECK_CODECS") == "1":
            codec_survey(cams)
        print("\nEverything works. docker compose build adapters && docker compose up -d adapters -> cameras appear in Sources.")
        return 0
    err = p.stderr.strip()
    if "401" in err or "Unauthorized" in err:
        step(BAD, f"stream refused (401 Unauthorized): the email is not on the approved RTSP access list, or CORP8_PASS is not the access password. ({short(err, 160)})")
    elif "404" in err or "Not Found" in err:
        step(BAD, f"stream path not found: the URL pattern or camera id is wrong ({short(err, 160)})")
    elif "Connection refused" in err or "timed out" in err.lower() or "No route" in err:
        step(BAD, f"cannot reach {src.get('host')}:{src.get('rtsp_port', 554)} (blocked port / firewall): {short(err, 160)}")
    else:
        step(BAD, f"stream failed: {short(err, 300)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
