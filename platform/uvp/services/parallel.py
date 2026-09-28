"""Shared bits for the frame-processing workers (ANPR, analytics).

* low-latency RTSP capture options for OpenCV/FFmpeg (the workers read the relay over TCP on the same host:
  the default FFmpeg jitter buffer only adds 1-2 s of delay to what the console shows)
* CameraPool: one in-flight inference per camera, cameras processed in parallel. ONNX Runtime releases the
  GIL while it runs, so N worker threads give ~N x the throughput on a multi-core host and the overlay on the
  video wall stops lagging behind the video by "number of cameras x inference time".
"""
from __future__ import annotations

import concurrent.futures as cf
import logging
import os
import threading
from typing import Callable

log = logging.getLogger(__name__)

LOW_LATENCY_CAPTURE = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay|max_delay;500000|reorder_queue_size;0"


def capture_options() -> None:
    """Set OPENCV_FFMPEG_CAPTURE_OPTIONS before cv2 opens anything (an explicit value in the environment wins).
    Also quiet FFmpeg's decoder chatter: joining an H.264/HEVC stream mid-GOP prints one 'could not find ref with
    POC' / 'Error constructing the frame RPS' line per frame until the first keyframe, on every reconnect."""
    os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", LOW_LATENCY_CAPTURE)
    os.environ.setdefault("OPENCV_FFMPEG_LOGLEVEL", "-8")      # AV_LOG_QUIET; set to 16 (error) to see real failures


def worker_count(requested: int, threads_per_inference: int, cameras: int = 0) -> int:
    """Number of parallel inference workers: requested, or cores // threads, never more than the cameras."""
    cores = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 2)
    n = requested if requested > 0 else max(1, cores // max(1, threads_per_inference))
    if cameras:
        n = min(n, max(1, cameras))
    return max(1, n)


class CameraPool:
    """Run `fn(camera_id, frame, ts)` for many cameras concurrently, at most one task per camera at a time."""

    def __init__(self, workers: int, name: str = "infer"):
        self.workers = workers
        self.pool = cf.ThreadPoolExecutor(max_workers=workers, thread_name_prefix=name)
        self.inflight: dict[str, cf.Future] = {}
        self.lock = threading.Lock()

    def busy(self, camera_id: str) -> bool:
        with self.lock:
            return camera_id in self.inflight

    def submit(self, camera_id: str, fn: Callable, *args) -> bool:
        """Queue one frame for a camera; False when that camera already has a frame being processed."""
        with self.lock:
            if camera_id in self.inflight:
                return False
            fut = self.pool.submit(self._run, camera_id, fn, *args)
            self.inflight[camera_id] = fut
        return True

    def _run(self, camera_id: str, fn: Callable, *args):
        try:
            return fn(camera_id, *args)
        except Exception:  # noqa: BLE001
            log.exception("%s: processing failed", camera_id)
        finally:
            with self.lock:
                self.inflight.pop(camera_id, None)

    def pending(self) -> int:
        with self.lock:
            return len(self.inflight)

    def shutdown(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)
