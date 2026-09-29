import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mockApi } from "./mock/mockApi.js";

// The API (FastAPI) serves platform/web at "/"; the build lands there.
// `npm run dev` proxies the API + alert websocket to a running backend (UVP_API, default http://localhost:8000).
// No backend answering at startup -> demo mode: the dev server answers /api with sample data (sign in admin / admin123).
// Force a mode with UVP_MOCK=1 (demo) or UVP_MOCK=0 (always proxy).
const API = process.env.UVP_API || "http://localhost:8000";

async function backendUp() {
  try { return (await fetch(`${API}/api/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

export default defineConfig(async ({ command }) => {
  const demo = command === "serve" && (process.env.UVP_MOCK === "1" || (process.env.UVP_MOCK !== "0" && !(await backendUp())));
  if (demo) console.log(`\n  Demo mode: no backend at ${API}, serving sample data. Sign in with any username / password.\n  Start the backend and restart \`npm run dev\` to use real data.\n`);
  return {
    plugins: [react(), demo && { name: "uvp-demo-api", configureServer: (server) => {
      server.middlewares.use(mockApi());
      // no live alert channel in demo mode: refuse /ws upgrades cleanly (a dangling socket reset would crash the dev server)
      server.httpServer?.on("upgrade", (req, socket) => {
        if (!req.url.startsWith("/ws/")) return;
        socket.on("error", () => {});
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      });
    } }].filter(Boolean),
    build: { outDir: "../web", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
    server: {
      port: 5173,
      proxy: demo ? {} : {
        "/api": API,
        "/docs": API,
        "/openapi.json": API,
        "/ws": { target: API.replace(/^http/, "ws"), ws: true },
      },
    },
  };
});
