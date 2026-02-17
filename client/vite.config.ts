import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  server: {
    host: true,
  },
  preview: {
    host: true,
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
