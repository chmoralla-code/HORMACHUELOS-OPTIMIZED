import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  base: "./",
  publicDir: "../public",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: "src/index.html",
      },
    },
  },
});
