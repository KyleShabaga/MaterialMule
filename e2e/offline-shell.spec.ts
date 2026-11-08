import { expect, test } from '@playwright/test';

// MM-V2-C11 spike: the app-shell service worker and manifest in Chromium. This is not device
// evidence (that comes only from the phone runs on the card); it keeps the worker from breaking
// and shows the shell, a draft and its 3 MB photo come back with the browser offline.

test('the app shell starts offline and keeps a draft with a 3 MB photo', async ({
  page,
  context,
}) => {
  await page.goto('/offline-spike');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.getByRole('button', { name: 'Save draft on device' }).click();
  await expect(page.getByText(/^Saved on device at/)).toBeVisible();

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Offline spike (MM-V2-C11)' })).toBeVisible();
    await page.getByRole('button', { name: 'Check saved draft' }).click();
    await expect(
      page.getByText(/^PASS: Draft saved .* 3\.0 MB as blob, size matches, SHA-256 matches/),
    ).toBeVisible();

    // A new tab while offline: the worker answers the navigation from its cache.
    const fresh = await context.newPage();
    const response = await fresh.goto('/offline-spike');
    expect(response?.fromServiceWorker()).toBe(true);
    await expect(fresh.getByRole('heading', { name: 'Offline spike (MM-V2-C11)' })).toBeVisible();
    await fresh.close();
  } finally {
    await context.setOffline(false);
  }
});

test('the worker and manifest are served for a Home Screen install', async ({ request }) => {
  const worker = await request.get('/sw.js');
  expect(worker.status()).toBe(200);
  expect(worker.headers()['cache-control']).toBe('no-cache');
  expect(await worker.text()).toMatch(/^self\.__MM_SHELL_BUILD__ = \{"version":"[0-9a-f]{16}"/);

  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.headers()['content-type']).toMatch(/^application\/manifest\+json/);
  const body = (await manifest.json()) as { icons: { src: string }[]; display: string };
  expect(body.display).toBe('standalone');
  for (const icon of body.icons) {
    expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  }
});
