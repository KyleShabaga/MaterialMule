import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clearIdentityToasts, notifyError, notifySuccess, StrataToaster } from './toast';

// jsdom has no pointer capture; Sonner's swipe-to-dismiss calls it on pointerdown.
beforeAll(() => {
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => undefined;
    HTMLElement.prototype.releasePointerCapture = () => undefined;
    HTMLElement.prototype.hasPointerCapture = () => false;
  }
});

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
});

function renderToaster() {
  render(<StrataToaster />);
}

describe('notifySuccess', () => {
  it('has no Undo button when no inverse is given', async () => {
    renderToaster();
    act(() => {
      notifySuccess('Moved BKT-2026-000019 to Shelf A-03');
    });
    expect(await screen.findByText('Moved BKT-2026-000019 to Shelf A-03')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('runs the undo once on a double click and confirms it', async () => {
    const user = userEvent.setup();
    renderToaster();
    const run = vi.fn(() => Promise.resolve());
    act(() => {
      notifySuccess('Added CT-2026-000004 to the disposal list', { undo: { run } });
    });
    const undo = await screen.findByRole('button', { name: 'Undo' });
    await user.dblClick(undo);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Undone')).toBeTruthy();
  });

  it('guards the Undo action itself against a second activation', () => {
    const spy = vi.spyOn(toast, 'success').mockReturnValue(1);
    const run = vi.fn(() => Promise.resolve());
    notifySuccess('Moved BKT-2026-000019', { undo: { run } });
    const options = spy.mock.calls[0]![1]!;
    expect(options.duration).toBe(5000);
    const action = options.action as { label: string; onClick: (e: unknown) => void };
    expect(action.label).toBe('Undo');
    action.onClick({});
    action.onClick({});
    expect(run).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('reports a failed undo persistently and calls onUndoError', async () => {
    const user = userEvent.setup();
    renderToaster();
    const failure = new Error('BKT-2026-000019 was moved by Pat Example.');
    const onUndoError = vi.fn();
    act(() => {
      notifySuccess('Moved BKT-2026-000019', {
        undo: { run: () => Promise.reject(failure), onUndoError },
      });
    });
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    const message = await screen.findByText(
      "Couldn't undo. BKT-2026-000019 was moved by Pat Example.",
    );
    expect(onUndoError).toHaveBeenCalledWith(failure);
    const errorToast = message.closest('[data-sonner-toast]');
    expect(errorToast).toHaveAttribute('data-type', 'error');
    expect(
      errorToast?.querySelector('[data-close-button]') ??
        errorToast?.querySelector('button[aria-label]'),
    ).toBeTruthy();
  });
});

describe('notifyError and clearIdentityToasts', () => {
  it('creates an error toast that never auto-dismisses', () => {
    const spy = vi.spyOn(toast, 'error');
    notifyError("Couldn't save the move", 'Try again.');
    expect(spy).toHaveBeenCalledWith(
      "Couldn't save the move",
      expect.objectContaining({ description: 'Try again.', duration: Infinity, closeButton: true }),
    );
    spy.mockRestore();
  });

  it('dismisses every toast', async () => {
    renderToaster();
    act(() => {
      notifySuccess('Moved BKT-2026-000019');
      notifyError("Couldn't move CT-2026-000004");
    });
    expect(await screen.findByText('Moved BKT-2026-000019')).toBeTruthy();
    act(() => clearIdentityToasts());
    await waitFor(() => expect(screen.queryByText('Moved BKT-2026-000019')).toBeNull());
    expect(screen.queryByText("Couldn't move CT-2026-000004")).toBeNull();
  });
});
