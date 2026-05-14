import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendProxyTarget = env.VITE_BACKEND_PROXY_TARGET || "http://127.0.0.1:8000";

  return {
    plugins: [react()],
    assetsInclude: ["**/*.vrm"],
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
          rewrite: (path) => path.replace(/^\/api/, "")
        }
      }
    }
  };
});