import { createElement, lazy, type ComponentType, type LazyExoticComponent } from 'react';

const preloads: Promise<unknown>[] = [];

/** Unit tests: every page import started so far (see lazyPage); empty in the app. */
export function testPagePreloads(): Promise<unknown>[] {
  return preloads;
}

/**
 * A page component loaded on first use (STRATA-132): each area of the app is its own chunk, so
 * signing in doesn't download concrete, lab or admin code.
 *
 * `lazyPage(() => import('./inbox/InboxPage'), 'InboxPage')` names the export, so pages keep
 * their named exports. Once a chunk has loaded it stays in memory for the tab, so a LAB station
 * that loses the network keeps every page it has already opened.
 */
export function lazyPage<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): LazyExoticComponent<M[K] extends ComponentType<infer P> ? ComponentType<P> : never> {
  type Page = M[K] extends ComponentType<infer P> ? ComponentType<P> : never;
  if (import.meta.env.MODE === 'test')
    return testPage(load, name) as unknown as LazyExoticComponent<Page>;
  return lazy(async () => ({ default: (await load())[name] as Page }));
}

/**
 * Unit tests only (the build drops the call): the import starts when routes.tsx is imported,
 * test-setup.ts awaits every one before the file's tests (testPagePreloads), and the page then
 * renders synchronously, as before the split. Tests never wait on the compiler or a Suspense
 * tick. A page whose import failed throws that error, as React.lazy would.
 */
function testPage<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  let loaded: { module: M } | { error: unknown } | null = null;
  const pending = load().then(
    (module) => {
      loaded = { module };
    },
    (error: unknown) => {
      loaded = { error };
    },
  );
  preloads.push(pending);
  return function TestPage(props: object) {
    if (!loaded) throw pending; // not preloaded yet: suspend until it is
    if ('error' in loaded) throw loaded.error;
    return createElement(loaded.module[name] as ComponentType<object>, props);
  };
}

/**
 * Whether a route error is a page's code failing to download: the network dropped before the
 * chunk was cached, or the server was updated and the old chunk is gone. Reloading fixes both.
 * Browsers word it differently (Chromium, Firefox, Safari), and Vite's preload helper too.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS|error loading dynamically imported|ChunkLoadError/i.test(
    `${error.name} ${error.message}`,
  );
}
