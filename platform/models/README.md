# Bundled models

| File | Purpose | Licence | Source |
| --- | --- | --- | --- |
| `face_detection_yunet_2023mar.onnx` | YuNet face detector (5 landmarks) for persons of interest. | Apache-2.0 | OpenCV Zoo |
| `face_recognition_sface_2021dec.onnx` | SFace 128-d face embeddings; cosine matching. 38 MB — fetched at image build or by `scripts/fetch_models.sh` when missing. | Apache-2.0 | OpenCV Zoo |
| `yolox_nano.onnx` | COCO object detector (person, bicycle, car, motorcycle, bus, truck …) used for vehicle attributes, triple riding, intrusion, crowd and parking analytics. 416×416, ~45 ms on one CPU core. | Apache-2.0 | Megvii YOLOX release 0.1.1rc0 |

Optional (not in the repository zip): `yolo26n.onnx` (640 px) and `yolo26n-416.onnx` — Ultralytics **YOLO26n** end-to-end
exports (40.9 COCO mAP vs ~26 for YOLOX-nano; **AGPL-3.0 / Enterprise licence**). Produce them with
`tools/export_yolo.sh` or copy the files here, then set `ANALYTICS_MODEL=platform/models/yolo26n.onnx` in `.env` and
rebuild (`docker compose build && docker compose up -d`). The detector recognises the `[1, 300, 6]` output automatically.

Optional, downloaded separately (see `docs/analytics.md`): `yolox_tiny.onnx` / `yolox_s.onnx` for higher accuracy on a GPU or
a stronger CPU; a helmet classifier and a make/model classifier (customer-supplied ONNX, contract in `docs/analytics.md`).
ANPR models (plate detector, OCR) are fetched by `fast-alpr` / `rapidocr` at image build time.
