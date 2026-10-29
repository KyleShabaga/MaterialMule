import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { signInAsLabStation } from './support/lab-station';

// MM-T26 program lifecycle (card T3/T6 closure route, T7 LAB denial, the empty-program rule and
// cancellation requests). Each test makes its own program on a fresh test hole, so parallel runs
// never share a test. Fictional data only: DEMO-2601, PM/PE Pat Example (pe), Lab Manager
// "Lab (test)" (lab), Technician Alex Tester (at).

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const PAT = '00000000-0000-4000-8000-000000000101';
const SOILS = '00000000-0000-4000-8000-00000000c101';
const CSRF = { 'x-materialmule-csrf': '1' };

const unique = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;

async function addTestType(page: Page, code: string) {
  await signInAs(page, 'lab'); // Lab Manager
  const response = await page.request.post('/api/test-types', {
    headers: CSRF,
    data: { groupId: SOILS, code, description: `Fictional ${code}`, name: `Test ${code}` },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).id as string;
}

/** A program with one Requested test, submitted by the signed-in account. */
async function submittedProgram(request: APIRequestContext, testTypeId: string) {
  const hole = await request.post(`/api/projects/${DEMO_PROJECT_ID}/test-holes`, {
    headers: CSRF,
    data: { name: unique('TH') },
  });
  expect(hole.status()).toBe(201);
  const holeId = (await hole.json()).id as string;
  const draft = await request.post('/api/lab-programs', {
    headers: CSRF,
    data: {
      projectId: DEMO_PROJECT_ID,
      idempotencyKey: crypto.randomUUID(),
      lines: [
        { source: { kind: 'test_hole', id: holeId }, scope: 'all', testTypeIds: [testTypeId] },
      ],
    },
  });
  expect(draft.status()).toBe(201);
  const created = await draft.json();
  const review = await (await request.get(`/api/lab-programs/${created.id}/review`)).json();
  const submitted = await request.post(`/api/lab-programs/${created.id}/submit`, {
    headers: CSRF,
    data: {
      version: created.version,
      idempotencyKey: crypto.randomUUID(),
      coverage: review.lines.map(
        (l: { lineId: string; coverage: { storageUnitId: string }[] }) => ({
          lineId: l.lineId,
          unitIds: l.coverage.map((c) => c.storageUnitId),
        }),
      ),
    },
  });
  expect(submitted.status()).toBe(200);
  const program = await submitted.json();
  return {
    programId: program.id as string,
    programNumber: program.programNumber as string,
    testRequestId: program.lines[0].requests[0].id as string,
  };
}

function lifecycle(page: Page) {
  return page.locator('.program-lifecycle');
}

function testRow(page: Page, code: string) {
  return page.locator('.request-list li', { hasText: code });
}

test('T6: closure is blocked until every test is resolved; the PM/PE closes and a Lab Manager reopens', async ({
  page,
}) => {
  const code = unique('DEMO-LC');
  const typeId = await addTestType(page, code);
  await signInAs(page, 'at');
  const { programId, programNumber } = await submittedProgram(page.request, typeId);

  await signInAs(page, 'pe');
  await page.goto(`/lab-testing/programs/${programId}`);
  await expect(page.getByRole('heading', { name: programNumber })).toBeVisible();
  const header = lifecycle(page);
  await expect(header).toContainText('Open');
  const close = header.getByRole('button', { name: 'Close program' });
  await expect(close).toBeDisabled();
  await expect(close).toHaveAccessibleDescription('1 test still Requested');
  await header.getByText(/Closure checklist/).click();
  await expect(header).toContainText(`Line 1 · ${code}`);

  // Cancel the test with a required reason: cancelled resolves it, without acceptance.
  const row = testRow(page, code);
  await row.getByRole('button', { name: 'Cancel test' }).click();
  const confirm = row.getByRole('form').getByRole('button', { name: 'Cancel test' });
  await expect(confirm).toBeDisabled();
  await row.getByLabel(/Reason for cancelling/).fill('Client withdrew this test');
  await confirm.click();
  await expect(row).toContainText('Cancelled');
  await expect(row).toContainText('Client withdrew this test');

  await expect(close).toBeEnabled();
  await close.click();
  await expect(header).toContainText('Closed');
  await expect(header).toContainText('Closed by PE · Pat Example');
  await expect(header.getByRole('button', { name: 'Close program' })).toHaveCount(0);

  // A Lab Manager reopens it with a reason; the test keeps its status.
  await signInAs(page, 'lab');
  await page.goto(`/lab-testing/programs/${programId}`);
  await header.getByRole('button', { name: 'Reopen program' }).click();
  await header.getByLabel(/Reason for reopening/).fill('Client asked for one more test');
  await header.getByRole('form').getByRole('button', { name: 'Reopen program' }).click();
  await expect(header).toContainText('Open');
  await expect(testRow(page, code)).toContainText('Cancelled');
  await header.getByText(/Program history/).click();
  await expect(header).toContainText('Reopened by LAB · Lab (test)');
});

test('Empty-program rule: a submitted program with no tests can’t be closed, even by its PM/PE', async ({
  page,
}) => {
  // Submission never produces this state; build it in the database to prove closure doesn't
  // treat "no unresolved tests" as "all tests resolved".
  const programNumber = `LP-2025-${String(randomInt(5000, 9999))}`;
  const programId = await withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO lab_program (project_id, program_number, status, created_by_account_user_id,
                                created_by_account_type, requested_by_user_id,
                                requested_by_name_snapshot, create_idempotency_key, submitted_at,
                                submitted_by_account_user_id, submitted_by_account_type,
                                submitted_by_name_snapshot, submitted_for_user_id,
                                submitted_for_name_snapshot, submit_idempotency_key)
       VALUES ($1, $2, 'submitted', $3, 'personal', $3, 'Pat Example', gen_random_uuid(), now(),
               $3, 'personal', 'Pat Example', $3, 'Pat Example', gen_random_uuid())
       RETURNING id`,
      [DEMO_PROJECT_ID, programNumber, PAT],
    );
    return rows[0]!.id;
  });
  await signInAs(page, 'pe');
  await page.goto(`/lab-testing/programs/${programId}`);
  const header = lifecycle(page);
  const close = header.getByRole('button', { name: 'Close program' });
  await expect(close).toBeDisabled();
  await expect(close).toHaveAccessibleDescription(/no test requests/);
  await expect(header).toContainText('At least one test request is needed');
  const response = await page.request.post(`/api/lab-programs/${programId}/close`, {
    headers: CSRF,
    data: { version: 1, idempotencyKey: crypto.randomUUID() },
  });
  expect(response.status()).toBe(422);
  expect((await response.json()).code).toBe('empty_program');
});

test('AC6: a Technician asks for a cancellation instead of cancelling', async ({ page }) => {
  const code = unique('DEMO-CR');
  const typeId = await addTestType(page, code);
  await signInAs(page, 'at');
  const { programId, testRequestId } = await submittedProgram(page.request, typeId);
  await page.goto(`/lab-testing/programs/${programId}`);
  const row = testRow(page, code);
  await expect(row.getByRole('button', { name: 'Cancel test' })).toHaveCount(0);
  const direct = await page.request.post(`/api/test-requests/${testRequestId}/cancel`, {
    headers: CSRF,
    data: { reason: 'x', version: 1, idempotencyKey: crypto.randomUUID() },
  });
  expect(direct.status()).toBe(403);
  await row.getByRole('button', { name: 'Request cancellation' }).click();
  await row.getByLabel(/Why this test should be cancelled/).fill('Sample was contaminated');
  await row.getByRole('form').getByRole('button', { name: 'Request cancellation' }).click();
  await expect(row).toContainText('Cancellation requested by AT · Alex Tester');
  await expect(row).toContainText('Requested');
});

test('T7: LAB stations see why lifecycle actions need a personal sign-in and are refused', async ({
  browser,
}) => {
  const setup = await browser.newPage();
  const code = unique('DEMO-LL');
  const typeId = await addTestType(setup, code);
  await signInAs(setup, 'at');
  const { programId, testRequestId } = await submittedProgram(setup.request, typeId);
  await setup.close();

  const station = await browser.newContext();
  const page = await station.newPage();
  try {
    await signInAsLabStation(page);
    await page.goto(`/lab-testing/programs/${programId}`);
    await expect(lifecycle(page)).toContainText(
      'Closing, reopening and cancelling need a personal sign-in',
    );
    await expect(page.getByRole('button', { name: 'Close program' })).toHaveCount(0);
    await expect(testRow(page, code).getByRole('button', { name: 'Cancel test' })).toHaveCount(0);
    for (const [path, data] of [
      [`/api/lab-programs/${programId}/close`, { version: 1 }],
      [`/api/lab-programs/${programId}/reopen`, { version: 1, reason: 'x' }],
      [`/api/lab-programs/${programId}/close-request`, { reason: 'x' }],
      [`/api/test-requests/${testRequestId}/cancel`, { version: 1, reason: 'x' }],
      [`/api/test-requests/${testRequestId}/cancel-request`, { reason: 'x' }],
      [`/api/lab-programs/${programId}/amend`, { version: 1, addTests: [] }],
    ] as const) {
      const response = await page.request.post(path, {
        headers: CSRF,
        data: { ...data, idempotencyKey: crypto.randomUUID(), actingStaffUserId: PAT },
      });
      expect(response.status(), path).toBe(403);
    }
  } finally {
    await station.close();
  }
});

test('MM-T72 T3: a repeat of a test whose depth was changed shows the changed depth', async ({
  page,
}) => {
  const code = unique('DEMO-RP');
  const typeId = await addTestType(page, code);
  await signInAs(page, 'pe');
  const hole = await page.request.post(`/api/projects/${DEMO_PROJECT_ID}/test-holes`, {
    headers: CSRF,
    data: { name: unique('TH') },
  });
  expect(hole.status()).toBe(201);
  const holeId = (await hole.json()).id as string;
  const draft = await page.request.post('/api/lab-programs', {
    headers: CSRF,
    data: {
      projectId: DEMO_PROJECT_ID,
      idempotencyKey: crypto.randomUUID(),
      lines: [
        {
          source: { kind: 'test_hole', id: holeId },
          scope: 'specific',
          testTypeIds: [typeId],
          sampleLabel: 'S3',
          depthMode: 'point',
          depthFrom: 1.5,
          depthUnit: 'm',
        },
      ],
    },
  });
  expect(draft.status(), await draft.text()).toBe(201);
  const created = await draft.json();
  const review = await (await page.request.get(`/api/lab-programs/${created.id}/review`)).json();
  const submitted = await page.request.post(`/api/lab-programs/${created.id}/submit`, {
    headers: CSRF,
    data: {
      version: created.version,
      idempotencyKey: crypto.randomUUID(),
      coverage: review.lines.map((l: { lineId: string }) => ({ lineId: l.lineId, unitIds: [] })),
    },
  });
  expect(submitted.status(), await submitted.text()).toBe(200);
  const program = await submitted.json();
  const id = program.lines[0].requests[0].id as string;

  const send = async (path: string, data: Record<string, unknown>, method = 'post') => {
    const response = await page.request.fetch(path, {
      method,
      headers: CSRF,
      data: { idempotencyKey: crypto.randomUUID(), ...data },
    });
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
    return (await response.json()) as { version: number };
  };
  /** Requested → Accepted, as the project's PM/PE. */
  const accept = async (start: number) => {
    let version = start;
    for (const to of ['in_progress', 'completed', 'review']) {
      version = (await send(`/api/test-requests/${id}/status`, { to, version })).version;
    }
    version = (await send(`/api/test-requests/${id}/review`, { action: 'complete', version }))
      .version;
    return (await send(`/api/test-requests/${id}/accept`, { version })).version;
  };
  let version = await accept(program.lines[0].requests[0].version as number);
  version = (
    await send(
      `/api/test-requests/${id}`,
      {
        reason: 'Field log corrected',
        identity: { sampleLabel: 'S3', depthMode: 'point', depthFrom: 2, depthUnit: 'm' },
        version,
      },
      'patch',
    )
  ).version;
  version = await accept(version);
  await send(`/api/test-requests/${id}/repeat`, { version });

  await page.goto(`/lab-testing/programs/${program.id}`);
  const repeatRow = testRow(page, code).filter({ hasText: 'Repeat of' });
  await expect(repeatRow).toContainText('Sample now S3 at 2 m');
  await expect(repeatRow).not.toContainText('1.5 m');
});
