import {
  DEFAULT_USER_PREFERENCES,
  type MeResponse,
  type ProjectSummary,
  type TestHole,
} from '@materialmule/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';
import {
  chooseHolder,
  confirmAndPrint,
  confirmButton,
  installPointerCapture,
  rowAction,
} from './receive-test-utils';

// Receive samples on one page (STRATA-76, after MM-T10) and the done page (STRATA-77). Every
// project, person and hole here is fictional.

const PE = {
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Pat Example',
  initials: 'PE',
};
const AT = {
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
};
const project: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000901',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  leadProjectEngineer: PE,
};
const th1: TestHole = {
  id: '00000000-0000-4000-8000-000000000911',
  projectId: project.id,
  name: 'TH26-01',
};
const th2: TestHole = {
  id: '00000000-0000-4000-8000-000000000912',
  projectId: project.id,
  name: 'TH26-02',
};

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: AT.id,
  displayName: AT.displayName,
  initials: AT.initials,
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'project.create', 'test_hole.create', 'receipt.confirm'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (body: unknown) => Response | Promise<Response>;

function renderWizard(
  extra: Record<string, Handler> = {},
  session = me(),
  path = '/receiving-log/new',
) {
  pickStationPerson(session);
  const api: Record<string, Handler> = {
    'GET /api/projects/search': () => json(200, [project]),
    [`GET /api/projects/${project.id}/test-holes`]: () => json(200, [th1, th2]),
    ...extra,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = Object.keys(api)
      .filter((k) => {
        const [m, prefix] = k.split(' ');
        return m === method && url.startsWith(prefix!);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (key) return api[key]!(init?.body ? JSON.parse(String(init.body)) : undefined);
    if (url.startsWith('/api/staff/active')) return json(200, [AT, PE]);
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: session },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return { fetchMock, router };
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

beforeAll(installPointerCapture);

afterEach(() => {
  vi.unstubAllGlobals();
  setOnline(true);
});

type User = ReturnType<typeof userEvent.setup>;

async function chooseProject(user: User) {
  await user.type(await screen.findByRole('combobox', { name: /Find project/ }), 'river');
  await user.click(await screen.findByRole('option', { name: /DEMO-2601/ }));
}

async function addHole(user: User, unit: HTMLElement, name: string) {
  await user.type(within(unit).getByRole('combobox', { name: 'Find or add a test hole' }), name);
  await user.click(await within(unit).findByRole('option', { name }));
}

function holeGroup(unit: HTMLElement, hole: string) {
  return within(within(unit).getByRole('group', { name: `${hole} summary` }));
}

async function sampleRange(user: User, unit: HTMLElement, hole: string, from: string, to: string) {
  const group = holeGroup(unit, hole);
  await user.selectOptions(group.getByLabelText('Summary type'), 'sample_range');
  await user.type(group.getByLabelText('Sample from'), from);
  await user.type(group.getByLabelText('Sample to'), to);
}

const bucket = (n: number) => screen.getByRole('region', { name: `Bucket ${n}` });
const doneHeading = (count: number) =>
  screen.findByRole(
    'heading',
    { level: 1, name: count === 1 ? '1 storage unit received' : `${count} storage units received` },
    { timeout: 3000 },
  );

/** Each receipt its own ID: the done page sends a receipt's labels once per page load. */
let receipts = 0;

function issued(body: unknown, first = 1) {
  const units = (body as { units: { clientRowId: string }[] }).units;
  receipts += 1;
  return {
    receiptId: `00000000-0000-4000-8000-${String(980 + receipts).padStart(12, '0')}`,
    units: units.map((u, i) => ({
      clientRowId: u.clientRowId,
      storageUnitId: `00000000-0000-4000-8000-00000000099${i}`,
      suNumber: `BKT-2026-00000${i + first}`,
    })),
  };
}

function sentJob(status: 'sent' | 'failed' | 'uncertain' = 'sent') {
  return {
    id: 'job-1',
    kind: 'initial',
    printerId: 'receiving',
    printerName: 'Receiving bench',
    templateVersion: 'v1',
    status,
    attempts: 1,
    lastError: status === 'sent' ? null : 'No answer',
    printerMessage: null,
    requestedBy: { userId: AT.id, initials: AT.initials, name: AT.displayName },
    receiver: null,
    createdAt: '2026-11-12T16:00:00.000Z',
    updatedAt: '2026-11-12T16:00:00.000Z',
    sentAt: status === 'sent' ? '2026-11-12T16:00:01.000Z' : null,
    physicallyConfirmedAt: null,
    physicallyConfirmedBy: null,
    target: 'storage_unit',
    items: [
      {
        storageUnitId: '00000000-0000-4000-8000-000000000990',
        readableId: 'BKT-2026-000001',
        position: 1,
      },
    ],
    locations: [],
  };
}

describe('Receive samples on one page (STRATA-76)', () => {
  it('shows the draft header, project, unit rows, Received and the sticky bar; never an ID', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);

    expect(screen.getByRole('heading', { level: 1, name: 'Receive samples' })).toBeVisible();
    expect(screen.getByText('Draft')).toBeVisible();
    expect(screen.getByText(/Receiver: AT/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save draft and leave' })).toBeVisible();
    // No steps: the units are on the same page as the project.
    expect(screen.queryByRole('list', { name: 'Receiving steps' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Storage units' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Received' })).toBeVisible();
    const unit = bucket(1);
    expect(within(unit).getByRole('combobox', { name: 'Bucket 1 holder' })).toHaveTextContent(
      'Bucket',
    );
    const bar = screen.getByRole('region', { name: 'Confirm receipt' });
    expect(bar).toHaveTextContent('1 storage unit · IDs issue on confirm');
    expect(screen.queryByText(/BKT-\d{4}-\d{6}/)).toBeNull();

    // Trying to confirm with a bucket that has no test hole counts the problems in the bar.
    await user.click(confirmButton());
    expect(bar).toHaveTextContent('1 thing to fix before confirming');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await addHole(user, bucket(1), 'TH26-01');
    await sampleRange(user, bucket(1), 'TH26-01', 'G1', 'S12');
    expect(bar).toHaveTextContent('1 storage unit · IDs issue on confirm');

    // Confirm lists each unit with the prefix it will get, never a number.
    await user.click(confirmButton());
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Confirm receipt of 1 storage unit?',
    });
    const planned = within(dialog).getByRole('list', { name: 'IDs to be issued' });
    expect(within(planned).getByText('New BKT- ID')).toBeVisible();
    expect(within(planned).getByText('TH26-01')).toBeVisible();
    expect(within(dialog).queryByText(/BKT-\d{4}-\d{6}/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('AC1/AC2: two buckets, one holding two test holes, confirmed in one request', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    const prints: unknown[] = [];
    renderWizard({
      'POST /api/receipts': (body) => {
        posts.push(body);
        return json(201, issued(body));
      },
      'POST /api/print-jobs': (body) => {
        prints.push(body);
        return json(500, {});
      },
    });
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await sampleRange(user, bucket(1), 'TH26-01', 'G1', 'S12');
    await addHole(user, bucket(1), 'TH26-02');
    await user.selectOptions(holeGroup(bucket(1), 'TH26-02').getByLabelText('Summary type'), 'all');
    // The second hole is an "Also holds" line with its own summary.
    const lines = within(bucket(1)).getByRole('list', { name: 'Bucket 1 samples and depth' });
    expect(within(lines).getAllByRole('listitem')[1]).toHaveTextContent(/Also holds\s*TH26-02/);

    await user.click(screen.getByRole('button', { name: 'Add unit' }));
    await addHole(user, bucket(2), 'TH26-01');
    await sampleRange(user, bucket(2), 'TH26-01', 'G13', 'S32');
    expect(screen.getByRole('region', { name: 'Confirm receipt' })).toHaveTextContent(
      '2 storage units · IDs issue on confirm',
    );

    await confirmAndPrint(user);
    expect(await doneHeading(2)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'BKT-2026-000001' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'BKT-2026-000002' })).toBeInTheDocument();
    // Labels were sent on confirm; a failed print says the IDs are still issued, and Print
    // again becomes the primary.
    expect(
      await screen.findByText(/The IDs are issued, but the labels didn’t print/),
    ).toBeVisible();
    expect(prints).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Print again' })).toHaveAttribute(
      'data-variant',
      'default',
    );
    expect(screen.getByRole('link', { name: 'Put away' })).toHaveAttribute(
      'data-variant',
      'outline',
    );
    expect(screen.getAllByText('Not printed')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Open BKT-2026-000002' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000002',
    );

    expect(posts).toHaveLength(1);
    const sent = posts[0] as {
      description: string;
      units: { unitType: string; holeSummaries: unknown[] }[];
    };
    expect(sent.description).toBe('');
    expect(sent.units.map((u) => u.unitType)).toEqual(['bucket', 'bucket']);
    expect(sent.units[0]!.holeSummaries).toEqual([
      { testHoleId: th1.id, type: 'sample_range', note: '', sampleFrom: 'G1', sampleTo: 'S12' },
      { testHoleId: th2.id, type: 'all', note: '' },
    ]);

    // Print again reprints the same IDs without confirming again.
    await user.click(screen.getByRole('button', { name: 'Print again' }));
    expect(prints).toHaveLength(2);
    expect(posts).toHaveLength(1);

    // Receive more starts a new draft.
    await user.click(screen.getByRole('button', { name: 'Receive more' }));
    expect(screen.getByRole('combobox', { name: /Find project/ })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Received by' })).toHaveValue('AT · Alex Tester');
  });

  it('STRATA-77: labels sent: each ID says "Sent to printer" and Put away is the primary', async () => {
    const user = userEvent.setup();
    const { router } = renderWizard({
      'POST /api/receipts': (body) => json(201, issued(body)),
      'POST /api/print-jobs': () => json(201, sentJob('sent')),
    });
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await confirmAndPrint(user);
    expect(await doneHeading(1)).toBeVisible();
    expect(
      (await screen.findAllByText('Sent to printer', { selector: '[data-slot=badge]' })).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/^Printed$/)).toBeNull();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Stick each label on its unit' }),
    ).toBeVisible();
    const putAway = screen.getByRole('link', { name: 'Put away' });
    expect(putAway).toHaveAttribute('data-variant', 'default');
    expect(screen.getByRole('button', { name: 'Print all labels again' })).toBeEnabled();
    await user.click(putAway);
    expect(router.state.location.pathname).toBe('/sample-storage/move');
    expect(router.state.location.state).toEqual({ units: ['BKT-2026-000001'] });
  });

  it('STRATA-77: "Go straight to Put away" opens Put away once the labels are sent', async () => {
    const user = userEvent.setup();
    const { router } = renderWizard({
      'POST /api/receipts': (body) => json(201, issued(body)),
      'POST /api/print-jobs': () => json(201, sentJob('sent')),
      'GET /api/me/preferences': () =>
        json(200, {
          preferences: { ...DEFAULT_USER_PREFERENCES, afterReceipt: 'put_away' },
          version: 1,
          labTimeZone: 'America/Edmonton',
          readOnly: false,
        }),
    });
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await confirmAndPrint(user);
    await waitFor(() => expect(router.state.location.pathname).toBe('/sample-storage/move'));
    expect(router.state.location.state).toEqual({ units: ['BKT-2026-000001'] });
  });

  it('STRATA-77: "Go straight to Put away" stops on the done page when the print is uncertain', async () => {
    const user = userEvent.setup();
    const { router } = renderWizard({
      'POST /api/receipts': (body) => json(201, issued(body)),
      'POST /api/print-jobs': () => json(201, sentJob('uncertain')),
      'GET /api/me/preferences': () =>
        json(200, {
          preferences: { ...DEFAULT_USER_PREFERENCES, afterReceipt: 'put_away' },
          version: 1,
          labTimeZone: 'America/Edmonton',
          readOnly: false,
        }),
    });
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await confirmAndPrint(user);
    expect(await doneHeading(1)).toBeVisible();
    expect(await screen.findByText(/it isn’t known whether the labels printed/)).toBeVisible();
    expect(router.state.location.pathname).toBe('/receiving-log/new');
    expect(screen.getByRole('button', { name: 'Print again' })).toBeVisible();
  });

  it('AC3: a reversed depth range and a missing ft/m block Confirm with a linked error summary', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    const group = holeGroup(bucket(1), 'TH26-01');
    await user.selectOptions(group.getByLabelText('Summary type'), 'depth_range');
    await user.type(group.getByLabelText('Depth from'), '30');
    await user.type(group.getByLabelText('Depth to'), '0');
    await user.click(confirmButton());

    const summary = screen.getByRole('alert');
    expect(summary).toHaveFocus();
    expect(summary).toHaveTextContent('2 things to fix before confirming');
    expect(
      within(summary).getByRole('link', {
        name: 'Bucket 1 · TH26-01: Depth to must be greater than or equal to depth from.',
      }),
    ).toBeInTheDocument();
    expect(
      within(summary).getByRole('link', { name: 'Bucket 1 · TH26-01: Choose ft or m.' }),
    ).toBeInTheDocument();
    expect(group.getByLabelText('Depth to')).toHaveAttribute('aria-invalid', 'true');
    expect(group.getByRole('radiogroup', { name: 'Depth unit' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );

    await user.click(within(summary).getByRole('link', { name: /Depth to must be/ }));
    expect(group.getByLabelText('Depth to')).toHaveFocus();

    // Fixing both clears the summary.
    await user.clear(group.getByLabelText('Depth from'));
    await user.type(group.getByLabelText('Depth from'), '0');
    await user.clear(group.getByLabelText('Depth to'));
    await user.type(group.getByLabelText('Depth to'), '10.5');
    await user.click(group.getByRole('radio', { name: 'm' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('AC3: empty Custom text and a unit without a test hole are reported; Go to the first', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await user.selectOptions(
      holeGroup(bucket(1), 'TH26-01').getByLabelText('Summary type'),
      'custom',
    );
    expect(screen.getByText('State units if you describe depths.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add unit' }));
    await user.click(confirmButton());
    const summary = screen.getByRole('alert');
    expect(
      within(summary)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([
      'Bucket 1 · TH26-01: Describe the samples (Custom needs text).',
      'Bucket 2: Choose at least one test hole.',
    ]);
    await user.click(screen.getByRole('button', { name: 'Go to the first' }));
    expect(holeGroup(bucket(1), 'TH26-01').getByLabelText('Custom summary')).toHaveFocus();
  });

  it('MTR-133 / AC5: a missing project and a blank LAB receiver are reported on the one page', async () => {
    const user = userEvent.setup();
    renderWizard(
      {},
      me({ accountType: 'shared_lab', id: 'lab', displayName: 'LAB', initials: null }),
    );
    // T8/AC5: Received by starts blank on LAB; the Recording as person never fills it.
    expect(await screen.findByRole('combobox', { name: 'Received by' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /Find project/ })).toHaveAttribute(
      'aria-required',
      'true',
    );
    expect(screen.getByLabelText(/^Received date/)).toBeRequired();
    await user.click(confirmButton());
    const summary = screen.getByRole('alert');
    expect(summary).toHaveFocus();
    expect(
      within(summary).getByRole('link', { name: 'Choose who received the samples.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Find project/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('AC5: a personal account starts as itself; another receiver shows "Entered by …, for …"', async () => {
    const user = userEvent.setup();
    renderWizard({
      'GET /api/staff/receivers': () => json(200, [AT, PE]),
    });
    const receiver = await screen.findByRole('combobox', { name: 'Received by' });
    expect(receiver).toHaveValue('AT · Alex Tester');
    expect(screen.queryByText(/^Entered by/)).toBeNull();
    await user.clear(receiver);
    await user.type(receiver, 'PE');
    await user.click(await screen.findByRole('option', { name: /Pat Example/ }));
    expect(screen.getByText('Entered by Alex Tester, for Pat Example')).toBeVisible();
  });

  it('AC6: offline disables Confirm with the message and keeps every entry', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);
    await user.type(screen.getByLabelText('Description (optional)'), 'Two buckets');
    await addHole(user, bucket(1), 'TH26-01');
    const group = holeGroup(bucket(1), 'TH26-01');
    await user.selectOptions(group.getByLabelText('Summary type'), 'custom');
    await user.type(group.getByLabelText('Custom summary'), 'Grab samples, 0–2 m');
    await user.type(within(bucket(1)).getByLabelText('Bucket 1 note (optional)'), 'Lid cracked');

    setOnline(false);
    expect(
      screen.getByText("You're offline. Your draft is kept. Connect to confirm."),
    ).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('Two buckets');
    expect(within(bucket(1)).getByLabelText('Bucket 1 note (optional)')).toHaveValue('Lid cracked');
    setOnline(true);
    expect(confirmButton()).toBeEnabled();
  });

  it('retries a lost response automatically with the same idempotency key and body', async () => {
    const user = userEvent.setup();
    const bodies: string[] = [];
    renderWizard({
      'POST /api/receipts': (body) => {
        bodies.push(JSON.stringify(body));
        if (bodies.length === 1) throw new TypeError('Failed to fetch');
        return json(200, issued(body, 7));
      },
    });
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await confirmAndPrint(user);
    expect(screen.getByRole('button', { name: /Confirming/ })).toBeDisabled();
    expect(
      await screen.findByRole('heading', { name: 'BKT-2026-000007' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('an expired session keeps the draft and offers Sign in to confirm', async () => {
    const user = userEvent.setup();
    renderWizard({ 'POST /api/receipts': () => json(401, { code: 'unauthenticated' }) });
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await confirmAndPrint(user);
    expect(
      await screen.findByText('Your session has expired. Your draft is saved. Sign in to confirm.'),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'Confirm receipt' })).toHaveTextContent(
      '1 storage unit · Sign in again to confirm them',
    );
    expect(screen.getByRole('button', { name: 'Sign in to confirm' })).toBeVisible();
    expect(within(bucket(1)).getByRole('list', { name: 'Selected test holes' })).toHaveTextContent(
      'TH26-01',
    );
  });

  it('server field errors show next to the field', async () => {
    const user = userEvent.setup();
    renderWizard({
      'POST /api/receipts': () =>
        json(400, {
          code: 'validation_failed',
          errors: [
            {
              field: 'receiverUserId',
              code: 'receiver_not_active',
              message: 'must be an active staff member',
            },
          ],
        }),
    });
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await confirmAndPrint(user);
    const summary = await screen.findByRole('alert');
    expect(
      within(summary).getByRole('link', { name: 'Received by must be an active staff member.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Received by' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('holders: Shelby tube, Core box and Bulk bucket change the row and the ID prefix', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);
    await chooseHolder(user, 'Bucket 1', 'Core box');
    expect(screen.getByRole('region', { name: 'Core box 1' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '3 runs · 4.56 m' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Add unit' }));
    await chooseHolder(user, 'Bucket 2', 'Shelby tube');
    expect(screen.getByRole('region', { name: 'Shelby tube 2' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add unit' }));
    await chooseHolder(user, 'Bucket 3', 'Bulk bucket');
    expect(within(bucket(3)).getByText(/Each bucket gets its own BKT- ID/)).toBeInTheDocument();
    await user.click(confirmButton());
    // Problems first (no holes or sources yet); the holder choices themselves are kept.
    expect(screen.getByRole('alert', { name: /to fix before confirming/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Core box 1 holder' })).toHaveTextContent(
      'Core box',
    );
  });

  it('Enter on the last row adds a unit; Shift+Enter copies; Alt+N; remove moves focus back', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await sampleRange(user, bucket(1), 'TH26-01', 'G1', 'S4');
    // Enter on the last row adds a unit and goes to its test hole search; it never submits.
    await user.type(within(bucket(1)).getByLabelText('Bucket 1 note (optional)'), 'Heavy{Enter}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(
      within(bucket(2)).getByRole('combobox', { name: 'Find or add a test hole' }),
    ).toHaveFocus();

    // Enter on a row that isn't the last adds nothing.
    await user.type(within(bucket(1)).getByLabelText('Bucket 1 note (optional)'), '{Enter}');
    expect(screen.getAllByRole('region', { name: /^Bucket \d$/ })).toHaveLength(2);

    // Shift+Enter copies the row below it (same hole, next unit).
    await user.click(within(bucket(1)).getByLabelText('Sample from'));
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(screen.getAllByRole('region', { name: /^Bucket \d$/ })).toHaveLength(3);
    expect(within(bucket(2)).getByLabelText('Sample from')).toHaveValue('G1');
    expect(screen.getByRole('combobox', { name: 'Bucket 2 holder' })).toHaveFocus();

    await user.keyboard('{Alt>}n{/Alt}');
    expect(screen.getAllByRole('region', { name: /^Bucket \d$/ })).toHaveLength(4);

    await rowAction(user, 'Bucket 4', 'Remove Bucket 4');
    expect(screen.getAllByRole('region', { name: /^Bucket \d$/ })).toHaveLength(3);
    // MTR-136: focus goes to the unit before the removed one.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Bucket 3 holder' })).toHaveFocus(),
    );

    // Copy previous unit copies the last row.
    await user.click(screen.getByRole('button', { name: 'Copy previous unit' }));
    expect(screen.getAllByRole('region', { name: /^Bucket \d$/ })).toHaveLength(4);
  });

  it('?project=new opens Add project on a new draft (Quick actions › New project)', async () => {
    renderWizard({}, me(), '/receiving-log/new?project=new');
    const dialog = await screen.findByRole('dialog', { name: 'Add project' });
    expect(
      within(dialog).getByRole('option', { name: 'No nomination: leave it to an admin' }),
    ).toBeInTheDocument();
  });

  it('?new=1&projectId= fills that project in on a new draft (a project page link)', async () => {
    renderWizard(
      {
        [`GET /api/projects/${project.id}`]: () =>
          json(200, {
            ...project,
            serverFolderPath: null,
            version: 1,
            numberLocked: false,
            leadNomination: null,
            canEdit: false,
            canChangeLeadProjectEngineer: false,
            unitCount: 0,
            inStockUnitCount: 0,
            testHoles: [],
            receipts: [],
            receiptCount: 0,
          }),
      },
      me(),
      `/receiving-log/new?new=1&projectId=${project.id}`,
    );
    expect(await screen.findByLabelText('Project number')).toHaveValue('DEMO-2601');
    expect(screen.getByLabelText('Project name')).toHaveValue('Riverbank investigation');
  });

  it('?projectId= of a project that is not found leaves the project blank with a note', async () => {
    renderWizard(
      { [`GET /api/projects/${project.id}`]: () => json(404, { code: 'not_found' }) },
      me(),
      `/receiving-log/new?new=1&projectId=${project.id}`,
    );
    expect(
      await screen.findByText("That project wasn't found. Choose a project below."),
    ).toBeVisible();
    expect(screen.getByRole('combobox', { name: /Find project/ })).toHaveValue('');
  });

  it('?projectId= without permission to receive leaves the project blank with a note', async () => {
    renderWizard(
      {},
      me({ permissions: ['inventory.read'] }),
      `/receiving-log/new?new=1&projectId=${project.id}`,
    );
    expect(
      await screen.findByText(
        "You can't receive samples for that project. Choose a project below.",
      ),
    ).toBeVisible();
  });

  it('projects or test holes that cannot load: rows stay editable and Try again reloads', async () => {
    const user = userEvent.setup();
    let holeCalls = 0;
    renderWizard({
      [`GET /api/projects/${project.id}/test-holes`]: () => {
        holeCalls += 1;
        return holeCalls === 1 ? json(500, {}) : json(200, [th1, th2]);
      },
    });
    await chooseProject(user);
    expect(
      await screen.findByText('Test holes couldn’t load.', { selector: '[data-slot=alert-title]' }),
    ).toBeVisible();
    await user.type(within(bucket(1)).getByLabelText('Bucket 1 note (optional)'), 'Still typing');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await addHole(user, bucket(1), 'TH26-01');
    expect(within(bucket(1)).getByLabelText('Bucket 1 note (optional)')).toHaveValue(
      'Still typing',
    );
  });

  describe('MM-T66 UI-05/UI-06: keyboard flow for test holes', () => {
    const search = (unit: HTMLElement) =>
      within(unit).getByRole('combobox', { name: 'Find or add a test hole' });

    it('Alt+N still works after Enter has left the test hole search', async () => {
      const user = userEvent.setup();
      renderWizard();
      await chooseProject(user);
      await user.type(search(bucket(1)), 'TH26-01');
      await within(bucket(1)).findByRole('option', { name: 'TH26-01' });
      await user.keyboard('{Enter}');
      expect(document.activeElement).toBe(document.body);
      await user.keyboard('{Alt>}n{/Alt}');
      expect(search(bucket(2))).toHaveFocus();
    });

    it('Enter on an existing hole selects it, closes the list and leaves the search box', async () => {
      const user = userEvent.setup();
      renderWizard();
      await chooseProject(user);
      await user.type(search(bucket(1)), 'TH26-01');
      await within(bucket(1)).findByRole('option', { name: 'TH26-01' });
      await user.keyboard('{Enter}');
      expect(
        within(bucket(1)).getByRole('list', { name: 'Selected test holes' }),
      ).toHaveTextContent('TH26-01');
      expect(search(bucket(1))).not.toHaveFocus();
      expect(search(bucket(1))).toHaveAttribute('aria-expanded', 'false');
      // Enter in the picker never adds a unit or submits.
      expect(screen.getAllByRole('region', { name: /^Bucket \d$/ })).toHaveLength(1);
    });

    it('Enter on "Add …" creates the hole, selects it and leaves the search box', async () => {
      const user = userEvent.setup();
      const th3: TestHole = { id: 'th3', projectId: project.id, name: 'TH26-03' };
      renderWizard({
        [`POST /api/projects/${project.id}/test-holes`]: () => json(201, th3),
      });
      await chooseProject(user);
      await user.type(search(bucket(1)), 'TH26-03');
      await within(bucket(1)).findByRole('option', { name: 'Add TH26-03' });
      await user.keyboard('{Enter}');
      await vi.waitFor(() =>
        expect(
          within(bucket(1)).getByRole('list', { name: 'Selected test holes' }),
        ).toHaveTextContent('TH26-03'),
      );
      expect(search(bucket(1))).not.toHaveFocus();
    });

    it('a failed add keeps the search box focused with the error', async () => {
      const user = userEvent.setup();
      renderWizard({
        [`POST /api/projects/${project.id}/test-holes`]: () => {
          throw new TypeError('Failed to fetch');
        },
      });
      await chooseProject(user);
      await user.type(search(bucket(1)), 'TH26-04');
      await within(bucket(1)).findByRole('option', { name: 'Add TH26-04' });
      await user.keyboard('{Enter}');
      expect(
        await within(bucket(1)).findByText(
          "The test hole couldn't be saved. Check the connection.",
        ),
      ).toBeInTheDocument();
      expect(search(bucket(1))).toHaveFocus();
      expect(search(bucket(1))).toHaveValue('TH26-04');
    });
  });
});
