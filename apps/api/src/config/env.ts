import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
  // Guard on storage units per receipt (owner decision 2026-10-25: 50). It can be lowered, never
  // raised above 50, which the database also enforces.
  RECEIPT_MAX_UNITS: z.coerce
    .number({ error: 'must be a number of storage units' })
    .int({ error: 'must be a whole number' })
    .min(1, { error: 'must be between 1 and 50' })
    .max(50, { error: 'must be between 1 and 50' })
    .default(50),
  // Optional: serve the built web app (apps/web/dist) from the API's origin, as production will.
  WEB_DIST_DIR: z.string().min(1).optional(),
  // Development/test-only fixture sign-in (TRP-T33). Refused in production by loadConfig.
  ENABLE_TEST_AUTH: z
    .enum(['true', 'false'], { error: 'must be true or false' })
    .default('false')
    .transform((value) => value === 'true'),
  // Microsoft Entra ID sign-in (TRP-T05). Off unless tenant, client ID, secret and redirect URI
  // are all set; they come from IT's app registration. A partial set is refused at startup.
  MICROSOFT_TENANT_ID: z
    .string()
    .regex(GUID, { error: 'must be the directory (tenant) ID, a GUID' })
    .transform((value) => value.toLowerCase())
    .optional(),
  MICROSOFT_CLIENT_ID: z
    .string()
    .regex(GUID, { error: 'must be the application (client) ID, a GUID' })
    .optional(),
  MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
  MICROSOFT_REDIRECT_URI: z
    .url({ protocol: /^https?$/, error: 'must be an absolute http(s) URL' })
    .optional(),
  // Overridable only so tests can point at a mock tenant; production must use HTTPS.
  MICROSOFT_AUTHORITY_HOST: z
    .url({ protocol: /^https?$/, error: 'must be an absolute http(s) URL' })
    .default('https://login.microsoftonline.com'),
  MICROSOFT_GRAPH_BASE_URL: z
    .url({ protocol: /^https?$/, error: 'must be an absolute http(s) URL' })
    .default('https://graph.microsoft.com'),
  // The first administrator (Kyle): their Entra object ID (preferred) or, failing that, UPN.
  // Matching accounts become active admins at first sign-in; no first-user-wins logic.
  BOOTSTRAP_ADMIN_OBJECT_ID: z
    .string()
    .regex(GUID, { error: 'must be an Entra object ID, a GUID' })
    .transform((value) => value.toLowerCase())
    .optional(),
  BOOTSTRAP_ADMIN_UPN: z.string().min(3).max(320).optional(),
});

const MICROSOFT_REQUIRED = [
  'MICROSOFT_TENANT_ID',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_REDIRECT_URI',
] as const;

/** Cross-field rules zod can't express per key. Messages name keys only, never values. */
function crossFieldProblems(config: z.infer<typeof envSchema>): string[] {
  const problems: string[] = [];
  if (config.APP_ENV === 'production' && config.ENABLE_TEST_AUTH) {
    problems.push('ENABLE_TEST_AUTH must not be true when APP_ENV is production');
  }
  const present = MICROSOFT_REQUIRED.filter((key) => config[key] !== undefined);
  if (present.length > 0 && present.length < MICROSOFT_REQUIRED.length) {
    for (const key of MICROSOFT_REQUIRED.filter((k) => config[k] === undefined)) {
      problems.push(`${key} is required when Microsoft sign-in is configured`);
    }
  }
  if (config.APP_ENV === 'production') {
    for (const key of ['MICROSOFT_AUTHORITY_HOST', 'MICROSOFT_GRAPH_BASE_URL'] as const) {
      if (!config[key].startsWith('https://')) {
        problems.push(`${key} must use https in production`);
      }
    }
  }
  return problems;
}

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
    const problems = crossFieldProblems(result.data);
    if (problems.length > 0) {
      throw new ConfigError(problems);
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
