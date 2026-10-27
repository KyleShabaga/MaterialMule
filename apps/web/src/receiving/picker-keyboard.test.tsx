import type { ProjectSummary, ReceiverOption, TestHole } from '@materialmule/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    pmPe: PE,
  },
  {
    id: 'p2',
    projectNumber: 'DEMO-2602',
    name: 'Hillside bridge',
    client: 'Example Client',
    pmPe: PE,
  },
  {
    id: 'p3',
    projectNumber: 'DEMO-2603',
    name: 'Old Mill Road',
    client: 'Example Client',
    pmPe: PE,
  },
];
const HOLES: TestHole[] = ['TH26-01', 'TH26-02', 'TH26-03'].map((name, index) => ({
  id: `h${index + 1}`,
  projectId: 'p1',
  name,
}));
const RECEIVERS: ReceiverOption[] = [
  { id: 'r-at', initials: 'AT', displayName: 'Alex Tester', position: 'technician' },
  { id: 'r-ad', initials: 'AD', displayName: 'Avery Demo', position: 'engineer' },
  { id: 'r-al', initials: 'AL', displayName: 'Ash Lab', position: 'technician' },
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
  await screen.findByRole('option', { name: 'AT · Alex Tester (Tech)' });
  await user.keyboard('{Enter}');
  expect(picked).toHaveBeenLastCalledWith(RECEIVERS[0]);
});
