import { readFileSync } from 'node:fs';
import type { ServerOptions } from 'node:https';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config/env.js';

/** A year, as browsers expect for HSTS. No includeSubDomains: other internal hosts aren't ours. */
export const HSTS_HEADER_VALUE = 'max-age=31536000';

export class TlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsConfigError';
  }
}

function readKeyFile(key: 'TLS_PFX_FILE' | 'TLS_CERT_FILE' | 'TLS_KEY_FILE', path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    // Name the setting, never its value or the file's contents.
    throw new TlsConfigError(`${key} could not be read`);
  }
}

/**
 * HTTPS options for the configured certificate (MM-T20), or undefined when the API serves plain
 * HTTP (development, test, E2E). TLS 1.2 is the floor; Node's default ciphers apply.
 */
export function httpsOptionsFrom(config: AppConfig): ServerOptions | undefined {
  const base: ServerOptions = { minVersion: 'TLSv1.2' };
  if (config.TLS_PFX_FILE) {
    return {
      ...base,
      pfx: readKeyFile('TLS_PFX_FILE', config.TLS_PFX_FILE),
      passphrase: config.TLS_PFX_PASSPHRASE,
    };
  }
  if (config.TLS_CERT_FILE && config.TLS_KEY_FILE) {
    return {
      ...base,
      cert: readKeyFile('TLS_CERT_FILE', config.TLS_CERT_FILE),
      key: readKeyFile('TLS_KEY_FILE', config.TLS_KEY_FILE),
    };
  }
  return undefined;
}

/** Strict-Transport-Security on every response, so browsers keep to HTTPS on this host name. */
export function hstsMiddleware(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader('Strict-Transport-Security', HSTS_HEADER_VALUE);
  next();
}
