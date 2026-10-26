import 'reflect-metadata';
import type { Server } from 'node:http';
import { loadConfigOrExit } from './config/env.js';
import { createApp } from './create-app.js';

// Keep idle connections open longer than browsers and HTTP clients do, so the server never closes
// a socket at the moment a client reuses it (that race silently loses the request). The headers
// timeout must exceed the keep-alive timeout.
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

async function bootstrap(): Promise<void> {
  const config = loadConfigOrExit();
  const app = await createApp(config);
  const server = app.getHttpServer() as Server;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;
  await app.listen(config.PORT, config.HOST);
}

void bootstrap();
