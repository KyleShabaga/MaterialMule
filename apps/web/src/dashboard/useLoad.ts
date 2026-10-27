import { useEffect, useState } from 'react';
import type { Loaded } from './api';

export type LoadState<T> =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

/**
 * Loads `fetcher()` whenever `key` changes and on `retry()`. A result only counts for the
 * request that fetched it, so a slow answer for an old filter never replaces a newer one.
 */
export function useLoad<T>(
  key: string,
  fetcher: () => Promise<Loaded<T>>,
): [LoadState<T>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const request = `${key}#${attempt}`;
  const [latest, setLatest] = useState<{ request: string; result: Loaded<T> } | null>(null);

  useEffect(() => {
    let active = true;
    void fetcher().then((result) => {
      if (active) setLatest({ request, result });
    });
    return () => {
      active = false;
    };
    // `fetcher` is rebuilt every render; `request` says when to fetch again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const state: LoadState<T> =
    latest?.request !== request
      ? { state: 'loading' }
      : latest.result.ok
        ? { state: 'ready', data: latest.result.data }
        : { state: 'error', message: latest.result.message };
  return [state, () => setAttempt((a) => a + 1)];
}
