import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
// jsdom has no IndexedDB; receiving drafts (TRP-T11) use this in-memory implementation in tests.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach } from 'vitest';
import { draftWritesSettled } from './receiving/drafts/store';

afterEach(async () => {
  cleanup();
  // Unmounting saves open drafts; let that finish, then start the next test with empty storage.
  await draftWritesSettled();
  globalThis.indexedDB = new IDBFactory();
});
