import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ActiveQueryChips } from './query-chips';
import { EMPTY_TABLE_QUERY, type SortOption, type TableQuery } from './table-query';

const sortOptions: SortOption[] = [
  { label: 'Newest first', sort: null },
  { label: 'Oldest first', sort: { key: 'received', dir: 'asc' } },
];
const filters = [
  { id: 'unread', label: 'Unread' },
  { id: 'requests', label: 'Requests' },
  { id: 'holds', label: 'Holds' },
];

function renderChips(query: Partial<TableQuery>) {
  const onQueryChange = vi.fn();
  const result = render(
    <ActiveQueryChips
      query={{ ...EMPTY_TABLE_QUERY, ...query }}
      onQueryChange={onQueryChange}
      filters={filters}
      sortOptions={sortOptions}
      sortLabels={{ title: { asc: 'Title A–Z', desc: 'Title Z–A' } }}
    />,
  );
  return { onQueryChange, ...result };
}

describe('ActiveQueryChips', () => {
  it('renders nothing when no sort or filter is active, including the default sort and a search', () => {
    const { container } = renderChips({ search: 'TH26-01' });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a chip for a menu sort and for a heading sort, and × resets the sort to null', async () => {
    const user = userEvent.setup();
    const { onQueryChange, rerender } = renderChips({ sort: { key: 'received', dir: 'asc' } });
    const group = screen.getByRole('group', { name: 'Active sort and filters' });
    expect(within(group).getByText('Oldest first')).toBeInTheDocument();

    rerender(
      <ActiveQueryChips
        query={{ ...EMPTY_TABLE_QUERY, sort: { key: 'title', dir: 'desc' } }}
        onQueryChange={onQueryChange}
        filters={filters}
        sortOptions={sortOptions}
        sortLabels={{ title: { asc: 'Title A–Z', desc: 'Title Z–A' } }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Clear Title Z–A' }));
    expect(onQueryChange).toHaveBeenCalledWith({ sort: null });
  });

  it('shows one chip per filter; × on one keeps the others', async () => {
    const user = userEvent.setup();
    const { onQueryChange } = renderChips({ filters: ['holds', 'unread', 'requests'] });
    const group = screen.getByRole('group', { name: 'Active sort and filters' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Clear Holds', 'Clear Unread', 'Clear Requests']);
    await user.click(screen.getByRole('button', { name: 'Clear Unread' }));
    expect(onQueryChange).toHaveBeenCalledWith({ filters: ['holds', 'requests'] });
  });

  it('puts the sort chip first and shows an unknown filter id as itself', () => {
    renderChips({ sort: { key: 'received', dir: 'asc' }, filters: ['archived'] });
    const buttons = within(
      screen.getByRole('group', { name: 'Active sort and filters' }),
    ).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Clear Oldest first',
      'Clear archived',
    ]);
  });
});
