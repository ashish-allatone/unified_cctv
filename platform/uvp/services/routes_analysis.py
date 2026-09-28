"""Offline analysis of uploaded videos and photos — evidence that did not come from the platform's cameras
(a bystander's phone video, a shop's DVR export, a WhatsApp clip).

  POST /api/analyses                     multipart: files[] (video or images), plates=1|0, fps -> {id, status}
  GET  /api/analyses                     my recent analyses
  GET  /api/analyses/{id}                status + results: persons found (clusters), plates found, matches
  POST /api/analyses/{id}/enrol          enrol one found person straight from the video: {cluster, name, category, ...}
  GET  /media/analyses/{id}/{name}       crops / key frames (owner or search feature)
  DELETE /api/analyses/{id}

The job samples frames (default 2 fps, at most ANALYSIS_MAX_FRAMES), detects every face, embeds it and groups faces
of the same person by embedding similarity (greedy clustering on the running centroid). For each person found it
keeps the best crops, when they appear, and whether they match an already enrolled person of interest. Plates are
read with the same ANPR pipeline as the live cameras. Enrolling from a cluster reuses its embeddings and crops, so a
person seen only in a phone video is on every face-enabled camera within 30 s.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import logging
import shutil
import threading
import time
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import auth as A
from ..analytics.faces import engine
from ..config import settings
from ..db import Person, SessionLocal, audit, new_id, utcnow
from .deps import _ip, current_user, need

log = logging.getLogger("uvp.analysis")
router = APIRouter()
MAX_UPLOAD = 300 * 1024 * 1024
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm", ".3gp", ".ts"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
CLUSTER_SIM = 0.45          # faces closer than this (cosine) are the same person within one upload
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def analyses_dir() -> Path:
    return settings.data_dir / "analyses"


def _job_path(jid: str) -> Path:
    return analyses_dir() / jid


def _write(jid: str) -> None:
    (_job_path(jid) / "result.json").write_text(json.dumps(_jobs[jid], default=str))


def _load(jid: str) -> dict | None:
    if jid in _jobs:
        return _jobs[jid]
    f = _job_path(jid) / "result.json"
    if f.exists():
        _jobs[jid] = json.loads(f.read_text())
        return _jobs[jid]
    return None


def _public(j: dict) -> dict:
    out = {k: v for k, v in j.items() if k not in ("_embeddings",)}
    out["persons"] = [{k: v for k, v in c.items() if k != "embeddings"} for c in j.get("persons", [])]
    return out


# ----------------------------------------------------------------------------- the analysis itself
def _estimate_frames(files: list[Path], fps: float, max_frames: int) -> int:
    """How many frames the job will look at (for the progress bar)."""
    n = 0
    for f in files:
        if f.suffix.lower() in IMAGE_EXT:
            n += 1
            continue
        cap = cv2.VideoCapture(str(f))
        vfps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        cap.release()
        n += max(1, total // max(1, int(round(vfps / max(0.2, fps)))))
    return min(n, max_frames)


def _frames(files: list[Path], fps: float, max_frames: int):
    """Yield (source_name, t_seconds, frame) from videos (sampled) and images."""
    n = 0
    for f in files:
        if f.suffix.lower() in IMAGE_EXT:
            img = cv2.imread(str(f))
            if img is not None:
                n += 1
                yield f.name, 0.0, img
            continue
        # the live workers set low-latency FFmpeg capture flags process-wide (nobuffer/low_delay); those drop
        # frames when reading a file, so open uploads with FFmpeg's default (complete) decoding instead
        saved_opts = os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
        try:
            cap = cv2.VideoCapture(str(f), cv2.CAP_FFMPEG)
        finally:
            if saved_opts is not None:
                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = saved_opts
        vfps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        step = max(1, int(round(vfps / max(0.2, fps))))
        i = 0
        while n < max_frames:
            ok = cap.grab()
            if not ok:
                break
            if i % step == 0:
                ok, frame = cap.retrieve()
                if ok:
                    n += 1
                    yield f.name, round(i / vfps, 2), frame
            i += 1
        cap.release()
        if n >= max_frames:
            return


def run_analysis(jid: str, files: list[Path], want_plates: bool, fps: float) -> None:
    j = _jobs[jid]
    folder = _job_path(jid)
    eng = engine()
    rec = None
    if want_plates:
        try:
            from .anpr_worker import Recogniser, detect_in_region
            rec = Recogniser()
        except Exception as e:  # noqa: BLE001
            log.warning("plate reader unavailable for analysis: %s", e)
    clusters: list[dict] = []
    cents: list[np.ndarray] = []
    plates: dict[str, dict] = {}
    gallery = None
    try:
        from .face_worker import load_gallery
        gallery = load_gallery()
    except Exception:  # noqa: BLE001
        pass
    frames = 0
    faces_total = 0
    timing = {"decode": 0.0, "faces": 0.0, "plates": 0.0}
    t_start = time.time()

    def work(item):
        """Per-frame inference, run in the pool: face detect + embed, plate reads. Returns what the
        (sequential) clustering step needs. ONNX releases the GIL, so several frames really run at once."""
        src, t, frame = item
        found, dets = [], []
        if eng is not None:
            t0 = time.time()
            for f in eng.detect(frame, max_width=1280):
                x1, y1, x2, y2 = f["bbox"]
                if x2 - x1 < settings.face_min_px:
                    continue
                found.append((f, eng.embed(frame, f["row"])))
            timing["faces"] += time.time() - t0
        if rec is not None:
            t0 = time.time()
            dets = [d for d in detect_in_region(rec, frame, {"roi": None, "upscale": 1}) if d.get("conf", 0) >= 0.6]
            timing["plates"] += time.time() - t0
        return src, t, frame, found, dets

    def results():
        """Bounded parallel map that keeps frame order (so 'first seen' stays right) without decoding the whole
        video into memory: at most 2 x workers frames in flight."""
        from concurrent.futures import ThreadPoolExecutor
        workers = max(1, settings.analysis_workers)
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="analysis") as ex:
            pending = []
            t0 = time.time()
            for item in _frames(files, fps, settings.analysis_max_frames):
                timing["decode"] += time.time() - t0
                pending.append(ex.submit(work, item))
                if len(pending) >= workers * 2:
                    yield pending.pop(0).result()
                t0 = time.time()
            for fut in pending:
                yield fut.result()

    try:
        j["total"] = _estimate_frames(files, fps, settings.analysis_max_frames)
        for src, t, frame, found, dets in results():
            frames += 1
            j["progress"] = frames
            if True:
                for f, emb in found:
                    x1, y1, x2, y2 = f["bbox"]
                    faces_total += 1
                    quality = float(f["score"]) * min(1.0, (x2 - x1) / 120.0)
                    idx = None
                    if cents:
                        sims = np.array([float(np.dot(c, emb)) for c in cents])
                        k = int(np.argmax(sims))
                        if sims[k] >= CLUSTER_SIM:
                            idx = k
                    if idx is None:
                        idx = len(clusters)
                        clusters.append({"cluster": idx, "count": 0, "first_t": t, "last_t": t, "sources": [], "crops": [],
                                         "best_quality": -1.0, "embeddings": [], "face_px": x2 - x1})
                        cents.append(emb.copy())
                    c = clusters[idx]
                    c["count"] += 1
                    c["last_t"] = t
                    if src not in c["sources"]:
                        c["sources"].append(src)
                    # running centroid keeps the cluster stable across pose changes
                    cents[idx] = cents[idx] * 0.8 + emb * 0.2
                    cents[idx] /= float(np.linalg.norm(cents[idx])) or 1.0
                    if len(c["embeddings"]) < 8:
                        c["embeddings"].append([round(float(v), 5) for v in emb])
                    if quality > c["best_quality"] or len(c["crops"]) < 3:
                        m = int((x2 - x1) * 0.4)
                        crop = frame[max(0, y1 - m):y2 + m, max(0, x1 - m):x2 + m]
                        if crop.size:
                            if crop.shape[0] < 160:
                                crop = cv2.resize(crop, None, fx=160 / crop.shape[0], fy=160 / crop.shape[0], interpolation=cv2.INTER_CUBIC)
                            name = f"p{idx}_{len(c['crops'])}.jpg"
                            cv2.imwrite(str(folder / name), crop, [cv2.IMWRITE_JPEG_QUALITY, 88])
                            if quality > c["best_quality"]:
                                c["best_quality"] = quality
                                c["face_px"] = x2 - x1
                                c["best_crop"] = name
                                c["best_t"] = t
                            if len(c["crops"]) < 3:
                                c["crops"].append(name)
                            else:                       # replace the weakest crop by the better one
                                c["crops"][-1] = name
            if dets:
                for d in dets:
                    p = plates.setdefault(d["raw"], {"plate": d["raw"], "count": 0, "best_conf": 0.0, "first_t": t, "last_t": t, "sources": []})
                    p["count"] += 1
                    p["last_t"] = t
                    if src not in p["sources"]:
                        p["sources"].append(src)
                    if d["conf"] > p["best_conf"]:
                        p["best_conf"] = round(float(d["conf"]), 2)
                        x1, y1, x2, y2 = d["bbox"]
                        crop = frame[max(0, y1 - 4):y2 + 4, max(0, x1 - 6):x2 + 6]
                        if crop.size:
                            name = f"plate_{len(plates)}_{d['raw']}.jpg"
                            cv2.imwrite(str(folder / name), crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
                            p["crop"] = name
        # matches against enrolled persons
        for c in clusters:
            c["match"] = None
            if gallery is not None and len(gallery):
                best, best_sim = None, 0.0
                for e in c["embeddings"]:
                    person, sim = gallery.match(np.asarray(e, np.float32))
                    if person is not None and sim > best_sim:
                        best, best_sim = person, sim
                if best is not None:
                    c["match"] = {"person_id": best["id"], "name": best["name"], "category": best["category"], "score": round(best_sim, 3)}
        clusters.sort(key=lambda c: -c["count"])
        for i, c in enumerate(clusters):
            c["rank"] = i + 1
        timing = {k: round(v, 1) for k, v in timing.items()} | {"total": round(time.time() - t_start, 1)}
        j.update({"status": "done", "frames": frames, "faces": faces_total, "persons": clusters, "timing": timing,
                  "plates": sorted(plates.values(), key=lambda p: -p["count"]), "finished_at": utcnow().isoformat(),
                  "face_engine": eng is not None, "plate_reader": rec is not None})
    except Exception as e:  # noqa: BLE001
        log.exception("analysis %s failed", jid)
        j.update({"status": "failed", "error": str(e)[:300]})
    _write(jid)


# ----------------------------------------------------------------------------- endpoints
@router.post("/api/analyses", status_code=202)
def create_analysis(request: Request, files: list[UploadFile] = File(...), plates: int = Form(1), fps: float = Form(2.0),
                    note: str = Form(""), u: A.User = Depends(need("search"))):
    if not files:
        raise HTTPException(400, "upload a video or one or more photos")
    jid = new_id()
    folder = _job_path(jid)
    folder.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    total = 0
    for i, up in enumerate(files):
        ext = Path(up.filename or "").suffix.lower()
        if ext not in VIDEO_EXT | IMAGE_EXT:
            shutil.rmtree(folder, ignore_errors=True)
            raise HTTPException(400, f"{up.filename}: unsupported type (video: mp4/mov/mkv/avi/webm; photo: jpg/png)")
        dest = folder / f"src{i}{ext}"
        with dest.open("wb") as fh:
            while True:
                chunk = up.file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD:
                    shutil.rmtree(folder, ignore_errors=True)
                    raise HTTPException(400, "upload larger than 300 MB")
                fh.write(chunk)
        saved.append(dest)
    with _lock:
        _jobs[jid] = {"id": jid, "status": "running", "owner": u.username, "department": u.departments[0] if u.departments else "*",
                      "created_at": utcnow().isoformat(), "files": [f.filename for f in files], "bytes": total, "note": note[:300],
                      "progress": 0, "persons": [], "plates": []}
        _write(jid)
    with SessionLocal() as s:
        audit(s, u.username, "analysis_upload", jid, f"{len(files)} file(s), {total // 1024} KB, plates={bool(plates)}", _ip(request))
        s.commit()
    threading.Thread(target=run_analysis, args=(jid, saved, bool(plates), max(0.2, min(fps, 10.0))), daemon=True).start()
    return {"id": jid, "status": "running"}


@router.get("/api/analyses")
def list_analyses(u: A.User = Depends(need("search"))):
    out = []
    if analyses_dir().exists():
        for d in sorted(analyses_dir().iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[:50]:
            j = _load(d.name)
            if j and (j.get("owner") == u.username or u.has("admin")):
                out.append({k: j.get(k) for k in ("id", "status", "created_at", "files", "note", "frames", "faces")} | {"persons": len(j.get("persons", [])), "plates": len(j.get("plates", []))})
    return out


@router.get("/api/analyses/{jid}")
def get_analysis(jid: str, u: A.User = Depends(need("search"))):
    j = _load(jid)
    if j is None or not (j.get("owner") == u.username or u.has("admin")):
        raise HTTPException(404, "no such analysis")
    out = _public(j)
    for c in out["persons"]:
        c["crop_urls"] = [f"/media/analyses/{jid}/{n}" for n in c.get("crops", [])]
        c["best_crop_url"] = f"/media/analyses/{jid}/{c['best_crop']}" if c.get("best_crop") else ""
    for p in out["plates"]:
        p["crop_url"] = f"/media/analyses/{jid}/{p['crop']}" if p.get("crop") else ""
    return out


class EnrolFrom(BaseModel):
    cluster: int
    name: str
    category: str = "suspect"
    priority: str = "high"
    reason: str = ""
    reference: str = ""
    days: int = 90


@router.post("/api/analyses/{jid}/enrol", status_code=201)
def enrol_from_analysis(jid: str, body: EnrolFrom, request: Request, u: A.User = Depends(need("watchlist"))):
    """Turn a person found in the uploaded video into a person of interest, reusing its embeddings and crops."""
    j = _load(jid)
    if j is None or j.get("status") != "done":
        raise HTTPException(404, "analysis not found or not finished")
    c = next((c for c in j["persons"] if c["cluster"] == body.cluster), None)
    if c is None or not c.get("embeddings"):
        raise HTTPException(400, "no such person in this analysis")
    if body.category not in ("wanted", "missing", "suspect", "other"):
        raise HTTPException(400, "bad category")
    name = body.name.strip()[:120]
    if len(name) < 2:
        raise HTTPException(400, "name is required")
    pid = new_id()
    dest = settings.data_dir / "persons" / pid
    dest.mkdir(parents=True, exist_ok=True)
    photos = []
    for i, crop in enumerate(c.get("crops", [])[:5], start=1):
        src = _job_path(jid) / crop
        if src.exists():
            shutil.copy(src, dest / f"{i}.jpg")
            photos.append(f"persons/{pid}/{i}.jpg")
    with SessionLocal() as s:
        p = Person(id=pid, name=name, category=body.category, priority=body.priority if body.priority in ("high", "medium", "low") else "high",
                   reason=(body.reason or f"enrolled from uploaded evidence {', '.join(j.get('files', []))[:200]}")[:1000], reference=body.reference[:120],
                   departments=["*"], photos=photos, embeddings=list(c["embeddings"])[:8], added_by=u.username,
                   expires_at=(utcnow() + dt.timedelta(days=body.days)) if body.days > 0 else None)
        s.add(p)
        audit(s, u.username, "person_enrol", pid, f"{name} ({body.category}) from analysis {jid} cluster {body.cluster}, {len(photos)} crop(s)", _ip(request))
        s.commit()
    c["enrolled_person_id"] = pid
    _write(jid)
    return {"id": pid, "name": name, "photos": len(photos), "embeddings": len(c["embeddings"][:8])}


@router.delete("/api/analyses/{jid}")
def delete_analysis(jid: str, request: Request, u: A.User = Depends(need("search"))):
    j = _load(jid)
    if j is None or not (j.get("owner") == u.username or u.has("admin")):
        raise HTTPException(404, "no such analysis")
    shutil.rmtree(_job_path(jid), ignore_errors=True)
    _jobs.pop(jid, None)
    with SessionLocal() as s:
        audit(s, u.username, "analysis_delete", jid, ip=_ip(request))
        s.commit()
    return {"ok": True}


@router.get("/media/analyses/{jid}/{name}")
def analysis_media(jid: str, name: str, u: A.User = Depends(current_user)):
    j = _load(jid)
    if j is None or not (j.get("owner") == u.username or u.has("admin") or u.has("search")):
        raise HTTPException(404)
    f = (_job_path(jid) / name).resolve()
    if analyses_dir().resolve() not in f.parents or not f.exists() or f.suffix.lower() != ".jpg":
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "private, max-age=3600"})
