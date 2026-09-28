"""Simulated Department B: Municipal VMS with a vendor-style REST API.

  POST /api/v1/auth/login            -> {"token": ...}
  GET  /api/v1/cameras               -> camera list with location + status
  GET  /api/v1/cameras/{id}/live     -> RTSP URL for ?profile=main|sub
  --- write endpoints the platform must NEVER call (present to prove it) ---
  POST /api/v1/cameras/{id}/ptz
  PUT  /api/v1/cameras/{id}/recording
  POST /api/v1/users
  GET  /sim/audit                    -> every request received, writes flagged
"""
from __future__ import annotations

import datetime as dt
import os
import secrets

from fastapi import Depends, FastAPI, Header, HTTPException, Request

USER = os.environ.get("MUNI_API_USER", "uvp-viewer")
PASSWORD = os.environ.get("MUNI_API_PASS", "muni-view-only")
RTSP_HOST = os.environ.get("MUNI_RTSP_HOST", "localhost")
RTSP_PORT = int(os.environ.get("MUNI_RTSP_PORT", "28554"))
RTSP_USER = os.environ.get("MUNI_RTSP_USER", "vms-live")
RTSP_PASS = os.environ.get("MUNI_RTSP_PASS", "vms-live-secret")
CAMS = [
    {"id": "muni-cam1", "name": "Civic Centre Entry Gate", "location": {"lat": 19.0810, "lon": 72.8900}},
    {"id": "muni-cam2", "name": "Bus Depot Exit", "location": {"lat": 19.0655, "lon": 72.8990}},
    {"id": "muni-cam3", "name": "Lake Road Overview", "location": {"lat": 19.0905, "lon": 72.8850}},
    {"id": "muni-cam4", "name": "Flyover West Overview", "location": {"lat": 19.0700, "lon": 72.8700}},
]
app = FastAPI(title="Simulated Municipal VMS API")
TOKENS: set[str] = set()
AUDIT: list[dict] = []


@app.middleware("http")
async def audit_mw(request: Request, call_next):
    AUDIT.append({"ts": dt.datetime.now(dt.timezone.utc).isoformat(), "method": request.method,
                  "path": request.url.path, "query": str(request.url.query),
                  "write": request.method not in ("GET", "HEAD") and not request.url.path.endswith("/auth/login"),
                  "client": request.client.host if request.client else ""})
    return await call_next(request)


def auth(authorization: str = Header(default="")):
    if not authorization.startswith("Bearer ") or authorization[7:] not in TOKENS:
        raise HTTPException(401, "invalid token")


@app.post("/api/v1/auth/login")
def login(body: dict):
    if body.get("username") != USER or body.get("password") != PASSWORD:
        raise HTTPException(401, "bad credentials")
    t = secrets.token_hex(16)
    TOKENS.add(t)
    return {"token": t, "expires_in": 3600}


@app.get("/api/v1/cameras", dependencies=[Depends(auth)])
def cameras():
    return [{**c, "status": "online", "vendor_model": "SimCam 4MP"} for c in CAMS]


@app.get("/api/v1/cameras/{cid}/live", dependencies=[Depends(auth)])
def live(cid: str, profile: str = "main"):
    if cid not in {c["id"] for c in CAMS} or profile not in ("main", "sub"):
        raise HTTPException(404)
    w, h = (1280, 720) if profile == "main" else (640, 360)
    return {"rtsp_url": f"rtsp://{RTSP_USER}:{RTSP_PASS}@{RTSP_HOST}:{RTSP_PORT}/{cid}/{profile}",
            "width": w, "height": h, "codec": "H264"}


@app.post("/api/v1/cameras/{cid}/ptz", dependencies=[Depends(auth)])
def ptz(cid: str, body: dict):
    return {"ok": True}


@app.put("/api/v1/cameras/{cid}/recording", dependencies=[Depends(auth)])
def recording(cid: str, body: dict):
    return {"ok": True}


@app.post("/api/v1/users", dependencies=[Depends(auth)])
def users(body: dict):
    return {"ok": True}


@app.get("/sim/audit")
def get_audit():
    return {"system": "Municipal VMS (simulated)", "requests": AUDIT,
            "write_requests": [a for a in AUDIT if a["write"]]}
