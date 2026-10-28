# Lab review, acceptance and program lifecycle (MM-T25, MM-T26)

Source of truth: the Notion cards MM-T25 "Review corrections and delegated acceptance" and MM-T26
"Lab amendments, repeats, cancellation and closure", including their §12 preparation tables.
This page maps each acceptance criterion to code and test evidence and records the product edges
the cards leave open. MM-T26 extends it.

## State axes (kept separate)

| Axis              | Values                                                                          | Where                                    |
| ----------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| Test progress     | requested → in_progress → completed → review → accepted                         | `test_request.status`                    |
| Review sub-state  | awaiting_review, returned, correction_done, review_complete (only while review) | `test_request.review_state`              |
| Acceptance        | who, when, and the delegation used (if any)                                     | `test_request.accepted_*`, review events |
| Program lifecycle | draft → submitted (shown Open) → closed (MM-T26)                                | `lab_program.status`                     |
| Physical units    | in stock … disposed (MM-T36 tested-unit removal, separate lane)                 | `storage_unit`                           |

Review, acceptance and program status never change a storage unit, and physical removal of a
tested unit never changes a test, review, acceptance or program (MM-T36 lane contract).

## MM-T25 review transitions

One table in `packages/shared/src/lab-review.ts` (`REVIEW_TRANSITIONS`), enforced by
`apps/api/src/lab/review.service.ts` and by the `test_request_status_guard` trigger
(migration 0040).

| From            | Action                  | Who (personal accounts only)            | To                               |
| --------------- | ----------------------- | --------------------------------------- | -------------------------------- |
| Completed       | Send to review (MM-T24) | personal, or LAB naming a person        | Review / Awaiting review         |
| Awaiting review | Mark review complete    | any internal personal account           | Review complete                  |
| Awaiting review | Return for correction   | any internal personal account + comment | Returned to Lab Manager (+ item) |
| Returned        | Mark correction done    | Lab Manager role + note                 | Correction done (item resolved)  |
| Correction done | Mark review complete    | any internal personal account           | Review complete                  |
| Correction done | Return for correction   | any internal personal account + comment | Returned (new cycle, new item)   |
| Review complete | Accept                  | project PM/PE or active delegate        | Accepted                         |

Everything else is refused (422 `invalid_transition` / `review_not_complete`) with no change.

### Unresolved product edges (not built; owner decision needed)

- **Review complete → Returned for correction** before acceptance (card §12 B). Refused.
- **Reviewer separation / self-review.** No restriction is applied; the card says nothing
  requires the re-reviewer to differ. Not invented.

## MM-T25 acceptance criteria → evidence

Integration tests: `apps/api/src/lab/review.integration.test.ts` (real PostgreSQL). Unit:
`packages/shared/src/lab-review.test.ts`, `apps/web/src/lab/review.test.tsx`. E2E:
`e2e/lab-review.spec.ts`. Permission sweep: `apps/api/src/security/permission-matrix.security.test.ts`.

| AC  | Behaviour                                                                         | Code                                                  | Evidence                                                     |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| AC1 | Return keeps status Review, sub-state Returned, Lab Manager action item           | `LabReviewService.review`, `action_item`              | "AC1/AC2/R02"; E2E T4                                        |
| AC2 | Return without a comment is rejected                                              | `reviewDecisionRequestSchema`, DB comment check       | "AC1/AC2/R02"; shared unit test                              |
| AC3 | PM/PE accept refused until correction done and review complete again              | `decide()` accept guard, DB trigger                   | "AC3/R03/R04"; E2E T4                                        |
| AC4 | Lab Manager without delegation → 403                                              | `accept()` authority, `can(test.accept)`              | "AC4/R05"                                                    |
| AC5 | Delegate accepts on its project only; after revoke 403, earlier acceptance kept   | `acceptance_delegation`, in-transaction grant recheck | "AC5/AC6/R06/R12"                                            |
| AC6 | Delegate can't close or change priority                                           | `DELEGATE_PERMISSIONS` = accept only                  | "AC5/AC6/R06/R12" (priority 403, `can(program.close)` false) |
| AC7 | Two LAB sessions: 403 on review, correction-done, accept, delegation              | `LabReviewController` policies, service LAB check     | "AC7/R09/T5"; E2E T5; sweep                                  |
| AC8 | Competing decisions: no lost correction or duplicates; accept after revoke denied | version check under row lock, share/update locks      | "AC8/R08", "R07/T6", "R10"                                   |

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

Order of checks: 403, 404, 422 `program_not_open`, 409 `version_conflict` (with current state) /
`idempotency_key_reused` / `correction_superseded`, 422 `invalid_transition` /
`review_not_complete`. Locks: program `FOR SHARE` → test `FOR UPDATE` → project `FOR SHARE` →
the actor's grant `FOR SHARE`; revocation takes the grant `FOR UPDATE`.

## Notes for MM-T26

- Extend `test_request_status_guard` (replace the function in a new migration) for cancellation
  and the accepted-request reset; the reset must clear `accepted_*` and `review_state` (shape
  checks) while the review events keep the historical acceptance.
- Lock the program `FOR UPDATE` before tests when closing; T25 takes the program `FOR SHARE`
  first, so closure and review decisions serialise without deadlock.
- `action_item.kind` and `target_role` checks need widening for cancellation/closure requests.
