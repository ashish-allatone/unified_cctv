#!/usr/bin/env bash
# Export an Ultralytics YOLO detector to ONNX for the analytics / ANPR workers.
#   tools/export_yolo.sh                    -> yolo26n.onnx (640, end-to-end) + yolo26n-416.onnx
#   tools/export_yolo.sh yolo12x 640        -> platform/models/yolo12x.onnx   (raw head [1,84,8400]; the platform does the NMS)
#   tools/export_yolo.sh yolo26s 640        -> platform/models/yolo26s.onnx   (end-to-end head [1,300,6])
# Any yolov8*/yolo11*/yolo12*/yolo26* weight name works. Needs internet once (pip + weights).
# Then in .env:  ANALYTICS_MODEL=platform/models/<file>.onnx  and rebuild the images.
# Licence: Ultralytics weights are AGPL-3.0 (or Ultralytics Enterprise) - see docs/analytics.md before shipping to a customer.
set -euo pipefail
MODEL="${1:-yolo26n}"; IMG="${2:-}"
cd "$(dirname "$0")/.."
python3 -m venv .venv-yolo >/dev/null 2>&1 || true
. .venv-yolo/bin/activate
pip install -q ultralytics onnx onnxslim onnxruntime
export_one() {   # $1 = imgsz, $2 = output name
  if [[ "$MODEL" == yolo26* ]] || [[ "$MODEL" == yolov10* ]]; then
    yolo export model="${MODEL}.pt" format=onnx imgsz="$1" nms=False >/dev/null     # end-to-end head, no NMS needed
  else
    yolo export model="${MODEL}.pt" format=onnx imgsz="$1" >/dev/null               # raw head; the platform applies NMS
  fi
  mv "${MODEL}.onnx" "platform/models/$2"
  echo "wrote platform/models/$2 ($(du -h "platform/models/$2" | cut -f1))"
}
if [ -n "$IMG" ]; then export_one "$IMG" "${MODEL}.onnx"
else export_one 640 "${MODEL}.onnx"; export_one 416 "${MODEL}-416.onnx"; fi
rm -f "${MODEL}.pt"
echo "now set ANALYTICS_MODEL=platform/models/${MODEL}.onnx in .env and run: docker compose build && docker compose up -d"
