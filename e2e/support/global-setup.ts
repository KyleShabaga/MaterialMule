import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeZebraPrinter } from '../../apps/api/src/test-support/fake-zebra';

/**
 * Starts the fake Zebra printer the E2E API prints to (LABEL_PRINTER_HOST/PORT in
 * playwright.config.ts). It accepts every job like a working ZD621; fault cases (refused, hang,
 * dropped mid-stream) are covered by the API integration tests.
 *
 * TRP-T18: a small loopback control endpoint lets a test make one specific job fail mid-stream
 * (see e2e/support/printer.ts) without disturbing jobs from tests running in parallel. Its URL
 * reaches the test workers through E2E_FAKE_PRINTER_CONTROL_URL.
 */
export default async function globalSetup() {
  const port = Number(process.env.E2E_FAKE_PRINTER_PORT);
  const printer = await FakeZebraPrinter.start({ port });

  const control = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const marker = url.searchParams.get('marker');
    if (request.method === 'POST' && url.pathname === '/drop-next-job' && marker) {
      printer.dropJobsContaining.add(marker);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
  const { port: controlPort } = control.address() as AddressInfo;
  process.env.E2E_FAKE_PRINTER_CONTROL_URL = `http://127.0.0.1:${controlPort}`;

  return async () => {
    await new Promise<void>((resolve) => control.close(() => resolve()));
    await printer.stop();
  };
}
