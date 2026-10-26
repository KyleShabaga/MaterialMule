import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { LoggerOptions } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import type { AppConfig } from '../config/env.js';

export const REDACTED = '[REDACTED]';

/** Log paths that must never be written. Extend this list rather than logging around it. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'newPassword',
  '*.newPassword',
  'passwordHash',
  '*.passwordHash',
  'password_hash',
  '*.password_hash',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'sessionSecret',
  '*.sessionSecret',
  'databaseUrl',
  '*.databaseUrl',
  'DATABASE_URL',
  '*.DATABASE_URL',
  'SESSION_SECRET',
  '*.SESSION_SECRET',
  'MICROSOFT_CLIENT_SECRET',
  '*.MICROSOFT_CLIENT_SECRET',
  'clientSecret',
  '*.clientSecret',
  'accessToken',
  '*.accessToken',
  'codeVerifier',
  '*.codeVerifier',
  'TLS_PFX_PASSPHRASE',
  '*.TLS_PFX_PASSPHRASE',
  'passphrase',
  '*.passphrase',
];

export const REQUEST_ID_HEADER = 'x-request-id';

export function baseLoggerOptions(level: AppConfig['LOG_LEVEL']): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
  };
}

/** Reuses a well-formed incoming request ID, otherwise generates one. */
export function requestIdFor(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  if (typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming)) {
    return incoming;
  }
  return randomUUID();
}

export function pinoHttpOptions(config: AppConfig): PinoHttpOptions {
  return {
    ...baseLoggerOptions(config.LOG_LEVEL),
    genReqId: (req, res) => {
      const id = requestIdFor(req);
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    // Human-readable output in development; JSON everywhere else.
    transport:
      config.APP_ENV === 'development'
        ? { target: 'pino-pretty', options: { singleLine: true } }
        : undefined,
  };
}
