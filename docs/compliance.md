# Security and compliance controls

How the platform meets the controls a state IT / police procurement usually asks for. Every item
names the file that implements it so an auditor can check rather than trust.

## Identity and access

| Control | Implementation |
| --- | --- |
| Directory sign-in (Active Directory / LDAP) | `config/auth.yaml` → `providers.ldap`; bind as the user, read `memberOf`, map groups to role + departments (`platform/uvp/auth.py::_ldap`) |
| Single sign-on (SAML / OIDC) | `providers.oidc`: authorization-code flow, ID token verified against the IdP JWKS, groups/app-roles mapped. SAML-only IdPs are fronted by Keycloak or ADFS in OIDC mode |
| Multi-factor | TOTP (RFC 6238) with 8 one-time backup codes; `mfa.required_roles` enforces enrolment; IdP MFA accepted via `amr` |
| Brute-force protection | `LOGIN_MAX_FAILURES` / `LOGIN_LOCKOUT_S`, per account, admin unlock |
| Least privilege | Feature-level permissions (`platform/uvp/rbac.py`), department scope, per-camera grants |
| Time-bound access | `access_grants` with `expires_at`; UI: Admin → Grant access |
| Break-glass | Supervisor/admin may self-elevate for `break_glass.ttl_minutes` with a justification ≥10 chars; admins are notified live; banner on every screen; audited as `break_glass` |
| Session | Signed JWT (HS256, `TOKEN_SECRET` ≥32 chars), TTL `session.ttl_hours`; grants re-evaluated at `/api/auth/refresh` |

## Audit and evidence integrity

| Control | Implementation |
| --- | --- |
| Tamper-evident audit log | Each row hashes its content + previous row's hash (`db.py::audit`); `/api/audit/verify` walks the chain; UI: Audit → Verify chain |
| What is logged | login/failed/locked, MFA events, plate searches, vehicle traces, live views, clip/recording playback, exports, grants, holds, DPDP actions, break-glass, retention trims, with user, IP and time |
| Audit retention | ≥180 days enforced (`retention_policy` floor), default 365 |
| Signed exports | Every CSV and evidence bundle carries `manifest.json` (SHA-256 per file) + `manifest.sig` (Ed25519) + `public_key.pem`; verify offline or via `/api/verify` |
| Watermarking | Exported frames and clips are burned with `UVP export · <user> · <UTC time> · <plate>` (`platform/uvp/pii.py`) |
| Signing key | `SIGNING_KEY_FILE` (generated once; back it up; publish the public key to recipients) |

## Data protection (DPDP Act 2023) and PII

| Control | Implementation |
| --- | --- |
| Purpose limitation | Plate reads are used for traffic enforcement / public safety only; no face recognition module is enabled |
| Data minimisation | Only metadata, plate crops, an annotated frame and a short clip are kept; departmental recordings stay in their VMS |
| Retention and purge | `config/rules.yaml → retention` per department: recordings, clips, crops, events, audit; applied hourly by the archiver |
| Legal hold | `legal_holds` by plate / camera(+window) / event / case: excluded from purge and erasure |
| Right to information (s.11) | `/api/dpdp/subject-access?plate=` |
| Right to erasure (s.12) | `/api/dpdp/erase?plate=` (refused under legal hold or watchlist); erases DB rows, index entries and archive objects |
| Masking | Users without `plate_search` see `MP04****93`; faces in evidence frames are blurred at capture (`PII_BLUR_FACES`) |
| Breach notification | Audit and compliance status give the evidence base; CERT-In requires reporting within 6 hours of noticing an incident |

## Encryption and secrets

| Control | Implementation |
| --- | --- |
| In transit | `docker compose --profile tls`: Caddy terminates HTTPS for console, API, WebSocket, WHEP and HLS (`deploy/tls/Caddyfile`); WebRTC media is DTLS-SRTP by design; RTSP from departmental NVRs stays on the closed VMS LAN |
| At rest | Object storage server-side encryption (`S3_SSE=AES256` / `aws:kms`); PostgreSQL on encrypted volumes (host disk encryption, or Oracle/AWS managed DB encryption); TOTP secrets encrypted in the database |
| Secrets | `.env` for the pilot; `NAME_FILE` (Docker/Kubernetes secrets) or HashiCorp Vault KV (`VAULT_ADDR`, `VAULT_TOKEN_FILE`, `VAULT_KV_PATH`) for production, loaded before settings |

## CERT-In directions (April 2022)

- Logs of all ICT systems kept for 180 days within India: audit retention floor + archive in an Indian region (Oracle Mumbai/Hyderabad).
- Time synchronisation: run `chrony`/`ntpd` against NIC/NPL NTP on every host (deployment checklist).
- Incident reporting within 6 hours: `/api/compliance/status` and the audit log are the evidence base.

## Not included, deliberately

- Face search / recognition: not built; would need state-level legal clearance and a separate DPIA.
- Vahan / NCRB / e-challan live integrations: connectors with documented contracts only (phase 4); credentials and API access must come from the respective authority.

## Console accounts and two-factor sign-in — one table: `users`

Every console account is ONE row in `users`: identity (`username`, `provider`, `password_hash`, `role`,
`departments`, `cameras`, `is_super`, `is_active`, `tenant`, `created_by`), two-factor state
(`totp_secret_enc` — encrypted with `TOKEN_SECRET`; `""` off, `pending:` QR shown, else active — `mfa_enrolled_at`,
`backup_codes` hashed, `grace_logins_used`) and lockout / activity (`failed_logins`, `locked_until`, `last_login`).
`provider = db` rows are password accounts; `users.yaml` / `ldap` / `oidc` rows are created on a directory or demo
user's first login so that 2FA and lockout work for them too (they have no password here). Databases from releases
before 1.1 had a separate `user_security` table: it is folded into `users` and dropped on first start.

**First run.** With no account in the `users` table the login page shows *Create the administrator account*
(`POST /api/auth/signup`). That account is the **super admin**. Sign-up then closes permanently (409), and the
demo accounts in `users.yaml` stop working (re-enable with `providers.local.keep_yaml_users: true` in `auth.yaml`
if you really want them).

**Accounts** (Admin tab, or the API):

| Action | Who | Endpoint |
|---|---|---|
| list password accounts with 2FA / lockout state (`?all=1` adds directory / demo rows) | admin | `GET /api/users` |
| create (username, password, role, departments, super) | super admin | `POST /api/users` |
| deactivate / reactivate, change role or departments, set password, grant/remove super | super admin | `PATCH /api/users/{username}` |
| remove — the row is the account, its 2FA secret and backup codes; grants are deleted too | super admin | `DELETE /api/users/{username}` |

Guards: a super admin cannot delete or deactivate itself, the last super admin cannot be removed or demoted,
usernames are lowercase (`a-z 0-9 . _ @ -`), passwords need 10+ characters with an uppercase letter and a digit.
Everything is written to `audit_log` (`signup_super_admin`, `user_create`, `user_update`, `user_delete`).

**Two-factor sign-in (TOTP, RFC 6238).** Per account, one flow for every provider:

1. *Set up*: header button **2FA** → `POST /api/auth/mfa/enrol` returns a QR / secret (stored `pending:`,
   encrypted with `TOKEN_SECRET`) → scan in Google/Microsoft Authenticator → `POST /api/auth/mfa/confirm` with the
   first code → enrolment active, 8 one-time backup codes shown once.
2. *Login*: `POST /api/auth/login` → password checked → **if the account has a confirmed enrolment (or its role is
   in `mfa.required_roles`)** the reply is `{mfa_required, mfa_token}` — a 5-minute *challenge token* with
   purpose `mfa` that no other endpoint accepts as a session → `POST /api/auth/mfa/verify` with the code (or a
   backup code) → session JWT. **Otherwise** the session JWT is returned directly. A `pending:` (unfinished)
   enrolment never triggers the challenge.
3. *Turn off*: header button **2FA on** → `POST /api/auth/mfa/disable` with a current code (refused for roles in
   `mfa.required_roles`). Lost device: an admin uses **Reset 2FA** (`POST /api/auth/mfa/reset/{username}`).
4. `GET /api/auth/mfa/status` → `off | pending | enrolled`, whether the role requires it, backup codes left.

Wrong codes count toward the login lockout; all steps are audited (`login_mfa_pending`, `mfa_enrolled`,
`mfa_failed`, `mfa_disabled`, `mfa_reset`).
