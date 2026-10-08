# One image for all platform services (api, indexer, adapters, anpr) and the simulators.
# --- React console build (platform/web-react -> dist); the Python image below copies only the built files
FROM node:22-alpine AS web
WORKDIR /src/platform/web-react
COPY platform/web-react/package.json platform/web-react/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY platform/web-react ./
COPY platform/web /src/platform/web
RUN npm run build

FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 fonts-dejavu-core curl espeak-ng \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY platform/requirements.txt /app/platform/requirements.txt
RUN pip install --no-cache-dir -r /app/platform/requirements.txt
# Download ANPR models at build time so the command-centre network needs no internet access.
RUN python -c "from fast_alpr import ALPR; ALPR(detector_model='yolo-v9-t-384-license-plate-end2end', ocr_model='cct-s-v2-global-model')"
COPY platform /app/platform
COPY --from=web /src/platform/web-react/dist /app/platform/web-react/dist
# Bundled COCO detector (Apache-2.0). Fetched here only if the build context lacks it, so a copy made
# without the .onnx still builds a working analytics worker.
RUN test -f /app/platform/models/yolox_nano.onnx || (mkdir -p /app/platform/models && curl -fsSL -o /app/platform/models/yolox_nano.onnx \
    https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx)
# Face models (OpenCV Zoo, Apache-2.0): the SFace recogniser is 38 MB and may be absent from a copied tree.
RUN test -f /app/platform/models/face_recognition_sface_2021dec.onnx || curl -fsSL -o /app/platform/models/face_recognition_sface_2021dec.onnx \
    https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx
RUN test -f /app/platform/models/face_detection_yunet_2023mar.onnx || curl -fsSL -o /app/platform/models/face_detection_yunet_2023mar.onnx \
    https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
COPY config /app/config
COPY scripts /app/scripts
COPY VERSION /app/VERSION
COPY deploy/licensing/vendor_public.pem /app/deploy/licensing/vendor_public.pem
COPY simulators /app/simulators
ENV PYTHONPATH=/app/platform UVP_ROOT=/app DATA_DIR=/data PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "uvp.services.api:app", "--host", "0.0.0.0", "--port", "8000"]
