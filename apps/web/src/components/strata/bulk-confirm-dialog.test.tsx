import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BulkConfirmDialog, type BulkResult } from './bulk-confirm-dialog';

const RECORDS = [
  { id: 'BKT-2026-000019', label: 'DEMO-2601' },
  { id: 'CT-2026-000004', label: 'DEMO-2601' },
  { id: 'BKT-2026-000020' },
];

function Host({
  onConfirm,
  onOpenChange,
}: {
  onConfirm: () => Promise<BulkResult | void>;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <BulkConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
      title="Record disposal of 3 units"
      description="These units will be marked disposed today."
      irreversibleNote="Disposal can't be undone."
      records={RECORDS}
      noun={{ one: 'unit', other: 'units' }}
      confirmLabel={(n) => `Record disposal of ${n} ${n === 1 ? 'unit' : 'units'}`}
      onConfirm={onConfirm}
    />
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('BulkConfirmDialog', () => {
  it('lists every ID in mono in a keyboard-scrollable region and repeats the count', () => {
    render(<Host onConfirm={() => Promise.resolve()} />);
    const dialog = screen.getByRole('alertdialog', { name: 'Record disposal of 3 units' });
    expect(within(dialog).getByText(/Disposal can't be undone\./)).toBeTruthy();
    const list = within(dialog).getByRole('region', { name: '3 units' });
    expect(list).toHaveAttribute('tabindex', '0');
    for (const { id } of RECORDS) {
      expect(within(list).getByText(id).className).toContain('font-mono');
    }
    expect(within(dialog).getByRole('button', { name: 'Record disposal of 3 units' })).toHaveClass(
      'bg-destructive',
    );
  });

  it('disables both buttons and blocks Escape while pending, then closes on full success', async () => {
    const user = userEvent.setup();
    const work = deferred<BulkResult>();
    const onOpenChange = vi.fn();
    render(<Host onConfirm={() => work.promise} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Record disposal of 3 units' }));
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();

    work.resolve({ succeeded: RECORDS.map((r) => r.id), failed: [] });
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('stays open on partial failure and lists each record that was not done', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Host
        onOpenChange={onOpenChange}
        onConfirm={() =>
          Promise.resolve({
            succeeded: ['BKT-2026-000019', 'BKT-2026-000020'],
            failed: [{ id: 'CT-2026-000004', reason: 'It is on hold for Pat Example.' }],
          })
        }
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Record disposal of 3 units' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('2 of 3 recorded. 1 was not:');
    expect(within(alert).getByText('CT-2026-000004')).toBeTruthy();
    expect(alert).toHaveTextContent('It is on hold for Pat Example.');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Record disposal/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows a thrown error inline and lets the person try again', async () => {
    const user = userEvent.setup();
    const onConfirm = vi
      .fn<() => Promise<BulkResult | void>>()
      .mockRejectedValueOnce(new Error("Couldn't reach the server. Nothing was recorded."))
      .mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    render(<Host onConfirm={onConfirm} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Record disposal of 3 units' }));
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent("Couldn't reach the server. Nothing was recorded.");
    expect(error.className).toContain('text-destructive-text');
    const confirm = screen.getByRole('button', { name: 'Record disposal of 3 units' });
    expect(confirm).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(confirm);
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});
