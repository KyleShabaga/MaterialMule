# Concrete package 1 → package 2 handoff (MM-V2-C08)

What package 2 (field form, attachments, offline) and later packages can rely on from the merged
package 1 foundation, and what is still an open input. Written 2026-11-09 against main `b996a3a`
(C01–C07, C09, C10, C22, C26–C31, C36–C38 merged; migrations 0015–0030).

Detail lives in [concrete.md](concrete.md) (records and rules per card) and
[permissions.md](permissions.md) (routes and who may call them). This page is the index plus the
gates. It claims nothing that isn't built: offline creation and set numbering don't exist yet;
strength results use the provisional method P1 (C24) until the office worksheet arrives.

## Proof that the pieces fit

- **Scenario test:** `apps/api/src/concrete/concrete-foundation.integration.test.ts` runs one
  fictional scenario across two projects (DEMO-2601 led by `pe`, DEMO-2603 led by `jo`) on real
  PostgreSQL through the API: reviewer, issuer, delegate and concrete Lab Manager grant → supplier
  and Lead-only mix → field report with the mix snapshot → three specimen sets with the mix ages and
  a holiday flag → submit, return (notice), resubmit, review, issue (machine info from the project
  setting) → pickup and receipt (LAB naming the person) → receiving exceptions → test result entry
  and correction → worklist and reschedule → ordinary HOLD test, disposal, failed-hold
  authorization → dashboard queue, search and project specimens. It asserts database and audit
  rows, every refusal leaves every concrete, notification and audit table unchanged, exact replays
  write nothing, and stale versions are refused (409) without writes.
- **Route sweep:** `apps/api/src/security/permission-matrix.security.test.ts` discovers every route
  and calls each as anonymous, pending, disabled, LAB, an ordinary technician and a Lab Technician
  against the documented matrix. C08 added a check that every concrete route is swept and that
  every project-scoped permission a concrete route checks is reported in
  `PROJECT_CAPABILITY_ACTIONS` (the report's technician's recall is per record and is listed on
  the report instead).
- **Storage units unchanged:** the scenario fingerprints `storage_unit`, `receipt`,
  `storage_unit_annual_counter` and `storage_unit_hole_summary` before and after; they don't change,
  and no concrete identifier uses a storage-unit prefix. The existing receiving, review,
  notification, retention and ID suites run unchanged in `npm test` and E2E.

## Entities (package 1)

| Area                | Tables                                                                                                                                                                                                                                                              | Card          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Field reports       | `concrete_field_report`, `concrete_field_reading`, `concrete_field_report_command`                                                                                                                                                                                  | C01, C04      |
| Lifecycle           | `concrete_report_version` (frozen snapshot + SHA-256), `concrete_report_transition`, `concrete_report_exception_note`                                                                                                                                               | C09, C28      |
| Specimens           | `concrete_specimen_set`, `concrete_specimen` (+ view `concrete_specimen_identity`), `concrete_casting_correction`, `concrete_specimen_set_command`                                                                                                                  | C01, C05      |
| Settings and grants | `concrete_project_settings`, `project_concrete_lab_manager_grant`                                                                                                                                                                                                   | C02           |
| Mixes               | `concrete_mix`, `concrete_mix_revision`, `concrete_mix_command`                                                                                                                                                                                                     | C03, C30, C37 |
| Equipment           | `concrete_equipment`, `concrete_equipment_calibration`                                                                                                                                                                                                              | C27           |
| Receiving           | `concrete_specimen_pickup`, `concrete_set_pickup_window`, `concrete_specimen_receipt`, `concrete_specimen_mass_correction`, `concrete_set_marker_confirmation(_specimen)`, `concrete_receiving_exception`, `concrete_curing_standard`, `concrete_receiving_command` | C06           |
| Test results        | `concrete_test_result`, `concrete_test_result_revision`                                                                                                                                                                                                             | C07           |
| Schedule            | `concrete_specimen_reschedule`                                                                                                                                                                                                                                      | C22           |
| HOLD and disposal   | `concrete_hold_command`, `concrete_specimen_failure_hold`, `concrete_specimen_hold_schedule`, `concrete_specimen_disposal`                                                                                                                                          | C26           |
| Reference data      | `concrete_supplier`, `company_holiday`                                                                                                                                                                                                                              | C37           |
| Notifications       | `notification` rows with concrete links (kinds in `CONCRETE_NOTIFICATION_KINDS`)                                                                                                                                                                                    | C29           |

Stable facts package 2 can build on:

- Internal UUIDs never change, and the client may choose them (sets, specimens, readings, test
  attempts). An exact resend of the same command with the same idempotency key returns the first
  result and writes nothing; a different body with a used key is refused.
- Every mutating command takes the record's `version`; a stale one is 409 and writes nothing.
- A set has no identifier until numbered: `temporary_id` and `permanent_id` are both empty in
  package 1. Numbering (C18) and temporary IDs for offline creation (package 2/3) don't exist; tests
  attach a number by direct update as a stand-in. Once numbered, a set's ID, letters and project
  never change.
- Submitted versions are frozen: `concrete_report_version.snapshot_sha256` never changes, and
  report content is locked while submitted or reviewed.
- Histories are append-only (reschedules, test-result revisions, transitions, disposals, audit).
- LAB never gains authority from the person it names. Every LAB write names the performing staff
  member (400 `<field>` required when missing): the field report's technician, the pickup
  collector, the receiver, the test entry person and the disposal performer. The database keeps
  both the account and the named person.

## API surface

All routes are under `/api`; reads need `inventory.read` (LAB included) unless noted. Writes are
listed with the permission the server checks; "handler" routes check a project-scoped permission
after loading the record (see `ACTIVE_ROUTE_PERMISSION` in the sweep). Full rules per route:
[permissions.md](permissions.md).

| Card        | Writes                                                                                                                                                                                                                                | Permission                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| C02         | `PATCH projects/:projectId/concrete-settings`; `POST`/`DELETE projects/:projectId/concrete-lab-managers`                                                                                                                              | `project.edit` (lead or admin)                                                          |
| C03/C30/C37 | `POST projects/:projectId/concrete-mixes[/copy]`, `PATCH concrete-mixes/:id`, `POST concrete-mixes/:id/approve`, `…/discard-draft`, `…/propagation`                                                                                   | `concrete_mix.manage` / `.approve` (the project's lead only)                            |
| C04         | `POST concrete/projects/:projectId/field-reports`, `PATCH concrete/field-reports/:id`                                                                                                                                                 | `concrete_report.draft` (own drafts; LAB names the technician)                          |
| C05         | `POST concrete/field-reports/:reportId/specimen-sets`, `PATCH`/`DELETE concrete/specimen-sets/:id`                                                                                                                                    | `concrete_report.draft`                                                                 |
| C05         | `POST concrete/field-reports/:reportId/casting-correction`                                                                                                                                                                            | `concrete_specimen.reschedule`                                                          |
| C09         | `POST concrete/field-reports/:id/submit`, `…/resubmit`                                                                                                                                                                                | `concrete_report.draft` (the technician)                                                |
| C09         | `…/recall` / `…/return`, `…/review`, `…/revise` / `…/issue`                                                                                                                                                                           | `concrete_report.recall` (the report's technician) / `concrete.review` / `report.issue` |
| C28         | `POST concrete/field-reports/:id/versions/:versionNo/exception-notes`                                                                                                                                                                 | `concrete.review`                                                                       |
| C06         | `POST concrete/specimen-sets/:setId/pickup`, `PUT …/pickup-window`, `POST concrete/specimens/:specimenId/receipt`, `POST concrete/specimen-sets/:setId/marker-confirmation`, `POST concrete/projects/:projectId/receiving-exceptions` | `concrete_specimen.receive` (lab staff)                                                 |
| C06         | `POST concrete/specimens/:specimenId/mass-correction`                                                                                                                                                                                 | `concrete_specimen.mass_correct` (lab staff, personal account)                          |
| C06         | `POST concrete/receiving-exceptions/:exceptionId/resolve`                                                                                                                                                                             | `concrete_receiving_exception.resolve`                                                  |
| C06         | `POST concrete/specimens/:specimenId/curing-resolution`                                                                                                                                                                               | `concrete.review`                                                                       |
| C07         | `PUT concrete/specimens/:specimenId/test-results/:resultId`                                                                                                                                                                           | `concrete_test.enter` (lab staff)                                                       |
| C22         | `POST concrete/specimens/:specimenId/reschedule`                                                                                                                                                                                      | `concrete_specimen.reschedule`                                                          |
| C26         | `POST concrete/holds/schedule-test`, `POST concrete/holds/authorize-disposal`                                                                                                                                                         | `concrete_ordinary_hold.manage`; failed holds `concrete_hold.manage`                    |
| C26         | `POST concrete/disposal/record`                                                                                                                                                                                                       | `concrete_specimen.dispose_record` (lab staff)                                          |
| C27         | `concrete/testing-machine[…]`, `concrete/air-meters[…]`                                                                                                                                                                               | `concrete_settings.testing_machine.manage` / `.air_meter.manage`                        |
| C37         | `concrete/suppliers[…]`, `concrete/holidays[…]`                                                                                                                                                                                       | `concrete_settings.supplier.manage` (LM or admin) / `.holiday.manage` (admin)           |

Reads: field reports and their versions, sets, receiving (per set and per report), receiving
exceptions, test results, the lab worklist and schedule history, HOLD list and history, disposal
ready list, review queue and exception notes, equipment and use checks, suppliers and holidays,
project specimens, mix propagation preview, the receiving queue and search (C31).

## Permission surface

Sources (policy.ts): the project's Lead Project Engineer; a designated reviewer for the scope
(`concrete_field`, MISC-08 live check); the project's concrete Lab Manager grant together with the
Lab Manager role (D13); the record's technician (C10); lab staff = the Lab Technician role, the
Lab Manager role, and LAB naming a person (C36); report issuer grants.

| Actor                                    | Concrete authority                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Lead Project Engineer (own project only) | mixes, review, issue, reschedule, casting correction, receiving exceptions, both HOLD kinds, settings |
| Designated `concrete_field` reviewer     | review/return/revise, curing resolution, reschedule, casting correction, receiving exceptions         |
| Lab Manager with the project grant       | reschedule, casting correction, receiving exceptions, failed and ordinary HOLD, lab-staff work        |
| Lab Manager (role alone)                 | ordinary HOLD, lab sync conflicts (planned route), lab-staff work, suppliers, equipment               |
| Lab Technician                           | lab-staff work (pickup, receipt, mass, test entry, disposal record), air meters                       |
| LAB                                      | drafts and lab-staff work naming the person; never review, issue, reschedule, HOLD or corrections     |
| Report issuer                            | issue on its project and scope only                                                                   |
| Casting technician                       | own drafts; recall; resolving receiving exceptions for specimens they cast                            |
| Admin                                    | concrete settings via `project.edit`, suppliers, holidays, curing standard; **no** workflow authority |
| Acceptance delegate                      | none (lab-program acceptance only)                                                                    |
| Ordinary technician                      | drafts, own records, reads                                                                            |

The scenario test proves each row through `/api/projects/:id/capabilities` and through the routes
themselves on both projects. No self-review: a technician never reviews or issues their own report.

## Named gates (not defaults)

Each of these is an open owner input or an external run. Nothing in package 1 fills it in; code
that reaches one either refuses, stores nothing, or marks the value provisional.

| Gate                           | What is open                                                                                                         | Where it is held in code                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **G2** strength report         | Provisional design decided 2026-11-09 (one report per set, cumulative, CS numbers); the real examples are still open | C32: CS number allocator and the strength template (unwired); C39 adds strength report records                                                                                       |
| **G8** units and readings      | Testing-machine / worksheet units, the number of height and diameter readings; the office calculation worksheet (G1) | `state` admits `'draft'` only; `units_provisional` always true; C24 calculates with **provisional method P1** (versioned, labelled provisional; the worksheet becomes a new version) |
| Workbook and standards         | The firm's concrete workbook mapping (C34 import), CSA/ASTM curing and pickup limits                                 | No curing standard seeded (out-of-range flags only when one is entered); pickup window default 24 h marked unverified                                                                |
| Report templates               | Office report examples, branding and accreditation marks (provisional P1 designs stand in, C32)                      | P1 templates print "Provisional template"; a new revision replaces them; nothing issued is rewritten                                                                                 |
| C11 offline device runs        | iPhone / Android installed-app and recovery runs (D38 limited offline is decided, the device evidence is not)        | The device steps and evidence template are on the C11 spike branch (draft PR #126, not merged); main has no offline route, worker or cache                                           |
| Allocator (package 3)          | Permanent set numbers and temporary offline IDs (C18, C12)                                                           | Both ID columns stay empty; tests number sets by direct update                                                                                                                       |
| Pass/fail and failure workflow | Failed-specimen schedule (C25), passed tested specimens entering HOLD (C23/C24)                                      | `concrete_specimen_failure_hold` has no route that inserts it; `concrete_failure_schedule.approve` has no route                                                                      |
| Billing D16–D18, IT/pilot D39  | Deferred owner decisions                                                                                             | Never defaulted; nothing in concrete reads them                                                                                                                                      |

## Follow-ups found by C08

- **Capabilities:** `concrete_receiving_exception.resolve`, `concrete_ordinary_hold.manage` and
  `concrete_hold.manage` were checked by delivered routes (C06, C26) but missing from
  `PROJECT_CAPABILITY_ACTIONS`; C08 added them (evaluated with the same facts as reschedule). The
  Team & Permissions screen now shows them.
- **MTR-25:** the new-lead grant review (`project_grant_review`) does not cover the concrete Lab
  Manager grant (C02 note). Still open.
- Items each card handed to a later card stay with that card (C23 tested condition in the worklist
  and propagation, C19 submit blockers from receiving, C21 exception UI, C32 issued files).
