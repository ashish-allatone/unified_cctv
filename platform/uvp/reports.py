"""ANPR accuracy reporting: operator reviews (confirm / correct) per read, weekly per-camera report,
misread review queue and the retraining set export (crops + corrected labels)."""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
import zipfile
from pathlib import Path

from sqlalchemy import func, select

from .config import settings
from .db import AnprEvent, Camera, PlateReview, SessionLocal, utcnow


def week_bounds(weeks_ago: int = 0) -> tuple[dt.datetime, dt.datetime]:
    now = utcnow()
    monday = (now - dt.timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    start = monday - dt.timedelta(weeks=weeks_ago)
    return start, start + dt.timedelta(days=7)


def weekly(s, weeks_ago: int = 0, departments: list[str] | None = None) -> dict:
    """Per camera: reads, reviewed, confirmed, corrected, unreadable, accuracy (on reviewed reads),
    low-confidence share, invalid-format share, mean confidence, night share, top correction reasons."""
    start, end = week_bounds(weeks_ago)
    q = select(AnprEvent).where(AnprEvent.ts >= start, AnprEvent.ts < end)
    if departments is not None:
        q = q.where(AnprEvent.department.in_(departments))
    evs = s.scalars(q).all()
    rq = select(PlateReview).where(PlateReview.ts >= start - dt.timedelta(days=30))     # reviews may lag the read
    reviews = {r.event_id: r for r in s.scalars(rq) if r.event_id in {e.id for e in evs}}
    cams = {c.id: c for c in s.scalars(select(Camera))}
    per: dict[str, dict] = {}
    for e in evs:
        d = per.setdefault(e.camera_id, {"camera_id": e.camera_id, "camera_name": cams[e.camera_id].name if e.camera_id in cams else e.camera_id,
                                         "department": e.department, "reads": 0, "reviewed": 0, "confirmed": 0, "corrected": 0, "unreadable": 0,
                                         "low_confidence": 0, "invalid_format": 0, "night": 0, "conf_sum": 0.0, "reasons": {}})
        d["reads"] += 1
        d["conf_sum"] += float(e.confidence or 0)
        tags = e.tags or []
        d["low_confidence"] += "low_confidence" in tags
        d["invalid_format"] += "invalid_format" in tags or "?" in e.plate
        d["night"] += "night" in tags
        r = reviews.get(e.id)
        if r:
            d["reviewed"] += 1
            d[r.verdict] = d.get(r.verdict, 0) + 1
            if r.reason:
                d["reasons"][r.reason] = d["reasons"].get(r.reason, 0) + 1
    out = []
    for d in per.values():
        rev = d["reviewed"]
        d["accuracy_pct"] = round(100 * d["confirmed"] / rev, 1) if rev else None
        d["mean_confidence"] = round(d["conf_sum"] / d["reads"], 3) if d["reads"] else 0
        d["low_confidence_pct"] = round(100 * d["low_confidence"] / d["reads"], 1) if d["reads"] else 0
        d["invalid_format_pct"] = round(100 * d["invalid_format"] / d["reads"], 1) if d["reads"] else 0
        d["night_pct"] = round(100 * d["night"] / d["reads"], 1) if d["reads"] else 0
        d["top_reasons"] = sorted(d.pop("reasons").items(), key=lambda kv: -kv[1])[:3]
        d.pop("conf_sum")
        out.append(d)
    tot_rev = sum(d["reviewed"] for d in out)
    tot_conf = sum(d["confirmed"] for d in out)
    return {"week_start": start.date().isoformat(), "week_end": (end - dt.timedelta(days=1)).date().isoformat(),
            "reads": len(evs), "reviewed": tot_rev, "accuracy_pct": round(100 * tot_conf / tot_rev, 1) if tot_rev else None,
            "cameras": sorted(out, key=lambda d: (d["accuracy_pct"] is None, d["accuracy_pct"] or 0)),
            "note": "accuracy is measured on operator-reviewed reads only; review a random sample each week (Violations -> Review queue)"}


def review_queue(s, departments: list[str] | None, limit: int = 50, sample: bool = True) -> list[AnprEvent]:
    """Reads worth a human look: low confidence, invalid format, non-standard, night, plus a random slice of
    ordinary reads so the accuracy estimate is not biased to hard cases."""
    reviewed = {r for (r,) in s.execute(select(PlateReview.event_id))}
    q = select(AnprEvent).where(AnprEvent.ts >= utcnow() - dt.timedelta(days=14)).order_by(AnprEvent.ts.desc()).limit(3000)
    if departments is not None:
        q = q.where(AnprEvent.department.in_(departments))
    rows = [e for e in s.scalars(q) if e.id not in reviewed]
    hard = [e for e in rows if any(t in (e.tags or []) for t in ("low_confidence", "invalid_format", "non_standard_plate", "night")) or "?" in e.plate]
    easy = [e for e in rows if e not in hard]
    import random
    random.Random(len(rows)).shuffle(easy)
    picked = hard[: max(1, limit * 2 // 3)] + (easy[: limit - min(len(hard), limit * 2 // 3)] if sample else [])
    return picked[:limit]


def training_set(s, departments: list[str] | None, since_days: int = 90) -> bytes:
    """Zip of plate crops with labels.csv (event_id, camera, read, truth, verdict, reason) for OCR fine-tuning."""
    buf = io.BytesIO()
    q = select(PlateReview).where(PlateReview.ts >= utcnow() - dt.timedelta(days=since_days))
    if departments is not None:
        q = q.where(PlateReview.department.in_(departments))
    rows = s.scalars(q).all()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["file", "event_id", "camera_id", "read_plate", "true_plate", "verdict", "reason", "confidence"])
        for r in rows:
            p = settings.data_dir / r.crop_path if r.crop_path else None
            name = f"crops/{r.event_id}.jpg"
            if p and p.exists():
                z.write(p, name)
            else:
                name = ""
            w.writerow([name, r.event_id, r.camera_id, r.read_plate, r.true_plate, r.verdict, r.reason, r.confidence])
        z.writestr("labels.csv", out.getvalue())
        z.writestr("README.txt", "Plate crops with operator ground truth. true_plate is the label; verdict=unreadable rows have no usable label.\n"
                   "Fine-tune the OCR (fast-plate-ocr / PaddleOCR rec) on these, keeping a held-out split per camera.\n")
    return buf.getvalue()


def save_weekly(weeks_ago: int = 1) -> Path:
    """Write last week's report to DATA_DIR/reports (called by the archiver every Monday)."""
    with SessionLocal() as s:
        rep = weekly(s, weeks_ago)
    d = settings.data_dir / "reports"
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"anpr_week_{rep['week_start']}.json"
    p.write_text(json.dumps(rep, indent=1))
    return p
