import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The API runs on 3000 by default; override with API_PROXY_TARGET when it doesn't.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
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
