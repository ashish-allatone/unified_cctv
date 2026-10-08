# Unified CCTV console — React (Vite + React 18 + TypeScript)

The console is being moved from the vanilla-JS app in `platform/web` to React, page by page.
This app is the **shell**: login (password / 2FA / first-run), sidebar + topbar, bell, WebSocket, i18n, theme,
and the pages already rebuilt. Pages not yet rebuilt open the legacy console (`/legacy/`) inside an iframe —
same origin, same session (`sessionStorage["uvp"]`), so the user never notices the seam.

| Status | Pages |
|---|---|
| React | Login, layout/sidebar/topbar/bell, **Notifications** (+ preferences), **Admin → Permissions, Users, Roles** |
| Legacy in iframe | Overview, Video wall, Map, Registry, Alerts, Counts, Reports, Search, Vehicle movement, Multi-camera, Playback, Cases, Violations, Watchlist, Upload, Sources, Audit, Admin → Compliance / Access grants / Legal holds / Archival / DPDP / External APIs / Notifications / API keys / Webhooks / Tenants |

Styling: `../web/styles.css` is imported as-is (same look); React-only additions live in `src/react.css`.

## Develop
```bash
cd platform/web-react
npm install
UVP_API=http://localhost:8000 npm run dev      # http://localhost:5173 ; /api, /ws, /legacy proxied to the API
```

## Build / deploy
`npm run build` writes `dist/`. The platform and api Dockerfiles have a Node stage that builds it, so
`docker compose build api && docker compose up -d api` is enough. When `dist/index.html` exists the API serves
React at `/` and the legacy console at `/legacy/`; without it the legacy console stays at `/` (`WEB_REACT_DIR`).

## Migrating a page
1. Add `src/pages/<Page>.tsx` (use `api()`, `useAuth()`, `useWsMessage()`, `Modal`, `Pager`).
2. Route it in `src/App.tsx` before the `:view` catch-all; set `react: true` on its entry in `src/nav.tsx`.
3. Delete nothing from `platform/web` until every page is migrated — the iframe still needs it.
