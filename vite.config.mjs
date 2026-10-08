import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "frontend",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { port: 5198, proxy: { "/api": "http://localhost:8098" } },
});
