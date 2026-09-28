#!/usr/bin/env python3
"""Remove a departmental source and everything recorded from it (the simulator departments, for example).

  docker compose run --rm api python scripts/purge_source.py police municipal --demo-watchlist
  python scripts/purge_source.py police municipal --demo-watchlist          # lite mode (SQLite)

Deletes: the source rows, their cameras, ANPR events, alerts, incidents, challans, recordings, plate reviews,
camera status / quality logs, bookmarks and case items that point at those events, the relay paths, and the
media files (crops, frames, clips) of those events. --demo-watchlist also removes the three demo watchlist
plates and demo hotlist entries. Audit log entries are kept (the audit chain must stay intact).
Run it with the adapter service stopped, or it will re-register the cameras from sources.yaml if they are
still listed there.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform"))

from sqlalchemy import delete, select  # noqa: E402

from uvp.config import settings  # noqa: E402
from uvp.db import (Alert, AnprEvent, Bookmark, Camera, CameraStatusLog, CaseItem, Challan, Incident,  # noqa: E402
                    PlateReview, Recording, SessionLocal, Source, WatchlistEntry, init_db)

DEMO_PLATES = ("MH12AB1234", "DL3CAF0921", "KA05MN7788")


def purge(source_ids: list[str], demo_watchlist: bool, dry: bool) -> None:
    with SessionLocal() as s:
        srcs = [x for x in s.scalars(select(Source)) if x.id in source_ids]
        if not srcs:
            print(f"no source among {source_ids} (have: {[x.id for x in s.scalars(select(Source))]})")
        cams = [c for c in s.scalars(select(Camera)) if c.source_id in source_ids]
        cam_ids = {c.id for c in cams}
        depts = {c.department for c in cams} | {x.department for x in srcs}
        events = s.scalars(select(AnprEvent).where(AnprEvent.camera_id.in_(cam_ids))).all() if cam_ids else []
        ev_ids = {e.id for e in events}
        counts = {
            "sources": len(srcs), "cameras": len(cams), "events": len(events),
            "alerts": s.query(Alert).filter(Alert.camera_id.in_(cam_ids)).count() if cam_ids else 0,
            "incidents": s.query(Incident).filter(Incident.camera_id.in_(cam_ids)).count() if cam_ids else 0,
            "challans": s.query(Challan).filter(Challan.camera_id.in_(cam_ids)).count() if cam_ids else 0,
            "recordings": s.query(Recording).filter(Recording.camera_id.in_(cam_ids)).count() if cam_ids else 0,
            "plate_reviews": s.query(PlateReview).filter(PlateReview.camera_id.in_(cam_ids)).count() if cam_ids else 0,
            "status_log": s.query(CameraStatusLog).filter(CameraStatusLog.camera_id.in_(cam_ids)).count() if cam_ids else 0,
            "bookmarks": s.query(Bookmark).filter(Bookmark.camera_id.in_(cam_ids)).count() if cam_ids else 0,
            "case_items": s.query(CaseItem).filter(CaseItem.ref_id.in_(ev_ids)).count() if ev_ids else 0,
        }
        if demo_watchlist:
            counts["watchlist"] = s.query(WatchlistEntry).filter(
                (WatchlistEntry.plate.in_(DEMO_PLATES)) | (WatchlistEntry.added_by.like("hotlist:%demo%"))).count()
        print(f"purging {source_ids} (departments {sorted(depts)}):")
        for k, v in counts.items():
            print(f"  {k:14s} {v}")
        if dry:
            print("dry run: nothing deleted")
            return
        # media files of those events
        removed_files = 0
        for e in events:
            for rel in (e.crop_path, e.frame_path):
                p = settings.data_dir / rel if rel else None
                if p and p.exists():
                    p.unlink()
                    removed_files += 1
        if cam_ids:
            for model, col in ((Alert, Alert.camera_id), (Incident, Incident.camera_id), (Challan, Challan.camera_id),
                               (Recording, Recording.camera_id), (PlateReview, PlateReview.camera_id),
                               (CameraStatusLog, CameraStatusLog.camera_id), (Bookmark, Bookmark.camera_id),
                               (AnprEvent, AnprEvent.camera_id), (Camera, Camera.id)):
                s.execute(delete(model).where(col.in_(cam_ids)))
        if ev_ids:
            s.execute(delete(CaseItem).where(CaseItem.ref_id.in_(ev_ids)))
        for x in srcs:
            s.delete(x)
        if demo_watchlist:
            s.execute(delete(WatchlistEntry).where(WatchlistEntry.plate.in_(DEMO_PLATES)))
            s.execute(delete(WatchlistEntry).where(WatchlistEntry.added_by.like("hotlist:%demo%")))
        s.commit()
        print(f"  media files   {removed_files}")
    # relay paths and search index
    try:
        from uvp.relay import relay
        for cid in cam_ids:
            for prof in ("main", "sub", "main-h264", "sub-h264", "main-vp8", "sub-vp8"):
                relay.delete_path(f"{cid}/{prof}")
        print("  relay paths removed")
    except Exception as e:  # noqa: BLE001
        print(f"  relay paths: skipped ({e})")
    try:                                       # Elasticsearch index (SQL backend needs nothing: rows are gone)
        from uvp.search import backend
        b = backend()
        if b.name == "elasticsearch" and ev_ids:
            b.es.delete_by_query(index=f"{b.prefix}-*", body={"query": {"terms": {"camera_id": sorted(cam_ids)}}}, ignore_unavailable=True)
            print("  search index cleaned")
    except Exception:  # noqa: BLE001
        pass
    # archived clips / crops / recordings in object storage
    try:
        import datetime as dt
        from uvp.storage import delete_prefix
        future = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)
        n = 0
        for d in depts:
            n += delete_prefix(f"recordings/{d}/", future)
        for cid in cam_ids:
            n += delete_prefix(f"clips/{cid}", future)
            n += delete_prefix(f"crops/{cid}", future)
        print(f"  archive objects removed: {n}")
    except Exception as e:  # noqa: BLE001
        print(f"  archive: skipped ({e})")
    print("done. Remove the same sources from config/sources.yaml (or they come back on the next sync) and restart: docker compose restart adapters api")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="+", help="source ids from sources.yaml, e.g. police municipal")
    ap.add_argument("--demo-watchlist", action="store_true", help="also remove the 3 demo watchlist plates and demo hotlist entries")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    init_db()
    purge(a.sources, a.demo_watchlist, a.dry_run)
