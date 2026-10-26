import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig, loadConfigOrExit } from './env.js';

const SECRET = 'an-example-session-secret-that-is-long-enough';
const DB_URL = 'postgres://trapezoid:hunter2pw@127.0.0.1:5432/trapezoid_test';

const validEnv = {
  APP_ENV: 'test',
  DATABASE_URL: DB_URL,
  SESSION_SECRET: SECRET,
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
