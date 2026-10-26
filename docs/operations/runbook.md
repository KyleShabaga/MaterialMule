# Material Mule operations runbook (Windows host)

How to install, upgrade, roll back and look after Material Mule on the office Windows PC (MM-T20,
decision D25). Written so someone who did not build the app can follow it step by step.

- The API is a Node.js app run as the Windows service **Material Mule** (wrapped by WinSW). It serves
  the web app and `/api` from one HTTPS address, e.g. `https://materialmule.example.internal`.
- PostgreSQL 17 runs on the same PC as its own service and only accepts local connections.
- Nothing is reachable from outside the office network (D26).

> Values in _italics_ like _materialmule.example.internal_ are placeholders. The real ones come from IT
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
10. [Backups and restore drills](#backups-and-restore-drills) (MM-T21)
11. [Monitoring and alerts](#monitoring-and-alerts) (MM-T21)
12. [Recover production from a backup](#recover-production-from-a-backup)
13. [Host acceptance tests (T1–T6)](#host-acceptance-tests-t1t6)
14. [Backup acceptance tests (MM-T21)](#backup-acceptance-tests-mm-t21)
15. [Performance benchmark (MM-T19)](#performance-benchmark-mm-t19)
16. [Troubleshooting](#troubleshooting)

## IT inputs

Still needed before the first install. Record the answers in `host.config.psd1` / `materialmule.env`
on the host, not in the repository.

| Input                       | Used for                                                            | Where it goes                                    |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| Host PC and Windows edition | Runs everything (Windows 11 Pro or Windows Server)                  | —                                                |
| Production host name (DNS)  | The address staff use; must resolve on the office network           | `HealthUrl`, certificate, Microsoft redirect URI |
| Certificate approach        | Internal CA or a public certificate for the internal name           | `TLS_PFX_FILE` (+ passphrase) or PEM pair        |
| Trust on devices            | Office PCs and staff phones must trust the issuing CA (camera, T17) | IT pushes the CA (GPO / MDM)                     |
| HTTPS port                  | 443 unless IT says otherwise                                        | `PORT`, `HttpsPort`                              |
| Firewall scope              | Network profile(s) and address ranges allowed in                    | `FirewallProfiles`, `FirewallRemoteAddresses`    |
| Service account             | Dedicated low-privilege account (virtual account or gMSA preferred) | `ServiceAccount`                                 |
| Windows Update window       | When the host may restart                                           | IT policy (active hours / maintenance window)    |
| Operational owner           | Who upgrades, watches health and renews the certificate             | This runbook's front page                        |
| Backup design (D39, T21)    | Scheduled and pre-deploy backups, restore drills, alerts            | `backup.config.psd1` (see below)                 |

Not decided here: Microsoft sign-in timing (D38) and backup/recovery design (D39). The T20 scripts
work without either; the T21 backup scripts **refuse to run** until IT has set every D39 value.

### Backup decisions IT still has to make (D39)

`deploy\windows\backup.config.example.psd1` leaves these empty on purpose. The proposals come from
the MM-T21 card and are **proposals pending IT**, not decisions.

| Setting                    | Decision                                                            | Proposal (pending IT)                        |
| -------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| `BackupTarget`             | Separate device or approved location (D25); IT picks the hardware   | none (IT's choice)                           |
| `TargetEncryptedAtRest`    | IT confirms the location is encrypted at rest (BitLocker, NAS, ...) | must be `$true`; the app doesn't encrypt     |
| `RpoHours`                 | Recovery point objective: the most data we may lose                 | ≤ 24 h, ideally 4-hourly dumps or hourly WAL |
| `RtoHours`                 | Recovery time objective: how long a recovery may take               | ≤ 4 h                                        |
| `KeepDaily/Weekly/Monthly` | Retention                                                           | 14 daily, 8 weekly, 12 monthly               |
| `BackupOwner`              | Who owns backups and the restore drills                             | —                                            |
| `AlertRecipient`           | Who IT's monitoring forwards the Material Mule event log alerts to  | —                                            |
| `BackupAccount`            | Windows account the scheduled tasks run as (gMSA preferred)         | —                                            |
| `BackupTimes`              | When the backup runs (follows the RPO)                              | `@('02:00')` for a 24 h RPO                  |
| Secrets recovery           | Password manager entry IT owns for every secret in the env files    | —                                            |

WAL archiving (for an RPO shorter than the dump interval) is not built; ask the developer if IT
wants it.

## Folder layout

```
C:\MaterialMule\                      InstallRoot (Administrators, SYSTEM: full; service account: read)
  config\                          service account: read
    host.config.psd1               settings for the scripts (no secrets)
    materialmule.env                  the service's environment (secrets: DB app role, TLS passphrase)
    tls\materialmule.pfx              certificate from IT
    admin\                         Administrators only
      migrate.env                  migration role's DATABASE_URL (deploy script only)
  releases\0.2.0-ab12cd3\          one folder per release (KeepReleases newest are kept)
  current -> releases\<version>    junction the service runs from
  service\materialmule-service.exe    WinSW (manual download) + generated materialmule-service.xml
  logs\                            service logs + deploy.log (service account: modify)
  deploy-state.json                current/previous release and deploy history
  ops\                             MM-T21 (Administrators, SYSTEM: full; backup account: modify)
    staging\                       local copy while a backup runs (kept only after a failed copy)
    status\                        backup-status.json, monitor-status.json (service account: read)
    logs\                          backup.log, monitor.log, restore.log, restore-drills.jsonl
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
   Save it as `C:\MaterialMule\service\materialmule-service.exe` (create the folder if needed). Record its
   hash: `(Get-FileHash C:\MaterialMule\service\materialmule-service.exe).Hash` → `WinSWSha256` below.

Script files copied from a network share or a downloaded zip may be marked as "from the internet".
Check where they came from, then `Get-ChildItem C:\MaterialMule\releases -Recurse | Unblock-File`.
Never use `-ExecutionPolicy Bypass`.

### 2. Lock PostgreSQL to this PC (AC5)

1. In `C:\Program Files\PostgreSQL\17\data\postgresql.conf` set `listen_addresses = 'localhost'`.
2. In `pg_hba.conf` keep only the `127.0.0.1/32` and `::1/128` `host` lines (method
   `scram-sha-256`). Delete any `0.0.0.0/0`, `all` or subnet lines.
3. If the installer created a Windows Firewall rule for port 5432, disable it:
   `Get-NetFirewallPortFilter | Where-Object LocalPort -eq 5432 | Get-NetFirewallRule`.
4. Restart PostgreSQL: `Restart-Service postgresql-x64-17`.

`Install-MaterialMuleHost.ps1` checks all three and warns if anything is still open.

### 3. Create the database and roles

```powershell
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
& $psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE materialmule"
```

Get a release folder onto the host first (see [Build a release](#build-a-release)), e.g.
`D:\materialmule-0.2.0-ab12cd3`, then create the two roles (prompts for the `postgres` password; it
is used only for this command):

```powershell
$release = 'D:\materialmule-0.2.0-ab12cd3'
$env:DATABASE_ADMIN_URL = 'postgres://postgres@127.0.0.1:5432/materialmule'
$env:PGPASSWORD = (Read-Host 'postgres password' -MaskInput)
& node "$release\apps\api\dist\db\cli.js" setup-roles materialmule_owner materialmule_app
Remove-Item Env:PGPASSWORD, Env:DATABASE_ADMIN_URL
```

Give each role a long random password (generate with the password manager, store it there):

```powershell
& $psql -h 127.0.0.1 -U postgres -d materialmule -c "\password materialmule_owner"
& $psql -h 127.0.0.1 -U postgres -d materialmule -c "\password materialmule_app"
```

(`setup-roles` runs again after the first deploy, step 7.)

Once IT has decided the backup design (D39), add the read-only backup role as a third argument
(`setup-roles materialmule_owner materialmule_app materialmule_backup`); see
[Backups and restore drills](#backups-and-restore-drills).

### 4. Configuration files

1. `mkdir C:\MaterialMule\config\admin, C:\MaterialMule\config\tls` (if missing).
2. Copy `deploy\windows\host.config.example.psd1` from the release to
   `C:\MaterialMule\config\host.config.psd1` and fill in every **IT INPUT** line, `ServiceAccount`
   and `WinSWSha256`.
3. Copy `deploy\windows\materialmule.env.example` to `C:\MaterialMule\config\materialmule.env`. Fill in:
   `DATABASE_URL` (the `materialmule_app` password), a new `SESSION_SECRET`
   (`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`), the
   certificate settings and `PORT`.
4. Copy `deploy\windows\migrate.env.example` to `C:\MaterialMule\config\admin\migrate.env` and put
   the `materialmule_owner` password in its `DATABASE_URL`.
5. Put IT's certificate at `C:\MaterialMule\config\tls\materialmule.pfx` (or the PEM pair). The
   certificate's subject alternative names must include the production host name.

Never copy these files into the repository, email or chat.

### 5. Prepare the host

Preview first; it changes nothing:

```powershell
cd D:\materialmule-0.2.0-ab12cd3\deploy\windows
.\Install-MaterialMuleHost.ps1 -ConfigPath C:\MaterialMule\config\host.config.psd1 -WhatIf
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
.\Deploy-MaterialMule.ps1 -ConfigPath C:\MaterialMule\config\host.config.psd1 -Release D:\materialmule-0.2.0-ab12cd3 -SkipBackup
```

(`-SkipBackup` is fine here: the database is empty. Production starts empty, D42.)

### 7. Finish the roles

Re-run the `setup-roles` command from step 3. Now that the tables exist, it makes
`schema_migration` read-only and `audit_event` append-only for the app role.

### 8. Check

- `https://`_materialmule.example.internal_ opens with no certificate warning on an office PC and on
  a phone on the office Wi-Fi, and sign-in works (AC2).
- Run the [host acceptance tests](#host-acceptance-tests-t1t6) and record the results on the card.

## Build a release

On the developer PC (not the host), from a clean checkout of `main`:

```powershell
git switch main; git pull
npm ci
npm run verify          # lint, typecheck, tests, build, bundle secret check
npm run release:pack    # -> release\materialmule-<version>-<commit>\
```

The folder holds the built API and web app, migrations, production `node_modules` (installed from
the lockfile with install scripts disabled), the deploy scripts and `release.json`. It contains no
`.env` files or secrets. Copy the whole folder to the host (USB drive or a network share IT
approves), e.g. to `D:\`.

## Upgrade

This is the routine task (AC6). Allow 10 minutes, outside busy receiving hours.

1. Tell the lab the app will be unavailable for about a minute.
2. **Back up the database.** Once backups are set up (`BackupScript` and `BackupConfig` in
   `host.config.psd1`), the deploy script runs `backup.ps1` first and stops if it fails. Until
   then, take a manual backup:
   ```powershell
   $file = "E:\backups\materialmule-manual-$(Get-Date -Format yyyyMMdd-HHmm).dump"
   & 'C:\Program Files\PostgreSQL\17\bin\pg_dump.exe' -h 127.0.0.1 -U postgres -Fc -f $file materialmule
   '{0} *{1}' -f (Get-FileHash $file).Hash.ToLower(), (Split-Path -Leaf $file) | Set-Content ($file -replace '\.dump$', '.sha256')
   ```
   (`E:\backups` = the separate backup location D25 requires. Check the file is not empty.
   `restore.ps1` accepts it thanks to the `.sha256` file, but reports `restored-unverified`
   because a manual dump has no manifest to compare with.)
3. Copy the new release folder to the host, e.g. `D:\materialmule-0.3.0-cd34ef5`.
4. Open an elevated PowerShell 7 window and preview:
   ```powershell
   cd C:\MaterialMule\current\deploy\windows
   .\Deploy-MaterialMule.ps1 -ConfigPath C:\MaterialMule\config\host.config.psd1 -Release D:\materialmule-0.3.0-cd34ef5 -SkipBackup -WhatIf
   ```
5. Run it (same command without `-WhatIf`; drop `-SkipBackup` once `BackupScript` is set).
6. Read the last line:
   - `Outcome: Deployed` (exit code 0): done. Open the app and check the version under `/api/health`.
   - `Outcome: RolledBack` (exit code 1): the new release failed its migrations or health check and
     the previous release is running again. Nothing else to do now; send `C:\MaterialMule\logs\deploy.log`
     and the service logs to the developer.
   - `Outcome: RollbackFailed` / `Failed` (exit code 2): the app is down. Go to
     [Troubleshooting](#troubleshooting).
   - `Stopped: …` (exit code 3): refused before switching anything (bad configuration, backup
     failed, release already present, service would not stop). The running release is unchanged.
7. Delete the copied release folder from `D:\` (the host keeps its own copy under `releases\`).

What the script does: backup (if configured) → copy the release into `releases\` → stop the
service (the API finishes any label being sent and closes its database connections) → point
`current` at the new release → run migrations as `materialmule_owner` → start → wait up to
`HealthTimeoutSeconds` for `GET /api/health` to return 200 `"status":"ok"` → on any failure, stop,
point `current` back at the previous release and start it.

## Roll back

**Automatic:** see Upgrade step 6.

**By hand** (e.g. a bug found after a successful upgrade):

```powershell
cd C:\MaterialMule\current\deploy\windows
.\Deploy-MaterialMule.ps1 -ConfigPath C:\MaterialMule\config\host.config.psd1 -Rollback              # to the previous release
.\Deploy-MaterialMule.ps1 -ConfigPath C:\MaterialMule\config\host.config.psd1 -Rollback -ToVersion 0.2.0-ab12cd3
```

Migrations are forward-only: rolling back the code does not undo schema changes. Releases are
written so the previous release still runs on the newer schema; if a release says otherwise in its
notes, or the previous release fails its health check after a rollback, recover the database from
the backup taken before the upgrade ([Recover production from a backup](#recover-production-from-a-backup))
and then roll back.

## Rotate secrets

Edit the file, then restart the service: `Restart-Service Material Mule`, and check `/api/health`.

| Secret                          | How                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `materialmule_app` password     | `psql … -c "\password materialmule_app"`, update `DATABASE_URL` in `materialmule.env`, restart         |
| `materialmule_owner` password   | `psql … -c "\password materialmule_owner"`, update `config\admin\migrate.env` (no restart needed)      |
| `postgres` password             | `psql … -c "\password postgres"`; update the password manager                                          |
| `SESSION_SECRET`                | New random value in `materialmule.env`, restart                                                        |
| `TLS_PFX_PASSPHRASE`            | Comes with a new certificate file; see below                                                           |
| `MICROSOFT_CLIENT_SECRET` (D38) | New secret from IT's app registration, update `materialmule.env`, restart, then IT deletes the old one |

After any rotation, check no secret reached the logs (AC4):

```powershell
node C:\MaterialMule\current\scripts\check-bundle-secrets.mjs --dir C:\MaterialMule\current\apps\web\dist --logs C:\MaterialMule\logs --env-file C:\MaterialMule\config\materialmule.env --env-file C:\MaterialMule\config\admin\migrate.env
```

## Renew the certificate

Before the expiry date (put a reminder in the operational owner's calendar a month ahead):

1. Get the new certificate from IT (same host name).
2. Save it next to the old one, e.g. `C:\MaterialMule\config\tls\materialmule-2027.pfx`.
3. Update `TLS_PFX_FILE` (and `TLS_PFX_PASSPHRASE`) in `materialmule.env`.
4. `Restart-Service Material Mule`. If it does not come back, the log names the bad setting (never the
   value); fix it or point back at the old file.
5. In a browser, check the padlock shows the new expiry date. Delete the old file.

Check the current expiry from the host:
`(Get-PfxData C:\MaterialMule\config\tls\materialmule.pfx -Password (Read-Host -AsSecureString)).EndEntityCertificates.NotAfter`.

## Logs and health

| What                     | Where                                                                             |
| ------------------------ | --------------------------------------------------------------------------------- |
| API (JSON lines, pino)   | `C:\MaterialMule\logs\materialmule-service.out.log` (rolled at 10 MB, 10 kept)    |
| API errors / crashes     | `C:\MaterialMule\logs\materialmule-service.err.log`                               |
| Service wrapper          | `C:\MaterialMule\logs\materialmule-service.wrapper.log`                           |
| Deploys and rollbacks    | `C:\MaterialMule\logs\deploy.log`, history in `C:\MaterialMule\deploy-state.json` |
| Service start/stop/crash | Event Viewer → Windows Logs → System, source "Service Control Manager"            |
| PostgreSQL               | `C:\Program Files\PostgreSQL\17\data\log\`                                        |
| Backups, monitor, drills | `C:\MaterialMule\ops\logs\` (MM-T21)                                              |
| Backup/monitor alerts    | Event Viewer → Windows Logs → Application, source "MaterialMule"                  |

Health: `GET https://`_host_`/api/health` returns 200 `{"status":"ok","version":…,"database":"up"}`,
or 503 when the database is down. Logs never contain passwords, cookies or connection strings
(redacted at the source); report it as a bug if one does.

Admins see more under **Settings → System status** (`GET /api/admin/system-status`): version,
database, the latest backup's time and result (with a warning when no backup succeeded within the
RPO), the print queue backlog and its oldest waiting job, print worker heartbeat, and free disk
space on the host and (as measured by the last backup) the backup location. It reads the backup
status record from `BACKUP_STATUS_FILE` in `materialmule.env`
(`C:\MaterialMule\ops\status\backup-status.json`); while that is empty the page says backups are not
set up.

### Log rotation (AC5)

| Log                              | Rotation                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Service (`materialmule-service`) | WinSW: at 10 MB, 10 files kept (`Install-MaterialMuleHost.ps1`)              |
| `deploy.log`                     | the deploy script: at 10 MB, 5 files kept                                    |
| `ops\logs\*.log`                 | the backup/monitor/restore scripts: `LogMaxSizeMB` (10), `LogKeepFiles` (10) |
| PostgreSQL                       | its own settings, below                                                      |

PostgreSQL (set once in `postgresql.conf`, then `Restart-Service postgresql-x64-17`): keep a week of
daily files that overwrite themselves, and never log statements (they could hold personal data):

```
logging_collector = on
log_filename = 'postgresql-%a.log'
log_truncate_on_rotation = on
log_rotation_age = 1d
log_rotation_size = 50MB
log_statement = 'none'
```

The API's logs never contain request bodies, tokens, cookies or passwords (pino redaction,
`apps/api/src/logging/logger.ts`); the scripts never handle passwords at all.

## Backups and restore drills

MM-T21. **Only after IT has decided the backup design (D39)**: every script refuses to run while a
D39 value is missing from `backup.config.psd1` ([IT inputs](#backup-decisions-it-still-has-to-make-d39)).

What a backup does (`deploy\windows\backup.ps1`): run `verify-restore.sql` (read-only) → `pg_dump`
in custom format as the read-only `materialmule_backup` role → run the queries again (equal results
mean nothing changed during the dump) → zip the configuration (host and backup config,
`materialmule.env` **with every secret replaced by `<redacted>`**, `release.json`) → write SHA-256
checksums → copy to `BackupTarget` under temporary names, then re-check the checksum there →
retention → write the status record and, on failure, an Error event. Files at the location:

```
materialmule-production-20261026T080000Z-0.3.0-cd34ef5.dump            the database (pg_dump -Fc)
materialmule-production-20261026T080000Z-0.3.0-cd34ef5.manifest.json   verification values at backup time
materialmule-production-20261026T080000Z-0.3.0-cd34ef5.config.zip      configuration without secrets
materialmule-production-20261026T080000Z-0.3.0-cd34ef5.sha256          checksums of the three files
```

Retention keeps every backup from the last 24 hours plus the newest of each of the last
`KeepDaily` days, `KeepWeekly` ISO weeks and `KeepMonthly` months. It only deletes complete
`materialmule-<EnvironmentName>-*` sets in `BackupTarget`; nothing else there is touched.

Secrets are **not** in any backup. Recovering them (DB role passwords, `SESSION_SECRET`, TLS
passphrase, Microsoft client secret) relies on the password manager entry IT owns; check it at
every drill.

### Set up backups (once, after IT's decisions)

Elevated PowerShell 7 on the host:

1. Backup role (read-only; also used by the monitor). Re-run `setup-roles` with the third role,
   then give it a long random password from the password manager:
   ```powershell
   $release = 'C:\MaterialMule\current'
   $env:DATABASE_ADMIN_URL = 'postgres://postgres@127.0.0.1:5432/materialmule'
   $env:PGPASSWORD = (Read-Host 'postgres password' -MaskInput)
   & node "$release\apps\api\dist\db\cli.js" setup-roles materialmule_owner materialmule_app materialmule_backup
   & 'C:\Program Files\PostgreSQL\17\bin\psql.exe' -h 127.0.0.1 -U postgres -d materialmule -c "\password materialmule_backup"
   Remove-Item Env:PGPASSWORD, Env:DATABASE_ADMIN_URL
   ```
2. The backup account (`BackupAccount`, from IT) needs: write access to `BackupTarget` (IT sets
   this on the device or share), and a pgpass file only it and Administrators can read:
   `mkdir C:\MaterialMule\config\backup`, then put this single line in
   `C:\MaterialMule\config\backup\pgpass.conf` (`127.0.0.1:5432:materialmule:materialmule_backup:<password>`),
   and limit the folder to Administrators, SYSTEM and the backup account (Properties → Security).
3. Copy `deploy\windows\backup.config.example.psd1` to `C:\MaterialMule\config\backup.config.psd1` and
   fill in **every** IT decision. Leave nothing at a proposal IT hasn't approved.
4. Preview, then install (creates `C:\MaterialMule\ops`, its permissions, the event log source
   "MaterialMule" and the two scheduled tasks; nothing else changes with `-Skip`):
   ```powershell
   cd C:\MaterialMule\current\deploy\windows
   .\Install-MaterialMuleHost.ps1 -ConfigPath C:\MaterialMule\config\host.config.psd1 -BackupConfigPath C:\MaterialMule\config\backup.config.psd1 -Skip Folders,Service,Permissions,Firewall,Postgres,Power -WhatIf
   ```
   Run it again without `-WhatIf`. For a standard (non-gMSA) backup account it asks for that
   account's password once and hands it to Task Scheduler.
5. Point the app and the deploy script at it, then restart the service:
   - `materialmule.env`: `BACKUP_STATUS_FILE=C:\MaterialMule\ops\status\backup-status.json`
   - `host.config.psd1`: `BackupScript = 'C:\MaterialMule\current\deploy\windows\backup.ps1'` and
     `BackupConfig = 'C:\MaterialMule\config\backup.config.psd1'` (then drop `-SkipBackup`).
6. Run the first backup by hand and check Settings → System status shows it:
   `Start-ScheduledTask -TaskPath '\MaterialMule\' -TaskName 'Material Mule Backup'`.

Backups run as the backup account; never run `backup.ps1` elevated. Exit codes: 0 backed up,
1 failed (recorded and alerted), 2 refused (configuration incomplete; nothing ran).

### Restore drill (AC2, AC6)

A backup only counts once a restore of it has been verified. Do a drill after setup, after every
major upgrade and at least every quarter (or as IT decides), on the host or a spare PC with
PostgreSQL 17. `restore.ps1` **only restores into a new, isolated database**: it refuses the
production database (`DbName`), system databases, any database that already exists, and names
without `restore` in them. It never uses `--clean`.

```powershell
cd C:\MaterialMule\current\deploy\windows
$env:PGPASSWORD = (Read-Host 'postgres password' -MaskInput)
$backup = 'E:\MaterialMuleBackups\materialmule-production-20261026T080000Z-0.3.0-cd34ef5.dump'
.\restore.ps1 -ConfigPath C:\MaterialMule\config\backup.config.psd1 -BackupFile $backup -TargetDatabase materialmule_restore_20261026 -WhatIf
.\restore.ps1 -ConfigPath C:\MaterialMule\config\backup.config.psd1 -BackupFile $backup -TargetDatabase materialmule_restore_20261026 -DropAfterVerify
Remove-Item Env:PGPASSWORD
```

It checks the SHA-256 file, creates the database, restores, runs `verify-restore.sql` on the copy
and compares it with the manifest taken from production at backup time: row counts of receipts,
units, summaries, audit events and print jobs; the latest storage unit ID per prefix and year and
the ID counters; the audit history (latest event and a fingerprint of all of them); and five
spot-checked units. `Result: verified` (exit 0) means everything matches. Each drill is appended to
`C:\MaterialMule\ops\logs\restore-drills.jsonl` with date, duration and result; also record it in the
[drill log](#drill-log) below (AC6). A backup alone is not a verified backup.

#### Drill log

| Date | Who | Backup file | Duration | Result | Notes |
| ---- | --- | ----------- | -------- | ------ | ----- |
|      |     |             |          |        |       |

## Monitoring and alerts

The "Material Mule Monitor" task runs `monitor.ps1` every 5 minutes (`MonitorIntervalMinutes`) and
checks: the Windows service is running; `/api/health` answers 200 with the database up; the last
backup succeeded and is younger than the RPO; no label print job has waited longer than
`PrintQueueMaxAgeMinutes`; at least `MinFreeSpaceGB` free on the host, the PostgreSQL data drive
and the backup location (local drives only; a network share's space is shown when the backup can
measure it). Results: `C:\MaterialMule\ops\status\monitor-status.json`.

Alerts go to the **Windows Application event log, source "MaterialMule"** (the app sends no email,
MM-T21). IT's monitoring forwards them to `AlertRecipient`:

| Event ID | Level       | Meaning                                                     |
| -------- | ----------- | ----------------------------------------------------------- |
| 1000     | Information | Backup succeeded                                            |
| 1001     | Error       | Backup failed (reason in the message)                       |
| 1100     | Warning     | Monitor found a new problem (listed; raised once per issue) |
| 1101     | Information | All monitor checks pass again                               |
| 1200     | Information | Restore drill verified                                      |
| 1201     | Error       | Restore drill failed or did not match                       |

What to do: **1001** → read the reason (e.g. "Backup location unavailable": reconnect the drive or
share), then run the backup task by hand and confirm Settings → System status shows success.
**1100** about backups → the same; about the service or health → [Troubleshooting](#troubleshooting);
about the print queue → check the printer (Settings → Printers); about disk space → free space or
ask IT. If the backup task itself stops running (disabled, account password expired), the monitor
still raises 1100 once the RPO passes, and the status page shows the warning.

## Recover production from a backup

Only when the production database is lost or damaged and the owner has decided to recover. This
is deliberately manual: no script ever restores over production.

1. Stop the service: `Stop-Service Material Mule`.
2. Restore the chosen backup into a **new** database, keeping owners and grants (the roles must
   exist: on a rebuilt host, do [First install](#first-install) steps 1–4 and `setup-roles` first):
   ```powershell
   .\restore.ps1 -ConfigPath C:\MaterialMule\config\backup.config.psd1 -BackupFile <backup>.dump -TargetDatabase materialmule_restore_recovery -KeepOwnership
   ```
   It must end with `Result: verified`.
3. Swap the databases (keeps the damaged one for investigation):
   ```powershell
   $psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
   & $psql -h 127.0.0.1 -U postgres -d postgres -c "ALTER DATABASE materialmule RENAME TO materialmule_damaged_$(Get-Date -Format yyyyMMdd)"
   & $psql -h 127.0.0.1 -U postgres -d postgres -c "ALTER DATABASE materialmule_restore_recovery RENAME TO materialmule"
   ```
4. Re-run `setup-roles` (all three roles) so the database-level grants match, then
   `Start-Service Material Mule` and check `/api/health` and Settings → System status.
5. Restore the secrets from the password manager if the host was rebuilt. Record the recovery like
   a drill.
6. **Before anyone receives samples again:** storage unit IDs issued after the backup's timestamp
   may already be on physical labels, and the restored counters would issue them a second time
   (IDs are never reused). Collect the highest ID per prefix and year printed since the backup
   (labels, paper trail), and have the developer raise `storage_unit_annual_counter` past them
   with an audited correction. Then re-enter the missing receipts from the paper trail.

## Host acceptance tests (T1–T6)

Run on the host (or a spare Windows PC / VM first) and record date, who, and result on the
MM-T20 card.

| ID  | Test                                       | How                                                                                                                                                                                                     | Pass when                                          |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| T1  | Fresh install via scripts                  | Follow [First install](#first-install) on a clean PC/VM                                                                                                                                                 | `Get-Service Material Mule` is Running; health 200 |
| T2  | Reboot without login (AC1)                 | `Restart-Computer`; don't sign in; from another PC open `/api/health`                                                                                                                                   | 200 within 3 minutes                               |
| T3  | Broken release rolls back (AC3)            | Copy a release folder to `D:\materialmule-broken`, set `"version"` in its `release.json` to e.g. `0.0.0-broken`, replace `apps\api\dist\main.js` with the single line `process.exit(1)`, then deploy it | `Outcome: RolledBack`; previous version serving    |
| T4  | Desktop and phone, certificate trust (AC2) | Open the URL in Edge/Chrome on an office PC and on iOS + Android phones on office Wi-Fi; sign in                                                                                                        | No warning; sign-in works; camera scan works       |
| T5  | Port scan (AC5)                            | From another PC: `Test-NetConnection <host> -Port 5432` and `-Port 443` (or `nmap -p- <host>` if IT allows)                                                                                             | 5432 fails; only the HTTPS port is open            |
| T6  | Crash restart                              | `Stop-Process -Name node -Force` on the host (only the Material Mule node process runs there)                                                                                                           | Service is Running again within ~10 s; health 200  |

Also for AC4: run the secret check command under [Rotate secrets](#rotate-secrets) after T1–T6.
For AC6: a second person performs one [Upgrade](#upgrade) using only this page and notes any step
that was unclear.

## Backup acceptance tests (MM-T21)

After [Set up backups](#set-up-backups-once-after-its-decisions), on the host. Record date, who and
result on the MM-T21 card (and drills in the [drill log](#drill-log)). T4 is automated.

| ID  | Test                     | How                                                                                                                           | Pass when                                                                                              |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| T1  | Scheduled backup (AC1)   | Wait for (or `Start-ScheduledTask`) "Material Mule Backup"                                                                    | `.dump`, `.manifest.json`, `.config.zip`, `.sha256` at `BackupTarget`; status page shows time, success |
| T2  | Restore drill (AC2, AC6) | [Restore drill](#restore-drill-ac2-ac6) with the latest backup, timed                                                         | `Result: verified`; duration within the RTO; drill logged                                              |
| T3  | Target unavailable (AC3) | Unplug the drive / disconnect the share, run the backup task                                                                  | Exit 1; status page "Failed: Backup location unavailable"; event 1001 reaches `AlertRecipient`         |
| T4  | Status endpoint (AC4)    | Automated: `apps/api/src/system-status/system-status.test.ts` (admin only; RPO warning)                                       | Non-admins get 403                                                                                     |
| T5  | Log rotation (AC5)       | After a week: list `C:\MaterialMule\logs`, `ops\logs` and the PostgreSQL log folder; run the secret check from Rotate secrets | Sizes bounded; no passwords, cookies or tokens found                                                   |

Also for AC4: disable the backup task for longer than the RPO (or set `RpoHours` low on a test
host) and check the status page shows "Overdue" and the monitor raises event 1100.

## Performance benchmark (MM-T19)

Before go-live (or out of hours), measure the host with the MM-T19 benchmark: a separate
`materialmule_bench` database and role, a separate checkout with `npm ci`, then `npm run bench:seed`,
`bench:explain` and `bench:load` for the ten-year and stress datasets. It never touches the
`materialmule` database and refuses any database without "bench" or "test" in its name. Step by step,
including clean-up: [docs/performance/README.md](../performance/README.md#run-it-on-the-host-ac2).

## Troubleshooting

**The service won't start.** Look at `materialmule-service.err.log`. "Invalid configuration" lists
each bad key in `materialmule.env` by name. "TLS_PFX_FILE could not be read" means the path or the
service account's read permission is wrong. A PFX error at startup usually means a wrong
passphrase.

**Health check fails but the service runs.** Open `/api/health` in a browser on the host:
`"database":"down"` → is `postgresql-x64-17` running, and is the `materialmule_app` password in
`DATABASE_URL` right? A certificate error from the deploy script → the host itself must trust the
certificate and resolve the host name to itself.

**RollbackFailed.** The previous release didn't come back either, usually because a migration in
the failed release changed something it relies on. Contact the developer, then recover the
pre-upgrade backup into a new database and swap it in, following
[Recover production from a backup](#recover-production-from-a-backup) (nothing was received
after that backup, because the service stopped for the upgrade). Never `pg_restore --clean` over
the production database.

**Phones show a certificate warning.** The phone doesn't trust IT's CA: IT installs the CA
profile through MDM (camera scanning needs a trusted HTTPS page, T17).
