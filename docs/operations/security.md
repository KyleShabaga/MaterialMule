# Material Mule security review (Windows host)

The deployment-specific security review for Material Mule on the office Windows PC (MM-T68,
review of 2026-10-29). It lists what we protect, how data moves, who can reach it, the controls
that already exist and where they are proven, the open findings and the decisions still needed.
Applying and verifying these controls on the real host is MM-T90.

Step-by-step procedures live in the [operations runbook](runbook.md); this page links to them
rather than repeating them. If a change alters a rule here, update this page, the source doc and
the "Data safety rules" list on the MM-T68 card together.

## Contents

1. [Assets](#assets)
2. [Data flows and access paths](#data-flows-and-access-paths)
3. [Accounts](#accounts)
4. [Existing controls](#existing-controls)
5. [Data safety rules](#data-safety-rules)
6. [Local-only database connections](#local-only-database-connections)
7. [Findings](#findings)
8. [Decisions needed](#decisions-needed)
9. [Patching](#patching)
10. [Operational ownership](#operational-ownership)
11. [Incident response](#incident-response)
12. [Personal-data retention (proposal)](#personal-data-retention-proposal)

## Assets

| Asset                       | Where                                                                                                               | Why it matters                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Projects and test holes     | `project` (number, name, client, leads, server folder path), test holes                                             | Client work; disclosure or tampering affects reports                              |
| Storage units and inventory | Receipts, units, summaries, locations, moves, retention, disposal                                                   | The physical chain of custody; IDs are on printed labels and are never reused     |
| Lab programs                | Requests, progress, review decisions, amendments                                                                    | Test history the firm relies on                                                   |
| Staff data                  | `app_user`: display, given and family name, work email, sign-in username, initials, job title, office               | Personal data                                                                     |
| Audit and history           | `audit_event` (with actor name and initials snapshots) and the append-only history tables                           | Evidence of who did what; must never change or disappear                          |
| Email outbox                | `email_outbox`: recipient address, subject and body of each action-request email                                    | Personal data (addresses); nothing sends while `EMAIL_ENABLED` is false           |
| Notifications               | `notification`: who was told about which action request, and when they read or dismissed it (MM-T91)                | Personal activity data; rows are never deleted, LAB never receives any            |
| Sessions and sign-in state  | `session` (SHA-256 of the token only), `sign_in_throttle` (account and client address keys), `oidc_sign_in_attempt` | Session hijack or lockout bypass                                                  |
| LAB password                | `local_credential` (Argon2id hash only)                                                                             | Shared receiving account                                                          |
| Secrets                     | `materialmule.env`, `config\admin\migrate.env`, backup `pgpass.conf`, TLS key, the password manager                 | Full database or host access if leaked                                            |
| Backups                     | `BackupTarget` (once D39 is decided): dump, manifest, redacted config zip, checksums                                | A complete copy of the database                                                   |
| Logs                        | `C:\MaterialMule\logs`, `C:\MaterialMule\ops\logs`, the PostgreSQL log folder                                       | User IDs, request paths, role names and client addresses; never secrets or bodies |

Production starts empty (D42). Development, test, bench and demo databases hold fictional data only.

## Data flows and access paths

```
Office PCs and phones ──HTTPS (TLS 1.2+, HSTS)──▶ MaterialMule service (Node API, serves the web app)
                                                     │  materialmule_app, pool, 127.0.0.1:5432
                                                     ▼
Deploy-MaterialMule.ps1 ── materialmule_owner ──▶ PostgreSQL 17 (same PC, localhost only)
backup.ps1 / monitor.ps1 ── materialmule_backup ─▶    │
Administrator (psql) ──── postgres ─────────────▶    │
                                                     ▼
                                     pg_dump ──▶ BackupTarget (encrypted at rest, D39)
```

- **Staff browsers → API.** The only inbound port is HTTPS on the profile(s) IT agrees
  (`FirewallProfiles`, `FirewallRemoteAddresses`). Nothing is reachable from outside the office
  network (D26). Sign-in is LAB (app-managed password) or Microsoft (D38, off until IT sets it up).
- **API → PostgreSQL.** On the same PC over `127.0.0.1`, as `materialmule_app`, with a small
  connection pool.
- **Deploy script → PostgreSQL.** Runs migrations as `materialmule_owner`, reading
  `config\admin\migrate.env` (Administrators only).
- **Backup and monitor tasks → PostgreSQL** (after D39). Scheduled tasks run as the backup account
  and connect as `materialmule_backup` through a `pgpass.conf` only that account and Administrators
  can read.
- **Administrators → PostgreSQL.** Only as `postgres`, only for `setup-roles`, restores, recovery and
  the incident steps in the runbook. The password is prompted for and cleared afterwards.
- **Printing.** The API sends labels to the Zebra printer on the office network; labels carry
  storage unit IDs and project numbers.
- **Email.** None today: `EMAIL_ENABLED` must stay false until IT approves the sending set-up
  (startup refuses `true`).

## Accounts

| Account               | Type                  | May                                                                                                            | May not                                                                                                                            |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`            | PostgreSQL superuser  | Everything; used by an administrator for `setup-roles`, restores, recovery and incident steps                  | Be used by the service, the deploy script or the scheduled tasks                                                                   |
| `materialmule_owner`  | Migration role        | Own the schema and every table; run migrations; add trusted extensions (`CREATE` on the database)              | Superuser, CREATEDB, CREATEROLE; it is never in the service's env file                                                             |
| `materialmule_app`    | API role              | Connect; read and write rows; use sequences                                                                    | Create, alter or drop anything; change `schema_migration`; update or delete rows in `audit_event` or any append-only history table |
| `materialmule_backup` | Read-only (after D39) | Read every table and sequence (`pg_dump`, monitor); read-only transactions by default                          | Write anything                                                                                                                     |
| Service account       | Windows (IT, MM-T20)  | Run the `MaterialMule` service; read `config`; write `logs`                                                    | Read `config\admin`; administer the host                                                                                           |
| Backup account        | Windows (IT, D39)     | Run the backup and monitor tasks; write `ops` and `BackupTarget`; read its `pgpass.conf`                       | Run elevated                                                                                                                       |
| Local administrators  | Windows               | Install, deploy, roll back, rotate secrets, restore                                                            | —                                                                                                                                  |
| App users             | Material Mule         | What [docs/permissions.md](../permissions.md) grants; Admin manages staff and sessions but is not a super-user | Anything the server-side policy refuses                                                                                            |

None of the PostgreSQL roles is a superuser or has CREATEDB or CREATEROLE. Grants come from
`setup-roles` (`apps/api/src/db/roles.ts`); details in [docs/database.md](../database.md#roles).

## Existing controls

| Control                                                                                        | Where it lives                                                                      | Proven by                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Least-privilege roles; app role can't change the schema or append-only history                 | `apps/api/src/db/roles.ts` (`setup-roles`)                                          | `apps/api/src/db/roles.test.ts` (CI; needs a superuser test login)                                        |
| Host security check (roles, privileges, server settings, pg_hba, firewall, folder ACLs)        | `apps/api/src/db/security-check.ts`, `deploy\windows\Test-MaterialMuleSecurity.ps1` | `apps/api/src/db/security-check.test.ts`; first host run recorded on MM-T90                               |
| Integrity rules in the database (foreign keys, `CHECK`, unique indexes, append-only triggers)  | `apps/api/migrations/`                                                              | `apps/api/src/db/schema*.test.ts`                                                                         |
| Forward-only migrations with checksum and lock                                                 | `apps/api/src/db/migrator.ts`                                                       | `apps/api/src/db/migrator.test.ts`                                                                        |
| Default-deny guard; every route declares a policy                                              | `apps/api/src/auth/auth.guard.ts`, `policy.ts`                                      | Route-coverage test, `apps/api/src/security/permission-matrix.security.test.ts`                           |
| Hashed, revocable sessions with absolute expiry; CSRF header and `Origin` check                | `apps/api/src/auth/session.service.ts`, `auth.guard.ts`                             | `apps/api/src/auth/*.test.ts`                                                                             |
| LAB brute-force lockout, audited failures                                                      | `apps/api/src/auth/providers/local-lab/`                                            | `lab.integration.test.ts`                                                                                 |
| Production config: HTTPS only (TLS 1.2+, HSTS, secure cookies), test sign-in and email refused | `apps/api/src/config/env.ts`, `apps/api/src/hosting/https.ts`                       | `apps/api/src/security/production-config.security.test.ts`, `config/env.test.ts`, `hosting/https.test.ts` |
| Startup errors name bad keys, never values                                                     | `apps/api/src/config/env.ts`                                                        | `config/env.test.ts`                                                                                      |
| Log redaction of passwords, tokens, cookies, connection strings and secrets                    | `REDACT_PATHS` in `apps/api/src/logging/logger.ts`                                  | `logging/logger.test.ts`                                                                                  |
| No server secret in the web bundle or host logs                                                | `scripts/check-bundle-secrets.mjs`                                                  | `npm run verify`; on the host after every rotation                                                        |
| PostgreSQL local only; exposure warnings (or an error with `-FailOnExposure`)                  | `Install-MaterialMuleHost.ps1`, `MaterialMuleHosting.psm1`                          | `deploy/windows/tests/deploy.test.ts`; MM-T20 host test T5                                                |
| Backups: read-only role, redacted config, checksums, encrypted target required                 | `deploy\windows\backup.ps1`, `MaterialMuleOps.psm1`                                 | `deploy/windows/tests/ops.test.ts`                                                                        |
| Restores only into a new database; refuses production and tampered backups                     | `deploy\windows\restore.ps1`                                                        | `deploy/windows/tests/ops.test.ts`                                                                        |
| Release folder holds no `.env` files or secrets                                                | `scripts/pack-release.mjs`                                                          | `deploy/pack-release.test.ts`                                                                             |
| Fixtures and demo data refused in production                                                   | `apps/api/src/db/seed.ts`, `ENABLE_TEST_AUTH` check                                 | `production-config.security.test.ts`, `apps/api/src/db/migrator.test.ts`                                  |

## Data safety rules

Condensed from the MM-T68 card (current as of `5c18fa5`, 2026-10-29). The sources are
[CLAUDE.md](../../CLAUDE.md), [docs/database.md](../database.md),
[docs/permissions.md](../permissions.md) and the [runbook](runbook.md).

**Test, development and demo data**

- Fictional data only (DEMO- projects, TH26- test holes, invented people and clients). Never copy
  production data, real people's records or a production backup into a development, test, bench or
  demo database. Never send real email or messages from tests.
- Four seed sets, each with its own place ([docs/database.md](../database.md#seed-data)). Only the
  reference data reaches production.
- Destructive rebuilds only on a designated disposable database (`db:rebuild:dev -- --disposable
<db>`, `db:reset:test`). Each worktree has its own test database and E2E port.

**Schema and integrity**

- Forward-only migrations; never edit an applied one. The MM-AO02 baseline replacement is never
  repeated for a deployed database ([Migration rules](../database.md#migration-rules)).
- Integrity rules live in the database and are proven in `schema*.test.ts`. Audit and history
  tables are append-only. Storage unit IDs are never changed, recycled or reused.

**Database access (production)**

- Least-privilege roles from `setup-roles` (see [Accounts](#accounts)). `postgres` only for
  `setup-roles`, restores, recovery and incidents; prompt for its password and clear it afterwards.
- PostgreSQL is reachable only from the host (runbook
  [Lock PostgreSQL to this PC](runbook.md#2-lock-postgresql-to-this-pc-ac5)); the only inbound
  port is HTTPS.

**Secrets**

- Never in the repository, `VITE_` variables, email or chat. Long random passwords from the
  password manager IT owns, stored there.
- Config files readable only by the service account and Administrators; `migrate.env` in
  `config\admin`, apart from `materialmule.env`.
- New sensitive fields go into `REDACT_PATHS`. Run `check-bundle-secrets` in `npm run verify` and
  on the host after every rotation.

**Backups and restores**

- Backups hold no secrets. The backup location must be encrypted at rest; the scripts refuse to run
  until `TargetEncryptedAtRest = $true` and every D39 value is set.
- Never restore over production. Raise the ID counters past every label printed since the backup
  before receiving resumes ([runbook](runbook.md#recover-production-from-a-backup)).
- Never copy a production backup or dump to the development PC or any machine other than the host
  and the approved backup location. Restore drills run on the host into an isolated database.

**Logs**

- API logs never contain request bodies, tokens, cookies, passwords or connection strings.
  PostgreSQL runs with `log_statement = 'none'`. `email_outbox.last_error` never holds an address.

**Application access to data**

- Every permission is enforced on the server; input is validated with the zod schemas in
  `packages/shared`; queries are parameterized.
- Production is HTTPS only; startup refuses `ENABLE_TEST_AUTH` in production; nothing is emailed
  while `EMAIL_ENABLED` is false.

## Local-only database connections

Connections to PostgreSQL are **not** TLS-encrypted. This is a deliberate exception: PostgreSQL
listens only on `localhost`, `pg_hba.conf` allows only `127.0.0.1/32` and `::1/128` with
`scram-sha-256`, and there is no firewall rule for 5432, so database traffic never leaves the
host. Passwords are still never sent in clear (SCRAM).

The exception is only valid while the API, the scripts and PostgreSQL all run on the same PC. If
the database ever moves to another machine (a separate server, a NAS, a cloud database), this
exception no longer holds: turn on TLS in PostgreSQL with a certificate from IT, require it in
`pg_hba.conf` (`hostssl`), connect with `sslmode=verify-full`, and revisit this review first.

## Findings

From the 2026-10-29 review. "This card" is MM-T68 (repository work); MM-T90 is the host card.

| #   | Finding                                                                                                                                                                                                                          | Status                                                                                                                                                                                                                                                                                                                   | Owner                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| 1   | Host disk encryption isn't decided: only the backup location must be encrypted. Nothing covers the PostgreSQL data directory, WAL, PostgreSQL logs, `C:\MaterialMule\config` or `C:\MaterialMule\logs`, or recovery-key custody. | Open; options below. Decision and set-up on MM-T90.                                                                                                                                                                                                                                                                      | Owner/IT, then MM-T90    |
| 2   | Database security events aren't logged or reviewed.                                                                                                                                                                              | Partly done: the runbook's PostgreSQL block adds `log_connections = on` (failed passwords were always logged); the security check reports it. App denials go to the API log as warnings; LAB failures and lockouts are audited (`auth.sign_in_failed`, `auth.lockout`). Alerting and a reviewer: pending owner decision. | This card; owner decides |
| 3   | Host controls are unverified (MM-T20 host tests T1–T6 not run).                                                                                                                                                                  | Open; the [security check](runbook.md#security-check) is ready for the host.                                                                                                                                                                                                                                             | MM-T90                   |
| 4   | Backups are blocked on D39.                                                                                                                                                                                                      | Open; no D39 value is filled with a default.                                                                                                                                                                                                                                                                             | IT (D39), then MM-T90    |
| 5   | No procedure for a compromised credential.                                                                                                                                                                                       | Done in the runbook ([If a secret has leaked](runbook.md#if-a-secret-has-leaked)). Rehearsal with non-production credentials to be recorded on this card; host rehearsal on MM-T90.                                                                                                                                      | This card, then MM-T90   |
| 6   | The role tests run only in CI.                                                                                                                                                                                                   | Done: `security-check` (database) and `Test-MaterialMuleSecurity.ps1` (host) run as the real roles and print no secrets.                                                                                                                                                                                                 | This card; run on MM-T90 |
| 7   | No retention rule for personal data in operational tables.                                                                                                                                                                       | [Proposal](#personal-data-retention-proposal) below, pending owner decision. Nothing purges data today.                                                                                                                                                                                                                  | Owner decides            |

**Host disk encryption options (finding 1).** For the owner and IT to choose between:

- **BitLocker on every host drive** that holds the PostgreSQL data directory, WAL and logs and
  `C:\MaterialMule` (TPM, optionally with a PIN). Protects against a stolen PC or disk. The
  recovery key must be kept somewhere IT controls (Entra ID / AD or the password manager); without
  it, a failed TPM or a board swap loses the database. A TPM-only set-up still lets the PC boot
  unattended (needed for the service to start without a login, MM-T20 T2) but does not protect a
  PC stolen while running.
- **No disk encryption,** with physical security of the host as the control. The owner records the
  accepted risk: anyone who takes the PC or its disk can read every table and the env files.

Either way, encryption at rest does not protect against someone signed in to the host or a leaked
database password; the role, folder and firewall controls cover those.

## Decisions needed

None of these has an answer yet. Do not fill any of them with a default.

| Decision                                                                                           | Who      | Blocks                      | Status  |
| -------------------------------------------------------------------------------------------------- | -------- | --------------------------- | ------- |
| Host disk encryption (finding 1) and who holds the recovery key, where                             | Owner/IT | MM-T90                      | Pending |
| Who reviews security alerts, and what counts as one (finding 2)                                    | Owner    | MM-T68 Done; MM-T90         | Pending |
| Whether repeated app denials or failed sign-ins raise an event-log alert                           | Owner    | MM-T68 Done                 | Pending |
| How long personal data may stay in operational tables (finding 7)                                  | Owner    | MM-T68 Done; any purge job  | Pending |
| Backup design D39 (target, encryption, RPO/RTO, retention, owner, alert recipient, backup account) | IT       | MM-T21 host set-up; MM-T90  | Pending |
| Service account and folder permissions (MM-T20)                                                    | IT       | MM-T20 host install; MM-T90 | Pending |
| Windows Update restart window                                                                      | IT       | Go-live                     | Pending |
| Operational owner                                                                                  | Owner/IT | Go-live                     | Pending |

## Patching

| Component     | What to apply                                                              | How                                                                                                                             |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Node.js       | The current Node.js 24 LTS release (the repository pins 24.x in `.nvmrc`)  | Download the new `.msi` on the host, install over the old one, `Restart-Service MaterialMule`, check `/api/health`              |
| PostgreSQL 17 | Each minor release (security fixes; no dump or restore needed within 17.x) | EDB installer over the existing one, outside office hours, after a backup; then the [security check](runbook.md#security-check) |
| Windows       | Windows Update in the restart window IT sets                               | IT policy; the service and PostgreSQL start on their own after a restart (MM-T20 T2)                                            |
| npm packages  | Updated in the repository and shipped as a normal release                  | `npm ci` from the lockfile; production `node_modules` are packed with install scripts disabled                                  |
| Certificate   | Before expiry                                                              | Runbook [Renew the certificate](runbook.md#renew-the-certificate)                                                               |

CI (`.github/workflows/ci.yml`) runs the `npm run verify` checks and the E2E tests; it does **not** run
`npm audit` or any other dependency vulnerability scan today. Moving to a new Node.js or
PostgreSQL major version is a developer task with its own release, not routine patching.

## Operational ownership

The operational owner (upgrades, health, certificate renewal, backups and drills, security alerts)
is **pending IT** ([IT inputs](runbook.md#it-inputs)). Until named:

- The developer prepares releases and keeps this review current.
- Kyle runs the host steps with IT (MM-T90).
- IT owns the host, its accounts, Windows Update, the firewall and the password manager.

## Incident response

An outline until the owner decides who reviews alerts (finding 2):

1. **Notice.** A monitor or backup alert (event log source "MaterialMule"), a security check FAIL,
   repeated `password authentication failed` lines in the PostgreSQL log, a burst of LAB lockouts
   (`auth.lockout` in the audit history), denied-request warnings in the API log, or a report from
   staff.
2. **Contain.** For a leaked or suspected secret, follow
   [If a secret has leaked](runbook.md#if-a-secret-has-leaked). For a compromised staff account, an
   admin disables it (revokes every session) or revokes its sessions. If the host itself is
   compromised, stop the service (`Stop-Service MaterialMule`) and call IT.
3. **Assess.** Check the PostgreSQL log, the API log and the audit history for the period; run the
   [security check](runbook.md#security-check). Keep the logs (copy them before rotation overwrites
   them; PostgreSQL keeps a week).
4. **Recover.** If data was damaged, follow
   [Recover production from a backup](runbook.md#recover-production-from-a-backup); never restore
   over production.
5. **Record.** Date, what happened, what was done and who did it, in the same place as the drill
   log. Tell the owner; whether staff or clients must be told is the owner's decision.

## Personal-data retention (proposal)

**Proposal, pending owner decision. Nothing purges data today.** No purge job is built until the
owner decides; the numbers below are examples to decide on, not settings.

| Data                                              | Proposal                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session` rows                                    | Delete a row _N_ days (e.g. 90) after it expired or was revoked (`expires_at`, `revoked_at`). Only token hashes are stored; nothing references a session row.                                                                                                   |
| `email_outbox` rows (`sent`, `skipped`, `failed`) | Delete _N_ days (e.g. 90) after `sent_at` / `created_at`, **only once the action item is resolved**: the one-email-per-recipient rule relies on the row, so deleting it for an open item could let a reassignment back to the same person queue a second email. |
| `sign_in_throttle`                                | Already short-lived: rows are cleared on a successful sign-in or reset; a row for a client address that never signs in again could be deleted after its window ends.                                                                                            |
| `oidc_sign_in_attempt`                            | Already purged: expired attempts are deleted when a new sign-in starts.                                                                                                                                                                                         |
| `audit_event` and every append-only history table | **Keep forever**, including the actor name and initials snapshots. They are the evidence of who did what, and the triggers and grants forbid changing or deleting them.                                                                                         |
| `app_user` (staff who leave)                      | Keep the row (audit history and assignments reference it); disable the account. Whether to blank profile fields such as work email, job title and office after a period is an owner decision.                                                                   |
| Backups                                           | Follow the D39 retention (`KeepDaily/Weekly/Monthly`). A purge in the live database does not reach older backups until they age out.                                                                                                                            |
| Logs                                              | Already bounded by rotation ([runbook](runbook.md#log-rotation-ac5)).                                                                                                                                                                                           |

Any purge job that follows must run as the app role (the grants allow deletes on `session` and
`email_outbox`), be audited as one summary event per run, and never touch an append-only table.
