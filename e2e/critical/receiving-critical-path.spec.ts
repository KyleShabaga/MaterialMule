import { expect, test, type Request } from '@playwright/test';
import { signInAs } from '../support/auth';
import { withDatabase } from '../support/db';
import { E2E_LAB_STATION_ID, signInAsLabStation } from '../support/lab-station';
import { dropNextPrintJobContaining } from '../support/printer';
import {
  addHole,
  bucket,
  chooseDemoProject,
  chooseReceiver,
  createProjectThroughApi,
  DEMO,
  issuedIds,
  openWizard,
  receiptsDescribed,
  receiveThroughApi,
  sampleRange,
  summaryOf,
  uniqueTag,
  unitState,
} from '../support/receiving';

// MM-T18: the receiving critical path, end to end against the production-shaped build, at
// desktop and phone widths. Run just these with `npm run test:e2e:critical`.
// Each test makes its own fictional receipts, tagged with a unique description or project
// number, so parallel workers and viewports never see each other's data. Traceability:
// docs/testing/receiving-critical-path.md. Scenarios that need MM-T11 (draft autosave, LAB
// session expiry mid-draft) are listed there as pending until T11 is merged.

const critical = { tag: '@critical' };

test(
  'personal user receives two TH26-01 buckets with summaries only; BKT IDs at Receiving lab',
  critical,
  async ({ page }) => {
    const description = uniqueTag('T18-personal');
    await signInAs(page, 'at');
    await openWizard(page);
    await chooseDemoProject(page);
    // A personal account is the receiver by default (MM-T10 AC5).
    await expect(page.getByRole('combobox', { name: 'Received by', exact: true })).toHaveValue(
      /^AT · Alex Tester/,
    );
    await page.getByLabel('Description (optional)').fill(description);
    await addHole(bucket(page, 1), 'TH26-01');
    await sampleRange(bucket(page, 1), 'TH26-01', 'G1', 'S12');
    await page.getByRole('button', { name: 'Add bucket' }).click();
    await addHole(bucket(page, 2), 'TH26-01');
    await sampleRange(bucket(page, 2), 'TH26-01', 'G13', 'S32');
    // D41: the quantity is calculated from the units; never an individual sample list (CLAUDE.md).
    await expect(page.getByText('2 storage units').first()).toBeVisible();
    await expect(page.getByLabel(/sample (number|id)/i)).toHaveCount(0);

    await page.getByRole('button', { name: 'Next: Review' }).click();
    await page.getByRole('button', { name: 'Confirm receipt' }).click();
    const ids = await issuedIds(page);
    expect(ids).toHaveLength(2);

    const [receipt, ...others] = await receiptsDescribed(description);
    expect(others).toEqual([]);
    expect(receipt).toMatchObject({
      quantity: 2,
      account_user_id: DEMO.at,
      receiver_user_id: DEMO.at,
      receiver_initials_snapshot: 'AT',
      readable_ids: ids,
      // D03: confirmation puts every unit in the Receiving lab.
      locations: ['RECEIVING', 'RECEIVING'],
      project_number: 'DEMO-2601',
    });

    await page.getByRole('link', { name: `Open ${ids[0]}` }).click();
    await expect(page.getByRole('heading', { level: 1, name: ids[0]! })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Location and retention' })).toContainText(
      'Receiving lab',
    );
    await expect(page.getByRole('list', { name: 'Test hole summaries' })).toContainText(
      'TH26-01: G1–S12',
    );
  },
);

test(
  'LAB receives a mixed-hole bucket for a chosen receiver; history shows LAB and the receiver',
  critical,
  async ({ page }) => {
    const description = uniqueTag('T18-lab');
    await signInAsLabStation(page);
    await openWizard(page);
    await expect(page.getByLabel('Signed in user')).toContainText('Shared station: LAB');
    // LAB starts blank every time and must pick a listed person (App Idea §8).
    const receiver = page.getByRole('combobox', { name: 'Received by', exact: true });
    await expect(receiver).toHaveValue('');
    await receiver.fill('JS');
    // Two people share "JS"; full names tell them apart.
    await expect(page.getByRole('option', { name: /^JS · Jordan Smith/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /^JS · Jamie Song/ })).toBeVisible();
    await page.getByRole('option', { name: /^JS · Jordan Smith/ }).click();

    await chooseDemoProject(page);
    await page.getByLabel('Description (optional)').fill(description);
    const unit = bucket(page, 1);
    await addHole(unit, 'TH26-01');
    await sampleRange(unit, 'TH26-01', 'G1', 'S12');
    await addHole(unit, 'TH26-02');
    await summaryOf(unit, 'TH26-02').getByLabel('Summary type').selectOption('all');
    await expect(unit.getByText('TH26-01: G1–S12 · TH26-02: ALL')).toBeVisible();
    await page.getByRole('button', { name: 'Next: Review' }).click();
    await page.getByRole('button', { name: 'Confirm receipt' }).click();
    const [id] = await issuedIds(page);

    const [receipt] = await receiptsDescribed(description);
    expect(receipt).toMatchObject({
      quantity: 1,
      account_user_id: E2E_LAB_STATION_ID,
      receiver_user_id: DEMO.jordanSmith,
      receiver_initials_snapshot: 'JS',
      readable_ids: [id],
      locations: ['RECEIVING'],
    });
    const audit = await withDatabase(async (client) => {
      const { rows } = await client.query(
        `SELECT actor_user_id, actor_account_type, receiver_user_id FROM audit_event
       WHERE action = 'receipt.confirmed' AND entity_id = $1`,
        [receipt!.receipt_id],
      );
      return rows;
    });
    expect(audit).toEqual([
      {
        actor_user_id: E2E_LAB_STATION_ID,
        actor_account_type: 'shared_lab',
        receiver_user_id: DEMO.jordanSmith,
      },
    ]);

    await page.getByRole('link', { name: `Open ${id}` }).click();
    const receiptCard = page.getByRole('region', { name: 'Receipt' });
    await expect(receiptCard).toContainText('JS · Jordan Smith');
    await expect(receiptCard).toContainText('LAB');
    await expect(page.getByRole('list', { name: 'Test hole summaries' })).toContainText(
      'TH26-02: ALL',
    );
  },
);

test(
  'a missing project and hole are added mid-receipt; the draft stays intact and confirms',
  critical,
  async ({ page }) => {
    const description = uniqueTag('T18-newproj');
    const projectNumber = uniqueTag('E2E').toUpperCase();
    await signInAsLabStation(page);
    await openWizard(page);
    await chooseReceiver(page, 'AT', /^AT · Alex Tester/);
    await page.getByLabel('Description (optional)').fill(description);

    // D42: the project isn't there yet, so LAB adds it with every required field.
    await page.getByRole('combobox', { name: /Find project/ }).fill(projectNumber);
    await expect(page.getByRole('option', { name: 'No matching project' })).toBeVisible();
    await page.getByRole('button', { name: 'Add project' }).click();
    const form = page.getByRole('group', { name: 'Add project' });
    await expect(form.getByLabel('Project number')).toHaveValue(projectNumber);
    await form.getByLabel('Project name').fill('Example Ridge');
    await form.getByLabel('Client').fill('Example Client');
    await form.getByLabel('PM/PE').selectOption({ label: 'PE · Pat Example' });
    await form.getByRole('button', { name: 'Save project' }).click();
    await expect(page.getByLabel('Project number')).toHaveValue(projectNumber);

    // ... and a hole that doesn't exist in it yet.
    const unit = bucket(page, 1);
    await unit.getByRole('combobox', { name: 'Find or add a test hole' }).fill('TH26-03');
    await page.getByRole('option', { name: 'Add TH26-03' }).click();
    await summaryOf(unit, 'TH26-03').getByLabel('Summary type').selectOption('all');

    // Nothing typed earlier was lost.
    await expect(page.getByRole('combobox', { name: 'Received by', exact: true })).toHaveValue(
      /^AT · Alex Tester/,
    );
    await expect(page.getByLabel('Description (optional)')).toHaveValue(description);
    await page.getByRole('button', { name: 'Next: Review' }).click();
    await page.getByRole('button', { name: 'Confirm receipt' }).click();
    const [id] = await issuedIds(page);

    expect(await receiptsDescribed(description)).toMatchObject([
      {
        quantity: 1,
        project_number: projectNumber,
        receiver_user_id: DEMO.at,
        account_user_id: E2E_LAB_STATION_ID,
        readable_ids: [id],
      },
    ]);
    const holes = await withDatabase(async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `SELECT th.name FROM storage_unit_hole_summary s
       JOIN storage_unit su ON su.id = s.storage_unit_id
       JOIN test_hole th ON th.id = s.test_hole_id WHERE su.readable_id = $1`,
        [id],
      );
      return rows.map((r) => r.name);
    });
    expect(holes).toEqual(['TH26-03']);
  },
);

test(
  'a double-clicked Confirm and a lost confirmation response create no duplicates',
  critical,
  async ({ page }) => {
    await signInAs(page, 'at');

    async function fillOneBucket(description: string) {
      await openWizard(page);
      await chooseDemoProject(page);
      await page.getByLabel('Description (optional)').fill(description);
      await addHole(bucket(page, 1), 'TH26-01');
      await sampleRange(bucket(page, 1), 'TH26-01', 'G1', 'S4');
      await page.getByRole('button', { name: 'Next: Review' }).click();
    }

    // 1. Double-click: one receipt, one unit.
    const doubled = uniqueTag('T18-dblclick');
    await fillOneBucket(doubled);
    await page.getByRole('button', { name: 'Confirm receipt' }).dblclick();
    const [first] = await issuedIds(page);
    expect(await receiptsDescribed(doubled)).toMatchObject([
      { quantity: 1, readable_ids: [first] },
    ]);

    // 2. The server confirms, but the answer never reaches the browser (connection reset). The
    //    wizard retries automatically with the same idempotency key and gets the original IDs.
    const lost = uniqueTag('T18-lost');
    const posts: Request[] = [];
    let dropped = false;
    await page.route('**/api/receipts', async (route) => {
      posts.push(route.request());
      if (!dropped) {
        dropped = true;
        await route.fetch(); // reaches the API, which commits the receipt
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    });
    await fillOneBucket(lost);
    await page.getByRole('button', { name: 'Confirm receipt' }).click();
    const [second] = await issuedIds(page);
    expect(posts.length).toBeGreaterThanOrEqual(2);
    const keys = new Set(
      posts.map((p) => (p.postDataJSON() as { idempotencyKey: string }).idempotencyKey),
    );
    expect(keys.size).toBe(1);
    expect(await receiptsDescribed(lost)).toMatchObject([
      { quantity: 1, readable_ids: [second], idempotency_key: [...keys][0] },
    ]);
  },
);

test('a failed print then a reprint keep the same IDs and location', critical, async ({ page }) => {
  const description = uniqueTag('T18-print');
  await signInAs(page, 'at');
  await openWizard(page);
  await chooseDemoProject(page);
  await page.getByLabel('Description (optional)').fill(description);
  await addHole(bucket(page, 1), 'TH26-01');
  await sampleRange(bucket(page, 1), 'TH26-01', 'G1', 'S12');
  await page.getByRole('button', { name: 'Add bucket' }).click();
  await addHole(bucket(page, 2), 'TH26-02');
  await summaryOf(bucket(page, 2), 'TH26-02').getByLabel('Summary type').selectOption('all');
  await page.getByRole('button', { name: 'Next: Review' }).click();
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  const ids = await issuedIds(page);
  const before = await unitState(ids);

  // The printer drops the connection part-way through this receipt's labels.
  await dropNextPrintJobContaining(ids[0]!);
  const labels = page.getByRole('region', { name: 'Receipt confirmed' });
  await labels.getByRole('button', { name: 'Print all labels' }).click();
  await expect(labels.getByText('Unknown — check the printer before reprinting')).toBeVisible({
    timeout: 15_000,
  });
  // D03: a failed print changes nothing about the units.
  expect(await unitState(ids)).toEqual(before);

  await labels.getByRole('button', { name: 'Reprint' }).click();
  await expect(labels.getByText('Sent to printer')).toBeVisible({ timeout: 15_000 });

  // Same IDs, same location, same receipt; two jobs (uncertain initial, sent reprint), no new unit.
  expect(await unitState(ids)).toEqual(before);
  expect(await receiptsDescribed(description)).toMatchObject([
    { quantity: 2, readable_ids: ids, locations: ['RECEIVING', 'RECEIVING'] },
  ]);
  const jobs = await withDatabase(async (client) => {
    const { rows } = await client.query<{ kind: string; status: string; ids: string[] }>(
      `SELECT j.kind, j.status, array_agg(su.readable_id ORDER BY i.position) AS ids
       FROM print_job j JOIN print_job_item i ON i.print_job_id = j.id
       JOIN storage_unit su ON su.id = i.storage_unit_id
       WHERE su.readable_id = ANY($1)
       GROUP BY j.id ORDER BY j.created_at`,
      [ids],
    );
    return rows;
  });
  expect(jobs).toEqual([
    { kind: 'initial', status: 'uncertain', ids },
    { kind: 'reprint', status: 'sent', ids },
  ]);
});

test(
  'a simulated keyboard scan opens a newly received unit and changes nothing',
  critical,
  async ({ page }) => {
    await signInAs(page, 'at');
    const [unit] = await receiveThroughApi(page, { holeIds: [DEMO.th01, DEMO.th02] });
    const before = await unitState([unit!.suNumber]);
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET' && new URL(r.url()).pathname.startsWith('/api/'))
        writes.push(r.url());
    });

    await page.goto('/sample-storage/scan');
    const field = page.getByRole('textbox', { name: 'Scan a storage unit label' });
    await expect(field).toBeFocused();
    // The DS3678-XR is a keyboard: the label's data, then its Enter suffix (MM-T16).
    await page.keyboard.type(unit!.suNumber);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: unit!.suNumber })).toHaveText(
      `Success: Found ${unit!.suNumber}`,
    );
    const card = page.getByRole('region', { name: unit!.suNumber });
    await expect(card).toContainText('DEMO-2601');
    await expect(card).toContainText('Receiving lab');

    expect(writes).toEqual([]);
    expect(await unitState([unit!.suNumber])).toEqual(before);
  },
);

test(
  'a personal user corrects a unit with a reason; LAB is refused and nothing changes',
  critical,
  async ({ page }) => {
    await signInAs(page, 'at');
    const [unit] = await receiveThroughApi(page, { receivedDate: '2026-10-20' });
    const id = unit!.suNumber;

    await page.goto(`/sample-storage/${id}`);
    await page.getByRole('button', { name: 'Correct details' }).click();
    const form = page.getByRole('form', { name: 'Correct details' });
    await form.getByLabel('Received date').fill('2026-10-19');
    await form.getByRole('button', { name: 'Save correction' }).click();
    // D45–D47: a reason is required.
    await expect(form.getByText('Enter a reason (at least 5 characters).')).toBeVisible();
    await form.getByLabel('Reason for the correction').fill('wrong date on tag');
    await form.getByRole('button', { name: 'Save correction' }).click();
    await expect(form).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: id })).toBeVisible();
    // D46: retention follows the corrected date; the ID and location stay.
    await expect(
      page.getByRole('region', { name: 'Location and retention' }).getByText('2027-10-19'),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Location and retention' })).toContainText(
      'Receiving lab',
    );
    await expect(page.getByRole('list', { name: 'History events' })).toContainText(
      'Reason: wrong date on tag',
    );
    const corrected = await unitState([id]);
    expect(corrected[0]).toMatchObject({ readable_id: id, received_date: '2026-10-19' });

    // The shared LAB station sees why it can't correct, and the API refuses it outright.
    await signInAsLabStation(page);
    await page.goto(`/sample-storage/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: id })).toBeVisible();
    await expect(page.getByText('Corrections need a personal account.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Correct details' })).toHaveCount(0);
    const refused = await page.request.patch(`/api/storage-units/${unit!.storageUnitId}`, {
      headers: { 'x-materialmule-csrf': '1' },
      data: {
        version: corrected[0]!.version,
        reason: 'LAB tries a correction',
        changes: { receivedDate: '2026-10-18' },
      },
    });
    expect(refused.status()).toBe(403);
    expect(await unitState([id])).toEqual(corrected);
  },
);

test('inventory search and filters find newly received units', critical, async ({ page }) => {
  const projectNumber = uniqueTag('E2E').toUpperCase();
  await signInAs(page, 'at');
  const project = await createProjectThroughApi(page, projectNumber, 'TH26-01');
  const units = await receiveThroughApi(page, {
    projectId: project.projectId,
    holeIds: [project.holeId],
    units: 2,
  });
  const ids = units.map((u) => u.suNumber);

  await page.goto('/sample-storage');
  await page.getByRole('searchbox', { name: 'Search' }).fill(projectNumber);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const count = page.getByRole('status').filter({ hasText: 'storage unit' });
  await expect(count).toHaveText('2 storage units');
  const table = page.getByRole('table', { name: 'Storage units' });
  for (const id of ids) await expect(table.getByText(id)).toBeVisible();

  // Narrow by project, location and type, one at a time as a person would (each applied before
  // the next; see defect D2 in docs/testing/receiving-regression-results.md): the new units stay.
  const chips = page.getByRole('list', { name: 'Active filters' });
  await page.getByRole('searchbox', { name: 'Project' }).fill(projectNumber);
  await page.getByRole('button', { name: new RegExp(`^${projectNumber} ·`) }).click();
  await expect(chips).toContainText(`Project: ${projectNumber}`);
  await page.getByRole('combobox', { name: 'Location' }).selectOption({ label: 'Receiving lab' });
  await expect(chips).toContainText('Location: Receiving lab');
  await page.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Bucket' });
  await expect(chips).toContainText('Type: Bucket');
  await expect(chips).toContainText(`Project: ${projectNumber}`);
  await expect(chips).toContainText('Location: Receiving lab');
  await expect(count).toHaveText('2 storage units');
  for (const id of ids) await expect(table.getByText(id)).toBeVisible();

  // And by ID alone, from a search by the readable ID.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(chips).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
  await page.getByRole('searchbox', { name: 'Search' }).fill(ids[1]!);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(count).toHaveText('1 storage unit');
  await expect(table.getByText(ids[1]!)).toBeVisible();
});
