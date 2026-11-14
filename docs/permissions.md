# Permissions

Enforced on the server by `apps/api/src/auth/policy.ts` (`can()`) and the global `AuthGuard`
(MM-T04). Source: App Idea §1 "Confirmed permissions" and §8 "Confirmed shared receiving
account", plus owner decisions of 2026-10-25. Keep this table and `policy.ts` in step.

## Rules

- **Default deny.** Every route declares one policy: `@Public()`, `@AnySession()` (pending users
  too), `@ActiveUser()` (handler checks a project-scoped permission itself) or
  `@RequirePermission(…)`. A route without one is refused, and a test fails the build.
- **Pending and disabled users** get only `GET /api/me`, their profile (`GET /api/me/profile`,
  `POST /api/me/profile/refresh`) and sign-out (pending),
  or a 401 (disabled: their sessions stop authenticating).
- **Position and job title grant nothing.** Only `role_assignment` (admin, lab_manager,
  lab_technician), the
  account type and project authority (Lead Project Engineer, acceptance delegates, Authorized
  report issuers) do. Team membership and reviewer assignment add no permission (MM-AO03).
- **Admin is not a super-user.** It manages staff and sessions; it doesn't imply Lab Manager
  rights, project authority, acceptance or closure.
- **Staff and Printers (STRATA-118, Kyle 2026-11-12)** are managed by Lab Managers and
  administrators (`staff.manage`, `printer.manage`). Making or removing admins, and changing an
  account that holds admin, stays administrator-only (`admin_role.manage`), as do the shared LAB
  account's password (`lab_account.manage`) and reading Administrator Feedback (`feedback.read`).
  None of these comes through LAB, a position or a LAB station's picked person.
- **LAB** (shared receiving account) is limited to the LAB column even if a role is assigned to it
  by mistake.

## Matrix

| Permission                                                                                                                                               | LAB | Any internal user | Lab Manager | Lab Technician | Admin | Lead Project Engineer | Acceptance delegate |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | :-: | :---------------: | :---------: | :------------: | :---: | :-------------------: | :-----------------: |
| receipt.confirm / receipt.draft                                                                                                                          |  ✓  |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| project.create / test_hole.create                                                                                                                        |  ✓  |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| inventory.read / label.print                                                                                                                             |  ✓  |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| storage_unit.move (#21)                                                                                                                                  |  ✓  |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| lab_program.read / lab_program.manage (T23)                                                                                                              |  ✓  |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| storage_unit.correct (D45–D47)                                                                                                                           |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| test.progress (D08, T24)                                                                                                                                 |  ✓  |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| lab_comment.write (T24)                                                                                                                                  |  ✓  |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| test.review                                                                                                                                              |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| acceptance_delegation.read (T25)                                                                                                                         |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| project_access.read (AO03)                                                                                                                               |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| project_lead.nominate (AO04, D01)                                                                                                                        |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| lab_program.amend (T26)                                                                                                                                  |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| test.cancel_request (T26)                                                                                                                                |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| program.close_request (T26)                                                                                                                              |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| storage_unit.dispose_scan (#24)                                                                                                                          |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| location_conflict.resolve (D29)                                                                                                                          |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| storage_unit.tested_removal (T36)                                                                                                                        |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| action_item.read (T27)                                                                                                                                   |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| notification.read (T91)                                                                                                                                  |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| retention.request (T29)                                                                                                                                  |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| personal_settings.manage (Strata 1C)                                                                                                                     |     |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| test_catalog.manage (D37)                                                                                                                                |     |                   |      ✓      |                |   ✓   |                       |                     |
| program.priority.set (D50)                                                                                                                               |     |                   |      ✓      |                |       |           ✓           |                     |
| program.reopen                                                                                                                                           |     |                   |      ✓      |                |       |           ✓           |                     |
| test.cancel (D07)                                                                                                                                        |     |                   |      ✓      |                |       |           ✓           |                     |
| test.correction_done (T25)                                                                                                                               |     |                   |      ✓      |                |       |                       |                     |
| retention.manage (D05)                                                                                                                                   |     |                   |      ✓      |                |       |           ✓           |                     |
| disposal.approve (D19)                                                                                                                                   |     |                   |      ✓      |                |       |           ✓           |                     |
| settings.drafts.manage (MM-T45)                                                                                                                          |     |                   |      ✓      |                |   ✓   |                       |                     |
| location.manage (MM-T37)                                                                                                                                 |     |                   |      ✓      |                |   ✓   |                       |                     |
| action_item.reassign (T27)                                                                                                                               |     |                   |      ✓      |                |   ✓   |                       |                     |
| test.accept (D04)                                                                                                                                        |     |                   |             |                |       |           ✓           |          ✓          |
| program.close (D06)                                                                                                                                      |     |                   |             |                |       |           ✓           |                     |
| acceptance_delegation.manage                                                                                                                             |     |                   |             |                |       |           ✓           |                     |
| staff.manage (STRATA-118)                                                                                                                                |     |                   |      ✓      |                |   ✓   |                       |                     |
| admin_role.manage / lab_account.manage / feedback.read (STRATA-118)                                                                                      |     |                   |             |                |   ✓   |                       |                     |
| session.revoke                                                                                                                                           |     |                   |             |                |   ✓   |                       |                     |
| printer.manage (T15, STRATA-118)                                                                                                                         |     |                   |      ✓      |                |   ✓   |                       |                     |
| project.edit (T35)                                                                                                                                       |     |                   |             |                |   ✓   |           ✓           |                     |
| project_team.manage (AO03, D04)                                                                                                                          |     |                   |             |                |   ✓   |           ✓           |                     |
| project_reviewer.manage (AO03, D04/D05)                                                                                                                  |     |                   |             |                |   ✓   |           ✓           |                     |
| project_review.approve (MISC-08)                                                                                                                         |     |                   |             |                |       |           ✓           |                     |
| report_issuer.manage (AO03, D06)                                                                                                                         |     |                   |             |                |       |           ✓           |                     |
| report.issue (AO03, D07)                                                                                                                                 |     |                   |             |                |       |           ✓           |                     |
| concrete_mix.manage / concrete_mix.approve (AO08, C03)                                                                                                   |     |                   |             |                |       |           ✓           |                     |
| concrete.review (AO08, C09; + designated reviewer)                                                                                                       |     |                   |             |                |       |           ✓           |                     |
| concrete_failure_schedule.approve (AO08, planned; + designated reviewer)                                                                                 |     |                   |             |                |       |           ✓           |                     |
| concrete_hold.manage (AO08, C26; + concrete LM grant)                                                                                                    |     |                   |             |                |       |           ✓           |                     |
| concrete_report.draft (C10; routes C04)                                                                                                                  |  ✓  |         ✓         |      ✓      |       ✓        |   ✓   |           ✓           |          ✓          |
| concrete_report.recall (C10, C09; record technician only)                                                                                                |     |                   |             |                |       |                       |                     |
| concrete_receiving_exception.resolve (C10, planned; + reviewer, concrete LM grant, record technician)                                                    |     |                   |             |                |       |           ✓           |                     |
| concrete_sync_conflict.resolve_field (C10, planned; record technician only)                                                                              |     |                   |             |                |       |                       |                     |
| concrete_sync_conflict.resolve_lab (C10, C36, planned; + reviewer)                                                                                       |     |                   |      ✓      |                |       |           ✓           |                     |
| concrete_recovery.import (C10, planned; + record technician)                                                                                             |     |                   |      ✓      |                |       |                       |                     |
| concrete_ordinary_hold.manage (C10, C26)                                                                                                                 |     |                   |      ✓      |                |       |           ✓           |                     |
| concrete_set.void / concrete_specimen.reschedule (C10, planned; + reviewer, concrete LM grant)                                                           |     |                   |             |                |       |           ✓           |                     |
| concrete_settings.curing_standard.manage (C10, planned)                                                                                                  |     |                   |      ✓      |                |   ✓   |                       |                     |
| concrete_settings.testing_machine.manage (C10, C27)                                                                                                      |     |                   |      ✓      |                |       |                       |                     |
| concrete_settings.air_meter.manage (C27, C36)                                                                                                            |     |                   |      ✓      |       ✓        |       |                       |                     |
| concrete_settings.supplier.manage (C37)                                                                                                                  |     |                   |      ✓      |                |   ✓   |                       |                     |
| concrete_settings.holiday.manage (C37)                                                                                                                   |     |                   |             |                |   ✓   |                       |                     |
| concrete_settings.report_header.manage (C32)                                                                                                             |     |                   |             |                |   ✓   |                       |                     |
| concrete_settings.attachment_limit.manage (C10, planned)                                                                                                 |     |                   |             |                |   ✓   |                       |                     |
| concrete_specimen.receive / concrete_specimen.dispose_record / concrete_test.enter (C36; routes C06/C07, C20, C23, C26; LAB names the performing person) |  ✓  |                   |      ✓      |       ✓        |       |                       |                     |
| concrete_specimen.mass_correct (C36, C06; personal account only, CD-46)                                                                                  |     |                   |      ✓      |       ✓        |       |                       |                     |
| reviewer_eligibility.manage (AO03, D05)                                                                                                                  |     |                   |             |                |   ✓   |                       |                     |
| staff_capability.manage (AO03, D01)                                                                                                                      |     |                   |             |                |   ✓   |                       |                     |
| project.lead_project_engineer.change (T35)                                                                                                               |     |                   |             |                |   ✓   |                       |                     |
| system.status.read (T21)                                                                                                                                 |     |                   |             |                |   ✓   |                       |                     |

"Lead Project Engineer" and "Acceptance delegate" apply only when the handler passes that project to
`can()`. "Any internal user" means an active personal or test account. `report.issue` is also held
by an active, unexpired Authorized report issuer grant for that project and report scope (D06); the
field-report issue route (MM-V2-C09) checks it. Team membership, reviewer assignment, job title and position add no
permission to this table. The `concrete_*` rows are the MM-AO08 contract: no route checks them yet
(see "Concrete permission contract" below for the designated-reviewer and concrete Lab Manager
sources they also have).

## Sessions

- Opaque random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production); only its
  SHA-256 is stored.
- Absolute expiry, never extended: personal and test accounts 12 hours (`PERSONAL_SESSION_HOURS`,
  owner decision 2026-10-25); LAB one calendar month (MM-T06): the same local time in
  `BUSINESS_TIME_ZONE` a month later, clamped to the month's last day (Jan 31 → Feb 28/29). The
  cookie's `Expires` equals the session expiry, so it survives a browser restart.
- Revocable one at a time or all for a user; disabling a user revokes all of them in the same
  transaction.
- Roles and account status are read from the database on every request, never stored in the
  session, so a role change applies to that person's existing sessions on their next request
  (MM-T48: removing Admin turns their next admin-only request into 403) without revoking them.

## Shared receiving account LAB (MM-T06)

- Username `LAB` (any case) and an app-managed password (`POST /api/auth/lab/sign-in`). It is not a
  Microsoft account and has nothing to do with the development-only "Lab (test)" identity.
- An admin (`lab_account.manage`; STRATA-118: not `staff.manage`, which Lab Managers hold) sets
  or resets the password with `POST /api/admin/lab/password`
  (minimum 12 characters). A reset revokes every LAB session in the same transaction and clears
  the account lockout. "Sign out all LAB stations" uses the T04 revoke endpoint.
- Brute-force protection: 10 failed attempts within 15 minutes for the account, or from one client
  address, refuse further attempts for 15 minutes (HTTP 429 with `Retry-After`). Every failure is
  audited (`auth.sign_in_failed`), as is each lockout (`auth.lockout`); neither records the
  password or an unrecognised username.
- Audit events: `auth.sign_in` (provider `local_lab`), `auth.sign_in_failed`, `auth.lockout`,
  `lab.password_reset`, `auth.sign_out` and `auth.sessions_revoked` (T04's name for a revocation).
- `lab.integration.test.ts` calls every `@RequirePermission` endpoint outside the LAB column with a
  LAB session and expects 403 with no audit event, so new endpoints are covered automatically.
  `permission-matrix.security.test.ts` sweeps every route, handler-checked ones included, and
  checks that refused calls change no table.

## Microsoft sign-in (MM-T05)

- **Off by default.** It is enabled only when `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`,
  `MICROSOFT_CLIENT_SECRET` and `MICROSOFT_REDIRECT_URI` are all set; a partial set is refused at
  startup. Until then `/api/auth/providers` reports `microsoft: false` and `/api/auth/microsoft/*`
  answers 404. Keys are documented in `apps/api/.env.example`.
- **Flow:** single-tenant Entra ID, authorization code + PKCE (S256), state and nonce, as a
  confidential client via `openid-client`. `GET /api/auth/microsoft/start` stores the attempt
  server-side (10 minutes, single use, bound to the browser by an HttpOnly cookie) and redirects to
  Microsoft. Microsoft returns to the web route `/sign-in/microsoft/callback`, which posts the
  result to `POST /api/auth/microsoft/callback`. The server validates the ID token (signature
  against the tenant's keys, issuer, audience, tenant, nonce, expiry; guests refused) and issues
  the app session. Microsoft tokens never reach the browser. The Graph token is held only in
  server memory for a profile Retry.
- **Identity:** `identity_link(provider='microsoft', tenant_id, subject=oid)`. Name, email and
  initials are profile data and never keys, so a renamed person keeps the same app user and audit
  history.
- **Scopes:** `openid profile User.Read` only. Graph is read with
  `GET /v1.0/me?$select=displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation`.
  A Graph failure never blocks sign-in: known values stay, and the person sees a Retry.
- **New people** are created `pending` and see access-pending until an admin approves them
  (MM-T07); there is no position step (MISC-06), and Not set never blocks anything. **Position
  grants nothing.** **Official initials** are only ever set by
  an admin; refresh never writes them.
- **Bootstrap admin:** the account whose object ID matches `BOOTSTRAP_ADMIN_OBJECT_ID` (or, only
  when that is unset, whose UPN matches `BOOTSTRAP_ADMIN_UPN`) becomes active + admin at first
  sign-in, or while still pending. There is no first-user-wins rule.
- **Shared devices:** "Switch user" signs out and sends `prompt=select_account`. A new sign-in
  revokes any previous session cookie on that browser.
- **Rate limit (MM-T48):** `start` and `callback` each allow 20 requests per client address per
  5 minutes; more get HTTP 429 with `Retry-After` and a plain message (`start` as text/plain,
  `callback` as code `rate_limited`, which the callback page explains). Each address has its own
  count, so one never blocks another. Counts are in memory (one API process, D25) and reset on a
  restart. Refusals are logged as warnings, not audited.
- **Still needs IT** (card T05 §5): the app registration (tenant ID, client ID, secret, redirect
  URIs, admin consent for User.Read, technical owner), the optional `acct` ID-token claim, and
  reconciling sign-in timing (D38). Real-account verification (card test T6) waits for these.
- **Tests** use a mock tenant and Graph (`apps/api/src/test-support/mock-oidc.ts`;
  `npm run mock:idp -w @materialmule/api` for E2E) with fictional identities only.

## CSRF

State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) must send `x-materialmule-csrf: 1`
(`CSRF_HEADER_NAME` in `@materialmule/shared`), and if the browser sends `Origin` it must match the
request's `Host`. The API enables no CORS, so another site can't send the header.

## Staff & access (MM-T07)

| Route                                                                        | Policy                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------- |
| `GET /api/staff?search=&status=`                                             | `staff.manage` (Lab Manager, admin)          |
| `POST /api/staff` (pre-provision)                                            | `staff.manage`                               |
| `POST /api/staff/:id/approve`                                                | `staff.manage`                               |
| `POST /api/staff/:id/disable {reason}`                                       | `staff.manage`                               |
| `POST /api/staff/:id/enable`                                                 | `staff.manage`                               |
| `PUT /api/staff/:id/roles {roles, reason}`                                   | `staff.manage`                               |
| `PATCH /api/staff/:id`                                                       | `staff.manage`                               |
| `PUT /api/staff/:id/job-title-override {jobTitleOverride, reason}` (MM-AO06) | `staff.manage`                               |
| `GET /api/staff/:id/access` (MM-AO06)                                        | `staff.manage` (read-only)                   |
| `GET /api/admin/lab`, `POST /api/admin/lab/password` (MM-T06)                | `lab_account.manage` (admin only)            |
| `GET /api/me/access` (MM-AO06)                                               | active personal session (one's own); LAB 403 |
| `GET /api/staff/receivers?search=`                                           | any active session, LAB too                  |
| `GET /api/people/:userId/photo` (STRATA-52, cached photo; 404 `no_photo`)    | any active session, LAB too                  |

- **Approval** makes a pending account active; their existing session works on the next request.
- **Disabling** needs a reason and revokes every session in the same transaction; the person
  drops out of the receiver selector, and their cached directory photo is deleted. Re-enabling doesn't revive old sessions, and revokes every
  technical grant the person still holds for revalidation (D08, MM-AO03; see "Team & permissions").
- **Role changes** need a reason (D15, MM-AO03; 400 without one, nothing changes).
- **Lab Managers (STRATA-118)** hold `staff.manage`: they list staff, add and approve people,
  change roles other than admin (Lab Manager and Lab Technician included), disable and re-enable
  accounts, edit names and official initials and set job-title overrides. They are refused with
  403 `admin_only`, and nothing changes, when the change grants or removes the admin role, or
  touches an account that currently holds admin (its roles, disabling or re-enabling it, its
  profile or job title): that needs `admin_role.manage` (administrators). Setting or clearing a
  position (MISC-06, which moves review eligibility) needs `reviewer_eligibility.manage`, so it
  stays with administrators too. The check reads the account's roles after locking it, in the
  same transaction as the change. Reviewer eligibility, capabilities, session revocation and the
  LAB password stay administrator-only.
- **Last admin:** a change that would leave no active (non-LAB) admin, whether removing the admin
  role or disabling, returns 422 `last_admin`. Kyle's bootstrap admin is an ordinary admin.
- **LAB** can't hold roles (422 `roles_not_allowed`) and never appears as a receiver.
- **Receiver selection is attribution, not authentication**: it grants nothing. Only active
  staff with official initials are offered; free text is never accepted.
- **Pre-provisioned staff** are created active (the admin who adds them approves them). On a
  first Microsoft sign-in (`StaffService.resolveMicrosoftSignIn`, called by MM-T05) the entry is
  linked only when the UPN matches the expected UPN exactly (ignoring case) and the entry has no
  sign-in identity yet. Initials and names are never compared; anyone else becomes a new pending
  user.

### Job titles, eligibility and My access (MM-AO06)

- **Job title (D16).** Each person keeps the Microsoft Graph `jobTitle` (refreshed at sign-in) and
  may have an administrator's override, which is shown instead, labelled "Set by an
  administrator" (Microsoft's is labelled "From Microsoft"). Setting or clearing the override
  needs a reason (owner decision 2026-10-29; 400 without one) and is audited as
  `staff.job_title_override_set` / `_cleared` with before/after values and the reason. Setting the
  same value again changes nothing. The shared LAB account has none (422 `not_personal_account`).
  A Microsoft refresh never touches the override. Neither title is read by any permission,
  eligibility, capability or project rule (proven in `access-summary.integration.test.ts`).
- **Eligibility and capabilities** are administered in the Staff drawer ("Eligibility and
  capabilities") through the MM-AO03 routes (`/api/staff/:id/reviewer-eligibility`,
  `/api/staff/:id/capabilities`), each grant and revocation with a reason, for active accounts
  only. A 403 means the admin lost staff management and hides the admin controls (MM-T52).
- **My access** (`/settings/access`, "My access" in Settings for personal accounts) shows the
  signed-in person's own current app roles, what an admin granted them (reviewer eligibility per
  scope, "Can create and lead projects") and, per project, their responsibilities (Lead Project
  Engineer, team member, reviewer per scope, pending lead nomination) apart from their scoped
  grants (acceptance delegate, report issuer per scope with expiry), each with who granted it,
  when and why. A reviewer assignment whose eligibility was revoked, or an expired issuer grant,
  is listed as not effective with the reason. Active rows only (history stays on each project's
  Team & Permissions); at most 200 projects, by project number, with the total.
  `GET /api/me/access` always reads the session's own account (no id is accepted); it needs
  `project_access.read`, so LAB gets 403. Admins and Lab Managers (STRATA-118) see the same summary for anyone, read-only, under "Current
  access" in the Staff drawer (`GET /api/staff/:id/access`). My projects (D12) is unchanged: it
  filters relevance, never visibility.

## Projects (MM-T35)

| Route                                    | Policy                                                |
| ---------------------------------------- | ----------------------------------------------------- |
| `GET /api/projects?search=&mine=&sort=…` | `inventory.read` (every active session, LAB included) |
| `GET /api/projects/:id`                  | `inventory.read`                                      |
| `PATCH /api/projects/:id`                | active user; the service checks `project.edit`        |
| `POST /api/projects/:id/test-holes`      | `test_hole.create` (LAB included)                     |

- **Edit** (owner decision 2026-10-25): admins and the project's current Lead Project Engineer may change the
  number, name, client and server folder path. Changing the Lead Project Engineer is admin-only
  (`project.lead_project_engineer.change`) and needs a reason. A reviewer, Lab Manager or LAB can't edit.
  The single review engineer field is retired (MM-AO03, D12): scoped reviewer assignments replace it.
- **My projects** (`mine=true`, D12): projects the signed-in user is actively involved in as lead,
  team member, reviewer, acceptance delegate or report issuer; each row's `involvement` lists why.
- **Project number** is printed on labels, so it can't change once the project has any receipt:
  422 `project_number_locked`, also enforced by a database trigger.
- Edits are optimistic (`version`; a stale one gets 409 `version_conflict` with the current
  project) and audited as `project.updated` with only the changed fields before/after and the
  reason.

## Project creation and lead appointment (MM-AO04)

Owner decisions D01, D02, D08 and D10, with Kyle's AO04 answers of 2026-10-29: admins get an
inbox item and a list filter; the creator, then any staff member, may nominate; admins appoint
directly and may remove a lead; closure requests on a project with no lead wait for the next lead.

| Route                                                                                   | Policy                                         |
| --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `POST /api/projects {…, leadNomineeUserId?, nominationNote?, appointSelfAsLead?}`       | `project.create` (LAB included)                |
| `GET /api/projects?waitingForLead=true`                                                 | `inventory.read`                               |
| `GET /api/projects/:projectId/lead-nominations`                                         | `project_access.read` (personal accounts)      |
| `POST /api/projects/:projectId/lead-nominations {nomineeUserId, note?, idempotencyKey}` | `project_lead.nominate` (personal accounts)    |
| `POST /api/projects/:projectId/lead-nominations/:id/confirm {reason}`                   | `project.lead_project_engineer.change` (admin) |
| `POST /api/projects/:projectId/lead-nominations/:id/reject {reason}`                    | `project.lead_project_engineer.change` (admin) |
| `POST /api/projects/:projectId/lead-nominations/:id/withdraw {reason}`                  | `project_lead.nominate`; the nominator only    |
| `PATCH /api/projects/:id {leadProjectEngineerId: <id> or null, reason}`                 | `project.lead_project_engineer.change` (admin) |

- **Creating grants nothing** (AC1). Whoever adds a project, LAB included (for the selected
  person), may nominate a Lead Project Engineer or leave it empty. The project is saved with no
  lead either way and receiving carries on (D02). A nomination is a suggestion: it powers
  nothing for the creator or the nominee until an admin confirms it.
- **Self-appointment** (D01 option B): only a personal account holding an active "Can create and
  lead projects" grant may set `appointSelfAsLead`, and only while creating; anyone else gets 403
  `self_appointment_not_permitted` and nothing is saved. The grant row is locked, so a
  concurrent revocation commits wholly before or after. Audited as `project.lead_appointed`
  (`via: self_appointment`). The capability never lets its holder appoint anyone else.
- **Nominating later:** any active personal staff member, on a project with no lead (422
  `lead_already_appointed`) and no pending nomination (422 `nomination_pending`). The nominee
  must be active staff (422 `invalid_recipient`). LAB nominates only while creating.
- **Deciding:** an admin confirms (the nominee becomes the one effective lead in the same
  transaction; 409 `lead_already_appointed` if one was appointed meanwhile, 422
  `invalid_recipient` if the nominee is no longer active) or rejects; the nominator may
  withdraw. Every decision needs a reason (D15) and is recorded once on the nomination (409
  `nomination_decided` for a second, different decision; an exact retry returns the current
  state) and in its audit event. Confirmation is also audited as `project.lead_appointed`.
- **Direct appointment and removal:** an admin may set or change the lead with `PATCH` and a
  reason (as before), or remove it (`null`), which leaves the project waiting for a lead. A direct
  appointment closes a pending nomination: confirmed when it named that person, otherwise
  rejected with the admin's reason. Grants survive any of this (D08), with their original
  grantors.
- **Admin intake (D02):** while a project has no lead it has one open "Lead appointment" action
  request (`kind: lead_appointment`), in every admin's inbox and email (if they opted in), linking
  to the project's Lead section. Appointing a lead resolves it (`appointed`); removing a lead opens
  a new one. Lab Managers and admins may reassign it to another admin (`action_item.reassign`).
- **No lead (D02):** decisions only the lead can make (closing a program, managing delegates,
  issuers or the team as lead, approving disposal as lead…) are refused, and capabilities report
  them as `blocked.code: no_lead_project_engineer`. Lab Manager decisions and existing
  delegations keep working as before; there is no creator or admin fallback. A closure request is
  still saved and shows "Waiting for a Lead Project Engineer"; it reaches the lead's inbox as soon
  as one is appointed, because lead-routed requests follow the current lead. Rerouting of other
  open work (D10) is MM-AO07.
- **Lock order (D09):** the project (FOR UPDATE), then the accounts (FOR SHARE), then the
  nomination (FOR UPDATE). Two decisions, or a decision and a direct appointment, serialise on
  the project: the first to commit wins.

## Team & permissions (MM-AO03)

Owner decisions D01, D04–D09, D12 and D15 (adopted 2026-10-29). Code:
`apps/api/src/project-access/`; DTOs: `packages/shared/src/project-access.ts`.

| Route                                                                                                                            | Policy                                                |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /api/review-scopes`                                                                                                         | `project_access.read` (personal accounts)             |
| `GET /api/review-scopes/:code/eligible-reviewers?search=` (MM-AO05)                                                              | `project_access.read`                                 |
| `GET /api/projects/:projectId/capabilities`                                                                                      | `project_access.read`                                 |
| `GET /api/projects/:projectId/access-history` (STRATA-85, paged)                                                                 | `project_access.read`                                 |
| `GET /api/projects/:projectId/team-members`                                                                                      | `project_access.read`                                 |
| `POST /api/projects/:projectId/team-members {userId, reason, idempotencyKey}`                                                    | active user; handler checks `project_team.manage`     |
| `DELETE /api/projects/:projectId/team-members/:id {reason}`                                                                      | active user; handler checks `project_team.manage`     |
| `GET /api/projects/:projectId/reviewer-assignments`                                                                              | `project_access.read`                                 |
| `POST /api/projects/:projectId/reviewer-assignments {reviewerUserId, scopeCode, reason, idempotencyKey}`                         | active user; handler checks `project_reviewer.manage` |
| `DELETE /api/projects/:projectId/reviewer-assignments/:id {reason}`                                                              | active user; handler checks `project_reviewer.manage` |
| `POST /api/projects/:projectId/reviewer-assignments/:id/approval {reason?, idempotencyKey}` (MISC-08)                            | active user; handler checks `project_review.approve`  |
| `DELETE /api/projects/:projectId/review-approvals/:id {reason}` (MISC-08)                                                        | active user; handler checks `project_review.approve`  |
| `GET /api/projects/:projectId/report-issuers`                                                                                    | `project_access.read`                                 |
| `POST /api/projects/:projectId/report-issuers {issuerUserId, scopeCode, reason, approvalReference?, expiresAt?, idempotencyKey}` | active user; handler checks `report_issuer.manage`    |
| `DELETE /api/projects/:projectId/report-issuers/:id {reason, kind?}`                                                             | active user; handler checks `report_issuer.manage`    |
| `GET /api/staff/:id/grants`                                                                                                      | `staff.manage` (LM, admin)                            |
| `POST /api/staff/:id/reviewer-eligibility {scopeCode, reason, idempotencyKey}`                                                   | `reviewer_eligibility.manage` (admin)                 |
| `DELETE /api/staff/:id/reviewer-eligibility/:grantId {reason}`                                                                   | `reviewer_eligibility.manage`                         |
| `POST /api/staff/:id/capabilities {capability, reason, idempotencyKey}`                                                          | `staff_capability.manage` (admin)                     |
| `DELETE /api/staff/:id/capabilities/:grantId {reason}`                                                                           | `staff_capability.manage`                             |
| `GET /api/me/grants`                                                                                                             | any active session (one's own)                        |

- **Who manages what.** Team members and scoped reviewers: the project's Lead Project Engineer or
  an admin (D04). Reviewer eligibility per scope and "Can create and lead projects": admin (D05,
  D01). Authorized report issuers: the project's Lead Project Engineer only; admin never (D06).
  The lead issues on their own project in every scope without a grant (D07). Nominations (D01)
  and unassigned projects (D02) are MM-AO04.
- **Recipients** are named by ID; the server loads their standing. They must be active personal
  (or test) staff (422 `invalid_recipient`), never LAB, pending or disabled. A reviewer needs
  active eligibility for the scope (422 `not_eligible`); the scope must be active (422
  `invalid_scope`); the lead can't be added as their own team member or issuer
  (`invalid_recipient`); an issuer expiry must be in the future (422 `invalid_expiry`); a second
  active row for the same person and scope is 422 `already_assigned` (`already_granted` for
  per-person grants).
- **Reasons** (D15) are required on every grant, assignment, removal and revocation (400
  `validation_failed`), as on delegation grants/revocations and role changes. The reason, who and
  when are kept on the row and in its audit event (`project_team_member.added`/`.removed`,
  `project_reviewer_assignment.assigned`/`.removed`, `project_report_issuer_grant.granted`/
  `.revoked`, `reviewer_eligibility.granted`/`.revoked`, `staff_capability_grant.granted`/`.revoked`).
- **Issuer grants** carry an optional approval reference and expiry. Revocation `kind` is
  `ordinary` (default) or `emergency` (suspension); either needs a reason. A grant counts only while
  not revoked and before `expires_at`, for its project and scope only (AC2).
- **Effective only while valid.** A reviewer assignment counts only while the reviewer is active and
  still eligible for its scope (`blockedReason: eligibility_revoked`); an issuer grant while the
  holder is active and it hasn't expired (`expired`). Rows are never deleted.
- **Capabilities** (`GET …/capabilities`): for each project action, `allowed`, every `sources`
  entry that grants it (`lab`, `internal`, `lab_manager`, `admin`, `lead_project_engineer`,
  `acceptance_delegate`, `report_issuer`) and, when blocked, `{code, grantedBy}` (`code`:
  `account_not_active`, `shared_lab_account`, `no_lead_project_engineer` or `not_permitted`; `grantedBy`: the sources that
  would grant it). Also the caller's `involvement`, `issuerScopes` and `reviewerScopes`. Built from
  the same `permissionSources()` that `can()` uses, so it can't disagree with enforcement. Nothing
  the browser sends about roles or capabilities is read.
- **Order of checks:** 401/403 from the guard; 403 when the caller can't manage this (checked
  against the project as it stands, before the body; 403 too for an unknown project unless the
  caller could manage some project, then 404); 400 body; 409 `idempotency_key_reused`; 422
  recipient/scope rules. A removal of a row that belongs to another project is 404
  (`<table>_not_found`). Ending an already-ended row changes nothing. Exact retries return the
  current list without a second row.
- **D08.** Grants survive a lead change; the new lead reviews and revokes selectively (historical
  grantors never change). Re-enabling a disabled account revokes its technical grants (reviewer
  eligibility and assignments, issuer grants, acceptance delegations, create-and-lead, concrete Lab
  Manager grants) in the re-enable transaction, each audited with the reason "Account re-enabled: technical grants need
  revalidation (D08)". Team membership stays.

### Team & Permissions screen (MM-AO05)

`/projects/:projectId/team` (linked as **Team & Permissions** from the project page, for personal
accounts) shows, from the routes above and the MM-AO04 nomination routes: **Leadership** (the lead,
or "Waiting for a lead", and any pending nomination); **People on this project** (each person's
responsibilities — Lead Project Engineer, team member, reviewer per scope — and, in a separate
column, their grants — acceptance delegate, report issuer per scope); **Project team**; **Review
responsibilities** (grouped by scope, each marked effective or why not); **Authorizations**
(acceptance delegates and report issuers, with grantor, reason, approval reference, expiry and
emergency suspension); **Your permissions here** (the server's capability list: allowed or not,
the sources, and the blocked reason with who could); and **History** (every start and end with
who and why, newest first, from the lists' newest rows).

- Add, remove, assign and revoke controls appear only where the list's `canManage` is true. The
  browser computes no permissions; the people summary only arranges the server's lists.
- The reviewer picker lists `GET /api/review-scopes/:code/eligible-reviewers`: active personal
  staff with active eligibility for that scope (at most 50, narrowed by `search` on initials or
  name; 404 `review_scope_not_found` for an unknown or retired scope). It is a lookup only; the
  assignment re-checks eligibility under lock.
- Nothing shows as done before the server confirms it. A 403 on a write (authority lost
  mid-session) says nothing was saved and reloads the page, so the controls match the new
  capabilities; a 409 or 404 reloads too. After every confirmed change the capability list is
  re-read. Form entries are kept when a write fails or the connection drops.

### Lock order and first-commit-wins (D09)

Every final authority check runs inside the write's transaction, after taking locks in this
order: **domain rows** (program, test request, storage units, retention decision or request),
then **the project** (FOR SHARE; FOR UPDATE for a new assignment or grant, NO KEY UPDATE for a new
hold or extension or a request decision), then **the accounts involved** (FOR SHARE, in id order:
`lockStanding`), then **assignment and grant rows**. A lead change (project FOR UPDATE), a role
change, disable or re-enable (account FOR UPDATE) and a revocation (grant row FOR UPDATE) all
conflict with these locks, so whichever commits first wins: an action whose check comes after a
committed change sees it and is refused (403) with nothing written; a change that comes after a
committed action waits for it, and the action's results and attribution stay. Committed work is
never rolled back retroactively. MM-AO03 brought program close, reopen, test cancel, priority,
retention placement/release/decisions and disposal approval/revocation under this rule
(`canUnderLock`), alongside acceptance (MM-T25). Disposal approval now locks the units' projects
before the units, the order removal and retention placement already used, so the three can't
deadlock. A check that depends on grants (report issuers, designated reviewers and their
approvals, concrete Lab Managers) locks those rows FOR SHARE and reads them only then:
`canUnderLock` takes the context as a loader that runs after the project and account locks, and
the loader calls `lockProjectGrants` (review fix #134; field and strength review, return, issue
and revise, exception notes, summary issue, HOLD release). A list read before the locks is only
the first check. Requests that only route work to the lead (closure and cancellation requests) take no
authority and are unchanged; open-task rerouting (D10) is MM-AO07.

## Concrete permission contract (MM-AO08)

The shared authorization contract for concrete work, in `apps/api/src/auth/policy.ts` with its
matrix in `policy.test.ts`. **Partly implemented:** C01 added the record tables, C02 the settings,
the concrete Lab Manager grant and the loaders, and C03 the mix routes (`concrete_mix.manage` /
`concrete_mix.approve`, below; [concrete.md](concrete.md)). C09 added the field-report review and
issue routes (`concrete.review`, `report.issue`, `concrete_report.recall`; "Concrete report
lifecycle" below). No schedule or HOLD route exists yet, so those actions are enforced by no
endpoint yet, and none of them
appears in a project's capability list (`GET …/capabilities`, Team & Permissions) until its
owning card adds the route (owner decision 2026-10-29, AO08 Q2). Each owning card loads the
project facts below from the database, checks `can()` under the D09 lock order, and adds its row
to the capability list in the same change.

| Permission                                  | Granted by                                                                                    | Owner card                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `concrete_mix.manage`                       | the destination project's Lead Project Engineer only                                          | C03 (implemented: create, edit, copy)              |
| `concrete_mix.approve`                      | the destination project's Lead Project Engineer only                                          | C03 (implemented: approve; D14 revisions)          |
| `concrete.review`                           | the project's Lead Project Engineer, or a designated reviewer for the scope                   | C02 adapter, then C04/C07 review routes            |
| `concrete_failure_schedule.approve`         | the project's Lead Project Engineer, or a designated reviewer (strength scope); one is enough | the failure-workflow card after C07                |
| `concrete_hold.manage`                      | the project's Lead Project Engineer, or a Lab Manager holding the project's concrete grant    | C02 (grant storage), then the failed-specimen HOLD |
| `report.issue` (existing, AO03)             | the Lead Project Engineer, or an Authorized report issuer for the scope                       | C09 (implemented: field reports)                   |
| concrete settings → `project.edit`          | the Lead Project Engineer or an admin (settings only)                                         | C02 (implemented)                                  |
| concrete Lab Manager grant → `project.edit` | the Lead Project Engineer or an admin; grants/revokes the D13 grant                           | C02 (implemented)                                  |

- **Mixes (C03, D14).** Only the destination project's Lead Project Engineer creates, edits,
  copies and approves mixes: no admin, Lab Manager, reviewer, delegate or issuer fallback, and a
  project waiting for a lead (D02) has no one who can. D14 (adopted): editing an approved mix makes
  a new draft revision; the approved version stays effective until the lead approves the revision.
  Routes (MM-V2-C03):

  | Route                                                                                   | Policy                                                |
  | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
  | `GET /api/projects/:projectId/concrete-mixes?supplier=&search=&status=&page=&pageSize=` | `inventory.read` (every active session, LAB included) |
  | `GET /api/projects/:projectId/concrete-mix-suppliers`                                   | `inventory.read`                                      |
  | `GET /api/concrete-mixes/:id`                                                           | `inventory.read`                                      |
  | `POST /api/projects/:projectId/concrete-mixes {spec, idempotencyKey, note?}`            | active user; handler checks `concrete_mix.manage`     |
  | `POST /api/projects/:projectId/concrete-mixes/copy {sourceMixId, sourceRevisionId?, …}` | active user; `concrete_mix.manage` on the destination |
  | `PATCH /api/concrete-mixes/:id {version, spec, idempotencyKey, note?}`                  | active user; handler checks `concrete_mix.manage`     |
  | `POST /api/concrete-mixes/:id/approve {version, revisionId, idempotencyKey, note?}`     | active user; handler checks `concrete_mix.approve`    |
  | `GET /api/concrete-mixes/:id/propagation` (C30)                                         | `inventory.read`                                      |
  | `POST /api/concrete-mixes/:id/propagation {previewId, selection, idempotencyKey}` (C30) | active user; handler checks `concrete_mix.approve`    |
  | `GET /api/concrete/projects/:projectId/specimens` (C30)                                 | `inventory.read`                                      |
  | `GET /api/concrete/projects/:projectId/specimen-sets` (STRATA-98)                       | `inventory.read`                                      |

  Reads follow the project (mixes are project data; field preparation caches them, CD-15). Order
  of checks as AO03: 401/403 from the guard; 403 when the caller isn't the project's lead (an
  unknown project or mix is 404 only for someone who leads some project); 400 body; 409
  `idempotency_key_reused`, `version_conflict` (with the current mix) or `mix_number_taken`; 422
  `incomplete_for_approval`, `revision_not_draft`, `source_mix_not_found`,
  `invalid_source_revision`. The final check runs under the D09 locks (mix row, then project and
  account: `canUnderLock`). Both actions are in the capability list (blocked code
  `no_lead_project_engineer` on a project waiting for a lead, otherwise `not_permitted`).

- **Concrete review (D05, D11).** The project's Lead Project Engineer always holds it on their own
  project (owner decision 2026-10-29, AO08 Q3), as does a designated reviewer: assigned to the
  project for that scope, active, and still eligible (`designated_reviewer` source; the loader
  fills `ProjectContext.designatedReviewerUserIds` for the one scope being checked). One eligible
  review is enough. A result corrected by a Lab Manager goes to the project's lead for review
  (D11). Generic lab review (`test.review`) is unchanged.
- **Failed-specimen schedule change.** The lead or a designated reviewer approves the specified
  change; one approval is enough.
- **Failed-specimen HOLD (D13).** Releasing, testing or disposing of a failed-specimen hold needs
  the project's lead, or the global Lab Manager role **and** the project's explicit concrete grant
  (`concrete_lab_manager` source, `ProjectContext.concreteLabManagerUserIds`). The role alone or the
  grant alone is not enough. Grant storage, and its grant/revoke by the lead or an admin with a
  reason, belong to C02 (AO08 Q1). It is separate from retention holds (`retention.manage`) and
  geotechnical tested-unit removal (`storage_unit.tested_removal`).
- **Failure photos** are optional and never block a result; no permission beyond recording the
  result.
- **Concrete settings** reuse `project.edit`: the lead or an admin (AO08 Q4). Admin authority
  covers settings only, never mixes. Reviewer assignments stay `project_reviewer.manage` (AO03);
  there is no second reviewer list.

### Concrete settings and Lab Manager grant routes (MM-V2-C02)

| Route                                                                                            | Policy                                                |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `GET /api/projects/:projectId/concrete-settings`                                                 | `inventory.read` (every active session, LAB included) |
| `PATCH /api/projects/:projectId/concrete-settings {version, …fields, reason?}`                   | active user; handler checks `project.edit`            |
| `GET /api/projects/:projectId/concrete-lab-managers`                                             | `project_access.read` (personal accounts)             |
| `POST /api/projects/:projectId/concrete-lab-managers {labManagerUserId, reason, idempotencyKey}` | active user; handler checks `project.edit`            |
| `DELETE /api/projects/:projectId/concrete-lab-managers/:id {reason}`                             | active user; handler checks `project.edit`            |

- **Settings save:** 403 (checked against the project as it stands, before the body; 403 for an
  unknown project unless the caller could edit projects, then 404), 400 body, then under the D09
  lock order (settings row FOR UPDATE, project and account FOR SHARE) the final `project.edit`
  check; a stale `version` (0 = never saved) is 409 `version_conflict` with the current settings,
  nothing written. Only changed fields are written and audited; an unchanged save keeps the
  version. An admin may save on a project waiting for a lead.
- **Grant:** the recipient must be active personal staff (422 `invalid_recipient`) holding the
  Lab Manager role (422 `not_lab_manager`, also a database trigger); one active grant per project
  and person (422 `already_assigned`); reasons required (D15); retries and key reuse as for the
  AO03 grants. Each list row is `effective` or blocked (`account_not_active`, `not_lab_manager`).
  The grant counts only with the role, on that project only. Re-enabling a disabled account
  revokes it (D08). No new permission: granting reuses `project.edit` (owner direction 2026-11-07; new concrete
  permission rows, including technician/LAB preparation and submission, belong to C10).
  `concrete_hold.manage` and `concrete.review` stay out of the capability list until their routes
  exist.
- **Denied wording** for the owning screens: the existing blocked codes apply —
  `no_lead_project_engineer` when only the lead could act and there is none, `not_permitted`
  otherwise, with the sources that could (`CAPABILITY_SOURCE_LABEL`: "Designated reviewer", "Lab
  Manager with this project’s concrete grant").

### Concrete contract extension (MM-V2-C10)

The rows the Combined Plan and the owner's gap-review answers (2026-10-30, gap review §3) confirm
but AO08 did not name. **Planned, not implemented:** no route checks them, and none appears in a
capability list until its owning card adds the route and its capability row (AO08 Q2). The
matrix is in `policy.test.ts` ("MM-V2-C10 …").

New fact: `ProjectContext.recordTechnicianUserId`, the technician of the one record being checked,
loaded per record by the owning card the way `designatedReviewerUserIds` is loaded per scope (the
report's technician; the casting technician of the specimen's report; the original technician of
a recovery file). It grants through the new `record_technician` source ("Technician of this
record"), personal and test accounts only. "Designated reviewer" is MISC-08's
`designatedReviewers()` for the scope being checked; "concrete-grant Lab Manager" is the C02 grant
together with the `lab_manager` role (`concrete_lab_manager`); "Lab Manager (role alone)" is the
`lab_manager` role with no grant.

| Permission                                     | Granted by                                                                                                         | Handler also checks                                                                                         | Owner card                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------- |
| `concrete_report.draft`                        | any active internal user, on any project; LAB with the performing staff member selected                            | edits only drafts whose technician is the acting person (LAB: the selected person)                          | C04 (drafts), C19 (Ready) |
| `concrete_report.recall`                       | the report's technician (`record_technician`)                                                                      | submitted and not yet reviewed                                                                              | C09                       |
| `concrete_receiving_exception.resolve`         | the lead, a designated reviewer, a concrete-grant Lab Manager, or the casting technician for specimens they cast   | reason required                                                                                             | C21                       |
| `concrete_sync_conflict.resolve_field`         | the record's technician (unsubmitted field data)                                                                   | data still unsubmitted                                                                                      | C17                       |
| `concrete_sync_conflict.resolve_lab`           | the lead, a designated reviewer, or any Lab Manager (role alone, no grant; C36): receiving, test or submitted data |                                                                                                             | C17                       |
| `concrete_recovery.import`                     | the original technician, or any Lab Manager (role alone)                                                           |                                                                                                             | C16                       |
| `concrete_ordinary_hold.manage`                | the lead, or any Lab Manager (role alone, no grant): ordinary HOLD release and disposal authorization              | not a failed-specimen hold (that stays `concrete_hold.manage`)                                              | C26                       |
| `concrete_set.void`                            | the lead, a designated reviewer, or a concrete-grant Lab Manager                                                   | reason required                                                                                             | C18                       |
| `concrete_specimen.reschedule`                 | the lead, a designated reviewer, or a concrete-grant Lab Manager (outside the failure rule)                        | reason required                                                                                             | C22                       |
| `concrete_settings.curing_standard.manage`     | Lab Manager or admin                                                                                               |                                                                                                             | no card yet (Package 4)   |
| `concrete_settings.testing_machine.manage`     | Lab Manager                                                                                                        |                                                                                                             | C27 (implemented)         |
| `concrete_settings.attachment_limit.manage`    | admin                                                                                                              |                                                                                                             | C15                       |
| project created during sync → `project.create` | existing rule (any internal user; LAB)                                                                             | the syncing technician, from job number and name; duplicate job number refused; lead nominated later (AO04) | C17                       |

- **Personal account only.** Every row except `concrete_report.draft` is refused to LAB whoever a
  station selects, even when the selected person is the record's technician, the lead or a
  reviewer, and even with a role assigned by mistake (AC3). Selection is attribution, never
  authority.
- **Record technician scope is per record.** It confers nothing beyond its four rows: a casting
  technician resolving a specimen they did not cast is refused (AC2), and it never gives review,
  void, reschedule or HOLD authority.
- **Admin** holds only the two settings rows; never any concrete workflow authority.
- **`GET /api/me`** reports `concrete_report.draft` (global, and on LAB's allow-list, whose
  reported list must equal `LAB_PERMISSIONS`); the other C10 rows are added to it, and to the
  project capability list, by their owning cards.
- **Owner decisions settled by MM-V2-C36 (Kyle 2026-11-08).** The "any active lab staff" rows and
  the Lab Manager part of `concrete_sync_conflict.resolve_lab` are granted as described in "Lab
  staff and the Lab Technician role (MM-V2-C36)" below. `PENDING_OWNER_DECISION` is empty; a
  test keeps any future member ungranted.

## Lab staff and the Lab Technician role (MM-V2-C36)

Owner decisions of 2026-11-08 (Kyle). **Lab staff** are: the admin-assigned `lab_technician` role
("Lab Technician"), the `lab_manager` role, and the shared LAB account when it names the
performing staff member, who is recorded as the actor (attribution only: LAB never gains that
person's roles). Position (Technician, Technologist, …) still grants nothing (MISC-06), so a plain
internal user is refused every lab-staff row.

| Permission                           | Granted to (sources)                                                           | Handler also checks (owner card)                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `concrete_specimen.receive`          | Lab Technician, Lab Manager (role alone), LAB (`lab`)                          | pickup, receipt and mass entry; LAB requires the performing person (C06, then C20) |
| `concrete_specimen.mass_correct`     | Lab Technician, Lab Manager (never LAB: CD-46 personal account)                | mass correction after save, reason (C06, then C20)                                 |
| `concrete_test.enter`                | Lab Technician, Lab Manager, LAB                                               | test entry and correction (reason); LAB requires the tester (C07, then C23)        |
| `concrete_specimen.dispose_record`   | Lab Technician, Lab Manager, LAB                                               | record actual disposal; LAB requires the performing person (C26)                   |
| `concrete_settings.air_meter.manage` | Lab Technician, Lab Manager (role alone)                                       | the air-meter register (C27, implemented)                                          |
| `concrete_sync_conflict.resolve_lab` | Lab Manager (role alone, no project concrete grant), lead, designated reviewer | receiving, test or submitted data (C17)                                            |

- **Routes:** `concrete_specimen.receive` and `concrete_specimen.mass_correct` guard C06's
  receiving routes and `concrete_test.enter` guards C07's test-result saves;
  `concrete_specimen.dispose_record` has no route yet. Each owning card adds its route; `GET /api/me`
  already reports them (and `concrete_sync_conflict.resolve_lab` for Lab Managers) so the UI can
  show the controls. LAB's reported list still equals `LAB_PERMISSIONS`, which leaves out
  `concrete_specimen.mass_correct`: the correction route needs a personal account (CD-46), so
  LAB never advertises it.
- **A Lab Technician is never a Lab Manager.** It holds only the rows above (and everything any
  internal user holds). It never reviews (`concrete.review`), issues (`report.issue`), accepts,
  approves, manages HOLDs, settings other than air meters, the catalogue, retention or disposal
  approval, and it can't receive a project's concrete Lab Manager grant (the grant trigger
  requires `lab_manager`). Every SQL helper and action-item rule that looks for a Lab Manager
  compares `role = 'lab_manager'` exactly, and `action_item.target_role` stays `lab_manager` or
  `admin`.
- **Assigning it.** Admins assign and remove the role on the Accounts screen (Settings → Staff &
  access → Manage → Roles) through `PUT /api/staff/:id/roles` with a reason, audited as
  `staff.roles_changed`. LAB still can't hold any role (422 `roles_not_allowed`). The change
  applies to existing sessions on their next request (MM-T48).
- **Migration 0024** widens the `role_assignment.role` check to `admin`, `lab_manager`,
  `lab_technician`; existing assignments are unchanged. The dev seed adds the fictional Lab
  Technician Taylor Bench (fixture key `lt`, `…000000000110`).

## Concrete reference data (MM-V2-C37)

Owner decisions of 2026-11-08 (Kyle). Contracts: `packages/shared/src/concrete-reference-data.ts`.

| Route                                                             | Policy                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `GET /api/concrete/suppliers?includeInactive=`                    | `inventory.read` (every active session, LAB included)         |
| `POST /api/concrete/suppliers`, `PATCH …/:id`                     | `concrete_settings.supplier.manage` (Lab Manager role, admin) |
| `GET /api/concrete/holidays?year=`                                | `inventory.read`                                              |
| `POST /api/concrete/holidays`, `PATCH …/:id`, `POST …/:id/remove` | `concrete_settings.holiday.manage` (admin)                    |
| `POST /api/concrete-mixes/:id/discard-draft`                      | `concrete_mix.manage` (the project's Lead Project Engineer)   |

- **Order of checks:** 401/403 (route permission, before the body), 404 for an unknown supplier or a
  holiday not in effect, 400 body, then under the lock (the row FOR UPDATE, then the actor's
  account FOR SHARE, D09) the final permission check. A stale `version` is 409 `version_conflict`
  with the current row; a duplicate name 409 `supplier_exists`; a date already a holiday 409
  `holiday_exists`. Removing a holiday needs a reason.
- **Discard draft** follows C03's mix order of checks (mix FOR UPDATE, project and account FOR
  SHARE). 422 `revision_not_draft` when the named revision isn't the open draft; 409
  `no_approved_revision` for an Unapproved mix; idempotent by key.
- **Supplier link:** `supplierId` on mix create/PATCH must name an active listed supplier (422
  `invalid_supplier`); `null` unlinks.

## Concrete equipment (MM-V2-C27)

The one testing machine and the air meters, with calibration history (CD-44, CD-45). Contracts:
`packages/shared/src/concrete-equipment.ts`; tables: migration 0018 ([concrete.md](concrete.md#equipment-c27)).

| Route                                                                | Policy                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/concrete/equipment?kind=&includeRetired=`                  | `inventory.read` (every active session, LAB included)              |
| `GET /api/concrete/equipment/:id`                                    | `inventory.read`                                                   |
| `GET /api/concrete/equipment/:id/use-check?on=`                      | `inventory.read`                                                   |
| `GET /api/concrete/air-meters/assigned?technicianUserId=&on=`        | `inventory.read` (field-report autofill)                           |
| `POST /api/concrete/testing-machine`, `PATCH …/:id`                  | `concrete_settings.testing_machine.manage` (Lab Manager)           |
| `POST /api/concrete/testing-machine/:id/calibrations`, `…/:cid/void` | `concrete_settings.testing_machine.manage`                         |
| `POST /api/concrete/air-meters`, `PATCH …/:id`                       | `concrete_settings.air_meter.manage` (Lab Manager, Lab Technician) |
| `POST /api/concrete/air-meters/:id/calibrations`, `…/:cid/void`      | `concrete_settings.air_meter.manage`                               |

- **Testing machine (AC3):** Lab Manager role alone (C10). Admin, the lead, any other staff and LAB
  get 403 before the body, and nothing is written.
- **Air meters:** `concrete_settings.air_meter.manage` is held by the Lab Manager and Lab
  Technician roles (MM-V2-C36, Kyle 2026-11-08). Admin, the lead, any other staff and LAB get 403.
- **Order of checks:** 401/403 (route permission, the request's user), 404 for an unknown id or an
  id of the other kind, 400 body, then under the lock (equipment row FOR UPDATE, then the editor's
  and an assignee's accounts FOR SHARE, D09) the final permission check. A stale `version` is 409
  `version_conflict` with the current detail; retired equipment is 409 `equipment_retired`; a
  second testing machine 409 `testing_machine_exists`; a duplicate equipment ID 409
  `equipment_identifier_exists`; an assignee who isn't active personal staff 422
  `invalid_recipient`. Creates and calibration entries are idempotent by key (a reused key for
  another intent is 409 `idempotency_key_reused`); voiding an entry twice is 409
  `calibration_already_voided`.
- **Audit** (entity `concrete_equipment`, in the same transaction): `concrete_equipment.registered`,
  `.updated` (changed fields only, before/after, optional reason), `.calibration_recorded`,
  `.calibration_voided` (reason required).
- **Flags never block.** The use-check, the autofill and the equipment list only report what using
  the equipment flags; no route refuses work because of a flag.

## Concrete field-report drafts (MM-V2-C04)

Contracts: `packages/shared/src/concrete-field-reports.ts`; tables: migration 0019
([concrete.md](concrete.md#field-reports-c04)). No submission, review or issuance route here.

| Route                                                  | Policy                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `GET /api/concrete/projects/:projectId/field-reports`  | `inventory.read` (every active session, LAB included)               |
| `GET /api/concrete/field-reports/:id`                  | `inventory.read`                                                    |
| `POST /api/concrete/projects/:projectId/field-reports` | `concrete_report.draft` (any active internal user; LAB with person) |
| `PATCH /api/concrete/field-reports/:id`                | `concrete_report.draft`, own drafts only                            |

- **Order of checks.** `concrete_report.draft` is checked by the route guard and again by the
  service before the body and before any lock or transaction (403). Then, in one transaction in
  the D09 order: the report FOR UPDATE (save), the chosen mix FOR SHARE (its snapshot is copied),
  the project and the actor's account FOR SHARE (`canUnderLock`), then the performing person's
  account FOR SHARE. Unknown project or report: 404 (the permission is global, so there is no
  project role to hide).
- **Attribution (C10).** The technician credited is the acting person. A personal account is its
  own technician (naming anyone else is 400 `not_allowed`). LAB must name an active staff member
  with confirmed initials in `technicianUserId` (400 `required`, 422 `invalid_technician`); LAB is
  the audited actor and the person the audited receiver. LAB never becomes the technician (C01
  trigger).
- **Own drafts only (CD-58).** A save by anyone other than the draft's technician is 403
  `not_own_draft` (a personal account: before the body; LAB: when the named person isn't the
  technician). Project roles (lead, Lab Manager, admin) add nothing. Only `draft` reports, and
  reports `returned` for correction (MM-V2-C09), are saved here (409 `not_a_draft`); submission
  is below, Ready to submit is C19's.
- **Retries and conflicts.** `idempotencyKey` on every write: an exact retry returns the report as
  it stands with no second version or event; the same key for anything else is 409
  `idempotency_key_reused`. A client `id` already used is 409 `report_id_taken`. A stale `version`
  is 409 `version_conflict` with the current report, nothing written. An unchanged save keeps the
  version.
- **Capabilities.** `concrete_report.draft` is global, already reported by `GET /api/me`; it is not
  a project capability, so `PROJECT_CAPABILITY_ACTIONS` is unchanged. Each report's `canEdit` says
  whether the caller may save it.
- **Review routing** (read only): MISC-08's `designatedReviewers()` for scope `concrete_field` plus
  the project's lead, read live; `blocked: no_reviewer` when neither exists. Review itself is C28.

## Concrete specimen sets (MM-V2-C05)

Contracts: `packages/shared/src/concrete-specimen-sets.ts`; tables: migration 0020
([concrete.md](concrete.md#specimen-sets-c05)). No allocation, Void, reschedule or device-code
route here.

| Route                                                             | Policy                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/concrete/field-reports/:reportId/specimen-set-defaults` | `inventory.read`                                                          |
| `GET /api/concrete/field-reports/:reportId/specimen-sets`         | `inventory.read`                                                          |
| `GET /api/concrete/specimen-sets/:id`                             | `inventory.read`                                                          |
| `POST /api/concrete/field-reports/:reportId/specimen-sets`        | `concrete_report.draft`, own draft report only                            |
| `PATCH /api/concrete/specimen-sets/:id`                           | `concrete_report.draft`, own draft report only                            |
| `DELETE /api/concrete/specimen-sets/:id`                          | `concrete_report.draft`, own draft report, unnumbered set only            |
| `POST /api/concrete/field-reports/:reportId/casting-correction`   | `concrete_specimen.reschedule` on the report's project (owner to confirm) |

- **Draft writes** follow C04 exactly: the route guard and the service check
  `concrete_report.draft` before the body; then in one transaction (D09) the report FOR UPDATE, the
  set FOR UPDATE, the project and actor FOR SHARE (`canUnderLock`), the performing person. The
  person credited (LAB: `technicianUserId`, attribution only) must be the report's technician
  (403 `not_own_draft`), the report a draft (409 `not_a_draft`), and "Specimens cast" not No (409
  `specimens_not_cast`). Retries: `idempotencyKey` (409 `idempotency_key_reused`), client `id`
  (409 `set_id_taken`), `version` (409 `version_conflict` with the current set). A numbered set's
  letters and ages and its existence are fixed (409 `set_numbered`).
- **Casting correction (AC5).** Proposal, owner to confirm: reuse C10's
  `concrete_specimen.reschedule` (the lead, a designated reviewer for `concrete_field`, or a
  Lab Manager with the project's concrete grant; personal accounts only, reason required), since
  correcting the casting time moves every dependent test date. Checked on the report's project
  before the body (an unknown report is 403 unless the caller could hold the permission somewhere,
  then 404) and again under the lock. Only for a report with a numbered set (409
  `no_numbered_set` otherwise: correct the draft instead). `confirm: false` returns the effects;
  `confirm: true` records the correction and applies it. C04's draft save of `castAt` on such a
  report is 409 `casting_correction_required`.
- **Capabilities.** `concrete_report.draft` is global (`GET /api/me`). C22 added
  `concrete_specimen.reschedule` to `PROJECT_CAPABILITY_ACTIONS` with the facts it needs (below).
  Each set's `canEdit` says whether the caller may edit its specimens.

## Concrete pickup and receiving (MM-V2-C06)

Contracts: `packages/shared/src/concrete-receiving.ts`; tables: migration 0026
([concrete.md](concrete.md#pickup-initial-curing-and-receiving-c06)).

| Route                                                          | Policy                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /api/concrete/specimen-sets/:setId/receiving`             | `inventory.read`                                                                |
| `GET /api/concrete/field-reports/:reportId/receiving`          | `inventory.read`                                                                |
| `GET /api/concrete/projects/:projectId/receiving-exceptions`   | `inventory.read`                                                                |
| `POST /api/concrete/specimen-sets/:setId/pickup`               | `concrete_specimen.receive`                                                     |
| `PUT /api/concrete/specimen-sets/:setId/pickup-window`         | `concrete_specimen.receive`                                                     |
| `POST /api/concrete/specimens/:specimenId/receipt`             | `concrete_specimen.receive`                                                     |
| `POST /api/concrete/specimens/:specimenId/mass-correction`     | `concrete_specimen.mass_correct`, personal account                              |
| `POST /api/concrete/specimen-sets/:setId/marker-confirmation`  | `concrete_specimen.receive`                                                     |
| `POST /api/concrete/projects/:projectId/receiving-exceptions`  | `concrete_specimen.receive`                                                     |
| `POST /api/concrete/receiving-exceptions/:exceptionId/resolve` | `concrete_receiving_exception.resolve` on the record's project (in the handler) |
| `POST /api/concrete/specimens/:specimenId/curing-resolution`   | `concrete.review` on the specimen's project (in the handler)                    |

- **Lab staff** (C36): pickup, the Pick up window, receipt and mass entry, marker confirmation
  and recording missing / extra / unmatched specimens need `concrete_specimen.receive` (Lab
  Technician, Lab Manager, or LAB). A plain internal user is refused (403, nothing changed). The
  route guard checks it, then the handler again with the account as it stands under the locks.
- **Actual person vs account.** Every record keeps the actual person (collector, receiver,
  confirming or reporting person) and the signed-in account that recorded it. A personal account
  is the person unless it names the actual one (the screen's autofill, corrected); a LAB station
  must name them (400 `required`). The person must be an active staff member with confirmed
  initials (422) and is attribution only: LAB never gains their roles. Audit: the account is the
  actor and, on LAB, the person the receiver.
- **Mass correction** (CD-46): any lab staff on a **personal account** (LAB: 403
  `personal_account_required`), reason required, the receipt's `version` (409
  `version_conflict`). History is append-only; the database changes a receipt's mass only with a
  correction row in the same transaction.
- **Exception resolution** (C10 `concrete_receiving_exception.resolve`, CD-34): the project's
  lead, a designated `concrete_field` reviewer, a Lab Manager holding the project's concrete grant,
  or the **casting technician for specimens they cast** (the record's set and, for a match, the
  matched specimen's set must both be theirs). Personal accounts only; disposition and reason
  required; the source is recorded. Checked before the body (an unknown record is 403 unless the
  caller could hold this authority somewhere) and again under the locks. LAB is refused whoever it
  names.
- **Curing flag resolution** (CD-32 issuance gate): `concrete.review` with the `concrete_field`
  reviewers, i.e. the lead or a designated reviewer, on a personal account, with a note. A Lab
  Manager, Lab Technician or LAB is refused.
- **Retries:** every write takes an `idempotencyKey` (409 `idempotency_key_reused` for another
  request); per-record `version`s give 409 `version_conflict` with the current view.

## Concrete lab worklist and rescheduling (MM-V2-C22)

Contracts: `packages/shared/src/concrete-worklist.ts`; table: migration 0022
([concrete.md](concrete.md#daily-lab-worklist-and-rescheduling-c22)).

| Route                                                      | Policy                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/concrete/lab-worklist`                           | `inventory.read`                                         |
| `GET /api/concrete/specimens/:specimenId/schedule-history` | `inventory.read`                                         |
| `POST /api/concrete/specimens/:specimenId/reschedule`      | `concrete_specimen.reschedule` on the specimen's project |

- **Read.** The worklist uses the internal read every concrete read uses (`inventory.read`:
  every active internal user, LAB included). No new role or permission. The owner defined "lab
  staff" on 2026-11-08 as the Lab Technician role, the Lab Manager role, or the LAB account naming
  a person. C36 builds that definition. The worklist read stays on `inventory.read`.
- **Reschedule.** C10's `concrete_specimen.reschedule`: the project's Lead Project Engineer, a
  designated reviewer for `concrete_field` (the scope C05's casting correction uses) or a Lab
  Manager with the project's concrete grant (confirmed by the owner, 2026-11-08); personal accounts only (LAB is refused whoever is selected); reason
  required. Checked on the specimen's project before the body and before any lock (an unknown
  specimen is 403 unless the caller could hold the permission somewhere, then 404), then again
  under the D09 locks: the report FOR UPDATE, the set FOR UPDATE, the specimen FOR UPDATE, then
  the project and the actor's account FOR SHARE (`canUnderLock`). Retries: `idempotencyKey` (409
  `idempotency_key_reused`) and `version` (409 `version_conflict` with the current schedule).
  Only a numbered set is rescheduled: unnumbered on a draft is 409 `edit_on_draft`, unnumbered
  past draft is 409 `set_not_numbered` ("Number this set first", owner decision 2026-11-09, C38).
- **Capabilities.** `concrete_specimen.reschedule` is in `PROJECT_CAPABILITY_ACTIONS` ("Reschedule
  concrete specimen tests"). `concreteRescheduleContext()` loads the lead, the live
  `concrete_field` reviewers and the concrete-grant holders for it, so Team & Permissions and
  `GET /api/projects/:id/capabilities` report it correctly; each worklist group's `canReschedule`
  uses the same check.

## Concrete report lifecycle (MM-V2-C09)

Field-report versions and the submit / recall / return / resubmit / review / issue / revise
commands. Contracts: `packages/shared/src/concrete-report-lifecycle.ts`; tables: migration 0021
([concrete.md](concrete.md#report-versions-and-lifecycle-c09)). Field reports only: strength
reports wait for owner decision G2.

| Route                                                                                       | Policy                                                                                    |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/concrete/field-reports/:id/versions`                                              | `inventory.read` (every active session, LAB included)                                     |
| `GET /api/concrete/field-reports/:id/versions/:versionNo`                                   | `inventory.read` (the version's frozen snapshot)                                          |
| `POST …/:id/submit {version, idempotencyKey, technicianUserId?}`                            | `concrete_report.draft`, the report's own technician (LAB names them)                     |
| `POST …/:id/resubmit {version, idempotencyKey, technicianUserId?}`                          | `concrete_report.draft`, as submit; routed (below)                                        |
| `POST …/:id/recall {version, idempotencyKey, comment?}`                                     | active user; handler checks `concrete_report.recall` (the report's technician)            |
| `POST …/:id/return {version, idempotencyKey, comment}`                                      | active user; handler checks `concrete.review` (lead or designated reviewer) + routing     |
| `POST …/:id/review {version, idempotencyKey, comment?}`                                     | active user; handler checks `concrete.review` + routing                                   |
| `POST …/:id/issue {version, idempotencyKey, comment?, includeMachineInfo?, includePhotos?}` | active user; handler checks `report.issue` (lead or issuer grant, scope `concrete_field`) |
| `POST …/:id/revise {version, idempotencyKey, comment}`                                      | active user; `concrete.review` (lead or designated reviewer), or the version's issuer     |

- **Order of checks (D09).** 401/403 from the guard; then, against the report as it stands and
  before the body or any lock, the action's permission (403 `forbidden`; a personal account
  submitting someone else's report 403 `not_own_report`; the report's own technician reviewing or
  issuing it 403 `own_report`). An unknown report is 404 for submit and
  resubmit, and for anyone with review, issue or technician standing somewhere; otherwise 403 like
  a real report. Then 400 body, then one transaction: report FOR UPDATE, its latest version FOR
  UPDATE, project and account FOR SHARE (`canUnderLock`, the permission again), the performing
  person (LAB) FOR SHARE; 409 `idempotency_key_reused`, 409 `version_conflict` (with the current
  report; also when the optional `reportVersionNo` on recall, return, review, issue or revise is
  not the latest version, review fix #139), 422 `invalid_transition`, 403 `routed_to_another_reviewer`, 422 `incomplete_for_review`
  (C04's final-review field list), 422 `no_lead_project_engineer`.
- **LAB** may submit and resubmit, naming the performing staff member (the report's technician),
  audited as receiver. LAB never recalls, returns, reviews, issues or revises, whoever a station
  selects (AC5).
- **Routing (D11).** A first submission, one after a recall and a revision go to the project's
  designated reviewers (MISC-08 `designatedReviewers()`, scope `concrete_field`) and its lead. A
  resubmission after a return goes to the reviewer who returned it. A correction saved by a person
  holding the Lab Manager role (recorded on save while the report is returned) goes to the
  project's Lead Project Engineer instead (AC2). If the original reviewer can no longer review
  (inactive, no longer designated), the lead takes it (owner decision 2026-11-08). A routed version
  is reviewed or returned only by the person it is routed to or the lead; anyone else 403
  `routed_to_another_reviewer`. Routing never targets the report's technician: if the lead is the
  technician, the designated reviewers take it.
- **Owner decisions 2026-11-08.**
  - **No self-review.** Nobody reviews or issues a report they are the technician of, even as a
    designated reviewer or the project's lead (403 `own_report`, nothing written). Another
    designated reviewer or the lead reviews it; the lead or another issuer issues it.
  - **Revision after issue:** the project's lead, a designated `concrete_field` reviewer, or the
    person who issued the version being corrected (while their personal account is active), with
    a required reason. An issuer grant alone does not allow it.
  - **Original reviewer unavailable at resubmit:** the lead takes it (above).
  - **Returned reports are edited only by their technician** (as drafts, CD-58); a Lab Manager
    can't edit someone else's. D11 Lab Manager routing applies when the Lab Manager is the
    report's technician.
- **Review source / issue source** are recorded from the policy source (`lead_project_engineer`
  vs `designated_reviewer`; `lead_project_engineer` vs `report_issuer`).
- **Capabilities.** `concrete.review` and `report.issue` are in `PROJECT_CAPABILITY_ACTIONS`,
  checked with the `concrete_field` reviewers and issuers. Recall depends on the record's
  technician, so each report's `lifecycle.allowedActions` lists the commands the caller may send
  now (state, permission, own report and routing; the server checks again).
- **Not here:** submission checks that later cards own (ticket attachment acknowledged C15,
  specimens received with masses C06 / C20, project matched C17) are not yet applied.

## Concrete review queue and exceptions (MM-V2-C28)

The review queue, documenting a submitted version's exceptions, the Mark reviewed rule and the
issue options. Contracts: `packages/shared/src/concrete-review.ts`; table: migration 0025
([concrete.md](concrete.md#review-queue-and-issuance-c28)). Field reports only (G2).

| Route                                                                                                                                                              | Policy                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `GET /api/concrete/review-queue?status=&projectId=&technicianUserId=&reportType=&submittedFrom=&submittedTo=&exceptions=&mine=&search=&sort=&dir=&page=&pageSize=` | `inventory.read` (every active session, LAB included)                                    |
| `GET /api/concrete/field-reports/:id/versions/:versionNo/exception-notes`                                                                                          | `inventory.read`                                                                         |
| `POST /api/concrete/field-reports/:id/versions/:versionNo/exception-notes {code, field, note}`                                                                     | active user; handler checks `concrete.review` + C09 routing, not the report's technician |

- **Queue.** Visible to every `inventory.read` session (confirmed by the owner, 2026-11-09). Statuses: Awaiting review (submitted), Returned for correction, Reviewed awaiting
  issuance, Issued; `counts` per status with the same filters. Each row's `canAct` says whether
  the caller could take its next step now: review (`concrete.review` + routing) or issue
  (`report.issue`), never on their own report (owner decision 2026-11-08); for a returned report,
  its technician (only the technician corrects a returned report). `mine=true` lists only those.
  Lists never grant anything; every command checks again.
- **Exception notes.** Order of checks (D09): report 404; `concrete.review` 403 `forbidden`; the
  report's own technician 403 `own_report`; 400 body; then one transaction: report FOR UPDATE, its
  latest version FOR UPDATE, `canUnderLock`, 403 `routed_to_another_reviewer`, 404 unknown version,
  422 `version_not_awaiting_review` (only the latest version while submitted), 422
  `unknown_exception` (code and field must be on the version as submitted), 409
  `exception_already_documented` (a different note; the same note again is answered as it stands).
  Audit `concrete_field_report.exception_documented`.
- **Mark reviewed (C09 `review`)** adds 422 `exceptions_unresolved` (one error per open exception)
  after the routing check: every exception on the version must be documented, or no longer raised
  by the live report (e.g. the other report with the same ticket was corrected). Same rule as the
  screen (`concreteReviewChecklist`). **Confirmed by the owner (2026-11-09):** every C04/C05/C27
  warning is required; the deferred checks are shown as not yet checked.
- **Issue** takes an optional `includeMachineInfo` (owner decision 2026-11-09, C38): omitted, the
  project's concrete setting applies (read under the issue transaction), false when unset; the
  issuer may override it either way, and the screen pre-fills the setting (Omit when unset). It
  accepts only `includePhotos: false` until photos exist (C15). The resolved values are stored on
  the issued version and audited.
- **Self-review** is refused by C09 (403 `own_report`, #135); the screens disable those actions
  with that reason, and the queue never marks one's own report as needing one's action.

## Concrete dashboard, Lab workspace and search (MM-V2-C31)

Read-only lists for the Concrete dashboard, the Concrete Lab workspace and search. Contracts:
`packages/shared/src/concrete-lab.ts`; search indexes: migration 0030
([concrete.md](concrete.md#dashboard-lab-workspace-and-search-c31)).

| Route                                                                                                    | Policy                                                |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /api/concrete/receiving-queue?stage=awaiting_pickup\|awaiting_receiving&projectId=&page=&pageSize=` | `inventory.read` (every active session, LAB included) |
| `GET /api/concrete/search?q=&page=&pageSize=`                                                            | `inventory.read`                                      |
| `GET /api/concrete/lab-worklist?view=hold&holdDue=true` (C22's route, one more filter)                   | `inventory.read`                                      |

- Like every concrete read, these cover every project; they grant nothing and say nothing about
  who may act. Pickup, receipt and every other command check their own permission (C06).
- **Navigation never grants permission.** The Concrete Lab menu group (Concrete home, Specimen
  receiving, Break worklist, Specimen lookup, Concrete equipment) is shown to lab staff — the
  Lab Technician role, Lab Managers and the shared LAB account (C36); everyone else gets one
  Concrete link. A link a session can open does not mean it may act there.
- **Lab search** (top bar) shows for sessions with `inventory.read` and calls each area's own
  search: storage units (`GET /api/inventory?search=`), projects (`GET /api/projects/search`) and
  Concrete search. It adds no new read.

## Concrete test-result drafts (MM-V2-C07)

Test-result drafts with tester attribution and correction history. Contracts:
`packages/shared/src/concrete-test-results.ts`; tables: migration 0027
([concrete.md](concrete.md#test-result-drafts-and-correction-history-c07)).

| Route                                                                | Policy                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/concrete/specimens/:specimenId/test-results`               | `inventory.read` (every active session, LAB included)                       |
| `GET /api/concrete/specimens/:specimenId/test-results/:resultId`     | `inventory.read`                                                            |
| `PUT /api/concrete/specimens/:specimenId/test-results/:resultId {…}` | `concrete_test.enter` (Lab Technician, Lab Manager, LAB); re-checked locked |

- **Global, not project-scoped.** `concrete_test.enter` is a lab-staff role permission (C36), so
  the route guard refuses everyone else (403) before the body is read; the endpoint sweep covers
  all three routes. The handler checks it again under the account lock (a role removed first is
  honoured).
- **LAB** must send `enteredByUserId` (400 `required`; 422 `entered_by_invalid` unless an active
  staff member with confirmed initials). That person is credited on the revision; LAB never gains
  their roles. A personal account is always the person entering it (400 `not_allowed` for anyone
  else). The named person is not required to hold a lab role (as for C36's other lab-staff rows).
- **Tester** (`testerUserId`) is a recorded value, not authority: any active staff member with
  confirmed initials, never LAB (422 `tester_invalid`); a new attempt defaults to the person
  entering it.
- **Order of checks:** specimen 404; attempt ID 404 when not an ID; 400 body; then one transaction:
  report, set, specimen and attempt FOR UPDATE (D09), exact-retry replay, account lock and
  permission, `enteredByUserId`, 409 `result_id_taken`, 409 `version_conflict`, 409
  `report_void` / `set_void`, 422 `tester_invalid`, 422 `reason_required` (a saved value changed
  or cleared without a reason). Audit `concrete_test_result.saved` / `.corrected`.

## Concrete testing table (MM-V2-C23)

| Route                                                                         | Policy                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /api/concrete/testing-table?includeOverdue=&on=&projectId=&specimenIds=` | `inventory.read` (every active session, LAB included) |

- Read only; entry is C07's PUT above (`concrete_test.enter`). The page shows the cells read-only
  without that permission; the server decides either way. Swept by the endpoint sweep.
- C22's reschedule gains 409 `tested_specimen` (a complete entry exists), after its other checks.

## Concrete strength reports (MM-V2-C39)

| Route                                                                                                                    | Policy                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `GET /api/concrete/strength-reports?projectId=&needsLab=&state=`                                                         | `inventory.read`                                                                        |
| `GET /api/concrete/specimen-sets/:setId/strength-report` (+ `/versions`, `/versions/:n`, `/versions/:n/exception-notes`) | `inventory.read`                                                                        |
| `POST …/strength-report/submit`, `/resubmit`, `/recall`                                                                  | `concrete_test.enter` at the guard (Lab Technician, Lab Manager, LAB naming the person) |
| `POST …/strength-report/return`, `/review`                                                                               | active user; service: `concrete.review` (scope `concrete_strength`) + C09 routing       |
| `POST …/strength-report/issue`                                                                                           | active user; service: `report.issue` (scope `concrete_strength`)                        |
| `POST …/strength-report/revise`                                                                                          | active user; service: `concrete.review` (strength) or the version's issuer              |
| `POST …/strength-report/versions/:n/exception-notes`                                                                     | active user; service: `concrete.review` (strength) + routing                            |

- Checked before the body against the report as it stands, then again under the locks (set FOR
  UPDATE, strength report, latest version, project and accounts FOR SHARE). An unknown set is 404
  for lab actions and for callers with strength review / issue authority somewhere, else 403.
- **No self-review:** the version's sole tester or sole credited entrant gets 403 `own_report` on
  review, return, issue and exception notes, whatever else they hold (owner decision 2026-11-08,
  applied to strength reports). Every route is in the security sweep; no new permission, so
  `PROJECT_CAPABILITY_ACTIONS` is unchanged (per-report rights show in `allowedActions`).
- C07's test-result save answers 409 `result_on_strength_report` for a result on a submitted,
  reviewed or issued strength report version.

## Concrete strength calculation (MM-V2-C24)

| Route                                                               | Policy                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /api/concrete/strength-tests?setId=&projectId=&failed=&after=` | `inventory.read`                                                                                              |
| `GET /api/concrete/specimens/:specimenId/strength-exclusion`        | `inventory.read`                                                                                              |
| `PUT /api/concrete/specimens/:specimenId/strength-exclusion`        | active user; service: `concrete.review` (scope `concrete_strength`), never on a result they tested or entered |

- **Proposal (owner to confirm):** exclusion is review work: the project's Lead Project Engineer
  or a designated `concrete_strength` reviewer, as reviewing the strength report. Checked before
  the body against the project as it stands, then again under the locks (field report, set,
  specimen FOR UPDATE; project and account FOR SHARE; then the strength reviewer assignments and
  approvals FOR SHARE, read after them, so an approval ended meanwhile is honoured). An unknown specimen is 404 for callers with
  strength review authority somewhere, else 403. 403 `own_result` when the caller tested or
  entered the specimen's latest result (no self-review). LAB never excludes.
- 409 `result_on_strength_report` while a submitted, reviewed or issued strength report version
  reports the specimen; 409 `already_excluded` / `not_excluded` for a stale request; a reason is
  always required (400). No new permission: `concrete.review` is already a listed project
  capability, so `PROJECT_CAPABILITY_ACTIONS` is unchanged; the route is in the security sweep
  (`ACTIVE_ROUTE_PERMISSION`).
- Calculation needs no permission of its own: C07's save (`concrete_test.enter`) stores it.
  Deliberate recalculation to another method version has no route yet (proposal: Lab Manager).

## Concrete report output (MM-V2-C32)

Issued report files, the project summary report and the report header. Contracts:
`packages/shared/src/concrete-reports.ts`; tables: migration 0031
([concrete.md](concrete.md#report-templates-numbers-and-issued-files-c32)).

| Route                                                                                     | Policy                                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /api/concrete/report-files/:fileId`                                                  | `inventory.read` (every active session, LAB included): the stored bytes, exactly as issued                    |
| `GET /api/concrete/projects/:projectId/summary-reports`                                   | `inventory.read`; `canIssue` is `report.issue` for the caller                                                 |
| `GET /api/concrete/projects/:projectId/summary-reports/preview?from=&to=&element=&mixId=` | `inventory.read`: the unnumbered preview PDF, never stored                                                    |
| `POST /api/concrete/projects/:projectId/summary-reports {idempotencyKey, filters}`        | active user; handler checks `report.issue` on the project (the lead, or an issuer grant for `concrete_field`) |
| `GET /api/concrete/report-header`                                                         | `inventory.read`                                                                                              |
| `PUT /api/concrete/report-header {version, companyName, address, phone}`                  | `concrete_settings.report_header.manage` (admin; proposal, owner to confirm)                                  |

- **Issue a field report (C09 `issue`).** Same checks as before; inside the same transaction it
  takes the template in force (422 `report_template_missing` / `report_template_unsupported` when
  none can be rendered), the report's number (first issue only), then renders and stores the PDF.
- **Summary issue.** Order of checks: 404 unknown project; 403 `forbidden` without `report.issue`
  (before the body); 400 body; then one transaction: replay by key (another body or caller with
  the same key: 409 `idempotency_key_reused`), `canUnderLock` (project FOR SHARE), the number, the
  snapshot, the file. Audit `concrete_summary_report.issued`. No review step: it only restates
  issued results (design section 5).
- **Report header.** 409 `version_conflict` with the current value on a stale `version`. Audit
  `concrete_report_header.changed`.

## Concrete HOLD management and disposal (MM-V2-C26)

HOLD release, bulk HOLD actions and actual disposal of concrete specimens. Contracts:
`packages/shared/src/concrete-holds.ts`; tables: migration 0029
([concrete.md](concrete.md#hold-management-bulk-actions-and-disposal-c26)). Storage-unit
retention and disposal (MM-T29/T30, MISC-13) are unchanged.

| Route                                                        | Policy                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/concrete/holds?kind=&status=&projectId=&on=&page=` | `inventory.read` (every active session, LAB included)                                                        |
| `GET /api/concrete/specimens/:specimenId/hold-history`       | `inventory.read`                                                                                             |
| `GET /api/concrete/disposal/ready?page=`                     | `inventory.read` (the Ready for disposal list's Concrete specimens filter)                                   |
| `POST /api/concrete/holds/schedule-test`                     | active user; per specimen `concrete_ordinary_hold.manage` (ordinary HOLD only)                               |
| `POST /api/concrete/holds/authorize-disposal`                | active user; per specimen `concrete_ordinary_hold.manage` (ordinary) or `concrete_hold.manage` (failed hold) |
| `POST /api/concrete/holds/hold-until` (STRATA-121)           | active user; per specimen `concrete_ordinary_hold.manage` (scheduled specimens onto an ordinary HOLD)        |
| `POST /api/concrete/disposal/record`                         | `concrete_specimen.dispose_record` (lab staff; LAB names the performing person)                              |

- **Who.** Ordinary HOLD release (Schedule test, Authorize disposal): the project's Lead Project
  Engineer or any Lab Manager by role alone (decided 2026-10-30). Failed-specimen hold: the lead,
  or a Lab Manager holding the project's concrete grant (D13); a Lab Manager without it is
  refused (AC2). Record disposal: Lab Technician, Lab Manager, or LAB with the performing staff
  member (attribution only; LAB never gains their roles). Release is personal accounts only.
  **Hold until** (STRATA-121, from Breaks) is the same authority as the ordinary release: the
  lead or any Lab Manager, personal accounts only; the LAB station is refused whoever it names
  (the request has no performer). A failed-specimen hold stays under `concrete_hold.manage` and
  its own workflow (409 `failed_hold`). Its route is in the endpoint sweep; the permission was
  already in the project capability list. The Breaks worklist reports it per project
  (`canHoldUntil`).
- **Order of checks.** Release routes: 403 before the body unless the caller is an active personal
  account that is a Lab Manager or leads some project; 400 body; then one transaction: replay by
  idempotency key, reports, sets, then specimens FOR UPDATE (each in id order, D09), the authority
  per project under `canUnderLock` (403 `forbidden` with `specimens`), eligibility (409
  `not_eligible` with `problems`), then the writes. Record disposal: 400 body (including a
  `disposedAt` in the future), the same locks, the caller's lab-staff standing under lock, the
  performer (`resolveActingPerson`), eligibility, writes.
- **Expiry flags only.** No route, job or read changes anything on a HOLD date (AC3).
- `concrete_ordinary_hold.manage` and `concrete_hold.manage` are in the project capability list
  since MM-V2-C08 (with the concrete grant loaded); the HOLD table also reports each row's actions.

## Concrete foundation integration (MM-V2-C08)

No new route or permission. C08 proves the package 1 rules end to end and closes one gap:

- **Capability list.** `PROJECT_CAPABILITY_ACTIONS` now also lists
  `concrete_receiving_exception.resolve` (C06), `concrete_ordinary_hold.manage` and
  `concrete_hold.manage` (C26), evaluated with the same facts as `concrete_specimen.reschedule`
  (the lead, live `concrete_field` reviewers, concrete-grant Lab Managers). The casting
  technician's own-specimen right to resolve an exception is per record and isn't in the list,
  like recall.
- **Sweep check.** `permission-matrix.security.test.ts` fails if a concrete route is public or
  unswept, if a project-scoped permission a concrete route checks is missing from the capability
  list, or if a listed concrete capability has no route.
- **Scenario.** `concrete-foundation.integration.test.ts` checks every actor type on two projects
  through the capability list and the routes: admin, acceptance delegates and report issuers gain
  no concrete workflow authority (an issuer issues only); A's lead, reviewer and grant Lab Manager
  have none on another project; LAB always names the person and never gains their authority.
  Handoff and open gates: [concrete-package-2-handoff.md](concrete-package-2-handoff.md).

## Receiving Log (MM-T51)

| Route                                                                                            | Policy                                                |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `GET /api/receipts?search=&projectId=&receiverUserId=&receivedFrom=&receivedTo=&page=&pageSize=` | `inventory.read` (every active session, LAB included) |
| `GET /api/receipts/:receiptId`                                                                   | `inventory.read`                                      |
| `GET /api/receipts/receivers?search=` or `?id=`                                                  | `inventory.read`                                      |

- **Read-only.** None of these writes, audits or queues printing. Printing from a receipt uses
  `POST /api/print-jobs` (`label.print`); correcting a unit uses `PATCH /api/storage-units/:id`
  (`storage_unit.correct`, so LAB still can't).
- **Attribution:** the received-by initials and name come from the receipt's snapshots, the
  filter uses the stable `receiver_user_id`, and the confirming account (e.g. LAB) is shown
  separately. Responses carry no idempotency key, request hash, email or session data.
- **Receivers filter** lists only people who have received at least one receipt, including
  people since disabled or renamed (shown by current name; their old name and initials still
  match). It returns the same minimal fields as `GET /api/staff/receivers`.
- Pending users get 403 and disabled or signed-out callers 401, as everywhere; the endpoint
  sweep (`permission-matrix.security.test.ts`) covers all three routes.

## Draft auto-delete setting (MM-T45)

| Route                      | Policy                                                   |
| -------------------------- | -------------------------------------------------------- |
| `GET /api/settings/drafts` | any active session, LAB included (stations need it)      |
| `PUT /api/settings/drafts` | `settings.drafts.manage` (Lab Manager and admin, no LAB) |

- **Setting:** `draftAutoDelete {enabled, afterDays}`; off by default, 30–365 days, default 90
  (outside that range: 400 with a field error on `draftAutoDelete.afterDays`). Optimistic
  `version` (409 `version_conflict` with the current value) and audited as
  `settings.drafts_changed` with before/after and the actor.
- **Settings → Receiving** is shown to people with `settings.drafts.manage`; anyone else who
  opens `/settings/receiving` sees the setting read-only with "Only Lab Managers and
  administrators can change this."
- **The browser deletes, not the server.** Receive samples deletes only drafts this session may
  see (T11: LAB drafts for LAB, personal drafts for their owner), last saved more than
  `afterDays` days ago, never one in the `confirming` state, and only when the setting was loaded
  successfully and is on. This amends the T11 decision that drafts are never deleted
  automatically (owner request 2026-10-26).

## Storage locations (MM-T37)

| Route                                              | Policy                                                |
| -------------------------------------------------- | ----------------------------------------------------- |
| `GET /api/locations?search=&includeRetired=`       | `inventory.read` (every active session, LAB included) |
| `GET /api/locations/:id`                           | `inventory.read`                                      |
| `GET /api/locations/:id/label/preview`             | `inventory.read` (read-only: no job, no code lock)    |
| `GET /api/locations/:id/activity` (shelf page)     | `inventory.read` (moves in and out, last 30 days)     |
| `GET /api/storage-units/:id/lab-programs`          | `lab_program.read` (progress counts only)             |
| `POST /api/locations`                              | `location.manage` (Lab Manager and admin, no LAB)     |
| `PATCH /api/locations/:id`                         | `location.manage`                                     |
| `POST /api/locations/:id/retire {reason, version}` | `location.manage`                                     |
| `POST /api/locations/:id/labels`                   | `label.print` (unchanged label-print permission)      |
| `GET /api/scan/resolve?payload=`                   | `inventory.read`                                      |

- **Who manages** (Kyle, 2026-10-26): admins and Lab Managers add, edit and retire locations.
  Everyone else, LAB included, reads them and resolves scans. A LAB station never manages
  locations, whoever is selected there: `receiverUserId` is attribution for printing only.
- **Codes** are 2–20 letters, digits or hyphens, stored trimmed and upper case, unique ignoring
  case (409 `location_code_exists`: "A location with code WH-C1 already exists."). Edits are
  optimistic (`version`; a stale one gets 409 `version_conflict` with the current location).
- **Receiving lab** is the system location receipt confirmation uses (D03): its display name can
  change; its code, kind and area can't (422 `system_location`), and it can't be retired (422).
- **Retiring** needs a reason. A location that still holds units (saved there and not disposed,
  the Inventory "Current stock" filter) can't retire: 409 `location_occupied` with
  `inStockCount`. A retired location stays on every record that names it, still resolves when
  scanned (with `active: false`), can't be edited or printed, and the database refuses to place
  a unit there. Locations are never deleted.
- **Label payload** (owner approval 2026-10-25): both symbols carry exactly `LOC-<CODE>`, e.g.
  `LOC-WH-C1`; never a URL or storage-unit data. The scan resolver answers
  `{type: "location"}`, `{type: "storage_unit"}` or `{type: "unknown", reason}`.
- **Code lock:** the first label request locks the code in the same transaction that queues the
  job, under the location's row lock. After that the code (and so the payload) never changes;
  the name still can. Edits take the same row lock, so an edit racing the first request either
  commits first (the label carries the new code) or finds the code locked (422
  `location_code_locked`).
- **Printing** uses the same queue and worker as storage-unit stickers (no stand-in units or
  receipts). A LAB station must choose the staff member printing (400 `receiver_required`): a
  location has no receipt receiver to fall back on. "Sent to printer" is not a physical print:
  only a person's "Labels came out OK"/"Mark as printed" sets the location's `label_printed_at`
  and records `location.label_printed`.
- **Audit events:** `location.created`, `location.updated` (changed fields before/after),
  `location.retired` (reason), `location.label_printed` (at physical confirmation), plus the
  print queue's `label.*` events with `target: "location"`.

## Storage moves (MM-T28)

LAB records moves (`storage_unit.move`, owner decision 2026-10-25) and must name the staff member
moving the units ("Moved by"); that person is attribution only. Only an active personal (or test)
account confirms a conflicted unit's actual location (`location_conflict.resolve`, D29); LAB is
refused even when a Lab Manager is selected at the station. A queued move is only ever sent by the
account that scanned it (`captureContext.accountId` must equal the session's account).

**Undo (STRATA-123).** `GET /api/undo/:action/:sourceId` and `POST /api/undo` are `@ActiveUser()`
(pending and disabled refused at the guard); the handler checks `storage_unit.move` again inside
its transaction (GET uses the same, so it never offers what POST refuses). A move is undone only
by the account that saved it, and on a LAB station only for the same picked person
(`moverUserId`, attribution only, who must still be active staff); within 15 minutes; only while
the unit is exactly as the move left it, not disposed, approved for disposal or in an open
location conflict, and the previous location is not retired. Another person's move or an unknown
ID answers `not_found`. A notification's dismissal is undone by its recipient only (LAB has none),
as the existing restore. Never undoable: receipt confirmation and issued IDs, disposals, reports,
destructive tests and approval revocation (the action enum refuses them with 400).

## Lab test catalogue and testing programs (MM-T23)

| Route                                                              | Policy                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| `GET /api/test-catalogue`, `GET /api/test-types`                   | `lab_program.read` (every active session, LAB too)    |
| `GET /api/test-templates`                                          | `lab_program.read`                                    |
| `POST/PATCH /api/test-types`, `POST /api/test-types/:id/retire`    | `test_catalog.manage` (Lab Manager and admin, no LAB) |
| `POST /api/test-types/:id/restore`, groups, subgroups, templates   | `test_catalog.manage`                                 |
| `GET /api/lab-programs`, `GET /api/lab-programs/:id(/review)`      | `lab_program.read`                                    |
| `GET /api/lab-programs/:id/sample-tags` (MM-T69, read-only)        | `lab_program.read`; 409 `program_not_submitted` draft |
| `GET /api/projects/:projectId/lab-sources(/:kind/:sourceId/units)` | `lab_program.read`                                    |
| `POST /api/lab-programs`, `PATCH /api/lab-programs/:id`            | `lab_program.manage` (+ Requested by for LAB, below)  |
| `POST /api/lab-programs/:id/submit`, `…/discard`                   | `lab_program.manage` (+ Requested by for LAB)         |

- **Shared LAB stations** (Kyle, 2026-10-27): LAB creates, edits, submits and discards programs,
  but every such request must carry `requestedByUserId`: an active staff member (not LAB) with
  confirmed initials, checked on every request (400 `required` when missing, 422
  `requested_by_invalid` otherwise). Submission must name the person the draft is requested by
  (422 `requested_by_mismatch`). The person is attribution only: LAB never gains their roles, so
  catalogue/template administration, priority, review, acceptance and closure stay refused. Audit
  events record LAB as the actor and the person as the receiver ("LAB for person"); no session
  data is stored.
- **Personal accounts** are always their own requester; naming someone else is refused (400).
- **Drafts** are visible and workable only by the account that created them (LAB's drafts from
  any LAB station). Each draft is its own row with its own `version`; there is no account-wide
  "current draft" or operator. Submitted programs are visible to everyone with `lab_program.read`.
- **Concurrency:** edits and submission are optimistic (409 `version_conflict` with `current`);
  submission is idempotent on `idempotencyKey` (an exact retry returns the original program; a
  different key on a submitted program gets 409 `not_draft`). Creation is idempotent too.

## Lab worklist, progress, priority and comments (MM-T24)

| Route                                                       | Policy                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/worklist?priority=&projectId=&open=&testTypeId=`  | `lab_program.read`                                      |
| `GET /api/lab-programs/:id/work`                            | `lab_program.read`                                      |
| `GET /api/lab-programs/:id/units` (STRATA-87, read-only)    | `lab_program.read`; 404 for drafts                      |
| `GET /api/worklist/units-to-pull` (Field Ledger, read-only) | `lab_program.read`                                      |
| `POST /api/test-requests/:id/status`                        | `test.progress` (LAB too, with `actingStaffUserId`)     |
| `PATCH /api/lab-programs/:id/priority`                      | active user; handler checks `program.priority.set`      |
| `POST /api/lab-programs/:id/comments`                       | `lab_comment.write` (LAB too, with `actingStaffUserId`) |
| `PATCH /api/comments/:id`                                   | `lab_comment.write`; only the author, within 15 minutes |

- **Shared LAB stations** (Kyle, 2026-10-27): LAB may Start, Mark completed and Send to review,
  and add or edit its comments, naming "Who is doing this?" on every request (an active staff
  member with confirmed initials, checked each time). History shows "LAB for person". LAB never
  changes priority, never accepts or reviews (a jump to `accepted` is 403 for LAB, 422 for a
  personal account), never closes programs and never removes tested units, whoever it selects.
- **Priority** (D50): only the project's Lead Project Engineer or a Lab Manager (403 otherwise, checked before
  the body is validated). Every change is kept in `program_priority_history` with old, new,
  person and time; it never changes a test status.
- **Transitions:** one table (`STATUS_TRANSITIONS` in `@materialmule/shared`): Requested → In
  progress → Completed → Awaiting review. Order of checks: authority (403), version (409
  `version_conflict` with the current status), transition (422 `invalid_transition`). Draft and
  closed programs aren't workable (422 `program_not_open`).
- **Exact tested units:** completing a test whose frozen coverage includes a Shelby tube or a
  bulk-sample bucket needs `testedStorageUnitIds` (422 `tested_units_required`; an empty list says
  none of them was used). Each unit must be in that line's coverage, in the program's project and
  not disposed (422 `unit_not_covered` / `unit_disposed`). Completion changes no unit; physical
  removal is MM-T36's separate personal-account action (see "Tested-unit removal").
- **Comments:** nonblank, the author only (for LAB, the same selected person), within 15 minutes
  of posting on the server clock (409 `edit_window_closed`); edits never restart the window and
  every text is kept. There is no delete.
- **Retries:** every action carries `idempotencyKey`; an exact retry returns the original result
  with no new history, and the same key with a different intent is 409 `idempotency_key_reused`.

## Review corrections and delegated acceptance (MM-T25)

| Route                                                      | Policy                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| `POST /api/test-requests/:id/review`                       | `test.review` (personal accounts; `complete` or `return`)  |
| `POST /api/test-requests/:id/correction-done`              | `test.correction_done` (Lab Manager role only)             |
| `POST /api/test-requests/:id/accept`                       | active user; handler checks `test.accept` for the project  |
| `GET /api/projects/:projectId/acceptance-delegates`        | `acceptance_delegation.read` (personal accounts)           |
| `POST /api/projects/:projectId/acceptance-delegates`       | active user; handler checks `acceptance_delegation.manage` |
| `DELETE /api/projects/:projectId/acceptance-delegates/:id` | active user; handler checks `acceptance_delegation.manage` |

Grant body `{delegateUserId, reason, idempotencyKey}`; revoke body `{reason}` (D15, MM-AO03).

- **LAB:** 403 on every route above, whoever the station selects. LAB still sends tests to review
  under MM-T24; the person it names is attribution only.
- **Acceptance** (D04): the project's Lead Project Engineer, or a person with an active delegation for that
  project. The Lab Manager and admin roles alone never accept. Delegation grants acceptance only:
  never closure (D06), priority (D50), cancellation or delegation management.
- **Corrections:** only the Lab Manager role marks a returned correction done (not Lead Project Engineer, admin
  or a delegate through those roles). A fresh review is always needed before acceptance.
- **Delegation:** only the project's Lead Project Engineer grants and revokes, each with a reason, for active
  staff other than themselves (422 `invalid_delegate`, `already_delegated`). Revocation takes effect at once;
  acceptances made before it keep their delegate attribution. History is kept.
- **Order of checks:** authority (403), body (400), not found (404), retry key (an exact retry
  returns the saved result; otherwise 409 `idempotency_key_reused`), `program_not_open` (422),
  version (409), transition (422 `invalid_transition` / `review_not_complete`), then 409
  `correction_superseded`. Details:
  [lab-review-lifecycle.md](lab-review-lifecycle.md).

## Program lifecycle, cancellation and repeats (MM-T26)

| Route                                        | Policy                                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/lab-programs/:id/close`           | active user; handler checks the requester (personal submitting account), `program.close` (Lead Project Engineer) or the Lab Manager role (STRATA-87) |
| `POST /api/lab-programs/:id/reopen`          | active user; handler checks `program.reopen` (Lead Project Engineer or LM)                                                                           |
| `POST /api/lab-programs/:id/close-request`   | `program.close_request` (personal accounts)                                                                                                          |
| `POST /api/test-requests/:id/cancel`         | active user; handler checks `test.cancel` (Lead Project Engineer or LM)                                                                              |
| `POST /api/test-requests/:id/cancel-request` | `test.cancel_request` (personal accounts)                                                                                                            |
| `POST /api/test-requests/:id/repeat`         | `lab_program.amend` (personal accounts)                                                                                                              |
| `PATCH /api/test-requests/:id`               | `lab_program.amend` (accepted-request change, D09)                                                                                                   |
| `GET /api/lab-programs/:id/later-receipts`   | `lab_program.amend`                                                                                                                                  |
| `POST /api/lab-programs/:id/amend`           | `lab_program.amend` (amendment, D02)                                                                                                                 |

- **LAB:** 403 on every route above, whoever the station selects. Its T23/T24 allow-list
  (create/submit, progress, comments) never covers amendments, repeats, cancellation, closure,
  reopening or their requests.
- **Close** (D06): only the project's Lead Project Engineer, never a delegate, Lab Manager or admin alone. Needs at
  least one test request and every request Accepted or Cancelled with a reason (422
  `empty_program` / `closure_blocked` with the blockers). Closing never changes a storage unit,
  retention, hold or disposal.
- **Reopen and cancel** (D07): the project's Lead Project Engineer or a Lab Manager, with a nonblank reason.
  Others ask instead (`cancel-request`, `close-request`), which creates an action item for the
  people who decide; the test or program is unchanged until they act.
- **Order of checks:** authority (403), not found (404), retry key (409), `program_not_open` (422),
  version (409), transition or closure rule (422). A cancellation request checks the transition
  (422) before `already_requested` (409). Details:
  [lab-review-lifecycle.md](lab-review-lifecycle.md).

## Tested-unit removal (MM-T36)

| Route                                        | Policy                                                       |
| -------------------------------------------- | ------------------------------------------------------------ |
| `POST /api/storage-units/:id/tested-removal` | `storage_unit.tested_removal` (personal accounts; never LAB) |

- **Who:** any active personal account confirms that a tested Shelby tube or tested bulk soil
  bucket has physically left the lab. LAB is refused (403) before the body is read, whoever its
  station would select, and a selected person never lends their roles. No Lead Project Engineer or Lab Manager
  disposal approval is needed.
- **Evidence:** the request names `testRequestId`, a completed test that linked this exact unit
  (MM-T24 `test_request_unit_link`, request not cancelled, same project). A shared hole, source,
  bulk group, receipt, coverage or a sibling's test is never evidence (422 `no_tested_evidence`).
  `confirmPhysicalRemoval: true` is required: completion alone never removes a unit.
- **Which units:** Shelby tubes (`tested_shelby`) and buckets holding a bulk soil sample
  (`tested_bulk`). Ordinary buckets: 422 `not_eligible_unit_type`. A unit disposed some other way:
  422 `storage_unit_disposed`.
- **Exception:** no retention wait, extension or hold, disposal approval, disposal scan or
  program closure is checked; review and acceptance may stay open. Removal changes no test
  request, review, acceptance or program.
- **Checks in order:** permission (403), unit (404), retry key (exact retry 200 `replayed`;
  different intent 409 `idempotency_key_reused`), already removed (409 `already_removed` with the
  recorded removal), unit type and status (422), version (409 `version_conflict`), evidence (422),
  open location conflict (409 `location_conflict_open`: confirm the location first).
- **Further testing:** a Shelby tube's contents are used up by its first completed test (shown
  "Disposed after testing" while the tube itself stays tracked until its removal is confirmed). New
  programs no longer cover it, and another program can't link it as tested (422
  `unit_contents_destroyed`); tests of the same program may still record it. A disposed unit is
  never covered or linked.

## Action requests (MM-T27)

| Route                                        | Policy                                                               |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/action-items?status=&scope=`       | `action_item.read`; `scope=all` and `scope=unresolved` need reassign |
| `GET /api/action-items/count`                | `action_item.read`                                                   |
| `GET /api/action-items/:id/assignees`        | `action_item.reassign`                                               |
| `POST /api/action-items/:id/reassign`        | `action_item.reassign`                                               |
| `GET`/`PUT /api/me/notification-preferences` | `action_item.read` (own preferences only)                            |

- **Routing** (`action_item_routed_to` in the database, never who a LAB station selects):
  correction → every Lab Manager; cancellation request → every Lab Manager and the project's
  current Lead Project Engineer; closure request → the project's current Lead Project Engineer; retention request → every Lab
  Manager and the project's current Lead Project Engineer; lead appointment → every admin. A
  reassigned item goes to its assignee only, while they are still eligible. Routing is by kind
  only: a requester sees their own request if they are also a recipient.
- **Resolution** happens only through the real workflow action (mark correction done, cancel the
  test, close the program), which checks its own permission; the inbox has no resolve or approve
  route. The first valid action resolves the shared item for everyone ("Resolved by LM").
- **Reassignment:** Lab Manager or admin, with a reason, to a person who can act on that item
  (Lab Managers for corrections; Lab Managers and the project's Lead Project Engineer for cancellation requests;
  the project's Lead Project Engineer for closure requests). A person can't pass on an item that is personally
  theirs (its assignee, or the Lead Project Engineer of a closure request): 403 `recipient_cannot_reassign`.
  Append-only `action_item_assignment` plus an `action_item.reassigned` audit event.
- **LAB:** 403 on every route above, whoever its station selects. LAB has no inbox, count,
  preferences or reassignment, and selecting a Lead Project Engineer or Lab Manager for lab work lends none.
- **Email:** off by default; people opt in under Settings → My profile. Creating or reassigning
  an item writes at most one `email_outbox` row per opted-in recipient. `EMAIL_ENABLED` must stay
  false (startup refuses true) until IT approves the sending configuration: rows wait unsent, and
  development and tests never send email. Routine moves, receipts, comments and test progress
  create no action item and no email.
- **Following eligibility (D10, MM-AO07; Kyle 2026-10-29, Option C).** An open item assigned to
  someone who can no longer act on it (they lost the role, were disabled, or stopped being the
  project's Lead Project Engineer) is no longer theirs: it goes back to its ordinary routing at
  once (`action_item_person_eligible`, `0004_action_item_rerouting.sql`), shown as "Assignment
  lapsed" with "<name> can no longer act on it". Nothing is rewritten; the assignment row stays
  in the history. Losing a role (`PUT /api/staff/:id/roles`), being disabled
  (`POST /api/staff/:id/disable`), and a change, removal or confirmation of a project's lead write
  one `action_item.assignment_lapsed` audit event per lapsed assignment (with the cause), and
  email the people the item now goes to (opted in only; at most one row per person per item). The
  email worker still rechecks routing when sending, so a lapsed assignee is never mailed.
- **Unresolved queue (D10).** `scope=unresolved` (Lab Manager or admin) lists open items nobody can
  act on now (`action_item_has_recipient` is false): for example a closure request on a project
  waiting for a lead (D02), which waits until an admin appoints one, or a correction when nobody
  holds the Lab Manager role. Each item says so ("Nobody can act on this now"). Lab Managers and
  admins reassign from it with a reason, to an eligible person only; the recipient restriction is
  unchanged. Routing and the queue grant nothing: every decision rechecks its own permission.

## Notifications (MM-T91)

| Route                                           | Policy                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/notifications?filter=&cursor=&limit=` | `notification.read`; own rows only; `active` (default), `unread` or `all`; paged |
| `GET /api/notifications/count`                  | `notification.read`                                                              |
| `POST /api/notifications/:id/read`              | `notification.read`; own notifications only                                      |
| `POST /api/notifications/:id/dismiss`           | `notification.read`; own notifications only                                      |
| `POST /api/notifications/:id/restore`           | `notification.read`; own notifications only                                      |
| `POST /api/notifications/read-all`              | `notification.read`                                                              |

- **Separate from action requests.** A notification tells someone something happened; an action
  request is work they must do. Reading, dismissing or restoring a notification never resolves,
  approves or changes an action request, its routing or the audit log. The two counts are
  separate (`GET /api/action-items/count` is the pending count; `GET /api/notifications/count`
  the unread count).
- **What creates one** (owner decisions, Kyle 2026-10-31): an action request now waiting on you
  (created, reassigned to you or rerouted to you by D10), once per item per person; and a
  decision notice when someone else resolves a cancellation, closure, retention or team join
  request you raised, or marks done a correction you returned. No routine-event notifications,
  none for lead appointments or grant reviews, none for your own resolution. Independent of the
  email preference and of `EMAIL_ENABLED`.
- **Own rows only.** Every route works on the signed-in person's notifications; another person's
  id, a missing one or a malformed one is 404 `notification_not_found`. The mutations are
  idempotent and return `{ unread }`. Dismiss hides a row (and marks it read); restore undoes it;
  nothing is deleted. The list and count cover the last 90 days (at most 200 rows, newest
  first). Following a notification's link grants nothing: the target page checks.
- **LAB:** 403 on every route above, whoever its station selects. LAB never receives
  notifications (the database refuses them).

## Personal settings, pins and recents (Strata 1C)

| Route                                  | Policy                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/me/sidebar-layout?personId=` | Any active session; LAB gets defaults, or with `personId` that person's layout, read-only |
| `PUT /api/me/sidebar-layout`           | `personal_settings.manage`; own layout; stale version 409 `version_conflict`              |
| `GET /api/me/pins`                     | `personal_settings.manage`; own pins, oldest first, access rechecked per record           |
| `PUT`/`DELETE /api/me/pins/:kind/:id`  | `personal_settings.manage`; idempotent; 404 when not openable; 409 `pin_limit`            |
| `GET`/`POST /api/me/recents`           | `personal_settings.manage`; own last 8, newest first; 404 when not openable               |
| `GET /api/me/preferences`              | Any active session; LAB gets defaults read-only                                           |
| `PATCH /api/me/preferences`            | `personal_settings.manage`; changed fields; stale version 409 `version_conflict`          |
| `GET /api/me/table-columns`            | Any active session; LAB gets defaults read-only                                           |
| `PUT /api/me/table-columns/:tableId`   | `personal_settings.manage`; 400 `unknown_table` / `invalid_column`; one version           |

- **Always one's own.** No route takes a user ID from the browser; a body with extra keys is 400.
  A personal account passing `?personId=` is 400 `person_id_not_allowed`.
- **LAB** never saves anyone's settings and never reads anyone's pins, recents, preferences or
  columns. The one exception is the sidebar layout with `?personId=` (the station's picked
  person, an active personal or test account; anything else is 404 `person_not_found`), read-only
  (`source: 'station_person'`). The picked person stays attribution only.
- **Record access** for pins and recents follows each detail route: storage units, projects and
  specimen sets are open to every active internal user (`inventory.read`), so existence is the
  check; a draft lab program only to the account that created it. Reads recheck it per record:
  one no longer openable (or gone) comes back `available: false` with no label, name, stage or
  link, and can still be unpinned.
- `/api/me/notification-preferences` is unchanged (its email switch, `action_item.read`).

## Inbox (STRATA-25, STRATA-55)

| Route                                  | Policy                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/inbox?tab=&filter=&q=&sort=` | `notification.read`; the signed-in person's own feed                   |
| `GET /api/inbox/summary`               | `notification.read`                                                    |
| `POST /api/inbox/read-all`             | `notification.read`; own feed only                                     |
| `POST /api/inbox/requests/:id/read`    | `action_item.read`; routed to me now or in my history, or raised by me |
| `POST /api/inbox/requests/:id/unread`  | `action_item.read`; as above                                           |

- **One feed, no new authority.** Requests appear as `GET /api/action-items` shows them to the
  person (open: routed to them now; resolved in the last 90 days: their history), plus requests
  they raised; updates are their notifications of the last 90 days. Reading, unreading and
  read-all change the person's read state only: never a request's status, routing or the audit
  log. Resolution stays with each workflow.
- **Someone else's request** (not routed to them, not resolved by them, not raised by them), a
  missing id or a malformed one is 404 `action_item_not_found`, and nothing changes.
- **LAB and pending accounts:** 403 on every route above.

## Retention (MM-T29)

| Route                                                                     | Policy                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `GET /api/storage-units/:id/retention`, `GET /api/projects/:id/retention` | `inventory.read` (LAB too; `canManage` false)      |
| `POST /api/retention/holds`, `…/extensions`                               | `retention.manage` for that project (handler)      |
| `POST /api/retention/holds/:id/release`, `…/extensions/:id/release`       | `retention.manage` for that project (handler)      |
| `POST /api/retention/requests`                                            | `retention.request` (personal accounts; never LAB) |
| `POST /api/retention/requests/:id/approve`, `…/decline`                   | `retention.manage` for that project (handler)      |

- **Who decides:** the project's Lead Project Engineer or a Lab Manager (D05). Admin alone doesn't. Others get
  403 `forbidden` (the retention views report `canManage: false`, `canRequest: true`, so the
  screen offers a request instead); the request is one shared action item
  for the Lead Project Engineer and every Lab Manager (MM-T27). Approving creates the hold or extension as the
  decider and resolves the item; declining needs a reason. A requester can't decide their own
  request unless they hold that authority anyway.
- **LAB:** 403 on every change and request, whoever its station selects; it may read retention.
- **Concurrency:** releases need the current `version` (409 `stale_retention`), are recorded
  once (409 `already_released`; an exact retry returns the same result), and concurrent holds or
  extensions are separate rows with their own history. Decided requests: 409 `request_decided`.
- **Tested units:** a Shelby tube or bulk soil bucket with completed-test evidence linked to that
  exact unit shows "Retention: Not applicable". Holds and extensions are not released or changed
  by that; they keep covering every other unit, and the MM-T36 route ignores them for that unit
  only.

## Standard disposal (MM-T30)

| Route                                     | Policy                                                     |
| ----------------------------------------- | ---------------------------------------------------------- |
| `GET /api/disposal/eligible?projectId=`   | `inventory.read` (`canApprove` says whether to offer it)   |
| `GET /api/disposal/ready?page=`           | `inventory.read`, every project (`canApprove` per unit)    |
| `POST /api/disposal/approvals`            | `disposal.approve` for each unit's project (handler)       |
| `POST /api/disposal/approvals/:id/revoke` | `disposal.approve` for that project (handler)              |
| `POST /api/disposal/remove`               | `storage_unit.dispose_scan` (personal accounts; never LAB) |

- **Eligibility** is the database's (`unit_disposal_eligible`): in stock, effective retain-until
  reached (MM-T29), no active hold, every covering program closed (including a program on the
  unit's hole that it was received after). Ineligible units carry reasons ("Retain until …",
  "On hold: …", "Program LP-… open").
- **Approval** (Lead Project Engineer or Lab Manager, single or batch, all or nothing) marks units
  `approved_for_disposal`; it never disposes. Revoking needs a reason and returns the unit to stock.
- **Removal** is the online-only Disposal scan. It locks the unit, needs a live approval and
  rechecks eligibility and open location conflicts at that moment: 200 Disposed; 422 Not approved
  or Blocked with reasons (audited `disposal.blocked`); 404 unknown ID. Offline the screen is
  disabled and nothing is queued. Concurrent scans dispose once; a retry with the same key
  returns the recorded result.
- **LAB:** 403 on approval, revocation and removal (and on MM-T36's post-testing removal),
  whoever its station selects. Ordinary move routes never change a unit's status; a disposed
  unit is refused by moves, queued-move replay and test linking, and never returns to stock.
- **Tested units** use MM-T36's separate route, which needs no approval, scan, retention or
  program closure.

## Help & Feedback (Field Ledger)

| Route                                   | Policy                           |
| --------------------------------------- | -------------------------------- |
| `POST /api/feedback {kind, text, page}` | any active session, LAB included |
| `GET /api/feedback`                     | `feedback.read` (admin only)     |

- **Stays on the host.** Each submission is an append-only audit event `feedback.submitted`
  (actor snapshot, kind, text, optional in-app path without a query string). Nothing is emailed
  or sent to an outside service. Administrators read the latest 50 on the Help & Feedback page.
- **Private to administrators (STRATA-118).** Reading it needs `feedback.read`, which only the
  admin role grants: never Lab Managers (who now hold `staff.manage`), LAB or a position.
- **Inbox (STRATA-104).** Each accepted submission writes one in-app notification
  `feedback.submitted` to every active administrator except the sender (never LAB, never email;
  migration 0042). It names the feedback event; the Inbox shows "Feedback · Problem" (or
  Question, Idea) from the sender, with the page as its record, linking to `/help`; the text stays
  behind `feedback.read`. The database refuses a feedback notification for anyone without the
  admin role. An optional `submissionId` (UUID) makes a retry safe: the same account sending the
  same id gets the first submission's id back and nobody is notified twice (unique in the
  database).
- **Kind words (round 10):** `not_working` reads "Problem", `confusing` "Question", `idea` "Idea";
  the stored values are unchanged, so older rows read the same way.

## Receiving drafts and receipts (STRATA-78, STRATA-108)

| Route                                                      | Policy                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /api/receipt-drafts {draftId, personUserId?}`        | `receipt.draft`                                                          |
| `GET /api/receipt-drafts?ids=&personUserId=`               | `receipt.draft`                                                          |
| `POST /api/receipt-drafts/:draftId/delete {personUserId?}` | `receipt.draft`; then the draft's starter or a verified Lab Manager only |
| `GET /api/receipts/:receiptId/history?page=`               | `inventory.read`                                                         |

- **Drafts stay in the browser** (MM-T11). The server registry holds only who started each draft
  (account and person), never its contents. Changing Received by never changes the starter.
- **Deleting a draft** (Kyle, 2026-11-12): only the person who started it or a Lab Manager whose
  role is checked as it stands now (not from the session). LAB may delete only a draft started on
  that LAB account with the starter picked at the station; the pick is attribution and never
  borrows a role. A draft saved before the registry has no owner, so only a Lab Manager may delete
  it, recorded as a legacy row. Refused: 403 `draft_delete_forbidden`; a repeat delete is
  idempotent. Draft auto-delete (MM-T45) is an admin policy and is unchanged.
- **Received by** is staff attribution chosen per receipt (STRATA-107): editable, separate from
  the account that entered it; the receipt shows "Entered by X, for Y" when they differ. It
  grants no permissions.
