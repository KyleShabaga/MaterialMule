import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

// Shared steps for the Receive samples page tests (STRATA-76). Radix Select and DropdownMenu use
// pointer capture, which jsdom lacks; `installPointerCapture` stands in for it.

export type User = ReturnType<typeof userEvent.setup>;

export function installPointerCapture() {
  const proto = Element.prototype as Element & {
    hasPointerCapture?: (id: number) => boolean;
    setPointerCapture?: (id: number) => void;
    releasePointerCapture?: (id: number) => void;
  };
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
}

export const unitRegion = (name: string) => screen.getByRole('region', { name });

/** Chooses a row's holder ("Bucket 1 holder" → "Shelby tube"). */
export async function chooseHolder(user: User, unitName: string, holder: string) {
  await user.click(screen.getByRole('combobox', { name: `${unitName} holder` }));
  await user.click(await screen.findByRole('option', { name: holder }));
}

/** Runs an item of a row's actions menu ("Bucket 1 actions" → "Remove Bucket 1"). */
export async function rowAction(user: User, unitName: string, item: string | RegExp) {
  await user.click(screen.getByRole('button', { name: `${unitName} actions` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

export const confirmButton = () => screen.getByRole('button', { name: 'Confirm and print labels' });

/** Confirm and print labels, then the AlertDialog's own Confirm. */
export async function confirmAndPrint(user: User) {
  await user.click(confirmButton());
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: /^Confirm \d+ units? and print/ }));
}
