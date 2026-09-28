"""Zone analytics on sampled frames: perimeter intrusion, abandoned object, crowd density,
illegal parking and red-light violations. Pure logic (detections in, incidents out) so it can be
unit-tested without video; the worker feeds it frames from the relay.
"""
from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass, field

import cv2
import numpy as np

from .detector import VEHICLES, Det, iou

log = logging.getLogger("uvp.analytics.zones")
IST = dt.timezone(dt.timedelta(minutes=330))


# ----------------------------------------------------------------------------- helpers
def px_polygon(poly: list, w: int, h: int) -> np.ndarray:
    return np.array([[int(x * w), int(y * h)] for x, y in poly], np.int32)


def inside(poly: np.ndarray, x: float, y: float) -> bool:
    return cv2.pointPolygonTest(poly, (float(x), float(y)), False) >= 0


def hours_active(spec: str | None, ts: dt.datetime) -> bool:
    if not spec:
        return True
    a, b = spec.split("-")
    local = ts.astimezone(IST).strftime("%H:%M")
    return (a <= local < b) if a < b else (local >= a or local < b)


@dataclass
class Track:
    id: int
    cls: str
    bbox: tuple
    first: float
    last: float
    hist: list = field(default_factory=list)      # (t, cx, cy)
    flagged: dict = field(default_factory=dict)   # kind -> time flagged (debounce)

    @property
    def cx(self):
        return (self.bbox[0] + self.bbox[2]) / 2

    @property
    def cy(self):
        return (self.bbox[1] + self.bbox[3]) / 2

    def displacement(self, since_s: float) -> float:
        pts = [(x, y) for t, x, y in self.hist if t >= self.last - since_s]
        if len(pts) < 2:
            return 0.0
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return float(np.hypot(max(xs) - min(xs), max(ys) - min(ys)))


class Tracker:
    """IoU association with a short memory; enough for stationary / crossing logic at 1-2 fps."""

    def __init__(self, iou_thr: float = 0.15, max_age_s: float = 3.0):
        self.tracks: dict[int, Track] = {}
        self.next = 1
        self.iou_thr = iou_thr
        self.max_age = max_age_s

    def update(self, dets: list[Det], t: float) -> list[Track]:
        unmatched = list(dets)
        for tr in sorted(self.tracks.values(), key=lambda x: -x.last):
            best, bi = 0.0, -1
            tw, th = tr.bbox[2] - tr.bbox[0], tr.bbox[3] - tr.bbox[1]
            for i, d in enumerate(unmatched):
                if d.cls != tr.cls and not (d.cls in VEHICLES and tr.cls in VEHICLES):
                    continue
                v = iou(d.bbox, tr.bbox)
                # at 1-2 fps a vehicle can move most of its own length between samples: accept a
                # nearby box of similar size when IoU alone is too small
                if v < self.iou_thr:
                    dist = float(np.hypot(d.cx - tr.cx, d.cy - tr.cy))
                    dw, dh = d.bbox[2] - d.bbox[0], d.bbox[3] - d.bbox[1]
                    similar = 0.5 < (dw * dh) / max(1, tw * th) < 2.0
                    if similar and dist < 0.9 * max(tw, th):
                        v = self.iou_thr + 0.05 * (1 - dist / (0.9 * max(tw, th, 1)))   # closer wins, always >= threshold
                if v > best:
                    best, bi = v, i
            if bi >= 0 and best >= self.iou_thr:
                d = unmatched.pop(bi)
                tr.bbox, tr.last, tr.cls = d.bbox, t, d.cls
                tr.hist.append((t, tr.cx, tr.cy))
                tr.hist = tr.hist[-600:]
        for d in unmatched:
            tr = Track(self.next, d.cls, d.bbox, t, t)
            tr.hist.append((t, tr.cx, tr.cy))
            self.tracks[self.next] = tr
            self.next += 1
        for k in [k for k, v in self.tracks.items() if t - v.last > self.max_age]:
            del self.tracks[k]
        return [tr for tr in self.tracks.values() if tr.last == t]


# ----------------------------------------------------------------------------- signal state
def signal_is_red(cfg: dict, frame: np.ndarray, ts: dt.datetime, http_get=None) -> bool | None:
    """None = unknown. roi: red vs green lamp pixels; schedule: fixed cycle; http: ask the ITMS."""
    mode = (cfg or {}).get("mode", "roi")
    if mode == "roi":
        x1, y1, x2, y2 = cfg["roi"]
        h, w = frame.shape[:2]
        crop = frame[int(y1 * h):int(y2 * h), int(x1 * w):int(x2 * w)]
        if crop.size == 0:
            return None
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        hh, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
        lit = (s > 120) & (v > 150)
        red = (lit & ((hh < 10) | (hh > 165))).sum()
        green = (lit & (hh > 40) & (hh < 95)).sum()
        if red + green < 8:
            return None
        return bool(red > green * 1.5)
    if mode == "schedule":
        epoch = dt.datetime.fromisoformat(cfg.get("epoch", "2026-01-01T00:00:00+05:30"))
        cyc = float(cfg.get("cycle_s", 90))
        pos = ((ts - epoch).total_seconds()) % cyc
        return float(cfg.get("red_from_s", 0)) <= pos < float(cfg.get("red_to_s", cyc / 2))
    if mode == "http" and http_get:
        try:
            j = http_get(cfg["url"])
            cur = j
            for part in cfg.get("json_path", "state").split("."):
                cur = cur.get(part) if isinstance(cur, dict) else None
            return str(cur).upper() in [str(x).upper() for x in cfg.get("red_values", ["RED", "R"])]
        except Exception:  # noqa: BLE001
            return None
    return None


# ----------------------------------------------------------------------------- analyser
class ZoneAnalyzer:
    def __init__(self, camera_id: str, cfg: dict, cooldown_s: float = 300):
        self.cam = camera_id
        self.cfg = cfg or {}
        self.tracker = Tracker()
        self.cooldown = cooldown_s
        self.last_fired: dict[str, float] = {}
        self.mog = cv2.createBackgroundSubtractorMOG2(history=400, varThreshold=32, detectShadows=True) if self.cfg.get("abandoned_object") else None
        self.static_blobs: dict[tuple, float] = {}     # rounded (x, y) -> first seen
        self.crossed: dict[int, float] = {}            # track id -> y at previous frame (red light)

    def _fire(self, key: str, t: float) -> bool:
        if t - self.last_fired.get(key, -1e9) < self.cooldown:
            return False
        self.last_fired[key] = t
        return True

    def step(self, frame: np.ndarray, dets: list[Det], ts: dt.datetime, http_get=None) -> list[dict]:
        """One sampled frame -> zero or more incidents {kind, zone, detail, bbox, priority}."""
        t = ts.timestamp()
        h, w = frame.shape[:2]
        out: list[dict] = []
        tracks = self.tracker.update(dets, t)

        # perimeter intrusion
        for z in (self.cfg.get("intrusion") or {}).get("zones", []):
            if not hours_active(z.get("hours"), ts):
                continue
            poly = px_polygon(z["polygon"], w, h)
            classes = set(z.get("classes") or ["person"])
            hits = [tr for tr in tracks if tr.cls in classes and inside(poly, tr.cx, tr.bbox[3])]
            if hits and self._fire(f"intrusion:{z.get('name')}", t):
                tr = hits[0]
                out.append({"kind": "intrusion", "zone": z.get("name", "zone"), "priority": "high", "bbox": list(tr.bbox),
                            "detail": {"class": tr.cls, "count": len(hits), "hours": z.get("hours")}})

        # crowd density
        cr = self.cfg.get("crowd")
        if cr:
            poly = px_polygon(cr["polygon"], w, h) if cr.get("polygon") else None      # no polygon = whole frame
            n = sum(1 for tr in tracks if tr.cls == "person" and (poly is None or inside(poly, tr.cx, tr.bbox[3])))
            if n > int(cr.get("max_persons", 20)) and self._fire("crowd", t):
                out.append({"kind": "crowd", "zone": "crowd", "priority": cr.get("priority", "medium"), "bbox": None,
                            "detail": {"persons": n, "max": int(cr.get("max_persons", 20))}})

        # illegal parking: vehicle stationary inside the polygon for min_seconds
        npk = self.cfg.get("no_parking")
        if npk:
            poly = px_polygon(npk["polygon"], w, h)
            min_s = float(npk.get("min_seconds", 90))
            for tr in tracks:
                if tr.cls not in VEHICLES or not inside(poly, tr.cx, tr.bbox[3]):
                    continue
                if t - tr.first >= min_s and tr.displacement(min_s) < 0.15 * (tr.bbox[2] - tr.bbox[0] + 1) and "parking" not in tr.flagged:
                    tr.flagged["parking"] = t
                    if self._fire(f"parking:{tr.id}", t):
                        out.append({"kind": "illegal_parking", "zone": "no_parking", "priority": npk.get("priority", "low"),
                                    "bbox": list(tr.bbox), "detail": {"class": tr.cls, "stationary_s": round(t - tr.first), "track": tr.id}})

        # red light: vehicle bottom edge crosses stop line downwards/upwards while the signal is red
        rl = self.cfg.get("red_light")
        if rl:
            red = signal_is_red(rl.get("signal"), frame, ts, http_get)
            line = float(rl.get("stop_line_y", 0.6)) * h
            for tr in tracks:
                if tr.cls not in VEHICLES:
                    continue
                prev = self.crossed.get(tr.id)
                cur = tr.bbox[3]
                self.crossed[tr.id] = cur
                if prev is None:
                    continue
                crossed = (prev < line <= cur) or (prev > line >= cur)
                if crossed and red and "red_light" not in tr.flagged:
                    tr.flagged["red_light"] = t
                    out.append({"kind": "red_light", "zone": "stop_line", "priority": "high", "bbox": list(tr.bbox),
                                "detail": {"class": tr.cls, "signal": "red", "track": tr.id, "signal_mode": (rl.get("signal") or {}).get("mode", "roi")}})
            for k in [k for k in self.crossed if k not in self.tracker.tracks]:
                del self.crossed[k]

        # abandoned object: static foreground blob inside the zone, not explained by a person/vehicle, for min_seconds
        ab = self.cfg.get("abandoned_object")
        if ab and self.mog is not None:
            poly = px_polygon(ab["polygon"], w, h)
            small = cv2.resize(frame, (w // 2, h // 2))
            fg = self.mog.apply(small, learningRate=0.002)
            fg = cv2.morphologyEx((fg == 255).astype(np.uint8) * 255, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            n, _, stats, cents = cv2.connectedComponentsWithStats(fg)
            min_area = float(ab.get("min_area", 0.002)) * (w * h) / 4
            seen = set()
            for i in range(1, n):
                if stats[i, cv2.CC_STAT_AREA] < min_area:
                    continue
                cx, cy = cents[i][0] * 2, cents[i][1] * 2
                if not inside(poly, cx, cy):
                    continue
                key = (int(cx // 24), int(cy // 24))
                seen.add(key)
                self.static_blobs.setdefault(key, t)
                explained = any(tr.bbox[0] - 10 <= cx <= tr.bbox[2] + 10 and tr.bbox[1] - 10 <= cy <= tr.bbox[3] + 10 for tr in tracks)
                if not explained and t - self.static_blobs[key] >= float(ab.get("min_seconds", 120)) and self._fire(f"abandoned:{key}", t):
                    x, y, bw, bh = [int(v * 2) for v in stats[i, :4]]
                    out.append({"kind": "abandoned_object", "zone": "abandoned", "priority": ab.get("priority", "high"),
                                "bbox": [x, y, x + bw, y + bh], "detail": {"static_s": round(t - self.static_blobs[key]), "area_px": int(stats[i, cv2.CC_STAT_AREA] * 4)}})
            for k in [k for k in self.static_blobs if k not in seen]:
                del self.static_blobs[k]
        return out
