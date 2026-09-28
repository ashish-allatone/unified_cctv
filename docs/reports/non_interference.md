# Non-interference test report

Run: 2026-09-22 14:29 IST against the simulated Police NVR (ONVIF) and Municipal VMS (vendor REST API).

Result: **7 of 7 checks passed.**

| Check | Result | Evidence |
| --- | --- | --- |
| Police: no write calls | PASS | 169 requests received, 0 writes; operations seen: GetCapabilities, GetDeviceInformation, GetProfiles, GetStreamUri |
| Municipal: no write calls | PASS | 53 requests received, 0 writes; operations seen: GET /api/v1/auth/login, GET /api/v1/cameras, GET /api/v1/cameras/muni-cam1/live, GET /api/v1/cameras/muni-cam2/live, GET /api/v1/cameras/muni-cam3/live, GET /api/v1/cameras/muni-cam4/live, POST /api/v1/auth/login |
| One departmental session per stream regardless of viewers | PASS | 1 viewers -> 1 session(s) on the Police NVR; 5 viewers -> 1 session(s) on the Police NVR; 20 viewers -> 1 session(s) on the Police NVR |
| Idle streams are released | PASS | police-cam3/sub: 0 session(s) 20 s after the last viewer left |
| Per-source stream cap enforced | PASS | cap 3 with 2 ANPR pulls active: allowed ['muni-cam2'], refused ['muni-cam3', 'muni-cam4', 'muni-cam1'] |
| Municipal outage is isolated | PASS | municipal source=error, municipal cameras offline=True, police cameras online=True, police stream still plays=True |
| Departmental systems keep working with the platform stopped | PASS | Police NVR stream codec=h264; Municipal VMS API HTTP 405 |
