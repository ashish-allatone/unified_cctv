"""Simulated Department A: Police NVR speaking ONVIF (Profile S) + RTSP.

Stands in for a real NVR during the pilot demo. It:
  * answers ONVIF GetCapabilities / GetProfiles / GetStreamUri (+ a few more)
  * checks WS-UsernameToken PasswordDigest credentials
  * also implements WRITE operations (SetVideoEncoderConfiguration, CreateUsers,
    SystemReboot, ...) so the non-interference test can prove the platform never
    sends them
  * logs every request to /sim/audit

Video comes from a separate MediaMTX instance (dept_a_mediamtx.yml).
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import os
import re

from fastapi import FastAPI, Request, Response

USER = os.environ.get("POLICE_ONVIF_USER", "uvp-viewer")
PASSWORD = os.environ.get("POLICE_ONVIF_PASS", "police-view-only")
RTSP_HOST = os.environ.get("POLICE_RTSP_HOST", "localhost")
RTSP_PORT = int(os.environ.get("POLICE_RTSP_PORT", "18554"))
HTTP_HOST = os.environ.get("POLICE_ONVIF_PUBLIC", "localhost:18080")
CAMS = [("police-cam1", "NH-48 Toll Plaza Lane 1"), ("police-cam2", "Ring Road Junction North"),
        ("police-cam3", "Station Road Overview"), ("police-cam4", "Market Square Overview")]
WRITE_ACTIONS = {"SetVideoEncoderConfiguration", "CreateUsers", "DeleteUsers", "SetUser", "SystemReboot",
                 "SetSystemFactoryDefault", "SetNetworkInterfaces", "CreateProfile", "DeleteProfile",
                 "AbsoluteMove", "ContinuousMove", "SetRecordingConfiguration"}

app = FastAPI(title="Simulated Police NVR (ONVIF)")
AUDIT: list[dict] = []

ENV = ('<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
       'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" '
       'xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body>{}</s:Body></s:Envelope>')


def fault(reason: str, code: int = 400) -> Response:
    body = ENV.format(f"<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text>{reason}"
                      "</s:Text></s:Reason></s:Fault>")
    return Response(body, status_code=code, media_type="application/soap+xml")


def check_auth(xml: str) -> bool:
    u = re.search(r"<(?:\w+:)?Username>([^<]*)<", xml)
    p = re.search(r"<(?:\w+:)?Password[^>]*>([^<]*)<", xml)
    n = re.search(r"<(?:\w+:)?Nonce[^>]*>([^<]*)<", xml)
    c = re.search(r"<(?:\w+:)?Created[^>]*>([^<]*)<", xml)
    if not (u and p and n and c) or u.group(1) != USER:
        return False
    expect = base64.b64encode(hashlib.sha1(base64.b64decode(n.group(1)) + c.group(1).encode()
                                           + PASSWORD.encode()).digest()).decode()
    return expect == p.group(1)


def action_of(xml: str) -> str:
    m = re.search(r"<s:Body[^>]*>\s*<(?:\w+:)?(\w+)", xml)
    return m.group(1) if m else "?"


async def handle(req: Request, service: str) -> Response:
    xml = (await req.body()).decode("utf-8", "replace")
    act = action_of(xml)
    ok = check_auth(xml)
    AUDIT.append({"ts": dt.datetime.now(dt.timezone.utc).isoformat(), "service": service, "action": act,
                  "auth": ok, "write": act in WRITE_ACTIONS, "client": req.client.host if req.client else ""})
    if act != "GetSystemDateAndTime" and not ok:
        return fault("Sender not authorized", 401)
    if act in WRITE_ACTIONS:
        return ENV.format(f"<tds:{act}Response/>")  # a real NVR would change state here
    if act == "GetSystemDateAndTime":
        now = dt.datetime.now(dt.timezone.utc)
        body = (f"<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Date><tt:Year>{now.year}"
                f"</tt:Year></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>")
    elif act == "GetCapabilities":
        body = (f"<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://{HTTP_HOST}"
                "/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>")
    elif act == "GetDeviceInformation":
        body = ("<tds:GetDeviceInformationResponse><tds:Manufacturer>SimVision</tds:Manufacturer>"
                "<tds:Model>NVR-16P</tds:Model><tds:FirmwareVersion>4.2.1</tds:FirmwareVersion>"
                "</tds:GetDeviceInformationResponse>")
    elif act == "GetProfiles":
        items = []
        for cid, name in CAMS:
            for prof, w, h in (("main", 1280, 720), ("sub", 640, 360)):
                items.append(
                    f'<trt:Profiles token="{cid}_{prof}" fixed="true"><tt:Name>{name} {prof}</tt:Name>'
                    f'<tt:VideoSourceConfiguration token="vsc_{cid}"><tt:SourceToken>{cid}</tt:SourceToken>'
                    f'</tt:VideoSourceConfiguration><tt:VideoEncoderConfiguration token="vec_{cid}_{prof}">'
                    f"<tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>{w}</tt:Width><tt:Height>{h}"
                    "</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>")
        body = f"<trt:GetProfilesResponse>{''.join(items)}</trt:GetProfilesResponse>"
    elif act == "GetStreamUri":
        tok = re.search(r"<(?:\w+:)?ProfileToken>([^<]+)<", xml)
        if not tok or "_" not in tok.group(1):
            return fault("No such profile")
        cid, prof = tok.group(1).rsplit("_", 1)
        body = (f"<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://{RTSP_HOST}:{RTSP_PORT}/{cid}/{prof}"
                "</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect></trt:MediaUri>"
                "</trt:GetStreamUriResponse>")
    else:
        return fault(f"Action {act} not supported")
    return Response(ENV.format(body), media_type="application/soap+xml")


@app.post("/onvif/device_service")
async def device(req: Request):
    return await handle(req, "device")


@app.post("/onvif/media_service")
async def media(req: Request):
    return await handle(req, "media")


@app.get("/sim/audit")
def audit():
    return {"system": "Police NVR (simulated)", "requests": AUDIT,
            "write_requests": [a for a in AUDIT if a["write"]]}
