"""Event search. Elasticsearch when ES_URL is set, otherwise SQL (PostgreSQL/SQLite).

Both backends support: exact / wildcard plate (MH12*, *1234), fuzzy plate
(one OCR error), time range, department, camera, tag.
"""
from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass

from sqlalchemy import select

from .config import settings
from .db import AnprEvent, SessionLocal
from .plates import levenshtein, normalise

log = logging.getLogger("uvp.search")


@dataclass
class Query:
    plate: str = ""
    fuzzy: bool = False
    camera_id: str = ""
    departments: list[str] | None = None  # None = all
    tag: str = ""
    vehicle_type: str = ""
    vehicle_colour: str = ""
    since: dt.datetime | None = None
    until: dt.datetime | None = None
    limit: int = 200


def event_dict(e: AnprEvent) -> dict:
    return {"id": e.id, "camera_id": e.camera_id, "department": e.department, "ts": e.ts.isoformat(),
            "plate": e.plate, "plate_raw": e.plate_raw, "plate_valid": e.plate_valid,
            "confidence": round(e.confidence, 3), "reads": e.reads, "direction": e.direction,
            "crop_url": f"/media/{e.crop_path}" if e.crop_path else "",
            "frame_url": f"/media/{e.frame_path}" if e.frame_path else "", "tags": e.tags or [],
            "vehicle_type": e.vehicle_type or "", "vehicle_colour": e.vehicle_colour or "", "plate_colour": e.plate_colour or "",
            "make_model": e.make_model or ""}


class SqlSearch:
    name = "sql"

    def index(self, ev: dict) -> None:  # rows are written by the indexer already
        pass

    def delete_plate(self, plate: str) -> None:  # rows are deleted by the caller
        pass

    def delete_older_than(self, ts: dt.datetime) -> None:
        pass

    def search(self, q: Query) -> list[dict]:
        stmt = select(AnprEvent)
        pat = normalise(q.plate.replace("*", "%")) if q.plate else ""
        if q.plate and "*" in q.plate:
            like = "%".join(normalise(p) for p in q.plate.split("*"))
            stmt = stmt.where(AnprEvent.plate.like(like))
        elif q.plate and not q.fuzzy:
            stmt = stmt.where(AnprEvent.plate == pat)
        if q.camera_id:
            stmt = stmt.where(AnprEvent.camera_id == q.camera_id)
        if q.departments is not None:
            stmt = stmt.where(AnprEvent.department.in_(q.departments))
        if q.since:
            stmt = stmt.where(AnprEvent.ts >= q.since)
        if q.until:
            stmt = stmt.where(AnprEvent.ts <= q.until)
        if q.vehicle_type:
            stmt = stmt.where(AnprEvent.vehicle_type == q.vehicle_type)
        if q.vehicle_colour:
            stmt = stmt.where(AnprEvent.vehicle_colour == q.vehicle_colour)
        stmt = stmt.order_by(AnprEvent.ts.desc())
        with SessionLocal() as s:
            if q.plate and q.fuzzy and "*" not in q.plate:
                rows = s.scalars(stmt.limit(50_000)).all()
                rows = [r for r in rows if levenshtein(r.plate, pat, 1) <= 1]
            else:
                rows = s.scalars(stmt.limit(q.limit * (5 if q.tag else 1))).all()
            out = [event_dict(r) for r in rows if not q.tag or q.tag in (r.tags or [])]
        return out[: q.limit]


class EsSearch:
    name = "elasticsearch"

    def __init__(self, url: str):
        from elasticsearch import Elasticsearch
        self.es = Elasticsearch(url, request_timeout=10)
        self.prefix = settings.es_index_prefix
        self.es.indices.put_index_template(name=self.prefix, index_patterns=[f"{self.prefix}-*"], template={
            "settings": {"number_of_shards": 1, "number_of_replicas": 0},
            "mappings": {"properties": {
                "plate": {"type": "keyword"}, "plate_raw": {"type": "keyword"},
                "camera_id": {"type": "keyword"}, "department": {"type": "keyword"},
                "ts": {"type": "date"}, "confidence": {"type": "float"}, "reads": {"type": "integer"},
                "direction": {"type": "keyword"}, "tags": {"type": "keyword"},
                "crop_url": {"type": "keyword", "index": False}, "frame_url": {"type": "keyword", "index": False},
                "vehicle_type": {"type": "keyword"}, "vehicle_colour": {"type": "keyword"}, "plate_colour": {"type": "keyword"},
                "make_model": {"type": "keyword"}, "plate_valid": {"type": "boolean"}}}})

    def index(self, ev: dict) -> None:
        month = ev["ts"][:7].replace("-", ".")
        self.es.index(index=f"{self.prefix}-{month}", id=ev["id"], document=ev)

    def search(self, q: Query) -> list[dict]:
        must, filt = [], []
        if q.plate:
            p = q.plate.upper().replace(" ", "")
            if "*" in p:
                must.append({"wildcard": {"plate": {"value": p}}})
            elif q.fuzzy:
                must.append({"fuzzy": {"plate": {"value": normalise(p), "fuzziness": 1}}})
            else:
                filt.append({"term": {"plate": normalise(p)}})
        if q.camera_id:
            filt.append({"term": {"camera_id": q.camera_id}})
        if q.departments is not None:
            filt.append({"terms": {"department": q.departments}})
        if q.tag:
            filt.append({"term": {"tags": q.tag}})
        if q.vehicle_type:
            filt.append({"term": {"vehicle_type": q.vehicle_type}})
        if q.vehicle_colour:
            filt.append({"term": {"vehicle_colour": q.vehicle_colour}})
        rng = {}
        if q.since:
            rng["gte"] = q.since.isoformat()
        if q.until:
            rng["lte"] = q.until.isoformat()
        if rng:
            filt.append({"range": {"ts": rng}})
        res = self.es.search(index=f"{self.prefix}-*", size=q.limit, sort=[{"ts": "desc"}],
                             query={"bool": {"must": must, "filter": filt}})
        return [h["_source"] for h in res["hits"]["hits"]]

    def delete_plate(self, plate: str) -> None:
        self.es.delete_by_query(index=f"{self.prefix}-*", query={"term": {"plate": plate}}, conflicts="proceed")

    def delete_older_than(self, ts: dt.datetime) -> None:
        self.es.delete_by_query(index=f"{self.prefix}-*", query={"range": {"ts": {"lt": ts.isoformat()}}},
                                conflicts="proceed")


_backend = None


def backend():
    global _backend
    if _backend is None:
        if settings.es_url:
            try:
                _backend = EsSearch(settings.es_url)
            except Exception as e:  # noqa: BLE001
                log.warning("Elasticsearch unavailable (%s); falling back to SQL search", e)
                _backend = SqlSearch()
        else:
            _backend = SqlSearch()
    return _backend
