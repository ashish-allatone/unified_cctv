# Operations and integration

## Multi-tenancy

`config/tenants.yaml` names tenants (a city SPV, a commissionerate, the state command centre) as sets of
departments with their own branding. A user's departments are clipped to their tenant at login; `central`
(`departments: ["*"]`) sees everything. Users get a tenant from `users.yaml` (`tenant:`), from the LDAP/OIDC
group map (`tenant:` on the group), or automatically from the tenant that owns their departments. API keys,
cases, challans and incidents follow departments, so one deployment serves several authorities with isolated
data. Console title and accent colour come from the tenant's `branding`.

## Camera health SLA

The adapter service logs every up/down transition (`camera_status_log`). Sources → **Camera health** shows
per-camera uptime, outage count, downtime and the longest outage over 24 h / 7 d / 30 d, with a ≥ 99 % SLA
flag, and fleet uptime. The analytics worker samples every camera's picture every `QUALITY_INTERVAL_S`
(default 5 min) for **image quality**: `dark`, `frozen` (identical frames), `tampered` (scene moved away from
the learned reference), `blurry` (low Laplacian variance), `no_signal`. A change of verdict raises a
`camera.health` event (console toast, notification routes, webhooks). An outage longer than
`OUTAGE_TICKET_MINUTES` or a quality degradation opens a ticket at `TICKET_WEBHOOK_URL` (generic JSON:
summary, description, camera_id, department, priority; signed with `TICKET_WEBHOOK_SECRET`) — map the
fields in Jira / ServiceNow's intake.

## Notifications (config/notify.yaml)

Channels: `email` (SMTP), `sms` and `whatsapp` (any HTTP gateway; body template with `{to}` / `{text}`;
WhatsApp Cloud API example included), `webhook` (signed JSON, e.g. Dial-112 / CAD intake). Routes pick
events by kind (`alert`, `incident`, `camera.health`, `break_glass`), priority, department and sub-kind
(watchlist match, offence code, incident kind) and send to a list of recipients. Every attempt is logged
(Admin → Notifications) with status and gateway response; admins can send a test through any channel.

## Open API, API keys and webhooks

- OpenAPI/Swagger at `/docs` (every console call is a documented endpoint).
- **API keys** (Admin → API keys): `X-API-Key: uvp_…`, with feature scopes (never `admin`), department scope
  and expiry; hashed at rest, revocable, last-use tracked, all use audited under `apikey:<name>`.
- **Webhooks** (Admin → Webhooks): subscribe a URL to `anpr.event`, `alert`, `incident`, `challan`,
  `camera.health`, `break_glass`, optionally per department. Payload
  `{"kind", "sent_at", "data": {...}}`, header `X-UVP-Signature` = HMAC-SHA256(secret, body), 3 retries,
  auto-disabled after 50 consecutive failures, "Test" button.

## Vahan / registration lookup

`VAHAN_URL=https://…/{plate}` + `VAHAN_HEADERS` (JSON) turns `/api/vehicles/{plate}/registration` on
(feature `plate_search`, cached 1 h, audited). The field app shows it under Lookup. The simulator serves
`/vahan/{plate}` for the pilot; the real service needs credentials from the transport department.

## Field-officer app (PWA)

`https://<host>/m/` — installable from the phone's browser menu ("Add to Home screen"), works over the same
login (including 2FA) and shows live alerts (vibrates on new ones), plate lookup with registration details,
incidents with snapshots and the officer's cases; acknowledgement from the field for roles with `alerts_ack`.
Shell is cached offline; data always comes from the API.

## Vendor presets (config/vendors.yaml)

`vendor: hikvision|dahua|cpplus|uniview|axis|honeywell|bosch|milestone|genetec` on a source fills in the
adapter and endpoints: RTSP channel templates (new `rtsp_template` adapter: `host`, `channels`), ONVIF, or
REST (`vendor_rest` with `login_mode: form` for Milestone's OAuth gateway, basic-auth header for Genetec's
Web SDK). Built from public vendor documentation; **not verified against every firmware** — confirm with the
vendor integration guide, and prefer ONVIF where the device offers it.

```yaml
- id: hq-nvr
  department: Police
  vendor: hikvision
  host: 10.20.0.12
  channels: 16
  username_env: HQ_NVR_USER
  password_env: HQ_NVR_PASS
```

## H.265 (HEVC) cameras and browsers

Browsers decode H.264 over WebRTC; most cannot decode H.265. When the console's WebRTC offer is rejected by the
relay with *codecs not supported by client*, the tile switches itself to the relay's on-demand H.264 transcode
(`<camera>/<profile>-h264`, state text *H.264 transcode (HEVC source)*), remembers it for that camera, and plays.
Recording, ANPR and analytics keep the original H.265 stream (no quality loss, no extra CPU). Cost: ~1 CPU core per
1080p stream *being viewed* (libx264 veryfast, 2500 kbit/s; edit the `-h264` path in `config/mediamtx.yml` to change it — MediaMTX runs the command without a shell, so no `${VAR}` expansion there). Survey the codecs of a
source with `docker compose run --rm -e CHECK_CODECS=1 api python scripts/check_source.py <source>`. If many
cameras are HEVC and many operators watch at once, ask the vendor for an H.264 (or H.264 sub-stream) profile, or run
the relay on a GPU host with an NVENC ffmpeg build.

## Credentials rejected (401) — automatic back-off

If a direct-RTSP source (adapter `rtsp` / `rtsp_template`) has pulls that should be running (recording, or a viewer
waiting) and none is ready, the adapter probes one stream. On *401 Unauthorized* it removes that source's relay paths
for `AUTH_BACKOFF_S` (default 600 s), marks the source *credentials rejected … pulls paused* in the Sources card and
logs an error, instead of retrying every camera every few seconds until the vendor locks the account (which is what
30 cameras retrying for an hour did to the Corp8 gateway during the pilot). Fix the username / access password in
`.env`, then `docker compose restart adapters`; the paths are re-registered on the next sync after the pause.

## Video wall black while the camera dot is green

The relay pulls the camera (workers read plates) but the browser shows nothing: the media leg browser ↔ relay is
blocked. WebRTC signalling goes over TCP 8889; the media itself over **UDP 8189**, or **TCP 8189** when UDP is
blocked (both are served since 1.0.2, so a cloud security list that only allows TCP still plays). Checklist:

1. `Test-NetConnection <host> -Port 8889` and `-Port 8189` from the operator PC: both must be `True`.
2. `.env`: `RELAY_PUBLIC_HOSTS=relay=<public ip or dns>` and `MTX_WEBRTCADDITIONALHOSTS=<same>`; after changing:
   `docker compose up -d --force-recreate relay api`.
3. `docker compose logs --since 2m relay`: *codecs not supported by client* = HEVC camera → the tile switches to the
   H.264 transcode by itself (see above); *ICE failed* / session closed after ~15 s = media port blocked.
4. On the host while a tile is open: `sudo tcpdump -ni any port 8189 -c 5` — no packets from the operator's IP
   means the packets are dropped before the host (cloud security list / NSG).

## Single-stream sources (Corp8): one gateway session per camera

Corp8's gateway hands out one RTSP URL per camera and limits concurrent sessions per account. Before 1.3.2 the
relay opened that URL twice per camera (`main` for the wall/recording, `sub` for ANPR/analytics/faces) — 60
sessions for 30 cameras, which the gateway answered with **401 after about a minute** as the on-demand `sub`
pulls ramped up, and the adapters then backed off for 10 minutes.

Now, when a camera's `sub` URL is identical to its `main`, the adapters register `sub` as a **loopback of the
relay's own `main` path** (`rtsp://<internal>@127.0.0.1:8554/<cam>/main`), so the gateway sees exactly one
session per camera. Cameras that really have two streams (Hikvision/Dahua NVRs with `sub:` templates) are
unchanged. `docker compose logs adapters | grep "path .*sub"` shows the loopback URLs after `docker compose
restart adapters`.

If 401s continue with the correct password, the account's session cap is below the camera count: lower the
number of cameras pulled at once with `max_concurrent_pulls` in `config/sources.yaml`, or ask the provider for
the per-account limit.

### Steady sessions instead of login churn (`persistent_pull`)

A relay path that is not recorded is *on demand*: the relay logs in to the gateway when a viewer or worker
starts reading and hangs up ~10 s after the last one leaves. On a gateway that counts logins per account this
churn (tiles opening and closing, workers reconnecting) eventually trips its limit — Corp8 answered 401 after
~20 minutes of otherwise healthy pulls. With `persistent_pull` the relay opens one session per camera at
start-up (0.5 s apart, `RELAY_ADD_STAGGER_S`) and simply keeps it; nothing logs in again unless the stream
drops. It is the default for single-stream `rtsp_template` sources whose camera count fits
`max_concurrent_pulls`; set it explicitly per source when in doubt:

```yaml
  - id: corp8
    adapter: rtsp_template
    max_concurrent_pulls: 30
    persistent_pull: true          # one steady gateway session per camera, no login churn
```

`docker compose logs adapters | grep persistent=True` confirms it; the relay's own log then shows each
`[path camNN/main] … is ready` once and stays quiet.

## Connecting a device from the console (Sources → Connect a device)

No yaml editing: choose the device type, fill in host / port / channels and a **read-only** account, *Test
connection* (ffprobe opens the first stream and reports the codec, 401, 404 or timeout), *Save & connect*. The
device is stored in the `sources` table (`managed=true`) with its credentials encrypted under `TOKEN_SECRET`;
the adapters merge console devices with `config/sources.yaml` and re-sync within seconds of any change, so its
cameras appear on the wall, in the registry and on the map (once they have coordinates) without a restart.

| type | what to fill in | adapter |
|---|---|---|
| Single IP camera (RTSP) | main (and optional sub) RTSP URL **without** user:pass, optional lat/lon | `rtsp` |
| NVR / DVR by vendor | vendor (Hikvision, Dahua / CP Plus, Uniview, Axis, Honeywell, Bosch…), host, RTSP port, channel count | `rtsp_template` (or `onvif` for ONVIF-only vendors) |
| Custom RTSP template | host, port, `rtsp://{host}:{rtsp_port}/…{channel}…` templates — how Corp8 is connected | `rtsp_template` (single-stream templates get `persistent_pull`) |
| ONVIF Profile S device | host, ONVIF port | `onvif` |

Options: ANPR on the cameras, record mode (ANPR cameras / all / none), max streams pulled at once. *Edit* keeps
the stored password when the field is left blank; *Disconnect* removes the relay paths and the cameras.
`device_connect` / `device_update` / `device_disconnect` are audited. API: `GET/POST /api/devices`,
`POST /api/devices/test`, `PATCH/DELETE /api/devices/{id}`, `GET /api/devices/types` (admin to change).

Coordinates typed into the Registry for a source-fed camera are kept across syncs (the source's own geo data,
when it has any, still wins), so Corp8 cameras can be placed on the map from Registry → Edit.

## "Cannot reach the server" toasts and tiles going black every few minutes

The console shows this toast when a request gets **no answer at all** (browser error *Failed to fetch*). Two very
different causes look identical from the browser:

1. **The API container restarted** — `docker compose ps` shows a short *Up* time for `api` and
   `docker inspect unified-cctv-api-1 --format '{{.RestartCount}} {{.State.ExitCode}} {{.State.OOMKilled}}'`
   shows a non-zero restart count. `docker compose logs api --tail 80` then has the reason just before
   `Application startup complete` (a Python traceback, `Killed` = out of memory, exit 139 = a native crash).
2. **The operator's own network dropped** for a moment (mobile / hotspot / Wi-Fi) — `api` has been *Up* for
   hours with `RestartCount 0`, and the relay log shows the WebRTC / HLS sessions closing from the client side.
   Nothing on the VM to fix; a wired connection or a stable ISP link to the command centre is the cure.

Since 1.4.5 the console recovers by itself in both cases: it polls `/api/version` every 3 s while the server is
unreachable, then reconnects the WebSocket, reloads the camera list and restarts every tile
("Server reachable again after N s — reconnecting streams"). An HLS tile that shows no picture within 12 s
now restarts too instead of sitting black under a "HLS fallback" label.

## Only some cameras play; counts stop; "offline, retrying" on most tiles

`docker compose exec api python scripts/relay_status.py` shows, per path, whether the **relay** has the stream.
When a few gateway pulls are READY and most are DOWN while the adapters still say `source ok`, the gateway is
limiting how many streams one account may pull at the same time — below the camera count. The 401 back-off does
not fire (some pulls work), the refused paths keep re-trying every few seconds, and the analytics / ANPR
workers get frames from the few that play.

Measure the limit once (frees the account's sessions first):

```bash
docker compose stop adapters relay
docker compose run --rm api python scripts/probe_cap.py corp8       # ~2 minutes, prints the cap
docker compose start relay adapters
```

then set it in `config/sources.yaml` (`max_concurrent_pulls: <cap>`). Since 1.4.6 the adapters keep exactly that
many cameras on steady sessions (recorded cameras first, then ANPR cameras, then by id) and open the others only
while an operator watches them, so the gateway never sees more sessions than it allows. Counting, ANPR and face
matching run on whatever is being pulled. Ask the provider to raise the account limit if every camera must be
analysed continuously.

### The adapters learn the cap by themselves (1.4.9)

If `max_concurrent_pulls` is set higher than the gateway really allows, the refused steady pulls would be
retried by the relay every few seconds for ever — a login storm that ends with the account locked and **every**
camera offline. Since 1.4.9 the adapters watch the steady pulls: when some are ready and others have not come
up within 90 s, the refused ones are demoted to on demand, the number that worked becomes the source's
effective cap, and the Sources page says so:
*"gateway accepted 10 steady sessions, refused 20: … Set max_concurrent_pulls: 10 in config/sources.yaml"*.
Put that number in `sources.yaml` to make it permanent (the learned value is forgotten when the adapters
restart). If **all** pulls are down, that is the 401 back-off (credentials rejected or a lockout): wait the
10 minutes it announces, then `docker compose restart adapters`.
