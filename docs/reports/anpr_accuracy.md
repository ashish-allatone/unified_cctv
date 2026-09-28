# ANPR accuracy report

Recorded 120-second clips from the four ANPR cameras (synthetic Indian HSRP plates, day scene), CPU only.
Pipeline: YOLOv9-t plate detector -> PaddleOCR PP-OCRv4 recogniser (row-by-row for two-line plates,
full PaddleOCR as fallback, fast-plate-ocr as last resort) -> Indian-format correction -> character-level
voting across all reads of a vehicle.

**Exact-plate accuracy: 98.1%** of 155 vehicles (152 exact; character accuracy 99.9%).

| Camera | Vehicles | Detected | Exact plate | One character off | Exact-plate rate |
| --- | --- | --- | --- | --- | --- |
| police-cam1 | 35 | 35 | 34 | 1 | 97.1% |
| police-cam2 | 36 | 35 | 34 | 1 | 94.4% |
| muni-cam1 | 41 | 41 | 41 | 0 | 100.0% |
| muni-cam2 | 43 | 43 | 43 | 0 | 100.0% |
| **All** | 155 | 154 | 152 | 2 | **98.1%** |

History on the same clips: fast-plate-ocr only 82.6% -> with voting and two-line handling 88.4% -> PaddleOCR 98.1%.

Real two-line motorcycle plates (5 crops from a user video): fast-plate-ocr 0/5, EasyOCR 0/5, PaddleOCR 3/5.

Speed: about 1x real time per camera at 4 fps sampling on one CPU thread. Use ANPR_THREADS=2+ or a GPU for many cameras.
Synthetic footage is cleaner than real roadside video; measure real accuracy on labelled frames from each camera.
