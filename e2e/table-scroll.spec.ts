import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { DEMO, uniqueTag } from './support/receiving';
import { removeTestedTube, testedTube } from './support/tested-tube';

// MTR-58: Sample Storage's Standard view never clips a column, card or badge. Where the table is
// wider than its card it scrolls inside the card (a focusable region), and stacked cards wrap long
// badges instead of running past the card. Desktop only: the widths are set here.

test.skip(({ isMobile }) => isMobile, 'Sets its own widths');

const CSRF = { 'x-materialmule-csrf': '1' };

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/**
 * Scrolled to its far end, nothing in the table card reaches past the card's right edge, so every
 * column can be seen. Returns how far the table scrolls sideways.
 */
async function expectNothingPastCard(page: Page, what: string): Promise<number> {
  const { scrolls, past } = await page.locator('.table-card').evaluate((card) => {
    const scroller = card.querySelector<HTMLElement>('.table-scroll')!;
    scroller.scrollLeft = scroller.scrollWidth;
    const right = card.getBoundingClientRect().right;
    const past = [...card.querySelectorAll('th, td, td *')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.right > right + 0.5;
      })
      .map((element) => `${element.tagName} "${(element.textContent ?? '').slice(0, 40)}"`);
    const scrolls = scroller.scrollWidth - scroller.clientWidth;
    scroller.scrollLeft = 0;
    return { scrolls, past };
  });
  expect(past, `${what}: past the card's right edge`).toEqual([]);
  return scrolls;
}

test('MTR-58: Standard view scrolls inside its card or wraps; nothing is clipped', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const tag = uniqueTag('mtr58');
  // A disposed-after-testing Shelby tube and two bulk soil buckets ("bucket 1 of 2").
  const tube = await testedTube(page);
  await removeTestedTube(page, tube);
  const receipt = await page.request.post('/api/receipts', {
    headers: CSRF,
    data: {
      idempotencyKey: randomUUID(),
      projectId: DEMO.projectId,
      receivedDate: '2026-10-20',
      receiverUserId: DEMO.at,
      bulkGroups: [
        {
          key: 'b1',
          sourceType: 'standalone_location',
          sourceLocationReference: `Stockpile ${tag}`,
          sampleReference: 'B1',
          depthFrom: 1.5,
          depthTo: 2,
          depthUnit: 'm',
        },
      ],
      units: [1, 2].map((n) => ({
        clientRowId: `row-${n}`,
        unitType: 'bucket',
        bulkGroup: { newGroupKey: 'b1' },
      })),
    },
  });
  expect(receipt.status(), await receipt.text()).toBe(201);

  for (const [search, shows] of [
    [tube.readableId, /Disposed after testing/i],
    [tag, /bucket 2 of 2/i],
  ] as const) {
    for (const width of [1280, 1281, 820, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `/sample-storage?status=all&pageSize=50&search=${encodeURIComponent(search)}`,
      );
      await page.getByRole('button', { name: 'Standard' }).click();
      const units = page.getByRole('table', { name: 'Storage units' });
      await expect(units.getByText(shows).first()).toBeVisible();
      const what = `${search} at ${width}px`;

      expect(await pageOverflow(page), what).toBeLessThanOrEqual(0);
      const scrolls = await expectNothingPastCard(page, what);
      if (await units.locator('thead').isVisible()) {
        await expect(units.getByRole('columnheader', { name: 'Retain until' })).toBeAttached();
      } else {
        // Stacked cards fit their box: long badges wrap rather than needing a sideways scroll.
        expect(scrolls, `${what}: stacked cards scroll sideways`).toBeLessThanOrEqual(0);
      }
      if (scrolls > 0) {
        // Keyboard users reach the hidden columns: the region takes focus and scrolls with arrows.
        const region = page.getByRole('region', { name: 'Storage unit table' });
        await region.focus();
        await page.keyboard.press('ArrowRight');
        await expect
          .poll(() => region.evaluate((element) => element.scrollLeft), { message: what })
          .toBeGreaterThan(0);
      }
    }
  }
});
