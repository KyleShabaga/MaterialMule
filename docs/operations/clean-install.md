# Clean install (office PC)

How to remove every earlier copy of Material Mule (including Trapezoid, its name before
2026-10-26) from a Windows PC and set it up again from scratch: a fresh checkout, fresh databases,
fresh configuration, then run it and check it.

Use this when an old setup is in a state you don't trust. Typical signs: `db:migrate` refuses the
database because it comes from the retired pre-baseline lineage (MM-AO02), old `trapezoid_*`
databases or roles are still around, or `npm ci` / `npm run dev` fail in ways a fresh checkout
doesn't.

> **This deletes data.** Part 1 drops every Material Mule and Trapezoid database on the PC. That is
> fine for development and test databases, which only hold fictional fixtures. **Never** follow it
> on a host with real production data: there is no production deployment yet (owner decision
> 2026-10-29). Once there is, upgrade it with the [runbook](runbook.md#upgrade) instead.

All commands run in **PowerShell 7**. Steps marked _(admin)_ need an elevated window ("Run as
administrator"). Placeholders are in angle brackets, e.g. `<password>`.

## Contents

1. [Before you start](#before-you-start)
2. [Part 1: remove the old setup](#part-1-remove-the-old-setup)
3. [Part 2: install the prerequisites](#part-2-install-the-prerequisites)
4. [Part 3: install Material Mule](#part-3-install-material-mule)
5. [Part 4: run it](#part-4-run-it)
6. [Part 5: check everything works](#part-5-check-everything-works)
7. [Optional: the Windows service install](#optional-the-windows-service-install)
8. [Troubleshooting](#troubleshooting)

## Before you start

1. **Save unpushed work.** In every old checkout (look for folders named `MaterialMule`,
   `materialmule`, `Trapezoid` or `trapezoid`, and any worktrees made from them):
   ```powershell
   git status
   git stash list
   git log --branches --not --remotes --oneline
   ```
   Commit and push anything you want to keep. Whatever is only in that folder is lost in Part 1.
2. **Keep anything from an old database you need.** Development databases hold only fictional
   fixtures, which Part 3 recreates. If you entered anything by hand that you want to keep, dump it
   first (prompts for the `postgres` password):
   ```powershell
   & 'C:\Program Files\PostgreSQL\17\bin\pg_dump.exe' -h 127.0.0.1 -U postgres -Fc -f "$HOME\Desktop\materialmule_dev-before-clean.dump" materialmule_dev
   ```
   The schema changed at the clean baseline, so this dump is a record to look things up in, not
   something to restore into the new database.
3. **Have the `postgres` password** from the password manager. If nobody knows it, take the full
   wipe in [step 1.5](#15-optional-full-wipe-uninstall-nodejs-and-postgresql).

## Part 1: remove the old setup

### 1.1 Stop everything that is running

- In each terminal running `npm run dev`, `npm run test:e2e`, `mock:idp` or `mock:printer`, press
  **Ctrl+C**.
- Close VS Code and any other terminal opened in an old checkout (they lock files in
  `node_modules`).
- Check nothing is still listening on the app's ports (API 3000, web 5173, E2E 3100/4100/5100,
  mock tenant 4100, fake printer 9100):
  ```powershell
  Get-NetTCPConnection -State Listen -LocalPort 3000,3100,4100,5100,5173,9100 -ErrorAction SilentlyContinue |
    Select-Object LocalPort, OwningProcess, @{ n = 'Process'; e = { (Get-Process -Id $_.OwningProcess).ProcessName } }
  ```
  If a `node` process is listed, stop it: `Stop-Process -Id <OwningProcess>`.

### 1.2 Remove a Windows service install, if there is one _(admin)_

Skip this if the PC was only ever used with `npm run dev` (check: `Get-Service` below prints
nothing and `Test-Path` prints `False` twice).

```powershell
Get-Service -Name MaterialMule, Trapezoid -ErrorAction SilentlyContinue
Test-Path C:\MaterialMule, C:\Trapezoid
```

For each one that exists (shown for `MaterialMule`; for the old install replace `MaterialMule`
with `Trapezoid` and `materialmule` with `trapezoid`):

```powershell
$root = 'C:\MaterialMule'
& "$root\service\materialmule-service.exe" stop
& "$root\service\materialmule-service.exe" uninstall
Get-NetFirewallRule -Name 'MaterialMule-HTTPS-In' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-ScheduledTask -TaskPath '\MaterialMule\' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
if ([System.Diagnostics.EventLog]::SourceExists('MaterialMule')) { [System.Diagnostics.EventLog]::DeleteEventSource('MaterialMule') }
```

Then copy anything from `$root\config` you still need (the TLS certificate from IT, for example)
somewhere safe outside that folder, and delete the folder:

```powershell
Remove-Item -Recurse -Force $root
```

Check: `Get-Service MaterialMule, Trapezoid` finds neither.

### 1.3 Drop the old databases and roles

Open PowerShell (not elevated) and list what is there:

```powershell
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
$env:PGPASSWORD = (Read-Host 'postgres password' -MaskInput)
& $psql -h 127.0.0.1 -U postgres -d postgres -c "SELECT datname FROM pg_database WHERE datname ~* '^(materialmule|trapezoid)' ORDER BY 1"
& $psql -h 127.0.0.1 -U postgres -d postgres -c "SELECT rolname FROM pg_roles WHERE rolname ~* '^(materialmule|trapezoid)' ORDER BY 1"
```

Expect names such as `materialmule_dev`, `materialmule_test`, `materialmule_test_t07` (worktrees),
`materialmule_bench`, `materialmule_rehearsal_*`, `trapezoid_dev`, `trapezoid_test` and the roles
`materialmule`, `materialmule_owner`, `materialmule_app`, `materialmule_backup`,
`materialmule_bench`, `trapezoid`. **Read the list.** If anything in it is not a development, test
or benchmark database you are sure is disposable, stop and ask.

Then drop them all (`WITH (FORCE)` closes any connection still open to them):

```powershell
@'
SELECT format('DROP DATABASE %I WITH (FORCE)', datname) FROM pg_database WHERE datname ~* '^(materialmule|trapezoid)' \gexec
SELECT format('DROP ROLE %I', rolname) FROM pg_roles WHERE rolname ~* '^(materialmule|trapezoid)' \gexec
'@ | & $psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1
Remove-Item Env:PGPASSWORD
```

Run the two `SELECT` commands above again: both now return `(0 rows)`.

If `DROP ROLE` says the role "cannot be dropped because some objects depend on it", the role still
owns something in another database (usually `postgres`). Connect to the database it names and run
`DROP OWNED BY <role>;`, then repeat the drop.

### 1.4 Delete the old checkouts and caches

For each old checkout (after [Before you start](#before-you-start), step 1):

```powershell
Remove-Item -Recurse -Force C:\<path>\MaterialMule
```

If it says a file is in use, something from step 1.1 is still running. If git worktrees were made
from it, delete those folders too.

Clear the caches so nothing old is reused:

```powershell
npm cache clean --force
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\ms-playwright" -ErrorAction SilentlyContinue
```

### 1.5 Optional: full wipe (uninstall Node.js and PostgreSQL)

Only if Node.js is the wrong version (not 24.x), PostgreSQL is not 17, nobody knows the
`postgres` password, or you want nothing old left at all. **Uninstalling PostgreSQL removes every
database on this PC**, not only Material Mule's; check nothing else uses it.

1. **Settings → Apps → Installed apps**: uninstall **Node.js** and **PostgreSQL 17** (and any
   other PostgreSQL version you don't need).
2. The PostgreSQL uninstaller keeps the data folder. Delete it _(admin)_:
   ```powershell
   Remove-Item -Recurse -Force 'C:\Program Files\PostgreSQL\17'
   ```
3. Delete leftovers from Node.js (ignore "not found"):
   ```powershell
   Remove-Item -Recurse -Force "$env:APPDATA\npm", "$env:LOCALAPPDATA\npm-cache" -ErrorAction SilentlyContinue
   ```
4. Restart the PC, then continue with Part 2.

## Part 2: install the prerequisites

Skip any that are already installed at the right version.

| Tool         | Version                                                    | Check                       |
| ------------ | ---------------------------------------------------------- | --------------------------- |
| Node.js      | 24.x, at least 24.11 (`.nvmrc`: 24.22.0), **not** 25 or 26 | `node --version`            |
| npm          | 11 (comes with Node.js 24)                                 | `npm --version`             |
| PostgreSQL   | 17                                                         | `psql --version` (below)    |
| Git          | any recent                                                 | `git --version`             |
| PowerShell 7 | 7.x                                                        | `$PSVersionTable.PSVersion` |

1. **Node.js 24**: download the Windows x64 `.msi` for v24.22.0 from
   <https://nodejs.org/download/release/v24.22.0/>. Default options; do **not** tick
   "Automatically install the necessary tools". (Don't take "latest LTS" blindly: from October
   2026 that may be Node 26, which the app refuses.)
2. **PostgreSQL 17** _(admin)_:
   ```powershell
   winget install --id PostgreSQL.PostgreSQL.17 -e
   ```
   Choose a `postgres` password and save it in the password manager. Keep port 5432. Skip Stack
   Builder.
3. **Git** and **PowerShell 7**, if missing:
   ```powershell
   winget install --id Git.Git -e
   ```
   ```powershell
   winget install --id Microsoft.PowerShell -e
   ```
4. Close and reopen PowerShell 7 so the new `PATH` applies, then run the checks in the table.
   For PostgreSQL: `& 'C:\Program Files\PostgreSQL\17\bin\psql.exe' --version` prints `17.x`.

## Part 3: install Material Mule

### 3.1 Get the code

```powershell
cd C:\dev        # or wherever you keep code
git clone https://github.com/KyleShabaga/MaterialMule.git
cd MaterialMule
npm ci
```

`npm ci` installs exactly what is in `package-lock.json`. It may print that install scripts for
esbuild and @swc/core were skipped; that is on purpose (`allowScripts` in `package.json`).

### 3.2 Create the role and databases

Pick a new local password for the `materialmule` login (it is only used on this PC):

```powershell
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
$env:PGPASSWORD = (Read-Host 'postgres password' -MaskInput)
& $psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE materialmule LOGIN PASSWORD '<password>'"
& $psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE materialmule_dev OWNER materialmule"
& $psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE materialmule_test OWNER materialmule"
Remove-Item Env:PGPASSWORD
```

### 3.3 Create the configuration files

```powershell
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/api/.env.example apps/api/.env.test
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The last two lines print two different random secrets. Edit the two files (e.g.
`notepad apps/api/.env`) and set:

| Key                | `apps/api/.env`                                                      | `apps/api/.env.test`                                                  |
| ------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `APP_ENV`          | `development`                                                        | `test`                                                                |
| `DATABASE_URL`     | `postgres://materialmule:<password>@127.0.0.1:5432/materialmule_dev` | `postgres://materialmule:<password>@127.0.0.1:5432/materialmule_test` |
| `SESSION_SECRET`   | the first secret                                                     | the second secret                                                     |
| `ENABLE_TEST_AUTH` | `true`                                                               | leave as is                                                           |

Leave everything else at its default. These files are git-ignored; never commit, email or paste
them.

### 3.4 Build the databases

```powershell
npm run db:migrate
npm run db:seed:dev
npm run db:reset:test
```

- `db:migrate` applies `0001_baseline` onwards and creates the Receiving lab and the LAB account.
- `db:seed:dev` loads the fictional fixtures: project DEMO-2601, test holes TH26-01 and TH26-02,
  seven test identities and two pending applicants.
- `db:reset:test` builds the test database the automated tests use.

Each ends without an error. Running `npm run db:migrate` a second time reports nothing pending.

## Part 4: run it

```powershell
npm run dev
```

Wait until the output shows the API listening on port 3000 and Vite ready on port 5173. Leave this
window open; **Ctrl+C** stops the app.

Open <http://127.0.0.1:5173> (use `127.0.0.1`, not `localhost`). Choose **Test sign-in
(development only)** and sign in as **Admin (test)**.

Optional extras, each in its own PowerShell window from the checkout (details in the
[README](../../README.md)):

```powershell
npm run mock:printer -w @materialmule/api
```

```powershell
npm run mock:idp -w @materialmule/api
```

## Part 5: check everything works

1. <http://127.0.0.1:5173/api/health> returns `"status":"ok"` and `"database":"up"`. As Admin
   (test), **Settings → System status** shows the database as **Connected**.
2. Sign in as `at` (Alex Tester) at <http://127.0.0.1:5173/sign-in/test>, open **Receive
   samples**, choose **DEMO-2601**, add a bucket with a summary for **TH26-01**, review and
   confirm. The receipt issues a storage unit ID such as `BKT-2026-000001`, and **Preview label** on the
   labels step shows its label.
3. Run the full gate (stop `npm run dev` first with Ctrl+C, so E2E has its ports):
   ```powershell
   npm run verify
   ```
   ```powershell
   npx playwright install chromium
   ```
   ```powershell
   npm run test:e2e
   ```
   Both `verify` and `test:e2e` must pass. A clean install that fails them is a bug to report, not
   something to work around.

Then `npm run dev` again to keep using the app.

## Optional: the Windows service install

Parts 3–5 set the PC up for development (`npm run dev`). To run Material Mule as an always-on
Windows service over HTTPS for other office PCs and phones, after Part 2:

1. Build a release on the development checkout: `npm run verify`, then `npm run release:pack`
   ([runbook: Build a release](runbook.md#build-a-release)).
2. Follow [runbook: First install](runbook.md#first-install) from step 1. It needs IT's inputs
   (host name, certificate, service account, firewall scope) first; see
   [runbook: IT inputs](runbook.md#it-inputs). Production starts with an empty database (D42):
   never load the development fixtures there.

## Troubleshooting

| Symptom                                                         | Fix                                                                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Remove-Item` says a file is in use                             | A `node` process or editor still has the folder open; repeat step 1.1                                          |
| `DROP DATABASE` / `DROP ROLE` fails                             | See the note at the end of step 1.3                                                                            |
| `psql: password authentication failed for user "postgres"`      | Wrong `postgres` password. If nobody knows it, do the full wipe (step 1.5)                                     |
| `npm ci` says the Node.js version is unsupported (`EBADENGINE`) | Install Node.js 24 (Part 2, step 1), reopen PowerShell                                                         |
| `db:migrate` refuses the database (retired lineage)             | An old database survived; check `DATABASE_URL` names `materialmule_dev`, and that step 1.3 dropped the old one |
| `Invalid configuration: - SESSION_SECRET is required`           | Set `SESSION_SECRET` (32+ characters) in that `.env` file (step 3.3)                                           |
| `password authentication failed for user "materialmule"`        | The password in `DATABASE_URL` doesn't match the one in step 3.2                                               |
| Sign-in page says no sign-in method is set up                   | `ENABLE_TEST_AUTH=true` in `apps/api/.env`, then restart `npm run dev`                                         |
| `Port 5173 is in use` or E2E waits for its port                 | Something from the old setup still runs; repeat step 1.1                                                       |

More in the [README troubleshooting table](../../README.md#troubleshooting).
