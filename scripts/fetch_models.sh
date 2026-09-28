#!/usr/bin/env bash
# Download the bundled analytics models when they are missing (e.g. after copying the tree without large files).
#   bash scripts/fetch_models.sh
set -euo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)/platform/models"; mkdir -p "$D"
get() { [[ -s "$D/$1" ]] && { echo "have $1"; return; }; echo "fetching $1"; curl -fsSL -o "$D/$1" "$2"; }
get yolox_nano.onnx https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx
get face_detection_yunet_2023mar.onnx https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
get face_recognition_sface_2021dec.onnx https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx
ls -la "$D"
