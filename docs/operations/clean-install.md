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
owns something, or holds privileges, in a database you did **not** drop (often `postgres`, or a
database of another app). **Never run `DROP OWNED BY` there:** it deletes every table and other
object the role owns in that database, with their data. Inspect first (review fix #99; the SQL
below is proven in `apps/api/src/db/clean-install-guide.test.ts`):

1. See which databases still depend on the role (`owner`: it owns objects there; `privileges`:
   it was only granted access). This only reads:

   ```powershell
   $env:PGPASSWORD = (Read-Host 'postgres password' -MaskInput)
   $role = '<role>'   # the role DROP ROLE refused, e.g. materialmule
   @'
   -- role-dependencies-by-database
   SELECT coalesce(d.datname, '(shared: a database or tablespace itself)') AS database,
          CASE s.deptype WHEN 'o' THEN 'owner' WHEN 'a' THEN 'privileges' WHEN 'i' THEN 'privileges'
                         WHEN 'r' THEN 'row security policy' ELSE s.deptype::text END AS dependency,
          count(*) AS objects
     FROM pg_shdepend s JOIN pg_roles r ON r.oid = s.refobjid
     LEFT JOIN pg_database d ON d.oid = s.dbid
    WHERE s.refclassid = 'pg_authid'::regclass AND r.rolname = :'role'
    GROUP BY 1, 2 ORDER BY 1, 2;
   '@ | & $psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -v role=$role
   ```

2. For **each** database it lists, list the exact objects (this only reads too):

   ```powershell
   $database = '<database>'   # one database from step 1
   @'
   -- role-dependencies-in-database
   SELECT pg_describe_object(s.classid, s.objid, s.objsubid) AS object,
          CASE s.deptype WHEN 'o' THEN 'owner' WHEN 'a' THEN 'privileges' WHEN 'i' THEN 'privileges'
                         WHEN 'r' THEN 'row security policy' ELSE s.deptype::text END AS dependency
     FROM pg_shdepend s JOIN pg_roles r ON r.oid = s.refobjid
    WHERE s.refclassid = 'pg_authid'::regclass AND r.rolname = :'role'
      AND s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    ORDER BY 2, 1;
   '@ | & $psql -h 127.0.0.1 -U postgres -d $database -v ON_ERROR_STOP=1 -v role=$role
   ```

3. Decide, per database, and **ask** if you are not sure who the objects belong to:
   - **Keep the objects** (the usual case for a database you are keeping): give them to their
     intended owner, then remove the role's remaining privileges. `REASSIGN OWNED` runs first and
     moves every object the role owns in that database, so nothing is deleted; the `DROP OWNED`
     after it then only revokes privileges (and the role's default privileges). Both run in one
     transaction, which refuses and changes nothing unless the new owner is an existing role
     other than `$role`:

     ```powershell
     $newOwner = '<intended owner>'   # an existing role, e.g. the owner of that database
     @'
     -- role-hand-over
     SELECT set_config('materialmule.cleanup_role', :'role', true) AS role,
            set_config('materialmule.cleanup_new_owner', :'new_owner', true) AS new_owner;
     DO $$
     DECLARE
       old_role text := current_setting('materialmule.cleanup_role');
       new_owner text := current_setting('materialmule.cleanup_new_owner');
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = old_role) THEN
         RAISE EXCEPTION 'role % does not exist; nothing was changed', old_role;
       END IF;
       IF new_owner = old_role OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = new_owner) THEN
         RAISE EXCEPTION 'new owner must be an existing role other than %; nothing was changed', old_role;
       END IF;
       EXECUTE format('REASSIGN OWNED BY %I TO %I', old_role, new_owner);
       EXECUTE format('DROP OWNED BY %I', old_role);
     END
     $$;
     '@ | & $psql -h 127.0.0.1 -U postgres -d $database -v ON_ERROR_STOP=1 -1 -v role=$role -v new_owner=$newOwner
     ```

     Run step 2 again: it now lists nothing for that database.

   - **Keep the role** instead: leave it and stop here. In [3.2](#32-create-the-role-and-databases)
     use `ALTER ROLE materialmule LOGIN` in place of `CREATE ROLE materialmule LOGIN`.
   - Drop an object only once step 2 has shown it and you have confirmed that **it** is
     disposable, and drop it by name (`DROP TABLE <schema>.<table>;`), never with `DROP OWNED`.

4. Repeat the `DROP ROLE` above. If it still refuses, its message names the database and object
   left: go back to step 2 for that database. When done, `Remove-Item Env:PGPASSWORD`.

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

Pick a new local password for the `materialmule` login (it is only used on this PC) and save it
in the password manager. The password is never typed into a command: the login is created
without one, and psql's `\password` asks for it twice, hidden, and sends PostgreSQL only its
SCRAM hash, so it never appears in the command line, the process list or the server log (review
fix #99). Any characters work, including `'`, `$`, `@`, `/` and `:`.

```powershell
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
$env:PGPASSWORD = (Read-Host 'postgres password' -MaskInput)
& $psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE materialmule LOGIN"
& $psql -h 127.0.0.1 -U postgres -d postgres -c '\password materialmule'
& $psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE materialmule_dev OWNER materialmule"
& $psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE materialmule_test OWNER materialmule"
Remove-Item Env:PGPASSWORD
```

(If you kept the old `materialmule` role in [1.3](#13-drop-the-old-databases-and-roles), use
`ALTER ROLE materialmule LOGIN` in the first `-c` instead.)

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

`<password>` in `DATABASE_URL` is the password **percent-encoded**: a URL can't hold `@`, `:`,
`/`, `#`, `?`, `%` and other characters as they are. This prints the encoded form (type the
password at the hidden prompt; it is not kept anywhere):

```powershell
[uri]::EscapeDataString([System.Net.NetworkCredential]::new('', (Read-Host 'materialmule password' -AsSecureString)).Password)
```

For example the fictional password `it's$a/b@c:d` becomes `it%27s%24a%2Fb%40c%3Ad`. Paste the
printed text in place of `<password>`, then clear the screen (`Clear-Host`).

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
