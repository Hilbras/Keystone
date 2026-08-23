import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/setup": {
        target: process.env.KEYSTONE_API_URL || "http://localhost:4001",
        changeOrigin: true,
      },
      "/health": {
        target: process.env.KEYSTONE_API_URL || "http://localhost:4001",
        changeOrigin: true,
      },
      "/.well-known": {
        target: process.env.KEYSTONE_API_URL || "http://localhost:4001",
        changeOrigin: true,
      },
      "/documentation": {
        target: process.env.KEYSTONE_API_URL || "http://localhost:4001",
        changeOrigin: true,
      },
      "/auth": {
        target: process.env.KEYSTONE_API_URL || "http://localhost:4001",
        changeOrigin: true,
      },
      "/v1": {
        target: process.env.KEYSTONE_API_URL || "http://localhost:4001",
        changeOrigin: true,
      },
    },
  },

});
