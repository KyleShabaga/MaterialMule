import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
// jsdom has no IndexedDB; receiving drafts (MM-T11) use this in-memory implementation in tests.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll } from 'vitest';
import { testPagePreloads } from './lib/lazy-page';
import { draftWritesSettled } from './receiving/drafts/store';

// jsdom has no ResizeObserver; Radix (tooltips, menus, hover cards, popovers) measures with it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
// Nor scrollIntoView; the Ctrl K menu (cmdk) scrolls the highlighted row into view.
if (typeof Element !== 'undefined') Element.prototype.scrollIntoView ??= () => {};

// Pages load lazily (STRATA-132). A file that imports routes.tsx starts every page's import;
// finish compiling them before its tests, so a test's findBy never waits on the compiler.
beforeAll(async () => {
  await Promise.allSettled(testPagePreloads());
}, 120_000);

afterEach(async () => {
  cleanup();
  // Unmounting saves open drafts; let that finish, then start the next test with empty storage.
  await draftWritesSettled();
  globalThis.indexedDB = new IDBFactory();
});
