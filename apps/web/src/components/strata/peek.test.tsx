import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from 'react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PeekSplit,
  PeekToolbar,
  peekNeighbours,
  usePeekKeys,
  usePeekParam,
  type PeekParam,
} from './peek';

// jsdom has no ResizeObserver; react-resizable-panels measures the group with one.
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const IDS = ['BKT-2026-000019', 'CT-2026-000004', 'BKT-2026-000020'];

describe('peekNeighbours', () => {
  it('gives previous and next in the middle', () => {
    expect(peekNeighbours(IDS, 'CT-2026-000004')).toEqual({
      index: 1,
      total: 3,
      previousId: 'BKT-2026-000019',
      nextId: 'BKT-2026-000020',
    });
  });

  it('has no previous at the first record and no next at the last', () => {
    expect(peekNeighbours(IDS, 'BKT-2026-000019').previousId).toBeNull();
    expect(peekNeighbours(IDS, 'BKT-2026-000020').nextId).toBeNull();
  });

  it('returns index -1 and no neighbours when the record is not in the results or none is open', () => {
    expect(peekNeighbours(IDS, 'CT-2026-000099')).toEqual({
      index: -1,
      total: 3,
      previousId: null,
      nextId: null,
    });
    expect(peekNeighbours(IDS, null).index).toBe(-1);
    expect(peekNeighbours([], 'BKT-2026-000019').total).toBe(0);
  });
});

/** A small host page: a list with focusable rows, the peek split and the toolbar. */
function Host({ onParam }: { onParam?: (param: PeekParam) => void }) {
  const peek = usePeekParam();
  const location = useLocation();
  const navigate = useNavigate();
  onParam?.(peek);
  const { index, total, previousId, nextId } = peekNeighbours(IDS, peek.openId);
  usePeekKeys({
    enabled: peek.openId !== null,
    onClose: peek.close,
    onPrevious: previousId ? () => peek.open(previousId) : undefined,
    onNext: nextId ? () => peek.open(nextId) : undefined,
  });
  return (
    <>
      <output data-testid="search">{location.search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        Back
      </button>
      <input aria-label="Search" />
      <PeekSplit
        open={peek.openId !== null}
        openId={peek.openId}
        listLabel="Units"
        drawerLabel="Unit"
        list={
          <ul>
            {IDS.map((id) => (
              <li key={id}>
                <button type="button" data-peek-id={id} onClick={() => peek.open(id)}>
                  {id}
                </button>
              </li>
            ))}
          </ul>
        }
        drawer={
          <PeekToolbar
            onClose={peek.close}
            fullPageHref={`/units/${peek.openId}`}
            position={{ index, total }}
            onPrevious={previousId ? () => peek.open(previousId) : undefined}
            onNext={nextId ? () => peek.open(nextId) : undefined}
          />
        }
      />
    </>
  );
}

function renderHost(initial = '/units?filter=stored&sort=id') {
  const router = createMemoryRouter(
    [
      { path: '/', element: <p>Home</p> },
      { path: '/units', element: <Host /> },
    ],
    { initialEntries: ['/', initial], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const search = () => new URLSearchParams(screen.getByTestId('search').textContent ?? '');

describe('usePeekParam with PeekSplit', () => {
  it('opens with a pushed entry, moves with replace, and Back closes the drawer', async () => {
    const user = userEvent.setup();
    const router = renderHost();
    expect(screen.queryByRole('region', { name: 'Unit' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'BKT-2026-000019' }));
    expect(search().get('open')).toBe('BKT-2026-000019');
    expect(search().get('filter')).toBe('stored');
    expect(search().get('sort')).toBe('id');
    expect(screen.getByRole('region', { name: 'Unit' })).toBeTruthy();
    const pushedIndex = router.state.historyAction;
    expect(pushedIndex).toBe('PUSH');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(search().get('open')).toBe('CT-2026-000004');
    expect(router.state.historyAction).toBe('REPLACE');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(search().get('open')).toBeNull();
    expect(search().get('filter')).toBe('stored');
    expect(screen.queryByRole('region', { name: 'Unit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'BKT-2026-000019' })).toBeTruthy();
  });

  it('restores the drawer from the URL on load', () => {
    renderHost('/units?open=CT-2026-000004&filter=stored');
    const drawer = screen.getByRole('region', { name: 'Unit' });
    expect(within(drawer).getByText('2 of 3')).toBeTruthy();
    expect(within(drawer).getByRole('link', { name: 'Open as full page' })).toHaveAttribute(
      'href',
      '/units/CT-2026-000004',
    );
  });

  it('close removes only the open param', async () => {
    const user = userEvent.setup();
    renderHost('/units?filter=stored&open=BKT-2026-000019&sort=id&page=2');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(search().get('open')).toBeNull();
    expect(search().get('filter')).toBe('stored');
    expect(search().get('sort')).toBe('id');
    expect(search().get('page')).toBe('2');
  });

  it('keeps the list inside the @container/list wrapper, open or closed', async () => {
    const user = userEvent.setup();
    renderHost();
    const list = () => screen.getByLabelText('Units');
    expect(list().className).toContain('@container/list');
    await user.click(screen.getByRole('button', { name: 'BKT-2026-000019' }));
    expect(list().className).toContain('@container/list');
    expect(screen.getByRole('separator', { name: 'Resize the drawer' })).toBeTruthy();
  });

  it('returns focus to the row of the record that was open when the drawer closes', async () => {
    const user = userEvent.setup();
    renderHost();
    await user.click(screen.getByRole('button', { name: 'BKT-2026-000019' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Unit' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'CT-2026-000004' }));
  });
});

describe('usePeekKeys', () => {
  it('J and K move, Esc closes, and all are ignored while typing', async () => {
    const user = userEvent.setup();
    renderHost('/units?open=CT-2026-000004');

    await user.keyboard('j');
    expect(search().get('open')).toBe('BKT-2026-000020');
    await user.keyboard('k');
    expect(search().get('open')).toBe('CT-2026-000004');

    // focus(), not click: in jsdom every rect is empty, so the panels' pointer hit-testing
    // treats any click as landing on the resize handle.
    act(() => screen.getByLabelText('Search').focus());
    await user.keyboard('jk{Escape}');
    expect(search().get('open')).toBe('CT-2026-000004');

    act(() => (document.activeElement as HTMLElement).blur());
    await user.keyboard('{Escape}');
    expect(search().get('open')).toBeNull();
  });

  it('is ignored while a dialog is open and when disabled', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onNext = vi.fn();
    function Keys({ enabled }: { enabled: boolean }) {
      usePeekKeys({ enabled, onClose, onNext });
      return null;
    }
    const { rerender } = render(<Keys enabled />);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.append(dialog);
    await user.keyboard('j{Escape}');
    expect(onNext).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    dialog.remove();

    await user.keyboard('j');
    expect(onNext).toHaveBeenCalledTimes(1);
    rerender(<Keys enabled={false} />);
    await user.keyboard('j{Escape}');
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PeekToolbar', () => {
  function renderToolbar(ui: React.ReactNode) {
    const router = createMemoryRouter([{ path: '/', element: ui }]);
    render(<RouterProvider router={router} />);
  }

  it('renders only Close when nothing else is given', () => {
    renderToolbar(<PeekToolbar onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open as full page' })).toBeNull();
    expect(screen.queryByText(/ of /)).toBeNull();
  });

  it('disables Previous at the first record and shows the position', async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    const onClose = vi.fn();
    renderToolbar(
      <PeekToolbar onClose={onClose} position={{ index: 0, total: 12 }} onNext={onNext}>
        <button type="button">Move</button>
      </PeekToolbar>,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(screen.getByText('1 of 12')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
