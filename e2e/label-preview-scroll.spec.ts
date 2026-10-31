import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertInventoryFixture } from './support/inventory';

// MTR-128: at phone width the label preview never scrolls unless zoomed; zoomed, its frame is a
// labelled region keyboard users can focus and scroll. A disposed unit's preview (watermarked
// DISPOSED by the server, MTR-48) still shows with its reference-only note.

test.skip(({ isMobile }) => !isMobile, 'Phone layout only');

test('MTR-128: the zoomed label preview is a keyboard-scrollable region', async ({ page }) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  for (const id of [data.a1, data.aDisposed]) {
    await page.goto(`/sample-storage/${id}`);
    const panel = page.getByRole('group', { name: 'Preview label' });
    await expect(panel.getByRole('img', { name: `Label for storage unit ${id}` })).toBeVisible();
    const frame = panel.locator('.label-preview-frame');
    // Scaled to fit: nothing to scroll, so no extra tab stop.
    expect(await frame.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    await expect(frame).not.toHaveAttribute('tabindex');

    await panel.getByRole('button', { name: 'Zoom in' }).click();
    const region = panel.getByRole('region', { name: 'Label preview, scrolls sideways' });
    await expect(region).toHaveAttribute('tabindex', '0');
    await region.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  }
  await expect(page.getByText(/Shown for reference only/)).toBeVisible();
});
