import { describe, expect, it } from 'vitest';
import {
  cleanScannedValue,
  displayScannedValue,
  DuplicateScanFilter,
  SCAN_DUPLICATE_WINDOW_MS,
} from './scan-core';

describe('cleanScannedValue', () => {
  it('trims whitespace and drops control characters', () => {
    expect(cleanScannedValue('  BKT-2026-000014 \t')).toBe('BKT-2026-000014');
    expect(cleanScannedValue('\u0002BKT-2026-000014\r\n')).toBe('BKT-2026-000014');
    expect(cleanScannedValue('   ')).toBe('');
  });
});

describe('displayScannedValue', () => {
  it('shortens very long values', () => {
    expect(displayScannedValue('X'.repeat(80))).toBe(`${'X'.repeat(60)}…`);
    expect(displayScannedValue('ST-2026-000003')).toBe('ST-2026-000003');
  });
});

describe('DuplicateScanFilter (T1: 2 s duplicate window)', () => {
  it('ignores the same payload inside the window and accepts it again after', () => {
    let now = 1_000;
    const filter = new DuplicateScanFilter(SCAN_DUPLICATE_WINDOW_MS, () => now);
    expect(filter.accept('BKT-2026-000014')).toBe(true);
    now += 1_999;
    expect(filter.accept('BKT-2026-000014')).toBe(false);
    now += 1;
    expect(filter.accept('BKT-2026-000014')).toBe(true);
  });

  it('always accepts a different payload, which then becomes the one compared', () => {
    let now = 0;
    const filter = new DuplicateScanFilter(2_000, () => now);
    expect(filter.accept('BKT-2026-000014')).toBe(true);
    now += 100;
    expect(filter.accept('ST-2026-000003')).toBe(true);
    now += 100;
    expect(filter.accept('BKT-2026-000014')).toBe(true);
  });

  it('forgets the last payload on reset (Retry)', () => {
    const filter = new DuplicateScanFilter(2_000, () => 0);
    expect(filter.accept('CT-2026-000120')).toBe(true);
    filter.reset();
    expect(filter.accept('CT-2026-000120')).toBe(true);
  });
});
