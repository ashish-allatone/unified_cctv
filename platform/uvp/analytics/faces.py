"""Face detection, embedding and matching for persons of interest.

Models (OpenCV Zoo, Apache-2.0, bundled in platform/models):
  face_detection_yunet_2023mar.onnx     YuNet face detector (5 landmarks), ~80 ms per 720p frame on one CPU core
  face_recognition_sface_2021dec.onnx   SFace 128-d embedding, ~70 ms per face; cosine similarity for matching

Enrolment: one or more photos of a person -> one embedding per photo (the largest face in each photo).
Matching: a live face is compared with every enrolled embedding; the best cosine similarity above
FACE_MATCH_THRESHOLD (default 0.40; OpenCV's published SFace threshold is 0.363) is a match. Several photos per
person raise recall on pose/lighting; one photo works, with a slightly higher miss rate.

Faces need to be roughly frontal and >= FACE_MIN_PX wide (default 32 px) — a plate-facing lane camera or an
entrance camera gives that, a wide junction overview does not.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path

import cv2
import numpy as np

from ..config import ROOT, settings

log = logging.getLogger("uvp.faces")
DET_MODEL = ROOT / "platform" / "models" / "face_detection_yunet_2023mar.onnx"
REC_MODEL = ROOT / "platform" / "models" / "face_recognition_sface_2021dec.onnx"
_engine = None
_lock = threading.Lock()


class FaceEngine:
    def __init__(self, det_model: Path = DET_MODEL, rec_model: Path = REC_MODEL, score: float | None = None):
        self.det = cv2.FaceDetectorYN.create(str(det_model), "", (320, 320), score or settings.face_det_score, 0.3, 500)
        self.rec = cv2.FaceRecognizerSF.create(str(rec_model), "")
        self._size = (320, 320)
        self._lk = threading.Lock()

    # ---- detection
    def detect(self, frame: np.ndarray, max_width: int = 960) -> list[dict]:
        """Faces in a BGR frame: [{bbox: (x1,y1,x2,y2), score, row}] in frame coordinates. Frames wider than
        max_width are downscaled for the detector (speed); boxes are mapped back."""
        h, w = frame.shape[:2]
        scale = 1.0
        img = frame
        if w > max_width:
            scale = max_width / w
            img = cv2.resize(frame, (max_width, int(h * scale)), interpolation=cv2.INTER_AREA)
        with self._lk:                                   # FaceDetectorYN keeps the input size as state
            if (img.shape[1], img.shape[0]) != self._size:
                self._size = (img.shape[1], img.shape[0])
                self.det.setInputSize(self._size)
            _, faces = self.det.detect(img)
        out = []
        for row in (faces if faces is not None else []):
            r = row.copy()
            r[:14] = r[:14] / scale                        # x, y, w, h + 5 landmarks back to frame scale
            x, y, bw, bh = r[:4]
            out.append({"bbox": (int(x), int(y), int(x + bw), int(y + bh)), "score": float(r[14]), "row": r})
        return out

    # ---- embedding
    def embed(self, frame: np.ndarray, row: np.ndarray) -> np.ndarray:
        """128-d L2-normalised SFace embedding of one detected face (row = detector output for that face)."""
        aligned = self.rec.alignCrop(frame, row)
        feat = self.rec.feature(aligned).reshape(-1).astype(np.float32)
        n = float(np.linalg.norm(feat)) or 1.0
        return feat / n

    def enrol_image(self, img: np.ndarray, min_px: int | None = None) -> tuple[np.ndarray, tuple[int, int, int, int], int]:
        """Embedding of the largest face in an enrolment photo -> (embedding, bbox, faces_found).
        Raises ValueError when no usable face is found."""
        faces = self.detect(img, max_width=1600)
        min_px = min_px or settings.face_min_px
        faces = [f for f in faces if f["bbox"][2] - f["bbox"][0] >= min_px]
        if not faces:
            raise ValueError(f"no face of at least {min_px} px found in the photo")
        best = max(faces, key=lambda f: (f["bbox"][2] - f["bbox"][0]) * (f["bbox"][3] - f["bbox"][1]))
        return self.embed(img, best["row"]), best["bbox"], len(faces)


def engine() -> FaceEngine | None:
    """Shared engine; None when disabled or the models are missing."""
    global _engine
    if not settings.face_enabled:
        return None
    with _lock:
        if _engine is None:
            try:
                _engine = FaceEngine()
            except Exception as e:  # noqa: BLE001
                log.warning("face engine unavailable: %s", e)
                return None
    return _engine


# ---- matching helpers (pure numpy, usable without the models)
def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / ((np.linalg.norm(a) * np.linalg.norm(b)) or 1.0))


class Gallery:
    """Enrolled embeddings as one matrix for fast matching: rows = embeddings, owner[i] = person id."""

    def __init__(self, persons: list[dict]):
        rows, owners, meta = [], [], {}
        for p in persons:
            for e in p.get("embeddings") or []:
                v = np.asarray(e, np.float32)
                n = float(np.linalg.norm(v)) or 1.0
                rows.append(v / n)
                owners.append(p["id"])
            meta[p["id"]] = p
        self.mat = np.vstack(rows) if rows else np.zeros((0, 128), np.float32)
        self.owner = owners
        self.meta = meta

    def __len__(self) -> int:
        return len(self.owner)

    def match(self, emb: np.ndarray, threshold: float | None = None) -> tuple[dict | None, float]:
        """Best person for an embedding: (person meta, similarity) or (None, best) below the threshold."""
        if not len(self):
            return None, 0.0
        sims = self.mat @ (emb / (float(np.linalg.norm(emb)) or 1.0))
        i = int(np.argmax(sims))
        best = float(sims[i])
        thr = settings.face_match_threshold if threshold is None else threshold
        return (self.meta[self.owner[i]], best) if best >= thr else (None, best)
