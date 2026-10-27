import { createHash, randomBytes } from 'node:crypto';
import { test, type Page } from '@playwright/test';
import { withDatabase } from './db';

// A real shared receiving-station (LAB) session for E2E (MM-T18), without the LAB password.
//
// Signing in through the LAB form needs the shared password, and lab-login.spec.ts resets it,
// which revokes every session of the seeded LAB account at once. So the critical-path tests use a
// second shared_lab account that exists only in the E2E database (display name "LAB", fixed
// fictional UUID) and give it a session row directly, exactly as POST /api/auth/lab/sign-in
// creates one: a random token of which only the SHA-256 is stored, expiring a month later. The
// API treats it like any LAB session; permissions come from account_type = 'shared_lab'.

export const E2E_LAB_STATION_ID = '00000000-0000-4000-8000-0000000e1801';
const SESSION_COOKIE = 'materialmule_session';

async function ensureStationAccount() {
  await withDatabase((client) =>
    client.query(
      `INSERT INTO app_user (id, display_name, account_type, status)
       VALUES ($1, 'LAB', 'shared_lab', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [E2E_LAB_STATION_ID],
    ),
  );
}

/** Signs the page's browser context in as the shared LAB station; returns the session row ID. */
export async function signInAsLabStation(page: Page): Promise<string> {
  await ensureStationAccount();
  await page.request.post('/api/auth/sign-out', { headers: { 'x-materialmule-csrf': '1' } });
  const token = randomBytes(32).toString('base64url');
  const sessionId = await withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO session (user_id, token_hash, created_at, expires_at)
       VALUES ($1, $2, now(), now() + interval '1 month') RETURNING id`,
      [E2E_LAB_STATION_ID, createHash('sha256').update(token, 'utf8').digest()],
    );
    return rows[0]!.id;
  });
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error('playwright.config.ts sets no baseURL');
  await page
    .context()
    .addCookies([
      { name: SESSION_COOKIE, value: token, url: baseURL, httpOnly: true, sameSite: 'Lax' },
    ]);
  return sessionId;
}

/** Ends a session as if its time had run out (the LAB month, MM-T06). */
export async function expireSession(sessionId: string): Promise<void> {
  await withDatabase((client) =>
    // Moves the whole month into the past (expires_at must stay after created_at).
    client.query(
      `UPDATE session SET created_at = now() - interval '1 month' - interval '1 second',
                          expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [sessionId],
    ),
  );
}
