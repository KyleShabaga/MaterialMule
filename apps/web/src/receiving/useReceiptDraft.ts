import { useCallback, useState } from 'react';
import type { ReceiptDraft } from './draft';

/**
 * The receiving draft as one object (TRP-T10). State lives in memory for now; TRP-T11 persists
 * it (autosave and recovery) behind this same interface, so callers don't change.
 */
export function useReceiptDraft(start: () => ReceiptDraft) {
  const [draft, setDraft] = useState<ReceiptDraft>(start);

  /** Functional update, so concurrent edits (e.g. a project created inline) never clobber others. */
  const update = useCallback(
    (recipe: (current: ReceiptDraft) => ReceiptDraft) => setDraft(recipe),
    [],
  );

  /** Starts a new receipt (new idempotency key). */
  const reset = useCallback((next: ReceiptDraft) => setDraft(next), []);

  return { draft, update, reset };
}
