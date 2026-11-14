import { expect, test, type Request } from '@playwright/test';
import { signInAs } from '../support/auth';
import { withDatabase } from '../support/db';
import { E2E_LAB_STATION_ID, signInAsLabStation } from '../support/lab-station';
import { dropNextPrintJobContaining } from '../support/printer';
import { closeMore, isPhoneLayout, openAccount } from '../support/shell';
import {
  addHole,
  addUnit,
  bucket,
  chooseDemoProject,
  chooseProject,
  chooseReceiver,
  confirmDelivery,
  createProjectThroughApi,
  DEMO,
  issuedIds,
  openWizard,
  receiptsDescribed,
  receiveThroughApi,
  sampleRange,
  summaryOf,
  toUnits,
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
    await toUnits(page);
    await addHole(bucket(page, 1), 'TH26-01');
    await sampleRange(bucket(page, 1), 'TH26-01', 'G1', 'S12');
    await addUnit(page);
    await addHole(bucket(page, 2), 'TH26-01');
    await sampleRange(bucket(page, 2), 'TH26-01', 'G13', 'S32');
    // D41: the quantity is calculated from the units; never an individual sample list (CLAUDE.md).
    await expect(page.getByRole('region', { name: 'Confirm receipt' })).toContainText(
      '2 storage units · IDs issue on confirm',
    );
    await expect(page.getByLabel(/sample (number|id)/i)).toHaveCount(0);

    await confirmDelivery(page);
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
    await expect(page.getByRole('region', { name: 'Where it is' })).toContainText('Receiving lab');
    await expect(
      page
        .getByRole('table', { name: 'Test hole summaries' })
        .getByRole('row')
        .filter({ hasText: 'TH26-01' }),
    ).toContainText('G1–S12');
  },
);

test(
  'LAB receives a mixed-hole bucket for a chosen receiver; history shows LAB and the receiver',
  critical,
  async ({ page }) => {
    const description = uniqueTag('T18-lab');
    await signInAsLabStation(page);
    await openWizard(page);
    // The account row sits in the sidebar footer (desktop) or the sidebar Sheet (phone).
    await expect(await openAccount(page)).toContainText('LAB station');
    await closeMore(page);
    // LAB starts blank every time and must pick a listed person (App Idea §8, T8/AC5). The
    // Recording as person (Alex Tester here) never fills Received by (STRATA-107).
    const receiver = page.getByRole('combobox', { name: 'Received by', exact: true });
    await expect(receiver).toHaveValue('');
    await receiver.fill('JS');
    // Two people share "JS"; full names tell them apart.
    await expect(page.getByRole('option', { name: /^JS · Jordan Smith/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /^JS · Jamie Song/ })).toBeVisible();
    await page.getByRole('option', { name: /^JS · Jordan Smith/ }).click();

    await chooseDemoProject(page);
    await page.getByLabel('Description (optional)').fill(description);
    await toUnits(page);
    const unit = bucket(page, 1);
    await addHole(unit, 'TH26-01');
    await sampleRange(unit, 'TH26-01', 'G1', 'S12');
    await addHole(unit, 'TH26-02');
    await summaryOf(unit, 'TH26-02').getByLabel('Summary type').selectOption('all');
    // One unit, two holes: the second is an "Also holds" line with its own summary.
    await expect(
      unit.getByRole('list', { name: 'Bucket 1 samples and depth' }).getByRole('listitem'),
    ).toHaveCount(2);
    await confirmDelivery(page);
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
    await expect(
      page
        .getByRole('table', { name: 'Test hole summaries' })
        .getByRole('row')
        .filter({ hasText: 'TH26-01' }),
    ).toContainText('G1–S12');
    await expect(
      page
        .getByRole('table', { name: 'Test hole summaries' })
        .getByRole('row')
        .filter({ hasText: 'TH26-02' }),
    ).toContainText('All samples');
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
    const form = page.getByRole('dialog', { name: 'Add project' });
    await expect(form.getByLabel('Project number')).toHaveValue(projectNumber);
    await form.getByLabel('Project name').fill('Example Ridge');
    await form.getByLabel('Client').fill('Example Client');
    await form
      .getByLabel('Nominate a Lead Project Engineer (optional)')
      .selectOption({ label: 'PE · Pat Example' });
    await form.getByRole('button', { name: 'Add project' }).click();
    await expect(page.getByLabel('Project number')).toHaveValue(projectNumber);
    await toUnits(page);

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
    await confirmDelivery(page);
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
      await toUnits(page);
      await addHole(bucket(page, 1), 'TH26-01');
      await sampleRange(bucket(page, 1), 'TH26-01', 'G1', 'S4');
    }

    // 1. Double-click: one receipt, one unit.
    const doubled = uniqueTag('T18-dblclick');
    await fillOneBucket(doubled);
    // The dialog's Confirm is double-clicked: the receipt is sent once.
    await page.getByRole('button', { name: 'Confirm and print labels' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Confirm 1 unit and print labels' })
      .dblclick();
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
    await confirmDelivery(page);
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
  // A project of its own, so the printer can be told to drop this receipt's labels (they carry
  // the project number) before the confirm sends them.
  const projectNumber = uniqueTag('E2E-PRINT').toUpperCase();
  await signInAs(page, 'at');
  await createProjectThroughApi(page, projectNumber, 'TH26-01');
  await openWizard(page);
  await chooseProject(page, projectNumber, `${projectNumber} · Example Ridge · Example Client`);
  await page.getByLabel('Description (optional)').fill(description);
  await toUnits(page);
  await addHole(bucket(page, 1), 'TH26-01');
  await sampleRange(bucket(page, 1), 'TH26-01', 'G1', 'S12');
  await addUnit(page);
  await addHole(bucket(page, 2), 'TH26-01');
  await sampleRange(bucket(page, 2), 'TH26-01', 'G13', 'S32');

  // The printer drops the connection part-way through this receipt's labels.
  await dropNextPrintJobContaining(projectNumber);
  await confirmDelivery(page);
  const ids = await issuedIds(page);
  const before = await unitState(ids);
  // STRATA-77: an uncertain print makes Print again the primary; nothing is confirmed again.
  await expect(page.getByText(/it isn’t known whether the labels printed/)).toBeVisible({
    timeout: 15_000,
  });
  // D03: a failed print changes nothing about the units.
  expect(await unitState(ids)).toEqual(before);

  await page.getByRole('button', { name: 'Print again' }).click();
  await expect(
    page.getByRole('list', { name: 'New storage units' }).getByText('Sent to printer'),
  ).toHaveCount(2, { timeout: 15_000 });

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
      const path = new URL(r.url()).pathname;
      // Opening the unit adds it to the person's sidebar Recent (their view history, not a record
      // change), so that one POST is not a write here.
      if (r.method() !== 'GET' && path.startsWith('/api/') && path !== '/api/me/recents')
        writes.push(r.url());
    });

    await page.goto('/sample-storage/scan');
    // Phones keep the Scan page; on desktop the URL opens the Ctrl K menu, which takes the scan
    // and opens the unit (STRATA-81).
    const phone = isPhoneLayout(page);
    const field = phone
      ? page.getByRole('textbox', { name: 'Scan a storage unit label' })
      : page
          .getByRole('dialog', { name: 'Search or scan' })
          .getByRole('combobox', { name: 'Search or scan a label' });
    await expect(field).toBeFocused();
    // The DS3678-XR is a keyboard: the label's data, then its Enter suffix (MM-T16).
    await page.keyboard.type(unit!.suNumber);
    await page.keyboard.press('Enter');
    if (phone) {
      await expect(page.getByRole('status').filter({ hasText: unit!.suNumber })).toHaveText(
        `Success: Found ${unit!.suNumber}`,
      );
      const card = page.getByRole('region', { name: unit!.suNumber });
      await expect(card).toContainText('DEMO-2601');
      await expect(card).toContainText('Receiving lab');
    } else {
      await expect(page).toHaveURL(new RegExp(`/sample-storage/${unit!.suNumber}$`));
      await expect(page.getByRole('heading', { level: 1, name: unit!.suNumber })).toBeVisible();
      await expect(page.getByRole('main')).toContainText('DEMO-2601');
      await expect(page.getByRole('main')).toContainText('Receiving lab');
    }

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
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Correct' }).click();
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
    await expect(page.getByRole('region', { name: 'Retention', exact: true })).toContainText(
      'Retain until 2027-10-19',
    );
    await expect(page.getByRole('region', { name: 'Where it is' })).toContainText('Receiving lab');
    await expect(page.getByRole('list', { name: 'History events' })).toContainText(
      'Reason: wrong date on tag',
    );
    const corrected = await unitState([id]);
    expect(corrected[0]).toMatchObject({ readable_id: id, received_date: '2026-10-19' });

    // The shared LAB station sees why it can't correct, and the API refuses it outright.
    await signInAsLabStation(page);
    await page.goto(`/sample-storage/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: id })).toBeVisible();
    // STRATA-72: Correct sits in More, disabled for LAB with its reason under it.
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Correct' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.getByText('Corrections need a personal account.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('form', { name: 'Correct details' })).toHaveCount(0);
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

  // STRATA-79: the toolbar's search opens from its Search button; filters are chips, each with
  // its own picker, added from "+ Add filter".
  await page.goto('/sample-storage');
  const searchBox = page.getByRole('searchbox', { name: 'Search storage units' });
  const search = async (text: string) => {
    if (!(await searchBox.isVisible())) {
      await page
        .getByRole('toolbar', { name: 'Storage unit tools' })
        .getByRole('button', { name: 'Search', exact: true })
        .click();
    }
    await searchBox.fill(text);
  };
  await search(projectNumber);
  const count = page.getByRole('status').filter({ hasText: 'storage unit' });
  await expect(count).toHaveText('2 storage units');
  const table = page.getByRole('table', { name: 'Storage units' });
  for (const id of ids) await expect(table.getByText(id)).toBeVisible();

  // Narrow by project, location and type, one at a time as a person would (each applied before
  // the next; see defect D2 in docs/testing/receiving-regression-results.md): the new units stay.
  const addFilter = async (field: string) => {
    await page.getByRole('button', { name: 'Add filter' }).click();
    await page.getByRole('menuitem', { name: field }).click();
  };
  const chip = (field: string) => page.getByRole('group', { name: `Filter ${field}` });
  await addFilter('Project');
  await page.getByRole('combobox', { name: 'Project' }).fill(projectNumber);
  await page.getByRole('option', { name: new RegExp(`^${projectNumber} ·`) }).click();
  await expect(chip('Project')).toContainText(projectNumber);
  await addFilter('Location');
  await page.getByRole('option', { name: 'Receiving lab' }).click();
  await expect(chip('Location')).toContainText('Receiving lab');
  await addFilter('Type');
  await page.getByRole('option', { name: 'Bucket', exact: true }).click();
  await expect(chip('Type')).toContainText('Bucket');
  await expect(chip('Project')).toContainText(projectNumber);
  await expect(chip('Location')).toContainText('Receiving lab');
  await expect(count).toHaveText('2 storage units');
  for (const id of ids) await expect(table.getByText(id)).toBeVisible();

  // And by ID alone, from a search by the readable ID.
  await page
    .getByRole('group', { name: 'Filters' })
    .getByRole('button', { name: 'Clear filters' })
    .click();
  await expect(page.getByRole('group', { name: /^Filter / })).toHaveCount(0);
  await expect(page).not.toHaveURL(/search=/);
  await search(ids[1]!);
  await expect(count).toHaveText('1 storage unit');
  await expect(table.getByText(ids[1]!)).toBeVisible();
});
