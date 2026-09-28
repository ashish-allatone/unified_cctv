"""Vehicle attributes for an ANPR event: type, body colour, plate background colour, riders on a
two-wheeler, and an optional customer-supplied make/model or helmet classifier (ONNX).

Type comes from the COCO detector when a detection contains the plate; otherwise from plate
geometry (a two-row, near-square plate is a two-wheeler in India). Colour is the dominant hue of
the body region above the plate, excluding the plate itself and near-black shadow pixels.
"""
from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from ..config import ROOT, settings
from .detector import VEHICLES, Det, contains, detector

log = logging.getLogger("uvp.analytics.attributes")

TYPE_MAP = {"car": "car", "motorcycle": "two_wheeler", "bicycle": "bicycle", "bus": "bus", "truck": "truck"}
COLOURS = ["white", "silver", "black", "red", "blue", "yellow", "green", "orange", "brown", "grey"]


# ----------------------------------------------------------------------------- colour
def colour_name(bgr_region: np.ndarray) -> tuple[str, float]:
    """Dominant colour name and the share of pixels that voted for it."""
    if bgr_region.size == 0:
        return "unknown", 0.0
    small = cv2.resize(bgr_region, (48, max(1, int(48 * bgr_region.shape[0] / max(1, bgr_region.shape[1])))))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(int)
    h, s, v = hsv[:, 0], hsv[:, 1], hsv[:, 2]
    votes = {c: 0 for c in COLOURS}
    for hh, ss, vv in zip(h, s, v):
        if vv < 50:
            votes["black"] += 1
        elif ss < 45:
            votes["white" if vv > 185 else ("silver" if vv > 120 else "grey")] += 1
        elif hh < 8 or hh >= 170:
            votes["red"] += 1
        elif hh < 20:
            votes["orange" if vv > 150 else "brown"] += 1
        elif hh < 35:
            votes["yellow"] += 1
        elif hh < 85:
            votes["green"] += 1
        elif hh < 135:
            votes["blue"] += 1
        else:
            votes["red"] += 1
    total = max(1, len(h))
    best = max(votes, key=votes.get)
    return best, round(votes[best] / total, 2)


def plate_colour(plate_crop: np.ndarray) -> str:
    """Background colour of the plate: white (private), yellow (commercial), green (EV), black (rental) or other."""
    if plate_crop.size == 0:
        return "unknown"
    hsv = cv2.cvtColor(plate_crop, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    n = h.size
    yellow = ((h >= 15) & (h <= 40) & (s > 80) & (v > 90)).sum() / n
    green = ((h >= 45) & (h <= 90) & (s > 70) & (v > 60)).sum() / n
    white = ((s < 60) & (v > 150)).sum() / n
    black = (v < 70).sum() / n
    best = max((yellow, "yellow"), (green, "green"), (white, "white"), (black, "black"))
    return best[1] if best[0] > 0.3 else "other"


# ----------------------------------------------------------------------------- vehicle region + type
def body_region(frame: np.ndarray, plate_bbox: tuple, vehicle_bbox: tuple | None) -> np.ndarray:
    """Pixels used for colour: the vehicle detection minus the plate row, or a box above the plate."""
    x1, y1, x2, y2 = plate_bbox
    pw, ph = x2 - x1, y2 - y1
    H, W = frame.shape[:2]
    if vehicle_bbox:
        vx1, vy1, vx2, vy2 = vehicle_bbox
        # exclude the bottom 20% (road, shadow) and shrink sides
        ix = int((vx2 - vx1) * 0.15)
        reg = frame[max(0, vy1):max(0, y1 - ph // 2) if y1 - ph // 2 > vy1 + 10 else int(vy1 + (vy2 - vy1) * 0.8), vx1 + ix:vx2 - ix]
        if reg.size:
            return reg
    top = max(0, y1 - int(ph * 3.0))
    left, right = max(0, x1 - pw), min(W, x2 + pw)
    return frame[top:max(top + 1, y1 - ph // 3), left:right]


def vehicle_for_plate(dets: list[Det], plate_bbox: tuple) -> Det | None:
    cands = [d for d in dets if d.cls in VEHICLES and contains(d.bbox, plate_bbox, tol=0.3)]
    if not cands:
        return None
    return min(cands, key=lambda d: d.area)   # tightest box around the plate


def riders_on(dets: list[Det], bike: Det) -> int:
    """Persons whose box overlaps a two-wheeler box substantially (triple riding = 3+)."""
    n = 0
    bx1, by1, bx2, by2 = bike.bbox
    for p in dets:
        if p.cls != "person":
            continue
        px1, py1, px2, py2 = p.bbox
        ix = max(0, min(px2, bx2) - max(px1, bx1))
        if ix / max(1, px2 - px1) > 0.5 and py2 > by1 and py1 < by2:
            n += 1
    return n


def geometry_type(plate_bbox: tuple, two_row: bool) -> str:
    w, h = plate_bbox[2] - plate_bbox[0], plate_bbox[3] - plate_bbox[1]
    if two_row or (h > 0 and w / h < 2.2):
        return "two_wheeler"
    return "light_vehicle"


# ----------------------------------------------------------------------------- optional classifiers (customer models)
class OnnxClassifier:
    """Generic image classifier: ONNX with one NCHW float input (RGB 0-1, ImageNet mean/std) and one
    logits output; labels one per line in a .txt next to the model. Used for make/model and helmet."""

    def __init__(self, model: Path, labels: Path | None = None, size: int = 224):
        import onnxruntime as ort
        self.sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
        self.input = self.sess.get_inputs()[0].name
        shp = self.sess.get_inputs()[0].shape
        self.size = int(shp[-1]) if isinstance(shp[-1], int) else size
        lab = labels or model.with_suffix(".txt")
        self.labels = [x.strip() for x in lab.read_text().splitlines() if x.strip()] if lab.exists() else []

    def __call__(self, bgr: np.ndarray) -> tuple[str, float]:
        x = cv2.resize(bgr, (self.size, self.size))[:, :, ::-1].astype(np.float32) / 255.0
        x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
        out = self.sess.run(None, {self.input: np.ascontiguousarray(x.transpose(2, 0, 1)[None])})[0][0]
        out = np.exp(out - out.max())
        out /= out.sum()
        i = int(out.argmax())
        return (self.labels[i] if i < len(self.labels) else str(i)), float(out[i])


_mm: OnnxClassifier | None | bool = None
_helmet: OnnxClassifier | None | bool = None


def _load(setting: str):
    if not setting:
        return None
    p = Path(setting)
    if not p.is_absolute():
        p = ROOT / p
    if not p.exists():
        log.warning("classifier model not found: %s", p)
        return None
    try:
        return OnnxClassifier(p)
    except Exception as e:  # noqa: BLE001
        log.warning("classifier failed to load (%s): %s", p, e)
        return None


def make_model_classifier():
    global _mm
    if _mm is None:
        _mm = _load(settings.analytics_make_model_model) or False
    return _mm or None


def helmet_classifier():
    global _helmet
    if _helmet is None:
        _helmet = _load(settings.analytics_helmet_model) or False
    return _helmet or None


# ----------------------------------------------------------------------------- entry point
def vehicle_attributes(frame: np.ndarray, plate_bbox: tuple, plate_crop: np.ndarray, two_row: bool = False) -> dict:
    """Everything we can say about the vehicle behind one plate read."""
    out: dict = {"vehicle_type": geometry_type(plate_bbox, two_row), "type_source": "plate_geometry"}
    dets: list[Det] = []
    det = detector()
    veh = None
    if det is not None:
        try:
            dets = det(frame)
        except Exception as e:  # noqa: BLE001
            log.warning("detector failed: %s", e)
        veh = vehicle_for_plate(dets, plate_bbox)
        if veh:
            out["vehicle_type"] = TYPE_MAP.get(veh.cls, veh.cls)
            out["type_source"] = "detector"
            out["vehicle_bbox"] = list(veh.bbox)
            out["type_conf"] = round(veh.conf, 2)
            if veh.cls == "motorcycle":
                out["riders"] = riders_on(dets, veh)
    colour, share = colour_name(body_region(frame, plate_bbox, veh.bbox if veh else None))
    out["vehicle_colour"], out["colour_conf"] = colour, share
    out["plate_colour"] = plate_colour(plate_crop)
    mm = make_model_classifier()
    if mm and veh is not None:
        x1, y1, x2, y2 = veh.bbox
        try:
            label, conf = mm(frame[y1:y2, x1:x2])
            out["make_model"], out["make_model_conf"] = label, round(conf, 2)
        except Exception as e:  # noqa: BLE001
            log.warning("make/model failed: %s", e)
    hc = helmet_classifier()
    if hc and veh is not None and veh.cls == "motorcycle":
        riders = [p for p in dets if p.cls == "person" and contains(veh.bbox, (p.bbox[0], veh.bbox[1], p.bbox[2], veh.bbox[3]), 0.5)]
        verdicts = []
        for p in riders:
            x1, y1, x2, y2 = p.bbox
            head = frame[y1:y1 + max(8, (y2 - y1) // 3), x1:x2]
            try:
                label, conf = hc(head)
                verdicts.append((label, round(conf, 2)))
            except Exception:  # noqa: BLE001
                pass
        if verdicts:
            out["helmet"] = verdicts
            out["no_helmet"] = any(l.lower().replace(" ", "_") in ("no_helmet", "without_helmet", "nohelmet") and c >= 0.6 for l, c in verdicts)
    return out
