/** Minimal `--name value` / `--flag` parsing for the benchmark commands. */
export function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args.set(arg.slice(2), 'true');
    } else {
      args.set(arg.slice(2), next);
      i++;
    }
  }
  return args;
}

/** Points the config loader at `--env-file` (default `.env.bench`) before it runs. */
export function useEnvFile(args: Map<string, string>): void {
  process.env.ENV_FILE = args.get('env-file') ?? process.env.ENV_FILE ?? '.env.bench';
}
