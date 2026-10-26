# Trapezoid

Laboratory sample receiving, storage-unit tracking and testing-program workflow. React web app,
NestJS API and PostgreSQL, hosted on a Windows PC on the office network.

See [CLAUDE.md](CLAUDE.md) for layout, commands and conventions.

## Prerequisites (Windows)

1. **Node.js 24** (the exact version is in `.nvmrc`). Check with `node --version`.
2. **PostgreSQL 17** running locally. One way to install it:
   ```powershell
   winget install --id PostgreSQL.PostgreSQL.17 -e
   ```
   The installer asks for a password for the `postgres` superuser; keep it for step 3.
3. Create a role and two databases (development and test) in **psql** or pgAdmin:
   ```sql
   CREATE ROLE trapezoid LOGIN PASSWORD 'choose-a-local-password';
   CREATE DATABASE trapezoid_dev OWNER trapezoid;
   CREATE DATABASE trapezoid_test OWNER trapezoid;
   ```

## First run

```powershell
npm ci
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/api/.env.example apps/api/.env.test
```

Edit both files:

- `apps/api/.env`: `APP_ENV=development`, `DATABASE_URL=postgres://trapezoid:<password>@127.0.0.1:5432/trapezoid_dev`
- `apps/api/.env.test`: `APP_ENV=test`, `DATABASE_URL=postgres://trapezoid:<password>@127.0.0.1:5432/trapezoid_test`
- `SESSION_SECRET` in both: generate with
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`

Then create the tables, load fictional demo data and start the app:

```powershell
npm run db:migrate
npm run db:seed:dev
npm run db:reset:test
npm run dev
```

Open http://127.0.0.1:5173. The page should show **API: OK** and **Database: Connected**.

## Test sign-in (development only)

Until Microsoft sign-in is set up, use the fictional test identities seeded by `db:seed:dev`:

1. In `apps/api/.env` set `ENABLE_TEST_AUTH=true` (the API refuses to start with it in
   production) and restart `npm run dev`.
2. Open http://127.0.0.1:5173/sign-in/test and pick an identity, for example **Admin (test)**
   (staff and sessions) or **Lab (test)** (Lab Manager role). Picking another one signs the first
   out. Every action they take is audited with a TEST account type.
3. `npm run db:reset:dev` restores the fixtures' names and roles without changing their IDs or
   any audit history.

In Playwright tests, `signInAs(page, 'admin')` from `e2e/support/auth.ts` does the same through
the API.

## Checks

```powershell
npm run verify       # lint, typecheck, unit/integration tests, build, bundle secret scan
npx playwright install chromium   # once
npm run test:e2e     # browser smoke tests
```

To run the database integration test locally, set `TEST_DATABASE_URL` to the same value as the
`DATABASE_URL` in `.env.test` before `npm test`. Without it that one test is skipped; CI always runs it.

## Troubleshooting

| Symptom                                             | Fix                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| `Invalid configuration: - DATABASE_URL is required` | Create `apps/api/.env` from `.env.example`                                  |
| Page shows **API unavailable**                      | The API isn't running on port 3000; check the `api` output in `npm run dev` |
| Page shows **Database: Unavailable** (HTTP 503)     | PostgreSQL isn't running, or `DATABASE_URL` is wrong                        |
| `Port 5173 is in use`                               | Another Vite dev server is running; stop it                                 |
| E2E fails waiting for port 3100                     | `apps/api/.env.test` is missing or invalid                                  |
