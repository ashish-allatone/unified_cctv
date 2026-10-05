"""Analytics worker: zone analytics (intrusion, abandoned object, crowd, illegal parking, red light)
on cameras configured in config/analytics.yaml. Reads the relay's copy of the stream (sub profile)
at ANALYTICS_FPS, runs the COCO detector, and publishes incidents with a snapshot.

  python -m uvp.services.analytics_worker                       # live, all configured cameras
  python -m uvp.services.analytics_worker --file clip.mp4 --camera muni-cam2 --department Municipal [--publish]
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import logging
import time
from pathlib import Path

import cv2
import numpy as np
import requests

from .. import metrics as M
from ..analytics.detector import detector
from ..analytics.zones import ZoneAnalyzer
from ..bus import TOPIC_DETS, TOPIC_INCIDENTS, publisher
from .. import detection as DETECT
from ..config import load_yaml, settings
from ..db import Camera, SessionLocal, init_db, new_id
from ..relay import internal_rtsp_url
from .parallel import CameraPool, capture_options, worker_count

capture_options()   # low-latency RTSP reads (before cv2 opens a stream)

log = logging.getLogger("uvp.analytics")
_http = requests.Session()


def _http_get(url: str) -> dict:
    return _http.get(url, timeout=3).json()


class TrafficCounter:
    """Per-camera traffic occupancy: vehicles in view by type, averaged per window (default 60 s), with the
    peak and, when a count line is configured, the number of vehicles that crossed it (flow) by direction.
    Wide overview cameras that cannot read plates still give counts, density and flow this way."""

    VEHICLE = ("car", "bus", "truck", "motorcycle", "bicycle")

    def __init__(self, camera_id: str, cfg: dict):
        self.camera_id = camera_id
        self.window = float(cfg.get("window_s", 60))
        self.polygon = cfg.get("polygon")                 # optional: only count inside this area
        self.line = cfg.get("line")                       # optional: [[x1, y1], [x2, y2]] crossing line (fractions)
        self.reset(0.0)
        self._tracks: dict[int, tuple[float, float, float, str, int]] = {}   # id -> (cx, cy, ts, cls, last side of the line)
        self._next = 1

    def reset(self, ts: float) -> None:
        self.start = ts
        self.frames = 0
        self.sum: dict[str, float] = {}
        self.peak = 0
        self.peak_persons = 0
        self.crossed = {"a_to_b": 0, "b_to_a": 0}

    def _inside(self, cx: float, cy: float, w: int, h: int) -> bool:
        if not self.polygon:
            return True
        import cv2 as _cv
        pts = np.array([[int(x * w), int(y * h)] for x, y in self.polygon], np.int32)
        return _cv.pointPolygonTest(pts, (float(cx), float(cy)), False) >= 0

    def add(self, dets, ts: float, frame_wh: tuple[int, int] = (1920, 1080)) -> dict | None:
        if self.start == 0.0:
            self.start = ts
        w, h = frame_wh
        counts: dict[str, int] = {}
        centres = []
        for d in dets:
            if d.cls not in self.VEHICLE and d.cls != "person":
                continue
            x1, y1, x2, y2 = d.bbox
            cx, cy = (x1 + x2) / 2, y2
            if not self._inside(cx, cy, w, h):
                continue
            counts[d.cls] = counts.get(d.cls, 0) + 1
            centres.append((cx, cy, d.cls))
        veh = sum(v for k, v in counts.items() if k in self.VEHICLE)
        self.peak = max(self.peak, veh)
        self.peak_persons = max(getattr(self, "peak_persons", 0), counts.get("person", 0))
        for k, v in counts.items():
            self.sum[k] = self.sum.get(k, 0.0) + v
        self.frames += 1
        if self.line:
            self._flow(centres, ts, w, h)
        if ts - self.start >= self.window:
            row = {"camera_id": self.camera_id, "ts": dt.datetime.fromtimestamp(self.start, dt.timezone.utc).isoformat(),
                   "window_s": int(self.window), "frames": self.frames,
                   "avg": {k: round(v / max(1, self.frames), 2) for k, v in self.sum.items()},
                   "avg_vehicles": round(sum(v for k, v in self.sum.items() if k in self.VEHICLE) / max(1, self.frames), 2),
                   "peak_vehicles": self.peak, "avg_persons": round(self.sum.get("person", 0.0) / max(1, self.frames), 2),
                   "peak_persons": getattr(self, "peak_persons", 0), "flow": dict(self.crossed) if self.line else None}
            self.reset(ts)
            return row
        return None

    def _flow(self, centres, ts: float, w: int, h: int) -> None:
        """Greedy nearest-neighbour tracking of vehicle centres; count sign changes of the side of the line."""
        (ax, ay), (bx, by) = self.line
        ax, ay, bx, by = ax * w, ay * h, bx * w, by * h

        def side(x, y) -> int:
            v = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
            return 1 if v > 0 else (-1 if v < 0 else 0)
        used = set()
        new: dict[int, tuple[float, float, float, str, int]] = {}
        for cx, cy, cls in centres:
            best, bd = None, 80.0 ** 2
            for tid, (px, py, pts, pcls, _) in self._tracks.items():
                if tid in used or ts - pts > 3.0:
                    continue
                d2 = (px - cx) ** 2 + (py - cy) ** 2
                if d2 < bd:
                    best, bd = tid, d2
            s1 = side(cx, cy)
            if best is None:
                new[self._next] = (cx, cy, ts, cls, s1)
                self._next += 1
            else:
                last = self._tracks[best][4]
                if s1 != 0 and last != 0 and s1 != last:
                    self.crossed["a_to_b" if s1 > 0 else "b_to_a"] += 1
                new[best] = (cx, cy, ts, cls, s1 if s1 != 0 else last)
                used.add(best)
        self._tracks = new


def zone_cameras() -> dict[str, dict]:
    from .. import licensing
    cfg = load_yaml(settings.analytics_file) or {}
    keys = ("intrusion", "abandoned_object", "crowd", "no_parking", "red_light", "traffic")
    zones = {cid: dict(c or {}) for cid, c in (cfg.get("cameras") or {}).items() if any(k in (c or {}) for k in keys)}
    if settings.analytics_count_all:
        # counting is on everywhere: vehicles + persons per minute and a crowd alert on every camera the platform
        # pulls; sources.yaml / analytics.yaml still override per camera (count: false switches it off)
        defaults = {"traffic": {"window_s": 60}, "crowd": {"max_persons": settings.crowd_max_persons, "priority": "medium"}}
        with SessionLocal() as s:
            pulled = [c.id for c in s.query(Camera) if not c.registry_only and c.status != "unlicensed"]
        # only cameras the relay keeps pulling anyway (steady session or recording): opening a capture on any other
        # camera would force a new departmental-gateway session and blow the source's max_concurrent_pulls
        try:
            from ..relay import relay
            steady = {name.split("/")[0] for name, (_src, rec, persist) in relay.configured_paths().items()
                      if name.endswith("/main") and (rec or persist)}
            pulled = [cid for cid in pulled if cid in steady]
        except Exception as e:  # noqa: BLE001
            log.warning("relay not reachable, counting only explicitly configured cameras: %s", e)
            pulled = []
        explicit = cfg.get("cameras") or {}
        for cid in pulled:
            own = dict(explicit.get(cid) or {})
            if own.get("count") is False:
                continue
            merged = {k: v for k, v in defaults.items()}
            merged.update(own)
            if "traffic" not in own:
                merged["traffic"] = defaults["traffic"]
            if "crowd" not in own:
                merged["crowd"] = defaults["crowd"]
            zones[cid] = merged
    limit = int(licensing.load().get("analytics_channels") or 0)
    if limit and len(zones) > limit:
        # licence cap: explicitly configured cameras first, then the rest by id
        explicit_ids = [cid for cid in zones if cid in (cfg.get("cameras") or {})]
        rest = [cid for cid in sorted(zones) if cid not in explicit_ids]
        keep = (explicit_ids + rest)[:limit]
        log.warning("licence allows %d analytics channels; %d wanted - counting on %s", limit, len(zones), keep[-1] if keep else "-")
        zones = {cid: zones[cid] for cid in keep}
    return zones


def snapshot(frame: np.ndarray, inc: dict, ts: dt.datetime, iid: str) -> str:
    day = ts.strftime("%Y-%m-%d")
    folder = settings.data_dir / "crops" / "incidents" / day
    folder.mkdir(parents=True, exist_ok=True)
    fr = frame.copy()
    if inc.get("bbox"):
        x1, y1, x2, y2 = inc["bbox"]
        cv2.rectangle(fr, (x1, y1), (x2, y2), (0, 0, 255), 3)
    cv2.putText(fr, f"{inc['kind']} {inc.get('zone', '')}", (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2)
    scale = 960 / fr.shape[1] if fr.shape[1] > 960 else 1.0
    if scale != 1.0:
        fr = cv2.resize(fr, (int(fr.shape[1] * scale), int(fr.shape[0] * scale)))
    cv2.imwrite(str(folder / f"{iid}.jpg"), fr, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return f"crops/incidents/{day}/{iid}.jpg"


def make_event(camera_id: str, department: str, frame: np.ndarray, inc: dict, ts: dt.datetime) -> dict:
    iid = new_id()
    return {"id": iid, "camera_id": camera_id, "department": department, "ts": ts.isoformat(), "kind": inc["kind"],
            "zone": inc.get("zone", ""), "priority": inc.get("priority", "medium"), "detail": inc.get("detail", {}),
            "bbox": inc.get("bbox"), "snapshot_path": snapshot(frame, inc, ts, iid)}


class Capture:
    """Sub-profile reader at the sampling interval (same drain/retrieve pattern as the ANPR worker)."""

    def __init__(self, camera_id: str, interval: float):
        import threading
        self.url = internal_rtsp_url(camera_id, "sub")
        self.camera_id, self.interval = camera_id, interval
        self.frame, self.frame_ts, self.running = None, 0.0, True
        threading.Thread(target=self.run, daemon=True).start()

    def run(self) -> None:
        backoff = 1
        while self.running:
            self.url = internal_rtsp_url(self.camera_id, "sub")      # re-resolved: the camera may have moved relays
            cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)
                continue
            backoff = 1
            while self.running and cap.grab():
                if time.time() - self.frame_ts >= self.interval:
                    ok, f = cap.retrieve()
                    if ok:
                        self.frame, self.frame_ts = f, time.time()
            cap.release()


# ----------------------------------------------------------------------------- image quality (all cameras)
_quality_ref: dict[str, np.ndarray] = {}
_quality_prev: dict[str, np.ndarray] = {}


def quality_sample(camera_id: str, frame: np.ndarray | None) -> dict:
    """Blur / dark / frozen / tampered verdict for one sampled frame (None = no signal)."""
    if frame is None:
        return {"camera_id": camera_id, "sharpness": 0, "brightness": 0, "frozen": False, "tampered": False, "verdict": "no_signal"}
    g = cv2.cvtColor(cv2.resize(frame, (320, 180)), cv2.COLOR_BGR2GRAY)
    sharp = float(cv2.Laplacian(g, cv2.CV_64F).var())
    bright = float(g.mean())
    prev = _quality_prev.get(camera_id)
    frozen = prev is not None and float(np.abs(g.astype(int) - prev.astype(int)).mean()) < 0.5
    _quality_prev[camera_id] = g
    ref = _quality_ref.get(camera_id)
    if ref is None:
        _quality_ref[camera_id] = g
        tampered = False
    else:
        # scene changed a lot compared with the reference (camera moved / covered); refresh the reference slowly
        diff = float(np.abs(cv2.GaussianBlur(g, (9, 9), 0).astype(int) - cv2.GaussianBlur(ref, (9, 9), 0).astype(int)).mean())
        tampered = diff > 60 and bright > 25
        if not tampered:
            _quality_ref[camera_id] = ((ref.astype(float) * 0.9) + g.astype(float) * 0.1).astype(np.uint8)
    verdict = "ok"
    if bright < 12:
        verdict = "dark"
    elif frozen:
        verdict = "frozen"
    elif tampered:
        verdict = "tampered"
    elif sharp < 15 and bright > 40:
        verdict = "blurry"
    return {"camera_id": camera_id, "sharpness": round(sharp, 1), "brightness": round(bright, 1), "frozen": frozen,
            "tampered": tampered, "verdict": verdict}


def quality_round(frames: dict[str, "np.ndarray | None"]) -> int:
    """One image-quality sample per counted camera from the frame the worker already holds in memory - no extra
    RTSP session is opened (an earlier version opened every camera's stream in turn, which blocked the counting
    loop for minutes and logged in to the gateway once per camera per round). Returns samples posted."""
    n = 0
    for cid, frame in frames.items():
        q = quality_sample(cid, frame)
        M.QUALITY_VERDICT.labels(cid).set(1 if q["verdict"] == "ok" else 0)
        try:
            _http.post(f"{settings.api_url}/internal/quality", json=q, headers={"X-Internal-Secret": settings.internal_secret}, timeout=5)
            n += 1
        except requests.RequestException as e:
            log.warning("quality post failed: %s", e)
    return n


def run_live() -> None:
    init_db()
    M.serve()
    det = detector()
    while det is None:
        log.error("object detector unavailable (ANALYTICS_ENABLED / ANALYTICS_MODEL: %s); retrying in 60 s", settings.analytics_model)
        time.sleep(60)
        det = detector()
    pub = publisher()
    interval = 1.0 / max(0.2, settings.analytics_fps)
    caps: dict[str, Capture] = {}
    zones: dict[str, ZoneAnalyzer] = {}
    counters: dict[str, TrafficCounter | None] = {}
    last_dets_pub: dict[str, float] = {}
    depts: dict[str, str] = {}
    last: dict[str, float] = {}
    stats = collections.Counter()
    refresh = 0.0
    next_quality = time.time() + 20
    wanted: dict[str, dict] = {}
    pool = CameraPool(worker_count(settings.analytics_workers, settings.analytics_threads), "analytics")
    log.info("analytics: %d parallel workers x %d ONNX threads, %.1f fps per camera", pool.workers, settings.analytics_threads, settings.analytics_fps)

    def step(cid: str, frame: np.ndarray, fts: float) -> None:
        """One sampled frame of one camera: detect, publish the overlay, count traffic, run the zone rules."""
        ts = dt.datetime.fromtimestamp(fts, dt.timezone.utc)
        t0 = time.perf_counter()
        dets = det(frame, tiles=int((wanted.get(cid) or {}).get("tiles") or 1))
        stats["frames"] += 1
        M.ANALYTICS_FRAMES.labels(cid).inc()
        if fts - last_dets_pub.get(cid, 0.0) >= 0.4:      # live overlay for the console, at most ~2/s per camera
            last_dets_pub[cid] = fts
            h_, w_ = frame.shape[:2]
            pub.publish(TOPIC_DETS, {"type": "dets", "camera_id": cid, "ts": ts.isoformat(), "w": w_, "h": h_,
                                     "lag_ms": int((time.time() - fts) * 1000), "infer_ms": int((time.perf_counter() - t0) * 1000),
                                     "boxes": [[d.cls, round(float(d.conf), 2), *[int(v) for v in d.bbox]] for d in dets[:80]]})
        tc = counters.get(cid)
        if tc is not None:
            row = tc.add(dets, fts, (frame.shape[1], frame.shape[0]))
            if row is not None:
                pub.publish(TOPIC_INCIDENTS, {"type": "traffic", **row})
                stats["traffic_rows"] += 1
        z = zones.get(cid)
        if z is None:
            return
        for inc in z.step(frame, dets, ts, _http_get):
            ev = make_event(cid, depts.get(cid, ""), frame, inc, ts)
            pub.publish(TOPIC_INCIDENTS, ev)
            stats["incidents"] += 1
            M.INCIDENTS.labels(cid, inc["kind"]).inc()
            log.info("INCIDENT %s %s %s %s", cid, inc["kind"], inc.get("zone", ""), inc.get("detail"))

    while True:
        now = time.time()
        if now > next_quality:
            next_quality = now + settings.quality_interval_s
            try:
                stats["quality"] += quality_round({cid: (cap.frame if time.time() - cap.frame_ts < 30 else None) for cid, cap in caps.items()})
            except Exception:  # noqa: BLE001
                log.exception("quality round failed")
        if now > refresh:
            wanted = zone_cameras()
            with SessionLocal() as s:
                for c in s.query(Camera).all():
                    depts[c.id] = c.department
            for cid, cfg in wanted.items():
                if cid not in caps:
                    caps[cid] = Capture(cid, interval)
                    zones[cid] = ZoneAnalyzer(cid, cfg)
                    counters[cid] = TrafficCounter(cid, cfg.get("traffic") or {}) if cfg.get("traffic") else None
                    log.info("analytics on %s: %s%s", cid, [k for k in cfg if k in ("intrusion", "abandoned_object", "crowd", "no_parking", "red_light", "traffic")],
                             f" (tiles {cfg.get('tiles')})" if cfg.get("tiles") else "")
            for cid in [c for c in caps if c not in wanted]:
                caps.pop(cid).running = False
                zones.pop(cid, None)
                counters.pop(cid, None)
            refresh = now + 60
            if stats:
                log.info("stats %s", dict(stats))
        submitted = False
        for cid, cap in list(caps.items()):
            if not DETECT.allows(cid):            # detection switch off for this camera: no inference, frames are dropped
                last[cid] = cap.frame_ts
                continue
            if cap.frame is None or cap.frame_ts <= last.get(cid, 0) or pool.busy(cid):
                continue
            frame, fts = cap.frame, cap.frame_ts
            if pool.submit(cid, step, frame, fts):        # one frame in flight per camera, cameras in parallel
                last[cid] = fts
                submitted = True
        if not submitted:
            time.sleep(0.02)


def run_file(path: str, camera_id: str, department: str, publish: bool, cfg: dict | None = None) -> list[dict]:
    det = detector()
    if det is None:
        raise SystemExit("object detector unavailable")
    cfg = cfg or (load_yaml(settings.analytics_file).get("cameras") or {}).get(camera_id) or {}
    z = ZoneAnalyzer(camera_id, cfg, cooldown_s=30)
    pub = publisher() if publish else None
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    step = max(1, int(round(fps / max(0.2, settings.analytics_fps))))
    t0 = dt.datetime.now(dt.timezone.utc)
    i, out = 0, []
    while True:
        ok = cap.grab()
        if not ok:
            break
        if i % step == 0:
            ok, frame = cap.retrieve()
            if ok:
                ts = t0 + dt.timedelta(seconds=i / fps)
                for inc in z.step(frame, det(frame), ts):
                    ev = make_event(camera_id, department, frame, inc, ts)
                    out.append(ev)
                    log.info("INCIDENT t=%.1fs %s %s %s", i / fps, inc["kind"], inc.get("zone"), inc.get("detail"))
                    if pub:
                        pub.publish(TOPIC_INCIDENTS, ev)
        i += 1
    log.info("processed %d frames -> %d incidents", i, len(out))
    return out


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--camera", default="file-cam")
    ap.add_argument("--department", default="Police")
    ap.add_argument("--publish", action="store_true")
    a = ap.parse_args()
    if a.file:
        run_file(a.file, a.camera, a.department, a.publish)
    else:
        run_live()


if __name__ == "__main__":
    main()
