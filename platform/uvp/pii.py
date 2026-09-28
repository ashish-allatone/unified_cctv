"""Personal-data controls: plate masking for users without plate_search, face blurring in
stored evidence frames, and user/time watermarks on anything exported."""
from __future__ import annotations

import datetime as dt
import subprocess
from pathlib import Path

import cv2
import numpy as np

from .config import settings

_face_cascade = None


def mask_plate(plate: str) -> str:
    """MP04ZR7493 -> MP04****93 : enough to recognise a series, not a vehicle."""
    if not plate or len(plate) < 6:
        return "*" * len(plate or "")
    return plate[:4] + "*" * (len(plate) - 6) + plate[-2:]


def mask_event(ev: dict, user) -> dict:
    """Apply plate masking to an API event/alert dict for users without plate_search."""
    if not settings.pii_mask_plates or user is None or user.has("plate_search"):
        return ev
    out = dict(ev)
    for k in ("plate", "plate_raw", "watchlist_plate"):
        if k in out and out[k]:
            out[k] = mask_plate(out[k])
    out["plate_masked"] = True
    return out


_cascade_warned = False


def _cascade():
    """Frontal-face Haar cascade, or None when this OpenCV build lacks objdetect / the cascade files
    (some minimal wheels): faces are then left unblurred and a warning is logged once."""
    global _face_cascade, _cascade_warned
    if _face_cascade is None:
        try:
            path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            c = cv2.CascadeClassifier(path)
            if c.empty():
                raise RuntimeError(f"cascade file missing: {path}")
            _face_cascade = c
        except Exception as e:  # noqa: BLE001
            if not _cascade_warned:
                import logging
                logging.getLogger("uvp.pii").warning("face blurring unavailable (%s); evidence frames are saved unblurred", e)
                _cascade_warned = True
            return None
    return _face_cascade


def blur_faces(frame: np.ndarray) -> tuple[np.ndarray, int]:
    """Gaussian-blur detected faces (frontal Haar cascade, runs offline). Returns (frame, n_faces)."""
    cascade = _cascade()
    if cascade is None:
        return frame, 0
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=5, minSize=(24, 24))
    out = frame.copy()
    for (x, y, w, h) in faces:
        pad = int(0.15 * w)
        x0, y0, x1, y1 = max(0, x - pad), max(0, y - pad), min(out.shape[1], x + w + pad), min(out.shape[0], y + h + pad)
        roi = out[y0:y1, x0:x1]
        k = max(15, (x1 - x0) // 2) | 1
        out[y0:y1, x0:x1] = cv2.GaussianBlur(roi, (k, k), 0)
    return out, len(faces)


def watermark_text(user: str, when: dt.datetime | None = None, extra: str = "") -> str:
    when = when or dt.datetime.now(dt.timezone.utc)
    return f"UVP export · {user} · {when:%Y-%m-%d %H:%M:%S} UTC{(' · ' + extra) if extra else ''}"


def watermark_image(src: Path, dst: Path, text: str) -> None:
    img = cv2.imread(str(src))
    if img is None:
        raise ValueError(f"cannot read {src}")
    h, w = img.shape[:2]
    scale = max(0.5, w / 1400)
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 2)
    x, y = 10, h - 10
    cv2.rectangle(img, (x - 6, y - th - 8), (x + tw + 6, y + 6), (0, 0, 0), -1)
    cv2.putText(img, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 2, cv2.LINE_AA)
    # faint diagonal repeat so cropping cannot remove the mark
    ov = img.copy()
    for yy in range(0, h, max(120, h // 5)):
        cv2.putText(ov, text.split(" · ")[1] if " · " in text else text, (20, yy + 60), cv2.FONT_HERSHEY_SIMPLEX,
                    scale * 1.4, (255, 255, 255), 2, cv2.LINE_AA)
    img = cv2.addWeighted(ov, 0.12, img, 0.88, 0)
    cv2.imwrite(str(dst), img, [cv2.IMWRITE_JPEG_QUALITY, 88])


def watermark_video(src: Path, dst: Path, text: str) -> None:
    """Burn the watermark into a clip with ffmpeg (re-encode, keeps audio out, H.264 baseline)."""
    safe = text.replace(":", "\\:").replace("'", "")
    font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    vf = (f"drawtext=fontfile={font}:text='{safe}':fontcolor=white:fontsize=h/32:box=1:boxcolor=black@0.6:"
          f"boxborderw=6:x=10:y=h-th-10")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", vf, "-an", "-c:v", "libx264", "-preset",
                    "veryfast", "-crf", "23", "-movflags", "+faststart", str(dst)], check=True, timeout=300)
