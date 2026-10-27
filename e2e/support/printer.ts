/**
 * Makes the fake Zebra printer reset the connection part-way through the next print job whose
 * label data contains `marker` (e.g. a storage unit ID), once (MM-T18). Other jobs, including
 * those from tests running in parallel, print normally.
 */
export async function dropNextPrintJobContaining(marker: string): Promise<void> {
  const base = process.env.E2E_FAKE_PRINTER_CONTROL_URL;
  if (!base) throw new Error('E2E_FAKE_PRINTER_CONTROL_URL is not set (see global-setup.ts)');
  const response = await fetch(`${base}/drop-next-job?marker=${encodeURIComponent(marker)}`, {
    method: 'POST',
  });
  if (response.status !== 204) {
    throw new Error(`Fake printer control refused the request: HTTP ${response.status}`);
  }
}
