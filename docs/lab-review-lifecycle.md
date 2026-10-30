# Lab review, acceptance and program lifecycle (MM-T25, MM-T26)

Source of truth: the Notion cards MM-T25 "Review corrections and delegated acceptance" and MM-T26
"Lab amendments, repeats, cancellation and closure", including their §12 preparation tables.
This page maps each acceptance criterion to code and test evidence and records the product edges
the cards leave open.

## State axes (kept separate)

| Axis              | Values                                                                          | Where                                    |
| ----------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| Test progress     | requested → in_progress → completed → review → accepted; cancelled (MM-T26)     | `test_request.status`                    |
| Review sub-state  | awaiting_review, returned, correction_done, review_complete (only while review) | `test_request.review_state`              |
| Acceptance        | who, when, and the delegation used (if any)                                     | `test_request.accepted_*`, review events |
| Program lifecycle | draft → submitted (shown Open) ⇄ closed (MM-T26)                                | `lab_program.status`                     |
| Physical units    | in stock … disposed (MM-T36 tested-unit removal, separate lane)                 | `storage_unit`                           |

Review, acceptance and program status never change a storage unit, and physical removal of a
tested unit never changes a test, review, acceptance or program (MM-T36 lane contract).

## MM-T25 review transitions

One table in `packages/shared/src/lab-review.ts` (`REVIEW_TRANSITIONS`), enforced by
`apps/api/src/lab/review.service.ts` and by the `test_request_status_guard` trigger.

| From            | Action                  | Who (personal accounts only)             | To                               |
| --------------- | ----------------------- | ---------------------------------------- | -------------------------------- |
| Completed       | Send to review (MM-T24) | personal, or LAB naming a person         | Review / Awaiting review         |
| Awaiting review | Mark review complete    | any internal personal account            | Review complete                  |
| Awaiting review | Return for correction   | any internal personal account + comment  | Returned to Lab Manager (+ item) |
| Returned        | Mark correction done    | Lab Manager role + note                  | Correction done (item resolved)  |
| Correction done | Mark review complete    | any internal personal account            | Review complete                  |
| Correction done | Return for correction   | any internal personal account + comment  | Returned (new cycle, new item)   |
| Review complete | Accept                  | Lead Project Engineer or active delegate | Accepted                         |

Everything else is refused (422 `invalid_transition` / `review_not_complete`) with no change.

### Unresolved product edges (not built; owner decision needed)

- **Review complete → Returned for correction** before acceptance (card §12 B). Refused.
- **Reviewer separation / self-review.** No restriction is applied; the card says nothing
  requires the re-reviewer to differ. Not invented.

## MM-T25 acceptance criteria → evidence

Integration tests: `apps/api/src/lab/review.integration.test.ts` (real PostgreSQL). Unit:
`packages/shared/src/lab-review.test.ts`, `apps/web/src/lab/review.test.tsx`. E2E:
`e2e/lab-review.spec.ts`. Permission sweep: `apps/api/src/security/permission-matrix.security.test.ts`.

| AC  | Behaviour                                                                            | Code                                                  | Evidence                                                     |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------ |
| AC1 | Return keeps status Review, sub-state Returned, Lab Manager action item              | `LabReviewService.review`, `action_item`              | "AC1/AC2/R02"; E2E T4                                        |
| AC2 | Return without a comment is rejected                                                 | `reviewDecisionRequestSchema`, DB comment check       | "AC1/AC2/R02"; shared unit test                              |
| AC3 | Lead Project Engineer accept refused until correction done and review complete again | `decide()` accept guard, DB trigger                   | "AC3/R03/R04"; E2E T4                                        |
| AC4 | Lab Manager without delegation → 403                                                 | `accept()` authority, `can(test.accept)`              | "AC4/R05"                                                    |
| AC5 | Delegate accepts on its project only; after revoke 403, earlier acceptance kept      | `acceptance_delegation`, in-transaction grant recheck | "AC5/AC6/R06/R12"                                            |
| AC6 | Delegate can't close or change priority                                              | `DELEGATE_PERMISSIONS` = accept only                  | "AC5/AC6/R06/R12" (priority 403, `can(program.close)` false) |
| AC7 | Two LAB sessions: 403 on review, correction-done, accept, delegation                 | `LabReviewController` policies, service LAB check     | "AC7/R09/T5"; E2E T5; sweep                                  |
| AC8 | Competing decisions: no lost correction or duplicates; accept after revoke denied    | version check under row lock, share/update locks      | "AC8/R08", "R07/T6", "R10"                                   |

Also covered: R01 ordered route with actor/time, R02, R04 second cycle keeps history, R10 exact
retry, R12 rename keeps attribution, closed program refuses decisions, database rules (acceptance
needs complete review, review moves, append-only events and items, one open correction, one
active grant, grants never deleted).

## API

- `POST /api/test-requests/:id/review` `{action: complete|return, comment?, version, idempotencyKey}`
- `POST /api/test-requests/:id/correction-done` `{note, version, idempotencyKey, actionItemId?}`
- `POST /api/test-requests/:id/accept` `{version, idempotencyKey}`
- `GET|POST /api/projects/:projectId/acceptance-delegates`, `DELETE …/acceptance-delegates/:id`
- `GET /api/lab-programs/:id/work` adds per test `reviewState`, `acceptedAt`, `acceptedBy`,
  `acceptedViaDelegation`, `reviewActions {canReview, canCorrectionDone, canAccept,
acceptBlockedReason}`, plus `reviewEvents` and `actionItems`.

Order of checks: 403, 400 (body), 404, retry key (an exact retry returns the saved result;
otherwise 409 `idempotency_key_reused`), 422 `program_not_open`, 409 `version_conflict` (with
current state), 422 `invalid_transition` / `review_not_complete`, 409 `correction_superseded`.
Locks: program `FOR SHARE` → test `FOR UPDATE` → project `FOR SHARE` → the actor's account
`FOR SHARE` → the actor's grant `FOR SHARE`; revocation takes the grant `FOR UPDATE`.

## MM-T26 program lifecycle

One shared module, `packages/shared/src/lab-lifecycle.ts` (closure eligibility, cancellable and
repeatable statuses, request schemas), enforced by `apps/api/src/lab/lifecycle.service.ts` and
`amendments.service.ts` and by the database (the schema baseline).

| Program state | Action                                       | Who (personal accounts only)                  | Result                                                             |
| ------------- | -------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| Open          | Close                                        | Lead Project Engineer (never a delegate)      | Closed, if ≥ 1 test and every test Accepted or reasoned-Cancelled  |
| Open          | Request closure                              | any internal personal account + reason        | action item for the Lead Project Engineer; program stays Open      |
| Closed        | Reopen                                       | Lead Project Engineer or Lab Manager + reason | Open; every test keeps its status, acceptance and history          |
| Open          | Cancel a test (Requested … In review)        | Lead Project Engineer or Lab Manager + reason | Cancelled; resolves its open correction / cancellation request     |
| Open          | Request cancellation                         | any internal personal account + reason        | action item; test unchanged                                        |
| Open          | Repeat an Accepted test                      | any internal personal account                 | new Requested test linked by `repeat_of_id`; original unchanged    |
| Open          | Change sample/depth/test of an Accepted test | any internal personal account + reason        | only that test → Requested (identity revision); siblings unchanged |
| Open          | Amend: add tests / lines / later receipts    | any internal personal account                 | numbered amendment; frozen coverage only appended to               |
| Closed        | Any of the above except Reopen               | anyone                                        | 422 `program_not_open` (reopen first; never auto-reopened)         |

LAB is refused (403) on every route above, whoever the station selects. Closing never changes a
storage unit, retention, hold or disposal; physical removal of a tested unit (MM-T36) never
changes a test, review, acceptance or program.

### Closure eligibility (D06 + empty-program rule)

`closureEligibility()` returns the blockers per test (`requested`, `in_progress`, `completed`,
`review` with its sub-state, `cancelled_without_reason`) with counts and a plain summary ("3 tests
still in Review"). **Zero requests is never eligible** (`empty_program`); the service rechecks under
`FOR UPDATE` on the program and `FOR SHARE` on its tests, and `lab_program_closure_guard` refuses
the same in the database.

### Unresolved product edges (not built; owner decision needed)

- **Cancelling an Accepted test** (card §12 B). Refused with 422 `invalid_transition`.
- **Editing or restoring a Cancelled test.** Cancelled is final.
- **Repeats of a test that is not Accepted** (Requested, In progress, Cancelled …). Only Accepted
  originals are repeated.
- **Changing the sample/depth/test of a test that is not Accepted.** Only the confirmed
  accepted-request change (D09) is built.
- **Changing the test of a repeat** is allowed (nothing forbids it); its repeat link stays.

Decisions taken within the card (documented, minimal):

- Cancelling a test resolves its open correction item and cancellation request
  (`resolution = 'cancelled'`); closing resolves the open closure request (`'closed'`).
- At most one open cancellation request per test and closure request per program
  (409 `already_requested`).
- Later receipts for Grabs/SPT lines: listing a unit is the explicit review that includes it
  (`reviewed_included`); units not listed stay out and stay offered. Amendment lines
  (`addLines`) are API-only for now; the program page offers "add a test to a line" and "include
  later receipts".

## MM-T26 acceptance criteria → evidence

Integration tests (real PostgreSQL): `apps/api/src/lab/lifecycle.integration.test.ts`,
`apps/api/src/lab/amendments.integration.test.ts`. Unit: `packages/shared/src/lab-lifecycle.test.ts`,
`apps/web/src/lab/lifecycle.test.tsx`. E2E: `e2e/lab-lifecycle.spec.ts`. Permission sweep:
`apps/api/src/security/permission-matrix.security.test.ts`.

| AC   | Behaviour                                                                              | Code                                                        | Evidence                                            |
| ---- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| AC1  | A test still in Review blocks closure and is listed                                    | `close()`, `closureEligibility`, closure guard              | "L01/AC1"; shared T1; E2E T6                        |
| AC2  | All Accepted / reasoned-Cancelled → Lead Project Engineer closes; delegate can't       | `program.close` (Lead Project Engineer only), closure guard | "L02/L03/AC2/AC8", "L12"; E2E T6                    |
| AC3  | Depth change on one of two accepted tests resets only that one                         | `changeRequest()`, identity revision, status guard          | "AC3/L04/T2"                                        |
| AC4  | Closed program refuses amend/repeat until Lead Project Engineer or Lab Manager reopens | `program_not_open` checks, insert guards                    | "AC4/L06/AC5/L05", amendments "adds tests … closed" |
| AC5  | Repeat links to the original; original keeps its history                               | `repeat()`, `repeat_of_id`, repeat insert guard             | "AC4/L06/AC5/L05", "L11"                            |
| AC6  | Technician cancel → 403; their request becomes an action item                          | `test.cancel` / `test.cancel_request`                       | "AC6"; E2E AC6                                      |
| AC7  | Later receipt included by amendment is listed; original snapshot kept                  | `amend()` `includeLaterReceipts`, snapshot guard            | "AC7/L07/T5", "Grabs/SPT later receipts"            |
| AC8  | Closing changes no storage unit                                                        | close touches only `lab_program` / events / items           | "L02/L03/AC2/AC8" (whole row compared)              |
| AC9  | Two LAB contexts: 403 on every lifecycle/request endpoint                              | route policies + service LAB checks                         | "AC9/L16"; E2E T7; sweep                            |
| AC10 | LAB progress vs personal cancel/close resolve on latest state; retries                 | versions under row locks, program lock order, retry keys    | "AC10/L10", "L09", "L11", "L15", retry checks       |

Empty-program rule: "empty-program rule …" (API and database) and E2E "Empty-program rule".
Lane B contract: "Lane B contract: a cancelled test is no longer completed-test evidence; a
sibling's still is" and "L13: a repeat never makes disposed material available again".

## API (MM-T26)

- `POST /api/lab-programs/:id/close` `{version, idempotencyKey}` → 422 `empty_program` /
  `closure_blocked` with `closure {eligible, emptyProgram, blockers, counts, summary}`
- `POST /api/lab-programs/:id/reopen` `{reason, version, idempotencyKey}`
- `POST /api/lab-programs/:id/close-request` `{reason, idempotencyKey}`
- `POST /api/test-requests/:id/cancel` `{reason, version, idempotencyKey}`
- `POST /api/test-requests/:id/cancel-request` `{reason, idempotencyKey}`
- `POST /api/test-requests/:id/repeat` `{version, idempotencyKey}` (version of the original)
- `PATCH /api/test-requests/:id` `{identity?, testTypeId?, reason, version, idempotencyKey}`
- `GET /api/lab-programs/:id/later-receipts`
- `POST /api/lab-programs/:id/amend` `{version, idempotencyKey, reason?, addTests?, addLines?,
includeLaterReceipts?}` → 409 `coverage_changed` with the current coverage of a new line
- `GET /api/lab-programs/:id/work` adds `lifecycle` (status, closure, history, amendments,
  identity revisions, allowed actions) and per test `lifecycle` (cancellation, repeat links,
  allowed actions). Program lines/requests/coverage add `amendmentId`, `repeatOfId`,
  `identityRevision` and the request's own `identity`.

## Shared contract for MM-T36 (Lane B)

- `test_request.status` values: requested, in_progress, completed, review, accepted, cancelled
  (literally `cancelled`).
- `completedTestEvidence(db, unitId)` excludes links whose test is now cancelled and returns
  `request_status`. A test reset by an accepted-request change keeps its earlier completion
  evidence; `test_request_unit_link` is unique per completion and unit.
- Nothing here gates or performs physical removal, and removal changes no test or program.
