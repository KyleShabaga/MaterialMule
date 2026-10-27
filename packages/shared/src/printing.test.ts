import { describe, expect, it } from 'vitest';
import {
  createPrintJobRequestSchema,
  printJobStatusText,
  putPrintersRequestSchema,
} from './printing';

const job = (overrides: Partial<Parameters<typeof printJobStatusText>[0]> = {}) =>
  printJobStatusText({
    status: 'queued',
    attempts: 0,
    printerMessage: null,
    physicallyConfirmedAt: null,
    ...overrides,
  });

describe('printJobStatusText', () => {
  it('uses the card wording and never claims a physical print without confirmation', () => {
    expect(job({ status: 'sent' }).label).toBe('Sent to printer');
    expect(job({ status: 'failed' }).label).toBe("Printer didn't respond — not printed");
    expect(job({ status: 'uncertain' })).toMatchObject({
      label: 'Unknown — check the printer before reprinting',
      hint: 'Check the printer, then Reprint or Mark as printed.',
    });
    for (const status of ['queued', 'sending', 'sent', 'failed', 'uncertain'] as const) {
      expect(job({ status }).label).not.toMatch(/^Printed|as printed/);
    }
  });

  it('only says printed once a person confirmed it', () => {
    const at = '2026-10-26T16:00:00.000Z';
    expect(job({ status: 'sent', physicallyConfirmedAt: at }).label).toBe('Printed (confirmed)');
    expect(job({ status: 'uncertain', physicallyConfirmedAt: at }).label).toBe('Marked as printed');
  });

  it('MM-T61: an uncertain job marked printed says so and who confirmed it', () => {
    const at = '2026-10-26T16:00:00.000Z';
    expect(
      job({
        status: 'uncertain',
        physicallyConfirmedAt: at,
        physicallyConfirmedBy: { userId: 'u1', initials: 'JS', name: 'Jordan Smith' },
      }),
    ).toEqual({
      label: 'Marked as printed',
      tone: 'success',
      hint: 'The printer result was uncertain; JS · Jordan Smith marked it as printed.',
    });
    expect(
      job({
        status: 'uncertain',
        physicallyConfirmedAt: at,
        physicallyConfirmedBy: { userId: 'u2', initials: null, name: 'Noor New' },
      }).hint,
    ).toBe('The printer result was uncertain; Noor New marked it as printed.');
    // Without the person (e.g. the dashboard's latest print), it still says it was uncertain.
    expect(job({ status: 'uncertain', physicallyConfirmedAt: at }).hint).toBe(
      'The printer result was uncertain; a person marked it as printed.',
    );
  });

  it('MM-T61: a failed job says how many attempts were made', () => {
    expect(job({ status: 'failed', attempts: 3 }).hint).toBe(
      'Tried 3 times. Fix the printer, then Reprint.',
    );
    expect(job({ status: 'failed', attempts: 1 }).hint).toBe(
      'Tried once. Fix the printer, then Reprint.',
    );
  });

  it('shows printer messages such as out of labels', () => {
    expect(job({ status: 'failed', printerMessage: 'Printer out of labels' }).label).toBe(
      'Printer out of labels — not printed',
    );
    expect(
      job({ status: 'queued', attempts: 1, printerMessage: 'Printer out of labels' }).label,
    ).toBe('Printer out of labels — trying again');
  });
});

describe('createPrintJobRequestSchema', () => {
  const id = '00000000-0000-4000-8000-000000000501';

  it('accepts storage units, a kind and an optional printer key', () => {
    expect(
      createPrintJobRequestSchema.parse({
        storageUnitIds: [id],
        kind: 'reprint',
        printerId: 'receiving',
      }),
    ).toEqual({ storageUnitIds: [id], kind: 'reprint', printerId: 'receiving' });
  });

  it('rejects host addresses, extra fields and duplicates', () => {
    for (const body of [
      { storageUnitIds: [id], kind: 'initial', host: '10.0.0.5' },
      { storageUnitIds: [id], kind: 'initial', printerId: '10.0.0.5:9100' },
      { storageUnitIds: [id, id], kind: 'initial' },
      { storageUnitIds: [], kind: 'initial' },
      { storageUnitIds: [id], kind: 'other' },
    ]) {
      expect(createPrintJobRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('putPrintersRequestSchema', () => {
  it('fills defaults and allows only one default printer', () => {
    expect(
      putPrintersRequestSchema.parse({
        printers: [{ id: 'receiving', name: 'ZD621', host: '10.0.0.5' }],
      }).printers[0],
    ).toMatchObject({ port: 9100, enabled: true, isDefault: false, checkStatus: true });
    expect(
      putPrintersRequestSchema.safeParse({
        printers: [
          { id: 'a', name: 'A', host: '10.0.0.5', isDefault: true },
          { id: 'b', name: 'B', host: '10.0.0.6', isDefault: true },
        ],
      }).success,
    ).toBe(false);
    expect(
      putPrintersRequestSchema.safeParse({ printers: [{ id: 'a', name: 'A', host: 'http://x' }] })
        .success,
    ).toBe(false);
  });
});
