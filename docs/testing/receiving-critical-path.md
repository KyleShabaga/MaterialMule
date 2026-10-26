# Receiving critical path: traceability (TRP-T18)

Every confirmed receiving decision, every shared-LAB rule and every acceptance criterion of the
cards the first receiving increment depends on (TRP-T05 to T17, T33 to T35), mapped to the
automated test that proves it. Results of the latest run are in
[receiving-regression-results.md](receiving-regression-results.md).

## How to run

| Command                                | What it runs                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run test:e2e -- --grep @critical` | The Playwright critical path (desktop and phone), production-shaped as all E2E        |
| `npm run test:security`                | Permission-matrix sweep and production-configuration checks (`apps/api/src/security`) |
| `npm test`                             | Everything else below, including the concurrency and failure-injection tests          |

Use `E2E_PORT=31xx` in a worktree, as for every E2E run (see `CLAUDE.md`). CI runs all three.

## Where the tests live

Paths are relative to the repository root. The card suggested `apps/web/e2e/critical` and
`apps/api/test/…`; the repository keeps E2E under `e2e/` and API tests next to the code, so:

| Kind              | Files                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Critical E2E      | `e2e/critical/receiving-critical-path.spec.ts`; also tagged: `e2e/receiving-wizard.spec.ts` T6                               |
| Security          | `apps/api/src/security/permission-matrix.security.test.ts`, `production-config.security.test.ts`                             |
| Concurrency       | `apps/api/src/receiving/receipts.concurrency.test.ts` (+ existing tests named below)                                         |
| Failure injection | `apps/api/src/receiving/receipts.failure-injection.test.ts`, `apps/api/src/printing/print-restart.failure-injection.test.ts` |
| Cross-card        | `apps/api/src/printing/reprint-after-correction.test.ts`                                                                     |

New in T18 is marked **(T18)**. "pending T11" means the behaviour belongs to TRP-T11 (local
autosaved drafts, PR #27), which wasn't merged when this table was written; those rows get tests
when T11 lands. Hardware checks (real ZD621, DS3678-XR, staff phones, Microsoft tenant) belong to
TRP-T22 and the cards' manual tests, never to this suite.

Abbreviations: `api/` = `apps/api/src/`, `web/` = `apps/web/src/`, `shared/` = `packages/shared/src/`.

## 1. Critical-path scenarios (card §2)

| #   | Scenario                                                                              | Test                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Personal user receives two TH26-01 buckets, summaries only; IDs and Receiving lab set | `e2e/critical` "personal user receives two TH26-01 buckets…" **(T18)**                                                                                                                |
| S2  | LAB receives a mixed-hole bucket for a chosen receiver; LAB + receiver attributed     | `e2e/critical` "LAB receives a mixed-hole bucket…" **(T18)**                                                                                                                          |
| S3  | Missing project and hole created mid-receipt; draft intact                            | `e2e/critical` "a missing project and hole are added mid-receipt…" **(T18)**                                                                                                          |
| S4  | Double-click and lost-response confirmation: no duplicates                            | `e2e/critical` "a double-clicked Confirm and a lost confirmation response…" **(T18)**                                                                                                 |
| S5  | Offline: confirm blocked; reconnect and confirm                                       | `e2e/receiving-wizard.spec.ts` T6 (tagged `@critical`)                                                                                                                                |
| S5b | Offline: the draft keeps **saving** (autosave indicator)                              | pending T11 (T11 AC2)                                                                                                                                                                 |
| S6  | LAB session expiry mid-draft; sign in; confirm                                        | pending T11 (T11 AC5). Today: API refuses an expired LAB session (`api/receiving/receipts.integration.test.ts` T7) and the station shows the expiry message (`e2e/lab-login.spec.ts`) |
| S7  | Print failure then reprint: same IDs, location unchanged (fake printer)               | `e2e/critical` "a failed print then a reprint keep the same IDs and location" **(T18)**                                                                                               |
| S8  | Scan lookup via simulated keyboard input                                              | `e2e/critical` "a simulated keyboard scan opens a newly received unit…" **(T18)**                                                                                                     |
| S9  | Correction by personal user with reason; LAB correction refused                       | `e2e/critical` "a personal user corrects a unit with a reason; LAB is refused…" **(T18)**                                                                                             |
| S10 | Inventory search and filters find the new units                                       | `e2e/critical` "inventory search and filters find newly received units" **(T18)**                                                                                                     |

The LAB scenarios use a real `shared_lab` session (account type decides permissions) on an
E2E-only LAB station account, because `e2e/lab-login.spec.ts` resets the seeded LAB password,
which revokes every session of that account (see `e2e/support/lab-station.ts`).

## 2. Confirmed decisions

| Decision                                                                                       | Tests                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D03 Confirmation sets Receiving lab; printing/reprinting never creates receipts or moves units | S1, S7; `api/receiving/receipts.integration.test.ts` AC1; `api/printing/print-worker.test.ts` AC2; `api/printing/printing.http.test.ts` AC5; `api/printing/reprint-after-correction.test.ts` **(T18)**; `api/printing/print-restart.failure-injection.test.ts` **(T18)** |
| D12 One summary per hole (ALL / sample range / depth range / custom), one project per unit     | S2; `api/db/schema.test.ts` AC3–AC5; `api/receiving/receipts.integration.test.ts` AC5, AC7; `shared/receipts.test.ts`; `e2e/receiving-wizard.spec.ts` T4, T5                                                                                                             |
| D35 New receipts only; no inventory import                                                     | No import route exists: the route sweep in `api/security/permission-matrix.security.test.ts` **(T18)** enumerates every endpoint; `api/db/schema.test.ts` AC1 (production reference seed is Receiving lab and LAB only)                                                  |
| D41 Quantity calculated from the units                                                         | S1; `api/receiving/receipts.integration.test.ts` AC1 (quantity 2); `web/receiving/draft.test.ts` (T10 T2); `api/db/schema.test.ts` (50-unit cap)                                                                                                                         |
| D42 Any internal user (LAB too) adds a missing project with number, name, client, PM/PE        | S3; `api/projects/projects.test.ts` AC2, AC4, AC5; `e2e/receiving-projects.spec.ts`                                                                                                                                                                                      |
| D43 Description optional                                                                       | `e2e/receiving-wizard.spec.ts` T4 (AC8); `api/receiving/receipts.concurrency.test.ts` **(T18)** (null description)                                                                                                                                                       |
| D44 Live connection required to confirm; drafts kept offline; no IDs before confirmation       | S5; `web/receiving/wizard.test.tsx`; `web/receiving/receiving.test.tsx` "offline"; draft autosave pending T11                                                                                                                                                            |
| D45 Corrections of type, holes/summaries, notes with reason and history; same ID               | S9; `api/storage-units/corrections/corrections.integration.test.ts` AC1–AC3, "type correction keeps the issued ST- ID"; `e2e/corrections.spec.ts` T7                                                                                                                     |
| D46 Receipt-date correction recalculates retention                                             | S9 (retain-until 2027-10-19); `corrections.integration.test.ts` AC1; `api/printing/reprint-after-correction.test.ts` **(T18)**                                                                                                                                           |
| D47 Project correction resolves lab-request links first; ID and receipt header kept            | `corrections.integration.test.ts` AC5, AC6                                                                                                                                                                                                                               |
| ID format `PREFIX-YYYY-NNNNNN`, per prefix/year counters, never reused or changed (CLAUDE.md)  | `api/numbering/storage-unit-id.test.ts` AC1–AC8; `api/db/schema.test.ts` AC8; `api/receiving/receipts.concurrency.test.ts` **(T18)**; `api/receiving/receipts.failure-injection.test.ts` **(T18)**                                                                       |
| Never an individual sample inventory at receiving (CLAUDE.md)                                  | S1 (no sample input); `e2e/receiving-wizard.spec.ts` T3                                                                                                                                                                                                                  |

## 3. Shared receiving account (LAB) rules — App Idea §8

| Rule                                                                                                          | Tests                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| App-managed username LAB + password; no Microsoft call                                                        | `api/auth/providers/local-lab/lab.integration.test.ts` AC1; `e2e/lab-login.spec.ts`                                                             |
| One calendar month, no sliding, month-end clamp; survives browser restart                                     | `lab.integration.test.ts` AC1–AC3; `api/auth/calendar-month.test.ts`; `e2e/lab-login.spec.ts`                                                   |
| LAB may receive, create project/hole, search, print/reprint, edit drafts                                      | S2, S3, S7 (LAB station); `lab.integration.test.ts` "allow-listed"; `printing.http.test.ts` AC7; `projects.test.ts` AC4                         |
| Corrections, lab programs, approvals, admin need a personal account                                           | S9; `api/security/permission-matrix.security.test.ts` **(T18)**; `lab.integration.test.ts` T3; `corrections.integration.test.ts` AC2            |
| LAB has no Lab Manager or project authority                                                                   | `api/auth/policy.test.ts`; matrix/policy check in `permission-matrix.security.test.ts` **(T18)**                                                |
| Receiver picked from a searchable staff list, blank each receipt, duplicate initials told apart, no free text | S2; `e2e/receiving-wizard.spec.ts` T8; `e2e/staff.spec.ts`; `api/staff/staff.integration.test.ts` AC3; `web/components/ReceiverSelect.test.tsx` |
| Account (LAB) and receiver stored separately; snapshot survives renames                                       | S2 (receipt + audit); `receipts.integration.test.ts` AC6; `staff.integration.test.ts` AC4                                                       |
| Expiry keeps drafts; sign in again before confirming                                                          | API 401: `receipts.integration.test.ts` T7; message: `e2e/lab-login.spec.ts`; draft kept: pending T11                                           |
| Sign-out any time; admin revocation                                                                           | `lab.integration.test.ts` "sign-out", "admin revocation"; `api/auth/auth.integration.test.ts`                                                   |
| Brute-force lockout, audited                                                                                  | `lab.integration.test.ts` T5/AC7                                                                                                                |
| Development "Lab (test)" identity is separate and never in production                                         | `api/security/production-config.security.test.ts` **(T18)**; `api/auth/test-provider/test-auth.test.ts`                                         |

## 4. Security, concurrency and failure injection (card §2, AC3, AC4)

| Requirement                                                                                                                | Tests                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every protected endpoint as unauthenticated, pending, disabled, LAB, Technician vs the T04 matrix; refusals change nothing | `api/security/permission-matrix.security.test.ts` **(T18)** (route discovery, so new endpoints are swept automatically; whole-database fingerprint before/after each refusal)            |
| `docs/permissions.md` matrix equals `policy.ts`                                                                            | `permission-matrix.security.test.ts` **(T18)**                                                                                                                                           |
| Test sign-in rejected in production config (T33)                                                                           | `api/security/production-config.security.test.ts` **(T18)**: startup refusal, forged config, dev seed refused, running HTTPS production API has no fixture routes and creates no session |
| Parallel receipts: no duplicate typed-prefix IDs                                                                           | `receipts.concurrency.test.ts` **(T18)** (15 receipts from 3 stations; retry racing others); `receipts.integration.test.ts` T5                                                           |
| Simultaneous allocations per prefix/year                                                                                   | `receipts.concurrency.test.ts` **(T18)** (4 prefixes × 2 years × 8 transactions); `numbering/storage-unit-id.test.ts` AC1, AC8                                                           |
| Parallel corrections: version conflict                                                                                     | `corrections.integration.test.ts` T4/AC4 (racing saves: one 200, one 409)                                                                                                                |
| Parallel project (and hole) creation                                                                                       | `projects.test.ts` AC2/T2 (project 70001; hole)                                                                                                                                          |
| Database error mid-receipt                                                                                                 | `receipts.failure-injection.test.ts` **(T18)**: error at each of 7 writes, then the same request succeeds with no ID gap; `receipts.integration.test.ts` AC2                             |
| Database connection lost mid-receipt                                                                                       | `receipts.failure-injection.test.ts` **(T18)** (found defect D1, fixed)                                                                                                                  |
| Worker restart during printing                                                                                             | `print-restart.failure-injection.test.ts` **(T18)** (service boot path, HTTP); `print-worker.test.ts` AC4                                                                                |
| Storage failure for drafts                                                                                                 | pending T11 (T11 AC3)                                                                                                                                                                    |

## 5. Card acceptance criteria

| Card | AC           | Test                                                                                                                                                                            |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T05  | AC1          | `api/auth/providers/microsoft/microsoft.integration.test.ts` (fictional bootstrap identity); `e2e/microsoft-sign-in.spec.ts` AC1. Real account: manual, IT                      |
| T05  | AC2–AC8      | `microsoft.integration.test.ts`; AC2 403 until approval also in the T18 sweep (pending caller); `id-token.test.ts`; `profile-merge.test.ts`; `e2e/microsoft-sign-in.spec.ts` T5 |
| T06  | AC1–AC3      | `lab.integration.test.ts`; `calendar-month.test.ts`                                                                                                                             |
| T06  | AC4          | `e2e/lab-login.spec.ts`                                                                                                                                                         |
| T06  | AC5          | `lab.integration.test.ts` T3; `permission-matrix.security.test.ts` **(T18)**                                                                                                    |
| T06  | AC6, AC7     | `lab.integration.test.ts` T4, T5                                                                                                                                                |
| T07  | AC1–AC7      | `api/staff/staff.integration.test.ts`; `first-sign-in.test.ts`; `e2e/staff.spec.ts`; AC5 also in the T18 sweep                                                                  |
| T08  | AC1–AC6      | `api/projects/projects.test.ts`; `shared/projects.test.ts`                                                                                                                      |
| T08  | AC7          | `e2e/receiving-projects.spec.ts`; S3                                                                                                                                            |
| T09  | AC1, AC3–AC7 | `receipts.integration.test.ts`; AC3 also S4 and `receipts.concurrency.test.ts` **(T18)**; AC6 also S2                                                                           |
| T09  | AC2          | `receipts.integration.test.ts` AC2; `receipts.failure-injection.test.ts` **(T18)**                                                                                              |
| T10  | AC1–AC8      | `e2e/receiving-wizard.spec.ts` T3–T8; `web/receiving/wizard.test.tsx`; AC1 also S1, AC2 also S2                                                                                 |
| T11  | AC1–AC7      | pending T11 (PR #27 not merged)                                                                                                                                                 |
| T12  | AC1–AC7      | `api/inventory/inventory.integration.test.ts`; `e2e/inventory.spec.ts`; S10                                                                                                     |
| T13  | AC1–AC6      | `corrections.integration.test.ts`; `e2e/corrections.spec.ts`; AC1/AC2 also S9                                                                                                   |
| T14  | AC1, AC7     | `api/labels/zpl.test.ts` (ZXing decode of every prefix); `api/storage-units/scan-lookup.test.ts`                                                                                |
| T14  | AC2–AC4      | `api/labels/zpl.test.ts`, `text-fit.test.ts`, `preview.test.ts`                                                                                                                 |
| T14  | AC5          | `api/printing/reprint-after-correction.test.ts` **(T18)**; `scan-lookup.test.ts` AC2                                                                                            |
| T14  | AC6          | hardware (T22)                                                                                                                                                                  |
| T15  | AC1          | `print-worker.test.ts`, `printing.http.test.ts` (fake printer); real ZD621: hardware (T22)                                                                                      |
| T15  | AC2–AC7      | `print-worker.test.ts`, `printing.http.test.ts`; AC4 also `print-restart.failure-injection.test.ts` **(T18)**; AC5 also S7                                                      |
| T16  | AC1, AC2     | `scan-lookup.test.ts` (decoded labels); S8; DS3678-XR: hardware (T22)                                                                                                           |
| T16  | AC3–AC7      | `e2e/scanning.spec.ts`; `web/scanning/scanning.test.tsx`                                                                                                                        |
| T17  | AC1          | `e2e/camera-scan.spec.ts` (fake camera); real phones: hardware (T22)                                                                                                            |
| T17  | AC2–AC5      | `e2e/camera-scan.spec.ts`; `web/scanning/CameraScanner.test.tsx`, `camera-core.test.ts`                                                                                         |
| T33  | AC1–AC7      | `api/auth/test-provider/test-auth.test.ts`; AC3/AC4 also `production-config.security.test.ts` **(T18)**; `e2e/test-sign-in.spec.ts`                                             |
| T34  | AC1–AC7      | `e2e/app-shell.spec.ts`; `api/activity/activity.test.ts`; `web/layout/shell.test.tsx`; AC2 also the T18 sweep                                                                   |
| T35  | AC1–AC6      | `api/projects/project-screens.test.ts`; `e2e/projects.spec.ts`; AC5 also the T18 sweep (Technician PATCH)                                                                       |
