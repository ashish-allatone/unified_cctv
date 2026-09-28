"""Non-interference evidence run against the two simulated departmental systems.

Produces data/reports/non_interference.md with five checks:
  1. No write calls reached either departmental system (their own audit logs).
  2. Load on a departmental system stays at ONE session per stream as viewers go 1 -> 20.
  3. The per-source cap refuses new streams once reached.
  4. A departmental outage affects only that department's cameras; the other keeps working.
  5. Stopping the whole platform leaves departmental systems running.

Needs the lite stack running (scripts/lite.sh start). Takes about 2 minutes.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
API = os.environ.get("API", "http://localhost:8000")
RELAY_RTSP = "rtsp://{u}:{p}@127.0.0.1:8554"
SIM = {"Police": {"audit": "http://localhost:18080/sim/audit", "stats": "http://localhost:19997"},
       "Municipal": {"audit": "http://localhost:18090/sim/audit", "stats": "http://localhost:29997"}}
RUN = ROOT / "data" / "run"
results: list[tuple[str, bool, str]] = []
lines: list[str] = []


def check(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + " — " + detail, flush=True)


def token(user="admin", pw="admin123") -> str:
    return requests.post(f"{API}/api/auth/login", json={"username": user, "password": pw}, timeout=10).json()["token"]


def sim_sessions(dept: str, path: str) -> int:
    """Readers on the departmental system itself for one stream (what the department sees)."""
    items = requests.get(f"{SIM[dept]['stats']}/v3/paths/list", timeout=5).json()["items"]
    return sum(len(p.get("readers", [])) for p in items if p["name"] == path)


def sim_total_sessions(dept: str) -> int:
    items = requests.get(f"{SIM[dept]['stats']}/v3/paths/list", timeout=5).json()["items"]
    return sum(len(p.get("readers", [])) for p in items)


def relay_rtsp_for(camera_id: str) -> str:
    """In a relay cluster the camera lives on one relay: ask the platform which (RELAY_RTSPS names it)."""
    u, p = os.environ.get("RELAY_INTERNAL_USER", "uvp-internal"), os.environ.get("RELAY_INTERNAL_PASS", "change-me-relay")
    spec = os.environ.get("RELAY_RTSPS", "")
    if spec:
        try:
            cams = {c["id"]: c for c in requests.get(f"{API}/api/cameras", headers={"Authorization": f"Bearer {token()}"}, timeout=5).json()}
            name = cams.get(camera_id, {}).get("relay", "")
            for part in spec.split(","):
                n, url = part.split("=", 1)
                if n.strip() == name:
                    return url.strip().replace("rtsp://", f"rtsp://{u}:{p}@")
        except Exception:  # noqa: BLE001
            pass
    return RELAY_RTSP.format(u=u, p=p)


def readers(path: str, n: int) -> list[subprocess.Popen]:
    url = f"{relay_rtsp_for(path.split('/')[0])}/{path}"
    return [subprocess.Popen(["ffmpeg", "-loglevel", "quiet", "-rtsp_transport", "tcp", "-i", url, "-c", "copy",
                              "-f", "null", "-"], stdin=subprocess.DEVNULL) for _ in range(n)]


def stop(procs):
    for p in procs:
        p.send_signal(signal.SIGINT)
    for p in procs:
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            p.kill()


def lite(*args):
    subprocess.run([str(ROOT / "scripts" / "lite.sh"), *args], check=False, capture_output=True)


def main() -> None:
    # 1. write calls ----------------------------------------------------------------------------
    for dept, s in SIM.items():
        a = requests.get(s["audit"], timeout=5).json()
        reqs = [r for r in a["requests"] if r.get("path") != "/sim/audit"]  # exclude this test's own reads
        writes = a["write_requests"]
        kinds = sorted({r.get("action") or f"{r.get('method')} {r.get('path')}" for r in reqs})
        check(f"{dept}: no write calls", not writes,
              f"{len(reqs)} requests received, {len(writes)} writes; operations seen: {', '.join(kinds)}")

    # 2. fan-out ------------------------------------------------------------------------------
    path = "police-cam3/sub"
    table = []
    for n in (1, 5, 20):
        procs = readers(path, n)
        time.sleep(8)
        table.append((n, sim_sessions("Police", path)))
        stop(procs)
        time.sleep(1)
    ok = all(s == 1 for _, s in table)
    check("One departmental session per stream regardless of viewers", ok,
          "; ".join(f"{n} viewers -> {s} session(s) on the Police NVR" for n, s in table))
    time.sleep(22)  # let on-demand pulls close
    idle = sim_sessions("Police", path)
    check("Idle streams are released", idle == 0, f"{path}: {idle} session(s) 20 s after the last viewer left")

    # 3. cap ------------------------------------------------------------------------------------
    from uvp.db import SessionLocal, Source
    with SessionLocal() as s:
        src = s.get(Source, "municipal")
        original = src.max_concurrent_pulls
        src.max_concurrent_pulls = 3  # temporary; the adapter service restores sources.yaml on its next sync
        s.commit()
    tok = token()
    time.sleep(3)
    codes = []
    cams = {c["id"]: c for c in requests.get(f"{API}/api/cameras", headers={"Authorization": f"Bearer {tok}"}).json()}
    for cam in ("muni-cam3", "muni-cam4", "muni-cam1", "muni-cam2"):
        host, hls = cams[cam].get("relay_host") or "localhost", cams[cam].get("relay_hls_port") or 8888
        r = requests.get(f"http://{host}:{hls}/{cam}/sub/index.m3u8?token={tok}", timeout=25)
        codes.append((cam, r.status_code))
        time.sleep(3)  # let the snapshot see the new pull
    with SessionLocal() as s:
        s.get(Source, "municipal").max_concurrent_pulls = original
        s.commit()
    # ANPR already holds 2 municipal pulls (cam1/main, cam2/main) -> cap 3 leaves room for exactly one more
    allowed = [c for c, code in codes if code == 200]
    refused = [c for c, code in codes if code in (401, 403)]
    check("Per-source stream cap enforced", len(allowed) == 1 and len(refused) == 3,
          f"cap 3 with 2 ANPR pulls active: allowed {allowed}, refused {refused}")
    time.sleep(15)

    # 4. outage isolation -------------------------------------------------------------------------
    for n in ("sim-muni-api", "sim-muni-video"):
        pid = (RUN / f"{n}.pid").read_text().strip()
        subprocess.run(["pkill", "-P", pid])
        os.kill(int(pid), signal.SIGTERM)
        (RUN / f"{n}.pid").unlink()
    time.sleep(28)
    tok = token()
    srcs = {s["id"]: s for s in requests.get(f"{API}/api/sources", headers={"Authorization": f"Bearer {tok}"}).json()}
    cams = requests.get(f"{API}/api/cameras", headers={"Authorization": f"Bearer {tok}"}).json()
    muni_off = all(c["status"] == "offline" for c in cams if c["department"] == "Municipal")
    police_ok = all(c["status"] in ("online", "live") for c in cams if c["department"] == "Police")
    procs = readers("police-cam4/sub", 1)
    time.sleep(6)
    police_stream = sim_sessions("Police", "police-cam4/sub") == 1
    stop(procs)
    check("Municipal outage is isolated", srcs["municipal"]["status"] == "error" and muni_off and police_ok and police_stream,
          f"municipal source={srcs['municipal']['status']}, municipal cameras offline={muni_off}, "
          f"police cameras online={police_ok}, police stream still plays={police_stream}")
    lite("sims")
    time.sleep(25)

    # 5. platform down -> departments unaffected ------------------------------------------------------
    for n in ("anpr", "adapters", "api", "relay"):
        f = RUN / f"{n}.pid"
        if f.exists():
            pid = int(f.read_text())
            subprocess.run(["pkill", "-P", str(pid)])
            os.kill(pid, signal.SIGTERM)
            f.unlink()
    time.sleep(5)
    u = os.environ.get("POLICE_ONVIF_USER", "uvp-viewer")
    pw = os.environ.get("POLICE_ONVIF_PASS", "police-view-only")
    r = subprocess.run(["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-show_entries", "stream=codec_name",
                        "-of", "csv=p=0", f"rtsp://{u}:{pw}@127.0.0.1:18554/police-cam2/main"],
                       capture_output=True, text=True, timeout=30)
    rest = requests.get("http://localhost:18090/api/v1/auth/login", timeout=5).status_code  # 405 = API up
    check("Departmental systems keep working with the platform stopped", r.stdout.strip() == "h264" and rest == 405,
          f"Police NVR stream codec={r.stdout.strip() or 'none'}; Municipal VMS API HTTP {rest}")
    lite("platform")

    # report ------------------------------------------------------------------------------------
    out = ROOT / "data" / "reports"
    out.mkdir(parents=True, exist_ok=True)
    md = ["# Non-interference test report", "",
          f"Run: {(dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=5, minutes=30)).strftime('%Y-%m-%d %H:%M')} IST against the simulated Police NVR (ONVIF) "
          "and Municipal VMS (vendor REST API).", "",
          f"Result: **{sum(ok for _, ok, _ in results)} of {len(results)} checks passed.**", "",
          "| Check | Result | Evidence |", "| --- | --- | --- |"]
    md += [f"| {n} | {'PASS' if ok else 'FAIL'} | {d} |" for n, ok, d in results]
    (out / "non_interference.md").write_text("\n".join(md) + "\n")
    (out / "non_interference.json").write_text(json.dumps([{"check": n, "pass": ok, "evidence": d}
                                                            for n, ok, d in results], indent=1))
    print(f"\nreport: {out / 'non_interference.md'}")
    sys.exit(0 if all(ok for _, ok, _ in results) else 1)


if __name__ == "__main__":
    main()
