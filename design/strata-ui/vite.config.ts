import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

// One IIFE (strata-ui.js) and one stylesheet (strata-ui.css). React and ReactDOM are not bundled:
// the canvas page provides React 18 as window.React and window.ReactDOM.
const shim = path.resolve(__dirname, "src/jsx-runtime-shim.ts")

export default defineConfig({
  plugins: [react({ jsxRuntime: "classic" }), tailwindcss()],
  resolve: {
    alias: [
      { find: /^react\/jsx-(dev-)?runtime$/, replacement: shim },
      { find: /^@\//, replacement: path.resolve(__dirname, "src") + "/" },
    ],
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    cssCodeSplit: false,
    lib: {
      entry: "src/index.tsx",
      name: "StrataUI",
      formats: ["iife"],
      fileName: () => "strata-ui.js",
      cssFileName: "strata-ui",
    },
    rollupOptions: {
      external: ["react", "react-dom"],
      output: { globals: { react: "React", "react-dom": "ReactDOM" } },
    },
  },
})
