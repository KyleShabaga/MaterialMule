import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { withDatabase } from './db';

// Shared steps for the MM-T18 critical-path suite: the receiving wizard driven like a person
// would, and a receipt confirmed straight through the API (as the signed-in page) when a test is
// about what happens to units afterwards. Fictional data only: DEMO-2601, TH26-01/02, AT.

export const DEMO = {
  projectId: '00000000-0000-4000-8000-000000000201',
  th01: '00000000-0000-4000-8000-000000000301',
  th02: '00000000-0000-4000-8000-000000000302',
  at: '00000000-0000-4000-8000-000000000102',
  jordanSmith: '00000000-0000-4000-8000-000000000106',
  jamieSong: '00000000-0000-4000-8000-000000000107',
};

const CSRF = { 'x-materialmule-csrf': '1' };
export const BKT_ID = /^BKT-\d{4}-\d{6}$/;

/** A per-test marker (e.g. in a receipt description) so parallel runs never see each other. */
export function uniqueTag(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export const bucket = (page: Page, n: number) => page.getByRole('region', { name: `Bucket ${n}` });

export async function openWizard(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Receive samples' }).click();
  await expect(page.getByRole('heading', { name: 'Receive samples' })).toBeVisible();
}

export async function chooseProject(page: Page, search: string, option: string) {
  await page.getByRole('combobox', { name: /Find project/ }).fill(search);
  await page.getByRole('option', { name: option }).click();
}

export async function chooseDemoProject(page: Page) {
  await chooseProject(page, 'DEMO-2601', 'DEMO-2601 · Riverbank investigation · Example Client');
  await expect(page.getByLabel('Project number')).toHaveValue('DEMO-2601');
}

export async function addHole(unit: Locator, name: string) {
  await unit.getByRole('combobox', { name: 'Find or add a test hole' }).fill(name);
  await unit.getByRole('option', { name, exact: true }).click();
}

export function summaryOf(unit: Locator, hole: string) {
  return unit.getByRole('group', { name: `${hole} summary` });
}

export async function sampleRange(unit: Locator, hole: string, from: string, to: string) {
  const group = summaryOf(unit, hole);
  await group.getByLabel('Summary type').selectOption('sample_range');
  await group.getByLabel('Sample from').fill(from);
  await group.getByLabel('Sample to').fill(to);
}

export async function chooseReceiver(page: Page, search: string, option: string | RegExp) {
  const receiver = page.getByRole('combobox', { name: 'Received by', exact: true });
  await receiver.fill(search);
  await page.getByRole('option', { name: option }).click();
}

/** Issued storage unit IDs on the labels step, in unit order. */
export async function issuedIds(page: Page): Promise<string[]> {
  const list = page.getByRole('list', { name: 'New storage units' });
  // Confirmation retries a lost answer after 0.5 s, 1.5 s and 3 s (MM-T10), so allow for them.
  await expect(list).toBeVisible({ timeout: 15_000 });
  const ids = await list.getByRole('heading').allTextContents();
  for (const id of ids) expect(id).toMatch(BKT_ID);
  return ids;
}

export interface ReceiptRow {
  receipt_id: string;
  idempotency_key: string;
  quantity: number;
  account_user_id: string;
  receiver_user_id: string;
  receiver_initials_snapshot: string;
  readable_ids: string[];
  locations: string[];
  project_number: string;
}

/** Every receipt whose description is `description`, with its units' IDs and locations. */
export async function receiptsDescribed(description: string): Promise<ReceiptRow[]> {
  return withDatabase(async (client) => {
    const { rows } = await client.query<ReceiptRow>(
      `SELECT r.id AS receipt_id, r.idempotency_key, r.quantity, r.account_user_id,
              r.receiver_user_id, r.receiver_initials_snapshot, p.project_number,
              coalesce(array_agg(su.readable_id ORDER BY su.receipt_line)
                         FILTER (WHERE su.id IS NOT NULL), '{}') AS readable_ids,
              coalesce(array_agg(l.code ORDER BY su.receipt_line)
                         FILTER (WHERE su.id IS NOT NULL), '{}') AS locations
       FROM receipt r
       JOIN project p ON p.id = r.project_id
       LEFT JOIN storage_unit su ON su.receipt_id = r.id
       LEFT JOIN location l ON l.id = su.current_location_id
       WHERE r.description = $1
       GROUP BY r.id, p.project_number`,
      [description],
    );
    return rows;
  });
}

export interface ApiReceiptOptions {
  projectId?: string;
  holeIds?: string[];
  units?: number;
  description?: string;
  receivedDate?: string;
  receiverUserId?: string;
}

/** Confirms a receipt through POST /api/receipts as the page's signed-in account. */
export async function receiveThroughApi(
  page: Page,
  options: ApiReceiptOptions = {},
): Promise<{ storageUnitId: string; suNumber: string }[]> {
  const holeIds = options.holeIds ?? [DEMO.th01];
  const response = await page.request.post('/api/receipts', {
    headers: CSRF,
    data: {
      idempotencyKey: randomUUID(),
      projectId: options.projectId ?? DEMO.projectId,
      receivedDate: options.receivedDate ?? '2026-10-20',
      receiverUserId: options.receiverUserId ?? DEMO.at,
      description: options.description ?? null,
      units: Array.from({ length: options.units ?? 1 }, (_, i) => ({
        clientRowId: `row-${i + 1}`,
        unitType: 'bucket',
        holeSummaries: holeIds.map((testHoleId) => ({ testHoleId, type: 'all' })),
      })),
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as {
    units: { storageUnitId: string; suNumber: string }[];
  };
  return body.units;
}

/** Creates a fictional project (Lead Project Engineer Pat Example) with one test hole through the API. */
export async function createProjectThroughApi(
  page: Page,
  projectNumber: string,
  holeName: string,
): Promise<{ projectId: string; holeId: string }> {
  const project = await page.request.post('/api/projects', {
    headers: CSRF,
    data: {
      projectNumber,
      name: 'Example Ridge',
      client: 'Example Client',
      leadProjectEngineerUserId: '00000000-0000-4000-8000-000000000101',
    },
  });
  expect(project.status()).toBe(201);
  const projectId = ((await project.json()) as { id: string }).id;
  const hole = await page.request.post(`/api/projects/${projectId}/test-holes`, {
    headers: CSRF,
    data: { name: holeName },
  });
  expect(hole.status()).toBe(201);
  return { projectId, holeId: ((await hole.json()) as { id: string }).id };
}

/** The columns of a storage unit that printing, scanning and refused changes must not touch. */
export async function unitState(readableIds: string[]) {
  return withDatabase(async (client) => {
    const { rows } = await client.query(
      `SELECT su.readable_id, su.receipt_id, su.project_id, su.current_location_id, su.status,
              su.received_date::text, su.version, su.updated_at
       FROM storage_unit su WHERE su.readable_id = ANY($1) ORDER BY su.readable_id`,
      [readableIds],
    );
    return rows;
  });
}
