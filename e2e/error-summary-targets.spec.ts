import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { openWizard } from './support/receiving';

// MTR-128-2: the error summary on Receive samples lists one link per problem; each link is at
// least 24 px tall and none overlaps the next (WCAG 2.5.8 Target Size (Minimum)).

test('MTR-128-2: error-summary links are 24 px targets that do not touch', async ({ page }) => {
  await signInAs(page, 'at');
  await openWizard(page);
  await page.getByRole('button', { name: 'Next: Review' }).click();
  const links = page.locator('.error-summary li a');
  await expect(links.first()).toBeVisible();
  expect(await links.count()).toBeGreaterThan(1);

  const boxes = await links.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { text: element.textContent ?? '', top: box.top, bottom: box.bottom };
    }),
  );
  for (const box of boxes) {
    expect(box.bottom - box.top, box.text).toBeGreaterThanOrEqual(24);
  }
  for (let i = 1; i < boxes.length; i += 1) {
    expect(boxes[i]!.top, `${boxes[i]!.text} below ${boxes[i - 1]!.text}`).toBeGreaterThanOrEqual(
      boxes[i - 1]!.bottom,
    );
  }
});
