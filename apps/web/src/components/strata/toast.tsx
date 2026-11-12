// Toasts (STRATA-31; DESIGN.md › Toasts, UX change 6 "Undo before confirm").
//
// - One host: mount <StrataToaster /> once at app scope (lane 1A's app shell, beside the router
//   outlet). Bottom right on desktop, 5 s, close button.
// - Call notifySuccess only after the server acknowledged the change; never optimistically.
// - Undo appears only when the caller passes a real inverse (`undo.run`). It runs at most once.
//   If it fails, a persistent error toast says so and `onUndoError` lets the page show it inline
//   too: a toast is never the only place a failure is reported.
// - Call clearIdentityToasts() when the signed-in account or the "Recording as" person changes,
//   so nothing from the previous person stays on screen.

import { UNDO_BLOCKED_MESSAGES, type UndoBlockedReason } from '@materialmule/shared';
import { toast, type ExternalToast, type ToasterProps } from 'sonner';
import { Toaster } from '@/components/ui/sonner';

export const TOAST_DURATION_MS = 5000;

export interface UndoOptions {
  /** Button text; default "Undo". */
  label?: string;
  /** The real inverse of the action, resolved once the server acknowledged the undo. */
  run: () => Promise<void>;
  /** Called when the undo fails, after the persistent error toast is shown. */
  onUndoError?: (error: unknown) => void;
  /** Toast after a successful undo; default "Undone". */
  doneMessage?: string;
}

export interface SuccessOptions {
  description?: string;
  undo?: UndoOptions;
}

function isBlockedReason(value: unknown): value is UndoBlockedReason {
  return typeof value === 'string' && Object.hasOwn(UNDO_BLOCKED_MESSAGES, value);
}

/**
 * The words for a failure. A refused Undo (409 `undo_blocked`, shared undo.ts) carries its
 * `blockedReason`, possibly on the error itself or on its `body`; it reads the shared message.
 */
function errorMessage(error: unknown): string {
  for (const holder of [error, (error as { body?: unknown } | null)?.body]) {
    const reason = (holder as { blockedReason?: unknown } | null | undefined)?.blockedReason;
    if (isBlockedReason(reason)) return UNDO_BLOCKED_MESSAGES[reason];
  }
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '';
}

/** A failure toast that stays until closed. */
// eslint-disable-next-line react-refresh/only-export-components -- toast helpers belong with the host
export function notifyError(message: string, description?: string): string | number {
  return toast.error(message, {
    description,
    duration: Infinity,
    closeButton: true,
    dismissible: true,
  });
}

/** Success after the server acknowledged it, with Undo when the caller gives a real inverse. */
// eslint-disable-next-line react-refresh/only-export-components -- toast helpers belong with the host
export function notifySuccess(message: string, options: SuccessOptions = {}): string | number {
  const { description, undo } = options;
  const data: ExternalToast = { description, duration: TOAST_DURATION_MS };
  if (undo) {
    let used = false;
    data.action = {
      label: undo.label ?? 'Undo',
      onClick: () => {
        // A second click (double click, or a click during the exit animation) does nothing.
        if (used) return;
        used = true;
        void undo.run().then(
          () => {
            toast.success(undo.doneMessage ?? 'Undone', { duration: TOAST_DURATION_MS });
          },
          (error: unknown) => {
            const detail = errorMessage(error);
            notifyError(detail ? `Couldn't undo. ${detail}` : "Couldn't undo.");
            undo.onUndoError?.(error);
          },
        );
      },
    };
  }
  return toast.success(message, data);
}

/** Dismiss every toast, e.g. when the account or the "Recording as" person changes. */
// eslint-disable-next-line react-refresh/only-export-components -- toast helpers belong with the host
export function clearIdentityToasts(): void {
  toast.dismiss();
}

/**
 * The app's single toast host. Mount once at app scope (the app shell, lane 1A), not per page.
 * On phones, pass `mobileOffset` so toasts sit above the bottom bar.
 */
export function StrataToaster(props: ToasterProps) {
  return <Toaster position="bottom-right" duration={TOAST_DURATION_MS} closeButton {...props} />;
}
