"""Why does ANPR find no plates in a video? Samples frames, runs the detector + OCR with
low thresholds, prints what it sees and saves annotated frames to <video folder>/diag/.

  python diagnose_video.py traffic.mp4 [--frames 20] [--detector yolo-v9-t-640-license-plate-end2end]
"""
import argparse
from pathlib import Path

import cv2
from fast_alpr import ALPR

ap = argparse.ArgumentParser()
ap.add_argument("video")
ap.add_argument("--frames", type=int, default=20)
ap.add_argument("--detector", default="yolo-v9-t-384-license-plate-end2end")
ap.add_argument("--conf", type=float, default=0.15)
a = ap.parse_args()

cap = cv2.VideoCapture(a.video)
n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
print(f"video: {w}x{h}, {n} frames, {cap.get(cv2.CAP_PROP_FPS):.0f} fps")
alpr = ALPR(detector_model=a.detector, ocr_model="cct-s-v2-global-model", detector_conf_thresh=a.conf)
out = Path(a.video).resolve().parent / "diag"
out.mkdir(exist_ok=True)
found = 0
for k in range(a.frames):
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(n * (k + 0.5) / a.frames))
    ok, f = cap.read()
    if not ok:
        continue
    res = alpr.predict(f)
    for r in res:
        bb = r.detection.bounding_box
        text = r.ocr.text if r.ocr else "?"
        conf = r.ocr.confidence if r.ocr else 0
        conf = sum(conf) / len(conf) if isinstance(conf, (list, tuple)) else float(conf or 0)
        print(f"frame {k:2d}: plate box {bb.x2 - bb.x1}x{bb.y2 - bb.y1}px  det={r.detection.confidence:.2f}"
              f"  text={text}  char_conf={conf:.2f}")
        cv2.rectangle(f, (bb.x1, bb.y1), (bb.x2, bb.y2), (0, 255, 255), 3)
        cv2.putText(f, text, (bb.x1, max(30, bb.y1 - 10)), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 255), 3)
    found += len(res)
    if not res:
        print(f"frame {k:2d}: no plate detected")
    cv2.imwrite(str(out / f"frame_{k:02d}.jpg"), f)
print(f"\n{found} plate detections in {a.frames} sample frames; annotated frames saved in {out}")
