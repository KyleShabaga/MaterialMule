# Material Mule

Laboratory sample receiving, storage-unit tracking and testing-program workflow. React web app,
NestJS API and PostgreSQL, hosted on a Windows PC on the office network.

Formerly named Trapezoid (renamed 2026-10-26). Git history, old branch names and PR titles, and
schema comments keep the old `TRP-Txx` card IDs (now `MM-Txx`).

See [CLAUDE.md](CLAUDE.md) for layout, commands and conventions, [docs/database.md](docs/database.md)
for the schema and [docs/permissions.md](docs/permissions.md) for who can do what.

## Prerequisites (Windows)

1. **Node.js 24.11 or later, below 25** (the exact version is in `.nvmrc`; npm 11). Check with
   `node --version`. Install scripts for esbuild and @swc/core are blocked on purpose
   (`allowScripts` in `package.json`); nothing to do.
2. **PostgreSQL 17** running locally. One way to install it:
   ```powershell
   winget install --id PostgreSQL.PostgreSQL.17 -e
   ```
   The installer asks for a password for the `postgres` superuser; keep it for step 3.
3. Create a role and two databases (development and test) in **psql** or pgAdmin:
   ```sql
   CREATE ROLE materialmule LOGIN PASSWORD 'choose-a-local-password';
   CREATE DATABASE materialmule_dev OWNER materialmule;
   CREATE DATABASE materialmule_test OWNER materialmule;
   ```

## First run

```powershell
npm ci
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/api/.env.example apps/api/.env.test
```

Only three keys are required; everything else in `.env.example` is optional with a default.
Edit both files:

- `apps/api/.env`: `APP_ENV=development`,
  `DATABASE_URL=postgres://materialmule:<password>@127.0.0.1:5432/materialmule_dev`, and
  `ENABLE_TEST_AUTH=true` so you can sign in with the fictional test identities (below).
- `apps/api/.env.test`: `APP_ENV=test`,
  `DATABASE_URL=postgres://materialmule:<password>@127.0.0.1:5432/materialmule_test`
- `SESSION_SECRET` in both (32+ characters): generate with
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`

Then create the tables, load fictional demo data and start the app:

```powershell
npm run db:migrate
npm run db:seed:dev
npm run db:reset:test
npm run dev
```

A development database built before the MM-AO02 clean baseline (2026-10-29) is refused by
`db:migrate`. If it is disposable, rebuild it with
`npm run db:rebuild:dev -- --disposable materialmule_dev` (it names the database on purpose; see
[docs/database.md](docs/database.md#clean-baseline-mm-ao02-owner-decision-2026-10-29)), and run
`npm run db:reset:test` for the test database.

Open http://127.0.0.1:5173 (use `127.0.0.1`, not `localhost`). You land on the sign-in page; pick
**Test sign-in (development only)** and sign in as **Admin (test)**. The dashboard's status card
should show **API: OK** and **Database: Connected**. Without signing in, check
http://127.0.0.1:5173/api/health.

## Signing in

The sign-in page offers only the methods this server has set up (`GET /api/auth/providers`):

| Method       | Appears when                                                 | Who uses it                    |
| ------------ | ------------------------------------------------------------ | ------------------------------ |
| Microsoft    | all four `MICROSOFT_*` keys are set in `.env`                | staff, with their work account |
| LAB          | an admin has set the LAB password                            | the shared receiving station   |
| Test sign-in | `ENABLE_TEST_AUTH=true` and `APP_ENV` is development or test | developers and manual testers  |

If none is set up, the page says "No sign-in method is set up on this server yet."

### Test identities (development only)

`npm run db:seed:dev` creates these fictional people, plus project **DEMO-2601** "Riverbank
investigation" with test holes **TH26-01** and **TH26-02**. Open
http://127.0.0.1:5173/sign-in/test and pick one; picking another signs the first out. Everything
they do is audited with a TEST account type.

| Key       | Name         | Initials | Role or position                         |
| --------- | ------------ | -------- | ---------------------------------------- |
| `admin`   | Admin (test) | ADM      | Admin: staff, sessions, printers         |
| `lab`     | Lab (test)   | LAB      | Lab Manager (not the shared LAB account) |
| `at`      | Alex Tester  | AT       | Technician                               |
| `pe`      | Pat Example  | PE       | Lead Project Engineer of DEMO-2601       |
| `de`      | Dana Example | DE       | Engineer                                 |
| `js-tech` | Jordan Smith | JS       | Technician (duplicate initials)          |
| `js-eng`  | Jamie Song   | JS       | Engineer (duplicate initials)            |

Two applicants, **Riley Pending** and **Casey Pending**, wait in Settings → Staff & access for an
admin to approve them. `npm run db:reset:dev` puts all of this back (names, roles, pending
applicants) without changing IDs or audit history. In Playwright tests,
`signInAs(page, 'admin')` from `e2e/support/auth.ts` signs in through the API.

The API refuses to start with `ENABLE_TEST_AUTH=true` when `APP_ENV=production`.

### The shared LAB account

`npm run db:migrate` creates the LAB account with no password, so LAB is hidden until an admin
sets one: sign in as an admin, open **Settings → Staff & access**, and under **Shared receiving
account (LAB)** enter a password of at least 12 characters, then **Reset LAB password**. The
station then signs in with username `LAB`. The session lasts one calendar month; ten wrong
passwords in 15 minutes lock sign-in for 15 minutes; resetting the password signs out every LAB
station.

### Microsoft sign-in against the mock tenant

For real use, IT provides the tenant ID, client ID, secret and redirect URI (see the comments in
`.env.example`). To try the flow locally with fictional accounts:

1. Start the mock tenant: `npm run mock:idp -w @materialmule/api` (listens on 127.0.0.1:4100;
   `MOCK_IDP_PORT` changes it).
2. Add to `apps/api/.env`, then restart `npm run dev`:
   ```
   MICROSOFT_TENANT_ID=11111111-2222-4333-8444-555555555555
   MICROSOFT_CLIENT_ID=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
   MICROSOFT_CLIENT_SECRET=mock-client-secret-not-a-real-secret
   MICROSOFT_REDIRECT_URI=http://127.0.0.1:5173/sign-in/microsoft/callback
   MICROSOFT_AUTHORITY_HOST=http://127.0.0.1:4100
   MICROSOFT_GRAPH_BASE_URL=http://127.0.0.1:4100
   BOOTSTRAP_ADMIN_OBJECT_ID=00000000-0000-4000-8000-0000000a0001
   ```
3. **Sign in with Microsoft** shows the mock's account list: `avery` becomes the active admin
   (bootstrap); `riley`, `morgan`, `casey` and `drew` are new people who choose a position and
   then wait for approval; `outsider` (another tenant) and `guest` are refused; `nograph` signs in
   with the profile service down; `jordan` links to a staff entry an admin added ahead of time
   with work email `jordan@example.test`; **Cancel** shows the cancelled-sign-in message.

Remove the `MICROSOFT_*` lines to turn it off again.

## Printing without a Zebra printer

1. Start the fake printer: `npm run mock:printer -w @materialmule/api` (listens on 127.0.0.1:9100
   and prints a line for each label it receives). `MOCK_PRINTER_MODE=hang` never answers,
   `MOCK_PRINTER_MODE=drop` cuts the connection mid-label, `MOCK_PRINTER_PAPER_OUT=1` reports
   out of labels; stop it to test a printer that is off.
2. Point the app at it: set `LABEL_PRINTER_HOST=127.0.0.1` in `apps/api/.env` before the API's
   first start (it creates the "receiving" printer once), or as an admin change the printer in
   **Settings → Printers**.
3. Print from a storage unit's page, `/sample-storage/<ID>` (for example
   `/sample-storage/BKT-2026-000001`).

No printer at all? Use **Preview label** on a unit's page (or on the receiving wizard's labels
step), then **Print / Save as PDF** and print or save at 100% / Actual size: each PDF page is one
true-size 3.5 × 1.5 in label. Saving a PDF is not a label print and creates no print job (MM-T39).

Need a unit to print? Receive one: sign in as `at` (or `lab`), open **Receive samples**, choose
project **DEMO-2601**, add a bucket with a summary for test hole **TH26-01**, review and confirm.
The labels step then prints (or previews) its labels.

## Scanning without a handheld scanner

The Zebra DS3678-XR (MM-T16) is a USB keyboard that types the label's ID and then Enter, so you
can try scanning by typing. Open **Sample Storage → Scan labels** (`/sample-storage/scan`), type
an ID such as `BKT-2026-000001` into the focused scan field and press Enter. Scanner setup and the
hardware test sheet: [docs/hardware/ds3678-xr.md](docs/hardware/ds3678-xr.md).

Phones scan with **Scan with camera** (MM-T17). The camera only works on HTTPS pages, or on
`http://127.0.0.1` on the PC itself, so test it from a phone through the host's HTTPS address
(MM-T20). Details and the device test sheet: [docs/hardware/phone-camera.md](docs/hardware/phone-camera.md).

## Receiving Log

**Receiving Log** (`/receiving-log`, MM-T51) lists confirmed receipts, one row per receipt,
newest confirmation first: received date, project, received by (initials and name), number of
storage units and when and from which account (e.g. LAB) it was confirmed. Search by project
number or name, received-by name or initials, or an exact storage unit ID, and filter by project,
received by and received-date range; filters and page stay in the URL. Open a receipt
(`/receiving-log/:receiptId`) for its original header and every storage unit it created, with
links to each unit, label previews and **Print labels**. Opening a receipt never prints. Drafts
that aren't confirmed stay on their computer and open from **Receive samples**.

## Receiving drafts

Receive samples autosaves each receipt in progress as a draft in that browser only (IndexedDB,
MM-T11): there is no server copy, and another computer never sees it. Drafts not saved for over
30 days get a **Stale** badge. By default they are never deleted automatically.

A Lab Manager or admin can turn on automatic clean-up in **Settings → Receiving** (MM-T45):
**Delete drafts automatically** after 30–365 days without changes (default 90). Each computer
then deletes its own old drafts the next time Receive samples is opened there and says how many,
e.g. "2 drafts older than 90 days were deleted from this computer (automatic clean-up set by an
administrator)." Drafts whose confirmation was interrupted are never deleted, and if the setting
can't be loaded (offline, server error) nothing is deleted.

## Checks

```powershell
npm run verify       # lint, typecheck, unit/integration tests, build, bundle secret scan
npx playwright install chromium   # once
npm run test:e2e     # browser tests, desktop and phone
npm run test:security                    # permission sweep of every endpoint (MM-T18)
npm run test:e2e:critical               # receiving critical path only (MM-T18)
```

What the receiving regression suite covers, and its latest results:
[docs/testing/receiving-critical-path.md](docs/testing/receiving-critical-path.md).

API tests use the database in `apps/api/.env.test` automatically; CI sets
`REQUIRE_DATABASE_TESTS=1` so they can't be skipped there.

`npm run test:e2e` resets the `.env.test` database, loads the test identities, builds both apps and
has the API serve the web build on `E2E_PORT` (default 3100). It also starts a fake printer on
`E2E_PORT + 1000` and the mock Microsoft tenant on `E2E_PORT + 2000`, so all three ports must be
free. To run E2E in two checkouts at once, give each its own test database and port, e.g.
`E2E_PORT=3107 npm run test:e2e`. Playwright won't reuse a server already on the port unless
`E2E_REUSE_SERVER=1` is set.

## Pull requests and CI

`main` is protected: every change goes through a pull request, and GitHub's `verify` check
(`.github/workflows/ci.yml`: verify and E2E on Windows) must pass on a branch that is up to date
with `main` before it can merge. Draft PRs don't run CI until they're marked ready; merged branches
are deleted automatically. CI doesn't replace the local gate: run `npm run verify` and
`npm run test:e2e` on Windows before opening a PR.

## Troubleshooting

| Symptom                                               | Fix                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Invalid configuration: - SESSION_SECRET is required` | Set `SESSION_SECRET` (32+ characters) in `apps/api/.env`; see First run             |
| Sign-in page says no sign-in method is set up         | Set `ENABLE_TEST_AUTH=true` in `apps/api/.env` and restart `npm run dev`            |
| Page shows **API unavailable**                        | The API isn't running on port 3000; check the `api` output in `npm run dev`         |
| Status shows **Database: Unavailable** (HTTP 503)     | PostgreSQL isn't running, or `DATABASE_URL` is wrong                                |
| `Port 5173 is in use`                                 | Another Vite dev server is running; stop it                                         |
| Microsoft sign-in fails on the way back               | Open the app at `127.0.0.1`, not `localhost`, matching `MICROSOFT_REDIRECT_URI`     |
| E2E fails waiting for its port                        | `apps/api/.env.test` is missing or invalid, or `E2E_PORT`, +1000 or +2000 is in use |
| E2E requests time out at random with more workers     | Antivirus web shields (AVG here) can stall browser traffic; keep 2 workers          |
