import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config/env.js';
import { hstsMiddleware, httpsOptionsFrom } from './hosting/https.js';
import { serveWebApp } from './web-static.js';

/** Builds the configured application without listening, so tests and main.ts share one setup. */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  // HTTPS when a certificate is configured (required in production, MM-T20).
  const httpsOptions = httpsOptionsFrom(config);
  // Nest's HttpsOptions type lags Node's (e.g. minVersion); Nest passes it to https.createServer.
  const app = await NestFactory.create(AppModule.forRoot(config), {
    bufferLogs: true,
    httpsOptions: httpsOptions as NestApplicationOptions['httpsOptions'],
  });
  app.useLogger(app.get(Logger));
  if (httpsOptions) {
    app.use(hstsMiddleware);
  }
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  if (config.WEB_DIST_DIR) {
    serveWebApp(app, config.WEB_DIST_DIR);
  }
  return app;
}
