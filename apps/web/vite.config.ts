import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The API runs on 3000 by default; override with API_PROXY_TARGET when it doesn't.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // '@/' is src/, the alias shadcn components use (components.json).
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // STRATA-132: pages are split by area (React.lazy in src/routes.tsx). The libraries every page
  // needs go in long-lived chunks of their own, so an update to the app doesn't re-download them
  // and no chunk passes ~600 kB.
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/,
            },
            // One icon chunk instead of a tiny chunk per icon shared between pages.
            { name: 'vendor-icons', test: /[\\/]node_modules[\\/]lucide-react[\\/]/ },
            {
              name: 'vendor-shared',
              test: /[\\/](node_modules[\\/]zod|packages[\\/]shared[\\/]dist)[\\/]/,
            },
          ],
        },
      },
    },
  },
  // Only VITE_-prefixed variables can reach the browser bundle; never put secrets in them.
  envPrefix: 'VITE_',
  // Bind IPv4 explicitly: on Windows "localhost" can resolve to ::1 only, and the API,
  // Playwright and the README all use 127.0.0.1.
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
