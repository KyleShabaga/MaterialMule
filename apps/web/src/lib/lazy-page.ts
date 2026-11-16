import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

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
  if (import.meta.env.MODE === 'test') {
    // Unit tests only (the build drops this): start the import when routes.tsx is imported, and
    // test-setup.ts waits for every one before the file's tests run (testPagePreloads). Pages
    // then compile before the tests, as they did before the split, not inside a test's 1 s
    // findBy window on a slow CI runner. Rendering still suspends once.
    const loaded = load();
    loaded.catch(() => undefined); // a failure surfaces when the page renders
    preloads.push(loaded);
    load = () => loaded;
  }
  return lazy(async () => ({
    default: (await load())[name] as M[K] extends ComponentType<infer P> ? ComponentType<P> : never,
  }));
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
