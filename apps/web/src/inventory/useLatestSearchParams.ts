import { useCallback, useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';

type Updater = (prev: URLSearchParams) => URLSearchParams;

/**
 * `useSearchParams` whose setter always builds on the latest params (MM-T46).
 *
 * React Router's own functional form `setParams(prev => …)` passes the params of the last render,
 * so two updates made before the first navigation has rendered (two quick filter picks, or typing
 * a search right after Clear filters) would both start from the same old URL and the second would
 * drop the first. Here each update starts from the newest URL this page asked for, until a
 * navigation the page did not ask for (Back, a link) arrives.
 */
export function useLatestSearchParams(): [URLSearchParams, (update: Updater) => void] {
  const [params, setParams] = useSearchParams();
  const rendered = params.toString();
  const renderedRef = useRef(rendered);
  // URLs this page requested that have not rendered yet, oldest first.
  const pending = useRef<string[]>([]);

  useLayoutEffect(() => {
    renderedRef.current = rendered;
    const index = pending.current.indexOf(rendered);
    pending.current = index === -1 ? [] : pending.current.slice(index + 1);
  }, [rendered]);

  const update = useCallback(
    (fn: Updater) => {
      const base = pending.current.at(-1) ?? renderedRef.current;
      const next = fn(new URLSearchParams(base)).toString();
      pending.current = [...pending.current, next];
      setParams(new URLSearchParams(next));
    },
    [setParams],
  );
  return [params, update];
}
