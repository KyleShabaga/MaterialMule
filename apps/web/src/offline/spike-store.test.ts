import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shellFiles } from '../../offline-shell-plugin';
import {
  checkDraft,
  clearFiller,
  createDevice,
  fillStorage,
  incrementDeviceCounter,
  randomBlob,
  readDevice,
  saveDraft,
} from './spike-store';

// MM-V2-C11 spike probes, against fake-indexeddb (test-setup.ts). Device results come only from
// the real phones; these tests only show the probes report what they store.

describe('offline spike draft probe', () => {
  // fake-indexeddb can't clone jsdom Blobs, so the byte check runs on the ArrayBuffer format;
  // Blob storage is exactly what the phone runs check.
  it('reads back a saved draft and its photo bytes', async () => {
    const photo = randomBlob(300_000, 'image/jpeg');
    await saveDraft({
      note: 'DEMO-2601 TH26-01',
      photo,
      photoName: 'photo.jpg',
      photoFormat: 'arraybuffer',
      shellVersion: 'abc',
      now: new Date('2026-11-01T12:00:00Z'),
    });
    const check = await checkDraft(new Date('2026-11-09T12:00:00Z'));
    expect(check).toMatchObject({
      found: true,
      note: 'DEMO-2601 TH26-01',
      photoSize: 300_000,
      sizeMatches: true,
      hashMatches: true,
      savedWithShell: 'abc',
    });
    expect(check.ageDays).toBeCloseTo(8);
  });
});

describe('offline spike device code probe', () => {
  it('keeps one code and counts up in IndexedDB and localStorage', async () => {
    await createDevice();
    await incrementDeviceCounter();
    const readings = await readDevice();
    expect(readings.indexedDb.ok && readings.indexedDb.value?.counter).toBe(1);
    expect(readings.localStorage.ok && readings.localStorage.value?.code).toBe(
      readings.indexedDb.ok && readings.indexedDb.value?.code,
    );
    // jsdom has neither Cache Storage nor OPFS; the probe reports that rather than throwing.
    expect(readings.cacheStorage.ok).toBe(false);
  });
});

describe('offline spike low-storage probe', () => {
  it('stops at the limit and clears its filler', async () => {
    const progress: number[] = [];
    const result = await fillStorage({
      chunkMb: 1,
      limitMb: 2,
      onProgress: (mb) => progress.push(mb),
    });
    expect(result).toEqual({ writtenMb: 2, stoppedBy: 'limit' });
    expect(progress).toEqual([1, 2]);
    await clearFiller();
  });
});

describe('offline shell file list', () => {
  it('precaches the build except the worker, .woff fallbacks and source maps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-shell-'));
    try {
      mkdirSync(join(dir, 'assets'));
      mkdirSync(join(dir, 'icons'));
      for (const file of [
        'index.html',
        'sw.js',
        'manifest.webmanifest',
        'icons/icon-192.png',
        'assets/index-1.js',
        'assets/index-1.js.map',
        'assets/font.woff',
        'assets/font.woff2',
      ]) {
        writeFileSync(join(dir, file), 'x');
      }
      expect(shellFiles(dir)).toEqual([
        '/assets/font.woff2',
        '/assets/index-1.js',
        '/icons/icon-192.png',
        '/index.html',
        '/manifest.webmanifest',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
