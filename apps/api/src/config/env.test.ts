import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig, loadConfigOrExit, tlsConfigured } from './env.js';

const SECRET = 'an-example-session-secret-that-is-long-enough';
const DB_URL = 'postgres://trapezoid:hunter2pw@127.0.0.1:5432/trapezoid_test';

const validEnv = {
  APP_ENV: 'test',
  DATABASE_URL: DB_URL,
  SESSION_SECRET: SECRET,
};

// The smallest production environment that loads (TRP-T20: HTTPS is required there).
const productionEnv = {
  ...validEnv,
  APP_ENV: 'production',
  TLS_PFX_FILE: 'C:/fictional/app.pfx',
};

describe('loadConfig', () => {
  it('accepts a valid environment and applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({ APP_ENV: 'test', PORT: 3000, HOST: '127.0.0.1' });
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('names every missing key', () => {
    expect(() => loadConfig({})).toThrowError(ConfigError);
    try {
      loadConfig({});
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain('APP_ENV is required');
      expect(message).toContain('DATABASE_URL is required');
      expect(message).toContain('SESSION_SECRET is required');
    }
  });

  it('treats an empty value as missing', () => {
    expect(() => loadConfig({ ...validEnv, SESSION_SECRET: '' })).toThrowError(
      /SESSION_SECRET is required/,
    );
  });

  it('never echoes rejected values', () => {
    const badEnv = {
      APP_ENV: 'staging-secret-env',
      DATABASE_URL: 'mysql://root:topsecretpw@db/app',
      SESSION_SECRET: 'too-short-secret',
      PORT: '99999',
    };
    try {
      loadConfig(badEnv);
      expect.unreachable('loadConfig should throw');
    } catch (error) {
      const message = (error as ConfigError).message;
      for (const value of Object.values(badEnv)) {
        expect(message).not.toContain(value);
      }
      expect(message).toContain('APP_ENV must be one of');
      expect(message).toContain('DATABASE_URL must be a postgres:// connection URL');
      expect(message).toContain('SESSION_SECRET must be at least 32 characters');
      expect(message).toContain('PORT must be between 1 and 65535');
    }
  });

  describe('Microsoft sign-in keys (TRP-T05)', () => {
    // Fictional values only.
    const microsoft = {
      MICROSOFT_TENANT_ID: '11111111-2222-4333-8444-555555555555',
      MICROSOFT_CLIENT_ID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      MICROSOFT_CLIENT_SECRET: 'fictional-client-secret-value',
      MICROSOFT_REDIRECT_URI: 'https://trapezoid.example.test/sign-in/microsoft/callback',
    };

    it('is optional, and complete sets load with Microsoft defaults', () => {
      expect(loadConfig(validEnv).MICROSOFT_TENANT_ID).toBeUndefined();
      expect(loadConfig({ ...validEnv, ...microsoft })).toMatchObject({
        MICROSOFT_AUTHORITY_HOST: 'https://login.microsoftonline.com',
        MICROSOFT_GRAPH_BASE_URL: 'https://graph.microsoft.com',
      });
    });

    it('refuses a partial set, naming the missing keys but never the secret', () => {
      const partial = { ...validEnv, ...microsoft, MICROSOFT_REDIRECT_URI: '' };
      expect(() => loadConfig(partial)).toThrowError(
        /MICROSOFT_REDIRECT_URI is required when Microsoft sign-in is configured/,
      );
      try {
        loadConfig({ ...partial, MICROSOFT_TENANT_ID: 'not-a-guid' });
      } catch (error) {
        const message = (error as ConfigError).message;
        expect(message).toContain('MICROSOFT_TENANT_ID must be the directory (tenant) ID');
        expect(message).not.toContain('not-a-guid');
        expect(message).not.toContain(microsoft.MICROSOFT_CLIENT_SECRET);
      }
    });

    it('requires https Microsoft endpoints in production', () => {
      expect(() =>
        loadConfig({
          ...validEnv,
          ...microsoft,
          APP_ENV: 'production',
          MICROSOFT_AUTHORITY_HOST: 'http://127.0.0.1:4100',
        }),
      ).toThrowError(/MICROSOFT_AUTHORITY_HOST must use https in production/);
    });

    it('requires an https redirect URI in production', () => {
      expect(() =>
        loadConfig({
          ...productionEnv,
          ...microsoft,
          MICROSOFT_REDIRECT_URI: 'http://trapezoid.example.test/sign-in/microsoft/callback',
        }),
      ).toThrowError(/MICROSOFT_REDIRECT_URI must use https in production/);
      expect(loadConfig({ ...productionEnv, ...microsoft }).MICROSOFT_REDIRECT_URI).toMatch(
        /^https:/,
      );
    });
  });

  describe('HTTPS certificate keys (TRP-T20)', () => {
    it('are optional outside production', () => {
      expect(tlsConfigured(loadConfig(validEnv))).toBe(false);
    });

    it('are required in production', () => {
      expect(() => loadConfig({ ...validEnv, APP_ENV: 'production' })).toThrowError(
        /TLS_PFX_FILE \(or TLS_CERT_FILE and TLS_KEY_FILE\) is required in production/,
      );
      expect(tlsConfigured(loadConfig(productionEnv))).toBe(true);
      expect(
        tlsConfigured(
          loadConfig({
            ...validEnv,
            APP_ENV: 'production',
            TLS_CERT_FILE: 'C:/fictional/app.crt',
            TLS_KEY_FILE: 'C:/fictional/app.key',
          }),
        ),
      ).toBe(true);
    });

    it('accept exactly one complete certificate form', () => {
      expect(() =>
        loadConfig({ ...productionEnv, TLS_CERT_FILE: 'C:/fictional/app.crt' }),
      ).toThrowError(/TLS_PFX_FILE must not be combined/);
      expect(() => loadConfig({ ...validEnv, TLS_CERT_FILE: 'C:/fictional/app.crt' })).toThrowError(
        /TLS_CERT_FILE and TLS_KEY_FILE must be set together/,
      );
      expect(() =>
        loadConfig({ ...validEnv, TLS_PFX_PASSPHRASE: 'fictional-passphrase' }),
      ).toThrowError(/TLS_PFX_PASSPHRASE is only used with TLS_PFX_FILE/);
    });

    it('never echoes the passphrase', () => {
      try {
        loadConfig({ ...validEnv, TLS_PFX_PASSPHRASE: 'fictional-passphrase' });
        expect.unreachable('loadConfig should throw');
      } catch (error) {
        expect((error as ConfigError).message).not.toContain('fictional-passphrase');
      }
    });
  });
});

describe('loadConfigOrExit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes the problems to stderr and exits with code 1', () => {
    vi.stubEnv('ENV_FILE', 'does-not-exist.env');
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('SESSION_SECRET', SECRET);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => loadConfigOrExit()).toThrowError('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('DATABASE_URL is required');
    expect(output).not.toContain(SECRET);
  });
});
