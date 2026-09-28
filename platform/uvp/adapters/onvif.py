"""ONVIF Profile S/T adapter (NVRs and IP cameras).

Uses plain SOAP with WS-UsernameToken (PasswordDigest) so there is no heavy
WSDL dependency, and only these read-only operations are ever sent:
GetSystemDateAndTime, GetCapabilities, GetDeviceInformation, GetProfiles,
GetStreamUri.

Profile -> camera mapping: NVRs expose each channel as one or more media
profiles sharing a VideoSourceConfiguration SourceToken. Profiles with the
largest resolution become "main", the smallest "sub".
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import os
import xml.etree.ElementTree as ET
from collections import defaultdict

from .base import Adapter, CameraInfo, ReadOnlyHTTP, StreamProfile, with_credentials

NS = {
    "s": "http://www.w3.org/2003/05/soap-envelope",
    "tds": "http://www.onvif.org/ver10/device/wsdl",
    "trt": "http://www.onvif.org/ver10/media/wsdl",
    "tt": "http://www.onvif.org/ver10/schema",
}
READ_ONLY_ACTIONS = {"GetSystemDateAndTime", "GetCapabilities", "GetDeviceInformation", "GetProfiles",
                     "GetStreamUri"}


def _security_header(user: str, password: str) -> str:
    nonce = os.urandom(16)
    created = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    digest = base64.b64encode(hashlib.sha1(nonce + created.encode() + password.encode()).digest()).decode()
    return (
        '<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
        "<UsernameToken>"
        f"<Username>{user}</Username>"
        '<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">'
        f"{digest}</Password>"
        '<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">'
        f"{base64.b64encode(nonce).decode()}</Nonce>"
        f'<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">{created}</Created>'
        "</UsernameToken></Security>"
    )


class OnvifAdapter(Adapter):
    kind = "onvif"

    def __init__(self, cfg: dict):
        super().__init__(cfg)
        scheme = "https" if cfg.get("tls") else "http"
        self.device_url = f"{scheme}://{cfg['host']}:{cfg.get('onvif_port', 80)}/onvif/device_service"
        self.user = os.environ.get(cfg.get("username_env", ""), cfg.get("username", ""))
        self.password = os.environ.get(cfg.get("password_env", ""), cfg.get("password", ""))
        self.http = ReadOnlyHTTP(allowed_soap_actions=READ_ONLY_ACTIONS, verify=cfg.get("tls_verify", True))
        self.rtsp_host_override = cfg.get("rtsp_host")  # NVRs behind NAT often report internal IPs

    def _call(self, url: str, action: str, body: str, ns: str) -> ET.Element:
        env = (
            f'<s:Envelope xmlns:s="{NS["s"]}"><s:Header>{_security_header(self.user, self.password)}</s:Header>'
            f'<s:Body xmlns:{ns}="{NS[ns]}">{body}</s:Body></s:Envelope>'
        )
        r = self.http.post(url, soap_action=action, data=env.encode(),
                           headers={"Content-Type": f'application/soap+xml; charset=utf-8; action="{NS[ns]}/{action}"'})
        r.raise_for_status()
        root = ET.fromstring(r.content)
        fault = root.find(".//s:Fault", NS)
        if fault is not None:
            raise RuntimeError(f"ONVIF fault on {action}: {ET.tostring(fault, 'unicode')[:200]}")
        return root

    def _media_url(self) -> str:
        root = self._call(self.device_url, "GetCapabilities",
                          "<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>", "tds")
        x = root.find(".//tt:Media/tt:XAddr", NS)
        if x is None or not x.text:
            raise RuntimeError("device reports no Media service")
        return x.text.strip()

    def list_cameras(self) -> list[CameraInfo]:
        media = self._media_url()
        root = self._call(media, "GetProfiles", "<trt:GetProfiles/>", "trt")
        by_source: dict[str, list[tuple[str, str, int, int, str]]] = defaultdict(list)
        for p in root.findall(".//trt:Profiles", NS):
            token = p.get("token")
            name = (p.findtext("tt:Name", "", NS) or token).strip()
            src = p.findtext("tt:VideoSourceConfiguration/tt:SourceToken", token, NS)
            w = int(p.findtext("tt:VideoEncoderConfiguration/tt:Resolution/tt:Width", "0", NS) or 0)
            h = int(p.findtext("tt:VideoEncoderConfiguration/tt:Resolution/tt:Height", "0", NS) or 0)
            codec = p.findtext("tt:VideoEncoderConfiguration/tt:Encoding", "H264", NS)
            by_source[src].append((token, name, w, h, codec))
        cams = []
        for src, profs in by_source.items():
            if not self.included(src):
                continue
            profs.sort(key=lambda t: t[2] * t[3], reverse=True)
            chosen = {"main": profs[0], "sub": profs[-1]}
            profiles = {}
            for key, (token, _n, w, h, codec) in chosen.items():
                body = ("<trt:GetStreamUri><trt:StreamSetup><tt:Stream xmlns:tt=\"http://www.onvif.org/ver10/schema\">"
                        "RTP-Unicast</tt:Stream><tt:Transport xmlns:tt=\"http://www.onvif.org/ver10/schema\">"
                        "<tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>"
                        f"<trt:ProfileToken>{token}</trt:ProfileToken></trt:GetStreamUri>")
                r = self._call(media, "GetStreamUri", body, "trt")
                uri = (r.findtext(".//tt:Uri", "", NS) or "").strip()
                if self.rtsp_host_override:
                    from urllib.parse import urlsplit, urlunsplit
                    u = urlsplit(uri)
                    uri = urlunsplit((u.scheme, f"{self.rtsp_host_override}:{u.port or 554}", u.path, u.query, ""))
                profiles[key] = StreamProfile(with_credentials(uri, self.user, self.password), w, h, codec)
            cams.append(CameraInfo(native_id=src, name=profs[0][1].rsplit(" ", 1)[0] or src, profiles=profiles))
        return self.apply_overrides(cams)

    def ping(self) -> tuple[bool, str]:
        try:
            self._call(self.device_url, "GetDeviceInformation", "<tds:GetDeviceInformation/>", "tds")
            return True, "ONVIF device reachable"
        except Exception as e:  # noqa: BLE001
            return False, str(e)[:300]
