"""Runtime settings, all overridable through environment variables."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


_SECRET_NAME = re.compile(r"^[A-Z0-9_]*(SECRET|PASS|PASSWORD|_KEY|TOKEN|_USER)$")
_NOT_SECRETS = ("SSL_", "CA_", "CERT", "NIX_", "CLOUDSDK", "GIT_", "NODE_", "NPM_", "PIP_", "REQUESTS_CA", "CURL_")


def _load_secret_files() -> None:
    """Docker/Kubernetes secrets: NAME_FILE=/run/secrets/x sets NAME from the file's contents,
    for platform credential names only (…_PASS, …_SECRET, …_KEY, …_TOKEN, …_USER)."""
    for k, v in list(os.environ.items()):
        if not k.endswith("_FILE") or not v:
            continue
        name = k[:-5]
        if not _SECRET_NAME.match(name) or name.startswith(_NOT_SECRETS) or name.endswith("SIGNING_KEY"):
            continue
        if os.path.isfile(v) and os.path.getsize(v) <= 65536:
            os.environ.setdefault(name, Path(v).read_text().strip())


def _load_vault() -> None:
    """HashiCorp Vault KV v2: VAULT_ADDR + VAULT_TOKEN (or VAULT_TOKEN_FILE) + VAULT_KV_PATH
    (e.g. secret/data/uvp). Every key in that secret becomes an environment variable unless
    already set, so .env can hold nothing sensitive."""
    addr, path = os.environ.get("VAULT_ADDR"), os.environ.get("VAULT_KV_PATH")
    tok = os.environ.get("VAULT_TOKEN")
    if not (addr and path and tok):
        return
    import requests
    r = requests.get(f"{addr.rstrip('/')}/v1/{path.strip('/')}", headers={"X-Vault-Token": tok}, timeout=10)
    r.raise_for_status()
    data = r.json().get("data", {})
    data = data.get("data", data)      # KV v2 nests under data.data
    for k, v in data.items():
        os.environ.setdefault(k, str(v))


_load_secret_files()
_load_vault()


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass
class Settings:
    database_url: str = _env("DATABASE_URL", f"sqlite:///{ROOT / 'data' / 'uvp.db'}")
    # "http" = ANPR workers post events straight to the API (single-host pilot, no Kafka)
    # "kafka" = events flow through Kafka topics and a separate indexer service
    bus: str = _env("BUS", "http")
    kafka_bootstrap: str = _env("KAFKA_BOOTSTRAP", "localhost:9092")
    es_url: str = _env("ES_URL", "")  # empty = search on PostgreSQL/SQLite
    es_index_prefix: str = _env("ES_INDEX_PREFIX", "anpr-events")

    api_url: str = _env("API_URL", "http://localhost:8000")
    internal_secret: str = _env("INTERNAL_SECRET", "change-me-internal")
    token_secret: str = _env("TOKEN_SECRET", "change-me-token")
    token_ttl_s: int = int(_env("TOKEN_TTL_S", "43200"))

    relay_api: str = _env("RELAY_API", "http://localhost:9997")
    relay_rtsp: str = _env("RELAY_RTSP", "rtsp://localhost:8554")
    relay_internal_user: str = _env("RELAY_INTERNAL_USER", "uvp-internal")
    relay_internal_pass: str = _env("RELAY_INTERNAL_PASS", "change-me-relay")
    relay_webrtc_port: int = int(_env("RELAY_WEBRTC_PORT", "8889"))
    relay_hls_port: int = int(_env("RELAY_HLS_PORT", "8888"))
    relay_public_host: str = _env("RELAY_PUBLIC_HOST", "")  # empty = same host as the web UI

    auth_file: Path = Path(_env("AUTH_FILE", str(ROOT / "config" / "auth.yaml")))
    signing_key_file: Path = Path(_env("SIGNING_KEY_FILE", str(ROOT / "data" / "signing_ed25519.key")))
    pii_blur_faces: bool = _env("PII_BLUR_FACES", "1") == "1"        # blur faces in stored evidence frames
    pii_mask_plates: bool = _env("PII_MASK_PLATES", "1") == "1"      # users without plate_search see masked plates
    login_max_failures: int = int(_env("LOGIN_MAX_FAILURES", "5"))
    login_lockout_s: int = int(_env("LOGIN_LOCKOUT_S", "900"))
    s3_sse: str = _env("S3_SSE", "")                                  # "AES256" or "aws:kms" for at-rest encryption headers
    relay_public_base: str = _env("RELAY_PUBLIC_BASE", "")            # e.g. https://cctv.example.gov.in/relay when behind the TLS proxy
    sources_file: Path = Path(_env("SOURCES_FILE", str(ROOT / "config" / "sources.yaml")))
    users_file: Path = Path(_env("USERS_FILE", str(ROOT / "config" / "users.yaml")))
    rules_file: Path = Path(_env("RULES_FILE", str(ROOT / "config" / "rules.yaml")))
    data_dir: Path = Path(_env("DATA_DIR", str(ROOT / "data")))
    web_dir: Path = Path(_env("WEB_DIR", str(ROOT / "platform" / "web")))

    anpr_fps: float = float(_env("ANPR_FPS", "4"))
    anpr_threads: int = int(_env("ANPR_THREADS", "1"))
    anpr_workers: int = int(_env("ANPR_WORKERS", "0"))            # cameras processed in parallel; 0 = cores // threads
    anpr_gpu: bool = _env("ANPR_GPU", "0") == "1"
    anpr_ocr_engine: str = _env("ANPR_OCR_ENGINE", "paddle")  # paddle (PaddleOCR, fast-plate as fallback) | fastplate | both
    anpr_home_states: list = None  # set below from ANPR_HOME_STATES, e.g. "MP" or "MP,CG"
    anpr_home_state_max_conf: float = float(_env("ANPR_HOME_STATE_MAX_CONF", "1.01"))  # <1 = only fix unsure letters
    anpr_night: str = _env("ANPR_NIGHT", "auto")          # auto | on | off: low-light / IR enhancement
    anpr_night_luma: float = float(_env("ANPR_NIGHT_LUMA", "80"))  # frame mean brightness below this = night
    anpr_tiles: int = int(_env("ANPR_TILES", "1"))            # 2 = also detect on 2x2 overlapping tiles (small plates)
    anpr_upscale: bool = _env("ANPR_UPSCALE", "0") == "1"     # enlarge + sharpen small plate crops before OCR
    anpr_crop_min_h: int = int(_env("ANPR_CROP_MIN_H", "80"))  # target crop height (px) after upscaling
    anpr_detector: str = _env("ANPR_DETECTOR", "yolo-v9-t-384-license-plate-end2end")
    anpr_ocr: str = _env("ANPR_OCR", "cct-s-v2-global-model")
    anpr_det_conf: float = float(_env("ANPR_DET_CONF", "0.3"))
    anpr_min_char_conf: float = float(_env("ANPR_MIN_CHAR_CONF", "0.5"))
    anpr_track_gap_s: float = float(_env("ANPR_TRACK_GAP_S", "1.5"))
    anpr_dedupe_s: float = float(_env("ANPR_DEDUPE_S", "30"))

    # ---- analytics beyond ANPR ----
    analytics_enabled: bool = _env("ANALYTICS_ENABLED", "1") == "1"
    analytics_model: str = _env("ANALYTICS_MODEL", "platform/models/yolox_nano.onnx")   # COCO detector (Apache-2.0)
    analytics_conf: float = float(_env("ANALYTICS_CONF", "0.35"))
    analytics_fps: float = float(_env("ANALYTICS_FPS", "2"))          # zone analytics sampling rate per camera
    analytics_count_all: bool = _env("ANALYTICS_COUNT_ALL", "1") == "1"   # vehicle + person counting and crowd alert on every pulled camera
    crowd_max_persons: int = int(_env("CROWD_MAX_PERSONS", "25"))       # default crowd alert threshold (persons in view)
    geocode_url: str = _env("GEOCODE_URL", "https://nominatim.openstreetmap.org/search")   # OSM Nominatim (or your own instance)
    geocode_region: str = _env("GEOCODE_REGION", "Gujarat, India")                            # appended to camera names
    geocode_contact: str = _env("GEOCODE_CONTACT", "")                                        # e-mail for the Nominatim User-Agent policy
    analytics_threads: int = int(_env("ANALYTICS_THREADS", _env("ANPR_THREADS", "2")))   # ONNX threads per inference
    analytics_workers: int = int(_env("ANALYTICS_WORKERS", "0"))      # cameras processed in parallel; 0 = cores // threads
    analytics_file: Path = Path(_env("ANALYTICS_FILE", str(ROOT / "config" / "analytics.yaml")))
    analytics_make_model_model: str = _env("ANALYTICS_MAKE_MODEL_MODEL", "")   # customer ONNX classifier + .txt labels
    analytics_helmet_model: str = _env("ANALYTICS_HELMET_MODEL", "")           # customer ONNX classifier: helmet / no_helmet
    # ---- face recognition (persons of interest) ----
    face_enabled: bool = _env("FACE_ENABLED", "1") == "1"
    face_fps: float = float(_env("FACE_FPS", "2"))                     # frames per second sampled per camera
    face_det_score: float = float(_env("FACE_DET_SCORE", "0.8"))       # YuNet detection confidence
    face_min_px: int = int(_env("FACE_MIN_PX", "32"))                  # smallest face width worth embedding
    face_match_threshold: float = float(_env("FACE_MATCH_THRESHOLD", "0.40"))   # SFace cosine; 0.363 = OpenCV default
    face_dedupe_s: float = float(_env("FACE_DEDUPE_S", "30"))          # one alert per person per camera per window
    face_cameras: str = _env("FACE_CAMERAS", "")                       # "" = cameras with face: true in analytics.yaml; "all" = every camera; or a comma list
    face_threads: int = int(_env("FACE_THREADS", "2"))
    face_workers: int = int(_env("FACE_WORKERS", "0"))
    analysis_max_frames: int = int(_env("ANALYSIS_MAX_FRAMES", "900"))
    analysis_workers: int = int(_env("ANALYSIS_WORKERS", str(min(4, max(1, (os.cpu_count() or 2) // 2)))))  # frames analysed in parallel per upload   # uploaded-video analysis: frames sampled at most (2 fps -> 7.5 min)
    echallan_webhook_url: str = _env("ECHALLAN_WEBHOOK_URL", "")
    echallan_webhook_secret: str = _env("ECHALLAN_WEBHOOK_SECRET", "")
    hotlists_file: Path = Path(_env("HOTLISTS_FILE", str(ROOT / "config" / "hotlists.yaml")))

    # ---- product ----
    version: str = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").exists() else "dev"
    license_file: Path = Path(_env("LICENSE_FILE", str(ROOT / "config" / "license.json")))
    license_report_url: str = _env("LICENSE_REPORT_URL", "")
    default_language: str = _env("DEFAULT_LANGUAGE", "en")           # en | hi (console + field app)

    # ---- HA & scale ----
    metrics_port: int = int(_env("METRICS_PORT", "0"))                 # workers: Prometheus endpoint port (0 = off)
    relay_apis: str = _env("RELAY_APIS", "")                            # relay cluster: "relay-a=http://relay-a:9997,relay-b=http://relay-b:9997"
    relay_rtsps: str = _env("RELAY_RTSPS", "")                          # matching RTSP endpoints "relay-a=rtsp://relay-a:8554,..."
    relay_playbacks: str = _env("RELAY_PLAYBACKS", "")                  # matching playback endpoints
    relay_public_hosts: str = _env("RELAY_PUBLIC_HOSTS", "")            # "relay-a=cctv-a.example.gov.in,relay-b=..." for browsers
    anpr_shard: str = _env("ANPR_SHARD", "0/1")                         # "i/n": this worker handles cameras hashed to shard i of n
    edge: bool = _env("EDGE", "0") == "1"                               # edge ANPR: read cameras directly, buffer events offline
    edge_cameras: str = _env("EDGE_CAMERAS", "")                        # "cam-id=rtsp://...,cam2=rtsp://..." when EDGE=1
    edge_department: str = _env("EDGE_DEPARTMENT", "Police")
    outbox_file: Path = Path(_env("OUTBOX_FILE", str(ROOT / "data" / "outbox.db")))

    # ---- operations & integration ----
    notify_file: Path = Path(_env("NOTIFY_FILE", str(ROOT / "config" / "notify.yaml")))
    tenants_file: Path = Path(_env("TENANTS_FILE", str(ROOT / "config" / "tenants.yaml")))
    vendors_file: Path = Path(_env("VENDORS_FILE", str(ROOT / "config" / "vendors.yaml")))
    ticket_webhook_url: str = _env("TICKET_WEBHOOK_URL", "")           # Jira / ServiceNow / generic ticketing intake
    ticket_webhook_secret: str = _env("TICKET_WEBHOOK_SECRET", "")
    outage_ticket_minutes: int = int(_env("OUTAGE_TICKET_MINUTES", "15"))
    quality_interval_s: int = int(_env("QUALITY_INTERVAL_S", "300"))  # image-quality sample per camera
    vahan_url: str = _env("VAHAN_URL", "")                              # e.g. http://sim-hotlist:18095/vahan/{plate}
    vahan_headers: str = _env("VAHAN_HEADERS", "")                      # JSON dict of headers (API key)

    # ---- video archive (object storage) ----
    object_storage: str = _env("OBJECT_STORAGE", "local")       # local | s3
    s3_endpoint: str = _env("S3_ENDPOINT", "")                  # Oracle: https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
    s3_region: str = _env("S3_REGION", "")                      # Oracle: e.g. ap-mumbai-1
    s3_bucket: str = _env("S3_BUCKET", "uvp-video")
    s3_access_key: str = _env("S3_ACCESS_KEY", "")              # Oracle: customer secret key (access key part)
    s3_secret_key: str = _env("S3_SECRET_KEY", "")
    s3_prefix: str = _env("S3_PREFIX", "")                      # optional folder inside the bucket
    s3_path_style: bool = _env("S3_PATH_STYLE", "1") == "1"     # Oracle and MinIO need path-style
    s3_url_ttl_s: int = int(_env("S3_URL_TTL_S", "900"))        # lifetime of presigned playback links
    record_mode: str = _env("RECORD_MODE", "anpr")              # none | anpr (ANPR cameras) | all
    record_segment_s: int = int(_env("RECORD_SEGMENT_S", "60"))
    record_local_keep: str = _env("RECORD_LOCAL_KEEP", "6h")    # relay disk buffer before segments are dropped
    recordings_dir: Path = Path(_env("RECORDINGS_DIR", str(ROOT / "data" / "recordings")))
    relay_playback: str = _env("RELAY_PLAYBACK", "http://localhost:9996")
    clip_before_s: int = int(_env("CLIP_BEFORE_S", "4"))
    clip_after_s: int = int(_env("CLIP_AFTER_S", "4"))
    archive_interval_s: int = int(_env("ARCHIVE_INTERVAL_S", "15"))

    health_interval_s: int = int(_env("HEALTH_INTERVAL_S", "20"))   # one-request ping per source
    sync_interval_s: int = int(_env("SYNC_INTERVAL_S", "300"))      # full camera re-discovery
    auth_backoff_s: int = int(_env("AUTH_BACKOFF_S", "600"))         # pause a source's pulls this long after a 401 (lockout guard)
    relay_add_stagger_s: float = float(_env("RELAY_ADD_STAGGER_S", "0.5"))   # pause between persistent path adds (gateway login burst)

    @property
    def crops_dir(self) -> Path:
        p = self.data_dir / "crops"
        p.mkdir(parents=True, exist_ok=True)
        return p


settings = Settings()
settings.anpr_home_states = [x.strip().upper() for x in _env("ANPR_HOME_STATES", "").split(",") if x.strip()]

_VAR = re.compile(r"\$\{([A-Z0-9_]+)(?::-([^}]*))?\}")


def expand_env(text: str) -> str:
    """Expand ${VAR} and ${VAR:-default} inside YAML config files."""
    return _VAR.sub(lambda m: os.environ.get(m.group(1), m.group(2) or ""), text)


def load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    return yaml.safe_load(expand_env(path.read_text())) or {}
