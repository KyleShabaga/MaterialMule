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
- **Position and job title grant nothing.** Only `role_assignment` (admin, lab_manager), the
  account type and project authority (Lead Project Engineer, acceptance delegates, Authorized
  report issuers) do. Team membership and reviewer assignment add no permission (MM-AO03).
- **Admin is not a super-user.** It manages staff and sessions; it doesn't imply Lab Manager
  rights, project authority, acceptance or closure.
- **LAB** (shared receiving account) is limited to the LAB column even if a role is assigned to it
  by mistake.

## Matrix

| Permission                                                               | LAB | Any internal user | Lab Manager | Admin | Lead Project Engineer | Acceptance delegate |
| ------------------------------------------------------------------------ | :-: | :---------------: | :---------: | :---: | :-------------------: | :-----------------: |
| receipt.confirm / receipt.draft                                          |  ✓  |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| project.create / test_hole.create                                        |  ✓  |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| inventory.read / label.print                                             |  ✓  |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| storage_unit.move (#21)                                                  |  ✓  |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| lab_program.read / lab_program.manage (T23)                              |  ✓  |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| storage_unit.correct (D45–D47)                                           |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| test.progress (D08, T24)                                                 |  ✓  |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| lab_comment.write (T24)                                                  |  ✓  |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| test.review                                                              |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| acceptance_delegation.read (T25)                                         |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| project_access.read (AO03)                                               |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| project_lead.nominate (AO04, D01)                                        |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| lab_program.amend (T26)                                                  |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| test.cancel_request (T26)                                                |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| program.close_request (T26)                                              |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| storage_unit.dispose_scan (#24)                                          |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| location_conflict.resolve (D29)                                          |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| storage_unit.tested_removal (T36)                                        |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| action_item.read (T27)                                                   |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| notification.read (T91)                                                  |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| retention.request (T29)                                                  |     |         ✓         |      ✓      |   ✓   |           ✓           |          ✓          |
| test_catalog.manage (D37)                                                |     |                   |      ✓      |   ✓   |                       |                     |
| program.priority.set (D50)                                               |     |                   |      ✓      |       |           ✓           |                     |
| program.reopen                                                           |     |                   |      ✓      |       |           ✓           |                     |
| test.cancel (D07)                                                        |     |                   |      ✓      |       |           ✓           |                     |
| test.correction_done (T25)                                               |     |                   |      ✓      |       |                       |                     |
| retention.manage (D05)                                                   |     |                   |      ✓      |       |           ✓           |                     |
| disposal.approve (D19)                                                   |     |                   |      ✓      |       |           ✓           |                     |
| settings.drafts.manage (MM-T45)                                          |     |                   |      ✓      |   ✓   |                       |                     |
| location.manage (MM-T37)                                                 |     |                   |      ✓      |   ✓   |                       |                     |
| action_item.reassign (T27)                                               |     |                   |      ✓      |   ✓   |                       |                     |
| test.accept (D04)                                                        |     |                   |             |       |           ✓           |          ✓          |
| program.close (D06)                                                      |     |                   |             |       |           ✓           |                     |
| acceptance_delegation.manage                                             |     |                   |             |       |           ✓           |                     |
| staff.manage / session.revoke                                            |     |                   |             |   ✓   |                       |                     |
| printer.manage (T15)                                                     |     |                   |             |   ✓   |                       |                     |
| project.edit (T35)                                                       |     |                   |             |   ✓   |           ✓           |                     |
| project_team.manage (AO03, D04)                                          |     |                   |             |   ✓   |           ✓           |                     |
| project_reviewer.manage (AO03, D04/D05)                                  |     |                   |             |   ✓   |           ✓           |                     |
| project_review.approve (MISC-08)                                         |     |                   |             |       |           ✓           |                     |
| report_issuer.manage (AO03, D06)                                         |     |                   |             |       |           ✓           |                     |
| report.issue (AO03, D07)                                                 |     |                   |             |       |           ✓           |                     |
| concrete_mix.manage / concrete_mix.approve (AO08, planned)               |     |                   |             |       |           ✓           |                     |
| concrete.review (AO08, planned; + designated reviewer)                   |     |                   |             |       |           ✓           |                     |
| concrete_failure_schedule.approve (AO08, planned; + designated reviewer) |     |                   |             |       |           ✓           |                     |
| concrete_hold.manage (AO08, planned; + concrete LM grant)                |     |                   |             |       |           ✓           |                     |
| reviewer_eligibility.manage (AO03, D05)                                  |     |                   |             |   ✓   |                       |                     |
| staff_capability.manage (AO03, D01)                                      |     |                   |             |   ✓   |                       |                     |
| project.lead_project_engineer.change (T35)                               |     |                   |             |   ✓   |                       |                     |
| system.status.read (T21)                                                 |     |                   |             |   ✓   |                       |                     |

"Lead Project Engineer" and "Acceptance delegate" apply only when the handler passes that project to
`can()`. "Any internal user" means an active personal or test account. `report.issue` is also held
by an active, unexpired Authorized report issuer grant for that project and report scope (D06); no
report route uses it yet. Team membership, reviewer assignment, job title and position add no
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
- An admin (`staff.manage`) sets or resets the password with `POST /api/admin/lab/password`
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
| `GET /api/staff?search=&status=`                                             | `staff.manage` (admin)                       |
| `POST /api/staff` (pre-provision)                                            | `staff.manage`                               |
| `POST /api/staff/:id/approve`                                                | `staff.manage`                               |
| `POST /api/staff/:id/disable {reason}`                                       | `staff.manage`                               |
| `POST /api/staff/:id/enable`                                                 | `staff.manage`                               |
| `PUT /api/staff/:id/roles {roles, reason}`                                   | `staff.manage`                               |
| `PATCH /api/staff/:id`                                                       | `staff.manage`                               |
| `PUT /api/staff/:id/job-title-override {jobTitleOverride, reason}` (MM-AO06) | `staff.manage`                               |
| `GET /api/staff/:id/access` (MM-AO06)                                        | `staff.manage` (read-only)                   |
| `GET /api/me/access` (MM-AO06)                                               | active personal session (one's own); LAB 403 |
| `GET /api/staff/receivers?search=`                                           | any active session, LAB too                  |

- **Approval** makes a pending account active; their existing session works on the next request.
- **Disabling** needs a reason and revokes every session in the same transaction; the person
  drops out of the receiver selector. Re-enabling doesn't revive old sessions, and revokes every
  technical grant the person still holds for revalidation (D08, MM-AO03; see "Team & permissions").
- **Role changes** need a reason (D15, MM-AO03; 400 without one, nothing changes).
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
  `project_access.read`, so LAB gets 403. Admins see the same summary for anyone, read-only, under "Current
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
| `GET /api/staff/:id/grants`                                                                                                      | `staff.manage` (admin)                                |
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
  eligibility and assignments, issuer grants, acceptance delegations, create-and-lead) in the
  re-enable transaction, each audited with the reason "Account re-enabled: technical grants need
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
deadlock. Requests that only route work to the lead (closure and cancellation requests) take no
authority and are unchanged; open-task rerouting (D10) is MM-AO07.

## Concrete permission contract (MM-AO08)

The shared authorization contract for concrete work, in `apps/api/src/auth/policy.ts` with its
matrix in `policy.test.ts`. **Planned, not implemented:** no concrete route, screen or table exists
yet (C01–C08 are not started), so nothing here is enforced by an endpoint, and none of these actions
appears in a project's capability list (`GET …/capabilities`, Team & Permissions) until its
owning card adds the route (owner decision 2026-10-29, AO08 Q2). Each owning card loads the
project facts below from the database, checks `can()` under the D09 lock order, and adds its row
to the capability list in the same change.

| Permission                          | Granted by                                                                                    | Owner card                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `concrete_mix.manage`               | the destination project's Lead Project Engineer only                                          | C03 (create, edit, copy)                           |
| `concrete_mix.approve`              | the destination project's Lead Project Engineer only                                          | C03 (approve; D14 revisions)                       |
| `concrete.review`                   | the project's Lead Project Engineer, or a designated reviewer for the scope                   | C02 adapter, then C04/C07 review routes            |
| `concrete_failure_schedule.approve` | the project's Lead Project Engineer, or a designated reviewer (strength scope); one is enough | the failure-workflow card after C07                |
| `concrete_hold.manage`              | the project's Lead Project Engineer, or a Lab Manager holding the project's concrete grant    | C02 (grant storage), then the failed-specimen HOLD |
| `report.issue` (existing, AO03)     | the Lead Project Engineer, or an Authorized report issuer for the scope                       | the report-lifecycle card (not in C01–C08)         |
| concrete settings → `project.edit`  | the Lead Project Engineer or an admin (settings only)                                         | C02                                                |

- **Mixes (C03, D14).** Only the destination project's Lead Project Engineer creates, edits,
  copies and approves mixes: no admin, Lab Manager, reviewer, delegate or issuer fallback, and a
  project waiting for a lead (D02) has no one who can. D14 (adopted): editing an approved mix makes
  a new draft revision; the approved version stays effective until the lead approves the revision.
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
- **Concrete settings** (tests used, reviewer list) reuse `project.edit`: the lead or an admin
  (AO08 Q4). Admin authority covers settings only, never mixes. Reviewer assignments stay
  `project_reviewer.manage` (AO03).
- **Denied wording** for the owning screens: the existing blocked codes apply —
  `no_lead_project_engineer` when only the lead could act and there is none, `not_permitted`
  otherwise, with the sources that could (`CAPABILITY_SOURCE_LABEL`: "Designated reviewer", "Lab
  Manager with this project’s concrete grant").

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

| Route                                                      | Policy                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/worklist?priority=&projectId=&open=&testTypeId=` | `lab_program.read`                                      |
| `GET /api/lab-programs/:id/work`                           | `lab_program.read`                                      |
| `POST /api/test-requests/:id/status`                       | `test.progress` (LAB too, with `actingStaffUserId`)     |
| `PATCH /api/lab-programs/:id/priority`                     | active user; handler checks `program.priority.set`      |
| `POST /api/lab-programs/:id/comments`                      | `lab_comment.write` (LAB too, with `actingStaffUserId`) |
| `PATCH /api/comments/:id`                                  | `lab_comment.write`; only the author, within 15 minutes |

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

| Route                                        | Policy                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `POST /api/lab-programs/:id/close`           | active user; handler checks `program.close` (Lead Project Engineer)        |
| `POST /api/lab-programs/:id/reopen`          | active user; handler checks `program.reopen` (Lead Project Engineer or LM) |
| `POST /api/lab-programs/:id/close-request`   | `program.close_request` (personal accounts)                                |
| `POST /api/test-requests/:id/cancel`         | active user; handler checks `test.cancel` (Lead Project Engineer or LM)    |
| `POST /api/test-requests/:id/cancel-request` | `test.cancel_request` (personal accounts)                                  |
| `POST /api/test-requests/:id/repeat`         | `lab_program.amend` (personal accounts)                                    |
| `PATCH /api/test-requests/:id`               | `lab_program.amend` (accepted-request change, D09)                         |
| `GET /api/lab-programs/:id/later-receipts`   | `lab_program.amend`                                                        |
| `POST /api/lab-programs/:id/amend`           | `lab_program.amend` (amendment, D02)                                       |

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
