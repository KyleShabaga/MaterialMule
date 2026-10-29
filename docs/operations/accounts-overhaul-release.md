# Accounts overhaul: release rehearsal, cutover and acceptance (MM-AO09)

This covers the accounts and permissions overhaul (MM-AO02 to MM-AO08) at the integrated commit:
how the migration was rehearsed, what the regression evidence is, how to cut over and recover,
and what is still open before the release is accepted. All data is fictional (DEMO-2601,
TH26-01). Nothing here was run against a production database, and no real email was sent.

**Status: not accepted.** The open items under [Open before Done](#open-before-done) remain. This
file records evidence; it does not approve anything.

## What is in the release

Base for this card: `main` at `b1dab39` (2026-10-29).

| Card    | What it delivered                                                                   | PR  | Merge commit |
| ------- | ----------------------------------------------------------------------------------- | --- | ------------ |
| MM-AO02 | Lead Project Engineer rename; clean pre-release baseline `0001_baseline.sql`        | #90 | `dc6a470`    |
| MM-AO03 | Central policy, Team & Permissions API; `0002_project_access.sql`                   | #91 | `c43ee8b`    |
| MM-AO04 | Project creation, lead nomination and confirmation; `0003_project_lead_appointment` | #92 | `751b3c0`    |
| MM-AO05 | Project Team & Permissions screen                                                   | #93 | `0e399f2`    |
| MM-AO06 | Staff administration, job-title override (with reason), My access                   | #94 | `a00fb8f`    |
| MM-AO08 | Concrete permission contract in the central policy (no routes)                      | #95 | `418bce1`    |
| MM-AO07 | Open action items follow current eligibility (D10); `0004_action_item_rerouting`    | #96 | `b1dab39`    |

Migrations after this release: `0001_baseline`, `0002_project_access`,
`0003_project_lead_appointment`, `0004_action_item_rerouting` (4). They are forward-only.

## Migration rehearsal (AC1)

There is no deployed database (owner decision 2026-10-29). The databases built from the retired
pre-release lineage cannot be upgraded: the migrator refuses them (MM-AO02). So the "legacy" state
rehearsed is the oldest one that can be upgraded, the `0001` baseline, loaded with fictional data
of every kind the overhaul touches.

### Automated: `apps/api/src/db/release-rehearsal.test.ts`

Part of `npm test`, so it runs in Windows CI against real PostgreSQL (`REQUIRE_DATABASE_TESTS=1`).
It migrates a fresh schema to `0001` only, loads reference data, the dev fixtures and these
fictional access records:

- an admin and a Lab Manager (roles), and a disabled account that still holds the admin role;
- the retired single review engineer field set on DEMO-2601 (`0002` drops it);
- an acceptance delegation granted before reasons were required (no reason);
- reviewer eligibility and a reviewer assignment for `concrete_field`;
- a live report issuer grant and an expired one;
- a team member and a "Can create and lead projects" capability;
- two open retention requests: one on its ordinary route, and one assigned to Jordan Smith while
  they were a Lab Manager, after which the role was removed.

It records every effective permission (each person × each permission × no project, each project,
and each project with each report scope, with its sources, using the central policy and the real
project loader) and every inbox route, applies the remaining migrations, records both again, and
compares.

| Check                                                               | Result at `b1dab39` (Linux, PostgreSQL 16.15)                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Later migrations applied in order                                   | `0002`, `0003`, `0004`                                               |
| Effective permissions before = after                                | identical: no access gained, none lost                               |
| Disabled admin, expired issuer grant, team member, staff capability | grant nothing, before and after                                      |
| Inbox routes changed                                                | only the lapsed assignment: Jordan Smith → Lab (test) + Pat Example  |
| Row counts (users, roles, audit, units, grants, items, assignments) | unchanged; storage unit IDs unchanged; the item still names Jordan   |
| Pre-reason delegation                                               | kept without a reason; revocation refused without one, then accepted |
| New delegation without a reason                                     | refused (`acceptance_delegation_grant_reason_required`)              |
| `project.review_engineer_user_id`                                   | dropped                                                              |

The test was checked for teeth: with the fixture's role removal taken out, two of its eight checks
fail.

### Exception register

Every difference between before and after, and why it is expected:

| Exception                                                | Cause                         | Accounted for                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An item assigned to someone no longer eligible reroutes  | `0004` (D10, Kyle 2026-10-29) | Goes to its ordinary recipients and shows "Assignment lapsed"; the assignment row and history stay. No lapse audit is written for an assignment that lapsed before the upgrade (the app audits lapses when it makes the change, MM-AO07) |
| `project.review_engineer_user_id` values are not carried | `0002` (D12)                  | It never granted anything (proven: identical permissions); reviewer responsibility is scoped assignments                                                                                                                                 |
| Delegations granted before D15 keep a null reason        | `0002` (D15)                  | Nothing is invented; revoking one needs a reason                                                                                                                                                                                         |
| `project.lead_project_engineer_user_id` becomes nullable | `0003` (D02)                  | Existing projects keep their lead; only new projects may wait for one                                                                                                                                                                    |

No unexplained access expansion or loss.

### Backup and restore round trip

Run by hand on 2026-10-29 at `b1dab39` against `materialmule_rehearsal_ao09`, a disposable
database created for this rehearsal (Linux container, PostgreSQL 16.15, `pg_dump`/`pg_restore`
16.15). Same fixtures as above.

1. Build the legacy state at `0001`; take snapshot A (migrations, row counts, storage unit IDs,
   inbox routes).
2. `pg_dump -Fc` (419,709 bytes).
3. Migrate: applied `0002`, `0003`, `0004`. Snapshot B: 4 migrations, same counts and IDs, the
   lapsed item now routed to Lab (test) and Pat Example.
4. Drop the database, create it again, `pg_restore --exit-on-error`. Snapshot C = A exactly.
5. Migrate the restored database again. Snapshot D = B exactly.

So the pre-upgrade backup is a full recovery point, and the upgrade is repeatable from it. This was
not run on the office Windows PC; see [Open before Done](#open-before-done).

## Regression evidence (AC2, AC3)

Already in the suite, all against real PostgreSQL, rerun at this commit by `npm run verify`:

| Area                                                                 | Where                                                                                           |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Every route classified and enforced (security matrix)                | `apps/api/src/security/permission-matrix.security.test.ts`                                      |
| Policy matrix, LAB allow-list, sources and blocked reasons           | `apps/api/src/auth/policy.test.ts`                                                              |
| Success and denial for team, reviewers, issuers, delegations         | `project-access/project-access.integration.test.ts` (AC1–AC3)                                   |
| Wrong-project row IDs and unknown projects refused, nothing changed  | same file, "wrong-project row IDs"                                                              |
| Stale scopes, expired grants, eligibility revoked                    | same file (AC2; "a reviewer assignment counts only while…")                                     |
| Disabled users; re-enable revokes technical grants (D08)             | same file (D08); `staff/staff.integration.test.ts`                                              |
| Races in both orders: lead change, role removal, disable, revocation | same file, "AC4 / D09 races" (5 cases, lock-wait synchronised, no sleeps)                       |
| Lead nomination, confirmation, direct appointment, decision race     | `project-access/lead-appointment.integration.test.ts`                                           |
| Action items follow eligibility; refused decisions change nothing    | `notifications/rerouting.integration.test.ts`, `notifications/action-items.integration.test.ts` |
| Receiving, project-number locking, stable IDs, attribution           | `receiving/*`, `numbering/storage-unit-id.test.ts`, `projects/projects.test.ts`                 |
| Holds, disposal, tested-unit removal, bulk/Shelby                    | `retention/*`, `disposal/*`, `storage-units/tested-removal/*`, `storage-units/bulk-groups/*`    |
| Migration rehearsal                                                  | `db/release-rehearsal.test.ts` (above)                                                          |

Browser journeys (Playwright, desktop and phone viewports, production-shaped):
`lead-appointment`, `projects`, `receiving-projects`, `team-permissions`, `my-access`, `staff`,
`staff-profile-edits`, `action-requests`, `lab-*`, `retention`, `disposal`, `tested-removal`,
`bulk-shelby-receiving`, `same-source-evidence`, `receiving-*` and the rest of `e2e/`.

### Gate results

| Gate                      | Environment                             | Commit | Result                                                                                                                                                           |
| ------------------------- | --------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`          | Linux container, Node 24, PostgreSQL 16 | branch | passed: API 849 + 5 skipped (HTTPS certificate and production-boot tests, by environment), web 396, shared 100, deploy 3 + 42 skipped (PowerShell, Windows only) |
| `npm run test:e2e`        | Linux container, Chromium               | branch | passed: 245, 7 skipped (viewport-specific by design)                                                                                                             |
| `npm run verify` + e2e    | Windows CI (`windows-latest`)           | PR     | recorded on the MM-AO09 card and PR (this is the Windows gate)                                                                                                   |
| Windows office PC         | Kyle's PC                               | —      | **not run** (open)                                                                                                                                               |
| Manual phone/desktop pass | —                                       | —      | **not run** (open)                                                                                                                                               |

Historic green CI from earlier cards is not counted.

## Cutover

For the office PC (development use today; the same order applies to the first production install,
which starts empty, D42).

1. Merge to `main`; take the release from `main` (`npm run verify`, then `npm run release:pack`).
2. Tell staff the app will be down for a few minutes. Nobody needs to sign out first.
3. Back up the database (runbook "Upgrade" step 2: the deploy script's backup, or the manual
   `pg_dump -Fc` there). Check the file is not empty.
4. Deploy with `Deploy-MaterialMule.ps1` (it stops the service, runs `db:migrate`, starts the new
   release and checks `/api/health`). A development checkout instead runs `npm run db:migrate`;
   the office PC needs this for `0004`.
5. Check: `/api/health` is OK; the migrate step listed `0004_action_item_rerouting` (or nothing
   pending on a second run); an admin opens a project's Team &
   Permissions and their own My access; a Lab Manager opens Action requests (Unresolved).
6. Lab Managers look at the Unresolved queue and at any "Assignment lapsed" items, and reassign
   them where needed (with a reason).

A database still on the retired lineage (`0001_initial_schema` … `0078`) is refused by the
migrator. If it is disposable, rebuild it (`npm run db:rebuild:dev -- --disposable <db>`);
otherwise export what you need first (docs/database.md). Never rebuild a database you are not sure
is disposable.

## Rollback and recovery limits

- Migrations are forward-only; rolling back the code does not undo them.
- `0004` only adds and replaces database functions, so the release before MM-AO07 still runs on
  it. Inbox routing lives in those functions, so lapsed assignments keep going to their ordinary
  recipients even under the old code; that code only stops showing the lapsed and unresolved
  badges and stops auditing new lapses. No data changes either way.
- `0003` makes a project's lead optional. Code from before MM-AO04 assumes every project has one,
  so a code-only rollback to MM-AO03 is safe only while no project is waiting for a lead.
- `0002` drops `project.review_engineer_user_id`, which code from before MM-AO03 reads (the project
  list), so that code **does not run on this schema**. Rolling back below MM-AO03 means restoring
  the pre-upgrade backup, then deploying the old release (runbook "Recover production from a
  backup"). Anything recorded after the upgrade is lost by that restore.
- Rolling back to MM-AO04, MM-AO05, MM-AO06 or MM-AO08 is code-only.

## Compatibility removal gates

No compatibility layer was kept: the clean baseline removed the old project-role names and there
are no legacy aliases or dual authority paths (MM-AO02; `schema-assignments.test.ts` checks the
schema for them). The one compatibility behavior is the null reason on delegations granted before
D15; it is permanent history, not a code path, and needs no removal.

## Deferred concrete scope

Defined in the central policy by MM-AO08, enforced by no route yet, and hidden from capability
lists until the owning card ships (owner decision 2026-10-29). Not part of this release.

| Deferred                                                  | Owner card                                 |
| --------------------------------------------------------- | ------------------------------------------ |
| Concrete Lab Manager grant storage and grant/revoke (D13) | C02                                        |
| Concrete settings (via `project.edit`), review adapter    | C02                                        |
| Mixes: create, edit, copy, approve, D14 revisions         | C03                                        |
| Concrete review routes (`concrete.review`)                | C04 / C07                                  |
| Failed-specimen schedule approval and HOLD                | the failure-workflow card after C07        |
| Report issuing (`report.issue` route)                     | the report-lifecycle card (not in C01–C08) |

## Open before Done

- [ ] `npm run verify` and `npm run test:e2e` on the office Windows PC at the merged commit.
- [ ] `npm run db:migrate` on the office PC (applies `0004`), after a backup.
- [ ] A restore drill on Windows (`restore.ps1`, runbook MM-T21) once IT has set the D39 backup
      values; until then the manual `pg_dump` in the runbook.
- [ ] A manual pass on a phone and a desktop: Team & Permissions, My access, Staff, Action requests.
- [ ] Owner acceptance (Kyle) of this release and of the exception register.
