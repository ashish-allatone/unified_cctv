"""Event bus: Kafka for the full deployment, direct HTTP for a single-host pilot.

Topics
  anpr.events     ANPR workers -> indexer
  events.tags     viewer/rules -> indexer
  alerts          indexer -> API (pushed to operator consoles)
  health.sources  adapter service -> monitoring
"""
from __future__ import annotations

import json
import logging
import time
from typing import Callable, Iterable

import requests

from .config import settings

log = logging.getLogger("uvp.bus")
TOPIC_ANPR = "anpr.events"
TOPIC_INCIDENTS = "analytics.incidents"
TOPIC_DETS = "analytics.dets"          # live detection boxes for the console overlay (not stored)
TOPIC_TAGS = "events.tags"
TOPIC_ALERTS = "alerts"
TOPIC_HEALTH = "health.sources"


class Outbox:
    """Durable store-and-forward queue (SQLite) for edge nodes with an unreliable link to the centre."""

    def __init__(self, path):
        import sqlite3
        from pathlib import Path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.con = sqlite3.connect(str(path), check_same_thread=False)
        self.con.execute("CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, body TEXT, ts REAL)")
        self.con.commit()

    def put(self, topic: str, msg: dict) -> None:
        self.con.execute("INSERT INTO outbox (topic, body, ts) VALUES (?, ?, ?)", (topic, json.dumps(msg, default=str), time.time()))
        self.con.commit()

    def pending(self) -> int:
        return self.con.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]

    def drain(self, send, limit: int = 200) -> int:
        """Replay oldest first; stop at the first failure so ordering is preserved."""
        n = 0
        for rid, topic, body in self.con.execute("SELECT id, topic, body FROM outbox ORDER BY id LIMIT ?", (limit,)).fetchall():
            if not send(topic, json.loads(body)):
                break
            self.con.execute("DELETE FROM outbox WHERE id = ?", (rid,))
            self.con.commit()
            n += 1
        return n


class HttpPublisher:
    """No-Kafka mode: POST events to the API, which indexes them in-process. With EDGE=1 (or whenever
    the API is unreachable) events are queued on disk and replayed in order when the link returns."""

    def __init__(self):
        self.s = requests.Session()
        self.s.headers["X-Internal-Secret"] = settings.internal_secret
        self.outbox = Outbox(settings.outbox_file) if settings.edge else None
        self._last_drain = 0.0

    def _send(self, topic: str, msg: dict) -> bool:
        path = {TOPIC_ANPR: "/internal/events", TOPIC_INCIDENTS: "/internal/incidents", TOPIC_DETS: "/internal/dets"}.get(topic)
        if not path:
            return True
        try:
            r = self.s.post(f"{settings.api_url}{path}", json=msg, timeout=5)
            return r.status_code < 500 and r.status_code != 403
        except requests.RequestException:
            return False

    def publish(self, topic: str, msg: dict) -> None:
        if self.outbox is not None:
            self.outbox.put(topic, msg)
            self.drain()
            return
        for attempt in range(3):
            if self._send(topic, msg):
                return
            log.warning("publish failed, retry %d", attempt + 1)
            time.sleep(1 + attempt)

    def drain(self) -> int:
        if self.outbox is None:
            return 0
        n = self.outbox.drain(self._send)
        left = self.outbox.pending()
        if left:
            log.info("outbox: %d sent, %d waiting for the link", n, left)
        return n


class KafkaPublisher:
    def __init__(self):
        from kafka import KafkaProducer
        self.p = KafkaProducer(bootstrap_servers=settings.kafka_bootstrap,
                               value_serializer=lambda v: json.dumps(v, default=str).encode(),
                               key_serializer=lambda k: k.encode() if k else None,
                               acks="all", linger_ms=20, retries=5)

    def publish(self, topic: str, msg: dict) -> None:
        self.p.send(topic, key=msg.get("camera_id"), value=msg)


def publisher():
    return KafkaPublisher() if settings.bus == "kafka" else HttpPublisher()


def consume(topics: Iterable[str], group: str, handler: Callable[[str, dict], None]) -> None:
    from kafka import KafkaConsumer
    while True:
        try:
            c = KafkaConsumer(*topics, bootstrap_servers=settings.kafka_bootstrap, group_id=group,
                              value_deserializer=lambda b: json.loads(b.decode()), auto_offset_reset="latest",
                              enable_auto_commit=True)
            for m in c:
                try:
                    handler(m.topic, m.value)
                except Exception:  # noqa: BLE001
                    log.exception("handler failed for %s", m.topic)
        except Exception as e:  # noqa: BLE001
            log.warning("kafka consumer error: %s; reconnecting in 5 s", e)
            time.sleep(5)
