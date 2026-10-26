import { FakeZebraPrinter } from '../../apps/api/src/test-support/fake-zebra';

/**
 * Starts the fake Zebra printer the E2E API prints to (LABEL_PRINTER_HOST/PORT in
 * playwright.config.ts). It accepts every job like a working ZD621; fault cases (refused, hang,
 * dropped mid-stream) are covered by the API integration tests.
 */
export default async function globalSetup() {
  const port = Number(process.env.E2E_FAKE_PRINTER_PORT);
  const printer = await FakeZebraPrinter.start({ port });
  return async () => {
    await printer.stop();
  };
}
