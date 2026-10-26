# Trapezoid operations runbook (Windows host)

How to install, upgrade, roll back and look after Trapezoid on the office Windows PC (TRP-T20,
decision D25). Written so someone who did not build the app can follow it step by step.

- The API is a Node.js app run as the Windows service **Trapezoid** (wrapped by WinSW). It serves
  the web app and `/api` from one HTTPS address, e.g. `https://trapezoid.example.internal`.
- PostgreSQL 17 runs on the same PC as its own service and only accepts local connections.
- Nothing is reachable from outside the office network (D26).

> Values in _italics_ like _trapezoid.example.internal_ are placeholders. The real ones come from IT
> (see [IT inputs](#it-inputs)).

## Contents

1. [IT inputs](#it-inputs)
2. [Folder layout](#folder-layout)
3. [First install](#first-install)
4. [Build a release](#build-a-release) (developer PC)
5. [Upgrade](#upgrade)
6. [Roll back](#roll-back)
7. [Rotate secrets](#rotate-secrets)
8. [Renew the certificate](#renew-the-certificate)
9. [Logs and health](#logs-and-health)
10. [Host acceptance tests (T1–T6)](#host-acceptance-tests-t1t6)
11. [Performance benchmark (TRP-T19)](#performance-benchmark-trp-t19)
12. [Troubleshooting](#troubleshooting)

## IT inputs

Still needed before the first install. Record the answers in `host.config.psd1` / `trapezoid.env`
on the host, not in the repository.

| Input                       | Used for                                                            | Where it goes                                       |
| --------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| Host PC and Windows edition | Runs everything (Windows 11 Pro or Windows Server)                  | —                                                   |
| Production host name (DNS)  | The address staff use; must resolve on the office network           | `HealthUrl`, certificate, Microsoft redirect URI    |
| Certificate approach        | Internal CA or a public certificate for the internal name           | `TLS_PFX_FILE` (+ passphrase) or PEM pair           |
| Trust on devices            | Office PCs and staff phones must trust the issuing CA (camera, T17) | IT pushes the CA (GPO / MDM)                        |
| HTTPS port                  | 443 unless IT says otherwise                                        | `PORT`, `HttpsPort`                                 |
| Firewall scope              | Network profile(s) and address ranges allowed in                    | `FirewallProfiles`, `FirewallRemoteAddresses`       |
| Service account             | Dedicated low-privilege account (virtual account or gMSA preferred) | `ServiceAccount`                                    |
| Windows Update window       | When the host may restart                                           | IT policy (active hours / maintenance window)       |
| Operational owner           | Who upgrades, watches health and renews the certificate             | This runbook's front page                           |
| Backup design (D39, T21)    | Pre-deploy backup                                                   | `BackupScript` (until then: manual + `-SkipBackup`) |

Not decided here: Microsoft sign-in timing (D38) and backup/recovery design (D39). The scripts
work without either.

## Folder layout

```
C:\Trapezoid\                      InstallRoot (Administrators, SYSTEM: full; service account: read)
  config\                          service account: read
    host.config.psd1               settings for the scripts (no secrets)
    trapezoid.env                  the service's environment (secrets: DB app role, TLS passphrase)
    tls\trapezoid.pfx              certificate from IT
    admin\                         Administrators only
      migrate.env                  migration role's DATABASE_URL (deploy script only)
  releases\0.2.0-ab12cd3\          one folder per release (KeepReleases newest are kept)
  current -> releases\<version>    junction the service runs from
  service\trapezoid-service.exe    WinSW (manual download) + generated trapezoid-service.xml
  logs\                            service logs + deploy.log (service account: modify)
  deploy-state.json                current/previous release and deploy history
```

## First install

Do these once, signed in to the host as a local administrator. Every command runs in an
**elevated PowerShell 7** window ("Run as administrator") unless it says otherwise.

### 1. Install the prerequisites (manual downloads)

Download each installer yourself from the vendor's site, on the host. The scripts never download
anything.

1. **Node.js 24 LTS** (Windows x64 `.msi`) from <https://nodejs.org>. Default options; do **not**
   tick "Automatically install the necessary tools". Check: `node --version` prints `v24.…`.
2. **PowerShell 7** (`.msi`) from Microsoft (<https://aka.ms/powershell>). The scripts need it.
3. **PostgreSQL 17** from the EDB installer (<https://www.postgresql.org/download/windows/>).
   Remember the `postgres` password you choose; keep it in the team's password manager.
   Skip Stack Builder.
4. **WinSW 2.12.0** `WinSW-x64.exe` from <https://github.com/winsw/winsw/releases> (MIT licence).
   Save it as `C:\Trapezoid\service\trapezoid-service.exe` (create the folder if needed). Record its
   hash: `(Get-FileHash C:\Trapezoid\service\trapezoid-service.exe).Hash` → `WinSWSha256` below.

Script files copied from a network share or a downloaded zip may be marked as "from the internet".
Check where they came from, then `Get-ChildItem C:\Trapezoid\releases -Recurse | Unblock-File`.
Never use `-ExecutionPolicy Bypass`.

### 2. Lock PostgreSQL to this PC (AC5)

1. In `C:\Program Files\PostgreSQL\17\data\postgresql.conf` set `listen_addresses = 'localhost'`.
2. In `pg_hba.conf` keep only the `127.0.0.1/32` and `::1/128` `host` lines (method
   `scram-sha-256`). Delete any `0.0.0.0/0`, `all` or subnet lines.
3. If the installer created a Windows Firewall rule for port 5432, disable it:
   `Get-NetFirewallPortFilter | Where-Object LocalPort -eq 5432 | Get-NetFirewallRule`.
4. Restart PostgreSQL: `Restart-Service postgresql-x64-17`.

`Install-TrapezoidHost.ps1` checks all three and warns if anything is still open.

### 3. Create the database and roles

```powershell
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
& $psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE trapezoid"
```

Get a release folder onto the host first (see [Build a release](#build-a-release)), e.g.
`D:\trapezoid-0.2.0-ab12cd3`, then create the two roles (prompts for the `postgres` password; it
is used only for this command):

```powershell
$release = 'D:\trapezoid-0.2.0-ab12cd3'
$env:DATABASE_ADMIN_URL = 'postgres://postgres@127.0.0.1:5432/trapezoid'
$env:PGPASSWORD = (Read-Host 'postgres password' -MaskInput)
& node "$release\apps\api\dist\db\cli.js" setup-roles trapezoid_owner trapezoid_app
Remove-Item Env:PGPASSWORD, Env:DATABASE_ADMIN_URL
```

Give each role a long random password (generate with the password manager, store it there):

```powershell
& $psql -h 127.0.0.1 -U postgres -d trapezoid -c "\password trapezoid_owner"
& $psql -h 127.0.0.1 -U postgres -d trapezoid -c "\password trapezoid_app"
```

(`setup-roles` runs again after the first deploy, step 7.)

### 4. Configuration files

1. `mkdir C:\Trapezoid\config\admin, C:\Trapezoid\config\tls` (if missing).
2. Copy `deploy\windows\host.config.example.psd1` from the release to
   `C:\Trapezoid\config\host.config.psd1` and fill in every **IT INPUT** line, `ServiceAccount`
   and `WinSWSha256`.
3. Copy `deploy\windows\trapezoid.env.example` to `C:\Trapezoid\config\trapezoid.env`. Fill in:
   `DATABASE_URL` (the `trapezoid_app` password), a new `SESSION_SECRET`
   (`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`), the
   certificate settings and `PORT`.
4. Copy `deploy\windows\migrate.env.example` to `C:\Trapezoid\config\admin\migrate.env` and put
   the `trapezoid_owner` password in its `DATABASE_URL`.
5. Put IT's certificate at `C:\Trapezoid\config\tls\trapezoid.pfx` (or the PEM pair). The
   certificate's subject alternative names must include the production host name.

Never copy these files into the repository, email or chat.

### 5. Prepare the host

Preview first; it changes nothing:

```powershell
cd D:\trapezoid-0.2.0-ab12cd3\deploy\windows
.\Install-TrapezoidHost.ps1 -ConfigPath C:\Trapezoid\config\host.config.psd1 -WhatIf
```

Read the list, then run it for real (same command without `-WhatIf`). It creates the folders,
registers the service (automatic, delayed start after PostgreSQL, restart after 10 s / 30 s / 2 min
on failure), sets folder permissions, opens **only** the HTTPS port on the configured profile(s),
sets PostgreSQL to start automatically and stops the PC sleeping or hibernating on mains power.
Re-running it is safe. Use `-Skip Firewall,Power` where IT manages those by policy.

If `ServiceAccount` is a normal account with a password, WinSW asks for it during install.

Then agree the Windows Update restart window with IT (outside office hours).

### 6. First deploy

```powershell
.\Deploy-Trapezoid.ps1 -ConfigPath C:\Trapezoid\config\host.config.psd1 -Release D:\trapezoid-0.2.0-ab12cd3 -SkipBackup
```

(`-SkipBackup` is fine here: the database is empty. Production starts empty, D42.)

### 7. Finish the roles

Re-run the `setup-roles` command from step 3. Now that the tables exist, it makes
`schema_migration` read-only and `audit_event` append-only for the app role.

### 8. Check

- `https://`_trapezoid.example.internal_ opens with no certificate warning on an office PC and on
  a phone on the office Wi-Fi, and sign-in works (AC2).
- Run the [host acceptance tests](#host-acceptance-tests-t1t6) and record the results on the card.

## Build a release

On the developer PC (not the host), from a clean checkout of `main`:

```powershell
git switch main; git pull
npm ci
npm run verify          # lint, typecheck, tests, build, bundle secret check
npm run release:pack    # -> release\trapezoid-<version>-<commit>\
```

The folder holds the built API and web app, migrations, production `node_modules` (installed from
the lockfile with install scripts disabled), the deploy scripts and `release.json`. It contains no
`.env` files or secrets. Copy the whole folder to the host (USB drive or a network share IT
approves), e.g. to `D:\`.

## Upgrade

This is the routine task (AC6). Allow 10 minutes, outside busy receiving hours.

1. Tell the lab the app will be unavailable for about a minute.
2. **Back up the database.** Until TRP-T21 provides `BackupScript`, take a manual backup:
   ```powershell
   $stamp = Get-Date -Format yyyyMMdd-HHmm
   & 'C:\Program Files\PostgreSQL\17\bin\pg_dump.exe' -h 127.0.0.1 -U postgres -Fc -f "E:\backups\trapezoid-$stamp.dump" trapezoid
   ```
   (`E:\backups` = the separate backup location D25 requires. Check the file is not empty.)
3. Copy the new release folder to the host, e.g. `D:\trapezoid-0.3.0-cd34ef5`.
4. Open an elevated PowerShell 7 window and preview:
   ```powershell
   cd C:\Trapezoid\current\deploy\windows
   .\Deploy-Trapezoid.ps1 -ConfigPath C:\Trapezoid\config\host.config.psd1 -Release D:\trapezoid-0.3.0-cd34ef5 -SkipBackup -WhatIf
   ```
5. Run it (same command without `-WhatIf`; drop `-SkipBackup` once `BackupScript` is set).
6. Read the last line:
   - `Outcome: Deployed` (exit code 0): done. Open the app and check the version under `/api/health`.
   - `Outcome: RolledBack` (exit code 1): the new release failed its migrations or health check and
     the previous release is running again. Nothing else to do now; send `C:\Trapezoid\logs\deploy.log`
     and the service logs to the developer.
   - `Outcome: RollbackFailed` / `Failed` (exit code 2): the app is down. Go to
     [Troubleshooting](#troubleshooting).
   - `Stopped: …` (exit code 3): refused before switching anything (bad configuration, backup
     failed, release already present, service would not stop). The running release is unchanged.
7. Delete the copied release folder from `D:\` (the host keeps its own copy under `releases\`).

What the script does: backup (if configured) → copy the release into `releases\` → stop the
service (the API finishes any label being sent and closes its database connections) → point
`current` at the new release → run migrations as `trapezoid_owner` → start → wait up to
`HealthTimeoutSeconds` for `GET /api/health` to return 200 `"status":"ok"` → on any failure, stop,
point `current` back at the previous release and start it.

## Roll back

**Automatic:** see Upgrade step 6.

**By hand** (e.g. a bug found after a successful upgrade):

```powershell
cd C:\Trapezoid\current\deploy\windows
.\Deploy-Trapezoid.ps1 -ConfigPath C:\Trapezoid\config\host.config.psd1 -Rollback              # to the previous release
.\Deploy-Trapezoid.ps1 -ConfigPath C:\Trapezoid\config\host.config.psd1 -Rollback -ToVersion 0.2.0-ab12cd3
```

Migrations are forward-only: rolling back the code does not undo schema changes. Releases are
written so the previous release still runs on the newer schema; if a release says otherwise in its
notes, or the previous release fails its health check after a rollback, restore the backup taken
before the upgrade (`pg_restore`, TRP-T21) and then roll back.

## Rotate secrets

Edit the file, then restart the service: `Restart-Service Trapezoid`, and check `/api/health`.

| Secret                          | How                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `trapezoid_app` password        | `psql … -c "\password trapezoid_app"`, update `DATABASE_URL` in `trapezoid.env`, restart            |
| `trapezoid_owner` password      | `psql … -c "\password trapezoid_owner"`, update `config\admin\migrate.env` (no restart needed)      |
| `postgres` password             | `psql … -c "\password postgres"`; update the password manager                                       |
| `SESSION_SECRET`                | New random value in `trapezoid.env`, restart                                                        |
| `TLS_PFX_PASSPHRASE`            | Comes with a new certificate file; see below                                                        |
| `MICROSOFT_CLIENT_SECRET` (D38) | New secret from IT's app registration, update `trapezoid.env`, restart, then IT deletes the old one |

After any rotation, check no secret reached the logs (AC4):

```powershell
node C:\Trapezoid\current\scripts\check-bundle-secrets.mjs --dir C:\Trapezoid\current\apps\web\dist --logs C:\Trapezoid\logs --env-file C:\Trapezoid\config\trapezoid.env --env-file C:\Trapezoid\config\admin\migrate.env
```

## Renew the certificate

Before the expiry date (put a reminder in the operational owner's calendar a month ahead):

1. Get the new certificate from IT (same host name).
2. Save it next to the old one, e.g. `C:\Trapezoid\config\tls\trapezoid-2027.pfx`.
3. Update `TLS_PFX_FILE` (and `TLS_PFX_PASSPHRASE`) in `trapezoid.env`.
4. `Restart-Service Trapezoid`. If it does not come back, the log names the bad setting (never the
   value); fix it or point back at the old file.
5. In a browser, check the padlock shows the new expiry date. Delete the old file.

Check the current expiry from the host:
`(Get-PfxData C:\Trapezoid\config\tls\trapezoid.pfx -Password (Read-Host -AsSecureString)).EndEntityCertificates.NotAfter`.

## Logs and health

| What                     | Where                                                                       |
| ------------------------ | --------------------------------------------------------------------------- |
| API (JSON lines, pino)   | `C:\Trapezoid\logs\trapezoid-service.out.log` (rolled at 10 MB, 10 kept)    |
| API errors / crashes     | `C:\Trapezoid\logs\trapezoid-service.err.log`                               |
| Service wrapper          | `C:\Trapezoid\logs\trapezoid-service.wrapper.log`                           |
| Deploys and rollbacks    | `C:\Trapezoid\logs\deploy.log`, history in `C:\Trapezoid\deploy-state.json` |
| Service start/stop/crash | Event Viewer → Windows Logs → System, source "Service Control Manager"      |
| PostgreSQL               | `C:\Program Files\PostgreSQL\17\data\log\`                                  |

Health: `GET https://`_host_`/api/health` returns 200 `{"status":"ok","version":…,"database":"up"}`,
or 503 when the database is down. Logs never contain passwords, cookies or connection strings
(redacted at the source); report it as a bug if one does.

## Host acceptance tests (T1–T6)

Run on the host (or a spare Windows PC / VM first) and record date, who, and result on the
TRP-T20 card.

| ID  | Test                                       | How                                                                                                                                                                                                  | Pass when                                         |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| T1  | Fresh install via scripts                  | Follow [First install](#first-install) on a clean PC/VM                                                                                                                                              | `Get-Service Trapezoid` is Running; health 200    |
| T2  | Reboot without login (AC1)                 | `Restart-Computer`; don't sign in; from another PC open `/api/health`                                                                                                                                | 200 within 3 minutes                              |
| T3  | Broken release rolls back (AC3)            | Copy a release folder to `D:\trapezoid-broken`, set `"version"` in its `release.json` to e.g. `0.0.0-broken`, replace `apps\api\dist\main.js` with the single line `process.exit(1)`, then deploy it | `Outcome: RolledBack`; previous version serving   |
| T4  | Desktop and phone, certificate trust (AC2) | Open the URL in Edge/Chrome on an office PC and on iOS + Android phones on office Wi-Fi; sign in                                                                                                     | No warning; sign-in works; camera scan works      |
| T5  | Port scan (AC5)                            | From another PC: `Test-NetConnection <host> -Port 5432` and `-Port 443` (or `nmap -p- <host>` if IT allows)                                                                                          | 5432 fails; only the HTTPS port is open           |
| T6  | Crash restart                              | `Stop-Process -Name node -Force` on the host (only the Trapezoid node process runs there)                                                                                                            | Service is Running again within ~10 s; health 200 |

Also for AC4: run the secret check command under [Rotate secrets](#rotate-secrets) after T1–T6.
For AC6: a second person performs one [Upgrade](#upgrade) using only this page and notes any step
that was unclear.

## Performance benchmark (TRP-T19)

Before go-live (or out of hours), measure the host with the TRP-T19 benchmark: a separate
`trapezoid_bench` database and role, a separate checkout with `npm ci`, then `npm run bench:seed`,
`bench:explain` and `bench:load` for the ten-year and stress datasets. It never touches the
`trapezoid` database and refuses any database without "bench" or "test" in its name. Step by step,
including clean-up: [docs/performance/README.md](../performance/README.md#run-it-on-the-host-ac2).

## Troubleshooting

**The service won't start.** Look at `trapezoid-service.err.log`. "Invalid configuration" lists
each bad key in `trapezoid.env` by name. "TLS_PFX_FILE could not be read" means the path or the
service account's read permission is wrong. A PFX error at startup usually means a wrong
passphrase.

**Health check fails but the service runs.** Open `/api/health` in a browser on the host:
`"database":"down"` → is `postgresql-x64-17` running, and is the `trapezoid_app` password in
`DATABASE_URL` right? A certificate error from the deploy script → the host itself must trust the
certificate and resolve the host name to itself.

**RollbackFailed.** The previous release didn't come back either, usually because a migration in
the failed release changed something it relies on. Restore the pre-upgrade backup:

```powershell
Stop-Service Trapezoid
& 'C:\Program Files\PostgreSQL\17\bin\pg_restore.exe' -h 127.0.0.1 -U postgres -d trapezoid --clean --if-exists E:\backups\trapezoid-<stamp>.dump
Start-Service Trapezoid
```

then check `/api/health` and contact the developer.

**Phones show a certificate warning.** The phone doesn't trust IT's CA: IT installs the CA
profile through MDM (camera scanning needs a trusted HTTPS page, T17).
