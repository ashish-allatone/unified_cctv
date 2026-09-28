"""ANPR worker.

Live mode (default): reads the MAIN profile of every ANPR-enabled camera from
the platform relay (never from the departmental VMS directly), so ANPR adds
zero load on departmental systems.

Recorded mode: `python -m uvp.services.anpr_worker --file clip.mp4 --camera police-cam1 [--publish]`
runs the same pipeline on a video file (e.g. an export from a departmental VMS).

Pipeline per camera: frame sampler (ANPR_FPS) -> motion gate -> plate detector
(YOLOv9) -> OCR -> Indian-format correction -> multi-read tracker -> one event
per vehicle pass -> bus.
"""
from __future__ import annotations

import argparse
import hashlib
import collections
import contextlib
import datetime as dt
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

from ..bus import TOPIC_ANPR, TOPIC_DETS, publisher
from ..config import settings
from .. import metrics as M
from ..analytics.attributes import vehicle_attributes
from ..pii import blur_faces
from ..db import Camera, SessionLocal, init_db, new_id
from ..plates import STATE_CODES, correct, home_state_fix, home_state_prefix, levenshtein, trim_to_plate
from ..relay import internal_rtsp_url
from .parallel import CameraPool, capture_options, worker_count

capture_options()   # low-latency RTSP reads (before cv2 opens a stream)
log = logging.getLogger("uvp.anpr")


# ----------------------------------------------------------------------------- recogniser
class Recogniser:
    def __init__(self):
        import onnxruntime as ort
        from fast_alpr import ALPR

        def opts():
            o = ort.SessionOptions()
            o.intra_op_num_threads = settings.anpr_threads  # keep CPU use predictable on shared hosts
            o.inter_op_num_threads = 1
            return o
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if settings.anpr_gpu else ["CPUExecutionProvider"]
        self.alpr = ALPR(detector_model=settings.anpr_detector, ocr_model=settings.anpr_ocr,
                         detector_conf_thresh=settings.anpr_det_conf, detector_providers=providers,
                         detector_sess_options=opts(), ocr_providers=providers, ocr_sess_options=opts(),
                         ocr_device="cuda" if settings.anpr_gpu else "cpu")
        # one Recogniser is shared by the worker threads: ONNX Runtime sessions run concurrently, and the
        # per-read scratch state (_all_raws, used for RTO digit voting) is thread-local, so no lock is needed
        self.lock = contextlib.nullcontext()
        self._tls = threading.local()
        self.paddle = None
        if settings.anpr_ocr_engine in ("paddle", "both"):
            try:
                from rapidocr_onnxruntime import RapidOCR  # PaddleOCR PP-OCR models on ONNX Runtime
                self.paddle = RapidOCR(intra_op_num_threads=settings.anpr_threads)
            except Exception as e:  # noqa: BLE001
                log.warning("PaddleOCR (rapidocr) unavailable, using fast-plate-ocr only: %s", e)

    def _rec_line(self, img: np.ndarray) -> tuple[str, list[float]]:
        """PaddleOCR text recogniser only (no text-box search): fast, for one line of text."""
        if img.shape[0] < 4 or img.shape[1] < 4:
            return "", []
        s = 48 / img.shape[0]
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
        res, _ = self.paddle(img, use_det=False, use_cls=False, use_rec=True)
        if not res:
            return "", []
        text, scores = "", []
        for t, sc in ((r[0], float(r[1])) for r in res):
            t = "".join(ch for ch in t.upper() if ch.isalnum())
            text += t
            scores += [sc] * len(t)
        return text, scores

    @property
    def _all_raws(self) -> list[tuple[str, str]]:
        raws = getattr(self._tls, "raws", None)
        if raws is None:
            raws = self._tls.raws = []
        return raws

    @_all_raws.setter
    def _all_raws(self, value: list[tuple[str, str]]) -> None:
        self._tls.raws = value

    def _prep(self, raw: str, chars: list[float], engine: str = "paddle") -> tuple[str, list[float]]:
        """Clean one OCR read (row order, stickers, home-state letter) and remember it for RTO voting."""
        raw = home_state_prefix(raw, settings.anpr_home_states or [])
        trimmed = trim_to_plate(raw)
        if trimmed != raw:  # keep per-character confidences aligned with the trimmed text
            start = raw.find(trimmed)
            chars = chars[start:start + len(trimmed)] if start >= 0 else chars[:len(trimmed)]
            raw = trimmed
        raw = home_state_prefix(raw, settings.anpr_home_states or [])
        self._all_raws.append((raw, engine))
        return raw, chars

    def _rto_vote(self, plate: str, raw: str) -> str:
        """If the chosen read had an AMBIGUOUS letter where the RTO digits are (a 'Z' that is really a '4'),
        use the digit other PaddleOCR reads of the same plate saw there. Letters that map to one obvious
        digit (O->0, I->1, S->5, B->8, G->6) are kept as that digit and never voted on."""
        if len(plate) < 4 or plate[:2] not in STATE_CODES or plate[:2] == "DL" or len(raw) < 4:
            return plate
        out = list(plate)
        for pos in (2, 3):
            if raw[pos].isdigit() or raw[pos] in "ODQILSBG":
                continue
            votes: dict[str, int] = collections.Counter(
                r[pos] for r, eng in self._all_raws
                if eng == "paddle" and len(r) > pos and r[:2] == plate[:2] and r[pos].isdigit())
            if votes:
                out[pos] = votes.most_common(1)[0][0]
        return "".join(out)

    def _read_paddle(self, img: np.ndarray, square: bool):
        """PaddleOCR in three steps, cheapest first; stop as soon as a valid Indian plate comes out.
        1. whole plate as one line (single-line plates)   ~30 ms
        2. top row + bottom row read separately (two-line plates)   ~35 ms
        3. full PaddleOCR with its own text-line detection   ~450 ms, only when 1-2 fail
        """
        cands = []

        def whole():
            return [self._rec_line(img)]

        def two_rows():
            top, bottom = split_halves(img)
            t, b = self._rec_line(top), self._rec_line(bottom)
            # normal reading order first; bottom-then-top in case the rows were mis-ordered
            return [(t[0] + b[0], t[1] + b[1]), (b[0] + t[0], b[1] + t[1])]

        steps = [two_rows, whole] if square else [whole, two_rows]
        for step in steps:
            for raw, chars in step():
                raw, chars = self._prep(raw, chars)
                if len(raw) >= 4:
                    fix = correct(raw)
                    c = (fix.valid, -fix.corrections, float(np.mean(chars)) if chars else 0.0, raw, chars[:len(raw)])
                    if fix.valid and fix.corrections == 0:
                        return (c[0], c[2], c[3], c[4])  # read cleanly as a valid plate: done
                    cands.append(c)
        s = 128 / max(img.shape[0], 1)
        big = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC) if s > 1 else img
        res, _ = self.paddle(big)
        if res:
            lines = plate_lines(res)
            orders = [lines] + ([lines[::-1]] if 1 < len(lines) <= 3 else [])
            for ls in orders:
                raw = "".join(ch for _, t, _ in ls for ch in t.upper() if ch.isalnum())
                chars = [float(sc) for _, t, sc in ls for ch in t if ch.isalnum()]
                raw, chars = self._prep(raw, chars)
                if len(raw) >= 4:
                    fix = correct(raw)
                    cands.append((fix.valid, -fix.corrections, float(np.mean(chars)), raw, chars[:len(raw)]))
        if not cands:
            return None
        # valid first, then the read that needed the fewest letter<->digit corrections, then confidence
        best = max(cands, key=lambda c: (c[0], c[1], c[2]))
        return (best[0], best[2], best[3], best[4])

    def _read(self, img: np.ndarray):
        r = self.alpr.ocr.predict(img)
        if not r or not r.text:
            return None
        raw = r.text.replace("_", "")
        c = r.confidence
        chars = [float(x) for x in c][:len(raw)] if isinstance(c, (list, tuple, np.ndarray)) else [float(c)] * len(raw)
        raw, chars = self._prep(raw, chars, engine="fastplate")
        fix = correct(raw)
        return (fix.valid, float(np.mean(chars)) if chars else 0.0, raw, chars)

    def _detect(self, frame: np.ndarray) -> list[tuple[int, int, int, int, float]]:
        """Plate boxes in frame coordinates. With ANPR_TILES=n>1 the frame is also cut into n x n
        overlapping tiles; each tile reaches the detector at n times the scale, so small plates show up."""
        boxes = [(d.bounding_box.x1, d.bounding_box.y1, d.bounding_box.x2, d.bounding_box.y2, float(d.confidence))
                 for d in self.alpr.detector.predict(frame)]
        n = settings.anpr_tiles
        if n > 1:
            h, w = frame.shape[:2]
            tw, th = int(w / n * 1.25), int(h / n * 1.25)  # 25% overlap so plates on a seam are whole in one tile
            for i in range(n):
                for j in range(n):
                    x0 = min(max(0, int(j * w / n - (tw - w / n) / 2)), w - tw)
                    y0 = min(max(0, int(i * h / n - (th - h / n) / 2)), h - th)
                    for d in self.alpr.detector.predict(frame[y0:y0 + th, x0:x0 + tw]):
                        b = d.bounding_box
                        boxes.append((b.x1 + x0, b.y1 + y0, b.x2 + x0, b.y2 + y0, float(d.confidence)))
        return nms(boxes)

    def read_plate(self, crop: np.ndarray, night: bool = False):
        """Read one plate crop -> (plate text, confidence, per-character confidences) or None."""
        bh, bw = crop.shape[:2]
        crop = mask_stickers(crop)
        variants = [crop]
        if settings.anpr_upscale and crop.shape[0] < settings.anpr_crop_min_h:
            variants.append(enhance(crop, settings.anpr_crop_min_h))
        self._all_raws = []
        cands = []  # (valid, engine rank, conf, raw, chars): valid format first, then PaddleOCR, then conf
        if self.paddle is not None:
            crops = [crop, enhance_night_crop(crop)] if night else [crop]
            for cimg in crops:
                r = self._read_paddle(cimg, square=bw / max(bh, 1) < 2.8)
                if r:
                    cands.append((r[0], 1, r[1], r[2], r[3]))
                    if r[0] and r[1] > 0.9:
                        break  # confident valid read: skip the enhanced copy
        need_fallback = not cands or not cands[0][0]
        use_fast = settings.anpr_ocr_engine in ("fastplate", "both") or self.paddle is None or need_fallback
        for v in variants:  # the small model is cheap (~5 ms): always read, as a second opinion
            for r in (self._read(v), self._read(split_rows(v)) if bw / max(bh, 1) < 2.8 else None):
                if r and use_fast:
                    cands.append((r[0], 0, r[1], r[2], r[3]))
        if not cands:
            return None
        valid, _rank, conf, raw, chars = max(cands, key=lambda c: (c[0], c[1], c[2]))
        chosen = raw
        raw = correct(raw).plate
        if settings.anpr_home_states:  # e.g. MP: a look-alike 'H' in 'HP..' becomes 'M'
            raw = home_state_fix(raw, chars, settings.anpr_home_states, settings.anpr_home_state_max_conf)
        voted = self._rto_vote(raw, chosen)
        # direct[i]: the character was read as-is (or voted from real digit reads), not guessed by the corrector
        direct = [len(chosen) == len(raw) and (chosen[i] == raw[i] or voted[i] != raw[i] or i < 2)
                  for i in range(len(raw))]
        return voted, conf, chars, direct

    def __call__(self, frame: np.ndarray) -> list[dict]:
        out = []
        h, w = frame.shape[:2]
        night = is_night(frame)
        det_frame = enhance_night_frame(frame) if night else frame
        with self.lock:
            for x1b, y1b, x2b, y2b, det_conf in self._detect(det_frame):
                bw, bh = x2b - x1b, y2b - y1b
                if bw < 8 or bh < 4:
                    continue
                # small margin so characters at the plate edge are not clipped by a tight box
                px, py = int(bw * 0.06), int(bh * 0.10)
                crop = frame[max(0, y1b - py):min(h, y2b + py), max(0, x1b - px):min(w, x2b + px)]
                r = self.read_plate(crop, night)
                if r is None:
                    continue
                raw, conf, chars, direct = r
                out.append({"raw": raw, "conf": conf, "char_conf": chars, "det_conf": det_conf,
                            "bbox": (x1b, y1b, x2b, y2b), "night": night, "direct": direct})
        return out


def plate_lines(res: list) -> list:
    """Order OCR text boxes as a plate is read: rows top to bottom, left to right within a row."""
    items = []
    for box, text, score in res:
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        alnum = [ch for ch in str(text) if ch.isalnum()]
        if len(alnum) <= 1 and h > 0 and w / h < 1.4:
            continue  # a lone round/square blob (sticker, emoji, screw) is not plate text
        if float(score) < 0.3:
            continue
        items.append(((min(ys) + max(ys)) / 2, max(ys) - min(ys), min(xs), text, score))
    items.sort(key=lambda t: t[0])
    rows: list[list] = []
    for it in items:
        if rows and abs(it[0] - rows[-1][0][0]) < 0.5 * max(it[1], rows[-1][0][1]):
            rows[-1].append(it)
        else:
            rows.append([it])
    return [(None, it[3], it[4]) for row in rows for it in sorted(row, key=lambda t: t[2])]


def mask_stickers(crop: np.ndarray) -> np.ndarray:
    """Paint over small, round, brightly coloured blobs (emoji / stickers) with the plate background.
    A yellow commercial plate is not touched: its yellow fills the crop, not a small circle in it."""
    h, w = crop.shape[:2]
    if h < 12 or w < 12:
        return crop
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    colourful = cv2.inRange(hsv, (0, 110, 110), (180, 255, 255))
    n, labels, stats, cents = cv2.connectedComponentsWithStats(colourful, 8)
    out = None
    for k in range(1, n):
        x, y, bw, bh, area = stats[k]
        if area < 0.004 * h * w or area > 0.25 * h * w:
            continue
        if not (0.6 < bw / max(bh, 1) < 1.6) or area / float(bw * bh) < 0.55:
            continue  # not round-ish and filled
        if out is None:
            out = crop.copy()
            bg = np.median(crop[colourful == 0].reshape(-1, 3), axis=0) if (colourful == 0).any() else (128, 128, 128)
        pad = max(1, int(0.06 * max(bw, bh)))
        cv2.rectangle(out, (max(0, x - pad), max(0, y - pad)), (min(w, x + bw + pad), min(h, y + bh + pad)),
                      tuple(int(v) for v in bg), -1)
    return out if out is not None else crop


def is_night(frame: np.ndarray) -> bool:
    """Low-light colour footage (dark) or infrared footage (grey, almost no colour) counts as night."""
    if settings.anpr_night == "on":
        return True
    if settings.anpr_night == "off":
        return False
    small = cv2.resize(frame, (160, 90))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    luma, sat = float(hsv[:, :, 2].mean()), float(hsv[:, :, 1].mean())
    return luma < settings.anpr_night_luma or (sat < 12 and luma < 140)


def _gamma(img: np.ndarray, g: float) -> np.ndarray:
    lut = np.clip(((np.arange(256) / 255.0) ** g) * 255.0, 0, 255).astype(np.uint8)
    return cv2.LUT(img, lut)


def enhance_night_frame(frame: np.ndarray) -> np.ndarray:
    """Brighten shadows and boost local contrast so the detector can see plates in the dark."""
    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
    lab[:, :, 0] = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(lab[:, :, 0])
    return _gamma(cv2.cvtColor(lab, cv2.COLOR_LAB2BGR), 0.7)


def enhance_night_crop(crop: np.ndarray) -> np.ndarray:
    """Night plate crop: tame IR/headlight glare on reflective plates, or lift a dark plate; then
    contrast (CLAHE) and denoise. Returned as 3-channel so every OCR engine accepts it."""
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    m = float(g.mean())
    g = _gamma(g, 2.2 if m > 185 else (0.5 if m < 70 else 1.0))
    g = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(4, 4)).apply(g)
    g = cv2.fastNlMeansDenoising(g, None, h=7, templateWindowSize=5, searchWindowSize=15)
    return cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)


def nms(boxes: list, iou_thr: float = 0.4) -> list:
    """Drop duplicate boxes (same plate found in the full frame and in a tile), keeping the most confident."""
    keep = []
    for b in sorted(boxes, key=lambda b: -b[4]):
        ok = True
        for k in keep:
            ix = max(0, min(b[2], k[2]) - max(b[0], k[0]))
            iy = max(0, min(b[3], k[3]) - max(b[1], k[1]))
            inter = ix * iy
            union = (b[2] - b[0]) * (b[3] - b[1]) + (k[2] - k[0]) * (k[3] - k[1]) - inter
            if union and inter / union > iou_thr:
                ok = False
                break
        if ok:
            keep.append(b)
    return keep


def enhance(crop: np.ndarray, min_h: int) -> np.ndarray:
    """Upscale a small plate crop (bicubic), boost local contrast (CLAHE) and sharpen (unsharp mask)."""
    s = min_h / max(crop.shape[0], 1)
    big = cv2.resize(crop, (max(1, int(crop.shape[1] * s)), min_h), interpolation=cv2.INTER_CUBIC)
    lab = cv2.cvtColor(big, cv2.COLOR_BGR2LAB)
    lab[:, :, 0] = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4)).apply(lab[:, :, 0])
    big = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
    blur = cv2.GaussianBlur(big, (0, 0), 1.2)
    return cv2.addWeighted(big, 1.6, blur, -0.6, 0)


def split_halves(crop: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Cut a two-line plate at the emptiest row between the text lines."""
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    h = g.shape[0]
    _, b = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    rows = b.sum(1).astype(float)
    lo, hi = int(h * 0.35), max(int(h * 0.65), int(h * 0.35) + 1)
    cut = lo + int(np.argmin(rows[lo:hi]))
    return crop[:cut], crop[cut:]


def split_rows(crop: np.ndarray) -> np.ndarray:
    """Two-line plate -> one line: cut at the emptiest row between the text lines, join the halves."""
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    h = g.shape[0]
    _, b = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    rows = b.sum(1).astype(float)
    lo, hi = int(h * 0.35), max(int(h * 0.65), int(h * 0.35) + 1)
    cut = lo + int(np.argmin(rows[lo:hi]))
    top, bot = crop[:cut], crop[cut:]
    if top.shape[0] < 2 or bot.shape[0] < 2:
        return crop
    H = max(top.shape[0], bot.shape[0])
    top = cv2.resize(top, (max(1, int(top.shape[1] * H / top.shape[0])), H))
    bot = cv2.resize(bot, (max(1, int(bot.shape[1] * H / bot.shape[0])), H))
    return np.hstack([top, bot])


# ----------------------------------------------------------------------------- tracker
@dataclass
class Read:
    plate: str
    raw: str
    valid: bool
    conf: float
    ts: float
    bbox: tuple
    frame: np.ndarray
    chars: list = field(default_factory=list)
    night: bool = False
    direct: list = field(default_factory=list)


@dataclass
class Track:
    reads: list[Read] = field(default_factory=list)

    @property
    def last(self) -> Read:
        return self.reads[-1]

    def consensus(self) -> tuple[str, Read]:
        """Character-level vote across all reads of one vehicle, weighted by per-character confidence.

        Each read is noisy in a different place, so voting per position recovers plates that no single
        read got fully right. Falls back to a whole-string vote if the voted string is not a valid plate.
        """
        pool = [r for r in self.reads if r.valid] or self.reads
        lengths: dict[int, float] = collections.defaultdict(float)
        for r in pool:
            lengths[len(r.plate)] += r.conf
        n = max(lengths, key=lengths.get)
        same = [r for r in pool if len(r.plate) == n]
        voted = []
        for i in range(n):
            direct: dict[str, float] = collections.defaultdict(float)   # character read as-is
            guessed: dict[str, float] = collections.defaultdict(float)  # letter<->digit guess by the corrector
            for r in same:
                w = r.chars[i] if i < len(r.chars) else r.conf
                was_direct = r.direct[i] if i < len(r.direct) else True
                (direct if was_direct else guessed)[r.plate[i]] += w
            pool_i = direct or guessed  # any real read of this position outranks every guess
            voted.append(max(pool_i, key=pool_i.get))
        fix = correct("".join(voted))
        if fix.valid:
            plate = fix.plate
        else:
            votes: dict[str, float] = collections.defaultdict(float)
            for r in self.reads:
                votes[r.plate] += r.conf * (1.5 if r.valid else 0.5)
            plate = max(votes, key=votes.get)
            # Nothing valid: if most reads agree on the state + RTO code, show that and mark the
            # rest unreadable (decorative font, damaged or hidden plate) instead of a random string.
            heads = collections.Counter(r.plate[:4] for r in self.reads
                                        if len(r.plate) >= 4 and r.plate[:2] in STATE_CODES and r.plate[2:4].isdigit())
            if heads:
                head, n_head = heads.most_common(1)[0]
                if n_head >= max(2, 0.3 * len(self.reads)):
                    plate = head + "????"
        best = min(self.reads, key=lambda r: (levenshtein(r.plate, plate, 4), -r.conf))
        return plate, best

    def direction(self) -> str:
        if len(self.reads) < 2:
            return "unknown"
        a, b = self.reads[0].bbox, self.reads[-1].bbox
        wa, wb = a[2] - a[0], b[2] - b[0]
        if wb < wa * 0.85:
            return "away"
        if wb > wa * 1.15:
            return "towards"
        return "crossing"


class CameraTracker:
    def __init__(self, camera_id: str, department: str, emit):
        self.camera_id, self.department, self.emit = camera_id, department, emit
        self.tracks: list[Track] = []
        self.recent: dict[str, float] = {}  # plate -> last emitted ts (dedupe window)

    def add(self, dets: list[dict], frame: np.ndarray, ts: float) -> None:
        for d in dets:
            fix = correct(d["raw"])
            if len(fix.plate) < 6 or d["conf"] < settings.anpr_min_char_conf:
                continue
            rd = Read(fix.plate, d["raw"], fix.valid, d["conf"], ts, d["bbox"], frame, d.get("char_conf", []),
                      bool(d.get("night")), d.get("direct", []))
            best, best_d = None, 99
            for t in self.tracks:
                dist = levenshtein(t.last.plate, rd.plate, 3)
                if dist < best_d and (dist <= 2 or self._near(t.last.bbox, rd.bbox)):
                    best, best_d = t, dist
            if best is None:
                self.tracks.append(Track([rd]))
            else:
                best.reads.append(rd)
        self.flush(ts)

    @staticmethod
    def _near(a, b) -> bool:
        ax, ay = (a[0] + a[2]) / 2, (a[1] + a[3]) / 2
        bx, by = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        return abs(ax - bx) < (a[2] - a[0]) * 1.5 and abs(ay - by) < (a[3] - a[1]) * 4

    def flush(self, now: float, force: bool = False) -> None:
        keep = []
        for t in self.tracks:
            if force or now - t.last.ts > settings.anpr_track_gap_s:
                self._finish(t)
            else:
                keep.append(t)
        self.tracks = keep

    def _finish(self, t: Track) -> None:
        try:
            self._finish_inner(t)
        except Exception:  # noqa: BLE001
            log.exception("%s: could not emit event for %s", self.camera_id, t.last.plate if t.reads else "?")

    def _finish_inner(self, t: Track) -> None:
        plate, best = t.consensus()
        if settings.anpr_home_states:  # the voted plate gets the same home-state rule as single reads
            plate = home_state_fix(plate, best.chars, settings.anpr_home_states, settings.anpr_home_state_max_conf)
        if len(t.reads) < 2 and best.conf < 0.9:
            return  # single weak read: likely noise
        prev = self.recent.get(plate)
        if prev is not None and t.reads[0].ts - prev < settings.anpr_dedupe_s:
            return
        self.recent[plate] = t.last.ts
        self.emit(self._event(plate, best, t))

    def _event(self, plate: str, best: Read, t: Track) -> dict:
        eid = new_id()
        ts = dt.datetime.fromtimestamp(t.reads[0].ts, dt.timezone.utc)
        day = ts.strftime("%Y-%m-%d")
        folder = settings.crops_dir / day
        folder.mkdir(parents=True, exist_ok=True)
        x1, y1, x2, y2 = best.bbox
        h, w = best.frame.shape[:2]
        pad = 6
        crop = best.frame[max(0, y1 - pad):min(h, y2 + pad), max(0, x1 - pad):min(w, x2 + pad)]
        if crop.shape[1] and crop.shape[1] < 160:            # far-away plates: enlarge the saved crop so operators can read it
            f = 160 / crop.shape[1]
            crop_out = cv2.resize(crop, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
        else:
            crop_out = crop
        cv2.imwrite(str(folder / f"{eid}_plate.jpg"), crop_out, [cv2.IMWRITE_JPEG_QUALITY, 90])
        fr = best.frame.copy()
        if settings.pii_blur_faces:      # riders / pedestrians in the evidence frame are not the subject
            try:
                fr, _ = blur_faces(fr)
            except Exception as e:  # noqa: BLE001
                log.warning("face blur failed (%s); saving the frame unblurred", e)
        cv2.rectangle(fr, (x1, y1), (x2, y2), (0, 255, 255), 3)
        cv2.putText(fr, plate, (x1, max(20, y1 - 10)), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 2)
        scale = 960 / w if w > 960 else 1.0
        if scale != 1.0:
            fr = cv2.resize(fr, (int(w * scale), int(h * scale)))
        cv2.imwrite(str(folder / f"{eid}_frame.jpg"), fr, [cv2.IMWRITE_JPEG_QUALITY, 80])
        attrs = {}
        if settings.analytics_enabled:
            try:
                attrs = vehicle_attributes(best.frame, best.bbox, crop)
            except Exception as e:  # noqa: BLE001
                log.warning("vehicle attributes failed: %s", e)
        tags = ["night"] if any(r.night for r in t.reads) else []
        return {"id": eid, "camera_id": self.camera_id, "department": self.department, "ts": ts.isoformat(),
                "plate": plate, "plate_raw": best.raw, "plate_valid": correct(plate).valid,
                "confidence": round(best.conf, 4), "reads": len(t.reads), "direction": t.direction(),
                "crop_path": f"crops/{day}/{eid}_plate.jpg", "frame_path": f"crops/{day}/{eid}_frame.jpg",
                "tags": tags, "attrs": attrs}


# ----------------------------------------------------------------------------- live capture
class Capture(threading.Thread):
    """Drains an RTSP stream at full rate but only converts the frames the sampler asks for.

    grab() keeps the decoder in sync (cheap); retrieve() does the costly colour conversion and
    runs only when `due()` says a new sample is needed.
    """

    def __init__(self, camera_id: str, interval: float, url: str | None = None):
        super().__init__(daemon=True)
        self.camera_id = camera_id
        self.fixed_url = url
        self.url = url or internal_rtsp_url(camera_id, "main")
        self.frame: np.ndarray | None = None
        self.frame_ts = 0.0
        self.interval = interval
        self.running = True
        self.connected = False

    def due(self) -> bool:
        return time.time() - self.frame_ts >= self.interval

    def run(self) -> None:
        backoff = 1
        while self.running:
            if not self.fixed_url:
                self.url = internal_rtsp_url(self.camera_id, "main")   # the camera may have moved to another relay
            cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                self.connected = False
                log.warning("%s: cannot open relay stream, retry in %ss", self.camera_id, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)
                continue
            log.info("%s: connected to %s", self.camera_id, "camera" if settings.edge else "relay")
            self.connected, backoff = True, 1
            M.ANPR_STREAM_UP.labels(self.camera_id).set(1)
            while self.running:
                if not cap.grab():
                    break
                if self.due():
                    ok, f = cap.retrieve()
                    if ok:
                        self.frame, self.frame_ts = f, time.time()
            cap.release()
            self.connected = False
            M.ANPR_STREAM_UP.labels(self.camera_id).set(0)
            log.warning("%s: stream ended, reconnecting", self.camera_id)
            time.sleep(1)


def motion_key(frame: np.ndarray) -> np.ndarray:
    """Small, contrast-normalised grey picture for the motion gate. Histogram equalisation makes a dark
    night frame and a bright day frame comparable, so moving vehicles register at any brightness."""
    return cv2.equalizeHist(cv2.cvtColor(cv2.resize(frame, (160, 90)), cv2.COLOR_BGR2GRAY))


def moving(prev: np.ndarray | None, cur: np.ndarray, thresh: float = 3.0) -> bool:
    if prev is None:
        return True
    return float(np.mean(cv2.absdiff(motion_key(cur), prev))) > thresh


def detect_in_region(rec, frame: np.ndarray, cfg: dict | None) -> list[dict]:
    """Run the recogniser on the camera's ANPR region (optionally enlarged) and return detections in
    full-frame coordinates, so crops, evidence frames and tracking all stay on the original picture."""
    cfg = cfg or {}
    roi, up = cfg.get("roi"), float(cfg.get("upscale") or 1.0)
    h, w = frame.shape[:2]
    x1 = y1 = 0
    region = frame
    if roi and len(roi) == 4:
        fx, fy, fw, fh = roi
        x1, y1 = int(max(0.0, fx) * w), int(max(0.0, fy) * h)
        x2, y2 = int(min(1.0, fx + fw) * w), int(min(1.0, fy + fh) * h)
        if x2 - x1 > 32 and y2 - y1 > 32:
            region = frame[y1:y2, x1:x2]
        else:
            x1 = y1 = 0
    if up > 1.01:
        region = cv2.resize(region, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    dets = rec(region)
    if up > 1.01 or x1 or y1:
        for d in dets:
            bx1, by1, bx2, by2 = d["bbox"]
            d["bbox"] = (int(bx1 / up) + x1, int(by1 / up) + y1, int(bx2 / up) + x1, int(by2 / up) + y1)
    return dets


def _in_shard(camera_id: str) -> bool:
    """ANPR_SHARD=i/n: several workers split the cameras deterministically."""
    try:
        i, n = (int(x) for x in settings.anpr_shard.split("/"))
    except ValueError:
        return True
    if n <= 1:
        return True
    return int(hashlib.sha256(camera_id.encode()).hexdigest(), 16) % n == i


def _edge_cameras() -> dict[str, str]:
    """EDGE_CAMERAS="cam-id=rtsp://user:pass@camera/stream,..." -> direct camera URLs (no relay)."""
    out = {}
    for part in (settings.edge_cameras or "").split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def run_live() -> None:
    if not settings.edge:
        init_db()
    M.serve()
    rec = Recogniser()
    pub = publisher()
    caps: dict[str, Capture] = {}
    trackers: dict[str, CameraTracker] = {}
    last_proc: dict[str, float] = {}
    last_small: dict[str, np.ndarray] = {}
    stats = collections.Counter()
    refresh_at = 0.0
    interval = 1.0 / settings.anpr_fps

    def emit(ev: dict) -> None:
        if settings.edge:
            ev = attach_media(ev)
        pub.publish(TOPIC_ANPR, ev)
        stats["events"] += 1
        M.ANPR_EVENTS.labels(ev["camera_id"], ev["department"]).inc()
        log.info("EVENT %s %s conf=%.2f reads=%d dir=%s", ev["camera_id"], ev["plate"], ev["confidence"],
                 ev["reads"], ev["direction"])

    edge = _edge_cameras() if settings.edge else {}
    anpr_cfgs: dict[str, dict] = {}
    logged_cfg: set[str] = set()
    last_forced: dict[str, float] = {}
    pool = CameraPool(worker_count(settings.anpr_workers, settings.anpr_threads), "anpr")
    log.info("anpr: %d parallel workers x %d ONNX threads, %.1f fps per camera", pool.workers, settings.anpr_threads, settings.anpr_fps)

    def step(cid: str, frame: np.ndarray, fts: float) -> None:
        """One sampled frame of one camera: motion gate, plate detection + OCR, overlay, tracker."""
        tracker = trackers.get(cid)
        if tracker is None:
            return
        is_moving = moving(last_small.get(cid), frame)
        last_small[cid] = motion_key(frame)
        # never skip for long: a slow or distant vehicle barely moves the picture, so process at least one
        # frame every 2 s regardless of the gate
        if not is_moving and fts - last_forced.get(cid, 0.0) < 2.0:
            stats["skipped_static"] += 1
            tracker.flush(fts)
            return
        last_forced[cid] = fts
        t0 = time.perf_counter()
        dets = detect_in_region(rec, frame, anpr_cfgs.get(cid))
        M.ANPR_LATENCY.observe(time.perf_counter() - t0)
        M.ANPR_FRAMES.labels(cid).inc()
        stats["frames"] += 1
        if dets:
            M.ANPR_READS.labels(cid).inc(len(dets))
            pub.publish(TOPIC_DETS, {"type": "dets", "camera_id": cid, "ts": dt.datetime.fromtimestamp(fts, dt.timezone.utc).isoformat(),
                                     "w": frame.shape[1], "h": frame.shape[0], "kind": "plate",
                                     "lag_ms": int((time.time() - fts) * 1000), "infer_ms": int((time.perf_counter() - t0) * 1000),
                                     "boxes": [["plate:" + d["raw"], round(float(d["conf"]), 2), *[int(v) for v in d["bbox"]]] for d in dets]})
        tracker.add(dets, frame, fts)

    while True:
        now = time.time()
        if now > refresh_at:
            if settings.edge:
                wanted = {cid: type("C", (), {"department": settings.edge_department})() for cid in edge}
            else:
                with SessionLocal() as s:
                    cams = s.query(Camera).filter(Camera.anpr_enabled.is_(True)).all()
                    anpr_cfgs = {c.id: dict(c.anpr_cfg or {}) for c in cams}
                    for cid_, cfg_ in anpr_cfgs.items():
                        if cfg_ and cid_ not in logged_cfg:
                            logged_cfg.add(cid_)
                            log.info("%s: ANPR region %s upscale x%s", cid_, cfg_.get("roi", "full frame"), cfg_.get("upscale", 1))
                from .. import licensing
                allowed = licensing.allowed_anpr(licensing.load(), [c.id for c in cams if c.status != "unlicensed"])
                wanted = {c.id: c for c in cams if _in_shard(c.id) and c.id in allowed}
                if len(allowed) < len(cams):
                    log.warning("licence allows %d ANPR channels; %d cameras have ANPR enabled", len(allowed), len(cams))
            for cid, c in wanted.items():
                if cid not in caps:
                    fps_override = (anpr_cfgs.get(cid) or {}).get("fps")
                    caps[cid] = Capture(cid, (1.0 / fps_override) if fps_override else interval, url=edge.get(cid))
                    caps[cid].start()
                    trackers[cid] = CameraTracker(cid, c.department, emit)
            for cid in list(caps):
                if cid not in wanted:
                    caps.pop(cid).running = False
                    trackers.pop(cid).flush(now, force=True)
            refresh_at = now + 30
            if stats:
                log.info("stats %s", dict(stats))
        submitted = False
        for cid, cap in list(caps.items()):
            if cap.frame is None or cap.frame_ts <= last_proc.get(cid, 0) or pool.busy(cid):
                continue
            frame, fts = cap.frame, cap.frame_ts
            if pool.submit(cid, step, frame, fts):        # one frame in flight per camera, cameras in parallel
                last_proc[cid] = fts
                submitted = True
        if not submitted:
            for cid, t in list(trackers.items()):
                if not pool.busy(cid):
                    t.flush(time.time())
            time.sleep(0.02)


def attach_media(ev: dict) -> dict:
    """Edge mode: the central API has no access to this node's disk, so ship the crop and frame inline."""
    import base64
    out = dict(ev)
    for key in ("crop_path", "frame_path"):
        p = settings.data_dir / ev.get(key, "")
        if ev.get(key) and p.exists():
            out[key.replace("_path", "_b64")] = base64.b64encode(p.read_bytes()).decode()
    return out


# ----------------------------------------------------------------------------- recorded mode
def run_file(path: str, camera_id: str, department: str, publish: bool, out_json: str | None) -> list[dict]:
    if publish:
        init_db()
    rec = Recogniser()
    pub = publisher() if publish else None
    events: list[dict] = []

    def emit(ev: dict) -> None:
        events.append(ev)
        if pub:
            pub.publish(TOPIC_ANPR, ev)
        print(f"{ev['ts'][11:19]}  {ev['plate']:<11} conf={ev['confidence']:.2f} reads={ev['reads']} "
              f"dir={ev['direction']}", flush=True)

    tr = CameraTracker(camera_id, department, emit)
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 15
    step = max(1, round(fps / settings.anpr_fps))
    base = time.time()
    i = 0
    t0 = time.time()
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if i % step == 0:
            ts = base + i / fps
            tr.add(rec(f), f, ts)
        i += 1
    tr.flush(base + i / fps + 60, force=True)
    print(f"processed {i} frames ({i / fps:.0f}s of video) in {time.time() - t0:.0f}s -> {len(events)} vehicles")
    if out_json:
        with open(out_json, "w") as fh:
            json.dump([{**e, "video_offset_s": round(dt.datetime.fromisoformat(e["ts"]).timestamp() - base, 1)}
                       for e in events], fh, indent=1)
    return events


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--camera", default="recorded")
    ap.add_argument("--department", default="Recorded")
    ap.add_argument("--publish", action="store_true", help="send events from --file to the platform")
    ap.add_argument("--json", help="write events to this JSON file")
    a = ap.parse_args()
    if a.file:
        run_file(a.file, a.camera, a.department, a.publish, a.json)
    else:
        run_live()


if __name__ == "__main__":
    main()
