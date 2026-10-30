# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

Material Mule tracks laboratory sample **storage units** (buckets, Shelby tubes, bulk containers) for a
geotechnical/materials consulting firm: receiving and labelling, inventory and location, lab testing
programs (progress only), retention, and disposal.

- Requirements: Notion page "App Idea" (decisions D01–D52).
- Work items: Notion "Material Mule — Development Board". Each card (MM-Txx) has scope, acceptance
  criteria (section 7) and a test plan (section 8). Implement one card per branch.
- Hosting (D25): a regular Windows PC running the NestJS API as a Windows service, PostgreSQL on the
  same PC, and the React app in browsers on office computers and phones. No cloud, no off-site access.

## Layout

```
apps/api         NestJS 12 backend, ESM ("type": "module"), routes under /api
apps/web         React 19 + Vite browser app
packages/shared  Types and zod schemas used by both (built with tsup to ESM + CJS)
e2e              Playwright tests (desktop and phone viewports)
deploy/windows   Host scripts: Install-MaterialMuleHost, Deploy-MaterialMule (MM-T20, docs/operations/runbook.md)
scripts          Repo tooling (check-bundle-secrets.mjs, pack-release.mjs)
```

## Commands (run from the repo root)

| Command                                       | What it does                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                      | Install exactly what's in the lockfile                                                                                                                         |
| `npm run dev`                                 | Shared (watch) + API (watch, port 3000) + web (port 5173, proxies `/api`)                                                                                      |
| `npm run lint`                                | ESLint (zero warnings) and Prettier check                                                                                                                      |
| `npm run format`                              | Prettier write                                                                                                                                                 |
| `npm run typecheck`                           | `tsc --noEmit` in every workspace                                                                                                                              |
| `npm test`                                    | Unit and integration tests (Vitest) in every workspace                                                                                                         |
| `npm run build`                               | Build shared, API and web                                                                                                                                      |
| `npm run check:bundle`                        | Fail if server config appears in the web bundle                                                                                                                |
| `npm run test:deploy`                         | Deploy-script and release-packing tests (PowerShell 7, temp folders; part of `npm test`)                                                                       |
| `npm run release:pack`                        | Pack `release/materialmule-<version>-<commit>/` for the Windows host (after verify)                                                                            |
| `npm run verify`                              | lint → typecheck → test → build → check:bundle (the gate for every card)                                                                                       |
| `npm run test:e2e`                            | Playwright: resets + seeds the test DB, builds both apps, API serves the web build on `E2E_PORT` (3100); fake printer on +1000, mock Microsoft tenant on +2000 |
| `npm run db:migrate`                          | Apply pending migrations, then reference data (Receiving lab)                                                                                                  |
| `npm run db:seed:dev`                         | Load fictional dev fixtures (DEMO-2601, TH26-01/02, 7 test identities, 2 pending applicants); refused in production                                            |
| `npm run db:reset:dev`                        | Re-apply the dev fixtures (names, roles, pending applicants) without changing IDs or audit                                                                     |
| `npm run db:seed:demo`                        | Richer demo data (DEMO-2610–2615: receipts, moves, lab programs in every stage, retention, disposal) via the running dev API                                   |
| `npm run db:rebuild:dev -- --disposable <db>` | Drop and rebuild a designated disposable dev database from the baseline, with reference data and fixtures (development only)                                   |
| `npm run db:reset:test`                       | Drop and rebuild the test database from `apps/api/.env.test`                                                                                                   |
| `npm run bench:seed`                          | Rebuild a bench DB with fictional ten-year / 5x data (MM-T19; see docs/performance/README.md)                                                                  |
| `npm run bench:load`                          | Concurrent workload and correctness checks against the built API; `bench:explain` for plans                                                                    |
| `npm run mock:idp -w @materialmule/api`       | Mock Microsoft tenant for local sign-in (127.0.0.1:4100); see README                                                                                           |
| `npm run mock:printer -w @materialmule/api`   | Fake Zebra printer for local printing (127.0.0.1:9100); see README                                                                                             |

Per-workspace: `npm run <script> -w @materialmule/api` (or `@materialmule/web`, `@materialmule/shared`).
Database details: [docs/database.md](docs/database.md). Migrations are forward-only SQL files in
`apps/api/migrations`, starting from `0001_baseline.sql` (MM-AO02 clean pre-release baseline, a
one-time owner-approved replacement of the undeployed lineage; never repeat it for a deployed
database); never edit one that has been applied (the runner checks a checksum). Put
integrity rules in the database and prove each in `apps/api/src/db/schema.test.ts`. API tests read
the test database from `apps/api/.env.test` automatically.

A card is done only when `npm run verify` and `npm run test:e2e` pass on Windows. E2E runs
production-shaped (the API serves `apps/web/dist` via `WEB_DIST_DIR`, no dev proxy) and signs in with
`signInAs(page, key)` from `e2e/support/auth.ts`. Locally it uses 2 workers: on the dev PC, more
parallel browsers made the API stall (AVG Web Shield); CI uses the default.

Parallel worktrees: each worktree needs its own test database (point its `apps/api/.env.test` at
e.g. `materialmule_test_t07`) and its own E2E port (`E2E_PORT=3107 npm run test:e2e`), because E2E
resets the database it runs against. Playwright never reuses a server already on the port unless
`E2E_REUSE_SERVER=1` is set.

## Configuration

- The API validates env vars at startup (`apps/api/src/config/env.ts`) and exits with the list of
  bad keys. Error messages must never include values.
- Env file: `ENV_FILE` (default `.env` in `apps/api`). Templates: `apps/api/.env.example`.
  `.env` / `.env.test` are git-ignored; never commit them.
- Only `VITE_`-prefixed variables reach the browser. Never put secrets in them.
- Tests that need PostgreSQL read `TEST_DATABASE_URL`; CI sets `REQUIRE_DATABASE_TESTS=1` so they
  can't be silently skipped there.

## Conventions

- TypeScript strict everywhere. In `apps/api`, relative imports end in `.js` (NodeNext ESM).
- API: one Nest module per domain area; validate input with zod schemas from `packages/shared`;
  enforce every permission on the server, never only in the UI.
- Put request/response types and validation in `packages/shared` so web and API agree.
- Logging: pino via nestjs-pino. Add sensitive field names to `REDACT_PATHS` in
  `apps/api/src/logging/logger.ts` instead of logging around them.
- Tests sit next to the code (`*.test.ts`); E2E in `e2e/`. No fixed sleeps in tests.
- Windows first: npm scripts must work in PowerShell, cmd and Git Bash.

## Never

- Never require or create an individual sample inventory at receiving. Receiving is per storage
  unit with one SAMPLE#/DEPTH summary per test hole; individual samples appear only in lab requests.
- Never implement a deferred decision as a default: billing D16–D18, sign-in timing D38, IT/pilot
  choices D39. Cards mark proposals that need owner confirmation; stop and ask.
- Never change a storage unit ID after issue, recycle one, or issue one for a draft. IDs are
  `PREFIX-YYYY-NNNNNN` (amended 2026-10-25; the earlier `SU-` format is superseded): `BKT` bucket,
  `ST` individually tracked Shelby tube, `CRE` core box, `CT` any other (generic) container. The
  prefix follows the physical holder at confirmation; each prefix/year pair has its own counter;
  a later type, date or project correction never changes the issued ID. Year = confirmation date
  in America/Edmonton.
- Never use real production data, real people's records or send real email/messages in tests.
  Use fictional data such as project DEMO-2601 and test hole TH26-01.
- Never commit secrets, `.env` files or credentials.

<!-- claude-reflect: learned rules (saved from the band; edit freely) -->

## Learned rules

- Format storage unit IDs with type prefixes (BKT-, ST-, CRE-, CT-) and per-type yearly counters, not SU-YYYY-000001.

- Do not use pill-shaped (fully rounded) styling for UI components; use moderate corner radii instead.

<!-- end claude-reflect -->
