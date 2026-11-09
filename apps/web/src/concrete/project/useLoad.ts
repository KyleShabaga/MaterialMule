import { useEffect, useState } from 'react';

export type Load<T> =
  { state: 'loading' } | { state: 'error'; error: unknown } | { state: 'ready'; data: T };

/**
 * Runs `fetcher` whenever `key` (or a reload) changes. An answer is kept with the key it answers,
 * so a newer request never shows an older answer.
 */
export function useLoad<T>(key: string, fetcher: () => Promise<T>) {
  const [reloads, setReloads] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; load: Load<T> }>({
    key: '',
    load: { state: 'loading' },
  });
  const full = `${key}#${reloads}`;
  useEffect(() => {
    let cancelled = false;
    fetcher().then(
      (data) => {
        if (!cancelled) setAnswer({ key: full, load: { state: 'ready', data } });
      },
      (error: unknown) => {
        if (!cancelled) setAnswer({ key: full, load: { state: 'error', error } });
      },
    );
    return () => {
      cancelled = true;
    };
    // The fetcher is recreated on every render; the key says when it asks something new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);
  // A reload keeps showing the current answer until the new one arrives.
  const sameQuery = answer.key.split('#')[0] === key;
  return {
    load:
      answer.key === full || (sameQuery && answer.load.state === 'ready')
        ? answer.load
        : { state: 'loading' as const },
    reload: () => setReloads((n) => n + 1),
    replace: (data: T) => setAnswer({ key: full, load: { state: 'ready', data } }),
  };
}
