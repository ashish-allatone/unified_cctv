"""Simulated NCRB / Vahan-style stolen-vehicle feed and an e-challan receiver, for the pilot.

  uvicorn sim_hotlist:app --port 18095

GET  /hotlist/stolen           -> {"vehicles": [{"plate", "reason", "priority", "expires"}]}   (X-API-Key: demo)
POST /echallan                 -> accepts the platform's signed challan payload, returns {"reference": "ECH-..."}
GET  /echallan/received        -> what has been received (for demos and tests)
"""
import datetime as dt
import hashlib
import hmac
import os
import uuid

from fastapi import FastAPI, Header, HTTPException, Request

app = FastAPI(title="Hotlist + e-challan simulator")
RECEIVED: list[dict] = []
STOLEN = [
    {"plate": "MH12AB1234", "reason": "Stolen vehicle FIR 220/2026 Pune", "priority": "high"},
    {"plate": "MP04ZR7493", "reason": "Wanted: hit-and-run FIR 88/2026", "priority": "high"},
    {"plate": "KA05MN7788", "reason": "Insurance fraud inquiry", "priority": "medium"},
]


@app.get("/hotlist/stolen")
def stolen(x_api_key: str = Header(default="")):
    if x_api_key != os.environ.get("HOTLIST_API_KEY", "demo"):
        raise HTTPException(401)
    exp = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=60)).date().isoformat()
    return {"vehicles": [{**v, "expires": exp} for v in STOLEN], "generated_at": dt.datetime.now(dt.timezone.utc).isoformat()}


@app.post("/echallan")
async def echallan(request: Request, x_uvp_signature: str = Header(default="")):
    body = await request.body()
    secret = os.environ.get("ECHALLAN_WEBHOOK_SECRET", "")
    if secret and x_uvp_signature != hmac.new(secret.encode(), body, hashlib.sha256).hexdigest():
        raise HTTPException(401, "bad signature")
    payload = await request.json()
    ref = f"ECH-{uuid.uuid4().hex[:10].upper()}"
    RECEIVED.append({"reference": ref, **payload})
    return {"reference": ref, "status": "accepted"}


@app.get("/vahan/{plate}")
def vahan(plate: str, x_api_key: str = Header(default="")):
    """Vahan-style registration lookup (simulated): the real service needs credentials from the transport authority."""
    if x_api_key != os.environ.get("HOTLIST_API_KEY", "demo"):
        raise HTTPException(401)
    p = plate.upper().replace(" ", "")
    return {"regn_no": p, "owner_name": "R*** K***", "maker_model": "MARUTI SWIFT VXI" if p[4:6] not in ("ZR", "ZC") else "HERO SPLENDOR PLUS",
            "vehicle_class": "LMV" if p[4:6] not in ("ZR", "ZC") else "MCWG", "fuel": "PETROL", "colour": "WHITE", "regn_date": "2019-03-14",
            "fitness_upto": "2034-03-13", "insurance_upto": "2027-02-28", "puc_upto": "2026-11-30", "rto": p[:4], "status": "ACTIVE",
            "note": "simulated record"}


@app.get("/echallan/received")
def received():
    return RECEIVED
