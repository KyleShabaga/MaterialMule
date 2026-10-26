import { afterEach, describe, expect, it } from 'vitest';
import { FakeZebraPrinter } from '../test-support/fake-zebra.js';
import { ZebraTcpTransport } from './zebra-client.js';

const FAST = { connectTimeoutMs: 1_000, statusTimeoutMs: 300, sendTimeoutMs: 500 };
const LABELS = '^XA^FDBKT-2026-000014^FS^XZ\n^XA^FDBKT-2026-000015^FS^XZ\n'.repeat(20);

describe('ZebraTcpTransport against a fake printer (T3)', () => {
  let printer: FakeZebraPrinter | undefined;
  const transport = new ZebraTcpTransport(FAST);

  afterEach(async () => {
    await printer?.stop();
    printer = undefined;
  });

  it('accept → sent, with every byte received after a status check', async () => {
    printer = await FakeZebraPrinter.start();
    const outcome = await transport.send(
      { host: printer.host, port: printer.port, checkStatus: true },
      LABELS,
    );
    expect(outcome).toEqual({ result: 'sent' });
    expect(printer.statusQueries).toBe(1);
    expect(printer.jobs).toEqual([LABELS]);
  });

  it('sends without a status check when the printer is set that way', async () => {
    printer = await FakeZebraPrinter.start();
    const outcome = await transport.send(
      { host: printer.host, port: printer.port, checkStatus: false },
      LABELS,
    );
    expect(outcome).toEqual({ result: 'sent' });
    expect(printer.statusQueries).toBe(0);
    expect(printer.jobs).toEqual([LABELS]);
  });

  it('refuse → not sent', async () => {
    const port = await FakeZebraPrinter.unusedPort();
    const outcome = await transport.send({ host: '127.0.0.1', port, checkStatus: true }, LABELS);
    expect(outcome).toMatchObject({ result: 'not_sent', error: 'Printer refused the connection' });
  });

  it('hang → not sent (no label byte leaves before the printer answers)', async () => {
    printer = await FakeZebraPrinter.start({ mode: 'hang' });
    const outcome = await transport.send(
      { host: printer.host, port: printer.port, checkStatus: true },
      LABELS,
    );
    expect(outcome).toMatchObject({
      result: 'not_sent',
      error: "Printer didn't answer the status check",
    });
    expect(printer.jobs).toEqual([]);
  });

  it('drop mid-stream → uncertain', async () => {
    printer = await FakeZebraPrinter.start({ mode: 'drop', dropAfterBytes: 40 });
    const outcome = await transport.send(
      { host: printer.host, port: printer.port, checkStatus: true },
      LABELS,
    );
    expect(outcome.result).toBe('uncertain');
    expect(printer.jobs[0]).toHaveLength(40);
  });

  it('hang after label bytes (no status check) → uncertain, never sent', async () => {
    printer = await FakeZebraPrinter.start({ mode: 'hang' });
    const outcome = await transport.send(
      { host: printer.host, port: printer.port, checkStatus: false },
      LABELS,
    );
    expect(outcome).toMatchObject({ result: 'uncertain' });
  });

  it('paper out → not sent, with the printer message', async () => {
    printer = await FakeZebraPrinter.start({ status: { paperOut: true, paused: true } });
    const outcome = await transport.send(
      { host: printer.host, port: printer.port, checkStatus: true },
      LABELS,
    );
    expect(outcome).toEqual({
      result: 'not_sent',
      error: 'Printer out of labels',
      printerMessage: 'Printer out of labels',
    });
    expect(printer.jobs).toEqual([]);
  });
});
