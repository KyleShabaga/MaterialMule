/**
 * The benchmark drops and rebuilds its database, so it refuses anything that could be a real one
 * (TRP-T19): APP_ENV must not be production and the database name must contain "bench" or "test".
 * Messages name the rule, never the connection string (it holds a password).
 */
export class BenchTargetRefusedError extends Error {
  override name = 'BenchTargetRefusedError';
}

/** The database name in a postgres:// URL, or undefined when it has none. */
export function databaseNameOf(databaseUrl: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

/** Returns the database name when the target is safe to benchmark; throws otherwise. */
export function assertBenchTarget(databaseUrl: string, appEnv: string): string {
  if (appEnv === 'production') {
    throw new BenchTargetRefusedError('Refusing to benchmark with APP_ENV=production.');
  }
  const name = databaseNameOf(databaseUrl);
  if (!name) {
    throw new BenchTargetRefusedError('Refusing to benchmark: DATABASE_URL names no database.');
  }
  if (!/bench|test/i.test(name)) {
    throw new BenchTargetRefusedError(
      'Refusing to benchmark: the database name must contain "bench" or "test" ' +
        '(the benchmark drops and rebuilds it).',
    );
  }
  return name;
}
