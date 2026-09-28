"""Investigation tooling: camera coverage geometry, clip stitching (timeline reconstruction),
bookmark clips, and court-ready case bundles with a chain-of-custody record.

Everything here works on the platform's own archive (object storage) and metadata; nothing
touches a departmental system.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

import requests
from sqlalchemy import select

from . import pii, signing
from .config import settings
from .db import AnprEvent, Bookmark, Camera, Case, CaseItem, CustodyLog, Recording, custody
from .relay import path_name, relay
from .storage import store

IST = dt.timezone(dt.timedelta(minutes=330))
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


# ----------------------------------------------------------------------------- geometry
def _offset(lat: float, lon: float, bearing_deg: float, dist_m: float) -> tuple[float, float]:
    r = 6371000.0
    b = math.radians(bearing_deg)
    la1, lo1 = math.radians(lat), math.radians(lon)
    la2 = math.asin(math.sin(la1) * math.cos(dist_m / r) + math.cos(la1) * math.sin(dist_m / r) * math.cos(b))
    lo2 = lo1 + math.atan2(math.sin(b) * math.sin(dist_m / r) * math.cos(la1), math.cos(dist_m / r) - math.sin(la1) * math.sin(la2))
    return math.degrees(la2), math.degrees(lo2)


def coverage_polygon(lat: float, lon: float, heading: float | None, fov: float | None, range_m: float | None,
                     steps: int = 12) -> list[list[float]]:
    """Cone of view as a closed polygon [[lat, lon], ...]; a camera with no heading gets a circle."""
    rng = float(range_m or 80)
    if heading is None:
        return [list(_offset(lat, lon, a, rng)) for a in range(0, 360, 20)]
    f = float(fov or 70)
    pts = [[lat, lon]]
    for i in range(steps + 1):
        a = heading - f / 2 + f * i / steps
        pts.append(list(_offset(lat, lon, a, rng)))
    pts.append([lat, lon])
    return pts


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def in_coverage(cam: Camera, lat: float, lon: float) -> bool:
    if cam.lat is None or cam.lon is None:
        return False
    d = haversine_m(cam.lat, cam.lon, lat, lon)
    if d > float(cam.range_m or 80):
        return False
    if cam.heading is None:
        return True
    diff = abs((bearing_deg(cam.lat, cam.lon, lat, lon) - cam.heading + 180) % 360 - 180)
    return diff <= float(cam.fov or 70) / 2


def nearest_cameras(cams: list[Camera], lat: float, lon: float, n: int = 5) -> list[dict]:
    out = []
    for c in cams:
        if c.lat is None or c.lon is None:
            continue
        d = haversine_m(c.lat, c.lon, lat, lon)
        out.append({"id": c.id, "name": c.name, "department": c.department, "distance_m": round(d),
                    "bearing_from_camera": round(bearing_deg(c.lat, c.lon, lat, lon)), "covers_point": in_coverage(c, lat, lon),
                    "anpr_enabled": c.anpr_enabled, "status": c.status})
    out.sort(key=lambda x: (not x["covers_point"], x["distance_m"]))
    return out[:n]


# ----------------------------------------------------------------------------- clips from the archive
def fetch_object(key: str, dst: Path) -> Path | None:
    """Copy an archive object to a local file (local backend: copy; S3: download via presigned URL)."""
    st = store()
    p = st.local_path(key)
    if p is not None:
        shutil.copyfile(p, dst)
        return dst
    try:
        r = requests.get(st.url(key, 300), timeout=300)
        if r.ok:
            dst.write_bytes(r.content)
            return dst
    except requests.RequestException:
        pass
    return None


def _caption(cam_name: str, ts: dt.datetime, plate: str = "") -> str:
    t = ts.astimezone(IST).strftime("%d %b %Y %H:%M:%S IST")
    return f"{cam_name} · {t}" + (f" · {plate}" if plate else "")


def stitch(segments: list[dict], out: Path, watermark: str) -> list[dict]:
    """Concatenate clips into one MP4 (1280x720, 15 fps), each captioned with camera + time.
    segments: [{path, caption}]; returns the segments actually used with their sha256."""
    tmp = Path(tempfile.mkdtemp(prefix="uvp-stitch-"))
    parts, used = [], []
    for i, sgm in enumerate(segments):
        part = tmp / f"p{i:03d}.ts"
        cap = sgm["caption"].replace(":", "\\:").replace("'", "")
        wm = watermark.replace(":", "\\:").replace("'", "")
        vf = (f"scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=15,"
              f"drawtext=fontfile={FONT}:text='{cap}':fontcolor=white:fontsize=26:box=1:boxcolor=black@0.6:boxborderw=8:x=16:y=16,"
              f"drawtext=fontfile={FONT}:text='{wm}':fontcolor=white:fontsize=18:box=1:boxcolor=black@0.6:boxborderw=6:x=16:y=h-th-16")
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(sgm["path"]), "-vf", vf, "-an", "-c:v", "libx264",
                            "-preset", "veryfast", "-crf", "23", "-f", "mpegts", str(part)], capture_output=True, text=True, timeout=600)
        if r.returncode == 0 and part.exists() and part.stat().st_size > 0:
            parts.append(part)
            used.append({**{k: v for k, v in sgm.items() if k != "path"}, "sha256": signing.sha256_file(Path(sgm["path"]))})
    if not parts:
        raise RuntimeError("no playable clips in the window")
    lst = tmp / "list.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy",
                    "-movflags", "+faststart", str(out)], check=True, timeout=600)
    shutil.rmtree(tmp, ignore_errors=True)
    return used


def timeline_for_plate(s, plate: str, since: dt.datetime | None, until: dt.datetime | None, departments: list[str] | None) -> list[AnprEvent]:
    q = select(AnprEvent).where(AnprEvent.plate == plate).order_by(AnprEvent.ts)
    if since:
        q = q.where(AnprEvent.ts >= since)
    if until:
        q = q.where(AnprEvent.ts <= until)
    if departments is not None:
        q = q.where(AnprEvent.department.in_(departments))
    return list(s.scalars(q))


def stitch_plate(s, plate: str, events: list[AnprEvent], user: str, out: Path) -> list[dict]:
    cams = {c.id: c for c in s.scalars(select(Camera))}
    tmp = Path(tempfile.mkdtemp(prefix="uvp-tl-"))
    segs = []
    for e in events:
        if e.clip_key in ("", "-"):
            continue
        p = fetch_object(e.clip_key, tmp / f"{e.id}.mp4")
        if p:
            cam = cams.get(e.camera_id)
            segs.append({"path": p, "event_id": e.id, "camera_id": e.camera_id, "ts": e.ts.isoformat(),
                         "caption": _caption(cam.name if cam else e.camera_id, e.ts, plate)})
    used = stitch(segs, out, pii.watermark_text(user, extra=plate))
    shutil.rmtree(tmp, ignore_errors=True)
    return used


def cut_bookmark(s, bm: Bookmark) -> str:
    """Cut the bookmark window from the relay buffer, or from archived segments if the buffer has moved on."""
    start = bm.ts - dt.timedelta(seconds=bm.before_s)
    dur = bm.before_s + bm.after_s
    data = None
    try:
        data = relay.clip(path_name(bm.camera_id, "main"), start, dur)
    except Exception:  # noqa: BLE001
        data = None
    if not data:  # fall back to the archived segment(s) covering the window
        end = bm.ts + dt.timedelta(seconds=bm.after_s)
        recs = list(s.scalars(select(Recording).where(Recording.camera_id == bm.camera_id, Recording.start_ts <= end)
                              .order_by(Recording.start_ts.desc()).limit(3)))
        recs = [r for r in recs if r.start_ts + dt.timedelta(seconds=r.duration_s) >= start]
        if recs:
            tmp = Path(tempfile.mkdtemp(prefix="uvp-bm-"))
            parts = []
            for r in sorted(recs, key=lambda r: r.start_ts):
                p = fetch_object(r.key, tmp / f"{r.id}.mp4")
                if p:
                    parts.append((r, p))
            if parts:
                lst = tmp / "list.txt"
                lst.write_text("".join(f"file '{p}'\n" for _, p in parts))
                joined = tmp / "joined.mp4"
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(joined)],
                               check=True, timeout=600)
                off = (start - parts[0][0].start_ts).total_seconds()
                cut = tmp / "cut.mp4"
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(max(0, off)), "-i", str(joined), "-t", str(dur), "-c", "copy",
                                "-movflags", "+faststart", str(cut)], check=True, timeout=600)
                data = cut.read_bytes()
            shutil.rmtree(tmp, ignore_errors=True)
    if not data:
        return "-"
    key = f"bookmarks/{bm.department}/{bm.camera_id}/{bm.ts:%Y-%m-%d}/{bm.id}.mp4"
    store().put_bytes(data, key, "video/mp4")
    return key


# ----------------------------------------------------------------------------- case bundle
def case_number(s) -> str:
    year = dt.datetime.now(dt.timezone.utc).year
    n = 1 + sum(1 for (num,) in s.execute(select(Case.number)) if num.startswith(f"CASE-{year}-"))
    return f"CASE-{year}-{n:04d}"


def snapshot_event(e: AnprEvent, cam: Camera | None) -> dict:
    return {"plate": e.plate, "camera_id": e.camera_id, "camera_name": cam.name if cam else e.camera_id,
            "department": e.department, "ts": e.ts.isoformat(), "confidence": e.confidence, "reads": e.reads,
            "tags": e.tags or [], "clip_key": e.clip_key, "crop_key": e.crop_key, "frame_key": e.frame_key,
            "crop_path": e.crop_path, "frame_path": e.frame_path}


def _pdf(case: Case, items: list[CaseItem], custody_rows: list[CustodyLog], files: dict[str, Path], out: Path,
         exported_by: str, thumbs: dict[str, Path]) -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    ss = getSampleStyleSheet()
    small = ParagraphStyle("small", parent=ss["Normal"], fontSize=8, leading=10)
    body = ParagraphStyle("body", parent=ss["Normal"], fontSize=9.5, leading=12)
    doc = SimpleDocTemplate(str(out), pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                            title=f"{case.number} evidence report", author="Unified CCTV Viewing Platform")
    el = [Paragraph(f"Evidence report · {case.number}", ss["Title"]),
          Paragraph(f"<b>{case.title}</b>", ss["Heading2"]),
          Paragraph(f"Reference: {case.reference or '-'} · Department: {case.department or '-'} · Priority: {case.priority} · Status: {case.status}", body),
          Paragraph(f"Opened by {case.created_by} on {case.created_at.astimezone(IST):%d %b %Y %H:%M} IST · Assigned to: {case.owner or '-'}", body),
          Paragraph(f"Exported by <b>{exported_by}</b> on {dt.datetime.now(IST):%d %b %Y %H:%M:%S} IST. Every file listed below is SHA-256 hashed in manifest.json and the manifest is Ed25519-signed by the platform (manifest.sig, public_key.pem).", body),
          Spacer(1, 6)]
    if case.description:
        el += [Paragraph(case.description.replace("\n", "<br/>"), body), Spacer(1, 6)]

    el.append(Paragraph("Evidence items", ss["Heading3"]))
    rows = [["#", "Kind", "Detail", "Added by", "Added (IST)", "Thumb"]]
    for i, it in enumerate(items, 1):
        m = it.meta or {}
        if it.kind == "event":
            detail = f"{m.get('plate','')} · {m.get('camera_name','')} · {dt.datetime.fromisoformat(m['ts']).astimezone(IST):%d %b %H:%M:%S} · conf {round(float(m.get('confidence',0))*100)}%"
        elif it.kind == "recording":
            detail = f"{m.get('camera_id','')} · {m.get('start','')} · {m.get('duration_s','')} s"
        elif it.kind == "bookmark":
            detail = f"{m.get('label','')} · {m.get('camera_id','')} · {m.get('ts','')}"
        elif it.kind == "stitch":
            detail = f"Stitched timeline {m.get('plate','')} · {m.get('segments',0)} clips"
        else:
            detail = it.note[:300]
        th = thumbs.get(it.id)
        img = Image(str(th), width=28 * mm, height=16 * mm) if th and th.exists() else ""
        rows.append([str(i), it.kind, Paragraph(detail + (f"<br/><i>{it.note}</i>" if it.note and it.kind != "note" else ""), small),
                     it.added_by, it.added_at.astimezone(IST).strftime("%d %b %H:%M"), img])
    t = Table(rows, colWidths=[8 * mm, 18 * mm, 78 * mm, 20 * mm, 22 * mm, 30 * mm], repeatRows=1)
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                           ("FONTSIZE", (0, 0), (-1, -1), 8), ("GRID", (0, 0), (-1, -1), 0.25, colors.grey), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    el += [t, Spacer(1, 8)]

    el.append(Paragraph("Files in this bundle", ss["Heading3"]))
    frows = [["File", "SHA-256"]] + [[n, Paragraph(signing.sha256_file(p), small)] for n, p in files.items()]
    ft = Table(frows, colWidths=[60 * mm, 116 * mm])
    ft.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 8), ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e5e7eb"))]))
    el += [ft, Spacer(1, 8)]

    el.append(Paragraph("Chain of custody", ss["Heading3"]))
    crows = [["When (IST)", "Action", "By", "Detail", "Hash"]]
    for c in custody_rows:
        crows.append([c.ts.astimezone(IST).strftime("%d %b %Y %H:%M:%S"), c.action, c.user_id, Paragraph(c.detail[:200], small), Paragraph(c.hash[:16] + "…", small)])
    ct = Table(crows, colWidths=[32 * mm, 20 * mm, 22 * mm, 74 * mm, 28 * mm], repeatRows=1)
    ct.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 8), ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e5e7eb")), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    el += [ct, Spacer(1, 14),
           Paragraph("Certified by: ______________________________  Designation: __________________  Date: ____________", body),
           Paragraph("(Section 63 Bharatiya Sakshya Adhiniyam 2023 / s.65B Evidence Act certificate to be attached by the officer producing this electronic record.)", small)]
    doc.build(el)


def export_case(s, case: Case, user: str) -> Path:
    """Build the zip: report.pdf, watermarked frames/clips per item, stitched timelines, manifest + signature."""
    items = list(s.scalars(select(CaseItem).where(CaseItem.case_id == case.id).order_by(CaseItem.added_at)))
    tmp = Path(tempfile.mkdtemp(prefix="uvp-case-"))
    files: dict[str, Path] = {}
    thumbs: dict[str, Path] = {}
    wm = pii.watermark_text(user, extra=case.number)
    for i, it in enumerate(items, 1):
        m = it.meta or {}
        tag = f"{i:02d}_{it.kind}"
        if it.kind == "event":
            fp = settings.data_dir / m["frame_path"] if m.get("frame_path") else None
            if fp and fp.exists():
                pii.watermark_image(fp, tmp / f"{tag}_frame.jpg", wm)
                files[f"{tag}_frame.jpg"] = tmp / f"{tag}_frame.jpg"
            cp = settings.data_dir / m["crop_path"] if m.get("crop_path") else None
            if cp and cp.exists():
                shutil.copyfile(cp, tmp / f"{tag}_plate.jpg")
                files[f"{tag}_plate.jpg"] = tmp / f"{tag}_plate.jpg"
                thumbs[it.id] = tmp / f"{tag}_plate.jpg"
            if m.get("clip_key") and m["clip_key"] != "-":
                src = fetch_object(m["clip_key"], tmp / f"{tag}_src.mp4")
                if src:
                    try:
                        pii.watermark_video(src, tmp / f"{tag}_clip.mp4", wm)
                        files[f"{tag}_clip.mp4"] = tmp / f"{tag}_clip.mp4"
                    except Exception:  # noqa: BLE001
                        pass
        elif it.kind in ("bookmark", "stitch", "recording"):
            key = m.get("clip_key") or m.get("key")
            if key and key != "-":
                src = fetch_object(key, tmp / f"{tag}_src.mp4")
                if src:
                    try:
                        pii.watermark_video(src, tmp / f"{tag}.mp4", wm)
                        files[f"{tag}.mp4"] = tmp / f"{tag}.mp4"
                    except Exception:  # noqa: BLE001
                        shutil.copyfile(src, tmp / f"{tag}.mp4")
                        files[f"{tag}.mp4"] = tmp / f"{tag}.mp4"
    (tmp / "case.json").write_text(json.dumps({
        "case": {"id": case.id, "number": case.number, "title": case.title, "reference": case.reference, "status": case.status,
                 "priority": case.priority, "department": case.department, "owner": case.owner, "created_by": case.created_by,
                 "created_at": case.created_at.isoformat()},
        "items": [{"id": it.id, "kind": it.kind, "ref_id": it.ref_id, "note": it.note, "meta": it.meta, "added_by": it.added_by,
                   "added_at": it.added_at.isoformat()} for it in items]}, indent=1))
    files["case.json"] = tmp / "case.json"
    custody(s, case.id, "exported", user, "", f"bundle with {len(files)} files")
    s.flush()
    rows = list(s.scalars(select(CustodyLog).where(CustodyLog.case_id == case.id).order_by(CustodyLog.id)))
    _pdf(case, items, rows, files, tmp / "report.pdf", user, thumbs)
    files = {"report.pdf": tmp / "report.pdf", **files}
    manifest = signing.build_manifest(files, user, f"case_{case.number}", {"case": case.number, "custody_chain_head": rows[-1].hash if rows else ""})
    sig = signing.sign_manifest(manifest)
    import zipfile
    z = tmp / f"{case.number}.zip"
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
        for n, p in files.items():
            zf.write(p, n)
        zf.writestr("manifest.json", json.dumps(manifest, indent=1))
        zf.writestr("manifest.sig", sig)
        zf.writestr("public_key.pem", signing.public_key_pem())
    return z
