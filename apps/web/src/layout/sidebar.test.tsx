import {
  DEFAULT_SIDEBAR_LAYOUT,
  normalizeSidebarLayout,
  type MeResponse,
  type SidebarLayout,
  type SidebarLayoutResponse,
  type SidebarRecord,
} from '@materialmule/shared';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@/components/ui/sidebar';
import { routes } from '../routes';
import { CommandMenuProvider } from '../search/command-menu';
import { PINS_CHANGED_EVENT } from '../projects/api';
import { SessionContext } from '../session/context';
import { AppSidebar } from './AppSidebar';
import { activeNavKey, sidebarNavFor } from './nav';
import { useRecordRecent } from './record-recent';
import {
  RECENTS_CHANGED_EVENT,
  SIDEBAR_COLLAPSED_KEY,
  apiPrefsSource,
  moveSection,
  toggleIn,
  useSidebarPrefs,
  type SidebarPrefsSource,
} from './sidebar-prefs';

// Strata sidebar (STRATA-8, 9, 11, 38, 39, 40, 42): the nav model, the layout adapter, and the
// sidebar itself (links, folds, Ctrl B, customize mode, phone Sheet). Fictional people only.

const ALL_ON = {
  labTesting: true,
  disposalRetention: true,
  concreteReview: true,
  concreteLab: true,
};
const ALL_OFF = {
  labTesting: false,
  disposalRetention: false,
  concreteReview: false,
  concreteLab: false,
};

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u1',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read'],
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

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('sidebarNavFor', () => {
  const labels = (who: MeResponse, features = ALL_ON) => {
    const nav = sidebarNavFor(who, features);
    return {
      top: nav.top.map((i) => `${i.label} ${i.to}`),
      sections: nav.sections.map((s) => [s.label, ...s.items.map((i) => i.label)]),
    };
  };

  it('Today, Projects, Inbox; then Storage units, Soils and Concrete with Overview', () => {
    const who = me({ roles: ['lab_technician'], permissions: ['notification.read'] });
    expect(labels(who)).toEqual({
      top: ['Today /', 'Projects /projects', 'Inbox /inbox'],
      sections: [
        ['Storage units', 'Receive', 'Inventory', 'Retention'],
        ['Soils', 'Lab programs', 'Workboard'],
        ['Concrete', 'Overview', 'Breaks', 'Receiving', 'Specimens', 'Holds', 'Review'],
      ],
    });
    const soils = sidebarNavFor(who, ALL_ON).sections[1]!.items;
    expect(soils.map((i) => i.to)).toEqual(['/lab-testing/programs', '/lab-testing']);
  });

  it('keeps the lab-staff gate and the feature flags; empty sections are left out', () => {
    expect(labels(me()).sections[2]).toEqual(['Concrete', 'Overview', 'Breaks', 'Holds', 'Review']);
    expect(labels(me({ accountType: 'shared_lab' })).sections[2]).toContain('Receiving');
    expect(labels(me(), ALL_OFF).sections).toEqual([['Storage units', 'Receive', 'Inventory']]);
  });

  it('Inbox: one row to /inbox with either permission, no sub-rows; or no Inbox', () => {
    for (const permissions of [
      ['notification.read', 'action_item.read'],
      ['notification.read'],
      ['action_item.read'],
    ]) {
      const inbox = sidebarNavFor(me({ permissions })).top.at(-1);
      expect(inbox).toMatchObject({ label: 'Inbox', to: '/inbox', children: [] });
    }
    // LAB has neither: no Inbox row.
    expect(sidebarNavFor(me({ accountType: 'shared_lab' })).top.map((i) => i.label)).toEqual([
      'Today',
      'Projects',
    ]);
  });

  it('activeNavKey separates Workboard from Lab programs and puts breaks under Concrete', () => {
    const cases: [string, ReturnType<typeof activeNavKey>][] = [
      ['/', 'today'],
      ['/projects/p1/team', 'projects'],
      ['/inbox', 'inbox'],
      ['/inbox/request%3Aa-1', 'inbox'],
      ['/notifications', 'inbox'],
      ['/action-requests', 'inbox'],
      ['/receiving-log/new', 'receive'],
      ['/labels/print/receipt/r1', 'receive'],
      ['/storage-units/BKT-2026-000001', 'inventory'],
      ['/disposal-retention/scan', 'retention'],
      ['/lab-testing', 'workboard'],
      ['/lab-testing/programs/x', 'lab-programs'],
      ['/lab-testing/concrete', 'breaks'],
      ['/lab-testing/concrete/holds', 'holds'],
      ['/concrete', 'concrete-overview'],
      ['/concrete/review/r1/issue', 'review'],
      ['/concrete/specimens/s1', 'specimens'],
      ['/settings/profile', 'settings'],
      ['/help', 'help'],
      ['/search', null],
    ];
    for (const [path, expected] of cases) expect(activeNavKey(path), path).toBe(expected);
  });
});

describe('sidebar layout adapter', () => {
  it('normalizes a saved layout: unknown and duplicate ids dropped, missing sections appended', () => {
    expect(
      normalizeSidebarLayout({
        order: ['concrete', 'nope', 'concrete', 'pinned'],
        hidden: ['soils', 'soils', 'x'],
        folded: ['retention'],
      }),
    ).toEqual({
      order: ['concrete', 'pinned', 'recent', 'storage_units', 'soils'],
      hidden: ['soils'],
      folded: ['retention'],
    });
    expect(normalizeSidebarLayout(null)).toEqual(DEFAULT_SIDEBAR_LAYOUT);
    expect(DEFAULT_SIDEBAR_LAYOUT.folded).toEqual(['recent', 'retention']);
  });

  it('moves a section among the visible ones, keeping others in place', () => {
    const layout = DEFAULT_SIDEBAR_LAYOUT;
    expect(moveSection(layout, 'pinned', 1).order.slice(0, 2)).toEqual(['recent', 'pinned']);
    expect(moveSection(layout, 'pinned', -1)).toBe(layout);
    // On a station Pinned and Recent aren't shown: Storage units moves past Soils only.
    const among = ['storage_units', 'soils', 'concrete'] as const;
    expect(moveSection(layout, 'storage_units', 1, among).order).toEqual([
      'pinned',
      'recent',
      'soils',
      'storage_units',
      'concrete',
    ]);
    expect(toggleIn(['recent'], 'soils', true)).toEqual(['recent', 'soils']);
  });

  function fakeSource(
    saved: SidebarLayout | null,
    save: SidebarPrefsSource['save'] = async () => null,
  ) {
    const source: SidebarPrefsSource = {
      load: async () => (saved ? { layout: saved, readOnly: false } : null),
      save,
      pins: async () => [],
      recents: async () => [],
      unpin: async () => undefined,
    };
    return source;
  }

  it('applies a change at once and keeps it, quietly, when the save cannot reach the server', async () => {
    let fail: (error: Error) => void = () => undefined;
    const save = vi.fn(
      () =>
        new Promise<SidebarLayout | null>((_, reject) => {
          fail = reject;
        }),
    );
    const source = fakeSource(null, save);
    const { result: prefs } = renderHook(() => useSidebarPrefs(source));
    act(() => prefs.current.update((l) => ({ ...l, hidden: ['concrete'] })));
    expect(prefs.current.layout.hidden).toEqual(['concrete']);
    await act(async () => fail(new TypeError('Failed to fetch')));
    expect(prefs.current.layout.hidden).toEqual(['concrete']);
  });

  it('takes the layout the server answers with (a conflict resolved there)', async () => {
    const merged: SidebarLayout = { ...DEFAULT_SIDEBAR_LAYOUT, hidden: ['soils', 'concrete'] };
    const source = fakeSource(null, async () => merged);
    const { result: prefs } = renderHook(() => useSidebarPrefs(source));
    act(() => prefs.current.update((l) => ({ ...l, hidden: ['concrete'] })));
    await waitFor(() => expect(prefs.current.layout.hidden).toEqual(['soils', 'concrete']));
  });

  it('a read-only layout (LAB) folds on screen and is never saved', async () => {
    const save = vi.fn(async () => null);
    const source: SidebarPrefsSource = {
      ...fakeSource(null, save),
      load: async () => ({ layout: DEFAULT_SIDEBAR_LAYOUT, readOnly: true }),
    };
    const { result: prefs } = renderHook(() => useSidebarPrefs(source));
    await waitFor(() => expect(prefs.current.readOnly).toBe(true));
    act(() => prefs.current.update((l) => ({ ...l, folded: ['soils'] })));
    expect(prefs.current.layout.folded).toEqual(['soils']);
    expect(save).not.toHaveBeenCalled();
  });

  it('Recent follows a record page as it is recorded', async () => {
    const source = fakeSource(null);
    const { result: prefs } = renderHook(() => useSidebarPrefs(source));
    await waitFor(() => expect(prefs.current.recents).toEqual([]));
    act(() => {
      window.dispatchEvent(new CustomEvent(RECENTS_CHANGED_EVENT, { detail: [PROJECT_RECORD] }));
    });
    expect(prefs.current.recents).toEqual([PROJECT_RECORD]);
  });

  it('Pinned follows a record page’s Pin button: the list it sends, without asking again', async () => {
    const pins = vi.fn(async () => [] as SidebarRecord[]);
    const source: SidebarPrefsSource = { ...fakeSource(null), pins };
    const { result: prefs } = renderHook(() => useSidebarPrefs(source));
    await waitFor(() => expect(prefs.current.pins).toEqual([]));
    act(() => {
      window.dispatchEvent(new CustomEvent(PINS_CHANGED_EVENT, { detail: [PROJECT_RECORD] }));
    });
    expect(prefs.current.pins).toEqual([PROJECT_RECORD]);
    expect(pins).toHaveBeenCalledTimes(1);
  });

  it('Pinned reads the list again when the pins-changed event carries none', async () => {
    const pins = vi
      .fn<() => Promise<SidebarRecord[] | null>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([PROJECT_RECORD]);
    const source: SidebarPrefsSource = { ...fakeSource(null), pins };
    const { result: prefs } = renderHook(() => useSidebarPrefs(source));
    await waitFor(() => expect(prefs.current.pins).toEqual([]));
    act(() => {
      window.dispatchEvent(new CustomEvent(PINS_CHANGED_EVENT));
    });
    await waitFor(() => expect(prefs.current.pins).toEqual([PROJECT_RECORD]));
    expect(pins).toHaveBeenCalledTimes(2);
  });

  it('stops listening for pin changes once the sidebar is gone', async () => {
    const pins = vi.fn(async () => [] as SidebarRecord[]);
    // One source for the whole test: a new object each render would read as a new person.
    const source: SidebarPrefsSource = { ...fakeSource(null), pins };
    const { result: prefs, unmount } = renderHook(() => useSidebarPrefs(source));
    await waitFor(() => expect(prefs.current.pins).toEqual([]));
    unmount();
    window.dispatchEvent(new CustomEvent(PINS_CHANGED_EVENT));
    expect(pins).toHaveBeenCalledTimes(1);
  });

  it('a new person gets their own layout, never the previous one', async () => {
    const first = fakeSource({ ...DEFAULT_SIDEBAR_LAYOUT, hidden: ['soils'] });
    const second = fakeSource(null);
    const { result, rerender } = renderHook(({ s }) => useSidebarPrefs(s), {
      initialProps: { s: first },
    });
    await waitFor(() => expect(result.current.layout.hidden).toEqual(['soils']));
    rerender({ s: second });
    expect(result.current.layout).toEqual(DEFAULT_SIDEBAR_LAYOUT);
  });
});

const PROJECT_RECORD: SidebarRecord = {
  kind: 'project',
  id: '00000000-0000-4000-8000-000000002601',
  available: true,
  label: 'DEMO-2601',
  name: 'Demo project',
  stage: 'storage',
  href: '/projects/00000000-0000-4000-8000-000000002601',
  at: '2026-11-12T16:00:00.000Z',
};
const GONE_RECORD: SidebarRecord = {
  kind: 'storage_unit',
  id: '00000000-0000-4000-8000-000000000014',
  available: false,
  label: null,
  name: null,
  stage: null,
  href: null,
  at: '2026-11-12T15:00:00.000Z',
};

const layoutResponse = (overrides: Partial<SidebarLayoutResponse> = {}): SidebarLayoutResponse => ({
  ...DEFAULT_SIDEBAR_LAYOUT,
  version: 3,
  source: 'own',
  readOnly: false,
  ...overrides,
});

type Call = { url: string; method: string; body: unknown };

/** fetch answering from `answer`, recording each call. */
function stubApi(answer: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

describe('server-backed sidebar source (STRATA-41, 11, 40)', () => {
  const personal = () => apiPrefsSource({ station: false, personId: null, records: true });

  it('loads the layout and saves a change with the version it read', async () => {
    const calls = stubApi(({ method, body }) =>
      method === 'PUT'
        ? json(200, { ...layoutResponse(body as Partial<SidebarLayoutResponse>), version: 4 })
        : json(200, layoutResponse({ hidden: ['soils'] })),
    );
    const source = personal();
    expect(await source.load()).toEqual({
      layout: { ...DEFAULT_SIDEBAR_LAYOUT, hidden: ['soils'] },
      readOnly: false,
    });
    const next = { ...DEFAULT_SIDEBAR_LAYOUT, hidden: [] };
    expect(await source.save(next, () => next)).toEqual(next);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/me/sidebar-layout',
      'PUT /api/me/sidebar-layout',
    ]);
    expect(calls[1]!.body).toEqual({ ...next, version: 3 });
    // The next save carries the version the last one returned.
    await source.save(next, () => next);
    expect(calls[2]!.body).toMatchObject({ version: 4 });
  });

  it('on 409 adopts the newer saved layout and reapplies the change once', async () => {
    const newer = layoutResponse({ version: 7, hidden: ['concrete'] });
    let puts = 0;
    const calls = stubApi(({ method, body }) => {
      if (method !== 'PUT') return json(200, layoutResponse());
      puts += 1;
      return puts === 1
        ? json(409, { code: 'version_conflict', current: newer })
        : json(200, { ...newer, ...(body as object), version: 8 });
    });
    const source = personal();
    await source.load();
    const fold = (l: SidebarLayout): SidebarLayout => ({ ...l, folded: [...l.folded, 'soils'] });
    const saved = await source.save(fold(DEFAULT_SIDEBAR_LAYOUT), fold);
    // Someone hid Concrete on another computer; this fold is applied on top of that.
    expect(saved).toEqual({
      ...DEFAULT_SIDEBAR_LAYOUT,
      hidden: ['concrete'],
      folded: ['recent', 'retention', 'soils'],
    });
    expect(calls[2]!.body).toMatchObject({ version: 7, hidden: ['concrete'] });
  });

  it('a second conflict takes the server layout as it stands', async () => {
    const newer = layoutResponse({ version: 9, hidden: ['soils'] });
    stubApi(({ method }) =>
      method === 'PUT'
        ? json(409, { code: 'version_conflict', current: newer })
        : json(200, layoutResponse()),
    );
    const source = personal();
    const saved = await source.save(DEFAULT_SIDEBAR_LAYOUT, (l) => ({ ...l, hidden: [] }));
    expect(saved).toEqual({ ...DEFAULT_SIDEBAR_LAYOUT, hidden: ['soils'] });
  });

  it('LAB reads the picked person read-only, never saves, never asks for pins or recents', async () => {
    const calls = stubApi(() =>
      json(200, layoutResponse({ source: 'station_person', readOnly: true })),
    );
    const source = apiPrefsSource({
      station: true,
      personId: '00000000-0000-4000-8000-0000000000aa',
      records: true,
    });
    expect((await source.load())?.readOnly).toBe(true);
    expect(await source.save(DEFAULT_SIDEBAR_LAYOUT, (l) => l)).toBeNull();
    expect(await source.pins()).toBeNull();
    expect(await source.recents()).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/me/sidebar-layout?personId=00000000-0000-4000-8000-0000000000aa',
    ]);
  });

  it('reads pins and recents; refused (403) means no section; unpin is a DELETE', async () => {
    const calls = stubApi(({ url, method }) => {
      if (url === '/api/me/pins' && method === 'GET') return json(200, { items: [GONE_RECORD] });
      if (url === '/api/me/recents') return json(403, { code: 'forbidden' });
      return json(200, { items: [] });
    });
    const source = personal();
    expect(await source.pins()).toEqual([GONE_RECORD]);
    expect(await source.recents()).toBeNull();
    await source.unpin('storage_unit', GONE_RECORD.id);
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `/api/me/pins/storage_unit/${GONE_RECORD.id}`,
    });
  });
});

describe('useRecordRecent (STRATA-40)', () => {
  function Page({ id }: { id: string | null }) {
    useRecordRecent('project', id);
    return null;
  }
  const renderPage = (who: MeResponse, id: string | null) =>
    render(
      <SessionContext.Provider
        value={{ session: { status: 'active', me: who }, refresh: vi.fn(), signOut: vi.fn() }}
      >
        <Page id={id} />
      </SessionContext.Provider>,
    );

  it('records the opened record and tells the sidebar', async () => {
    const calls = stubApi(() => json(200, { items: [PROJECT_RECORD] }));
    const heard = vi.fn();
    window.addEventListener(RECENTS_CHANGED_EVENT, heard);
    renderPage(me({ permissions: ['personal_settings.manage'] }), PROJECT_RECORD.id);
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    window.removeEventListener(RECENTS_CHANGED_EVENT, heard);
    expect(calls).toEqual([
      { url: '/api/me/recents', method: 'POST', body: { kind: 'project', id: PROJECT_RECORD.id } },
    ]);
  });

  it('never on the shared LAB account, and not before the record is loaded', () => {
    const calls = stubApi(() => json(200, { items: [] }));
    renderPage(
      me({ accountType: 'shared_lab', permissions: ['personal_settings.manage'] }),
      PROJECT_RECORD.id,
    );
    renderPage(me({ permissions: ['personal_settings.manage'] }), null);
    expect(calls).toEqual([]);
  });
});

/** The sidebar alone, in its providers, with an in-memory layout source. */
function SidebarHarness({ who, station = false }: { who: MeResponse; station?: boolean }) {
  const prefs = useSidebarPrefs(useStableSource(who.id));
  return <AppSidebar nav={sidebarNavFor(who, ALL_ON)} prefs={prefs} station={station} />;
}

interface MemorySource extends SidebarPrefsSource {
  saved: SidebarLayout[];
  unpinned: string[];
}

function memorySource(
  options: { pins?: SidebarRecord[] | null; readOnly?: boolean } = {},
): MemorySource {
  const source: MemorySource = {
    saved: [],
    unpinned: [],
    load: async () => ({ layout: DEFAULT_SIDEBAR_LAYOUT, readOnly: options.readOnly ?? false }),
    save: async (layout) => {
      source.saved.push(layout);
      return layout;
    },
    pins: async () => (options.pins === undefined ? [] : options.pins),
    recents: async () => [],
    unpin: async (kind, id) => {
      source.unpinned.push(`${kind}:${id}`);
    },
  };
  return source;
}

const sources = new Map<string, MemorySource>();
let nextSource: () => MemorySource = () => memorySource();
function useStableSource(id: string): MemorySource {
  if (!sources.has(id)) sources.set(id, nextSource());
  return sources.get(id)!;
}

function renderSidebar(
  who: MeResponse,
  path = '/',
  station = false,
  source: MemorySource = memorySource(),
) {
  sources.clear();
  nextSource = () => source;
  return render(
    <SessionContext.Provider
      value={{ session: { status: 'active', me: who }, refresh: vi.fn(), signOut: vi.fn() }}
    >
      <MemoryRouter initialEntries={[path]}>
        <CommandMenuProvider>
          <SidebarProvider>
            <SidebarHarness who={who} station={station} />
          </SidebarProvider>
        </CommandMenuProvider>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

describe('Strata sidebar', () => {
  it('rows are real links in nav "Main"; Retention opens by itself with its page current', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { status: 'ok', version: '1', database: 'up' })),
    );
    renderSidebar(me({ roles: ['lab_technician'] }), '/disposal-retention/scan');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Today' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Workboard' })).toHaveAttribute(
      'href',
      '/lab-testing',
    );
    expect(within(nav).getByRole('link', { name: 'Disposal scan' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('button', { name: 'Retention' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // Recent starts folded; Pinned is open and says how to pin.
    expect(within(nav).getByRole('button', { name: 'Recent' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(nav).getByText(/Nothing pinned yet/)).toBeInTheDocument();
    // The header: static logo (not a link), the lab, and the search field.
    expect(screen.queryByRole('link', { name: 'Material Mule' })).toBeNull();
    expect(screen.getByText('Receiving lab')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search or scan' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+K',
    );
  });

  it('a section heading folds its section and the fold is saved for the person', async () => {
    const user = userEvent.setup();
    renderSidebar(me());
    const heading = screen.getByRole('button', { name: 'Storage units' });
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    await user.click(heading);
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Inventory' })).toBeNull();
    expect(sources.get('u1')!.saved.at(-1)!.folded).toContain('storage_units');
  });

  it('a pinned record you can no longer open says No access and can be unpinned', async () => {
    const user = userEvent.setup();
    const source = memorySource({ pins: [PROJECT_RECORD, GONE_RECORD] });
    renderSidebar(me(), '/', false, source);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(await within(nav).findByRole('link', { name: /DEMO-2601/ })).toHaveAttribute(
      'href',
      PROJECT_RECORD.href,
    );
    expect(within(nav).getByText('No access')).toBeInTheDocument();
    await user.click(within(nav).getByRole('button', { name: 'Unpin record' }));
    expect(source.unpinned).toEqual([`storage_unit:${GONE_RECORD.id}`]);
    expect(within(nav).queryByText('No access')).toBeNull();
  });

  it('no Pinned section when the account keeps no pins (refused)', async () => {
    renderSidebar(me(), '/', false, memorySource({ pins: null }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Pinned' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Recent' })).toBeInTheDocument();
  });

  it('a read-only layout (LAB showing the picked person) hides Customize sidebar', async () => {
    renderSidebar(me({ accountType: 'shared_lab' }), '/', true, memorySource({ readOnly: true }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Customize sidebar' })).toBeNull(),
    );
  });

  it('LAB stations show no Pinned or Recent', () => {
    renderSidebar(me({ accountType: 'shared_lab' }), '/', true);
    expect(screen.queryByRole('button', { name: 'Pinned' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recent' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Concrete' })).toBeInTheDocument();
  });

  it('Customize: grips reorder with Space and arrows, Escape cancels, then leaves the mode', async () => {
    const user = userEvent.setup();
    renderSidebar(me());
    const row = screen.getByRole('button', { name: 'Customize sidebar' });
    await user.click(row);
    const editor = screen.getByRole('region', { name: 'Customize sidebar' });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    const fixed = within(editor).getByRole('list', { name: 'Fixed pages' });
    expect(
      within(fixed)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Locked:Today', 'Locked:Projects']);
    const order = () =>
      within(within(editor).getByRole('list', { name: 'Sidebar sections' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent);
    const pinnedGrip = within(editor).getByRole('button', { name: 'Move Pinned' });
    expect(pinnedGrip).toHaveFocus();

    await user.keyboard(' ');
    expect(pinnedGrip).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(order()).toEqual(['Recent', 'Storage units', 'Pinned', 'Soils', 'Concrete']);
    expect(editor).toHaveTextContent('Pinned is now at place 3 of 5.');
    await user.keyboard(' ');
    expect(editor).toHaveTextContent('Dropped Pinned at place 3 of 5.');

    // Pick up again and cancel: back where it was dropped.
    within(editor).getByRole('button', { name: 'Move Pinned' }).focus();
    await user.keyboard(' {ArrowUp}{Escape}');
    expect(order()[2]).toBe('Pinned');
    expect(editor).toHaveTextContent('Moving Pinned was cancelled.');

    // Hide Soils with its eye; Reset brings everything back.
    const eye = within(editor).getByRole('button', { name: 'Show Soils in the sidebar' });
    await user.click(eye);
    expect(eye).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(editor).getByRole('button', { name: 'Reset to default' }));
    expect(order()).toEqual(['Pinned', 'Recent', 'Storage units', 'Soils', 'Concrete']);

    await user.click(within(editor).getByRole('button', { name: 'Move Concrete up' }));
    expect(order().at(-1)).toBe('Soils');

    // Escape with nothing picked up leaves the mode and returns to the row.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Customize sidebar' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Customize sidebar' })).toHaveFocus(),
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const headings = within(nav)
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => ['Pinned', 'Recent', 'Storage units', 'Soils', 'Concrete'].includes(t!));
    expect(headings).toEqual(['Pinned', 'Recent', 'Storage units', 'Concrete', 'Soils']);
  });
});

/** Renders the real app at `path` (personal account) with stubbed API answers. */
function renderApp(path: string, who: MeResponse = me()) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/health'))
        return json(200, { status: 'ok', version: '1', database: 'up' });
      if (url.startsWith('/api/activity/recent')) return json(200, []);
      return json(404, {});
    }),
  );
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{ session: { status: 'active', me: who }, refresh: vi.fn(), signOut: vi.fn() }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return router;
}

const sidebarState = () =>
  document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state');

describe('Strata shell', () => {
  it('skip link first; top bar with the toggle and the page name; one main', async () => {
    renderApp('/');
    await screen.findByText('Nothing recorded in the last 24 hours.');
    const links = document.querySelectorAll('a[href], button');
    expect(links[0]).toHaveTextContent('Skip to content');
    const top = screen.getByRole('banner');
    expect(within(top).getByRole('button', { name: 'Toggle Sidebar' })).toBeInTheDocument();
    expect(within(top).getByText('Today')).toBeInTheDocument();
    // The page name is text: the page keeps its own (only) h1.
    expect(within(top).queryByRole('heading')).toBeNull();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    // No bell without notification.read.
    expect(within(top).queryByRole('link', { name: /Inbox|Notifications/ })).toBeNull();
  });

  it('Ctrl B collapses and expands, is ignored in a text field, and is remembered', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByText('Nothing recorded in the last 24 hours.');
    expect(sidebarState()).toBe('expanded');
    await user.keyboard('{Control>}b{/Control}');
    expect(sidebarState()).toBe('collapsed');
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('true');
    await user.keyboard('{Control>}b{/Control}');
    expect(sidebarState()).toBe('expanded');

    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    await user.keyboard('{Control>}b{/Control}');
    expect(sidebarState()).toBe('expanded');
    field.remove();
  });

  it('starts collapsed when this browser chose it', async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true');
    renderApp('/');
    await screen.findByText('Nothing recorded in the last 24 hours.');
    expect(sidebarState()).toBe('collapsed');
    // Collapsed, Retention opens its pages in a menu to the right.
    expect(screen.getByRole('button', { name: 'Retention pages' })).toHaveAttribute(
      'aria-haspopup',
      'menu',
    );
  });
});

describe('phone (under 768 px)', () => {
  /** matchMedia answering the phone queries, switchable like a turned phone. */
  function stubWidth(initial: number) {
    let width = initial;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => {
      const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity);
      return {
        get matches() {
          return width <= max;
        },
        media: query,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      };
    });
    return (next: number) => {
      width = next;
      act(() => listeners.forEach((fn) => fn()));
    };
  }

  it('the sidebar is a Sheet opened from the top bar; main is never remounted', async () => {
    const resize = stubWidth(412);
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByText('Nothing recorded in the last 24 hours.');
    const main = document.getElementById('main');
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Toggle Sidebar' }));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await user.click(within(nav).getByRole('link', { name: 'Projects' }));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull());
    resize(1300);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(document.getElementById('main')).toBe(main);
  });
});
