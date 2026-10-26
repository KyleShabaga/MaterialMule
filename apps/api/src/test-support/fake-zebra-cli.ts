// Runs the fake Zebra printer for manual testing without a ZD621 (MM-T15):
// `npm run mock:printer -w @materialmule/api`. Point the API's printer at 127.0.0.1 and this port
// (LABEL_PRINTER_HOST / LABEL_PRINTER_PORT, or Settings → Printers). Never used outside tests.
//   MOCK_PRINTER_PORT       port to listen on (default 9100)
//   MOCK_PRINTER_MODE       accept (default) | hang | drop  — see fake-zebra.ts
//   MOCK_PRINTER_PAPER_OUT  1 to report "out of labels" to status checks
import { FakeZebraPrinter, type FakeZebraMode } from './fake-zebra.js';

const port = Number(process.env.MOCK_PRINTER_PORT ?? 9100);
const mode = (process.env.MOCK_PRINTER_MODE ?? 'accept') as FakeZebraMode;
if (!['accept', 'hang', 'drop'].includes(mode)) {
  process.stderr.write('MOCK_PRINTER_MODE must be accept, hang or drop\n');
  process.exit(1);
}
const printer = await FakeZebraPrinter.start({
  port,
  mode,
  status: { paperOut: process.env.MOCK_PRINTER_PAPER_OUT === '1' },
});
process.stdout.write(`Fake Zebra printer (${mode}) listening on 127.0.0.1:${printer.port}\n`);

// Report each label as it arrives, with the readable ID it encodes.
let reported = 0;
const timer = setInterval(() => {
  const labels = printer.labels;
  for (; reported < labels.length; reported += 1) {
    const id = /(?:CT|BKT|ST|CRE)-\d{4}-\d{6}/.exec(labels.at(reported) ?? '')?.[0] ?? 'unknown';
    process.stdout.write(`Label ${reported + 1} received: ${id}\n`);
  }
}, 250);

const stop = () => {
  clearInterval(timer);
  void printer.stop().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
