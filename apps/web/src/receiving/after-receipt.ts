import { userPreferencesResponseSchema, type AfterReceiptChoice } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client';

/**
 * The person's "After confirming a receipt" preference (Settings › Preferences › Receiving,
 * STRATA-29): `done_page` (the default) or `put_away`. Read from `GET /api/me/preferences`; a
 * LAB station reads the defaults. Anything that goes wrong means the done page, which is always
 * safe. `null` until known.
 */
export async function fetchAfterReceipt(): Promise<AfterReceiptChoice> {
  try {
    const response = await apiFetch('/api/me/preferences', {}, { reportUnauthenticated: false });
    if (!response.ok) return 'done_page';
    const parsed = userPreferencesResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.preferences.afterReceipt : 'done_page';
  } catch {
    return 'done_page';
  }
}

export function useAfterReceipt(): AfterReceiptChoice | null {
  const [choice, setChoice] = useState<AfterReceiptChoice | null>(null);
  useEffect(() => {
    let current = true;
    void fetchAfterReceipt().then((value) => current && setChoice(value));
    return () => {
      current = false;
    };
  }, []);
  return choice;
}
