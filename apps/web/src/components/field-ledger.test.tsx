import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfirmDialog,
  CountedCells,
  EmptyState,
  ErrorState,
  Segmented,
  TableViewSelector,
  UnitLabel,
} from './ui';
import { TABLE_VIEW_STORAGE_PREFIX, useTableView } from './useTableView';

// Field Ledger shared parts (wave 0): docs/redesign/design.md, "Components".

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('table view', () => {
  it('defaults to comfortable and remembers the choice per table', () => {
    const { result } = renderHook(() => useTableView('inventory'));
    expect(result.current[0]).toBe('comfortable');
    act(() => result.current[1]('compact'));
    expect(result.current[0]).toBe('compact');
    expect(window.localStorage.getItem(`${TABLE_VIEW_STORAGE_PREFIX}inventory`)).toBe('compact');
    expect(renderHook(() => useTableView('inventory')).result.current[0]).toBe('compact');
    expect(renderHook(() => useTableView('receiving-log')).result.current[0]).toBe('comfortable');
  });

  it('still switches when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useTableView('inventory'));
    act(() => result.current[1]('compact'));
    expect(result.current[0]).toBe('compact');
  });

  it('phones always use comfortable rows and get no selector', () => {
    window.localStorage.setItem(`${TABLE_VIEW_STORAGE_PREFIX}inventory`, 'compact');
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 640px)',
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
    try {
      expect(renderHook(() => useTableView('inventory')).result.current[0]).toBe('comfortable');
      render(<TableViewSelector value="comfortable" onChange={() => undefined} />);
      expect(screen.queryByRole('group', { name: 'Table view' })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the selector is two pressed-state buttons with names', async () => {
    const onChange = vi.fn();
    render(<TableViewSelector value="comfortable" onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Table view' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comfortable rows' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Compact rows' }));
    expect(onChange).toHaveBeenCalledWith('compact');
  });
});

describe('Segmented', () => {
  it('marks the active option with aria-pressed', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="Status"
        value="all"
        onChange={onChange}
        options={[
          { value: 'all', label: 'All' },
          { value: 'stored', label: 'Stored' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Stored' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Stored' }));
    expect(onChange).toHaveBeenCalledWith('stored');
  });
});

describe('CountedCells', () => {
  it('draws one cell per thing with an accessible label and a written count', () => {
    render(
      <CountedCells
        cells={['done', 'done', 'current', 'empty']}
        label="Progress: 2 done, 1 in progress, 1 not started"
        count="2 / 4"
      />,
    );
    const img = screen.getByRole('img', {
      name: 'Progress: 2 done, 1 in progress, 1 not started',
    });
    expect(img.querySelectorAll('.counted-cell')).toHaveLength(4);
    expect(img.querySelectorAll('.counted-cell-current')).toHaveLength(1);
    expect(screen.getByText('2 / 4')).toBeInTheDocument();
  });
});

describe('UnitLabel', () => {
  it('shows holder, project, ID and one written line per test hole', () => {
    render(
      <UnitLabel
        holder="Shelby tube"
        project="DEMO-2601"
        unitId="ST-2026-000031"
        headingLevel={1}
        lines={[{ hole: 'TH26-02', summary: 'ST1 · 3.0–3.6 m' }]}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'ST-2026-000031' })).toBeInTheDocument();
    expect(screen.getByText('DEMO-2601')).toBeInTheDocument();
    expect(screen.getByText('ST1 · 3.0–3.6 m')).toBeInTheDocument();
  });
});

describe('Empty and error states', () => {
  it('keeps the one-line empty form and offers the full form with one action', () => {
    const { rerender } = render(<EmptyState>No units yet.</EmptyState>);
    expect(screen.getByText('No units yet.').tagName).toBe('P');
    rerender(
      <EmptyState title="No matches" action={<button type="button">Clear filters</button>}>
        Nothing matches these filters.
      </EmptyState>,
    );
    expect(screen.getByText('No matches')).toHaveClass('empty-state-title');
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('an error is an alert with its message, detail and one way forward', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        tag="Not saved"
        message="The move wasn't recorded."
        detail="The units are still on their old shelf."
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("The move wasn't recorded.");
    expect(alert).toHaveTextContent('The units are still on their old shelf.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('ConfirmDialog', () => {
  it('names the dialog by the title in its head band', () => {
    render(
      <ConfirmDialog
        open
        title="Extend retention"
        confirmLabel="Extend"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      >
        <p>Keeps the unit for six more months.</p>
      </ConfirmDialog>,
    );
    const heading = screen.getByRole('heading', { name: 'Extend retention', hidden: true });
    expect(heading.parentElement).toHaveClass('dialog-head');
  });
});
