import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API (uvicorn) runs on :8000 in Docker, :8765 in the dev sandbox; `npm run dev` proxies everything but the SPA to it.
const API = process.env.UVP_API || "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [".."] },                         // ../web/styles.css and brand assets are imported from the legacy console
    proxy: {
      "/api": API, "/healthz": API, "/readyz": API, "/media": API, "/archive": API, "/legacy": API,
      "/ws": { target: API.replace("http", "ws"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
