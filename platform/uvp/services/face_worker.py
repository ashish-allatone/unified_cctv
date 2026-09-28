"""Face-recognition worker: watches the configured cameras, matches every visible face against the enrolled
persons of interest, and raises a person_match incident (-> alert, notification, wall flash) on a hit.

  python -m uvp.services.face_worker                 # live (cameras from analytics.yaml `face: true`, FACE_CAMERAS)
  python -m uvp.services.face_worker --file clip.mp4 --camera cam06 --department Corp8   # run over a recording

Runs beside the ANPR and analytics workers with the same capture pattern (sub profile, latest frame, cameras
processed in parallel). The gallery (persons + embeddings) is re-read from the database every 30 s, so a person
enrolled in the console is matched within half a minute without a restart.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import logging
import time

import cv2
import numpy as np

from .. import metrics as M
from ..analytics.faces import Gallery, engine
from ..bus import TOPIC_DETS, TOPIC_INCIDENTS, publisher
from ..config import load_yaml, settings
from ..db import Camera, Person, SessionLocal, init_db, utcnow
from .analytics_worker import Capture, make_event
from .parallel import CameraPool, capture_options, worker_count

capture_options()
log = logging.getLogger("uvp.faces")


def face_cameras(all_cameras: list[str]) -> list[str]:
    sel = settings.face_cameras.strip()
    if sel == "all":
        return list(all_cameras)
    if sel:
        return [c.strip() for c in sel.split(",") if c.strip()]
    cfg = load_yaml(settings.analytics_file) or {}
    return [cid for cid, c in (cfg.get("cameras") or {}).items() if (c or {}).get("face")]


def load_gallery() -> Gallery:
    now = utcnow()
    with SessionLocal() as s:
        rows = s.query(Person).filter(Person.active.is_(True)).all()
        persons = [{"id": p.id, "name": p.name, "category": p.category, "priority": p.priority, "reason": p.reason,
                    "reference": p.reference, "departments": list(p.departments or ["*"]), "embeddings": list(p.embeddings or [])}
                   for p in rows if not p.expires_at or p.expires_at > now]
    return Gallery(persons)


def run_live() -> None:
    init_db()
    M.serve()
    eng = engine()
    while eng is None:
        log.error("face engine unavailable (FACE_ENABLED / models in platform/models); retrying in 60 s")
        time.sleep(60)
        eng = engine()
    pub = publisher()
    interval = 1.0 / max(0.2, settings.face_fps)
    caps: dict[str, Capture] = {}
    depts: dict[str, str] = {}
    last: dict[str, float] = {}
    last_alert: dict[tuple[str, str], float] = {}
    stats = collections.Counter()
    gallery = Gallery([])
    refresh = 0.0
    pool = CameraPool(worker_count(settings.face_workers, settings.face_threads), "faces")
    log.info("faces: %d parallel workers, %.1f fps per camera, match threshold %.2f", pool.workers, settings.face_fps, settings.face_match_threshold)

    def step(cid: str, frame: np.ndarray, fts: float) -> None:
        faces = eng.detect(frame)
        faces = [f for f in faces if f["bbox"][2] - f["bbox"][0] >= settings.face_min_px]
        stats["frames"] += 1
        stats["faces"] += len(faces)
        boxes = []
        for f in faces:
            label = "face"
            if len(gallery):
                emb = eng.embed(frame, f["row"])
                person, sim = gallery.match(emb)
                if person is not None and ("*" in person["departments"] or depts.get(cid, "") in person["departments"]):
                    label = f"face:{person['name']} {sim:.2f}"
                    key = (person["id"], cid)
                    if fts - last_alert.get(key, 0.0) >= settings.face_dedupe_s:
                        last_alert[key] = fts
                        x1, y1, x2, y2 = f["bbox"]
                        inc = {"kind": "person_match", "priority": person["priority"], "zone": "",
                               "detail": {"person_id": person["id"], "name": person["name"], "category": person["category"],
                                          "reference": person["reference"], "score": round(sim, 3), "face_px": x2 - x1},
                               "bbox": [x1, y1, x2, y2]}
                        ts = dt.datetime.fromtimestamp(fts, dt.timezone.utc)
                        ev = make_event(cid, depts.get(cid, ""), _annotate(frame, f["bbox"], person["name"], sim), inc, ts)
                        pub.publish(TOPIC_INCIDENTS, ev)
                        stats["matches"] += 1
                        M.INCIDENTS.labels(cid, "person_match").inc()
                        log.info("MATCH %s %s (%s) sim=%.2f face=%dpx", cid, person["name"], person["category"], sim, x2 - x1)
            boxes.append([label, round(f["score"], 2), *f["bbox"]])
        if boxes:
            h_, w_ = frame.shape[:2]
            pub.publish(TOPIC_DETS, {"type": "dets", "camera_id": cid, "ts": dt.datetime.fromtimestamp(fts, dt.timezone.utc).isoformat(),
                                     "w": w_, "h": h_, "kind": "face", "lag_ms": int((time.time() - fts) * 1000), "boxes": boxes})

    while True:
        now = time.time()
        if now > refresh:
            try:
                gallery = load_gallery()
            except Exception:  # noqa: BLE001
                log.exception("gallery reload failed")
            with SessionLocal() as s:
                cams = s.query(Camera).filter(Camera.status != "unlicensed").all()
                depts = {c.id: c.department for c in cams}
            wanted = [c for c in face_cameras([c.id for c in cams]) if c in depts]
            for cid in wanted:
                if cid not in caps:
                    caps[cid] = Capture(cid, interval)
                    log.info("faces on %s", cid)
            for cid in [c for c in caps if c not in wanted]:
                caps.pop(cid).running = False
            refresh = now + 30
            if stats:
                log.info("stats %s · gallery %d embeddings", dict(stats), len(gallery))
        submitted = False
        for cid, cap in list(caps.items()):
            if cap.frame is None or cap.frame_ts <= last.get(cid, 0) or pool.busy(cid):
                continue
            if pool.submit(cid, step, cap.frame, cap.frame_ts):
                last[cid] = cap.frame_ts
                submitted = True
        if not submitted:
            time.sleep(0.02)


def _annotate(frame: np.ndarray, bbox: tuple, name: str, sim: float) -> np.ndarray:
    out = frame.copy()
    x1, y1, x2, y2 = bbox
    cv2.rectangle(out, (x1, y1), (x2, y2), (0, 200, 255), 2)
    cv2.putText(out, f"{name} {sim:.2f}", (x1, max(18, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 200, 255), 2)
    return out


def run_file(path: str, camera_id: str, department: str, publish: bool = False) -> list[dict]:
    eng = engine()
    if eng is None:
        raise SystemExit("face engine unavailable")
    gallery = load_gallery()
    pub = publisher() if publish else None
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    step_n = max(1, int(round(fps / max(0.2, settings.face_fps))))
    t0 = dt.datetime.now(dt.timezone.utc)
    i, out, last_alert = 0, [], {}
    while True:
        ok = cap.grab()
        if not ok:
            break
        if i % step_n == 0:
            ok, frame = cap.retrieve()
            if ok:
                for f in eng.detect(frame):
                    if f["bbox"][2] - f["bbox"][0] < settings.face_min_px or not len(gallery):
                        continue
                    person, sim = gallery.match(eng.embed(frame, f["row"]))
                    if person is None or i / fps - last_alert.get(person["id"], -1e9) < settings.face_dedupe_s:
                        continue
                    last_alert[person["id"]] = i / fps
                    ts = t0 + dt.timedelta(seconds=i / fps)
                    inc = {"kind": "person_match", "priority": person["priority"], "detail": {"person_id": person["id"], "name": person["name"],
                           "category": person["category"], "score": round(sim, 3)}, "bbox": list(f["bbox"])}
                    ev = make_event(camera_id, department, _annotate(frame, f["bbox"], person["name"], sim), inc, ts)
                    out.append(ev)
                    log.info("MATCH t=%.1fs %s sim=%.2f", i / fps, person["name"], sim)
                    if pub:
                        pub.publish(TOPIC_INCIDENTS, ev)
        i += 1
    return out


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--camera", default="file")
    ap.add_argument("--department", default="")
    ap.add_argument("--publish", action="store_true")
    a = ap.parse_args()
    if a.file:
        init_db()
        r = run_file(a.file, a.camera, a.department, a.publish)
        print(f"{len(r)} match(es)")
    else:
        run_live()
