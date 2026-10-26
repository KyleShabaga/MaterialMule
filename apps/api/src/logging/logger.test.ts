import type { IncomingMessage } from 'node:http';
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACTED, baseLoggerOptions, requestIdFor } from './logger.js';

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { logger: pino(baseLoggerOptions('info'), stream), lines };
}

describe('log redaction', () => {
  it('redacts authorization, cookies and set-cookie headers', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        req: { headers: { authorization: 'Bearer abc.def', cookie: 'sid=s3cr3t-cookie' } },
        res: { headers: { 'set-cookie': 'sid=new-s3cr3t' } },
      },
      'request',
    );
    const output = lines.join('');
    expect(output).not.toContain('abc.def');
    expect(output).not.toContain('s3cr3t-cookie');
    expect(output).not.toContain('new-s3cr3t');
    expect(output).toContain(REDACTED);
  });

  it('redacts password, token, secret and connection-string fields', () => {
    const { logger, lines } = captureLogger();
    logger.info({
      password: 'pw-value',
      user: { token: 'tok-value', secret: 'sec-value' },
      DATABASE_URL: 'postgres://u:dbpw@h/db',
      config: { SESSION_SECRET: 'session-value' },
    });
    const output = lines.join('');
    for (const value of ['pw-value', 'tok-value', 'sec-value', 'dbpw', 'session-value']) {
      expect(output).not.toContain(value);
    }
  });
});

describe('requestIdFor', () => {
  const request = (id?: string) =>
    ({ headers: { 'x-request-id': id } }) as unknown as IncomingMessage;

  it('reuses a well-formed incoming request ID', () => {
    expect(requestIdFor(request('abc12345-trace'))).toBe('abc12345-trace');
  });

  it('replaces a missing or malformed ID with a UUID', () => {
    expect(requestIdFor(request())).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFor(request('bad id\nwith newline'))).toMatch(/^[0-9a-f-]{36}$/);
  });
});
