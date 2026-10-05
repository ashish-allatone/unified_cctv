# Product: install, update, licence, languages, accuracy programme

## Install and update

- Linux: `bash scripts/install.sh [--with-sim] [--with-monitoring] [--with-tls cctv.example.gov.in]` — checks
  Docker, writes `.env` with generated secrets, builds, starts, waits for `/api/version`.
- Windows: `powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-WithSim] [-WithMonitoring]`.
- Update: `bash scripts/update.sh <release.zip>` (or `--git`): runs `scripts/backup.sh` first, copies the release
  over the code while keeping `.env`, `config/*.yaml`, `config/license.json` and `data/`, reports config files that
  changed upstream so they can be merged deliberately, rebuilds, restarts; schema migrations run at service start.
- Backup: `scripts/backup.sh` → `backups/<timestamp>.tar.gz` with the database dump, config, `.env`, signing
  key and licence. The video archive lives in object storage (bucket versioning / replication).
- `VERSION` is shown at `/api/version` and in Admin.

## Licensing

`config/license.json` is issued by the vendor with `scripts/issue_license.py` (Ed25519, vendor private key
kept out of customer deployments; the public key ships in `deploy/licensing/vendor_public.pem`). It fixes the
customer, tenant, **camera limit**, **ANPR channels**, **analytics channels**, feature list and expiry.

- Enforcement: the adapter service registers cameras up to the limit (deterministic by id) and marks the rest
  `unlicensed` (visible in the registry, never pulled); the ANPR worker runs up to the licensed channel count;
  the analytics worker likewise. A banner shows over-limit or expiring states; Admin shows usage vs limits.
- No / invalid licence → **evaluation mode** (8 cameras, 2 ANPR, 2 analytics, all features) so a pilot never
  stops. Expiry → 14-day grace with a banner, then evaluation limits.
- Usage reporting: `POST /api/license/report` or daily from the archiver to `LICENSE_REPORT_URL`, signed with
  the platform key (customer, mode, usage, limits, version).

## Languages and accessibility

- Console and field app strings in `platform/web/i18n/en.json` and `hi.json`; the header button switches
  English ↔ हिंदी (remembered per browser; `DEFAULT_LANGUAGE`). Add a language by adding a JSON file and a
  toggle entry; add strings with `data-i18n="key"` / `t("key")`.
- Accessibility: skip-to-content link, ARIA landmarks and labels on icon buttons, live region for toasts,
  visible focus rings, reduced-motion support, keyboard shortcuts **Alt+1…9** for the tabs, dark
  control-room theme with ≥ 4.5:1 text contrast.

## ANPR accuracy programme

- **Review queue** (Violations tab, feature `plate_search`): hard reads (low confidence, invalid format,
  non-standard, night) plus a random sample of ordinary reads, so the accuracy estimate is not biased.
  Operators **confirm**, **correct** (with a reason: two_line, night, dirty, decorative_font, occluded, angle,
  motion_blur) or mark **unreadable**; `Fix plate` is also on every search row.
- A correction rewrites the record (plate, validity, tag `corrected`), fixes alerts and challan drafts that
  reference it, and cancels a non-standard-plate challan drafted on a misread.
- **Weekly report** (`/api/reports/anpr`, Violations tab, JSON file every Monday, e-mailed via the `report`
  route): per camera reads, reviewed, accuracy on reviewed reads, mean confidence, low-confidence / invalid /
  night shares, top correction reasons; history of past weeks.
- **Retraining set**: `/api/reports/anpr/training-set.zip` — crops with `labels.csv` (read, truth, verdict,
  reason) for fine-tuning the OCR (fast-plate-ocr / PaddleOCR rec) per site.

## Console (v1.2): layout and themes

`platform/web/index.html`, `styles.css`, `app.js` — plain HTML/CSS/JS, no build step; served by the API at `/`.

* **Shell**: left sidebar (Operations / Investigate / System groups, collapsible to an icon rail, becomes a bottom
  bar on phones), top bar (page title, live-channel dot, user chip, Break glass, 2FA, language, theme, Sign out).
* **Overview**: KPIs (cameras online, reads, unique plates, open alerts, watchlist, ANPR cameras), reads-per-minute
  chart, latest reads, cameras by department, sources, licence & health. Opens by default; the last view is
  remembered per browser.
* **Themes**: `data-theme="dark"` (command centre, default) and `"light"` (portal / reports) on `<html>`. Every
  colour is a token in `styles.css`; the toggle (sun/moon) is on the login page and the top bar; the choice is saved
  in `localStorage` (`uvp-theme`) and applied before first paint. The video wall stays black in both.
* **Ids and classes are unchanged** from 1.1 (every view keeps its `#view-*`, tables, forms, `#tabs button[data-view]`),
  so the e2e tests and any bookmarks/automation keep working.

## Languages: English, Hindi, Gujarati

The header language button cycles English → हिंदी → ગુજરાતી (`platform/web/i18n/en|hi|gu.json`, same keys; the
choice is remembered per browser and the browser's own language picks the default). Add a language by copying
`en.json` and adding its code to `LANGS` in `app.js`.

## Spoken alerts (text-to-speech)

The 🔊 header button turns spoken alerts on for that operator's browser: every watchlist hit, violation, person
of interest sighting and crowd alert is read aloud in the console's current language — plate numbers are
spelled out letter by letter ("G J 0 1 A B 1 2 3 4") so they are unambiguous in any language. It uses the
browser's built-in speech engine (Web Speech API): no audio leaves the machine and nothing is sent to a cloud
service. Hindi and Gujarati voices come from the operating system — on Windows add them under *Settings → Time
& language → Speech → Add voices* (Hindi is included; Gujarati is available on Windows 11), on Android/Chrome
they are present by default; when the voice is missing the console says so and falls back to English.

Note: *Whisper* is a speech-**to**-text model (it transcribes audio). It is the right tool for the opposite
direction — e.g. an operator dictating a case note or a plate number by voice — and can be added as an
offline service later; reading alerts aloud is text-to-speech, which is what the console does here. For a
server-side offline voice (control-room speakers rather than each browser), Piper TTS supports Hindi and
Gujarati models and can be added behind `/api/tts`.
