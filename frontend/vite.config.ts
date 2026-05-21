import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

const backendProxyTarget = process.env.VITE_BACKEND_PROXY_TARGET || "http://127.0.0.1:8000";

/**
 * Serve /assets/ requests from the repo-root assets/ directory.
 * This lets the frontend load VRMA files at /assets/animations/library/shared/idle.default.vrma
 */
function serveRepoAssets() {
  const assetsRoot = path.resolve(__dirname, "../assets");
  return {
    name: "serve-repo-assets",
    configureServer(server: { middlewares: { use: (fn: Function) => void } }) {
      server.middlewares.use((req: { url?: string }, res: { setHeader: (k: string, v: string) => void } & NodeJS.WritableStream, next: () => void) => {
        if (req.url && req.url.startsWith("/assets/")) {
          const requestPath = req.url.split("?")[0];
          const decodedAssetPath = decodeURIComponent(requestPath.slice("/assets/".length));
          const filePath = path.join(assetsRoot, decodedAssetPath);
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
              ".vrma": "model/gltf-binary",
              ".glb": "model/gltf-binary",
              ".json": "application/json",
              ".vrm": "model/gltf-binary",
            };
            res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), serveRepoAssets()],
  assetsInclude: ["**/*.vrm", "**/*.vrma", "**/*.glb"],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        control: fileURLToPath(new URL("./control/index.html", import.meta.url)),
        display: fileURLToPath(new URL("./display/index.html", import.meta.url))
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: {
      allow: [".."]
    },
    proxy: {
      "/api": {
        target: backendProxyTarget,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api/, "")
      }
    }
  }
});