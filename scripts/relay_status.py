#!/usr/bin/env python3
"""What the relay is actually receiving, per camera path: ready?, since when, bytes received, readers.
Answers "the tiles say offline - is it the gateway, the relay or the browser?" in one screen.

  docker compose exec api python scripts/relay_status.py            # inside Docker (relay reachable as http://relay:9997)
  docker compose exec api python scripts/relay_status.py --watch    # refresh every 5 s

Legend:  READY = the relay has the stream (a browser problem if the tile is still black)
         DOWN  = the relay cannot open the source (gateway refused / session cap / network)
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))


def main() -> int:
    from uvp.relay import relay
    watch = "--watch" in sys.argv
    while True:
        try:
            live = relay.live_paths(0)
            conf = relay.configured_paths()
        except Exception as e:  # noqa: BLE001
            print(f"relay API not reachable: {e}")
            return 1
        by = {p["name"]: p for p in live}
        rows = []
        for name, (src, rec, persist) in sorted(conf.items()):
            p = by.get(name, {})
            ready = bool(p.get("ready"))
            kind = "loopback" if "127.0.0.1" in src else ("gateway" if src.startswith("rtsp") else src[:12])
            rows.append((name, "READY" if ready else "DOWN ", p.get("readyTime", "")[11:19] if ready else "", int(p.get("bytesReceived") or 0), len(p.get("readers") or []), kind, "P" if persist else "d", "R" if rec else " "))
        gw = [r for r in rows if r[5] == "gateway"]
        up = sum(1 for r in gw if r[1] == "READY")
        print(f"\033[2J\033[H" if watch else "", end="")
        print(f"{time.strftime('%H:%M:%S')}  gateway pulls ready: {up} / {len(gw)}   (P = persistent, d = on demand, R = recording)\n")
        print(f"{'path':<18}{'state':<7}{'since':<10}{'MB recv':>9}  {'rd':>2}  {'source':<9}")
        for name, st, since, b, rd, kind, pers, rec in rows:
            colour = "\033[32m" if st == "READY" else "\033[31m"
            print(f"{name:<18}{colour}{st}\033[0m  {since:<10}{b / 1048576:>9.1f}  {rd:>2}  {kind:<9}{pers}{rec}")
        down = [r[0] for r in gw if r[1] != "READY"]
        if down:
            print(f"\n{len(down)} gateway pull(s) down: {', '.join(down[:12])}{' …' if len(down) > 12 else ''}")
            print("  all down + adapters log says 401  -> credentials / lockout (wait 10 min)")
            print("  some down, some ready            -> the gateway limits concurrent sessions: run scripts/probe_cap.py and set max_concurrent_pulls")
            print("  ready but tiles black            -> browser side: ports 8189 (WebRTC) / 8888 (HLS), or the H.265 transcode; see docs/operations.md")
        if not watch:
            return 0
        time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())
