// `npm run bench:explain -- [--draws 5] [--seed N] [--out plans.md] [--env-file F]`
// Captures EXPLAIN (ANALYZE, BUFFERS) for every statement the read endpoints run (MM-T19). It
// calls the real service functions with a pool that explains each statement before running it, so
// the plans are of exactly the SQL the API sends. Read-only: it never writes.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inventoryQuerySchema } from '@materialmule/shared';
import { Pool, type QueryResult } from 'pg';
import { loadConfigOrExit } from '../config/env.js';
import { queryInventory } from '../inventory/inventory.service.js';
import { getPrintHistory } from '../printing/print-queue.js';
import {
  getStorageUnitDetail,
  getStorageUnitHistory,
  lookupStorageUnit,
} from '../storage-units/storage-units.service.js';
import { parseArgs, useEnvFile } from './cli-args.js';
import { assertBenchTarget } from './guard.js';
import { DEFAULT_BENCH_SEED, SeededRandom } from './random.js';
import { inventoryKinds, loadTargets } from './workload.js';

interface Captured {
  sql: string;
  plan: string;
  ms: number;
}

/** A Pool stand-in whose query() explains, then runs, each statement. */
function explainingPool(pool: Pool, captured: Captured[]): Pool {
  const query = async (text: string, params?: unknown[]): Promise<QueryResult> => {
    const explained = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${text}`,
      params,
    );
    // Long UUID lists (the page's unit IDs) say nothing about the plan; keep the count only.
    const plan = explained.rows
      .map((r) => r['QUERY PLAN'])
      .join('\n')
      .replace(
        /'\{(?:[0-9a-f-]{36},)+[0-9a-f-]{36}\}'/g,
        (list) => `'{${list.split(',').length} uuids}'`,
      );
    const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? 0);
    captured.push({ sql: text.replace(/\s+/g, ' ').trim(), plan, ms });
    return pool.query(text, params);
  };
  return { query } as unknown as Pool;
}

interface CaseResult {
  name: string;
  /** Total database execution time per draw (ms), across the endpoint's statements. */
  totals: number[];
  slowest: Captured[];
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  useEnvFile(args);
  const config = loadConfigOrExit();
  const database = assertBenchTarget(config.DATABASE_URL, config.APP_ENV);
  const draws = Number(args.get('draws') ?? 5);
  const seed = Number(args.get('seed') ?? DEFAULT_BENCH_SEED);
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });

  try {
    const targets = await loadTargets(pool);
    const endYear = new Date().getFullYear();
    const random = new SeededRandom(seed + 500);
    const cases = new Map<string, (db: Pool) => Promise<unknown>>();

    const kindCount = inventoryKinds(random, targets, endYear).length;
    for (let k = 0; k < kindCount; k++) {
      for (let d = 0; d < draws; d++) {
        const [kind, params] = inventoryKinds(random, targets, endYear)[k]!;
        const query = inventoryQuerySchema.parse(params());
        cases.set(`${kind}#${d}`, (db) => queryInventory(db, query));
      }
    }
    for (let d = 0; d < draws; d++) {
      const code = random.pick(targets.readableIds);
      cases.set(`lookup: scan storage unit ID#${d}`, (db) => lookupStorageUnit(db, code));
      cases.set(`detail: storage unit#${d}`, (db) => getStorageUnitDetail(db, code));
      cases.set(`detail: history page 1#${d}`, (db) => getStorageUnitHistory(db, code, 1));
      cases.set(`detail: print history#${d}`, (db) => getPrintHistory(db, code));
    }

    const results = new Map<string, CaseResult>();
    for (const [key, run] of cases) {
      await run(pool); // warm the cache so plans show steady-state buffers
      const captured: Captured[] = [];
      await run(explainingPool(pool, captured));
      const name = key.split('#')[0]!;
      const total = captured.reduce((sum, c) => sum + c.ms, 0);
      const result = results.get(name) ?? { name, totals: [], slowest: [] };
      const slowestTotal = result.slowest.reduce((sum, c) => sum + c.ms, 0);
      if (result.totals.length === 0 || total > slowestTotal) result.slowest = captured;
      result.totals.push(total);
      results.set(name, result);
    }

    const ordered = [...results.values()].sort(
      (a, b) => Math.max(...b.totals) - Math.max(...a.totals),
    );
    const lines = [
      `# EXPLAIN (ANALYZE, BUFFERS): ${database}`,
      '',
      `Seed ${seed}, ${draws} draws per request kind, run ${new Date().toISOString()}.`,
      'Database execution time per request (all statements of the endpoint), warm cache.',
      '',
      '| Request kind | median ms | max ms |',
      '| --- | ---: | ---: |',
      ...ordered.map(
        (r) =>
          `| ${r.name} | ${median(r.totals).toFixed(1)} | ${Math.max(...r.totals).toFixed(1)} |`,
      ),
    ];
    for (const r of ordered) {
      lines.push('', `## ${r.name} (slowest draw)`);
      for (const c of r.slowest) {
        lines.push('', '```sql', c.sql, '```', '', '```text', c.plan, '```');
      }
    }
    const text = `${lines.join('\n')}\n`;
    const out = args.get('out');
    if (out) {
      await writeFile(resolve(out), text);
      process.stdout.write(`${lines.slice(0, 7 + ordered.length).join('\n')}\nWrote ${out}\n`);
    } else {
      process.stdout.write(text);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
