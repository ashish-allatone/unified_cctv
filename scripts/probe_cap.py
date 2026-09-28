#!/usr/bin/env python3
"""Find how many streams a gateway lets ONE account pull at the same time (its concurrent-session cap).

Opens k streams at once (distinct cameras), holds them 8 s, counts how many play, then tries a larger k.
Stops at the first k where the gateway refuses (401 / timeout) and prints the value to put in
config/sources.yaml as max_concurrent_pulls.

  docker compose stop adapters relay        # IMPORTANT: free the account's sessions first, or the probe measures nothing
  docker compose run --rm api python scripts/probe_cap.py corp8
  docker compose start relay adapters

Takes ~2 minutes for 30 cameras. Read-only (ffmpeg only reads). A gateway that locks the account after refusals
may need its 10-minute cool-down afterwards - the adapters handle that automatically.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def _find_root() -> Path:
    for start in (Path(__file__).resolve().parent, Path.cwd()):
        for d in (start, *start.parents):
            if (d / "config" / "sources.yaml").exists():
                return d
    print("cannot find config/sources.yaml: run this from the unified-cctv folder")
    sys.exit(2)


ROOT = _find_root()
sys.path.insert(0, str(ROOT / "platform"))
env_file = ROOT / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def play(url: str, seconds: int = 8) -> str:
    """'ok' | '401' | 'timeout' | short error."""
    try:
        p = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", url, "-t", str(seconds), "-f", "null", "-"],
                           capture_output=True, text=True, timeout=seconds + 15)
    except subprocess.TimeoutExpired:
        return "timeout"
    err = p.stderr.strip()
    if p.returncode == 0 and "Unauthorized" not in err:
        return "ok"
    if "401" in err or "Unauthorized" in err:
        return "401"
    return (err.splitlines() or ["error"])[-1][:60]


def main() -> int:
    from uvp.adapters.registry import build
    from uvp.config import load_yaml
    cfg_all = load_yaml(ROOT / "config" / "sources.yaml")
    if isinstance(cfg_all, list):
        cfg_all = {"sources": cfg_all}
    sid = sys.argv[1] if len(sys.argv) > 1 else next((s["id"] for s in cfg_all["sources"] if s["id"] not in ("police", "municipal")), None)
    src = next((s for s in cfg_all["sources"] if s["id"] == sid), None)
    if not src:
        print(f"source {sid!r} not in config/sources.yaml"); return 2
    ad = build(src)
    urls = [c.profiles["main"].url for c in ad.list_cameras() if "main" in c.profiles]
    print(f"{sid}: {len(urls)} cameras. Probing concurrent sessions (each step holds the streams for 8 s)…\n")
    steps = [k for k in (2, 4, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50) if k <= len(urls)]
    if len(urls) not in steps:
        steps.append(len(urls))
    best = 0
    for k in steps:
        with ThreadPoolExecutor(max_workers=k) as ex:
            res = list(ex.map(play, urls[:k]))
        ok = res.count("ok"); r401 = res.count("401"); to = res.count("timeout")
        other = k - ok - r401 - to
        print(f"  {k:>3} at once -> {ok:>3} play, {r401:>3} x 401, {to:>3} timeout, {other:>3} other error")
        if ok == k:
            best = k
        else:
            bad = [f"cam{i + 1}: {r}" for i, r in enumerate(res) if r != "ok"][:5]
            print(f"      refused from here on ({', '.join(bad)}{' …' if k - ok > 5 else ''})")
            break
        time.sleep(3)          # let the gateway release the sessions before the next, larger step
    print()
    if best == len(urls):
        print(f"All {best} cameras play together: no session cap seen. Keep max_concurrent_pulls: {best} and persistent_pull: true.")
    elif best:
        print(f"The gateway allows about {best} concurrent sessions for this account.")
        print(f"Put in config/sources.yaml under '{sid}':   max_concurrent_pulls: {best}")
        print("The relay then keeps that many cameras pulling (ANPR cameras first) and opens the others only while someone watches them.")
        print("Ask the provider to raise the limit for the pilot account if all cameras must be analysed at once.")
    else:
        print("Even 2 sessions were refused: credentials / lockout (wait 10 min and run scripts/check_source.py) rather than a cap.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
