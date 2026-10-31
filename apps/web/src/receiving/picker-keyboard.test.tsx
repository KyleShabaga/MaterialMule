import type { ProjectSummary, ReceiverOption, TestHole } from '@materialmule/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchProjects } from '../api/projects';
import { ReceiverSelect } from '../components/ReceiverSelect';
import { ProjectPicker } from './ProjectPicker';
import { TestHolePicker } from './TestHolePicker';

// MM-T62 T1: every receiving picker answers the keyboard the same way. After typing, the first
// match is highlighted: Enter picks it, ArrowDown+Enter the second, ArrowUp from the first wraps
// to the last option. Fictional data only.

const PE = { id: 'u-pe', displayName: 'Pat Example', initials: 'PE' };
const PROJECTS: ProjectSummary[] = [
  {
    id: 'p1',
    projectNumber: 'DEMO-2601',
    name: 'Riverbank investigation',
    client: 'Example Client',
    leadProjectEngineer: PE,
  },
  {
    id: 'p2',
    projectNumber: 'DEMO-2602',
    name: 'Hillside bridge',
    client: 'Example Client',
    leadProjectEngineer: PE,
  },
  {
    id: 'p3',
    projectNumber: 'DEMO-2603',
    name: 'Old Mill Road',
    client: 'Example Client',
    leadProjectEngineer: PE,
  },
];
const HOLES: TestHole[] = ['TH26-01', 'TH26-02', 'TH26-03'].map((name, index) => ({
  id: `h${index + 1}`,
  projectId: 'p1',
  name,
}));
const RECEIVERS: ReceiverOption[] = [
  { id: 'r-at', initials: 'AT', displayName: 'Alex Tester' },
  { id: 'r-ad', initials: 'AD', displayName: 'Avery Demo' },
  { id: 'r-al', initials: 'AL', displayName: 'Ash Lab' },
];

vi.mock('../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/projects')>()),
  searchProjects: vi.fn(async () => PROJECTS),
  listTestHoles: vi.fn(async () => HOLES),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function ProjectHarness({ onSelect }: { onSelect: (project: ProjectSummary | null) => void }) {
  const [query, setQuery] = useState('');
  const [value, setValue] = useState<ProjectSummary | null>(null);
  return (
    <ProjectPicker
      value={value}
      query={query}
      onQueryChange={setQuery}
      onSelect={(project) => {
        setValue(project);
        onSelect(project);
      }}
      staff={[]}
      receiverUserId={null}
      online
    />
  );
}

function HoleHarness({ onChange }: { onChange: (holes: TestHole[]) => void }) {
  const [query, setQuery] = useState('');
  return (
    <TestHolePicker
      projectId="p1"
      selected={[]}
      onChange={onChange}
      query={query}
      onQueryChange={setQuery}
      receiverUserId={null}
      online
    />
  );
}

function stubReceivers() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(RECEIVERS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

/** Each picker: render it, type a query and wait for its three options. */
const PICKERS = [
  {
    name: 'Received by',
    async open(user: ReturnType<typeof userEvent.setup>) {
      stubReceivers();
      const picked = vi.fn();
      render(<ReceiverSelect value={null} onChange={picked} />);
      await user.type(screen.getByRole('combobox', { name: /Received by/ }), 'A');
      await screen.findByRole('option', { name: /Ash Lab/ });
      return () => (picked.mock.lastCall?.[0] as ReceiverOption | undefined)?.id;
    },
    ids: ['r-at', 'r-ad', 'r-al'],
  },
  {
    name: 'project',
    async open(user: ReturnType<typeof userEvent.setup>) {
      const picked = vi.fn();
      render(<ProjectHarness onSelect={picked} />);
      await user.type(screen.getByRole('combobox', { name: /Find project/ }), 'DEMO');
      await screen.findByRole('option', { name: /DEMO-2603/ });
      return () => (picked.mock.lastCall?.[0] as ProjectSummary | undefined)?.id;
    },
    ids: ['p1', 'p2', 'p3'],
  },
  {
    name: 'test hole',
    async open(user: ReturnType<typeof userEvent.setup>) {
      const picked = vi.fn();
      render(<HoleHarness onChange={picked} />);
      await user.type(screen.getByRole('combobox', { name: 'Find or add a test hole' }), 'TH26');
      await screen.findByRole('option', { name: 'TH26-03' });
      return () => (picked.mock.lastCall?.[0] as TestHole[] | undefined)?.[0]?.id;
    },
    ids: ['h1', 'h2', 'h3'],
  },
];

describe.each(PICKERS)('$name picker keyboard (MM-T62)', ({ open, ids }) => {
  it('highlights the first match and announces it before Enter', async () => {
    const user = userEvent.setup();
    await open(user);
    const input = screen.getByRole('combobox');
    const first = screen.getAllByRole('option')[0]!;
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', first.id);
  });

  it('Enter picks the first match', async () => {
    const user = userEvent.setup();
    const picked = await open(user);
    await user.keyboard('{Enter}');
    expect(picked()).toBe(ids[0]);
  });

  it('ArrowDown+Enter picks the second match', async () => {
    const user = userEvent.setup();
    const picked = await open(user);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(picked()).toBe(ids[1]);
  });

  it('ArrowUp from the first match wraps to the last option', async () => {
    const user = userEvent.setup();
    await open(user);
    await user.keyboard('{ArrowUp}');
    const options = screen.getAllByRole('option');
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-activedescendant',
      options.at(-1)!.id,
    );
  });
});

it('MM-T62 AC3: in Received by, "AT" + Enter records AT · Alex Tester', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify([RECEIVERS[0], { ...PE, id: 'r-pe', position: 'engineer' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  const picked = vi.fn();
  const user = userEvent.setup();
  render(<ReceiverSelect value={null} onChange={picked} />);
  await user.type(screen.getByRole('combobox', { name: /Received by/ }), 'AT');
  await screen.findByRole('option', { name: 'AT · Alex Tester' });
  await user.keyboard('{Enter}');
  expect(picked).toHaveBeenLastCalledWith(RECEIVERS[0]);
});

// MM-T62 review follow-up: a highlight moved by the arrows belongs to the list it was moved in.
// When the query or the results change, the first match is highlighted again, even when an
// earlier query comes back (A → ArrowDown → B → A must not restore A's second option). The mocks
// filter by the query so each step really changes the results, as the server does.

function matches(text: string, query: string) {
  return text.toLowerCase().includes(query.trim().toLowerCase());
}

function stubFilteredReceivers() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const q = new URL(String(input), 'http://localhost').searchParams.get('search') ?? '';
      const found = RECEIVERS.filter(
        (receiver) => matches(receiver.initials, q) || matches(receiver.displayName, q),
      );
      return new Response(JSON.stringify(found), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

async function filterProjects(query: string) {
  return PROJECTS.filter(
    (project) => matches(project.projectNumber, query) || matches(project.name, query),
  );
}

/**
 * Each picker with a query `broad` that lists its three fictional options, a longer query
 * `narrow` that lists only the third, and `settled(query)` waiting until that query's list shows.
 */
const ROUND_TRIPS = [
  {
    name: 'Received by',
    setup() {
      stubFilteredReceivers();
      const picked = vi.fn();
      render(<ReceiverSelect value={null} onChange={picked} />);
      return () => (picked.mock.lastCall?.[0] as ReceiverOption | undefined)?.id;
    },
    combobox: /Received by/,
    broad: 'A',
    narrow: 'Ash',
    count: { broad: 3, narrow: 1 },
    ids: ['r-at', 'r-ad', 'r-al'],
  },
  {
    name: 'project',
    setup() {
      vi.mocked(searchProjects).mockImplementation(filterProjects);
      const picked = vi.fn();
      render(<ProjectHarness onSelect={picked} />);
      return () => (picked.mock.lastCall?.[0] as ProjectSummary | undefined)?.id;
    },
    combobox: /Find project/,
    broad: 'DEMO',
    narrow: 'DEMO-2603',
    count: { broad: 3, narrow: 1 },
    ids: ['p1', 'p2', 'p3'],
  },
  {
    name: 'test hole',
    setup() {
      const picked = vi.fn();
      render(<HoleHarness onChange={picked} />);
      return () => (picked.mock.lastCall?.[0] as TestHole[] | undefined)?.[0]?.id;
    },
    combobox: 'Find or add a test hole',
    broad: 'TH26',
    narrow: 'TH26-03',
    // Three holes plus "Add TH26" for the broad query; just TH26-03 for the narrow one.
    count: { broad: 4, narrow: 1 },
    ids: ['h1', 'h2', 'h3'],
  },
];

describe.each(ROUND_TRIPS)(
  '$name picker highlight after the query changes (MM-T62)',
  ({ setup, combobox, broad, narrow, count, ids }) => {
    async function settled(which: 'broad' | 'narrow') {
      await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(count[which]));
    }

    function expectHighlighted(index: number) {
      const option = screen.getAllByRole('option')[index]!;
      expect(option).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('combobox', { name: combobox })).toHaveAttribute(
        'aria-activedescendant',
        option.id,
      );
    }

    it('A → ArrowDown → B → A highlights the first match again, and Enter picks it', async () => {
      const user = userEvent.setup();
      const picked = setup();
      const input = screen.getByRole('combobox', { name: combobox });
      await user.type(input, broad);
      await settled('broad');
      await user.keyboard('{ArrowDown}');
      expectHighlighted(1);

      await user.type(input, narrow.slice(broad.length));
      await settled('narrow');
      expectHighlighted(0);

      await user.keyboard('{Backspace}'.repeat(narrow.length - broad.length));
      await settled('broad');
      expectHighlighted(0);
      await user.keyboard('{Enter}');
      expect(picked()).toBe(ids[0]);
    });

    it('clearing and retyping the same query starts again at the first match', async () => {
      const user = userEvent.setup();
      const picked = setup();
      const input = screen.getByRole('combobox', { name: combobox });
      await user.type(input, broad);
      await settled('broad');
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expectHighlighted(2);

      await user.clear(input);
      await user.type(input, broad);
      await settled('broad');
      expectHighlighted(0);
      await user.keyboard('{ArrowDown}{Enter}');
      expect(picked()).toBe(ids[1]);
    });

    it('keeps the highlight while the list stays the same, and resets when it changes', async () => {
      const user = userEvent.setup();
      const picked = setup();
      const input = screen.getByRole('combobox', { name: combobox });
      await user.type(input, broad);
      await settled('broad');
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expectHighlighted(2);

      await user.type(input, narrow.slice(broad.length));
      await settled('narrow');
      // The old index no longer exists; the single remaining match is highlighted.
      expectHighlighted(0);
      await user.keyboard('{Enter}');
      expect(picked()).toBe(ids[2]);
    });
  },
);

it('MM-T62: a new answer for the same query highlights its own first match', async () => {
  // The first answer for "A" lists the receivers in one order, the next answer in reverse.
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const q = new URL(String(input), 'http://localhost').searchParams.get('search') ?? '';
      if (q !== 'A') return new Response('[]', { status: 200 });
      call += 1;
      const list = call === 1 ? RECEIVERS : [...RECEIVERS].reverse();
      return new Response(JSON.stringify(list), { status: 200 });
    }),
  );
  const picked = vi.fn();
  const user = userEvent.setup();
  render(<ReceiverSelect value={null} onChange={picked} />);
  const input = screen.getByRole('combobox', { name: /Received by/ });
  await user.type(input, 'A');
  await screen.findByRole('option', { name: /Ash Lab/ });
  await user.keyboard('{ArrowDown}');

  // Typing "x" then deleting it searches "A" again, and that answer comes back reversed.
  await user.type(input, 'x');
  await screen.findByText(/No active staff/);
  await user.keyboard('{Backspace}');
  await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveAccessibleName(/Ash Lab/));
  expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0]!.id);
  await user.keyboard('{Enter}');
  expect(picked).toHaveBeenLastCalledWith(RECEIVERS[2]);
});

it('MTR-136: picking a project focuses Change project, and Change project focuses the search', async () => {
  const user = userEvent.setup();
  render(<ProjectHarness onSelect={vi.fn()} />);
  await user.type(screen.getByRole('combobox'), 'DEMO-260');
  await screen.findAllByRole('option');
  await user.keyboard('{ArrowDown}{Enter}');
  const change = await screen.findByRole('button', { name: 'Change project' });
  expect(change).toHaveFocus();
  expect(screen.getByRole('textbox', { name: 'Project number' })).toHaveValue('DEMO-2602');

  await user.click(change);
  expect(screen.getByRole('combobox', { name: 'Find project (number or name)' })).toHaveFocus();
});
