import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import {
  canMakeTestCertificates,
  makeTestCertificate,
  type TestCertificate,
} from '../test-support/self-signed-cert.js';
import { HSTS_HEADER_VALUE, httpsOptionsFrom, TlsConfigError } from './https.js';

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
// Port 1 refuses at once: health answers 503 without needing PostgreSQL.
const NO_DATABASE = 'postgres://nobody:nopw@127.0.0.1:1/nothing';

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: NO_DATABASE,
    SESSION_SECRET,
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

interface HttpsResult {
  status: number;
  hsts: string | undefined;
  protocol: string | null;
}

function getOverHttps(
  port: number,
  ca: Buffer,
  tls: {
    minVersion?: 'TLSv1' | 'TLSv1.2';
    maxVersion?: 'TLSv1.1' | 'TLSv1.3';
    ciphers?: string;
  } = {},
): Promise<HttpsResult> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', servername: 'localhost', port, path: '/api/health', ca, ...tls },
      (response) => {
        const socket = response.socket as import('node:tls').TLSSocket;
        const protocol = socket.getProtocol();
        response.resume();
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            hsts: response.headers['strict-transport-security'] as string | undefined,
            protocol,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('HTTPS hosting (TRP-T20)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves plain HTTP without HSTS when no certificate is configured', async () => {
    app = await createApp(config());
    await app.init();
    const response = await request(app.getHttpServer()).get('/api/health');
    expect(response.status).toBe(503);
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('names the setting, never the path, when a certificate file is missing', () => {
    const missing = 'C:/no/such/folder/secret-name.pfx';
    expect(() => httpsOptionsFrom(config({ TLS_PFX_FILE: missing }))).toThrowError(TlsConfigError);
    try {
      httpsOptionsFrom(config({ TLS_PFX_FILE: missing }));
    } catch (error) {
      expect((error as Error).message).toBe('TLS_PFX_FILE could not be read');
    }
  });

  // Certificates are made with .NET via PowerShell 7 (in memory, no certificate store). CI runs
  // on Windows with pwsh, so this never silently skips there.
  const certificates = process.env.CI === 'true' || canMakeTestCertificates();
  describe.runIf(certificates)('with a certificate', () => {
    let cert: TestCertificate;
    let ca: Buffer;

    beforeAll(() => {
      cert = makeTestCertificate();
      ca = readFileSync(cert.certFile);
    }, 60_000);

    afterAll(() => cert?.remove());

    async function listen(overrides: Record<string, string>): Promise<number> {
      app = await createApp(config(overrides));
      await app.listen(0, '127.0.0.1');
      return (app.getHttpServer().address() as AddressInfo).port;
    }

    it('serves HTTPS with HSTS from a PFX file and its passphrase', async () => {
      const port = await listen({
        TLS_PFX_FILE: cert.pfxFile,
        TLS_PFX_PASSPHRASE: cert.pfxPassphrase,
      });
      const result = await getOverHttps(port, ca);
      expect(result.status).toBe(503);
      expect(result.hsts).toBe(HSTS_HEADER_VALUE);
      expect(['TLSv1.2', 'TLSv1.3']).toContain(result.protocol);
    });

    it('serves HTTPS from a PEM certificate and key', async () => {
      const port = await listen({ TLS_CERT_FILE: cert.certFile, TLS_KEY_FILE: cert.keyFile });
      const result = await getOverHttps(port, ca);
      expect(result.hsts).toBe(HSTS_HEADER_VALUE);
    });

    it('refuses TLS 1.1 and older', async () => {
      const port = await listen({ TLS_CERT_FILE: cert.certFile, TLS_KEY_FILE: cert.keyFile });
      // The client is loosened as far as it goes, so only the server's floor can refuse.
      await expect(
        getOverHttps(port, ca, {
          minVersion: 'TLSv1',
          maxVersion: 'TLSv1.1',
          ciphers: 'DEFAULT@SECLEVEL=0',
        }),
      ).rejects.toThrow();
    });

    it('rejects a wrong PFX passphrase at startup without echoing it', async () => {
      const failure = await createApp(
        config({ TLS_PFX_FILE: cert.pfxFile, TLS_PFX_PASSPHRASE: 'wrong-passphrase' }),
      ).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).not.toContain('wrong-passphrase');
    });
  });
});
