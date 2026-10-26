# Performance benchmark (MM-T19)

A reproducible benchmark of inventory lookup, inventory search and filters, storage unit detail
pages and receipt confirmation at ten-year volume and at a 5x stress volume, under the concurrent
workload the owner approved on 2026-10-25. Results: [results-2026-10-26.md](results-2026-10-26.md)
(dev PC baseline). Raw output of each run is in [data/](data/).

## Targets and workload (approved 2026-10-25)

| Item          | Value                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Ten-year data | ~20,000 storage units, 5,000 projects, 15,000 test holes, 30,000 summaries, 250,000 audit events, 25,000 print jobs (10 years) |
| Stress data   | 5x storage units and audit events (100,000 and 1,250,000); summaries follow the units (150,000)                                |
| Concurrency   | 10 active users, 2 receiving stations, 2 scanner sessions issuing lookups every 3 s                                            |
| Targets       | lookup p95 < 300 ms; filtered inventory page p95 < 500 ms; 5-unit receipt confirmation p95 < 1 s; error rate 0%                |

How the load script models it (`apps/api/src/bench/workload.ts`), one autocannon connection per
person or device, each paced at **one request per second** (autocannon's smallest pacing step, so
scanners run at 3x the agreed rate and everything else is heavier than an office would be):

| Scenario            | Clients | Requests                                                                                                |
| ------------------- | ------: | ------------------------------------------------------------------------------------------------------- |
| Scanners            |       2 | `GET /api/storage-units/lookup?code=` (half typed lower-case)                                           |
| Inventory users     |       5 | `GET /api/inventory` in 14 search / filter / sort / paging combinations (reported per combination)      |
| Detail users        |       3 | `GET /api/storage-units/:id`                                                                            |
| Detail sections     |       2 | `GET /api/storage-units/:id/history?page=1` and `/print-history`                                        |
| Receiving stations  |       2 | `POST /api/receipts`, 5 buckets with one SAMPLE#/DEPTH summary each, fresh idempotency key              |
| Authorization probe |       1 | Requests that must be refused: no session (401), no CSRF header (403), technician on admin routes (403) |

After each run the script checks correctness against the database: no duplicate storage unit IDs;
every prefix/year series is 1..N with its counter at N; every receipt's units match its quantity
and line numbers; exactly one `receipt.confirmed` / `storage_unit.created` audit event per receipt
and unit written during the run; every ID a client received is stored; every unit has a search
document. Any problem, or any probe answered with the wrong status, makes the command exit 1.

## Tools

- **Load generator:** [autocannon](https://github.com/mcollina/autocannon) 8.0.0, MIT licence, a
  dev dependency of `@materialmule/api` (pure JavaScript, no install scripts, no external binary; its
  56 transitive packages are MIT, ISC, Apache-2.0, BSD-2/3-Clause). Its `uuid` dependency is
  overridden to 11.1.1 (`overrides` in the root `package.json`) to clear advisory
  GHSA-w5hq-g745-h8pq. Chosen over k6 because k6 is a separate binary.
- **Commands** (run from the repo root; each takes `--env-file <file>`, default
  `apps/api/.env.bench`):

| Command                                 | What it does                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run bench:seed -- --size ten-year` | Drops and rebuilds the bench database, migrates, loads reference data + test identities + the generated data (`--size stress` for 5x)       |
| `npm run bench:explain -- --out F.md`   | `EXPLAIN (ANALYZE, BUFFERS)` of every statement the read endpoints run (the real service code), 5 draws per request kind, slowest plan kept |
| `npm run bench:load -- --out F.json`    | Starts the built API on 127.0.0.1:3219, 15 s warm-up, 120 s measured run, correctness checks, p50/p95/p99 per scenario and request kind     |

Options: `--seed N` (default 20261025), `--as-of YYYY-MM-DD` (seed only; default 2026-10-25, the
last date in the data), `--duration`, `--warmup`, `--rate` (requests per second per connection;
`0` = unpaced saturation run), `--port`, `--url` (use an API that is already running instead of
starting one), `--label`, `--log-level`.

The generator is deterministic: the same seed and as-of date give the same rows and UUIDs on any
machine (it uses its own seeded generator, not PostgreSQL's `random()`). `bench:seed` prints a
**fingerprint**; ten-year with the defaults is `ae9a53ff332ef01f`, stress `136c4879fd2088c4`. If
the host prints the same fingerprint, it loaded identical data.

## Safety

- The seed and the load refuse `APP_ENV=production` and any database whose name does not contain
  `bench` or `test` (`apps/api/src/bench/guard.ts`). Errors never print the connection string.
- All data is fictional (invented names, project numbers `Bxx-nnnn`, clients such as "Sample Birch
  Utilities"). The generated printer is disabled and points at `printer.example.test`; the load
  never prints labels.
- The load API runs with test sign-in on a separate port and the bench env file; it never uses the
  service's `materialmule.env`.

## Run it on the dev PC

```powershell
Copy-Item apps/api/.env.bench.example apps/api/.env.bench   # then set the password and secret
npm ci
npm run build
npm run bench:seed -- --size ten-year
npm run bench:explain -- --out docs/performance/data/<date>-ten-year-explain.md
npm run bench:load -- --label "ten-year" --out docs/performance/data/<date>-ten-year.json
npm run bench:seed -- --size stress
npm run bench:explain -- --out docs/performance/data/<date>-stress-explain.md
npm run bench:load -- --label "stress" --out docs/performance/data/<date>-stress.json
```

## Run it on the host (AC2)

Do this before go-live or out of hours: the benchmark loads the same CPU, disk and PostgreSQL
server the service uses. It never touches the `materialmule` database.

1. **Bench role and database** (as `postgres`; the existing `127.0.0.1` `pg_hba.conf` lines
   already cover it):
   ```powershell
   $psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
   & $psql -h 127.0.0.1 -U postgres -c "CREATE ROLE materialmule_bench LOGIN"
   & $psql -h 127.0.0.1 -U postgres -c "\password materialmule_bench"
   & $psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE materialmule_bench OWNER materialmule_bench"
   ```
2. **A checkout for the benchmark**, separate from the release folder (the release has no dev
   dependencies): install Git, clone the repo to e.g. `D:\materialmule-bench`, check out the commit
   being measured, then in PowerShell:
   ```powershell
   cd D:\materialmule-bench
   npm ci
   npm run build
   Copy-Item apps/api/.env.bench.example apps/api/.env.bench
   notepad apps/api/.env.bench   # DATABASE_URL password from step 1, a random SESSION_SECRET
   ```
3. **Run** the commands under [Run it on the dev PC](#run-it-on-the-dev-pc) and check that
   `bench:seed` prints the fingerprints above.
4. **Record** in a new `docs/performance/results-<date>.md`: the host's CPU, RAM, disk, Windows
   build (`Get-CimInstance Win32_Processor`, `Win32_OperatingSystem`, `Get-PhysicalDisk`),
   antivirus, power plan, and the `system` block the load writes into its JSON (PostgreSQL version
   and settings). Tick AC2 on the MM-T19 card, or open a follow-up card for each missed target.
5. **Clean up:** `& $psql -h 127.0.0.1 -U postgres -c "DROP DATABASE materialmule_bench"`, then the
   same with `"DROP ROLE materialmule_bench"`, and delete `apps/api/.env.bench`.

Differences from production to note with host results: the load uses HTTP on 127.0.0.1 (the
service serves HTTPS), and the load generator shares the host's CPU.
