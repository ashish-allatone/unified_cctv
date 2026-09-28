"""Traffic-rule evaluation on plate reads (indexer side) and the offence / challan schedule.

A violation is {code, section, fine_inr, repeat, priority, reason, detail}. Codes:
  non_standard_plate  decorative / obscured plate (series unreadable -> "????")
  wrong_way           read direction opposes the camera's allowed_direction (config/analytics.yaml)
  over_speed          two-camera timing over a configured pair distance
  triple_riding       3+ persons detected on one two-wheeler
  no_helmet           customer helmet classifier says a rider has none (only when a model is configured)
Zone incidents (red_light, illegal_parking, intrusion, ...) are raised by the analytics worker.
"""
from __future__ import annotations

import datetime as dt
import logging

from sqlalchemy import select

from ..config import load_yaml, settings

log = logging.getLogger("uvp.analytics.rules")

DEFAULT_OFFENCES = {
    "non_standard_plate": {"section": "s.177 r/w CMVR Rule 50/51", "fine_inr": 500, "repeat_inr": 1500, "priority": "medium", "challan": True},
    "over_speed": {"section": "s.183(1)", "fine_inr": 1000, "repeat_inr": 2000, "priority": "high", "challan": True},
    "wrong_way": {"section": "s.184", "fine_inr": 1000, "repeat_inr": 5000, "priority": "high", "challan": True},
    "red_light": {"section": "s.184 / s.177", "fine_inr": 1000, "repeat_inr": 5000, "priority": "high", "challan": True},
    "no_helmet": {"section": "s.194D", "fine_inr": 1000, "repeat_inr": 1000, "priority": "medium", "challan": True},
    "triple_riding": {"section": "s.194C", "fine_inr": 1000, "repeat_inr": 1000, "priority": "medium", "challan": True},
    "illegal_parking": {"section": "s.177 / s.122", "fine_inr": 500, "repeat_inr": 1500, "priority": "low", "challan": True},
}

LABELS = {"non_standard_plate": "Non-standard number plate", "over_speed": "Over-speeding", "wrong_way": "Wrong-way driving",
          "red_light": "Red-light violation", "no_helmet": "Riding without helmet", "triple_riding": "Triple riding",
          "illegal_parking": "Illegal parking", "person_match": "Person of interest sighted"}


def offences() -> dict:
    cfg = load_yaml(settings.rules_file).get("offences") or {}
    out = {k: {**v} for k, v in DEFAULT_OFFENCES.items()}
    for k, v in cfg.items():
        out[k] = {**out.get(k, {}), **(v or {})}
    # legacy key kept for older rules.yaml files
    nsp = load_yaml(settings.rules_file).get("non_standard_plate") or {}
    if nsp:
        out["non_standard_plate"].update({"section": nsp.get("section", out["non_standard_plate"]["section"]),
                                          "fine_inr": nsp.get("fine_first_inr", out["non_standard_plate"]["fine_inr"]),
                                          "repeat_inr": nsp.get("fine_repeat_inr", out["non_standard_plate"]["repeat_inr"]),
                                          "priority": nsp.get("priority", out["non_standard_plate"]["priority"]),
                                          "challan": nsp.get("challan", True)})
    return out


class TrafficRules:
    def __init__(self):
        cfg = load_yaml(settings.analytics_file) or {}
        self.cameras = cfg.get("cameras") or {}
        self.pairs = cfg.get("pairs") or []
        self.offences = offences()

    def _violation(self, code: str, reason: str, detail: dict, repeat: bool) -> dict:
        o = self.offences.get(code, {})
        return {"code": code, "label": LABELS.get(code, code), "section": o.get("section", ""),
                "fine_inr": int(o.get("repeat_inr" if repeat else "fine_inr", 0)), "repeat": repeat,
                "priority": o.get("priority", "medium"), "challan": bool(o.get("challan", True)), "reason": reason, "detail": detail}

    def evaluate(self, ev: dict, s, ts: dt.datetime) -> list[dict]:
        """ev: the ANPR event dict; s: DB session (for pair lookups and repeat-offence checks)."""
        from ..db import AnprEvent, Challan
        out: list[dict] = []
        plate = ev["plate"]
        cam = ev["camera_id"]
        attrs = ev.get("attrs") or {}
        ccfg = self.cameras.get(cam) or {}

        def repeat_for(code: str) -> bool:
            return s.scalar(select(Challan.id).where(Challan.plate == plate, Challan.offence == code,
                                                     Challan.status.in_(("approved", "sent"))).limit(1)) is not None

        if "?" in plate and self.offences["non_standard_plate"].get("challan", True):
            out.append(self._violation("non_standard_plate", "Series unreadable: decorative font, sticker or obscured characters. "
                                       "Verify from the evidence frame before issuing.", {}, False))
        allowed = ccfg.get("allowed_direction")
        if allowed in ("towards", "away") and ev.get("direction") in ("towards", "away") and ev["direction"] != allowed:
            out.append(self._violation("wrong_way", f"Vehicle moving {ev['direction']} the camera on a lane where traffic flows {allowed}.",
                                       {"allowed": allowed, "observed": ev["direction"]}, repeat_for("wrong_way")))
        for pr in self.pairs:
            if pr.get("to") != cam:
                continue
            window = dt.timedelta(minutes=float(pr.get("max_minutes", 30)))
            prev = s.scalar(select(AnprEvent).where(AnprEvent.plate == plate, AnprEvent.camera_id == pr["from"],
                                                    AnprEvent.ts < ts, AnprEvent.ts >= ts - window).order_by(AnprEvent.ts.desc()).limit(1))
            if prev is None:
                continue
            secs = (ts - prev.ts).total_seconds()
            if secs <= 0:
                continue
            kmh = float(pr["distance_m"]) / secs * 3.6
            limit = float(pr.get("limit_kmh", ccfg.get("speed_limit_kmh", 60)))
            if kmh > limit * (1 + float(pr.get("tolerance", 0.05))):
                out.append(self._violation("over_speed", f"{kmh:.0f} km/h average over {pr['distance_m']} m between {pr['from']} and {cam} "
                                           f"(limit {limit:.0f} km/h).", {"kmh": round(kmh, 1), "limit_kmh": limit, "from": pr["from"],
                                                                          "from_event": prev.id, "seconds": round(secs)}, repeat_for("over_speed")))
        if int(attrs.get("riders") or 0) >= 3:
            out.append(self._violation("triple_riding", f"{attrs['riders']} riders detected on a two-wheeler.", {"riders": attrs["riders"]},
                                       repeat_for("triple_riding")))
        if attrs.get("no_helmet"):
            out.append(self._violation("no_helmet", "Rider without helmet (classifier).", {"helmet": attrs.get("helmet")}, repeat_for("no_helmet")))
        return out


def challan_number(s) -> str:
    from ..db import Challan
    year = dt.datetime.now(dt.timezone.utc).year
    n = 1 + sum(1 for (num,) in s.execute(select(Challan.number)) if num.startswith(f"CH-{year}-"))
    return f"CH-{year}-{n:06d}"
