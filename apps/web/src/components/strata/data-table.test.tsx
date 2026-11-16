import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DataTable,
  TABLE_DENSITY_STORAGE_PREFIX,
  planColumnHiding,
  useTableDensity,
  type DataTableColumn,
  type DataTableDensity,
} from './data-table';
import type { StageKey } from '@materialmule/shared';
import type { SortState } from './table-query';

interface Unit {
  id: string;
  project: string;
  status: string;
  stage: StageKey;
  receivedBy: string;
  received: string;
}

// Fictional data only.
const UNITS: Unit[] = [
  {
    id: 'BKT-2026-000019',
    project: 'DEMO-2601',
    status: 'In storage',
    stage: 'storage',
    receivedBy: 'Alex Tester',
    received: '2026-11-02',
  },
  {
    id: 'ST-2026-000004',
    project: 'DEMO-2601',
    status: 'In lab',
    stage: 'lab',
    receivedBy: 'Sam Example',
    received: '2026-10-28',
  },
  {
    id: 'CRE-2026-000002',
    project: 'DEMO-2610',
    status: 'Due for disposal',
    stage: 'due',
    receivedBy: 'Alex Tester',
    received: '2026-09-14',
  },
];

const COLUMNS: DataTableColumn<Unit>[] = [
  {
    id: 'id',
    header: 'Unit',
    cell: (u) => u.id,
    priority: 'identity',
    mono: true,
    width: '11rem',
    sortKey: 'id',
    // Deliberately set: identity columns must ignore it.
    hideBelow: '25rem',
  },
  { id: 'project', header: 'Project', cell: (u) => u.project, priority: 'identity' },
  {
    id: 'status',
    header: 'Status',
    cell: (u) => u.status,
    priority: 'state',
    wrap: true,
    hideBelow: '30rem',
  },
  {
    id: 'receivedBy',
    header: 'Received by',
    cell: (u) => u.receivedBy,
    priority: 'attribute',
    hideBelow: '40rem',
    fold: (u) => <span>Received by {u.receivedBy}</span>,
  },
  {
    id: 'received',
    header: 'Received',
    cell: (u) => u.received,
    priority: 'attribute',
    mono: true,
    width: '11ch',
    sortKey: 'received',
  },
];

function bodyRows() {
  const [, body] = screen.getAllByRole('rowgroup');
  return within(body!).getAllByRole('row');
}

function Harness({
  initialSelected = [],
  onOpenRow,
  openRowId,
  density = 'comfortable',
}: {
  initialSelected?: string[];
  onOpenRow?: (u: Unit) => void;
  openRowId?: string | null;
  density?: DataTableDensity;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initialSelected));
  return (
    <DataTable
      columns={COLUMNS}
      data={UNITS}
      getRowId={(u) => u.id}
      rowLabel={(u) => u.id}
      caption="Storage units"
      density={density}
      selectedIds={selected}
      onSelectedIdsChange={setSelected}
      onOpenRow={onOpenRow}
      openRowId={openRowId}
      stage={(u) => u.stage}
    />
  );
}

describe('DataTable', () => {
  it('renders rows in the given order and never reorders them when the sort changes', () => {
    const props = {
      columns: COLUMNS,
      getRowId: (u: Unit) => u.id,
      rowLabel: (u: Unit) => u.id,
      caption: 'Storage units',
      onSortChange: () => undefined,
    };
    const { rerender } = render(<DataTable {...props} data={UNITS} sort={null} />);
    const order = () => bodyRows().map((r) => r.getAttribute('data-row-id'));
    expect(order()).toEqual(['BKT-2026-000019', 'ST-2026-000004', 'CRE-2026-000002']);
    rerender(<DataTable {...props} data={UNITS} sort={{ key: 'received', dir: 'asc' }} />);
    expect(order()).toEqual(['BKT-2026-000019', 'ST-2026-000004', 'CRE-2026-000002']);
    expect(screen.getByRole('table', { name: 'Storage units' })).toBeInTheDocument();
  });

  it('cycles a heading sort asc → desc → default and sets aria-sort', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    function Sorted() {
      const [sort, setSort] = useState<SortState | null>(null);
      return (
        <DataTable
          columns={COLUMNS}
          data={UNITS}
          getRowId={(u) => u.id}
          rowLabel={(u) => u.id}
          caption="Storage units"
          sort={sort}
          onSortChange={(next) => {
            onSortChange(next);
            setSort(next);
          }}
        />
      );
    }
    render(<Sorted />);
    const th = screen.getByRole('columnheader', { name: 'Received' });
    expect(th).toHaveAttribute('aria-sort', 'none');
    const button = within(th).getByRole('button');
    await user.click(button);
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'received', dir: 'asc' });
    expect(th).toHaveAttribute('aria-sort', 'ascending');
    await user.click(button);
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'received', dir: 'desc' });
    expect(th).toHaveAttribute('aria-sort', 'descending');
    await user.click(button);
    expect(onSortChange).toHaveBeenLastCalledWith(null);
    expect(th).toHaveAttribute('aria-sort', 'none');
    // Not sortable: a plain heading.
    expect(screen.getByRole('columnheader', { name: 'Project' })).not.toHaveAttribute('aria-sort');
  });

  it('never hides identity or state columns, and hides attribute columns by container width', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<Harness />);
    const hideClass = /@max-\[[0-9]+rem\]\/table:hidden/;
    const headers = screen.getAllByRole('columnheader');
    const byName = (name: string) => headers.find((h) => h.textContent === name)!;
    expect(byName('Unit').className).not.toMatch(hideClass);
    expect(byName('Status').className).not.toMatch(hideClass);
    expect(byName('Received by')).toHaveClass('@max-[40rem]/table:hidden');
    const cells = within(bodyRows()[0]!).getAllByRole('cell');
    // [checkbox, id, project, status, receivedBy, received]
    expect(cells[1]!.className).not.toMatch(hideClass);
    expect(cells[3]!.className).not.toMatch(hideClass);
    expect(cells[4]).toHaveClass('@max-[40rem]/table:hidden');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"id" is identity'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"status" is state'));
    // The wrapper is the container the queries measure.
    expect(screen.getByRole('table').closest('[data-slot="data-table"]')).toHaveClass(
      '@container/table',
    );
    warn.mockRestore();
  });

  it('folds a hidden attribute into the identity cell with the inverse class', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<Harness />);
    const idCell = within(bodyRows()[0]!).getAllByRole('cell')[1]!;
    expect(idCell).toHaveTextContent('BKT-2026-000019');
    const fold = idCell.querySelector('[data-fold="receivedBy"]');
    expect(fold).toHaveTextContent('Received by Alex Tester');
    expect(fold).toHaveClass('hidden', '@max-[40rem]/table:inline-flex');
    vi.mocked(console.warn).mockRestore();
  });

  it('draws the stage stripe in the first cell', () => {
    render(
      <DataTable
        columns={COLUMNS.slice(1)}
        data={UNITS}
        getRowId={(u) => u.id}
        rowLabel={(u) => u.id}
        caption="Storage units"
        stage={(u) => (u.id === 'ST-2026-000004' ? null : u.stage)}
      />,
    );
    const [first, second] = bodyRows();
    const cell = within(first!).getAllByRole('cell')[0]!;
    expect(cell).toHaveClass('relative');
    const stripe = cell.querySelector('[data-slot="stage-stripe"]');
    expect(stripe).toHaveAttribute('data-stage', 'storage');
    expect(stripe).toHaveAttribute('aria-hidden', 'true');
    expect(stripe).toHaveClass('top-2.5'); // 'row' variant
    expect(second!.querySelector('[data-slot="stage-stripe"]')).toBeNull();
  });

  it('uses the dense stripe and 28 px rows in the table density', () => {
    render(<Harness density="table" />);
    const row = bodyRows()[0]!;
    expect(row).toHaveClass('h-7');
    const stripe = row.querySelector('[data-slot="stage-stripe"]');
    expect(stripe).toHaveClass('top-1');
    // The stripe sits in the first (checkbox) cell.
    expect(within(row).getAllByRole('cell')[0]).toContainElement(stripe as HTMLElement);
  });

  it.each([
    ['comfortable', 'h-13'],
    ['compact', 'h-9'],
    ['table', 'h-7'],
  ] as const)('gives %s rows the %s height', (density, cls) => {
    render(<Harness density={density} />);
    for (const row of bodyRows()) expect(row).toHaveClass(cls);
  });

  it('selects one row, all rows, and shows an indeterminate header', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const all = screen.getByRole('checkbox', { name: 'Select all rows' });
    expect(all).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('checkbox', { name: 'Select ST-2026-000004' }));
    expect(screen.getByRole('checkbox', { name: 'Select ST-2026-000004' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(bodyRows()[1]).toHaveAttribute('data-state', 'selected');
    expect(all).toHaveAttribute('aria-checked', 'mixed');
    await user.click(all);
    expect(all).toHaveAttribute('aria-checked', 'true');
    for (const row of bodyRows()) expect(row).toHaveAttribute('data-state', 'selected');
    await user.click(all);
    expect(all).toHaveAttribute('aria-checked', 'false');
  });

  it('does not open the row when its checkbox is clicked', async () => {
    const user = userEvent.setup();
    const onOpenRow = vi.fn();
    render(<Harness onOpenRow={onOpenRow} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select BKT-2026-000019' }));
    expect(onOpenRow).not.toHaveBeenCalled();
    await user.click(screen.getByText('DEMO-2610'));
    expect(onOpenRow).toHaveBeenCalledWith(UNITS[2]);
  });

  it('moves focus with J/K and the arrows, opens with Enter and ticks with Space', async () => {
    const user = userEvent.setup();
    const onOpenRow = vi.fn();
    render(<Harness onOpenRow={onOpenRow} />);
    const rows = bodyRows();
    expect(rows.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    rows[0]!.focus();
    await user.keyboard('j');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(rows[2]).toHaveFocus();
    await user.keyboard('j'); // stays on the last row
    expect(rows[2]).toHaveFocus();
    await user.keyboard('k');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(rows[0]).toHaveFocus();
    expect(bodyRows().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    await user.keyboard('{ArrowDown}');
    expect(bodyRows().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    await user.keyboard('{Enter}');
    expect(onOpenRow).toHaveBeenCalledWith(UNITS[1]);
    await user.keyboard(' ');
    expect(bodyRows()[1]).toHaveAttribute('data-state', 'selected');
    await user.keyboard(' ');
    expect(bodyRows()[1]).not.toHaveAttribute('data-state');
  });

  it('ignores the shortcuts while typing in a field inside a row', async () => {
    const user = userEvent.setup();
    const onOpenRow = vi.fn();
    const columns: DataTableColumn<Unit>[] = [
      ...COLUMNS.slice(0, 2),
      {
        id: 'note',
        header: 'Note',
        cell: (u) => <input aria-label={`Note for ${u.id}`} />,
        priority: 'attribute',
        control: true,
      },
    ];
    render(
      <DataTable
        columns={columns}
        data={UNITS}
        getRowId={(u) => u.id}
        rowLabel={(u) => u.id}
        caption="Storage units"
        onOpenRow={onOpenRow}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Note for BKT-2026-000019' });
    await user.click(input);
    await user.keyboard('jk{Enter}');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('jk');
    expect(onOpenRow).not.toHaveBeenCalled();
  });

  it('marks the open row with aria-current and makes it the tab stop', () => {
    render(<Harness openRowId="CRE-2026-000002" />);
    const rows = bodyRows();
    expect(rows[2]).toHaveAttribute('aria-current', 'true');
    expect(rows[0]).not.toHaveAttribute('aria-current');
    expect(rows.map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('shows the empty state in one full-width row', () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={[]}
        getRowId={(u) => u.id}
        rowLabel={(u) => u.id}
        caption="Storage units"
        empty="No units match these filters."
      />,
    );
    const rows = bodyRows();
    expect(rows).toHaveLength(1);
    const cell = within(rows[0]!).getByRole('cell');
    expect(cell).toHaveTextContent('No units match these filters.');
    // Full width: the message cell plus a blank cell per hideable column cover every column.
    const spans = Array.from(rows[0]!.querySelectorAll('td')).map((td) => td.colSpan);
    expect(spans.reduce((sum, n) => sum + n, 0)).toBe(COLUMNS.length);
  });

  it('keeps the empty row to the header’s shown columns when some columns hide', () => {
    // Hidden header cells are display:none; a colSpan over every column would add phantom
    // columns and squeeze the header. Each hideable column gets its own blank cell instead,
    // hidden by the same container query as its header.
    const columns: DataTableColumn<Unit>[] = [
      { id: 'id', header: 'Unit', priority: 'identity', cell: (u) => u.id },
      { id: 'status', header: 'Status', priority: 'state', width: '8rem', cell: (u) => u.id },
      {
        id: 'place',
        header: 'Location',
        priority: 'attribute',
        hideBelow: '40rem',
        width: '10rem',
        cell: (u) => u.id,
      },
      {
        id: 'project',
        header: 'Project',
        priority: 'attribute',
        hideBelow: '30rem',
        width: '8rem',
        cell: (u) => u.id,
      },
    ];
    render(
      <DataTable
        columns={columns}
        data={[]}
        getRowId={(u) => u.id}
        rowLabel={(u) => u.id}
        caption="Storage units"
        empty="No units match these filters."
      />,
    );
    const header = screen.getAllByRole('columnheader');
    expect(header.map((h) => h.textContent)).toEqual(['Unit', 'Status', 'Location', 'Project']);
    const row = bodyRows()[0]!;
    const message = within(row).getByRole('cell');
    expect(message).toHaveTextContent('No units match these filters.');
    // The message spans only the columns that never hide.
    expect(message).toHaveAttribute('colspan', '2');
    const cells = Array.from(row.querySelectorAll('td'));
    expect(cells).toHaveLength(3);
    // Each blank cell hides with its column's header, so the shown cell count always matches.
    const location = header[2]!.className.match(/@max-\[40rem\]\/table:hidden/)![0];
    const project = header[3]!.className.match(/@max-\[30rem\]\/table:hidden/)![0];
    expect(cells[1]).toHaveClass(location);
    expect(cells[2]).toHaveClass(project);
    expect(cells[1]).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows skeleton rows while loading', () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={[]}
        getRowId={(u) => u.id}
        rowLabel={(u) => u.id}
        caption="Storage units"
        loading
      />,
    );
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelectorAll('[data-slot="skeleton-row"]')).toHaveLength(3);
  });
});

describe('useTableDensity', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  function stubPhone(phone: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: phone && query === '(max-width: 640px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  }

  it('defaults to comfortable, then the account default, then the per-table choice', () => {
    stubPhone(false);
    expect(renderHook(() => useTableDensity('units')).result.current[0]).toBe('comfortable');
    const withDefault = renderHook(() => useTableDensity('units', 'compact'));
    expect(withDefault.result.current[0]).toBe('compact');
    act(() => withDefault.result.current[1]('comfortable'));
    expect(withDefault.result.current[0]).toBe('comfortable');
    expect(window.localStorage.getItem(TABLE_DENSITY_STORAGE_PREFIX + 'units')).toBe('comfortable');
    // Another table keeps the account default.
    expect(renderHook(() => useTableDensity('programs', 'compact')).result.current[0]).toBe(
      'compact',
    );
    // A stored choice wins over the account default on the next mount.
    expect(renderHook(() => useTableDensity('units', 'compact')).result.current[0]).toBe(
      'comfortable',
    );
  });

  it('is always comfortable on a phone', () => {
    stubPhone(true);
    window.localStorage.setItem(TABLE_DENSITY_STORAGE_PREFIX + 'units', 'compact');
    const { result } = renderHook(() => useTableDensity('units', 'compact'));
    expect(result.current[0]).toBe('comfortable');
    act(() => result.current[1]('compact'));
    expect(result.current[0]).toBe('comfortable');
    expect(window.localStorage.getItem(TABLE_DENSITY_STORAGE_PREFIX + 'units')).toBe('compact');
  });

  it('survives blocked storage', () => {
    stubPhone(false);
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useTableDensity('units', 'compact'));
    expect(result.current[0]).toBe('compact');
    act(() => result.current[1]('comfortable'));
    expect(result.current[0]).toBe('comfortable');
    get.mockRestore();
    set.mockRestore();
  });
});

describe('DataTable column widths', () => {
  it('sizes a mono column in mono characters plus the cell padding, with a sans label', () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={UNITS}
        getRowId={(u) => u.id}
        rowLabel={(u) => u.id}
        caption="Storage units"
        sort={null}
        onSortChange={() => undefined}
      />,
    );
    const th = screen.getByRole('columnheader', { name: /^Received$/ });
    expect(th.className).toContain('font-mono');
    expect(th.className).toContain('text-sm');
    expect(th.getAttribute('style')).toContain('calc(11ch + 1.5rem)');
    expect(within(th).getByText('Received').closest('.font-sans')).not.toBeNull();
    // The sort button carries a data-slot, so wave 0's legacy bare-button rules skip it.
    expect(within(th).getByRole('button').getAttribute('data-slot')).toBe('table-sort-button');
  });
});

describe('planColumnHiding', () => {
  // The gallery's Inbox-like table: Title is the free column; Task, From and Received hide in
  // that order before Title drops below 16rem.
  const INBOX: DataTableColumn<Unit>[] = [
    { id: 'title', header: 'Title', priority: 'identity', cell: () => null },
    {
      id: 'job',
      header: 'Job number',
      priority: 'identity',
      mono: true,
      width: '10ch',
      cell: () => null,
    },
    { id: 'stage', header: 'Stage', priority: 'state', width: '10rem', cell: () => null },
    {
      id: 'task',
      header: 'Task',
      priority: 'attribute',
      hideOrder: 1,
      width: '9rem',
      cell: () => null,
    },
    {
      id: 'from',
      header: 'From',
      priority: 'attribute',
      hideOrder: 2,
      width: '10rem',
      cell: () => null,
    },
    {
      id: 'received',
      header: 'Received',
      priority: 'attribute',
      hideOrder: 3,
      mono: true,
      width: '10ch',
      cell: () => null,
    },
  ];
  const hiddenAt = (plan: Map<string, string>, px: number) =>
    [...plan].filter(([, bp]) => px / 16 < Number.parseFloat(bp)).map(([id]) => id);

  it('hides Task first, then From, then Received, and never identity or state', () => {
    const plan = planColumnHiding(INBOX, { selectable: true });
    const rem = (id: string) => Number.parseFloat(plan.get(id)!);
    expect(rem('task')).toBeGreaterThan(rem('from'));
    expect(rem('from')).toBeGreaterThan(rem('received'));
    expect(plan.has('title')).toBe(false);
    expect(plan.has('stage')).toBe(false);
  });

  it('at a ~950 px list (1024 px window, rail collapsed) hides Task and keeps Title at 16rem or more', () => {
    const plan = planColumnHiding(INBOX, { selectable: true });
    expect(hiddenAt(plan, 950)).toEqual(['task']);
    // Room left for Title at 950 px once Task is gone: checkbox 2.75 + job 7.5 + stage 11.5 +
    // from 11.5 + received 7.5 = 40.75rem of fixed columns.
    expect(950 / 16 - 40.75).toBeGreaterThanOrEqual(16);
  });

  it('keeps every column in a 72rem list, drops only Task at 64rem, all three in a drawer list', () => {
    const plan = planColumnHiding(INBOX, { selectable: true });
    expect(hiddenAt(plan, 72 * 16)).toEqual([]);
    // 1280 px with the rail open: the page container is about 64rem (DESIGN.md).
    expect(hiddenAt(plan, 64 * 16)).toEqual(['task']);
    expect(hiddenAt(plan, 480)).toEqual(['task', 'from', 'received']);
  });

  it('lets an explicit hideBelow win and applies the planned class to th and td', () => {
    const columns = INBOX.map((c) => (c.id === 'from' ? { ...c, hideBelow: '30rem' as const } : c));
    expect(planColumnHiding(columns).has('from')).toBe(false);
    render(
      <DataTable
        columns={columns}
        data={UNITS}
        getRowId={(u) => u.id}
        rowLabel={(u) => u.id}
        caption="Inbox"
      />,
    );
    const task = screen.getByRole('columnheader', { name: 'Task' });
    expect(task.className).toMatch(/@max-\[\d+rem\]\/table:hidden/);
    expect(screen.getByRole('columnheader', { name: 'From' }).className).toContain(
      '@max-[30rem]/table:hidden',
    );
  });
});
