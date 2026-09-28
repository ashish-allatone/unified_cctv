"""Synthetic traffic footage generator for the pilot simulators.

Renders looping road-camera clips with Indian-format number plates so the
whole pipeline (relay -> viewer, ANPR -> search) can be demonstrated without
touching a real departmental system. Some vehicles are routed through
cameras of BOTH simulated departments so cross-department vehicle-movement
search can be shown.

Each camera gets two files, like a real IP camera's two profiles:
  <cam>_main.mp4  1280x720, 15 fps  (used for ANPR / full screen)
  <cam>_sub.mp4    640x360, 15 fps  (used for grid tiles)

Usage:
  python traffic_synth.py --out ./media [--seconds 120]
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FPS = 15
W, H = 1280, 720
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSansCondensed-Bold.ttf",
]
STATES = ["MH", "DL", "KA", "TS", "GJ", "UP", "TN", "RJ", "HR", "WB", "AP", "MP", "KL", "PB"]
CAR_COLOURS = [(40, 40, 160), (160, 160, 160), (30, 30, 30), (200, 200, 200), (140, 60, 20),
               (30, 110, 30), (20, 90, 170), (60, 60, 90)]

# Vehicles that deliberately travel across both departments' cameras.
# (plate, [(camera_id, second_in_clip), ...])
JOURNEYS = [
    ("MH12AB1234", [("police-cam1", 8), ("muni-cam1", 38), ("police-cam2", 70)]),
    ("DL3CAF0921", [("muni-cam1", 14), ("police-cam1", 52), ("muni-cam2", 90)]),
    ("KA05MN7788", [("police-cam2", 20), ("muni-cam2", 55)]),
]

CAMERAS = [
    # id, department, label, anpr-suitable view (large plates), seed
    ("police-cam1", "Police", "NH-48 Toll Plaza Lane 1", True, 11),
    ("police-cam2", "Police", "Ring Road Junction North", True, 12),
    ("police-cam3", "Police", "Station Road Overview", False, 13),
    ("police-cam4", "Police", "Market Square Overview", False, 14),
    ("muni-cam1", "Municipal", "Civic Centre Entry Gate", True, 21),
    ("muni-cam2", "Municipal", "Bus Depot Exit", True, 22),
    ("muni-cam3", "Municipal", "Lake Road Overview", False, 23),
    ("muni-cam4", "Municipal", "Flyover West Overview", False, 24),
]


def _font(size: int) -> ImageFont.FreeTypeFont:
    for p in FONT_CANDIDATES:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def random_plate(rng: random.Random) -> str:
    st = rng.choice(STATES)
    rto = f"{rng.randint(1, 50):02d}"
    series = "".join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(2))
    num = f"{rng.randint(1, 9999):04d}"
    return f"{st}{rto}{series}{num}"


_plate_cache: dict[str, np.ndarray] = {}


def plate_image(text: str) -> np.ndarray:
    """High-security-registration-plate style (white, black text)."""
    if text in _plate_cache:
        return _plate_cache[text]
    w, h = 210, 46
    im = Image.new("RGB", (w, h), (240, 240, 236))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([1, 1, w - 2, h - 2], radius=5, outline=(20, 20, 20), width=2)
    shown = f"{text[:4]} {text[4:-4]} {text[-4:]}"
    f = _font(34)
    bb = d.textbbox((0, 0), shown, font=f)
    tw = bb[2] - bb[0]
    if tw > w - 16:
        f = _font(int(34 * (w - 16) / tw))
        bb = d.textbbox((0, 0), shown, font=f)
        tw = bb[2] - bb[0]
    d.text(((w - tw) // 2 - bb[0], (h - (bb[3] - bb[1])) // 2 - bb[1]), shown, font=f, fill=(10, 10, 10))
    arr = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
    _plate_cache[text] = arr
    return arr


def draw_car(f: np.ndarray, cx: int, y: int, plate: str, colour, cw: int) -> None:
    """Rear view of a car, top-left anchored at (cx - cw/2, y)."""
    x = int(cx - cw / 2)
    ch = int(cw * 0.62)
    s = cw / 560.0
    wheel = lambda x0, x1: cv2.rectangle(f, (int(x0), int(y + ch - 10 * s)), (int(x1), int(y + ch + 45 * s)), (15, 15, 15), -1)
    wheel(x + 20 * s, x + 100 * s)
    wheel(x + cw - 100 * s, x + cw - 20 * s)
    body = np.array([[x + 90 * s, y], [x + cw - 90 * s, y], [x + cw - 40 * s, y + ch * 0.38], [x + cw, y + ch * 0.45],
                     [x + cw, y + ch], [x, y + ch], [x, y + ch * 0.45], [x + 40 * s, y + ch * 0.38]], np.int32)
    cv2.fillPoly(f, [body], colour)
    glass = np.array([[x + 105 * s, y + 15 * s], [x + cw - 105 * s, y + 15 * s], [x + cw - 60 * s, y + ch * 0.36],
                      [x + 60 * s, y + ch * 0.36]], np.int32)
    cv2.fillPoly(f, [glass], (55, 45, 40))
    cv2.rectangle(f, (int(x + 10 * s), int(y + ch * 0.5)), (int(x + 90 * s), int(y + ch * 0.62)), (30, 30, 220), -1)
    cv2.rectangle(f, (int(x + cw - 90 * s), int(y + ch * 0.5)), (int(x + cw - 10 * s), int(y + ch * 0.62)), (30, 30, 220), -1)
    cv2.rectangle(f, (x, int(y + ch * 0.82)), (x + cw, y + ch), (35, 35, 35), -1)
    p = plate_image(plate)
    pw = max(8, int(p.shape[1] * s))
    ph = max(3, int(p.shape[0] * s))
    p = cv2.resize(p, (pw, ph), interpolation=cv2.INTER_AREA)
    px, py = int(x + (cw - pw) / 2), int(y + ch * 0.62)
    y0, y1, x0, x1 = max(py, 0), min(py + ph, H), max(px, 0), min(px + pw, W)
    if y1 > y0 and x1 > x0:
        f[y0:y1, x0:x1] = p[y0 - py:y1 - py, x0 - px:x1 - px]


@dataclass
class Car:
    plate: str
    t0: float
    lane: int
    colour: tuple
    dur: float = 5.0


@dataclass
class Cam:
    cid: str
    dept: str
    label: str
    anpr: bool
    seed: int
    cars: list[Car] = field(default_factory=list)


def build_schedule(seconds: int) -> list[Cam]:
    cams = {c[0]: Cam(*c) for c in CAMERAS}
    for plate, route in JOURNEYS:
        for cid, t in route:
            if t < seconds - 6:
                cams[cid].cars.append(Car(plate, t, 0, (40, 40, 160)))
    for cam in cams.values():
        rng = random.Random(cam.seed)
        t = 1.0
        while t < seconds - 6:
            lane = rng.randint(0, 1)
            clash = any(abs(c.t0 - t) < 2.6 and c.lane == lane for c in cam.cars)
            if not clash:
                cam.cars.append(Car(random_plate(rng), t, lane, rng.choice(CAR_COLOURS), dur=rng.uniform(4.5, 6.0)))
            t += rng.uniform(1.6, 3.2)
        cam.cars.sort(key=lambda c: c.t0)
    return list(cams.values())


def background(cam: Cam) -> np.ndarray:
    rng = random.Random(cam.seed)
    f = np.zeros((H, W, 3), np.uint8)
    sky = (rng.randint(170, 210), rng.randint(140, 170), rng.randint(100, 130))
    f[:200] = sky
    for i in range(8):  # skyline
        bx = rng.randint(0, W - 120)
        bw = rng.randint(60, 180)
        bh = rng.randint(40, 150)
        g = rng.randint(80, 150)
        cv2.rectangle(f, (bx, 200 - bh), (bx + bw, 200), (g, g, g + 10), -1)
    road = np.array([[520, 200], [760, 200], [W, H], [0, H]], np.int32)
    f[200:] = (60, 110, 70)
    cv2.fillPoly(f, [road], (95, 95, 95))
    for k in range(12):  # centre dashes
        y0 = 200 + int((k / 12) ** 1.6 * (H - 200))
        y1 = 200 + int(((k + 0.5) / 12) ** 1.6 * (H - 200))
        cv2.line(f, (640, y0), (640, y1), (225, 225, 225), max(1, int(1 + k * 0.8)))
    return f


def render(cam: Cam, t: float, bg: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    f = bg.copy()
    max_w = 560 if cam.anpr else 250
    active = []
    for c in cam.cars:
        p = (t - c.t0) / c.dur
        if 0 <= p <= 1:
            active.append((p, c))
    for p, c in sorted(active, key=lambda a: -a[0]):  # far cars first
        # drive away from the camera: large at bottom, shrinking towards horizon
        scale = 1.0 - 0.8 * p
        cw = int(max_w * scale)
        lane_off = (-1 if c.lane == 0 else 1) * (170 if cam.anpr else 150) * scale
        y = int(200 + (H - 200 - cw * 0.62 - 40) * (1 - p) ** 1.3)
        draw_car(f, int(640 + lane_off), y, c.plate, c.colour, cw)
    # on-screen display, as on a real CCTV feed
    cv2.rectangle(f, (0, 0), (W, 34), (0, 0, 0), -1)
    cv2.putText(f, f"{cam.cid.upper()}  {cam.label}", (12, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    cv2.putText(f, f"{cam.dept} VMS  T+{t:06.1f}s", (W - 330, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 230, 255), 2)
    f = cv2.GaussianBlur(f, (3, 3), 0)
    noise = rng.normal(0, 5, f.shape).astype(np.int16)
    return np.clip(f.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def encode(cam: Cam, seconds: int, out: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg not found")
    common = ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
              "-profile:v", "baseline", "-bf", "0", "-g", str(FPS), "-r", str(FPS)]
    cmd = [ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
           "-r", str(FPS), "-i", "-",
           "-map", "0", *common, "-b:v", "2500k", str(out / f"{cam.cid}_main.mp4"),
           "-map", "0", *common, "-b:v", "600k", "-vf", "scale=640:360", str(out / f"{cam.cid}_sub.mp4")]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    bg = background(cam)
    rng = np.random.default_rng(cam.seed)
    for i in range(seconds * FPS):
        proc.stdin.write(render(cam, i / FPS, bg, rng).tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit(f"ffmpeg failed for {cam.cid}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="./media")
    ap.add_argument("--seconds", type=int, default=120)
    ap.add_argument("--only", nargs="*", help="camera ids to render")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    cams = build_schedule(a.seconds)
    gt = out / "ground_truth.json"
    truth = json.loads(gt.read_text()) if gt.exists() else {}
    for cam in cams:
        if a.only and cam.cid not in a.only:
            continue
        print(f"rendering {cam.cid} ({len(cam.cars)} vehicles)", flush=True)
        encode(cam, a.seconds, out)
        truth[cam.cid] = [{"plate": c.plate, "t": round(c.t0, 1)} for c in cam.cars]
    (out / "ground_truth.json").write_text(json.dumps(truth, indent=1))
    print("done")


if __name__ == "__main__":
    main()
