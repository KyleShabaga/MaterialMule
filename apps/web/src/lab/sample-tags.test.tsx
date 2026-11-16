import type { MeResponse, SampleTag, SampleTagSheet } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// Sample ID tag sheets (MM-T69). Fictional data only (DEMO-2601, TH26-01).

const me: MeResponse = {
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'lab_program.read'],
  sessionExpiresAt: '2026-10-28T06:00:00.000Z',
  profileRefreshFailed: false,
};

const PROGRAM = '00000000-0000-4000-8000-0000000000f1';

function tag(
  key: string,
  sampleLabel: string,
  tests: [string, SampleTag['tests'][number]['status']][],
) {
  return {
    key,
    lineNumbers: [1],
    source: { kind: 'test_hole', id: 'hole', label: 'TH26-01' },
    sampleLabel,
    depth: '10.0 m',
    tagGroup: null,
    tests: tests.map(([name, status], i) => ({
      requestId: `${key}-r${i}`,
      testTypeId: `t-${name}`,
      code: name.toUpperCase(),
      name,
      status,
    })),
    pending: tests.some(([, status]) => status === 'requested' || status === 'in_progress'),
  } satisfies SampleTag;
}

const sheet: SampleTagSheet = {
  program: {
    id: PROGRAM,
    programNumber: 'LP-2026-0012',
    status: 'submitted',
    project: { id: 'p', projectNumber: 'DEMO-2601', name: 'Riverbank investigation' },
  },
  tags: [
    tag('a', 'G13', [['Atterberg Limits', 'requested']]),
    tag('b', 'G13', [
      ['Sieve', 'requested'],
      ['Hydrometer', 'requested'],
    ]),
    tag('c', 'G5', [['Atterberg Limits', 'accepted']]),
  ],
  noTagTests: [
    {
      lineNumber: 1,
      sampleLabel: 'G13',
      depth: '10.0 m',
      test: {
        requestId: 'mc',
        testTypeId: 't-mc',
        code: 'MC',
        name: 'Moisture Content',
        status: 'requested',
      },
    },
  ],
  untaggedLines: [
    {
      lineNumber: 2,
      scope: 'all',
      sourceLabel: 'TH26-02',
      tests: [
        {
          requestId: 'x',
          testTypeId: 't',
          code: 'ATT',
          name: 'Atterberg Limits',
          status: 'requested',
        },
      ],
    },
  ],
};

function renderTags(response: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input).endsWith('/sample-tags') ? response() : new Response('{}', { status: 404 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, {
    initialEntries: [`/lab-testing/programs/${PROGRAM}/tags`],
  });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

const ok = () =>
  new Response(JSON.stringify(sheet), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Radix Select measures pointer capture, which jsdom lacks.
if (typeof Element !== 'undefined') {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
}

/** The print sheets (off screen, aria-hidden): what the printer gets. */
const printSheets = () => [...document.querySelectorAll<HTMLElement>('.tag-preview .tag-sheet')];

describe('sample ID tags (MM-T69, STRATA-89)', () => {
  it('selects tags with work still to do and lists what gets no tag', async () => {
    const fetchMock = renderTags(ok);
    expect(
      await screen.findByRole('heading', { name: 'Print sample ID tags', level: 1 }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'LP-2026-0012' })).toHaveAttribute(
      'href',
      `/lab-testing/programs/${PROGRAM}`,
    );
    const list = screen.getByRole('list', { name: 'Tags to print' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    const boxes = within(list).getAllByRole('checkbox', { name: /G13|G5/ });
    expect(boxes.map((box) => box.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false']);
    expect(screen.getByText('2 of 3 tags selected · 1 sheet')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Print 2 tags' })).toBeEnabled();
    // Field Ledger: both "no tag" cases are always listed, under their own headings.
    expect(screen.getByRole('heading', { name: 'No tag needed' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'No individual sample' })).toBeVisible();
    expect(screen.getByText(/G13 · 10.0 m: Moisture Content/)).toBeVisible();
    expect(screen.getByText(/Line 2 · ALL · TH26-02: Atterberg Limits/)).toBeVisible();
    // Reading tags only ever GETs.
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });

  it('previews one card at true size with its place on the sheet', async () => {
    const user = userEvent.setup();
    renderTags(ok);
    const preview = await screen.findByRole('complementary', { name: 'Preview' });
    expect(
      within(preview).getByLabelText(/Tag G13 at 10.0 m, TH26-01: Atterberg Limits$/),
    ).toBeVisible();
    expect(within(preview).getByText('1 of 2')).toBeVisible();
    expect(
      within(preview).getByRole('img', {
        name: 'Sheet 1 of 1: 2 tags on cards 1 to 2; this tag is card 1',
      }),
    ).toBeVisible();
    await user.click(within(preview).getByRole('button', { name: 'Next tag' }));
    expect(
      within(preview).getByLabelText(/Tag G13 at 10.0 m, TH26-01: Sieve, Hydrometer$/),
    ).toBeVisible();
    expect(within(preview).getByRole('button', { name: 'Next tag' })).toBeDisabled();
    // The printed card is black on white whatever the theme.
    expect(preview.querySelector('[data-slot="tag-card-frame"]')).toHaveClass(
      'bg-white',
      'text-black',
    );
  });

  it('splits a shared tag, never merging, and starts on a chosen card', async () => {
    const user = userEvent.setup();
    renderTags(ok);
    await user.click(await screen.findByRole('button', { name: 'Split into 2 tags' }));
    expect(screen.getByText('3 of 4 tags selected · 1 sheet')).toBeVisible();
    await user.click(screen.getByRole('combobox', { name: 'Start at card' }));
    await user.click(await screen.findByRole('option', { name: 'Card 9' }));
    expect(screen.getByText('3 of 4 tags selected · 2 sheets')).toBeVisible();
    // The sheets that print: card 9 and 10 of sheet 1, then sheet 2.
    const sheets = printSheets();
    expect(sheets.map((sheet) => sheet.dataset.sheet)).toEqual(['1 of 2', '2 of 2']);
    expect(sheets[0]!.querySelectorAll('.tag-slot-blank')).toHaveLength(8);
    expect(
      within(sheets[0]!).getByLabelText(/Tag G13 at 10.0 m, TH26-01: Atterberg Limits/),
    ).toBeInTheDocument();
    expect(within(sheets[1]!).getByText(/Sheet 2 of 2$/)).toBeInTheDocument();
    expect(document.querySelector('.tag-preview')).toHaveAttribute('aria-hidden', 'true');
  });

  it('explains that a draft has no tags yet', async () => {
    renderTags(
      () =>
        new Response(JSON.stringify({ code: 'program_not_submitted' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(
      await screen.findByText('Sample ID tags are available once the program is submitted.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Continue editing' })).toHaveAttribute(
      'href',
      `/lab-testing/programs/${PROGRAM}`,
    );
    expect(screen.queryByRole('button', { name: /^Print/ })).toBeNull();
  });

  it('says when no test needs a tag, and offers Try again after a failure', async () => {
    renderTags(
      () =>
        new Response(JSON.stringify({ ...sheet, tags: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(await screen.findByText('No test in this program needs a sample ID tag.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'No tag needed' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Print/ })).toBeNull();
  });

  it('offers Try again when the tags could not be loaded', async () => {
    let fail = true;
    const user = userEvent.setup();
    renderTags(() => (fail ? new Response('{}', { status: 500 }) : ok()));
    expect(await screen.findByText('The tags couldn’t be loaded.')).toBeVisible();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Print 2 tags' })).toBeEnabled();
  });
});

describe('sample ID tag date at print time (review fix, PR #103)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The Date: value on every card in the preview, as the print layout would see it. */
  const cardDates = () =>
    [...document.querySelectorAll('.tag-preview .tag-card')].map(
      (card) =>
        [...card.querySelectorAll('.tag-field')]
          .find((field) => field.textContent?.startsWith('Date:'))
          ?.querySelector('.tag-value')?.textContent,
    );

  async function openBeforeMidnight() {
    // 23:59 on 26 Oct 2026 in America/Edmonton (MDT, UTC−6). Only Date is faked: timers stay
    // real so the page loads normally.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T05:59:00Z'));
    renderTags(ok);
    await screen.findByRole('button', { name: 'Print 2 tags' });
    expect(cardDates().length).toBeGreaterThan(0);
    expect(new Set(cardDates())).toEqual(new Set(['26-Oct-26']));
    // The tab stays open past midnight.
    vi.setSystemTime(new Date('2026-10-27T06:01:00Z'));
  }

  it("prints today's date from the page button after midnight", async () => {
    const user = userEvent.setup();
    await openBeforeMidnight();
    const printed: (string | null | undefined)[][] = [];
    vi.stubGlobal('print', () => printed.push(cardDates()));
    await user.click(screen.getByRole('button', { name: 'Print 2 tags' }));
    expect(printed).toEqual([cardDates()]);
    expect(new Set(printed[0])).toEqual(new Set(['27-Oct-26']));
  });

  it("prints today's date from the browser's print command after midnight", async () => {
    await openBeforeMidnight();
    // A listener added after the page's runs after it, like the browser's print layout.
    let seen: (string | null | undefined)[] = [];
    window.addEventListener('beforeprint', () => (seen = cardDates()), { once: true });
    window.dispatchEvent(new Event('beforeprint'));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['27-Oct-26']));
  });
});
