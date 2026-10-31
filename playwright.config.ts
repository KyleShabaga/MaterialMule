import { defineConfig, devices } from '@playwright/test';
import { assertPrebuilt } from './e2e/support/prebuilt';

// E2E runs production-shaped: the built API serves the built web app from one origin (as on the
// Windows host, MM-T20), so no dev proxy sits between the browser and the API. The API reads
// apps/api/.env.test (copy from .env.example); CI writes one before running.
// E2E_PORT lets several worktrees run E2E side by side (each with its own .env.test database).
const PORT = Number(process.env.E2E_PORT ?? 3100);
const isCI = Boolean(process.env.CI);
// Never silently reuse a server already on the port: it could be another worktree's build.
// Set E2E_REUSE_SERVER=1 only when you started this checkout's server yourself.
const reuseServer = !isCI && process.env.E2E_REUSE_SERVER === '1';
// CI's browser jobs build once, check the bundle, then run E2E against that same build
// (E2E_PREBUILT=1). Missing or stale builds are refused. Otherwise E2E builds both apps itself.
const prebuilt = process.env.E2E_PREBUILT === '1';
// Playwright runs from the repository root (as e2e/support/db.ts assumes).
if (prebuilt) assertPrebuilt(process.cwd());
const buildApps = prebuilt
  ? ''
  : ' && npm run build -w @materialmule/web && npm run build -w @materialmule/api';
// A fake Zebra printer (raw TCP, like port 9100) that the API prints to during E2E (MM-T15).
// Started by e2e/support/global-setup.ts; 1000 above the app port so worktrees don't collide.
const FAKE_PRINTER_PORT = PORT + 1000;
process.env.E2E_FAKE_PRINTER_PORT = String(FAKE_PRINTER_PORT);
// A fictional Microsoft tenant + Graph for Microsoft sign-in tests (MM-T05), 2000 above the app.
const MOCK_IDP_PORT = Number(process.env.E2E_MOCK_IDP_PORT ?? PORT + 2000);
const MOCK_IDP_URL = `http://127.0.0.1:${MOCK_IDP_PORT}`;
// Fictional IDs that match apps/api/src/test-support/mock-oidc.ts. Never real tenant/object IDs.
const MOCK_TENANT_ID = '11111111-2222-4333-8444-555555555555';
const MOCK_CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MOCK_BOOTSTRAP_OID = '00000000-0000-4000-8000-0000000a0001';

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/support/global-setup.ts',
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
  webServer: [
    {
      name: 'mock-microsoft',
      command: 'npm run mock:idp -w @materialmule/api',
      port: MOCK_IDP_PORT,
      reuseExistingServer: reuseServer,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { MOCK_IDP_PORT: String(MOCK_IDP_PORT) },
    },
    {
      name: 'app',
      // Fresh test database with fictional fixtures, both builds (unless prebuilt), then the API
      // with test sign-in on.
      command:
        'npm run db:reset:test -w @materialmule/api && npm run db:seed:dev -w @materialmule/api' +
        buildApps +
        ' && npm run start -w @materialmule/api',
      // Wait on the port, not /api/health: a 503 (database down) would never count as ready,
      // and the smoke test reports the database state more clearly than a startup timeout.
      port: PORT,
      reuseExistingServer: reuseServer,
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
        LABEL_PRINTER_HOST: '127.0.0.1',
        LABEL_PRINTER_PORT: String(FAKE_PRINTER_PORT),
        // 4xx responses log at warn; keep E2E output to real errors.
        LOG_LEVEL: 'error',
        // Microsoft sign-in against the mock tenant (http is allowed only outside production).
        MICROSOFT_TENANT_ID: MOCK_TENANT_ID,
        MICROSOFT_CLIENT_ID: MOCK_CLIENT_ID,
        MICROSOFT_CLIENT_SECRET: 'mock-client-secret-not-a-real-secret',
        MICROSOFT_REDIRECT_URI: `http://127.0.0.1:${PORT}/sign-in/microsoft/callback`,
        MICROSOFT_AUTHORITY_HOST: MOCK_IDP_URL,
        MICROSOFT_GRAPH_BASE_URL: MOCK_IDP_URL,
        BOOTSTRAP_ADMIN_OBJECT_ID: MOCK_BOOTSTRAP_OID,
      },
    },
  ],
});
