"""Platform metadata store (PostgreSQL in production, SQLite for a laptop demo).

Only metadata lives here. Video stays in each department's own VMS; the platform's own
archive (event clips, crops, recorded segments) lives in object storage and is only
referenced from here by key.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import threading
import uuid

from sqlalchemy import (JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, create_engine, event,
                        Index)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy.types import TypeDecorator

from .config import settings


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex


class UTCDateTime(TypeDecorator):
    """Always hands back timezone-aware UTC datetimes (SQLite would otherwise drop the zone)."""
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=dt.timezone.utc)
        value = value.astimezone(dt.timezone.utc)
        return value.replace(tzinfo=None) if dialect.name == "sqlite" else value

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return value.replace(tzinfo=dt.timezone.utc) if value.tzinfo is None else value.astimezone(dt.timezone.utc)


class Base(DeclarativeBase):
    pass


class Source(Base):
    """One departmental VMS / NVR the platform reads from."""
    __tablename__ = "sources"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    department: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(200))
    adapter: Mapped[str] = mapped_column(String(32))
    max_concurrent_pulls: Mapped[int] = mapped_column(Integer, default=16)
    status: Mapped[str] = mapped_column(String(16), default="unknown")
    status_detail: Mapped[str] = mapped_column(Text, default="")
    checked_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    # console-managed devices (Sources -> Connect a device): the adapter config without secrets, the credentials
    # encrypted with TOKEN_SECRET, and who/when - yaml sources leave these empty
    managed: Mapped[bool] = mapped_column(Boolean, default=False)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    secret_enc: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(64), default="")
    updated_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Camera(Base):
    __tablename__ = "cameras"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id"))
    department: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(200))
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    profiles: Mapped[dict] = mapped_column(JSON, default=dict)  # {"main": {...}, "sub": {...}} (no credentials)
    anpr_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    anpr_cfg: Mapped[dict] = mapped_column(JSON, default=dict)      # {"roi": [x, y, w, h] fractions, "upscale": 2, "fps": 8}
    status: Mapped[str] = mapped_column(String(16), default="unknown")
    updated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    # coverage geometry for the GIS map (from sources.yaml camera overrides)
    relay: Mapped[str] = mapped_column(String(32), default="")            # relay holding this camera's paths (cluster)
    heading: Mapped[float | None] = mapped_column(Float, nullable=True)    # degrees clockwise from north
    fov: Mapped[float | None] = mapped_column(Float, nullable=True)        # horizontal field of view, degrees
    range_m: Mapped[float | None] = mapped_column(Float, nullable=True)    # useful range, metres
    # ---- registry metadata (centralised CCTV registry: inventory, ownership, connectivity, storage, maintenance)
    camera_type: Mapped[str] = mapped_column(String(24), default="")        # fixed | dome | bullet | ptz | anpr | thermal | other
    make_model: Mapped[str] = mapped_column(String(100), default="")
    resolution: Mapped[str] = mapped_column(String(16), default="")         # e.g. 1080p, 4MP
    ownership: Mapped[str] = mapped_column(String(48), default="")          # department | vendor-managed | leased | private-shared
    owner_contact: Mapped[str] = mapped_column(String(120), default="")
    connectivity: Mapped[str] = mapped_column(String(24), default="")       # fibre | lan | 4g | wifi | offline-dvr
    storage_type: Mapped[str] = mapped_column(String(24), default="")       # nvr | dvr | cloud | edge | none
    storage_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    install_date: Mapped[str] = mapped_column(String(10), default="")       # ISO date
    warranty_until: Mapped[str] = mapped_column(String(10), default="")
    maintenance_status: Mapped[str] = mapped_column(String(24), default="") # ok | due | under_repair | faulty | decommissioned
    last_maintenance: Mapped[str] = mapped_column(String(10), default="")
    address: Mapped[str] = mapped_column(String(200), default="")
    zone: Mapped[str] = mapped_column(String(64), default="")
    ward: Mapped[str] = mapped_column(String(64), default="")
    pole_id: Mapped[str] = mapped_column(String(64), default="")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    notes: Mapped[str] = mapped_column(Text, default="")
    meta: Mapped[dict] = mapped_column(JSON, default=dict)                  # any extra columns from a bulk import
    created_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    updated_by: Mapped[str] = mapped_column(String(64), default="")

    @property
    def registry_only(self) -> bool:
        """Listed in the registry but not pulled by the platform (no stream configured)."""
        return self.source_id == REGISTRY_SOURCE


REGISTRY_SOURCE = "registry"          # pseudo-source that owns cameras onboarded through the registry alone


class AnprEvent(Base):
    __tablename__ = "anpr_events"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    camera_id: Mapped[str] = mapped_column(String(64), index=True)
    department: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), index=True)
    plate: Mapped[str] = mapped_column(String(16))          # as read, after correction
    plate_raw: Mapped[str] = mapped_column(String(32))      # raw OCR string of the best read
    plate_valid: Mapped[bool] = mapped_column(Boolean, default=True)
    confidence: Mapped[float] = mapped_column(Float)
    reads: Mapped[int] = mapped_column(Integer, default=1)
    direction: Mapped[str] = mapped_column(String(16), default="unknown")
    crop_path: Mapped[str] = mapped_column(String(300), default="")
    frame_path: Mapped[str] = mapped_column(String(300), default="")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    # object-storage keys filled in by the archiver ("" = not yet, "-" = not available)
    clip_key: Mapped[str] = mapped_column(String(300), default="")
    crop_key: Mapped[str] = mapped_column(String(300), default="")
    frame_key: Mapped[str] = mapped_column(String(300), default="")
    # vehicle attributes (analytics): searchable columns + the full attribute dict
    vehicle_type: Mapped[str] = mapped_column(String(24), default="", index=True)   # car | two_wheeler | bus | truck | light_vehicle ...
    vehicle_colour: Mapped[str] = mapped_column(String(16), default="", index=True)
    plate_colour: Mapped[str] = mapped_column(String(12), default="")               # white | yellow | green | black | other
    make_model: Mapped[str] = mapped_column(String(64), default="")
    attrs: Mapped[dict] = mapped_column(JSON, default=dict)
    __table_args__ = (Index("ix_anpr_plate_ts", "plate", "ts"),)


class Incident(Base):
    """Non-plate analytics detections: intrusion, abandoned object, crowd, illegal parking, red light."""
    __tablename__ = "incidents"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    camera_id: Mapped[str] = mapped_column(String(64), index=True)
    department: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), index=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    zone: Mapped[str] = mapped_column(String(64), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)      # counts, bbox, duration, signal state ...
    snapshot_path: Mapped[str] = mapped_column(String(300), default="")
    plate: Mapped[str] = mapped_column(String(16), default="")     # when a plate read could be associated
    priority: Mapped[str] = mapped_column(String(16), default="medium")
    ack_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ack_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Challan(Base):
    """Draft challan generated from a violation; a supervisor approves, then it is sent to e-challan."""
    __tablename__ = "challans"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    number: Mapped[str] = mapped_column(String(32), unique=True)           # CH-2026-000123
    event_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    incident_id: Mapped[str] = mapped_column(String(32), default="")
    plate: Mapped[str] = mapped_column(String(16), index=True)
    camera_id: Mapped[str] = mapped_column(String(64))
    department: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), index=True)
    offence: Mapped[str] = mapped_column(String(32), index=True)
    section: Mapped[str] = mapped_column(String(64), default="")
    fine_inr: Mapped[int] = mapped_column(Integer, default=0)
    repeat: Mapped[bool] = mapped_column(Boolean, default=False)
    detail: Mapped[str] = mapped_column(Text, default="")
    evidence: Mapped[dict] = mapped_column(JSON, default=dict)             # crop/frame/clip paths + keys
    status: Mapped[str] = mapped_column(String(16), default="draft", index=True)   # draft | approved | rejected | sent | failed
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    reviewed_by: Mapped[str] = mapped_column(String(64), default="")
    reviewed_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    remarks: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    external_ref: Mapped[str] = mapped_column(String(128), default="")   # e-challan system's id


class Recording(Base):
    """One recorded segment of a camera's main stream, archived in object storage."""
    __tablename__ = "recordings"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    camera_id: Mapped[str] = mapped_column(String(64), index=True)
    department: Mapped[str] = mapped_column(String(64), index=True)
    profile: Mapped[str] = mapped_column(String(8), default="main")
    start_ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), index=True)
    duration_s: Mapped[float] = mapped_column(Float)
    key: Mapped[str] = mapped_column(String(300), unique=True)
    bytes: Mapped[int] = mapped_column(Integer, default=0)
    archived_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    __table_args__ = (Index("ix_rec_cam_start", "camera_id", "start_ts"),)


class EventTag(Base):
    """Operator- or rule-created tag on a camera at a point in time (e.g. 'accident')."""
    __tablename__ = "event_tags"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    camera_id: Mapped[str] = mapped_column(String(64), index=True)
    department: Mapped[str] = mapped_column(String(64))
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), index=True, default=utcnow)
    tag: Mapped[str] = mapped_column(String(64))
    note: Mapped[str] = mapped_column(Text, default="")
    user_id: Mapped[str] = mapped_column(String(64), default="system")


class WatchlistEntry(Base):
    __tablename__ = "watchlist"
    plate: Mapped[str] = mapped_column(String(16), primary_key=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    priority: Mapped[str] = mapped_column(String(16), default="high")
    added_by: Mapped[str] = mapped_column(String(64), default="system")
    added_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    event_id: Mapped[str] = mapped_column(String(32), index=True)
    plate: Mapped[str] = mapped_column(String(16))
    watchlist_plate: Mapped[str] = mapped_column(String(16))
    match: Mapped[str] = mapped_column(String(16), default="exact")  # exact | fuzzy
    camera_id: Mapped[str] = mapped_column(String(64))
    department: Mapped[str] = mapped_column(String(64))
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), index=True)
    priority: Mapped[str] = mapped_column(String(16), default="high")
    reason: Mapped[str] = mapped_column(Text, default="")
    ack_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ack_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Person(Base):
    """A person of interest (wanted / missing / suspect / other) enrolled from one or more photos.
    embeddings holds one 128-d SFace vector per photo; sightings are Incident rows of kind person_match whose
    detail.person_id points here, so alerts, acknowledgement, cases and audit all work unchanged."""
    __tablename__ = "persons"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(16), default="wanted")     # wanted | missing | suspect | other
    priority: Mapped[str] = mapped_column(String(16), default="high")
    reason: Mapped[str] = mapped_column(Text, default="")
    reference: Mapped[str] = mapped_column(String(120), default="")         # FIR / order / case number
    departments: Mapped[list] = mapped_column(JSON, default=lambda: ["*"])  # where matching is allowed
    photos: Mapped[list] = mapped_column(JSON, default=list)                # relative paths under data/
    embeddings: Mapped[list] = mapped_column(JSON, default=list)            # one 128-float list per photo
    added_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_seen_camera: Mapped[str] = mapped_column(String(64), default="")
    sightings: Mapped[int] = mapped_column(Integer, default=0)


class Case(Base):
    """An investigation: a folder of sightings, clips, recordings, bookmarks and notes with an owner."""
    __tablename__ = "cases"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    number: Mapped[str] = mapped_column(String(32), unique=True)          # CASE-2026-0001
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    reference: Mapped[str] = mapped_column(String(128), default="")       # FIR / complaint number
    status: Mapped[str] = mapped_column(String(16), default="open")        # open | closed
    priority: Mapped[str] = mapped_column(String(16), default="medium")
    department: Mapped[str] = mapped_column(String(64), default="")
    owner: Mapped[str] = mapped_column(String(64), default="")             # assigned officer (username)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)
    updated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    closed_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class CaseItem(Base):
    __tablename__ = "case_items"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))       # event | recording | bookmark | note | stitch
    ref_id: Mapped[str] = mapped_column(String(64), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    meta: Mapped[dict] = mapped_column(JSON, default=dict)   # snapshot (plate, camera, ts, keys, sha256 ...)
    added_by: Mapped[str] = mapped_column(String(64))
    added_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)


class CustodyLog(Base):
    """Chain of custody for evidence: every touch of a case item or export, hash-chained like the audit log."""
    __tablename__ = "custody_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)
    case_id: Mapped[str] = mapped_column(String(32), index=True)
    item_id: Mapped[str] = mapped_column(String(32), default="")
    action: Mapped[str] = mapped_column(String(32))     # added | removed | exported | stitched | note
    user_id: Mapped[str] = mapped_column(String(64))
    detail: Mapped[str] = mapped_column(Text, default="")
    sha256: Mapped[str] = mapped_column(String(64), default="")   # of the file involved, when any
    prev_hash: Mapped[str] = mapped_column(String(64), default="")
    hash: Mapped[str] = mapped_column(String(64), default="")


class Bookmark(Base):
    """A moment on a camera an operator wants to keep: cut into a clip from the recording buffer."""
    __tablename__ = "bookmarks"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    camera_id: Mapped[str] = mapped_column(String(64), index=True)
    department: Mapped[str] = mapped_column(String(64))
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), index=True)
    before_s: Mapped[int] = mapped_column(Integer, default=10)
    after_s: Mapped[int] = mapped_column(Integer, default=10)
    label: Mapped[str] = mapped_column(String(200), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    clip_key: Mapped[str] = mapped_column(String(300), default="")   # "" pending, "-" unavailable
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)


class ApiKey(Base):
    """Machine access for other departmental systems: hashed key, feature scopes, department scope."""
    __tablename__ = "api_keys"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100))
    prefix: Mapped[str] = mapped_column(String(12), index=True)        # first chars, shown in the UI
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    features: Mapped[list] = mapped_column(JSON, default=list)
    departments: Mapped[list] = mapped_column(JSON, default=list)      # ["*"] = all
    tenant: Mapped[str] = mapped_column(String(32), default="")
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_used: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    revoked_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Webhook(Base):
    """Outbound subscription: events of the listed kinds are POSTed as signed JSON."""
    __tablename__ = "webhooks"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100))
    url: Mapped[str] = mapped_column(String(500))
    secret: Mapped[str] = mapped_column(String(128), default="")
    kinds: Mapped[list] = mapped_column(JSON, default=list)            # anpr.event | alert | incident | challan | camera.health
    departments: Mapped[list] = mapped_column(JSON, default=list)      # ["*"] = all
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    failures: Mapped[int] = mapped_column(Integer, default=0)
    last_status: Mapped[str] = mapped_column(String(200), default="")
    last_delivery: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Notification(Base):
    """Delivery log for email / SMS / WhatsApp / CAD webhook notifications."""
    __tablename__ = "notifications"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)
    channel: Mapped[str] = mapped_column(String(16))                   # email | sms | whatsapp | webhook
    recipient: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(32))                      # alert | incident | camera.health | break_glass ...
    ref_id: Mapped[str] = mapped_column(String(32), default="")
    subject: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued | sent | failed
    detail: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)


class CameraStatusLog(Base):
    """Status transitions per camera for uptime / SLA reporting."""
    __tablename__ = "camera_status_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    camera_id: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)
    status: Mapped[str] = mapped_column(String(16))                    # online | live | offline
    detail: Mapped[str] = mapped_column(String(200), default="")


class CameraQuality(Base):
    """Periodic image-quality sample per camera."""
    __tablename__ = "camera_quality"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    camera_id: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)
    sharpness: Mapped[float] = mapped_column(Float, default=0)         # Laplacian variance
    brightness: Mapped[float] = mapped_column(Float, default=0)        # mean luma 0-255
    frozen: Mapped[bool] = mapped_column(Boolean, default=False)
    tampered: Mapped[bool] = mapped_column(Boolean, default=False)     # scene differs from reference
    verdict: Mapped[str] = mapped_column(String(16), default="ok")     # ok | blurry | dark | frozen | tampered | no_signal


class TrafficCount(Base):
    """One row per camera per window: average vehicles in view by class, peak, and line-crossing flow."""
    __tablename__ = "traffic_counts"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    camera_id: Mapped[str] = mapped_column(String(64), index=True)
    department: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), index=True)
    window_s: Mapped[int] = mapped_column(Integer, default=60)
    frames: Mapped[int] = mapped_column(Integer, default=0)
    avg_vehicles: Mapped[float] = mapped_column(Float, default=0)
    peak_vehicles: Mapped[int] = mapped_column(Integer, default=0)
    avg: Mapped[dict] = mapped_column(JSON, default=dict)          # {"car": 3.2, "bus": 0.4, "person": 1.1}
    flow: Mapped[dict | None] = mapped_column(JSON, nullable=True) # {"a_to_b": 12, "b_to_a": 9} when a line is set


class PlateReview(Base):
    """Operator verdict on a plate read: confirmed as read, or corrected to another plate.
    Feeds the weekly accuracy report and the OCR retraining set."""
    __tablename__ = "plate_reviews"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    event_id: Mapped[str] = mapped_column(String(32), index=True)
    camera_id: Mapped[str] = mapped_column(String(64), index=True)
    department: Mapped[str] = mapped_column(String(64))
    read_plate: Mapped[str] = mapped_column(String(16))
    true_plate: Mapped[str] = mapped_column(String(16))          # == read_plate when confirmed
    verdict: Mapped[str] = mapped_column(String(16))             # confirmed | corrected | unreadable
    reason: Mapped[str] = mapped_column(String(64), default="")  # e.g. two_line, night, dirty, decorative_font, occluded
    confidence: Mapped[float] = mapped_column(Float, default=0)
    crop_path: Mapped[str] = mapped_column(String(300), default="")
    user_id: Mapped[str] = mapped_column(String(64))
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)


class AuditLog(Base):
    """Append-only, hash-chained: each row's hash covers its content and the previous row's hash,
    so any edit or deletion is detectable (/api/audit/verify)."""
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)
    user_id: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(64))
    target: Mapped[str] = mapped_column(Text, default="")
    detail: Mapped[str] = mapped_column(Text, default="")
    ip: Mapped[str] = mapped_column(String(64), default="")
    prev_hash: Mapped[str] = mapped_column(String(64), default="")
    hash: Mapped[str] = mapped_column(String(64), default="")


class Users(Base):
    """ONE table for every console account: identity, password, role, 2FA and lockout.

    provider = "db"      account created through /api/auth/signup (the super admin) or by a super admin via
                         /api/users; has a PBKDF2 password_hash and is the only kind that can log in with a
                         password from this table.
    provider = "users.yaml" | "ldap" | "oidc"
                         directory / demo accounts: the row is created on their first login (or first failed
                         attempt) so that 2FA enrolment and lockout work for them too; password_hash stays "".
    Once a "db" account exists the users.yaml demo accounts are ignored (auth.yaml providers.local.keep_yaml_users).
    The TOTP secret is encrypted with TOKEN_SECRET; backup codes are stored hashed.
    """
    __tablename__ = "users"
    username: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(16), default="db")
    password_hash: Mapped[str] = mapped_column(String(200), default="")
    role: Mapped[str] = mapped_column(String(16), default="viewer")        # viewer | analyst | supervisor | admin
    departments: Mapped[list] = mapped_column(JSON, default=lambda: ["*"])
    cameras: Mapped[list] = mapped_column(JSON, default=list)              # explicit camera grants beyond departments
    is_super: Mapped[bool] = mapped_column(Boolean, default=False)         # may create / remove accounts
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)         # False = login refused, row kept for audit
    tenant: Mapped[str] = mapped_column(String(32), default="")
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    password_changed_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    # ---- two-factor
    totp_secret_enc: Mapped[str] = mapped_column(String(200), default="")   # "" = off, "pending:..." = QR shown, else active
    mfa_enrolled_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    backup_codes: Mapped[list] = mapped_column(JSON, default=list)          # sha256 of each one-time code
    grace_logins_used: Mapped[int] = mapped_column(Integer, default=0)      # logins before enrolment is enforced
    # ---- lockout / activity
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_login: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    @property
    def mfa_state(self) -> str:
        if not self.totp_secret_enc:
            return "off"
        return "pending" if self.totp_secret_enc.startswith("pending:") else "enrolled"

    @property
    def mfa_enrolled(self) -> bool:
        return self.mfa_state == "enrolled"


class AccessGrant(Base):
    """Fine-grained, time-bound access on top of the role: a feature, a camera or a department.
    kind=break_glass records an emergency elevation with its justification."""
    __tablename__ = "access_grants"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(16))         # feature | camera | department | break_glass
    value: Mapped[str] = mapped_column(String(128))       # feature name / camera id / department / "*"
    reason: Mapped[str] = mapped_column(Text, default="")
    granted_by: Mapped[str] = mapped_column(String(64))
    starts_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    revoked_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    revoked_by: Mapped[str] = mapped_column(String(64), default="")


class LegalHold(Base):
    """Blocks retention purge and DPDP erasure for matching records until released."""
    __tablename__ = "legal_holds"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    kind: Mapped[str] = mapped_column(String(16))         # plate | camera | event | case
    value: Mapped[str] = mapped_column(String(128), index=True)
    from_ts: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)   # camera holds: window
    to_ts: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    reference: Mapped[str] = mapped_column(String(128), default="")   # FIR / court order number
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    released_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    released_by: Mapped[str] = mapped_column(String(64), default="")


def _make_engine():
    return _make_engine_for(settings.database_url)


def _make_engine_for(url: str):
    kw = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        kw["connect_args"] = {"check_same_thread": False, "timeout": 30}
    eng = create_engine(url, **kw)
    if url.startswith("sqlite"):
        @event.listens_for(eng, "connect")
        def _wal(conn, _):  # allow concurrent readers while workers write
            conn.execute("PRAGMA journal_mode=WAL")
    return eng


engine = _make_engine()
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def rebind(url: str) -> None:
    """Point the module at another database (tests, tooling). Sessions created afterwards use it."""
    global engine
    engine = _make_engine_for(url)
    SessionLocal.configure(bind=engine)
    Base.metadata.create_all(engine)
    _migrate()


def init_db() -> None:
    Base.metadata.create_all(engine)
    _migrate()


def _migrate() -> None:
    """Add columns introduced after a database was first created (no Alembic in the pilot)."""
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    _merge_user_security(insp, text)
    have = {c["name"] for c in insp.get_columns("anpr_events")}
    have_audit = {c["name"] for c in insp.get_columns("audit_log")}
    with engine.begin() as con:
        for col in ("clip_key", "crop_key", "frame_key"):
            if col not in have:
                con.execute(text(f"ALTER TABLE anpr_events ADD COLUMN {col} VARCHAR(300) DEFAULT ''"))
        for col in ("prev_hash", "hash"):
            if col not in have_audit:
                con.execute(text(f"ALTER TABLE audit_log ADD COLUMN {col} VARCHAR(64) DEFAULT ''"))
        for col, ddl in (("vehicle_type", "VARCHAR(24) DEFAULT ''"), ("vehicle_colour", "VARCHAR(16) DEFAULT ''"),
                         ("plate_colour", "VARCHAR(12) DEFAULT ''"), ("make_model", "VARCHAR(64) DEFAULT ''"), ("attrs", "JSON")):
            if col not in have:
                con.execute(text(f"ALTER TABLE anpr_events ADD COLUMN {col} {ddl}"))
        have_src = {c["name"] for c in insp.get_columns("sources")}
        for col, ddl in (("managed", "BOOLEAN DEFAULT FALSE"), ("config", "JSON"), ("secret_enc", "TEXT DEFAULT ''"),
                         ("created_by", "VARCHAR(64) DEFAULT ''"), ("updated_at", "TIMESTAMP")):
            if col not in have_src:
                con.execute(text(f"ALTER TABLE sources ADD COLUMN {col} {ddl}"))
        have_cam = {c["name"] for c in insp.get_columns("cameras")}
        for col in ("heading", "fov", "range_m"):
            if col not in have_cam:
                con.execute(text(f"ALTER TABLE cameras ADD COLUMN {col} FLOAT"))
        if "relay" not in have_cam:
            con.execute(text("ALTER TABLE cameras ADD COLUMN relay VARCHAR(32) DEFAULT ''"))
        if "anpr_cfg" not in have_cam:
            con.execute(text("ALTER TABLE cameras ADD COLUMN anpr_cfg JSON"))
        for col, ddl in (("camera_type", "VARCHAR(24) DEFAULT ''"), ("make_model", "VARCHAR(100) DEFAULT ''"),
                         ("resolution", "VARCHAR(16) DEFAULT ''"), ("ownership", "VARCHAR(48) DEFAULT ''"),
                         ("owner_contact", "VARCHAR(120) DEFAULT ''"), ("connectivity", "VARCHAR(24) DEFAULT ''"),
                         ("storage_type", "VARCHAR(24) DEFAULT ''"), ("storage_days", "INTEGER"),
                         ("install_date", "VARCHAR(10) DEFAULT ''"), ("warranty_until", "VARCHAR(10) DEFAULT ''"),
                         ("maintenance_status", "VARCHAR(24) DEFAULT ''"), ("last_maintenance", "VARCHAR(10) DEFAULT ''"),
                         ("address", "VARCHAR(200) DEFAULT ''"), ("zone", "VARCHAR(64) DEFAULT ''"), ("ward", "VARCHAR(64) DEFAULT ''"),
                         ("pole_id", "VARCHAR(64) DEFAULT ''"), ("tags", "JSON"), ("notes", "TEXT DEFAULT ''"), ("meta", "JSON"),
                         ("created_at", "TIMESTAMP"), ("created_by", "VARCHAR(64) DEFAULT ''"), ("updated_by", "VARCHAR(64) DEFAULT ''")):
            if col not in have_cam:
                con.execute(text(f"ALTER TABLE cameras ADD COLUMN {col} {ddl}"))


_audit_lock = threading.Lock()


def audit_hash(prev_hash: str, ts: dt.datetime, user_id: str, action: str, target: str, detail: str, ip: str) -> str:
    body = "|".join([prev_hash, ts.astimezone(dt.timezone.utc).isoformat(timespec="microseconds"), user_id, action,
                     target or "", detail or "", ip or ""])
    return hashlib.sha256(body.encode()).hexdigest()


def audit(session, user_id: str, action: str, target: str = "", detail: str = "", ip: str = "") -> None:
    """Append one audit row, chained to the previous one. Rows are committed by the caller."""
    from sqlalchemy import select
    with _audit_lock:
        session.flush()
        last = session.scalar(select(AuditLog).order_by(AuditLog.id.desc()).limit(1))
        prev = last.hash if last else ""
        ts = utcnow()
        row = AuditLog(ts=ts, user_id=user_id, action=action, target=target, detail=detail, ip=ip, prev_hash=prev,
                       hash=audit_hash(prev, ts, user_id, action, target, detail, ip))
        session.add(row)
        session.flush()


def custody(session, case_id: str, action: str, user_id: str, item_id: str = "", detail: str = "", sha256: str = "") -> None:
    from sqlalchemy import select
    with _audit_lock:
        session.flush()
        last = session.scalar(select(CustodyLog).where(CustodyLog.case_id == case_id).order_by(CustodyLog.id.desc()).limit(1))
        prev = last.hash if last else ""
        ts = utcnow()
        h = audit_hash(prev, ts, user_id, action, f"{case_id}:{item_id}", detail, sha256)
        session.add(CustodyLog(ts=ts, case_id=case_id, item_id=item_id, action=action, user_id=user_id, detail=detail,
                               sha256=sha256, prev_hash=prev, hash=h))
        session.flush()


def verify_custody_chain(session, case_id: str) -> dict:
    from sqlalchemy import select
    prev, n = "", 0
    for r in session.scalars(select(CustodyLog).where(CustodyLog.case_id == case_id).order_by(CustodyLog.id)):
        n += 1
        if r.prev_hash != prev or r.hash != audit_hash(r.prev_hash, r.ts, r.user_id, r.action, f"{case_id}:{r.item_id}", r.detail, r.sha256):
            return {"ok": False, "rows": n, "first_bad_id": r.id}
        prev = r.hash
    return {"ok": True, "rows": n, "first_bad_id": None}


def verify_audit_chain(session) -> dict:
    """Walk the chain from the first row. Returns {ok, rows, first_bad_id}."""
    from sqlalchemy import select
    prev, n = None, 0
    for r in session.scalars(select(AuditLog).order_by(AuditLog.id)):
        n += 1
        if not r.hash:  # rows written before hashing existed are reported, not failed
            prev = ""
            continue
        if prev is None:   # chain may have been trimmed at the head by retention: start from this row
            prev = r.prev_hash
        if r.prev_hash != prev or r.hash != audit_hash(r.prev_hash, r.ts, r.user_id, r.action, r.target, r.detail, r.ip):
            return {"ok": False, "rows": n, "first_bad_id": r.id}
        prev = r.hash
    return {"ok": True, "rows": n, "first_bad_id": None}


def _merge_user_security(insp, text) -> None:
    """Releases before 1.1 kept 2FA / lockout state in a separate user_security table. Fold those rows into
    users (as provider 'users.yaml' / directory rows when no account of that name exists) and drop the table."""
    if not insp.has_table("user_security"):
        return
    with engine.begin() as con:
        rows = con.execute(text("select username, totp_secret_enc, mfa_enrolled_at, backup_codes, failed_logins, "
                                "locked_until, last_login, grace_logins_used from user_security")).mappings().all()
        for r in rows:
            exists = con.execute(text("select 1 from users where username = :u"), {"u": r["username"]}).first()
            if exists:
                con.execute(text("update users set totp_secret_enc=:t, mfa_enrolled_at=:m, backup_codes=:b, failed_logins=:f, "
                                 "locked_until=:l, last_login=:ll, grace_logins_used=:g where username=:u"),
                            {"t": r["totp_secret_enc"] or "", "m": r["mfa_enrolled_at"], "b": r["backup_codes"] or "[]",
                             "f": r["failed_logins"] or 0, "l": r["locked_until"], "ll": r["last_login"],
                             "g": r["grace_logins_used"] or 0, "u": r["username"]})
            else:
                con.execute(text("insert into users (username, provider, password_hash, role, departments, cameras, is_super, "
                                 "is_active, tenant, created_by, created_at, totp_secret_enc, mfa_enrolled_at, backup_codes, "
                                 "grace_logins_used, failed_logins, locked_until, last_login) values "
                                 "(:u, 'users.yaml', '', 'viewer', '[\"*\"]', '[]', :f0, :t1, '', 'migration', :now, :t, :m, :b, :g, :f, :l, :ll)"),
                            {"u": r["username"], "f0": False, "t1": True, "now": utcnow(), "t": r["totp_secret_enc"] or "",
                             "m": r["mfa_enrolled_at"], "b": r["backup_codes"] or "[]", "g": r["grace_logins_used"] or 0,
                             "f": r["failed_logins"] or 0, "l": r["locked_until"], "ll": r["last_login"]})
        con.execute(text("drop table user_security"))
