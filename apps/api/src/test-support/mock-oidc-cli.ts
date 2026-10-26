// Runs the fictional Microsoft tenant for E2E (TRP-T05): `tsx src/test-support/mock-oidc-cli.ts`.
// MOCK_IDP_PORT picks the port. Never used outside tests.
import { startMockOidc } from './mock-oidc.js';

const port = Number(process.env.MOCK_IDP_PORT ?? 4100);
const mock = await startMockOidc(port);
process.stdout.write(`Mock Microsoft tenant listening on ${mock.url}\n`);

const stop = () => {
  void mock.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
