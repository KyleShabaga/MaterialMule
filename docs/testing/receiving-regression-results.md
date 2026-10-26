# Receiving regression results (TRP-T18)

Actual results of the receiving security, transaction and regression suite before the pilot.
What each test proves, and which decision or acceptance criterion it covers, is in
[receiving-critical-path.md](receiving-critical-path.md). Hardware checks (real printer, scanner,
phones, Microsoft tenant) are TRP-T22's and are **not** covered here.

## Run record

| Item        | Value                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| Date        | 2026-10-26                                                                                                                  |
| Commit      | `f9922c0` (branch `test/trp-t18-receiving-regression`, on main `7863c3a`)                                                   |
| Environment | Windows 11 Pro 10.0.26200 (dev PC), Node 24.22.0, PostgreSQL 17.11, Playwright 1.64.1 (Chromium), npm 11                    |
| Database    | Fresh per E2E run (`db:reset:test` + fictional dev seed); each API test file builds its own schema                          |
| E2E shape   | Production-shaped: the API serves the built web app; fake Zebra printer on `E2E_PORT + 1000`; 2 local workers; `retries: 0` |
| CI          | GitHub Actions `windows-latest` runs the same, plus `npm run test:e2e:critical -- --repeat-each=3`                          |

| Gate                                                         | Result                                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `npm run verify`                                             | Pass (API 439 passed / 9 skipped, shared 54, web 131, deploy 18; lint, typecheck, build, bundle scan) |
| `npm run test:security`                                      | Pass (11 tests, 2 files)                                                                              |
| `E2E_PORT=3118 npm run test:e2e` (everything)                | Pass (88 passed, 4 skipped by design)                                                                 |
| `@critical`, run 1 / 2 / 3 (consecutive, no retries)         | Pass / Pass / Pass (18 passed each: 9 scenarios × 2 viewports)                                        |
| `npm run test:e2e:critical -- --repeat-each=3` (the CI step) | Pass (54 passed)                                                                                      |

## Outcome per scenario

Each E2E scenario runs at desktop and phone width; "Pass" means both, in every run above.

| #   | Scenario                                                                                                                               | Result                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| S1  | Personal user receives two TH26-01 buckets, summaries only; BKT IDs at Receiving lab                                                   | Pass                     |
| S2  | LAB receives a mixed-hole bucket for chosen receiver JS (Jordan Smith); LAB + receiver attributed                                      | Pass                     |
| S3  | Missing project and hole added mid-receipt; draft intact; confirms                                                                     | Pass                     |
| S4  | Double-click Confirm; lost confirmation response retried with the same key: no duplicates                                              | Pass                     |
| S5  | Offline: Confirm blocked with the message; reconnect and confirm                                                                       | Pass                     |
| S5b | Offline: the draft keeps autosaving                                                                                                    | Not run: pending TRP-T11 |
| S6  | LAB session expiry mid-draft; sign in; confirm                                                                                         | Not run: pending TRP-T11 |
| S7  | Print dropped mid-job ("Unknown — check the printer"), then Reprint: same IDs, location unchanged                                      | Pass                     |
| S8  | Simulated keyboard scan opens a newly received unit; no writes                                                                         | Pass                     |
| S9  | Personal correction needs a reason, recalculates retain-until; LAB sees no action and gets 403                                         | Pass                     |
| S10 | Inventory search and project / location / type filters find the new units                                                              | Pass                     |
| T2  | Permission sweep: every route × unauthenticated, pending, disabled, LAB, Technician vs `docs/permissions.md`; refusals change no table | Pass                     |
| T2b | `docs/permissions.md` matrix equals `policy.ts` for every permission and column                                                        | Pass                     |
| T2c | Test sign-in unreachable with a production configuration (startup refusal, HTTPS production API)                                       | Pass                     |
| T3a | 15 parallel receipts from 3 stations: distinct, contiguous BKT IDs, no gaps                                                            | Pass                     |
| T3b | A retry racing other receipts returns its original IDs                                                                                 | Pass                     |
| T3c | Simultaneous allocations, 4 prefixes × 2 years: independent counters, no duplicates                                                    | Pass                     |
| T3d | Parallel corrections (version conflict), parallel project / hole creation                                                              | Pass (existing tests)    |
| T4a | Database error at each of 7 writes of a receipt: nothing persisted, no ID burned, same request then succeeds                           | Pass                     |
| T4b | Database connection lost mid-receipt: nothing persisted, API keeps serving                                                             | Pass after fix D1        |
| T4c | API restart while printing: interrupted job uncertain and not resent; later job and reprint print; inventory unchanged                 | Pass                     |
| T4d | Storage failure for drafts                                                                                                             | Not run: pending TRP-T11 |
| X1  | Reprint after a received-date correction prints the new date, same ID                                                                  | Pass                     |

AC3 summary: no failure injected here left a partial receipt, a burned or duplicate storage unit
ID, or a changed unit; draft and identity loss under failures are T11 scenarios, pending.

## Defects found

| ID  | Severity | Status                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | High     | Fixed in this branch   | **The API process exits if a database connection drops mid-query.** pg-pool removes its error listener while a client is checked out, so the client's `'error'` event was unhandled: Node threw `ECONNRESET` as an uncaught exception, which ends the Windows service and every request in flight (the transaction itself rolled back; no data was lost). Trigger: a PostgreSQL restart, network blip or killed backend during any request or print-worker query. Fix: `DatabaseService` attaches an error listener to every pooled client (`apps/api/src/database/database.service.ts`); the request still fails with 500 and the pool discards the broken client. Proven by `receipts.failure-injection.test.ts` (fails without the fix with an uncaught `ECONNRESET`). |
| D2  | Low      | Open (bug card needed) | **Sample Storage can drop a filter chosen just before another.** With a text search active, choosing a project and then, quickly, a location sometimes loses the project (4 of 6 tries in a probe); typing into Search right after "Clear filters" can also be lost. `InventoryPage.update()` builds the next URL from the `query` of the last render, and the router applies URL changes without blocking, so a second change made before the re-render overwrites the first. Data is unaffected and the chips show what is applied; a person who changes filters one at a time won't notice. Suggested fix: build from the latest params (`setParams(prev => …)`) and don't remount the search form. The S10 test waits for each chip, as a person would.               |

## Known limitations

- **Hardware isn't covered** (TRP-T22): real ZD621 printing, DS3678-XR scanning, staff phones,
  the Microsoft tenant and the office HTTPS host. Printing uses a fake Zebra TCP printer;
  scanning uses keyboard input and a fake camera.
- **TRP-T11 scenarios are pending** (PR #27 not merged at this commit): draft autosave while
  offline (S5b), LAB session expiry mid-draft (S6) and storage failure for drafts (T4d). T11's
  own E2E covers them on its branch; this suite adds them when T11 is on main.
- **LAB in E2E** uses a second, E2E-only `shared_lab` account with a session row inserted directly
  (`e2e/support/lab-station.ts`), because resetting the seeded LAB password (lab-login.spec.ts)
  revokes every LAB session. The LAB password form itself is covered by `e2e/lab-login.spec.ts`.
- **Failure simulation**: database errors come from temporary triggers; the lost connection is
  the backend terminating itself (`pg_terminate_backend`), not a cable pull; the restart test
  leaves a job in `sending` and boots the service again in-process rather than killing an OS
  process. A dropped print is reported "uncertain" (by design); "failed" (refused, paper out) is
  covered by `print-worker.test.ts`.
- **"Clean Windows environment"** locally means the developer PC with a freshly reset test
  database for every run; the CI runner is the freshly provisioned Windows machine.
- Performance and load are TRP-T19's.
