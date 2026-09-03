import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  base: "./",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __TOKENPATH_DEBUG_CASES_ENABLED__: JSON.stringify(mode === "debug"),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(extensionRoot, "src/sidepanel"),
    },
  },
  build: {
    cssCodeSplit: false,
    emptyOutDir: false,
    minify: "oxc",
    outDir: path.resolve(extensionRoot, "sidepanel"),
    sourcemap: false,
    lib: {
      entry: path.resolve(extensionRoot, "src/sidepanel/main.tsx"),
      fileName: () => "panel.js",
      formats: ["iife"],
      name: "TokenPathSidepanel",
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith(".css"))
            ? "panel.css"
            : "assets/[name]-[hash][extname]",
        entryFileNames: "panel.js",
      },
    },
  },
}));
