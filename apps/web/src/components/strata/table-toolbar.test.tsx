import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CheckCheck } from 'lucide-react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Table, TableBody, TableHeader, TableRow } from '@/components/ui/table';
import { SortableTableHead } from './sortable-header';
import { TableToolbar, type TableToolbarProps } from './table-toolbar';
import { EMPTY_TABLE_QUERY, useTableQuery, type SortOption, type TableQuery } from './table-query';

// Radix menus and tooltips measure with ResizeObserver and use pointer capture; jsdom has neither.
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

const sortOptions: SortOption[] = [
  { label: 'Newest first', sort: null },
  { label: 'Oldest first', sort: { key: 'received', dir: 'asc' } },
];
const sortLabels = { title: { asc: 'Title A–Z', desc: 'Title Z–A' } };
const filters = [
  { id: 'unread', label: 'Unread', count: 4 },
  { id: 'requests', label: 'Requests', count: 2 },
];
const views = [
  { id: 'list', label: 'List' },
  { id: 'table', label: 'Table' },
];

/** A page holding the query in state, so the controlled toolbar behaves as it would on a page. */
function Harness({
  initial = {},
  onChange,
  ...props
}: { initial?: Partial<TableQuery>; onChange?: (patch: Partial<TableQuery>) => void } & Partial<
  Omit<TableToolbarProps, 'query' | 'onQueryChange'>
>) {
  const [query, setQuery] = React.useState<TableQuery>({ ...EMPTY_TABLE_QUERY, ...initial });
  return (
    <TableToolbar
      label="Inbox tools"
      pageAction={{ label: 'Mark all read', icon: CheckCheck, onClick: () => {} }}
      filters={filters}
      sortOptions={sortOptions}
      sortLabels={sortLabels}
      views={views}
      searchPlaceholder="Search inbox…"
      {...props}
      query={query}
      onQueryChange={(patch) => {
        onChange?.(patch);
        setQuery((q) => ({ ...q, ...patch }));
      }}
    />
  );
}

const toolbar = () => screen.getByRole('toolbar', { name: 'Inbox tools' });
const toolNames = () =>
  within(toolbar())
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'));

describe('TableToolbar', () => {
  it('is a named toolbar: chips, page action, divider, Filter, Sort, View, then Search', () => {
    const { container } = render(<Harness initial={{ filters: ['unread'] }} />);
    expect(toolNames()).toEqual([
      'Clear Unread',
      'Mark all read',
      'Filter, 1 on',
      'Sort, Newest first',
      'View, List',
      'Search',
    ]);
    const separator = container.querySelector('[data-slot=separator]');
    const markAll = screen.getByRole('button', { name: 'Mark all read' });
    const filter = screen.getByRole('button', { name: 'Filter, 1 on' });
    expect(separator).not.toBeNull();
    expect(
      markAll.compareDocumentPosition(separator!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      separator!.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('leaves out tools that have no options, and the divider without a page action', () => {
    const { container } = render(
      <TableToolbar label="Inbox tools" query={EMPTY_TABLE_QUERY} onQueryChange={() => {}} />,
    );
    expect(toolNames()).toEqual(['Search']);
    expect(container.querySelector('[data-slot=separator]')).toBeNull();
  });

  it('runs the page action', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Harness pageAction={{ label: 'Mark all read', icon: CheckCheck, onClick }} />);
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('filters with checkboxes, counts on in its name, and clears them all', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Unread, 4' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Clear filters' })).toBeNull();

    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Requests, 2' }));
    expect(onChange).toHaveBeenLastCalledWith({ filters: ['requests'] });
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Unread, 4' }));
    expect(onChange).toHaveBeenLastCalledWith({ filters: ['requests', 'unread'] });
    // The menu stays open while ticking.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Unread, 4' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const filterButton = screen.getByRole('button', { name: 'Filter, 2 on', hidden: true });
    expect(filterButton.className).toContain('text-link');

    await user.click(screen.getByRole('menuitem', { name: 'Clear filters' }));
    expect(onChange).toHaveBeenLastCalledWith({ filters: [] });
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
  });

  it('names the Sort button after the current sort, including a heading sort', () => {
    const { rerender } = render(
      <TableToolbar
        label="Inbox tools"
        query={{ ...EMPTY_TABLE_QUERY, sort: { key: 'received', dir: 'asc' } }}
        onQueryChange={() => {}}
        sortOptions={sortOptions}
        sortLabels={sortLabels}
      />,
    );
    expect(screen.getByRole('button', { name: 'Sort, Oldest first' })).toBeInTheDocument();
    rerender(
      <TableToolbar
        label="Inbox tools"
        query={{ ...EMPTY_TABLE_QUERY, sort: { key: 'title', dir: 'asc' } }}
        onQueryChange={() => {}}
        sortOptions={sortOptions}
        sortLabels={sortLabels}
      />,
    );
    expect(screen.getByRole('button', { name: 'Sort, Title A–Z' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear Title A–Z' })).toBeInTheDocument();
  });

  it('sorts from a radio menu and writes null for the default order', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial={{ sort: { key: 'title', dir: 'desc' } }} />);
    await user.click(screen.getByRole('button', { name: 'Sort, Title Z–A' }));
    let menu = await screen.findByRole('menu');
    // A heading sort that isn't in the menu leaves no radio checked.
    for (const item of within(menu).getAllByRole('menuitemradio')) {
      expect(item).toHaveAttribute('aria-checked', 'false');
    }
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Oldest first' }));
    expect(onChange).toHaveBeenLastCalledWith({ sort: { key: 'received', dir: 'asc' } });

    await user.click(screen.getByRole('button', { name: 'Sort, Oldest first' }));
    menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: 'Oldest first' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Newest first' }));
    expect(onChange).toHaveBeenLastCalledWith({ sort: null });
    expect(screen.getByRole('button', { name: 'Sort, Newest first' })).toBeInTheDocument();
  });

  it('chooses a view from a radio menu; the first view is null', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'View, List' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Table' }));
    expect(onChange).toHaveBeenLastCalledWith({ view: 'table' });
    await user.click(screen.getByRole('button', { name: 'View, Table' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'List' }));
    expect(onChange).toHaveBeenLastCalledWith({ view: null });
  });

  describe('search', () => {
    it('opens a focused box in place of the icon and searches as you type', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);
      await user.click(screen.getByRole('button', { name: 'Search' }));
      const box = screen.getByRole('searchbox', { name: 'Search inbox' });
      expect(box).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
      // Still the last tool.
      const tools = within(toolbar()).getAllByRole('button');
      expect(
        tools.at(-1)!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      await user.type(box, 'TH2');
      expect(onChange.mock.calls.map(([p]) => p)).toEqual([
        { search: 'T' },
        { search: 'TH' },
        { search: 'TH2' },
      ]);
      expect(box).toHaveValue('TH2');
    });

    it('Clear empties the box and keeps it open and focused', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Harness onChange={onChange} initial={{ search: 'DEMO' }} />);
      await user.click(screen.getByRole('button', { name: 'Clear search' }));
      expect(onChange).toHaveBeenLastCalledWith({ search: '' });
      const box = screen.getByRole('searchbox', { name: 'Search inbox' });
      expect(box).toHaveValue('');
      expect(box).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    });

    it('Escape clears, closes and returns focus to the Search button', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await user.keyboard('DEMO{Escape}');
      expect(onChange).toHaveBeenLastCalledWith({ search: '' });
      expect(screen.queryByRole('searchbox')).toBeNull();
      expect(screen.getByRole('button', { name: 'Search' })).toHaveFocus();
    });

    it('closes when left empty, and stays open when left with text', async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await user.click(document.body);
      expect(screen.queryByRole('searchbox')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Search' }));
      await user.keyboard('TH26');
      await user.click(document.body);
      expect(screen.getByRole('searchbox', { name: 'Search inbox' })).toHaveValue('TH26');
    });

    it('starts open, unfocused, when the query already has a search', () => {
      render(<Harness initial={{ search: 'TH26-01' }} />);
      const box = screen.getByRole('searchbox', { name: 'Search inbox' });
      expect(box).toHaveValue('TH26-01');
      expect(box).not.toHaveFocus();
      expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    });
  });
});

describe('TableToolbar with useTableQuery and a sortable heading', () => {
  function Page() {
    const [query, setQuery] = useTableQuery();
    const location = useLocation();
    return (
      <>
        <TableToolbar
          label="Inbox tools"
          query={query}
          onQueryChange={setQuery}
          filters={filters}
          sortOptions={sortOptions}
          sortLabels={sortLabels}
        />
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead
                sortKey="title"
                sort={query.sort}
                onSortChange={(sort) => setQuery({ sort })}
              >
                Title
              </SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody />
        </Table>
        <output aria-label="URL">{location.search}</output>
      </>
    );
  }

  const url = () =>
    new URLSearchParams(screen.getByRole('status', { name: 'URL' }).textContent ?? '');

  it('round-trips toolbar → URL → toolbar, resets the page on a filter change, and follows heading sorts', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/inbox?page=3&open=BKT-2026-000001&filter=requests']}>
        <Page />
      </MemoryRouter>,
    );
    // URL → toolbar.
    expect(screen.getByRole('button', { name: 'Filter, 1 on' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear Requests' })).toBeInTheDocument();
    expect(url().get('page')).toBe('3');

    // Toolbar → URL: a filter change keeps other params and resets the page.
    await user.click(screen.getByRole('button', { name: 'Filter, 1 on' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Unread, 4' }));
    await user.keyboard('{Escape}');
    expect(url().getAll('filter')).toEqual(['requests', 'unread']);
    expect(url().get('page')).toBeNull();
    expect(url().get('open')).toBe('BKT-2026-000001');
    expect(screen.getByRole('button', { name: 'Filter, 2 on' })).toBeInTheDocument();

    // Heading sort cycles asc → desc → default, and the Sort button says so.
    const heading = screen.getByRole('button', { name: 'Title' });
    await user.click(heading);
    expect(screen.getByRole('button', { name: 'Sort, Title A–Z' })).toBeInTheDocument();
    expect(url().get('sort')).toBe('title');
    expect(url().get('dir')).toBe('asc');
    await user.click(heading);
    expect(screen.getByRole('button', { name: 'Sort, Title Z–A' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');
    await user.click(heading);
    expect(screen.getByRole('button', { name: 'Sort, Newest first' })).toBeInTheDocument();
    expect(url().get('sort')).toBeNull();

    // A chip clears one filter in the URL.
    await user.click(screen.getByRole('button', { name: 'Clear Requests' }));
    expect(url().getAll('filter')).toEqual(['unread']);

    // Search writes to the URL as you type.
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.keyboard('TH26');
    expect(url().get('search')).toBe('TH26');
  });
});
