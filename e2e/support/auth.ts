import type { Page } from '@playwright/test';

/** Fixture keys seeded by apps/api/seed/dev.sql (MM-T33). */
export type FixtureKey = 'admin' | 'lab' | 'at' | 'pe' | 'de' | 'js-tech' | 'js-eng';

/**
 * Signs the page's browser context in as a test fixture through the API (no UI clicks), signing
 * out any previous identity first. Cookies land in the context, so later page loads are signed in.
 */
export async function signInAs(page: Page, fixtureKey: FixtureKey): Promise<void> {
  const headers = { 'x-materialmule-csrf': '1' };
  await page.request.post('/api/auth/sign-out', { headers });
  const response = await page.request.post('/api/auth/test/sign-in', {
    headers,
    data: { fixtureKey },
  });
  if (response.status() !== 204) {
    throw new Error(`Test sign-in as ${fixtureKey} failed: HTTP ${response.status()}`);
  }
}
