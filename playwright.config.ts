import { defineConfig, devices } from '@playwright/test';

// E2E runs production-shaped: the built API serves the built web app from one origin (as on the
// Windows host, TRP-T20), so no dev proxy sits between the browser and the API. The API reads
// apps/api/.env.test (copy from .env.example); CI writes one before running.
const PORT = 3100;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  // Locally, more than two parallel browsers made the API freeze for 5–20 s at a time on the dev
  // PC (zero CPU, socket calls blocked; AVG Web Shield inspects browser traffic). Two workers were
  // reliable in repeated runs. CI has no such filter and uses Playwright's default.
  workers: isCI ? undefined : 2,
  forbidOnly: isCI,
  retries: 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    name: 'app',
    // Fresh test database with fictional fixtures, both builds, then the API with test sign-in on.
    command:
      'npm run db:reset:test -w @trapezoid/api && npm run db:seed:dev -w @trapezoid/api' +
      ' && npm run build -w @trapezoid/web && npm run build -w @trapezoid/api' +
      ' && npm run start -w @trapezoid/api',
    // Wait on the port, not /api/health: a 503 (database down) would never count as ready,
    // and the smoke test reports the database state more clearly than a startup timeout.
    port: PORT,
    reuseExistingServer: !isCI,
    timeout: 180_000,
    // Drain the server's output so a full pipe can never block the API's synchronous log writes.
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ENV_FILE: '.env.test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ENABLE_TEST_AUTH: 'true',
      WEB_DIST_DIR: '../web/dist',
      // 4xx responses log at warn; keep E2E output to real errors.
      LOG_LEVEL: 'error',
    },
  },
});
