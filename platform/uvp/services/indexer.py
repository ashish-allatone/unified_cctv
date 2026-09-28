"""Indexer: stores ANPR events, applies tagging rules, matches the watchlist, raises alerts.

Runs inside the API process in no-Kafka mode, or as its own service
(`python -m uvp.services.indexer`) consuming Kafka in the full deployment.
"""
from __future__ import annotations

import datetime as dt
import logging

from sqlalchemy import select

from ..config import load_yaml, settings
from .. import metrics as M
from ..analytics.rules import TrafficRules
from ..db import AnprEvent, Alert, Challan, SessionLocal, WatchlistEntry, init_db, new_id, utcnow
from ..plates import levenshtein
from ..search import backend, event_dict

log = logging.getLogger("uvp.indexer")


class Rules:
    def __init__(self):
        cfg = load_yaml(settings.rules_file)
        self.low_conf = float(cfg.get("low_confidence_below", 0.8))
        self.fuzzy_watchlist = bool(cfg.get("fuzzy_watchlist_match", True))
        self.restricted = cfg.get("restricted_hours", [])  # [{camera: id|"*", from: "23:00", to: "05:00", tag: ...}]
        self.tz = dt.timezone(dt.timedelta(minutes=int(cfg.get("utc_offset_minutes", 330))))
        self.nsp = cfg.get("non_standard_plate") or {}

    def tags_for(self, ev: dict, ts: dt.datetime) -> list[str]:
        tags = []
        if ev["confidence"] < self.low_conf:
            tags.append("low_confidence")
        if not ev.get("plate_valid", True):
            tags.append("invalid_format")
        local = ts.astimezone(self.tz).strftime("%H:%M")
        for r in self.restricted:
            if r.get("camera", "*") not in ("*", ev["camera_id"]):
                continue
            a, b = r["from"], r["to"]
            inside = (a <= local < b) if a < b else (local >= a or local < b)
            if inside:
                tags.append(r.get("tag", "restricted_hours"))
        return tags


class Indexer:
    def __init__(self):
        init_db()
        self.rules = Rules()
        self.traffic = TrafficRules()
        self.search = backend()

    def handle(self, ev: dict) -> list[dict]:
        """Store one ANPR event, evaluate traffic rules, match the watchlist. Returns the alerts raised."""
        from ..analytics.rules import challan_number
        ts = dt.datetime.fromisoformat(ev["ts"])
        tags = set(ev.get("tags", []) + self.rules.tags_for(ev, ts))
        attrs = ev.get("attrs") or {}
        for k, pre in (("vehicle_type", "type:"), ("vehicle_colour", "colour:"), ("plate_colour", "plate:")):
            if attrs.get(k) and attrs[k] not in ("unknown", "other"):
                tags.add(pre + str(attrs[k]))
        alerts: list[dict] = []
        with SessionLocal() as s:
            if s.get(AnprEvent, ev["id"]) is not None:
                return []  # duplicate delivery (publisher retry / Kafka redelivery): idempotent
            violations = self.traffic.evaluate(ev, s, ts)
            for v in violations:
                tags.add(v["code"])
                if v["challan"]:
                    tags.add("challan_suggested")
            row = AnprEvent(id=ev["id"], camera_id=ev["camera_id"], department=ev["department"], ts=ts,
                            plate=ev["plate"], plate_raw=ev.get("plate_raw", ev["plate"]),
                            plate_valid=ev.get("plate_valid", True), confidence=ev["confidence"],
                            reads=ev.get("reads", 1), direction=ev.get("direction", "unknown"),
                            crop_path=ev.get("crop_path", ""), frame_path=ev.get("frame_path", ""), tags=sorted(tags),
                            vehicle_type=str(attrs.get("vehicle_type", "")), vehicle_colour=str(attrs.get("vehicle_colour", "")),
                            plate_colour=str(attrs.get("plate_colour", "")), make_model=str(attrs.get("make_model", "")), attrs=attrs)
            s.add(row)
            crop_url = f"/media/{row.crop_path}" if row.crop_path else ""
            for v in violations:
                a = Alert(id=new_id(), event_id=row.id, plate=row.plate, watchlist_plate=v["code"].upper(), match="rule",
                          camera_id=row.camera_id, department=row.department, ts=ts, priority=v["priority"],
                          reason=f"{v['label']}: {v['reason']} {v['section']}; Rs {v['fine_inr']}{' (repeat)' if v['repeat'] else ''}.")
                s.add(a)
                alerts.append({"id": a.id, "event_id": row.id, "plate": row.plate, "watchlist_plate": a.watchlist_plate, "match": "rule",
                               "camera_id": row.camera_id, "department": row.department, "ts": ts.isoformat(),
                               "priority": a.priority, "reason": a.reason, "crop_url": crop_url, "offence": v["code"]})
                if v["challan"]:
                    s.add(Challan(number=challan_number(s), event_id=row.id, plate=row.plate, camera_id=row.camera_id,
                                  department=row.department, ts=ts, offence=v["code"], section=v["section"], fine_inr=v["fine_inr"],
                                  repeat=v["repeat"], detail=v["reason"] + (" " + str(v["detail"]) if v["detail"] else ""),
                                  evidence={"crop_path": row.crop_path, "frame_path": row.frame_path, "event_id": row.id}))
            now = utcnow()
            hit, match = None, ""
            for w in s.scalars(select(WatchlistEntry)).all():
                if w.expires_at and w.expires_at.replace(tzinfo=w.expires_at.tzinfo or dt.timezone.utc) < now:
                    continue
                if w.plate == row.plate:
                    hit, match = w, "exact"
                    break
                if self.rules.fuzzy_watchlist and levenshtein(w.plate, row.plate, 1) <= 1:
                    hit, match = w, "fuzzy"
            if hit:
                row.tags = sorted(set(row.tags + ["watchlist"]))
                a = Alert(id=new_id(), event_id=row.id, plate=row.plate, watchlist_plate=hit.plate, match=match,
                          camera_id=row.camera_id, department=row.department, ts=ts, priority=hit.priority, reason=hit.reason)
                s.add(a)
                alerts.insert(0, {"id": a.id, "event_id": row.id, "plate": row.plate, "watchlist_plate": hit.plate, "match": match,
                                  "camera_id": row.camera_id, "department": row.department, "ts": ts.isoformat(),
                                  "priority": hit.priority, "reason": hit.reason, "crop_url": crop_url})
            s.commit()
            doc = event_dict(row)
            M.EVENTS_INGESTED.labels(row.department).inc()
            for a in alerts:
                M.ALERTS.labels(row.department, a["match"]).inc()
            for v in violations:
                if v["challan"]:
                    M.CHALLANS.labels(row.department, v["code"]).inc()
        try:
            self.search.index(doc)
        except Exception as e:  # noqa: BLE001
            log.warning("search index failed for %s: %s", doc["id"], e)
        return alerts


def main() -> None:  # Kafka mode
    from ..bus import TOPIC_ALERTS, TOPIC_ANPR, consume, publisher
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    M.serve()
    idx = Indexer()
    pub = publisher()

    def on_msg(topic: str, msg: dict) -> None:
        for alert in idx.handle(msg):
            pub.publish(TOPIC_ALERTS, alert)
            log.info("ALERT %s at %s: %s", alert["plate"], alert["camera_id"], alert.get("watchlist_plate"))

    consume([TOPIC_ANPR], "uvp-indexer", on_msg)


if __name__ == "__main__":
    main()
