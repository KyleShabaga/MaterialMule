// `npm run bench:load -- [--duration 120] [--warmup 15] [--rate 1] [--port 3219 | --url URL]
//                        [--seed N] [--label text] [--out results.json] [--env-file F]`
// --rate is requests per second per connection; 0 removes pacing (saturation run).
// Runs the TRP-T19 concurrent workload against the benchmark database named in the env file
// (default apps/api/.env.bench). Without --url it starts the built API (apps/api/dist, so run
// `npm run build` first) on 127.0.0.1:<port> with test sign-in enabled and stops it afterwards.
// Then it checks correctness (unique IDs, consistent audit) and prints p50/p95/p99 per request kind.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import autocannon, { type AutocannonRequest, type AutocannonResult } from 'autocannon';
import type { ConfirmReceiptResponse } from '@trapezoid/shared';
import { Pool } from 'pg';
import { loadConfigOrExit } from '../config/env.js';
import { parseArgs, useEnvFile } from './cli-args.js';
import { assertBenchTarget } from './guard.js';
import { DEFAULT_BENCH_SEED, SeededRandom } from './random.js';
import { summarise, type LatencySummary } from './stats.js';
import { verifyIntegrity, type IntegrityReport } from './verify.js';
import { buildScenarios, loadTargets, type PlannedRequest, type Scenario } from './workload.js';

const API_DIR = fileURLToPath(new URL('../../', import.meta.url));
const CSRF = { 'x-trapezoid-csrf': '1' };

interface KindStats {
  latencies: number[];
  statuses: Record<string, number>;
  unexpected: number;
}

interface ScenarioOutcome {
  scenario: string;
  description: string;
  connections: number;
  p95TargetMs?: number;
  probe: boolean;
  requests: number;
  errors: number;
  timeouts: number;
  kinds: Record<string, KindStats>;
}

function businessToday(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function waitForHealth(baseUrl: string, api: ChildProcess | undefined): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (api && api.exitCode !== null)
      throw new Error('The API exited during startup; see its log.');
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`The API at ${baseUrl} did not become healthy within 60 s.`);
}

async function signIn(baseUrl: string, fixtureKey: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/test/sign-in`, {
    method: 'POST',
    headers: { ...CSRF, 'content-type': 'application/json' },
    body: JSON.stringify({ fixtureKey }),
  });
  if (response.status !== 204) {
    throw new Error(
      `Test sign-in as ${fixtureKey} failed (HTTP ${response.status}). The API needs ` +
        'ENABLE_TEST_AUTH=true and APP_ENV=test, and the bench database the dev fixtures.',
    );
  }
  const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]);
  return cookie.join('; ');
}

function runScenario(
  baseUrl: string,
  scenario: Scenario,
  cookie: string,
  random: SeededRandom,
  timing: { seconds: number; rate: number },
  collect: ScenarioOutcome | undefined,
  onCreated: (body: string) => void,
): Promise<AutocannonResult> {
  let answered: PlannedRequest | undefined;
  const request: AutocannonRequest = {
    setupRequest: (req, context) => {
      const planned = scenario.next(random);
      context.planned = planned;
      const headers: Record<string, string> = {};
      if (planned.withSession !== false) headers.cookie = cookie;
      if (planned.method === 'POST') {
        headers['content-type'] = 'application/json';
        if (planned.withCsrf !== false) Object.assign(headers, CSRF);
      }
      return { ...req, method: planned.method, path: planned.path, headers, body: planned.body };
    },
    // Called synchronously just before autocannon's 'response' event for the same request.
    onResponse: (status, body, context) => {
      answered = context.planned as PlannedRequest;
      if (!collect) {
        if (status === 201) onCreated(body);
        return;
      }
      const stats = (collect.kinds[answered.kind] ??= {
        latencies: [],
        statuses: {},
        unexpected: 0,
      });
      stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
      if (!answered.expect.includes(status)) stats.unexpected++;
      if (status === 201) onCreated(body);
    },
  };
  return new Promise((resolveRun, rejectRun) => {
    const instance = autocannon(
      {
        url: baseUrl,
        connections: scenario.connections,
        // 0 = as fast as each connection can go (saturation run).
        connectionRate: timing.rate > 0 ? timing.rate : undefined,
        duration: timing.seconds,
        timeout: 10,
        requests: [request],
      },
      (error, result) => (error ? rejectRun(error) : resolveRun(result)),
    );
    instance.on('response', (_client: unknown, _status: number, _bytes: number, ms: number) => {
      if (collect && answered) collect.kinds[answered.kind]!.latencies.push(ms);
    });
  });
}

async function systemInfo(pool: Pool) {
  const settings = await pool.query<{ name: string; setting: string; unit: string | null }>(
    `SELECT name, setting, unit FROM pg_settings
     WHERE name IN ('shared_buffers', 'work_mem', 'effective_cache_size', 'max_connections',
                    'random_page_cost', 'jit', 'maintenance_work_mem', 'synchronous_commit',
                    'max_parallel_workers_per_gather')
     ORDER BY name`,
  );
  const version = await pool.query<{ version: string }>('SELECT version()');
  const size = await pool.query<{ size: string }>(
    'SELECT pg_size_pretty(pg_database_size(current_database())) AS size',
  );
  return {
    os: `${os.version()} (${os.release()}, ${os.arch()})`,
    cpu: `${os.cpus()[0]?.model.trim()} x ${os.cpus().length} logical`,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    postgres: version.rows[0]!.version,
    databaseSize: size.rows[0]!.size,
    settings: Object.fromEntries(
      settings.rows.map((s) => [s.name, `${s.setting}${s.unit ? ` ${s.unit}` : ''}`]),
    ),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  useEnvFile(args);
  const config = loadConfigOrExit();
  const database = assertBenchTarget(config.DATABASE_URL, config.APP_ENV);
  const duration = Number(args.get('duration') ?? 120);
  const warmup = Number(args.get('warmup') ?? 15);
  const seed = Number(args.get('seed') ?? DEFAULT_BENCH_SEED);
  const port = Number(args.get('port') ?? 3219);
  const rate = Number(args.get('rate') ?? 1);
  const baseUrl = args.get('url') ?? `http://127.0.0.1:${port}`;
  const log = (message: string) => process.stdout.write(`${message}\n`);

  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
  let api: ChildProcess | undefined;
  try {
    if (!args.has('url')) {
      const main = resolve(API_DIR, 'dist/main.js');
      if (!existsSync(main))
        throw new Error('apps/api/dist is missing: run `npm run build` first.');
      const logFile = resolve(os.tmpdir(), `trapezoid-bench-api-${port}.log`);
      const out = createWriteStream(logFile);
      api = spawn(process.execPath, [main], {
        cwd: API_DIR,
        env: {
          ...process.env,
          ENV_FILE: resolve(API_DIR, process.env.ENV_FILE!),
          HOST: '127.0.0.1',
          PORT: String(port),
          ENABLE_TEST_AUTH: 'true',
          // Production logs at info (deploy/windows/trapezoid.env.example); keep that cost in.
          LOG_LEVEL: args.get('log-level') ?? 'info',
          WEB_DIST_DIR: '',
          LABEL_PRINTER_HOST: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      api.stdout!.pipe(out);
      api.stderr!.pipe(out);
      log(`Started API on ${baseUrl} (log: ${logFile})`);
    }
    await waitForHealth(baseUrl, api);

    const targets = await loadTargets(pool);
    const endYear = Number(businessToday(config.BUSINESS_TIME_ZONE).slice(0, 4));
    const scenarios = buildScenarios(targets, {
      endYear,
      receivedDate: businessToday(config.BUSINESS_TIME_ZONE),
    });
    const cookies = new Map<string, string>();
    for (const scenario of scenarios) {
      if (!cookies.has(scenario.account)) {
        cookies.set(scenario.account, await signIn(baseUrl, scenario.account));
      }
    }
    log(
      `Database ${database}: ${targets.readableIds.length} storage units, ` +
        `${targets.projects.length} projects with test holes`,
    );

    const since = (await pool.query<{ now: Date }>('SELECT now()')).rows[0]!.now;
    const issued: string[] = [];
    let created = 0;
    const onCreated = (body: string) => {
      created++;
      const parsed = JSON.parse(body) as ConfirmReceiptResponse;
      for (const unit of parsed.units) issued.push(unit.suNumber);
    };

    if (warmup > 0) {
      log(`Warm-up ${warmup} s (not measured)...`);
      await Promise.all(
        scenarios.map((s, i) =>
          runScenario(
            baseUrl,
            s,
            cookies.get(s.account)!,
            new SeededRandom(seed + 1000 + i),
            { seconds: warmup, rate },
            undefined,
            onCreated,
          ),
        ),
      );
    }

    log(
      `Measuring ${duration} s with ${scenarios.reduce((n, s) => n + s.connections, 0)} clients...`,
    );
    const outcomes: ScenarioOutcome[] = scenarios.map((s) => ({
      scenario: s.name,
      description: s.description,
      connections: s.connections,
      p95TargetMs: s.p95TargetMs,
      probe: s.probe ?? false,
      requests: 0,
      errors: 0,
      timeouts: 0,
      kinds: {},
    }));
    const results = await Promise.all(
      scenarios.map((s, i) =>
        runScenario(
          baseUrl,
          s,
          cookies.get(s.account)!,
          new SeededRandom(seed + i),
          { seconds: duration, rate },
          outcomes[i],
          onCreated,
        ),
      ),
    );
    results.forEach((result, i) => {
      outcomes[i]!.requests = result.requests.total;
      outcomes[i]!.errors = result.errors;
      outcomes[i]!.timeouts = result.timeouts;
    });

    const integrity: IntegrityReport = await verifyIntegrity(pool, since);
    const duplicatesInResponses = issued.length - new Set(issued).size;
    if (duplicatesInResponses > 0) {
      integrity.problems.push(`duplicate IDs returned to clients: ${duplicatesInResponses}`);
    }
    // autocannon drops responses still in flight when a phase ends, so the database may hold up
    // to one receipt per receiving connection per phase that no client saw. Every ID a client did
    // see must be stored, and nothing else may differ.
    const stored = new Set(
      (
        await pool.query<{ readable_id: string }>(
          `SELECT su.readable_id FROM storage_unit su JOIN receipt r ON r.id = su.receipt_id
           WHERE r.confirmed_at >= $1`,
          [since],
        )
      ).rows.map((r) => r.readable_id),
    );
    const missing = issued.filter((id) => !stored.has(id)).length;
    if (missing > 0) integrity.problems.push(`IDs returned but not stored: ${missing}`);
    const receivingConnections = scenarios
      .filter((s) => s.name === 'receiving')
      .reduce((n, s) => n + s.connections, 0);
    const unseenReceipts = integrity.receiptsSince! - created;
    const phases = warmup > 0 ? 2 : 1;
    if (unseenReceipts < 0 || unseenReceipts > receivingConnections * phases) {
      integrity.problems.push(
        `receipts stored since start (${integrity.receiptsSince}) do not match receipts ` +
          `acknowledged (${created}) plus at most ${receivingConnections * phases} in flight`,
      );
    }

    const report = buildReport(outcomes, integrity, created, issued.length, unseenReceipts);
    const output = {
      label: args.get('label') ?? null,
      startedAt: since.toISOString(),
      durationSeconds: duration,
      ratePerConnection: rate === 0 ? 'unpaced' : rate,
      warmupSeconds: warmup,
      seed,
      database,
      system: await systemInfo(pool),
      scenarios: report.scenarios,
      integrity: {
        ...integrity,
        receiptsAcknowledged: created,
        receiptsInFlightAtCutoff: unseenReceipts,
        unitsIssuedToClients: issued.length,
      },
      authorizationFailures: report.authorizationFailures,
    };
    log(report.text);
    const outPath = args.get('out');
    if (outPath) {
      await writeFile(resolve(outPath), `${JSON.stringify(output, null, 2)}\n`);
      log(`Wrote ${outPath}`);
    }
    if (integrity.problems.length > 0 || report.authorizationFailures > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
    api?.kill();
  }
}

interface ReportRow extends LatencySummary {
  kind: string;
  statuses: Record<string, number>;
  unexpected: number;
}

function buildReport(
  outcomes: ScenarioOutcome[],
  integrity: IntegrityReport,
  created: number,
  issued: number,
  unseen: number,
) {
  const lines: string[] = [];
  let authorizationFailures = 0;
  const scenarios = outcomes.map((outcome) => {
    const all = Object.values(outcome.kinds).flatMap((k) => k.latencies);
    const unexpected = Object.values(outcome.kinds).reduce((n, k) => n + k.unexpected, 0);
    if (outcome.probe) authorizationFailures += unexpected;
    const rows: ReportRow[] = Object.entries(outcome.kinds)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, stats]) => ({
        kind,
        ...summarise(stats.latencies),
        statuses: stats.statuses,
        unexpected: stats.unexpected,
      }));
    return {
      scenario: outcome.scenario,
      description: outcome.description,
      connections: outcome.connections,
      p95TargetMs: outcome.p95TargetMs ?? null,
      overall: summarise(all),
      unexpectedStatuses: unexpected,
      socketErrors: outcome.errors,
      timeouts: outcome.timeouts,
      kinds: rows,
    };
  });

  lines.push(
    '',
    '| Scenario | Requests | p50 ms | p95 ms | p99 ms | max ms | Target p95 | Errors |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |');
  for (const s of scenarios) {
    const target = s.p95TargetMs
      ? `< ${s.p95TargetMs} ${s.overall.p95 < s.p95TargetMs ? 'met' : 'MISSED'}`
      : '-';
    const errors = s.unexpectedStatuses + s.socketErrors + s.timeouts;
    lines.push(
      `| ${s.description} | ${s.overall.count} | ${s.overall.p50} | ${s.overall.p95} | ${s.overall.p99} | ${s.overall.max} | ${target} | ${errors} |`,
    );
  }
  lines.push('', '| Request kind | n | p50 ms | p95 ms | p99 ms | max ms | Statuses |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const s of scenarios) {
    for (const k of s.kinds) {
      const statuses = Object.entries(k.statuses)
        .map(([code, n]) => `${code}x${n}`)
        .join(' ');
      lines.push(
        `| ${k.kind} | ${k.count} | ${k.p50} | ${k.p95} | ${k.p99} | ${k.max} | ${statuses} |`,
      );
    }
  }
  lines.push(
    '',
    `Receipts acknowledged ${created} (+${unseen} in flight at cutoff), IDs returned ${issued}; ` +
      `storage units now ${integrity.storageUnits}.`,
    `Authorization probes answered wrongly: ${authorizationFailures}.`,
    integrity.problems.length === 0
      ? 'Integrity: consistent (unique IDs, gap-free counters, one audit event per receipt and unit).'
      : `Integrity problems:\n- ${integrity.problems.join('\n- ')}`,
  );
  return { text: lines.join('\n'), scenarios, authorizationFailures };
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
