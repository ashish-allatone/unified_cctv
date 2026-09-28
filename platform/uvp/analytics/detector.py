"""COCO object detector (YOLOX, ONNX Runtime) shared by the analytics worker and the ANPR worker.

Classes kept: person, bicycle, car, motorcycle, bus, truck. Preprocessing follows the YOLOX
ONNX demo (letterbox to 416 with grey 114, raw 0-255 BGR, no normalisation).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from ..config import ROOT, settings

log = logging.getLogger("uvp.analytics.detector")

COCO = ["person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light", "fire hydrant",
        "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe",
        "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite", "baseball bat",
        "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl",
        "banana", "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
        "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave",
        "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"]
KEEP = {"person", "bicycle", "car", "motorcycle", "bus", "truck"}
VEHICLES = {"bicycle", "car", "motorcycle", "bus", "truck"}


@dataclass
class Det:
    cls: str
    conf: float
    bbox: tuple[int, int, int, int]     # x1, y1, x2, y2 in frame pixels

    @property
    def cx(self) -> float:
        return (self.bbox[0] + self.bbox[2]) / 2

    @property
    def cy(self) -> float:
        return (self.bbox[1] + self.bbox[3]) / 2

    @property
    def area(self) -> int:
        return max(0, self.bbox[2] - self.bbox[0]) * max(0, self.bbox[3] - self.bbox[1])


def iou(a: tuple, b: tuple) -> float:
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def contains(outer: tuple, inner: tuple, tol: float = 0.1) -> bool:
    """True when `inner` lies (mostly) inside `outer`; tol is a fraction of inner's size allowed outside."""
    w, h = inner[2] - inner[0], inner[3] - inner[1]
    return (inner[0] >= outer[0] - tol * w and inner[1] >= outer[1] - tol * h and inner[2] <= outer[2] + tol * w
            and inner[3] <= outer[3] + tol * h)


class Detector:
    def __init__(self, model: str | Path | None = None, size: int = 416, conf: float | None = None, threads: int = 1):
        import onnxruntime as ort
        path = Path(model or settings.analytics_model)
        if not path.is_absolute():
            path = ROOT / path
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if settings.anpr_gpu else ["CPUExecutionProvider"]
        self.sess = ort.InferenceSession(str(path), so, providers=providers)
        self.input = self.sess.get_inputs()[0].name
        shp = self.sess.get_inputs()[0].shape
        self.size = int(shp[-1]) if isinstance(shp[-1], int) else size
        self.conf = settings.analytics_conf if conf is None else conf
        self._grid, self._stride = self._grids(self.size)
        # Model family from the output shape:
        #   yolox      [1, N, 85]        raw grid predictions (bundled yolox_nano.onnx, Apache-2.0)
        #   ultralytics_raw [1, 84, 8400] YOLOv8/11/26 export with nms=False: cxcywh + 80 class scores
        #   ultralytics_e2e [1, 300, 6]   YOLO26 / YOLOv10 end-to-end export: xyxy, score, class
        out = self.sess.get_outputs()[0].shape
        dims = [d for d in out if isinstance(d, int)]
        if len(out) == 3 and out[-1] == 6:
            self.family = "ultralytics_e2e"
        elif len(out) == 3 and isinstance(out[1], int) and out[1] in (84, 85) and (not isinstance(out[2], int) or out[2] > out[1]):
            self.family = "ultralytics_raw"
        else:
            self.family = "yolox"
        log.info("detector %s (%dx%d, %s)", path.name, self.size, self.size, self.family)

    @staticmethod
    def _grids(size: int):
        grids, strides = [], []
        for s in (8, 16, 32):
            n = size // s
            yv, xv = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
            grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
            strides.append(np.full((n * n, 1), s))
        return np.concatenate(grids).astype(np.float32), np.concatenate(strides).astype(np.float32)

    def _pre(self, img: np.ndarray):
        h, w = img.shape[:2]
        r = min(self.size / h, self.size / w)
        rs = cv2.resize(img, (max(1, int(w * r)), max(1, int(h * r))), interpolation=cv2.INTER_LINEAR)
        pad = np.full((self.size, self.size, 3), 114, np.uint8)
        pad[:rs.shape[0], :rs.shape[1]] = rs
        return np.ascontiguousarray(pad.transpose(2, 0, 1)[None]).astype(np.float32), r

    def __call__(self, frame: np.ndarray, keep: set[str] | None = None, tiles: int = 1) -> list[Det]:
        """tiles=2 or 3 runs the detector on overlapping tiles as well as the whole frame and merges the
        results: wide overview cameras (a whole junction in one 1080p frame) get 3-5x more small vehicles."""
        if tiles and tiles > 1:
            return self._tiled(frame, keep, int(tiles))
        return self._single(frame, keep)

    def _tiled(self, frame: np.ndarray, keep: set[str] | None, n: int, overlap: float = 0.15) -> list[Det]:
        H, W = frame.shape[:2]
        out = list(self._single(frame, keep))
        tw, th = W / n, H / n
        for i in range(n):
            for j in range(n):
                x1, y1 = int(max(0, (j - overlap) * tw)), int(max(0, (i - overlap) * th))
                x2, y2 = int(min(W, (j + 1 + overlap) * tw)), int(min(H, (i + 1 + overlap) * th))
                for d in self._single(frame[y1:y2, x1:x2], keep):
                    bx1, by1, bx2, by2 = d.bbox
                    out.append(Det(d.cls, d.conf, (bx1 + x1, by1 + y1, bx2 + x1, by2 + y1)))
        return _nms(out, 0.5)

    def _pre_ultra(self, img: np.ndarray):
        """Ultralytics-style letterbox: RGB, 0..1, centred padding (114)."""
        h, w = img.shape[:2]
        r = min(self.size / h, self.size / w)
        nw, nh = max(1, int(round(w * r))), max(1, int(round(h * r)))
        rs = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        pad = np.full((self.size, self.size, 3), 114, np.uint8)
        dx, dy = (self.size - nw) // 2, (self.size - nh) // 2
        pad[dy:dy + nh, dx:dx + nw] = rs
        x = cv2.cvtColor(pad, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        return np.ascontiguousarray(x), r, dx, dy

    def _single_ultra(self, frame: np.ndarray, keep: set[str] | None) -> list[Det]:
        x, r, dx, dy = self._pre_ultra(frame)
        out = self.sess.run(None, {self.input: x})[0]
        h, w = frame.shape[:2]
        dets: list[Det] = []
        if self.family == "ultralytics_e2e":                 # [1, 300, 6] xyxy, score, class
            rows = out[0]
            for x1, y1, x2, y2, cf, c in rows:
                if cf < self.conf:
                    continue
                name = COCO[int(c)] if int(c) < len(COCO) else str(int(c))
                if name not in (keep or KEEP):
                    continue
                bx1, by1 = max(0, int((x1 - dx) / r)), max(0, int((y1 - dy) / r))
                bx2, by2 = min(w, int((x2 - dx) / r)), min(h, int((y2 - dy) / r))
                if bx2 > bx1 and by2 > by1:
                    dets.append(Det(name, float(cf), (bx1, by1, bx2, by2)))
            return dets
        pred = out[0].T                                      # [8400, 84]: cx, cy, w, h, 80 scores
        scores = pred[:, 4:]
        cls = scores.argmax(1)
        conf = scores.max(1)
        m = conf >= self.conf
        for (cx, cy, bw, bh), c, cf in zip(pred[m, :4], cls[m], conf[m]):
            name = COCO[c] if c < len(COCO) else str(c)
            if name not in (keep or KEEP):
                continue
            x1, y1 = max(0, int((cx - bw / 2 - dx) / r)), max(0, int((cy - bh / 2 - dy) / r))
            x2, y2 = min(w, int((cx + bw / 2 - dx) / r)), min(h, int((cy + bh / 2 - dy) / r))
            if x2 > x1 and y2 > y1:
                dets.append(Det(name, float(cf), (x1, y1, x2, y2)))
        return _nms(dets, 0.5)

    def _single(self, frame: np.ndarray, keep: set[str] | None = None) -> list[Det]:
        if self.family != "yolox":
            return self._single_ultra(frame, keep)
        x, r = self._pre(frame)
        out = self.sess.run(None, {self.input: x})[0][0]
        out[:, :2] = (out[:, :2] + self._grid) * self._stride
        out[:, 2:4] = np.exp(out[:, 2:4]) * self._stride
        scores = out[:, 4:5] * out[:, 5:]
        cls = scores.argmax(1)
        conf = scores.max(1)
        m = conf >= self.conf
        boxes = out[m, :4]
        cls, conf = cls[m], conf[m]
        h, w = frame.shape[:2]
        dets: list[Det] = []
        for (cx, cy, bw, bh), c, cf in zip(boxes, cls, conf):
            name = COCO[c] if c < len(COCO) else str(c)
            if name not in (keep or KEEP):
                continue
            x1, y1 = max(0, int((cx - bw / 2) / r)), max(0, int((cy - bh / 2) / r))
            x2, y2 = min(w, int((cx + bw / 2) / r)), min(h, int((cy + bh / 2) / r))
            if x2 > x1 and y2 > y1:
                dets.append(Det(name, float(cf), (x1, y1, x2, y2)))
        return _nms(dets, 0.5)


def _nms(dets: list[Det], thr: float) -> list[Det]:
    dets = sorted(dets, key=lambda d: -d.conf)
    out: list[Det] = []
    for d in dets:
        if all(iou(d.bbox, o.bbox) < thr or d.cls != o.cls for o in out):
            out.append(d)
    return out


_det: Detector | None = None


def detector() -> Detector | None:
    """Shared instance; None when analytics is disabled or the model is missing."""
    global _det
    if _det is None and settings.analytics_enabled:
        try:
            _det = Detector(threads=settings.analytics_threads)
        except Exception as e:  # noqa: BLE001
            log.warning("object detector unavailable: %s", e)
            return None
    return _det
