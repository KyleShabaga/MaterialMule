import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

// Every message is written by hand so a validation error can never echo the value it rejected.
const envSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production'], {
    error: 'must be one of development, test, production',
  }),
  HOST: z.string({ error: 'must be a host name or IP address' }).min(1).default('127.0.0.1'),
  PORT: z.coerce
    .number({ error: 'must be a port number' })
    .int({ error: 'must be a whole number' })
    .min(1, { error: 'must be between 1 and 65535' })
    .max(65535, { error: 'must be between 1 and 65535' })
    .default(3000),
  DATABASE_URL: z
    .string({ error: 'is required' })
    .regex(/^postgres(ql)?:\/\/.+/, { error: 'must be a postgres:// connection URL' }),
  SESSION_SECRET: z
    .string({ error: 'is required' })
    .min(32, { error: 'must be at least 32 characters' }),
  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` })
    .default('info'),
  // Personal-account sign-ins expire this many hours after sign-in, never extended
  // (owner decision 2026-10-25: 12).
  PERSONAL_SESSION_HOURS: z.coerce
    .number({ error: 'must be a number of hours' })
    .int({ error: 'must be a whole number of hours' })
    .min(1, { error: 'must be between 1 and 168' })
    .max(168, { error: 'must be between 1 and 168' })
    .default(12),
  // Decides the year in storage unit IDs (owner decision 2026-10-25: America/Edmonton).
  BUSINESS_TIME_ZONE: z
    .string()
    .refine(isValidTimeZone, { error: 'must be an IANA time zone such as America/Edmonton' })
    .default('America/Edmonton'),
  // Development/test-only fixture sign-in (TRP-T33). Refused in production by loadConfig.
  ENABLE_TEST_AUTH: z
    .enum(['true', 'false'], { error: 'must be true or false' })
    .default('false')
    .transform((value) => value === 'true'),
});

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export type AppConfig = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Validates environment variables. Throws ConfigError naming each bad key, never its value. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  // Treat empty strings as unset so `SESSION_SECRET=` in a .env file reports "is required".
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (result.success) {
    if (result.data.APP_ENV === 'production' && result.data.ENABLE_TEST_AUTH) {
      throw new ConfigError(['ENABLE_TEST_AUTH must not be true when APP_ENV is production']);
    }
    return result.data;
  }
  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join('.');
    return cleaned[key] === undefined ? `${key} is required` : `${key} ${issue.message}`;
  });
  throw new ConfigError(problems);
}

/**
 * Loads the env file (ENV_FILE, default `.env` in the working directory) if present,
 * validates the environment and exits the process with a readable error when invalid.
 */
export function loadConfigOrExit(): AppConfig {
  const envFile = resolve(process.env.ENV_FILE ?? '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\nSee apps/api/.env.example.\n`);
      process.exit(1);
    }
    throw error;
  }
}
