"""ANPR accuracy on recorded clips, scored against ground truth.

Runs the same pipeline as the live worker (sampler -> detector -> OCR -> Indian
correction -> tracker) on each ANPR camera's recorded main stream and matches
every emitted event to the ground-truth vehicle that appeared at that moment.

Usage:
  python scripts/eval_anpr.py [--media data/media] [--cams police-cam1 ...]

For real footage, create a ground_truth.json in the same shape:
  {"<camera>": [{"plate": "MH12AB1234", "t": 12.5}, ...]}   # t = seconds into the clip
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))
os.environ.setdefault("DATA_DIR", "/tmp/uvp-eval")

from uvp.plates import levenshtein  # noqa: E402
from uvp.services.anpr_worker import run_file  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--media", default=str(ROOT / "data" / "media"))
    ap.add_argument("--cams", nargs="*", default=["police-cam1", "police-cam2", "muni-cam1", "muni-cam2"])
    ap.add_argument("--out", default=str(ROOT / "data" / "reports"))
    a = ap.parse_args()
    media = Path(a.media)
    truth = json.loads((media / "ground_truth.json").read_text())
    rows, total = [], {"vehicles": 0, "read": 0, "exact": 0, "one_off": 0, "false": 0, "chars": 0, "chars_ok": 0}
    t_start = time.time()
    for cam in a.cams:
        gt = truth[cam]
        print(f"\n== {cam}: {len(gt)} vehicles in clip", flush=True)
        evs = run_file(str(media / f"{cam}_main.mp4"), cam, "eval", publish=False, out_json=None)
        used = set()
        exact = one_off = false = 0
        for e in evs:  # each clip's plates are distinct, so match on plate similarity
            cands = [(levenshtein(e["plate"], g["plate"], 4), i) for i, g in enumerate(gt) if i not in used]
            if not cands:
                false += 1
                continue
            d, i = min(cands)
            if d > 3:
                false += 1
                continue
            used.add(i)
            g = gt[i]["plate"]
            exact += d == 0
            one_off += d == 1
            total["chars"] += len(g)
            total["chars_ok"] += sum(x == y for x, y in zip(e["plate"], g)) if len(e["plate"]) == len(g) else max(0, len(g) - d)
        read = len(used)
        rows.append((cam, len(gt), read, exact, one_off, false))
        for k, v in zip(("vehicles", "read", "exact", "one_off", "false"), (len(gt), read, exact, one_off, false)):
            total[k] += v
    dur = time.time() - t_start
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    pct = lambda x, y: f"{100 * x / y:.1f}%" if y else "n/a"
    md = ["# ANPR accuracy report", "",
          "Recorded 120-second clips from the four ANPR cameras (synthetic Indian HSRP plates, day scene).",
          "Pipeline: YOLOv9-t plate detector, CCT-S OCR, Indian-format correction, multi-read tracker. CPU only.", "",
          f"**Exact-plate accuracy: {pct(total['exact'], total['vehicles'])}** of {total['vehicles']} vehicles "
          f"({pct(total['exact'] + total['one_off'], total['vehicles'])} within one character; "
          f"character accuracy {pct(total['chars_ok'], total['chars'])}).", "",
          "| Camera | Vehicles | Detected | Exact plate | One character off | Unmatched events | Exact-plate rate |",
          "| --- | --- | --- | --- | --- | --- | --- |"]
    for cam, n, r, ex, o1, f in rows:
        md.append(f"| {cam} | {n} | {r} | {ex} | {o1} | {f} | {pct(ex, n)} |")
    md.append(f"| **All** | {total['vehicles']} | {total['read']} | {total['exact']} | {total['one_off']} | "
              f"{total['false']} | **{pct(total['exact'], total['vehicles'])}** |")
    md += ["", f"Processing time: {dur:.0f} s for {len(rows) * 2} minutes of 720p video on 1 CPU thread "
           f"(sampled at {os.environ.get('ANPR_FPS', '4')} fps).", "",
           "Synthetic footage is cleaner than real roadside video. Real-camera accuracy must be measured "
           "in the pilot on labelled frames from each ANPR camera."]
    (out / "anpr_accuracy.md").write_text("\n".join(md) + "\n")
    (out / "anpr_accuracy.json").write_text(json.dumps({"rows": rows, "total": total}, indent=1))
    print("\n" + "\n".join(md))


if __name__ == "__main__":
    main()
