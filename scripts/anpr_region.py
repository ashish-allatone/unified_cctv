#!/usr/bin/env python3
"""Place and test the ANPR region of a camera. Grabs frames from the camera (through the relay, or from
any RTSP URL / video file), draws the region, runs the recogniser with and without region+upscale, and
reports plate widths so you can see whether vehicles are readable where the region is.

  docker compose run --rm anpr python scripts/anpr_region.py cam02 --roi 0,0.45,1,0.55 --upscale 2 --seconds 20
  python scripts/anpr_region.py rtsp://user%40x.in:pass@103.250.160.189:8554/stream/cam02 --roi 0,0.5,1,0.5

Writes data/anpr_region_<cam>.jpg (frame with the region and every detection drawn) and prints a summary.
Rule of thumb from the recogniser: plates need ~65 px width on the full frame, ~40 px with a region + 2x.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))

import cv2  # noqa: E402

os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("camera", help="camera id (uses the relay) or an rtsp:// URL / video file")
    ap.add_argument("--roi", default="", help="x,y,w,h as fractions of the frame, e.g. 0,0.45,1,0.55 (bottom 55%%)")
    ap.add_argument("--upscale", type=float, default=2.0)
    ap.add_argument("--seconds", type=int, default=20, help="how long to sample")
    ap.add_argument("--fps", type=float, default=2.0)
    a = ap.parse_args()
    from uvp.config import settings
    from uvp.services.anpr_worker import Recogniser, detect_in_region
    src = a.camera
    candidates: list[tuple[str, str]] = []
    if src.startswith("rtsp://") or Path(src).exists():
        candidates.append(("given", src))
    else:
        # camera id: try the relay first, then the departmental source directly (credentials from .env via the adapter)
        from uvp.relay import internal_rtsp_url
        candidates.append(("relay", internal_rtsp_url(a.camera, "main")))
        try:
            from uvp.adapters.registry import build, resolve
            from uvp.config import load_yaml
            for scfg in (load_yaml(settings.sources_file) or {}).get("sources", []):
                ad = build(resolve(scfg))
                for c in ad.list_cameras():
                    if f"{scfg.get('id_prefix', '')}{c.native_id}" == a.camera:
                        candidates.append(("direct", c.profiles["main"].url))
        except Exception as e:  # noqa: BLE001
            print(f"(could not resolve {a.camera} through sources.yaml: {e})")
    roi = [float(v) for v in a.roi.split(",")] if a.roi else None
    cfg = {"roi": roi, "upscale": a.upscale}
    rec = Recogniser()
    from uvp.adapters.base import redact
    cap = None
    for how, url in candidates:
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        if cap.isOpened():
            print(f"reading {a.camera} via {how}: {redact(url)}")
            break
        print(f"  {how}: cannot open {redact(url)}")
        cap.release()
        cap = None
    if cap is None:
        print("cannot open the stream: relay path missing (adapter not synced yet?) and the direct URL refused (401 = email/password, timeout = port 8554 blocked)")
        return 1
    t_end = time.time() + a.seconds
    n = 0
    full_reads, region_reads, widths_full, widths_region = [], [], [], []
    best_frame, best_dets = None, []
    last = 0.0
    while time.time() < t_end:
        ok, frame = cap.read()
        if not ok:
            break
        if time.time() - last < 1.0 / a.fps:
            continue
        last = time.time()
        n += 1
        d_full = rec(frame)
        d_reg = detect_in_region(rec, frame, cfg)
        full_reads += [(d["raw"], d["conf"]) for d in d_full]
        region_reads += [(d["raw"], d["conf"]) for d in d_reg]
        widths_full += [d["bbox"][2] - d["bbox"][0] for d in d_full]
        widths_region += [d["bbox"][2] - d["bbox"][0] for d in d_reg]
        if len(d_reg) >= len(best_dets):
            best_frame, best_dets = frame.copy(), d_reg
    cap.release()
    if best_frame is None:
        print("no frames received")
        return 1
    h, w = best_frame.shape[:2]
    if roi:
        x1, y1 = int(roi[0] * w), int(roi[1] * h)
        x2, y2 = int((roi[0] + roi[2]) * w), int((roi[1] + roi[3]) * h)
        cv2.rectangle(best_frame, (x1, y1), (x2, y2), (255, 200, 0), 3)
        cv2.putText(best_frame, f"ANPR region x{a.upscale:g}", (x1 + 8, y1 + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 200, 0), 2)
    for d in best_dets:
        bx1, by1, bx2, by2 = d["bbox"]
        cv2.rectangle(best_frame, (bx1, by1), (bx2, by2), (0, 255, 255), 2)
        cv2.putText(best_frame, f"{d['raw']} {d['conf']:.2f} {bx2 - bx1}px", (bx1, max(20, by1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
    out = settings.data_dir / f"anpr_region_{Path(a.camera).stem if not a.camera.startswith('rtsp') else 'stream'}.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), best_frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    good = lambda reads: sum(1 for _, c in reads if c >= 0.8)  # noqa: E731
    print(f"\n{n} frames sampled from {a.camera} ({w}x{h})")
    print(f"  full frame:        {len(full_reads)} reads, {good(full_reads)} confident (>=0.80); plate widths {sorted(widths_full)[-5:] or '-'} px")
    print(f"  region + x{a.upscale:g}:   {len(region_reads)} reads, {good(region_reads)} confident; plate widths {sorted(widths_region)[-5:] or '-'} px")
    print(f"  picture with the region and detections: {out}")
    if widths_region and max(widths_region) < 35:
        print("  plates here are under 35 px even inside the region: this view is too wide for ANPR; use it for counting / incidents instead")
    elif good(region_reads) > good(full_reads):
        print("  the region helps: put anpr_roi / anpr_upscale on this camera in sources.yaml")
    elif not region_reads and not full_reads:
        print("  nothing detected: no vehicles passed, or the region is on the wrong part of the road; try a different --roi")
    return 0


if __name__ == "__main__":
    sys.exit(main())
