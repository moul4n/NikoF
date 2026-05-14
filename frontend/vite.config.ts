import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendProxyTarget = process.env.VITE_BACKEND_PROXY_TARGET || "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  assetsInclude: ["**/*.vrm"],
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