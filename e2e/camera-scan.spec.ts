import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { cameraState, installFakeCamera, labelCrop, labelImage } from './support/fake-camera';
import { insertInventoryFixture } from './support/inventory';

// MM-T17: phone-camera scanning against a fake camera that films a generated T14 label, decoded
// by the app's real decoder (ZXing WebAssembly; headless Chromium has no BarcodeDetector).
// 127.0.0.1 counts as a secure context, as HTTPS will on the office network (T20).

function countLookups(page: Page) {
  const codes: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/storage-units/lookup') codes.push(url.searchParams.get('code')!);
  });
  return codes;
}

for (const symbol of ['code128', 'qr'] as const) {
  test(`T2/AC1/AC3/AC5: the camera reads the label's ${symbol === 'qr' ? 'QR' : 'Code 128'} and opens the unit once`, async ({
    page,
  }) => {
    const data = await insertInventoryFixture();
    await installFakeCamera(page, { image: labelImage(data.a1), crop: labelCrop(symbol) });
    await signInAs(page, 'de');
    const lookups = countLookups(page);
    const wasm: string[] = [];
    page.on('response', (response) => {
      if (response.url().endsWith('.wasm')) wasm.push(response.headers()['content-type'] ?? '');
    });

    await page.goto('/sample-storage?decoder=zxing');
    await expect(page.getByRole('heading', { level: 1, name: 'Sample Storage' })).toBeVisible();
    // AC2: nothing has asked for the camera yet.
    expect((await cameraState(page)).calls).toBe(0);

    const started = Date.now();
    await page.getByRole('button', { name: 'Scan with camera' }).click();
    const dialog = page.getByRole('dialog', { name: 'Scan with camera' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(`Found ${data.a1}`)).toBeVisible({ timeout: 10_000 });
    test.info().annotations.push({
      type: 'decode-to-found',
      description: `${Date.now() - started} ms (fake camera, desktop Chromium)`,
    });
    await expect(dialog.getByText('Decoder: ZXing (WebAssembly)')).toBeVisible();

    // AC3: opens once, even though the label stays in front of the camera.
    await expect(page).toHaveURL(new RegExp(`/sample-storage/${data.a1}$`));
    await expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible();
    expect(lookups).toEqual([data.a1]);
    // AC5: leaving the scanner stopped the camera.
    expect(await cameraState(page)).toEqual({ calls: 1, live: 0 });
    // The decoder came from Material Mule itself, as WebAssembly.
    expect(wasm).toEqual(['application/wasm']);
  });
}

test('AC2/AC5: no prompt before tapping; Close and Escape turn the camera off', async ({
  page,
}) => {
  await installFakeCamera(page, { image: labelImage('BKT-2024-000001'), crop: labelCrop('text') });
  await signInAs(page, 'at');
  for (const path of ['/', '/sample-storage', '/sample-storage/scan', '/receiving-log/new']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect((await cameraState(page)).calls, path).toBe(0);
  }

  await page.goto('/sample-storage/scan');
  await page.getByRole('button', { name: 'Scan with camera' }).click();
  const dialog = page.getByRole('dialog', { name: 'Scan with camera' });
  await expect(dialog.getByRole('status')).toHaveText('Point at the label');
  expect(await cameraState(page)).toEqual({ calls: 1, live: 1 });
  await dialog.getByRole('button', { name: 'Close camera' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await cameraState(page)).toEqual({ calls: 1, live: 0 });

  await page.getByRole('button', { name: 'Scan with camera' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Point at the label');
  expect((await cameraState(page)).live).toBe(1);
  // MTR-143: a modal dialog; Tab never reaches the page hidden behind it. Past the last
  // control Chromium may hand focus to the browser itself (activeElement is then the body).
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('Tab');
    const where = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return 'browser';
      return active.closest('dialog.camera-scanner') ? 'scanner' : active.outerHTML.slice(0, 80);
    });
    expect(['scanner', 'browser'], `Tab ${step + 1}`).toContain(where);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await cameraState(page)).toEqual({ calls: 2, live: 0 });
  await expect(page.getByRole('button', { name: 'Scan with camera' })).toBeFocused();
});

test('T3/AC4: permission denied explains itself and manual entry still opens the unit', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  await installFakeCamera(page, { fail: 'NotAllowedError' });
  await signInAs(page, 'de');
  await page.goto('/sample-storage');
  await page.getByRole('button', { name: 'Scan with camera' }).click();
  const dialog = page.getByRole('dialog', { name: 'Scan with camera' });
  await expect(dialog.getByRole('heading', { name: 'Camera access is blocked' })).toBeVisible();
  await expect(dialog.getByText(/Permissions → Camera → Allow/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();

  await dialog.getByRole('textbox', { name: 'Or type the storage unit ID' }).fill(data.b1);
  await dialog.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { level: 1, name: data.b1 })).toBeVisible();
});

test('AC4: no camera on the device', async ({ page }) => {
  await installFakeCamera(page, { fail: 'NotFoundError' });
  await signInAs(page, 'de');
  await page.goto('/sample-storage');
  await page.getByRole('button', { name: 'Scan with camera' }).click();
  const dialog = page.getByRole('dialog', { name: 'Scan with camera' });
  await expect(dialog.getByRole('heading', { name: 'No camera found' })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Or type the storage unit ID' })).toBeVisible();
});
