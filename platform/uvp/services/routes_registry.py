"""Centralised CCTV registry: the inventory and GIS layer underneath the viewing platform.

Every camera the platform pulls is already a registry row; the registry adds cameras that are *not* integrated
(a municipal DVR nobody streams from yet), the metadata a state-wide inventory needs (type, ownership,
connectivity, storage, installation / warranty / maintenance dates, address, zone, ward, pole) and the reports
planners ask for (coverage gaps, ageing infrastructure, health).

  GET    /api/registry                       list + filters (department, type, status, connectivity, ownership,
                                             maintenance, zone, q) — every field, live health, registry_only flag
  POST   /api/registry                       manual entry / API onboarding (JSON), id optional
  PATCH  /api/registry/{id}                  edit metadata (feed-managed cameras: metadata only, never the stream)
  DELETE /api/registry/{id}                  registry-only cameras
  GET    /api/registry/{id}/history          audit trail + status transitions
  GET    /api/registry/template.csv          import template with every column
  POST   /api/registry/import?apply=0|1      CSV bulk import: dry run reports row errors, apply upserts by id
  GET    /api/registry/export.csv            filtered export (audited)
  GET    /api/registry/stats                 counts by department / type / status / connectivity / ownership,
                                             health, maintenance due, ageing, storage below policy
  GET    /api/registry/gaps                  gap analysis: uncovered grid cells, ageing, offline, storage;
                                             ?format=json|csv|html   ?cell_m=100  ?age_years=5  ?min_storage_days=30

Write actions need the `registry_edit` feature (supervisor, admin, or an API key granted it); reading needs
`registry` (every role). All writes are audited with the changed fields.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
import logging
import math
import re
import time

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import auth as A
from .. import investigation as INV
from ..config import settings
from ..db import REGISTRY_SOURCE, AuditLog, Camera, CameraStatusLog, SessionLocal, Source, audit, utcnow
from .deps import _ip, current_user, need

log = logging.getLogger("uvp.registry")
router = APIRouter()

# ----------------------------------------------------------------------------- schema
CAMERA_TYPES = ["fixed", "dome", "bullet", "ptz", "anpr", "thermal", "other"]
OWNERSHIP = ["department", "vendor-managed", "leased", "private-shared", "other"]
CONNECTIVITY = ["fibre", "lan", "4g", "wifi", "offline-dvr", "none"]
STORAGE = ["nvr", "dvr", "cloud", "edge", "none"]
MAINTENANCE = ["ok", "due", "under_repair", "faulty", "decommissioned", "planned"]

META_FIELDS = ["name", "department", "lat", "lon", "heading", "fov", "range_m", "camera_type", "make_model", "resolution",
               "ownership", "owner_contact", "connectivity", "storage_type", "storage_days", "install_date", "warranty_until",
               "maintenance_status", "last_maintenance", "address", "zone", "ward", "pole_id", "tags", "notes"]
CSV_COLUMNS = ["id"] + META_FIELDS
FLOATS = {"lat", "lon", "heading", "fov", "range_m"}
INTS = {"storage_days"}
DATES = {"install_date", "warranty_until", "last_maintenance"}
ENUMS = {"camera_type": CAMERA_TYPES, "ownership": OWNERSHIP, "connectivity": CONNECTIVITY, "storage_type": STORAGE,
         "maintenance_status": MAINTENANCE}


class RegistryCamera(BaseModel):
    id: str | None = None
    name: str
    department: str
    lat: float | None = None
    lon: float | None = None
    heading: float | None = None
    fov: float | None = None
    range_m: float | None = None
    camera_type: str = ""
    make_model: str = ""
    resolution: str = ""
    ownership: str = ""
    owner_contact: str = ""
    connectivity: str = ""
    storage_type: str = ""
    storage_days: int | None = None
    install_date: str = ""
    warranty_until: str = ""
    maintenance_status: str = ""
    last_maintenance: str = ""
    address: str = ""
    zone: str = ""
    ward: str = ""
    pole_id: str = ""
    tags: list[str] = Field(default_factory=list)
    notes: str = ""
    meta: dict = Field(default_factory=dict)


class RegistryPatch(BaseModel):
    """Every field optional: only the keys sent are changed."""
    name: str | None = None
    department: str | None = None
    lat: float | None = None
    lon: float | None = None
    heading: float | None = None
    fov: float | None = None
    range_m: float | None = None
    camera_type: str | None = None
    make_model: str | None = None
    resolution: str | None = None
    ownership: str | None = None
    owner_contact: str | None = None
    connectivity: str | None = None
    storage_type: str | None = None
    storage_days: int | None = None
    install_date: str | None = None
    warranty_until: str | None = None
    maintenance_status: str | None = None
    last_maintenance: str | None = None
    address: str | None = None
    zone: str | None = None
    ward: str | None = None
    pole_id: str | None = None
    tags: list[str] | None = None
    notes: str | None = None
    meta: dict | None = None


def _validate(d: dict) -> list[str]:
    errs = []
    if not (d.get("name") or "").strip():
        errs.append("name is required")
    if not (d.get("department") or "").strip():
        errs.append("department is required")
    lat, lon = d.get("lat"), d.get("lon")
    if (lat is None) != (lon is None):
        errs.append("lat and lon go together")
    if lat is not None and not (-90 <= lat <= 90 and -180 <= lon <= 180):
        errs.append("lat/lon out of range")
    for k, allowed in ENUMS.items():
        v = (d.get(k) or "").strip().lower()
        if v and v not in allowed:
            errs.append(f"{k} must be one of {', '.join(allowed)}")
    for k in DATES:
        v = (d.get(k) or "").strip()
        if v:
            try:
                dt.date.fromisoformat(v)
            except ValueError:
                errs.append(f"{k} must be a real date, YYYY-MM-DD")
    if d.get("storage_days") is not None and d["storage_days"] < 0:
        errs.append("storage_days must be >= 0")
    return errs


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:48] or "cam"


def _ensure_registry_source(s) -> None:
    if s.get(Source, REGISTRY_SOURCE) is None:
        s.add(Source(id=REGISTRY_SOURCE, department="*", name="Registry-only cameras (no feed integrated yet)",
                     adapter="registry", max_concurrent_pulls=0, status="ok", status_detail="inventory entries"))
        s.flush()


def _row(c: Camera, live: dict | None = None) -> dict:
    d = {k: getattr(c, k) for k in META_FIELDS}
    d.update({"id": c.id, "source_id": c.source_id, "status": c.status, "registry_only": c.registry_only,
              "anpr_enabled": c.anpr_enabled, "meta": c.meta or {}, "tags": c.tags or [],
              "created_at": c.created_at.isoformat() if c.created_at else None, "created_by": c.created_by or "",
              "updated_at": c.updated_at.isoformat() if c.updated_at else None, "updated_by": c.updated_by or "",
              "profiles": sorted((c.profiles or {}).keys())})
    d["health"] = "not-integrated" if c.registry_only else ("online" if c.status in ("online", "live") else c.status or "unknown")
    d["age_years"] = _age_years(c.install_date)
    d["warranty_expired"] = bool(c.warranty_until and c.warranty_until < dt.date.today().isoformat())
    return d


def _age_years(install_date: str) -> float | None:
    if not install_date:
        return None
    try:
        d0 = dt.date.fromisoformat(install_date)
    except ValueError:
        return None
    return round((dt.date.today() - d0).days / 365.25, 1)


def _apply(c: Camera, d: dict, user: str) -> list[str]:
    """Set the fields present in d; returns the names that changed."""
    changed = []
    for k in META_FIELDS + ["meta"]:
        if k not in d or d[k] is None:
            continue
        v = d[k]
        if k in ENUMS and isinstance(v, str):
            v = v.strip().lower()
        if isinstance(v, str) and k not in ("notes",):
            v = v.strip()
        if getattr(c, k) != v:
            setattr(c, k, v)
            changed.append(k)
    if changed:
        c.updated_at = utcnow()
        c.updated_by = user
    return changed


# ----------------------------------------------------------------------------- list / CRUD
@router.get("/api/registry")
def list_registry(department: str = "", camera_type: str = "", status: str = "", connectivity: str = "", ownership: str = "",
                  maintenance: str = "", zone: str = "", integrated: str = "", q: str = "", limit: int = 5000,
                  u: A.User = Depends(need("registry"))):
    with SessionLocal() as s:
        cams = [c for c in s.scalars(select(Camera).order_by(Camera.department, Camera.id)) if u.sees_camera(c.id, c.department)]
        rows = [_row(c) for c in cams]
    ql = q.strip().lower()
    out = []
    for r in rows:
        if department and r["department"] != department:
            continue
        if camera_type and r["camera_type"] != camera_type:
            continue
        if status and r["health"] != status:
            continue
        if connectivity and r["connectivity"] != connectivity:
            continue
        if ownership and r["ownership"] != ownership:
            continue
        if maintenance and r["maintenance_status"] != maintenance:
            continue
        if zone and r["zone"] != zone:
            continue
        if integrated == "yes" and r["registry_only"]:
            continue
        if integrated == "no" and not r["registry_only"]:
            continue
        if ql and ql not in " ".join(str(r.get(k) or "") for k in ("id", "name", "department", "address", "zone", "ward", "pole_id", "make_model", "notes")).lower() \
                and not any(ql in t.lower() for t in r["tags"]):
            continue
        out.append(r)
    return out[:limit]


@router.post("/api/registry", status_code=201)
def create_registry(body: RegistryCamera, request: Request, u: A.User = Depends(need("registry_edit"))):
    d = body.model_dump()
    errs = _validate(d)
    if errs:
        raise HTTPException(400, "; ".join(errs))
    if not u.sees(d["department"]):
        raise HTTPException(403, "not your department")
    with SessionLocal() as s:
        _ensure_registry_source(s)
        cid = (d.get("id") or f"reg-{_slug(d['department'])}-{_slug(d['name'])}").strip()
        if s.get(Camera, cid) is not None:
            raise HTTPException(409, f"camera {cid} already exists (PATCH it, or import with apply=1 to update)")
        c = Camera(id=cid, source_id=REGISTRY_SOURCE, department=d["department"], name=d["name"], profiles={}, status="registered",
                   created_at=utcnow(), created_by=u.username, updated_at=utcnow(), updated_by=u.username)
        _apply(c, d, u.username)
        s.add(c)
        audit(s, u.username, "registry_create", cid, json.dumps({k: d[k] for k in ("name", "department", "camera_type", "lat", "lon")}), _ip(request))
        s.commit()
        return _row(s.get(Camera, cid))


@router.patch("/api/registry/{cid}")
def patch_registry(cid: str, body: RegistryPatch, request: Request, u: A.User = Depends(need("registry_edit"))):
    d = {k: v for k, v in body.model_dump().items() if v is not None}
    with SessionLocal() as s:
        c = s.get(Camera, cid)
        if c is None or not u.sees_camera(c.id, c.department):
            raise HTTPException(404, "no such camera")
        merged = _row(c) | d
        errs = _validate(merged)
        if errs:
            raise HTTPException(400, "; ".join(errs))
        if "department" in d and not u.sees(d["department"]):
            raise HTTPException(403, "not your department")
        changed = _apply(c, d, u.username)
        if changed:
            audit(s, u.username, "registry_update", cid, "changed: " + ", ".join(changed), _ip(request))
        s.commit()
        return _row(s.get(Camera, cid))


@router.delete("/api/registry/{cid}")
def delete_registry(cid: str, request: Request, u: A.User = Depends(need("registry_edit"))):
    with SessionLocal() as s:
        c = s.get(Camera, cid)
        if c is None or not u.sees_camera(c.id, c.department):
            raise HTTPException(404, "no such camera")
        if not c.registry_only:
            raise HTTPException(409, "this camera is fed by a departmental source; remove it from sources.yaml instead")
        s.delete(c)
        audit(s, u.username, "registry_delete", cid, c.name, _ip(request))
        s.commit()
    return {"ok": True}


@router.get("/api/registry/{cid}/history")
def registry_history(cid: str, u: A.User = Depends(need("registry"))):
    with SessionLocal() as s:
        c = s.get(Camera, cid)
        if c is None or not u.sees_camera(c.id, c.department):
            raise HTTPException(404, "no such camera")
        changes = s.scalars(select(AuditLog).where(AuditLog.target == cid, AuditLog.action.like("registry_%"))
                            .order_by(AuditLog.ts.desc()).limit(200)).all()
        status = s.scalars(select(CameraStatusLog).where(CameraStatusLog.camera_id == cid)
                           .order_by(CameraStatusLog.ts.desc()).limit(200)).all()
        return {"camera": _row(c),
                "changes": [{"ts": a.ts.isoformat(), "user": a.user_id, "action": a.action, "detail": a.detail, "ip": a.ip} for a in changes],
                "status": [{"ts": x.ts.isoformat(), "status": x.status, "detail": x.detail} for x in status]}


# ----------------------------------------------------------------------------- CSV import / export
@router.get("/api/registry/template.csv")
def registry_template(u: A.User = Depends(need("registry"))):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLUMNS)
    w.writerow(["amc-ellis-01", "Ellis Bridge east approach", "Municipal", "23.0225", "72.5714", "270", "70", "80", "bullet",
                "Hikvision DS-2CD2T47", "4MP", "department", "amc.itcell@example.gov.in", "fibre", "nvr", "30", "2023-04-12",
                "2026-04-11", "ok", "2026-06-02", "Ellis Bridge, Ahmedabad", "Central", "Ward 12", "P-1182", "junction;bridge",
                "covers the eastbound carriageway"])
    return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=registry_template.csv"})


def _coerce_row(raw: dict) -> tuple[dict, list[str]]:
    d, errs = {}, []
    for k in CSV_COLUMNS:
        v = (raw.get(k) or "").strip()
        if k in FLOATS:
            if v == "":
                d[k] = None
            else:
                try:
                    d[k] = float(v)
                except ValueError:
                    errs.append(f"{k} is not a number")
                    d[k] = None
        elif k in INTS:
            if v == "":
                d[k] = None
            else:
                try:
                    d[k] = int(float(v))
                except ValueError:
                    errs.append(f"{k} is not a whole number")
                    d[k] = None
        elif k == "tags":
            d[k] = [t.strip() for t in re.split(r"[;|,]", v) if t.strip()]
        else:
            d[k] = v
    extras = {k: v for k, v in raw.items() if k and k not in CSV_COLUMNS and (v or "").strip()}
    if extras:
        d["meta"] = extras
    return d, errs + _validate(d)


@router.post("/api/registry/import")
def import_registry(request: Request, file: UploadFile = File(...), apply: int = 0, u: A.User = Depends(need("registry_edit"))):
    raw = file.file.read(20 * 1024 * 1024)
    if len(raw) >= 20 * 1024 * 1024:
        raise HTTPException(400, "CSV larger than 20 MB")
    text = raw.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "name" not in reader.fieldnames or "department" not in reader.fieldnames:
        raise HTTPException(400, "CSV needs at least the columns: name, department (download the template)")
    rows, errors, created, updated, unchanged = [], [], 0, 0, 0
    with SessionLocal() as s:
        _ensure_registry_source(s)
        seen: set[str] = set()
        for n, r in enumerate(reader, start=2):        # row 1 is the header
            d, errs = _coerce_row(r)
            cid = (d.get("id") or f"reg-{_slug(d.get('department') or '')}-{_slug(d.get('name') or '')}").strip()
            if cid in seen:
                errs.append(f"duplicate id {cid} in this file")
            seen.add(cid)
            if d.get("department") and not u.sees(d["department"]):
                errs.append("not your department")
            if errs:
                errors.append({"row": n, "id": cid, "errors": errs})
                continue
            rows.append((n, cid, d))
        if apply and not errors:
            for n, cid, d in rows:
                c = s.get(Camera, cid)
                if c is None:
                    c = Camera(id=cid, source_id=REGISTRY_SOURCE, department=d["department"], name=d["name"], profiles={},
                               status="registered", created_at=utcnow(), created_by=u.username, updated_at=utcnow(), updated_by=u.username)
                    _apply(c, d, u.username)
                    s.add(c)
                    created += 1
                else:
                    if not u.sees_camera(c.id, c.department):
                        errors.append({"row": n, "id": cid, "errors": ["exists in a department you cannot edit"]})
                        continue
                    if _apply(c, d, u.username):
                        updated += 1
                    else:
                        unchanged += 1
            audit(s, u.username, "registry_import", file.filename or "csv",
                  f"{created} created, {updated} updated, {unchanged} unchanged, {len(errors)} rejected", _ip(request))
            s.commit()
        elif apply and errors:
            s.rollback()
    return {"apply": bool(apply), "rows": len(rows) + len(errors), "valid": len(rows), "errors": errors[:200],
            "created": created, "updated": updated, "unchanged": unchanged,
            "preview": [{"row": n, "id": cid, "name": d["name"], "department": d["department"], "camera_type": d.get("camera_type", ""),
                         "lat": d.get("lat"), "lon": d.get("lon")} for n, cid, d in rows[:50]],
            "note": "" if not (apply and errors) else "nothing was written: fix the rows listed and import again"}


@router.get("/api/registry/export.csv")
def export_registry(request: Request, department: str = "", camera_type: str = "", status: str = "", integrated: str = "",
                    q: str = "", u: A.User = Depends(need("registry"))):
    rows = list_registry(department=department, camera_type=camera_type, status=status, integrated=integrated, q=q, u=u)
    buf = io.StringIO()
    cols = CSV_COLUMNS + ["health", "integrated", "age_years", "warranty_expired", "updated_at", "updated_by"]
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow(r | {"tags": ";".join(r["tags"]), "integrated": "no" if r["registry_only"] else "yes"})
    with SessionLocal() as s:
        audit(s, u.username, "registry_export", "csv", f"{len(rows)} rows, filters dept={department} type={camera_type} status={status} q={q}", _ip(request))
        s.commit()
    return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=cctv_registry_{dt.date.today().isoformat()}.csv"})


# ----------------------------------------------------------------------------- stats
def _count(rows: list[dict], key: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in rows:
        k = r.get(key) or "unspecified"
        out[k] = out.get(k, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


@router.get("/api/registry/stats")
def registry_stats(age_years: float = 5, min_storage_days: int = 30, u: A.User = Depends(need("registry"))):
    rows = list_registry(u=u)
    today = dt.date.today().isoformat()
    return {
        "total": len(rows),
        "integrated": sum(1 for r in rows if not r["registry_only"]),
        "registry_only": sum(1 for r in rows if r["registry_only"]),
        "geolocated": sum(1 for r in rows if r["lat"] is not None),
        "health": _count(rows, "health"),
        "by_department": _count(rows, "department"),
        "by_type": _count(rows, "camera_type"),
        "by_connectivity": _count(rows, "connectivity"),
        "by_ownership": _count(rows, "ownership"),
        "by_storage": _count(rows, "storage_type"),
        "by_maintenance": _count(rows, "maintenance_status"),
        "maintenance_due": sum(1 for r in rows if r["maintenance_status"] in ("due", "under_repair", "faulty")),
        "ageing": sum(1 for r in rows if (r["age_years"] or 0) >= age_years),
        "warranty_expired": sum(1 for r in rows if r["warranty_until"] and r["warranty_until"] < today),
        "storage_below_policy": sum(1 for r in rows if r["storage_days"] is not None and r["storage_days"] < min_storage_days),
        "missing_metadata": sum(1 for r in rows if not (r["camera_type"] and r["ownership"] and r["connectivity"] and r["install_date"])),
    }


# ----------------------------------------------------------------------------- gap analysis
def gap_analysis(cams: list[Camera], cell_m: float = 100, age_years: float = 5, min_storage_days: int = 30,
                 offline_only_counts: bool = True, max_cells: int = 40000) -> dict:
    """Grid the area the cameras span (padded by one cell); a cell is covered when its centre lies inside the
    coverage cone / circle of a working camera. Returns uncovered cells ranked by distance to the nearest camera
    (the biggest holes first) plus the ageing / offline / storage lists planners need."""
    today = dt.date.today().isoformat()
    located = [c for c in cams if c.lat is not None and c.lon is not None]
    result = {"cell_m": cell_m, "cameras": len(cams), "located": len(located), "cells": 0, "covered": 0, "uncovered": 0,
              "coverage_pct": 0.0, "gaps": [], "by_department": {}, "ageing": [], "offline": [], "storage_below_policy": [],
              "maintenance": [], "not_geolocated": [{"id": c.id, "name": c.name, "department": c.department} for c in cams if c.lat is None]}
    if located:
        working = [c for c in located if c.status in ("online", "live", "registered", "unknown", "")
                   and c.maintenance_status not in ("faulty", "decommissioned", "under_repair")] if offline_only_counts else located
        lat0, lat1 = min(c.lat for c in located), max(c.lat for c in located)
        lon0, lon1 = min(c.lon for c in located), max(c.lon for c in located)
        dlat = cell_m / 111_320.0
        dlon = cell_m / (111_320.0 * max(0.1, math.cos(math.radians((lat0 + lat1) / 2))))
        lat0, lat1, lon0, lon1 = lat0 - dlat, lat1 + dlat, lon0 - dlon, lon1 + dlon
        n_lat, n_lon = int((lat1 - lat0) / dlat) + 1, int((lon1 - lon0) / dlon) + 1
        while n_lat * n_lon > max_cells:                     # keep the grid bounded for a state-wide inventory
            dlat *= 2; dlon *= 2; cell_m *= 2
            n_lat, n_lon = int((lat1 - lat0) / dlat) + 1, int((lon1 - lon0) / dlon) + 1
        result["cell_m"] = cell_m
        gaps = []
        covered = 0
        max_range = max([float(c.range_m or 80) for c in working] or [80.0])
        for i in range(n_lat):
            for k in range(n_lon):
                clat, clon = lat0 + (i + 0.5) * dlat, lon0 + (k + 0.5) * dlon
                # a cell is covered when its centre or any quarter point lies in a working camera's coverage
                samples = [(clat, clon), (clat - dlat / 4, clon - dlon / 4), (clat - dlat / 4, clon + dlon / 4),
                           (clat + dlat / 4, clon - dlon / 4), (clat + dlat / 4, clon + dlon / 4)]
                hit = False
                nearest, nd = None, 1e12
                reach = max_range + cell_m * 0.75
                for c in working:
                    d = INV.haversine_m(c.lat, c.lon, clat, clon)
                    if d < nd:
                        nearest, nd = c, d
                    if d <= reach and any(INV.in_coverage(c, a, b) for a, b in samples):
                        hit = True
                        break
                if hit:
                    covered += 1
                else:
                    gaps.append({"lat": round(clat, 6), "lon": round(clon, 6), "nearest_camera": nearest.id if nearest else None,
                                 "nearest_m": round(nd) if nearest else None, "nearest_department": nearest.department if nearest else None})
        gaps.sort(key=lambda g: -(g["nearest_m"] or 0))
        cells = n_lat * n_lon
        # blind spots: uncovered cells right next to existing infrastructure (a cheap fix: re-aim or add one camera)
        near = [g for g in gaps if g["nearest_m"] is not None and g["nearest_m"] <= 300]
        near_cells = covered + len(near)
        result.update({"cells": cells, "covered": covered, "uncovered": len(gaps), "coverage_pct": round(100.0 * covered / cells, 1) if cells else 0.0,
                       "near_uncovered": len(near), "near_coverage_pct": round(100.0 * covered / near_cells, 1) if near_cells else 0.0,
                       "blind_spots": sorted(near, key=lambda g: g["nearest_m"])[:300],
                       "gaps": gaps[:500], "bbox": [round(lat0, 6), round(lon0, 6), round(lat1, 6), round(lon1, 6)],
                       "grid": [n_lat, n_lon], "working_cameras": len(working)})
    # per-department: how many cameras, how many working, how many with location
    for c in cams:
        d = result["by_department"].setdefault(c.department, {"cameras": 0, "working": 0, "located": 0, "integrated": 0})
        d["cameras"] += 1
        d["located"] += int(c.lat is not None)
        d["integrated"] += int(not c.registry_only)
        d["working"] += int(c.status in ("online", "live") or (c.registry_only and c.maintenance_status in ("", "ok")))
    for c in cams:
        age = _age_years(c.install_date)
        if (age is not None and age >= age_years) or (c.warranty_until and c.warranty_until < today):
            result["ageing"].append({"id": c.id, "name": c.name, "department": c.department, "install_date": c.install_date,
                                     "age_years": age, "warranty_until": c.warranty_until, "make_model": c.make_model})
        if not c.registry_only and c.status == "offline":
            result["offline"].append({"id": c.id, "name": c.name, "department": c.department})
        if c.storage_days is not None and c.storage_days < min_storage_days:
            result["storage_below_policy"].append({"id": c.id, "name": c.name, "department": c.department, "storage_days": c.storage_days})
        if c.maintenance_status in ("due", "under_repair", "faulty"):
            result["maintenance"].append({"id": c.id, "name": c.name, "department": c.department, "maintenance_status": c.maintenance_status,
                                          "last_maintenance": c.last_maintenance})
    result["ageing"].sort(key=lambda r: -(r["age_years"] or 0))
    result["generated_at"] = utcnow().isoformat()
    result["parameters"] = {"cell_m": result["cell_m"], "age_years": age_years, "min_storage_days": min_storage_days}
    return result


@router.get("/api/registry/gaps")
def registry_gaps(request: Request, format: str = "json", cell_m: float = 100, age_years: float = 5, min_storage_days: int = 30,
                  department: str = "", u: A.User = Depends(need("registry"))):
    with SessionLocal() as s:
        cams = [c for c in s.scalars(select(Camera)) if u.sees_camera(c.id, c.department) and (not department or c.department == department)]
        s.expunge_all()
    rep = gap_analysis(cams, cell_m=max(50.0, min(cell_m, 5000.0)), age_years=age_years, min_storage_days=min_storage_days)
    if format == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["lat", "lon", "nearest_camera", "nearest_department", "nearest_m"])
        for g in rep["gaps"]:
            w.writerow([g["lat"], g["lon"], g["nearest_camera"], g["nearest_department"], g["nearest_m"]])
        return PlainTextResponse(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=coverage_gaps.csv"})
    if format == "html":
        with SessionLocal() as s:
            audit(s, u.username, "registry_report", "gap_analysis", f"cell={rep['cell_m']}m age>={age_years}y storage<{min_storage_days}d", _ip(request))
            s.commit()
        return HTMLResponse(render_gap_report(rep, u.username))
    return rep


def render_gap_report(rep: dict, by: str) -> str:
    def esc(x) -> str:
        return str(x if x is not None else "–").replace("&", "&amp;").replace("<", "&lt;")
    def table(rows: list[dict], cols: list[tuple[str, str]], empty: str) -> str:
        if not rows:
            return f"<p class='muted'>{empty}</p>"
        head = "".join(f"<th>{h}</th>" for _, h in cols)
        body = "".join("<tr>" + "".join(f"<td>{esc(r.get(k))}</td>" for k, _ in cols) + "</tr>" for r in rows)
        return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"
    dept = "".join(f"<tr><td>{esc(d)}</td><td>{v['cameras']}</td><td>{v['integrated']}</td><td>{v['located']}</td><td>{v['working']}</td></tr>"
                   for d, v in sorted(rep["by_department"].items()))
    p = rep["parameters"]
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>CCTV coverage gap analysis</title>
<style>body{{font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif;color:#111;margin:32px;max-width:1000px}}h1{{font-size:22px;margin:0 0 4px}}
h2{{font-size:16px;margin:26px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}}table{{border-collapse:collapse;width:100%;font-size:13px}}
th,td{{text-align:left;padding:5px 8px;border-bottom:1px solid #eee;vertical-align:top}}th{{background:#f4f6f8;font-weight:600}}
.kpis{{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0}}.kpi{{border:1px solid #ddd;border-radius:8px;padding:10px 14px;min-width:130px}}
.kpi b{{display:block;font-size:22px}}.muted{{color:#666}}@media print{{body{{margin:12mm}}}}</style></head><body>
<h1>CCTV coverage gap analysis</h1>
<p class="muted">Generated {esc(rep['generated_at'][:19].replace('T', ' '))} UTC by {esc(by)} · grid cell {p['cell_m']:.0f} m · ageing threshold {p['age_years']} years · storage policy {p['min_storage_days']} days</p>
<div class="kpis"><div class="kpi"><b>{rep['cameras']}</b>cameras in registry</div><div class="kpi"><b>{rep['located']}</b>geolocated</div>
<div class="kpi"><b>{rep['coverage_pct']}%</b>of the whole area covered</div><div class="kpi"><b>{rep.get('near_coverage_pct', 0)}%</b>covered within 300 m of cameras</div><div class="kpi"><b>{rep.get('near_uncovered', 0)}</b>blind spots next to cameras</div><div class="kpi"><b>{rep['uncovered']}</b>uncovered cells in all</div>
<div class="kpi"><b>{len(rep['ageing'])}</b>ageing / out of warranty</div><div class="kpi"><b>{len(rep['offline'])}</b>offline now</div>
<div class="kpi"><b>{len(rep['maintenance'])}</b>maintenance due</div><div class="kpi"><b>{len(rep['storage_below_policy'])}</b>storage below policy</div></div>
<h2>Method</h2><p>The area spanned by all geolocated cameras is divided into {p['cell_m']:.0f} m cells. A cell counts as covered when its centre or one of its quarter points lies inside the
coverage cone (heading ± field of view / 2, to the camera's useful range; a circle for cameras without a heading) of a camera that is not offline, faulty,
under repair or decommissioned. Uncovered cells are ranked by distance to the nearest camera, so the largest monitoring holes come first.
Coverage geometry comes from the registry (heading, fov, range_m); cameras without these get a 70° cone / 80 m default.</p>
<h2>Blind spots next to existing cameras (nearest camera ≤ 300 m; top 40 of {rep.get('near_uncovered', 0)})</h2>
<p class="muted">The cheapest gaps to close: re-aim a neighbouring camera or add one on the same pole / power.</p>
{table(rep.get('blind_spots', [])[:40], [("lat", "Latitude"), ("lon", "Longitude"), ("nearest_m", "Nearest camera (m)"), ("nearest_camera", "Nearest camera"), ("nearest_department", "Department")], "No blind spots next to existing cameras.")}
<h2>Largest uncovered zones anywhere in the area (top 40 of {rep['uncovered']})</h2>
<p class="muted">Ranked by distance to the nearest camera - candidate sites for new installations.</p>
{table(rep['gaps'][:40], [("lat", "Latitude"), ("lon", "Longitude"), ("nearest_m", "Nearest camera (m)"), ("nearest_camera", "Nearest camera"), ("nearest_department", "Department")], "No uncovered cells - every grid cell is inside at least one camera's coverage.")}
<h2>Coverage by department</h2><table><thead><tr><th>Department</th><th>Cameras</th><th>Integrated (live feed)</th><th>Geolocated</th><th>Working</th></tr></thead><tbody>{dept}</tbody></table>
<h2>Ageing infrastructure (installed ≥ {p['age_years']} years ago or warranty expired)</h2>
{table(rep['ageing'], [("id", "Camera"), ("name", "Name"), ("department", "Department"), ("install_date", "Installed"), ("age_years", "Age (y)"), ("warranty_until", "Warranty until"), ("make_model", "Make / model")], "No ageing cameras.")}
<h2>Maintenance due / faulty</h2>
{table(rep['maintenance'], [("id", "Camera"), ("name", "Name"), ("department", "Department"), ("maintenance_status", "Status"), ("last_maintenance", "Last maintenance")], "Nothing due.")}
<h2>Offline now (integrated cameras)</h2>
{table(rep['offline'], [("id", "Camera"), ("name", "Name"), ("department", "Department")], "All integrated cameras are online.")}
<h2>Retention below policy (&lt; {p['min_storage_days']} days)</h2>
{table(rep['storage_below_policy'], [("id", "Camera"), ("name", "Name"), ("department", "Department"), ("storage_days", "Storage (days)")], "All cameras meet the retention policy.")}
<h2>Not geolocated (cannot be assessed)</h2>
{table(rep['not_geolocated'], [("id", "Camera"), ("name", "Name"), ("department", "Department")], "Every camera has coordinates.")}
</body></html>"""


# ----------------------------------------------------------------------------- geocoding (camera name -> lat/lon)
class GeocodeBody(BaseModel):
    ids: list[str] = Field(default_factory=list)      # cameras to look up (default: every visible camera without coordinates)
    query: str = ""                                    # free text instead of camera names (single lookup)
    apply: bool = False                                # write the best candidate straight into the registry
    limit: int = 10                                    # cameras per call (Nominatim allows ~1 request / s)


def geocode(query: str) -> list[dict]:
    """Look a place name up with Nominatim (or GEOCODE_URL). Returns candidates [{lat, lon, label, score}]."""
    import requests
    ua = "UnifiedCCTV-Registry/1.4" + (f" ({settings.geocode_contact})" if settings.geocode_contact else "")
    q = query if "," in query and settings.geocode_region.split(",")[0].lower() in query.lower() else f"{query}, {settings.geocode_region}"
    try:
        rr = requests.get(settings.geocode_url, params={"q": q, "format": "jsonv2", "limit": 3, "countrycodes": "in", "addressdetails": 0},
                          headers={"User-Agent": ua, "Accept-Language": "en"}, timeout=12)
        rr.raise_for_status()
        items = rr.json()
    except Exception as e:  # noqa: BLE001
        log.warning("geocode %r failed: %s", query, e)
        return [{"error": str(e)[:120]}]
    return [{"lat": float(x["lat"]), "lon": float(x["lon"]), "label": x.get("display_name", ""), "score": round(float(x.get("importance") or 0), 3),
             "type": x.get("type", "")} for x in items]


def _clean_name(name: str) -> str:
    """'Hero showroom, Gir Somnath' -> keep; 'cam 12 - Paldi Circle' -> 'Paldi Circle'."""
    n = re.sub(r"^\s*cam(era)?\s*\d+\s*[-:]\s*", "", name or "", flags=re.I)
    n = re.sub(r"\b(cam|camera|ptz|anpr|fixed|dome|bullet)\b", "", n, flags=re.I)
    return re.sub(r"\s+", " ", n).strip(" -:,")


@router.post("/api/registry/geocode")
def registry_geocode(body: GeocodeBody, request: Request, u: A.User = Depends(need("registry_edit"))):
    """Find coordinates for cameras from their names (OSM Nominatim). Dry run returns candidates for review;
    apply=true writes the best candidate for each camera that has none (audited as registry_geocode)."""
    if body.query.strip():
        return {"query": body.query, "candidates": geocode(body.query.strip())}
    with SessionLocal() as s:
        cams = [c for c in s.scalars(select(Camera).order_by(Camera.id)) if u.sees_camera(c.id, c.department)]
        if body.ids:
            cams = [c for c in cams if c.id in set(body.ids)]
        else:
            cams = [c for c in cams if c.lat is None]
        cams = cams[:max(1, min(body.limit, 25))]
        out, applied = [], 0
        for i, c in enumerate(cams):
            if i:
                time.sleep(1.05)                       # Nominatim usage policy: at most one request per second
            q = _clean_name(c.name) or c.id
            cands = geocode(q)
            best = next((x for x in cands if "lat" in x), None)
            row = {"id": c.id, "name": c.name, "department": c.department, "query": q, "candidates": cands, "best": best,
                   "current": [c.lat, c.lon] if c.lat is not None else None}
            if body.apply and best is not None:
                c.lat, c.lon = best["lat"], best["lon"]
                c.updated_at, c.updated_by = utcnow(), u.username
                c.meta = dict(c.meta or {}) | {"geocoded_from": q, "geocode_label": best["label"]}
                audit(s, u.username, "registry_geocode", c.id, f"{q} -> {best['lat']:.5f},{best['lon']:.5f} ({best['label'][:80]})", _ip(request))
                applied += 1
                row["applied"] = True
            out.append(row)
        if body.apply:
            s.commit()
        remaining = sum(1 for c in s.scalars(select(Camera)) if u.sees_camera(c.id, c.department) and c.lat is None)
    return {"rows": out, "applied": applied, "remaining_without_coordinates": remaining}


@router.get("/api/registry/{cid}")
def get_registry(cid: str, u: A.User = Depends(need("registry"))):
    """Declared last so the fixed paths above (stats, gaps, export.csv, template.csv) win."""
    with SessionLocal() as s:
        c = s.get(Camera, cid)
        if c is None or not u.sees_camera(c.id, c.department):
            raise HTTPException(404, "no such camera")
        return _row(c)
