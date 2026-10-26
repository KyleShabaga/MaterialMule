import { defineConfig, devices } from '@playwright/test';

// E2E runs the built API and a production web build behind `vite preview`.
// The API reads apps/api/.env.test (copy from .env.example); CI writes one before running.
const API_PORT = 3100;
const WEB_PORT = 4173;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      name: 'api',
      command: 'npm run build -w @trapezoid/api && npm run start -w @trapezoid/api',
      // Wait on the port, not /api/health: a 503 (database down) would never count as ready,
      // and the smoke test reports the database state more clearly than a startup timeout.
      port: API_PORT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: { ENV_FILE: '.env.test', PORT: String(API_PORT), HOST: '127.0.0.1' },
    },
    {
      name: 'web',
      command: 'npm run build -w @trapezoid/web && npm run preview -w @trapezoid/web',
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: { API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
