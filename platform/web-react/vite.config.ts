import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

function serveLegacy(): Plugin {
  const webDir = path.resolve(process.cwd(), "../web");
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
  };

  return {
    name: "serve-legacy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/legacy")) return next();
        const rawPath = req.url.slice("/legacy".length).split("?")[0];
        const subPath = rawPath === "" || rawPath === "/" ? "/index.html" : rawPath;
        const filePath = path.join(webDir, subPath);

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
          fs.createReadStream(filePath).pipe(res);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // The API (uvicorn) runs on :8000 in Docker, :8765 in the dev sandbox; `npm run dev` proxies everything but the SPA to it.
  const API = env.UVP_API || process.env.UVP_API || "http://144.24.110.230:8000";

  return {
    plugins: [react(), serveLegacy()],
    server: {
      port: 5173,
      fs: { allow: [".."] },                         // ../web/styles.css and brand assets are imported from the legacy console
      proxy: {
        "/api": API, "/healthz": API, "/readyz": API, "/media": API, "/archive": API, "/legacy": API,
        "/ws": { target: API.replace("http", "ws"), ws: true },
      },
    },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  };
});
