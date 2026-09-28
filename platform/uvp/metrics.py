"""Prometheus metrics for every service. The API exposes /metrics; workers start a small HTTP
server on METRICS_PORT (0 = off). Labels are kept low-cardinality (camera / department / kind)."""
from __future__ import annotations

import logging
import threading
import time

from prometheus_client import (CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest, start_http_server)

from .config import settings

log = logging.getLogger("uvp.metrics")

# ---- ANPR worker
ANPR_FRAMES = Counter("uvp_anpr_frames_total", "Frames sampled for ANPR", ["camera"])
ANPR_READS = Counter("uvp_anpr_reads_total", "Plate reads (before consensus)", ["camera"])
ANPR_EVENTS = Counter("uvp_anpr_events_total", "ANPR events emitted", ["camera", "department"])
ANPR_LATENCY = Histogram("uvp_anpr_frame_seconds", "Detector+OCR time per frame", buckets=(0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2))
ANPR_STREAM_UP = Gauge("uvp_anpr_stream_connected", "1 when the worker is receiving frames", ["camera"])

# ---- analytics worker
ANALYTICS_FRAMES = Counter("uvp_analytics_frames_total", "Frames analysed for zones", ["camera"])
INCIDENTS = Counter("uvp_incidents_total", "Zone incidents", ["camera", "kind"])
QUALITY_VERDICT = Gauge("uvp_camera_quality", "Image quality verdict (1 = ok)", ["camera"])

# ---- API / indexer
EVENTS_INGESTED = Counter("uvp_events_ingested_total", "ANPR events stored", ["department"])
ALERTS = Counter("uvp_alerts_total", "Alerts raised", ["department", "match"])
CHALLANS = Counter("uvp_challans_total", "Challan drafts", ["department", "offence"])
HTTP_LATENCY = Histogram("uvp_http_request_seconds", "API latency", ["route", "method"], buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5))
HTTP_REQUESTS = Counter("uvp_http_requests_total", "API requests", ["route", "method", "status"])
WS_CLIENTS = Gauge("uvp_ws_clients", "Connected operator consoles")
CAMERAS = Gauge("uvp_cameras", "Cameras by status", ["department", "status"])
RELAY_PULLS = Gauge("uvp_relay_pulls", "Streams currently pulled from a departmental source", ["source"])
RELAY_CAP = Gauge("uvp_relay_pull_cap", "Agreed concurrent-pull cap per source", ["source"])
RELAY_UP = Gauge("uvp_relay_up", "Relay reachable", ["relay"])
VIEWERS = Gauge("uvp_viewers", "Viewer sessions served by relays", ["department"])
NOTIFICATIONS = Counter("uvp_notifications_total", "Notification deliveries", ["channel", "status"])
WEBHOOK_DELIVERIES = Counter("uvp_webhook_deliveries_total", "Webhook deliveries", ["status"])

# ---- archiver
ARCHIVE_OBJECTS = Counter("uvp_archive_objects_total", "Objects written to object storage", ["kind"])
ARCHIVE_BYTES = Counter("uvp_archive_bytes_total", "Bytes written to object storage", ["kind"])
ARCHIVE_BACKLOG = Gauge("uvp_archive_backlog", "Events waiting for clip/crop archiving")
RETENTION_REMOVED = Counter("uvp_retention_removed_total", "Objects removed by retention", ["kind"])

# ---- adapters
SOURCE_UP = Gauge("uvp_source_up", "Departmental source reachable", ["source", "department"])
SOURCE_SYNC_SECONDS = Gauge("uvp_source_sync_seconds", "Last discovery duration", ["source"])


def latest() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST


def serve(port: int | None = None) -> None:
    """Start the worker metrics endpoint (idempotent, no-op when METRICS_PORT=0)."""
    p = settings.metrics_port if port is None else port
    if p:
        try:
            start_http_server(p)
            log.info("metrics on :%d/metrics", p)
        except OSError as e:
            log.warning("metrics port %d unavailable: %s", p, e)


def route_label(path: str) -> str:
    """Collapse ids so labels stay bounded: /api/cases/abc -> /api/cases/{id}."""
    parts = path.split("/")
    out = []
    for i, x in enumerate(parts):
        if i > 0 and len(x) >= 16 and not x.startswith("{") and x.replace("-", "").replace("_", "").isalnum():
            out.append("{id}")
        else:
            out.append(x)
    return "/".join(out)
