# Permissions

Enforced on the server by `apps/api/src/auth/policy.ts` (`can()`) and the global `AuthGuard`
(TRP-T04). Source: App Idea §1 "Confirmed permissions" and §8 "Confirmed shared receiving
account", plus owner decisions of 2026-10-25. Keep this table and `policy.ts` in step.

## Rules

- **Default deny.** Every route declares one policy: `@Public()`, `@AnySession()` (pending users
  too), `@ActiveUser()` (handler checks a project-scoped permission itself) or
  `@RequirePermission(…)`. A route without one is refused, and a test fails the build.
- **Pending and disabled users** get nothing beyond `GET /api/me` and sign-out (pending) or a 401
  (disabled: their sessions stop authenticating).
- **Position and job title grant nothing.** Only `role_assignment` (admin, lab_manager), the
  account type and project authority (PM/PE, acceptance delegates) do.
- **Admin is not a super-user.** It manages staff and sessions; it doesn't imply Lab Manager
  rights, project authority, acceptance or closure.
- **LAB** (shared receiving account) is limited to the LAB column even if a role is assigned to it
  by mistake.

## Matrix

| Permission                        | LAB | Any internal user | Lab Manager | Admin | Project PM/PE | Acceptance delegate |
| --------------------------------- | :-: | :---------------: | :---------: | :---: | :-----------: | :-----------------: |
| receipt.confirm / receipt.draft   |  ✓  |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| project.create / test_hole.create |  ✓  |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| inventory.read / label.print      |  ✓  |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| storage_unit.move (#21)           |  ✓  |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| storage_unit.correct (D45–D47)    |     |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| lab_program.manage                |     |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| test.progress (D08) / test.review |     |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| storage_unit.dispose_scan (#24)   |     |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| test_catalog.manage (D37)         |     |                   |      ✓      |   ✓   |               |                     |
| program.priority.set (D50)        |     |                   |      ✓      |       |       ✓       |                     |
| program.reopen                    |     |                   |      ✓      |       |       ✓       |                     |
| test.cancel (D07)                 |     |                   |      ✓      |       |       ✓       |                     |
| retention.manage (D05)            |     |                   |      ✓      |       |       ✓       |                     |
| disposal.approve (D19)            |     |                   |      ✓      |       |       ✓       |                     |
| settings.drafts.manage (T40)      |     |                   |      ✓      |   ✓   |               |                     |
| test.accept (D04)                 |     |                   |             |       |       ✓       |          ✓          |
| program.close (D06)               |     |                   |             |       |       ✓       |                     |
| acceptance_delegation.manage      |     |                   |             |       |       ✓       |                     |
| staff.manage / session.revoke     |     |                   |             |   ✓   |               |                     |
| printer.manage (T15)              |     |                   |             |   ✓   |               |                     |
| project.edit (T35)                |     |                   |             |   ✓   |       ✓       |                     |
| project.pm_pe.change (T35)        |     |                   |             |   ✓   |               |                     |
| system.status.read (T21)          |     |                   |             |   ✓   |               |                     |

"Project PM/PE" and "Acceptance delegate" apply only when the handler passes that project to
`can()`. "Any internal user" means an active personal or test account.

## Sessions

- Opaque random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production); only its
  SHA-256 is stored.
- Absolute expiry, never extended: personal and test accounts 12 hours (`PERSONAL_SESSION_HOURS`,
  owner decision 2026-10-25); LAB one calendar month (TRP-T06): the same local time in
  `BUSINESS_TIME_ZONE` a month later, clamped to the month's last day (Jan 31 → Feb 28/29). The
  cookie's `Expires` equals the session expiry, so it survives a browser restart.
- Revocable one at a time or all for a user; disabling a user revokes all of them in the same
  transaction.

## Shared receiving account LAB (TRP-T06)

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
- `lab.integration.test.ts` calls every endpoint outside the LAB column with a LAB session and
  expects 403 with nothing changed, so new endpoints are covered automatically.

## Microsoft sign-in (TRP-T05)

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
- **New people** are created `pending` and see position setup, then access-pending until an admin
  approves them (TRP-T07). **Position grants nothing.** **Official initials** are only ever set by
  an admin; refresh never writes them.
- **Bootstrap admin:** the account whose object ID matches `BOOTSTRAP_ADMIN_OBJECT_ID` (or, only
  when that is unset, whose UPN matches `BOOTSTRAP_ADMIN_UPN`) becomes active + admin at first
  sign-in, or while still pending. There is no first-user-wins rule.
- **Shared devices:** "Switch user" signs out and sends `prompt=select_account`. A new sign-in
  revokes any previous session cookie on that browser.
- **Still needs IT** (card T05 §5): the app registration (tenant ID, client ID, secret, redirect
  URIs, admin consent for User.Read, technical owner), the optional `acct` ID-token claim, and
  reconciling sign-in timing (D38). Real-account verification (card test T6) waits for these.
- **Tests** use a mock tenant and Graph (`apps/api/src/test-support/mock-oidc.ts`;
  `npm run mock:idp -w @trapezoid/api` for E2E) with fictional identities only.

## CSRF

State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) must send `x-trapezoid-csrf: 1`
(`CSRF_HEADER_NAME` in `@trapezoid/shared`), and if the browser sends `Origin` it must match the
request's `Host`. The API enables no CORS, so another site can't send the header.

## Staff & access (TRP-T07)

| Route                                       | Policy                      |
| ------------------------------------------- | --------------------------- |
| `GET /api/staff?search=&status=`            | `staff.manage` (admin)      |
| `POST /api/staff` (pre-provision)           | `staff.manage`              |
| `POST /api/staff/:id/approve`               | `staff.manage`              |
| `POST /api/staff/:id/disable {reason}`      | `staff.manage`              |
| `POST /api/staff/:id/enable`                | `staff.manage`              |
| `PUT /api/staff/:id/roles {roles, reason?}` | `staff.manage`              |
| `PATCH /api/staff/:id`                      | `staff.manage`              |
| `GET /api/staff/receivers?search=`          | any active session, LAB too |

- **Approval** makes a pending account active; their existing session works on the next request.
- **Disabling** needs a reason and revokes every session in the same transaction; the person
  drops out of the receiver selector. Re-enabling doesn't revive old sessions.
- **Last admin:** a change that would leave no active (non-LAB) admin, whether removing the admin
  role or disabling, returns 422 `last_admin`. Kyle's bootstrap admin is an ordinary admin.
- **LAB** can't hold roles (422 `roles_not_allowed`) and never appears as a receiver.
- **Receiver selection is attribution, not authentication**: it grants nothing. Only active
  staff with official initials are offered; free text is never accepted.
- **Pre-provisioned staff** are created active (the admin who adds them approves them). On a
  first Microsoft sign-in (`StaffService.resolveMicrosoftSignIn`, called by TRP-T05) the entry is
  linked only when the UPN matches the expected UPN exactly (ignoring case) and the entry has no
  sign-in identity yet. Initials and names are never compared; anyone else becomes a new pending
  user.

## Projects (TRP-T35)

| Route                                    | Policy                                                |
| ---------------------------------------- | ----------------------------------------------------- |
| `GET /api/projects?search=&mine=&sort=…` | `inventory.read` (every active session, LAB included) |
| `GET /api/projects/:id`                  | `inventory.read`                                      |
| `PATCH /api/projects/:id`                | active user; the service checks `project.edit`        |
| `POST /api/projects/:id/test-holes`      | `test_hole.create` (LAB included)                     |

- **Edit** (owner decision 2026-10-25): admins and the project's current PM/PE may change the
  number, name, client, review engineer and server folder path. Changing the PM/PE is admin-only
  (`project.pm_pe.change`) and needs a reason. A review engineer, Lab Manager or LAB can't edit.
- **Project number** is printed on labels, so it can't change once the project has any receipt:
  422 `project_number_locked`, also enforced by a database trigger (migration 0015).
- Edits are optimistic (`version`; a stale one gets 409 `version_conflict` with the current
  project) and audited as `project.updated` with only the changed fields before/after and the
  reason.

## Draft auto-delete setting (TRP-T40)

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
