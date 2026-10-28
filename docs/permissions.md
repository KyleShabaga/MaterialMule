# Permissions

Enforced on the server by `apps/api/src/auth/policy.ts` (`can()`) and the global `AuthGuard`
(MM-T04). Source: App Idea §1 "Confirmed permissions" and §8 "Confirmed shared receiving
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

| Permission                                  | LAB | Any internal user | Lab Manager | Admin | Project PM/PE | Acceptance delegate |
| ------------------------------------------- | :-: | :---------------: | :---------: | :---: | :-----------: | :-----------------: |
| receipt.confirm / receipt.draft             |  ✓  |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| project.create / test_hole.create           |  ✓  |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| inventory.read / label.print                |  ✓  |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| storage_unit.move (#21)                     |  ✓  |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| lab_program.read / lab_program.manage (T23) |  ✓  |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| storage_unit.correct (D45–D47)              |     |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| test.progress (D08) / test.review           |     |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| storage_unit.dispose_scan (#24)             |     |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| location_conflict.resolve (D29)             |     |         ✓         |      ✓      |   ✓   |       ✓       |          ✓          |
| test_catalog.manage (D37)                   |     |                   |      ✓      |   ✓   |               |                     |
| program.priority.set (D50)                  |     |                   |      ✓      |       |       ✓       |                     |
| program.reopen                              |     |                   |      ✓      |       |       ✓       |                     |
| test.cancel (D07)                           |     |                   |      ✓      |       |       ✓       |                     |
| retention.manage (D05)                      |     |                   |      ✓      |       |       ✓       |                     |
| disposal.approve (D19)                      |     |                   |      ✓      |       |       ✓       |                     |
| settings.drafts.manage (MM-T45)             |     |                   |      ✓      |   ✓   |               |                     |
| location.manage (MM-T37)                    |     |                   |      ✓      |   ✓   |               |                     |
| test.accept (D04)                           |     |                   |             |       |       ✓       |          ✓          |
| program.close (D06)                         |     |                   |             |       |       ✓       |                     |
| acceptance_delegation.manage                |     |                   |             |       |       ✓       |                     |
| staff.manage / session.revoke               |     |                   |             |   ✓   |               |                     |
| printer.manage (T15)                        |     |                   |             |   ✓   |               |                     |
| project.edit (T35)                          |     |                   |             |   ✓   |       ✓       |                     |
| project.pm_pe.change (T35)                  |     |                   |             |   ✓   |               |                     |
| system.status.read (T21)                    |     |                   |             |   ✓   |               |                     |

"Project PM/PE" and "Acceptance delegate" apply only when the handler passes that project to
`can()`. "Any internal user" means an active personal or test account.

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
- `lab.integration.test.ts` calls every endpoint outside the LAB column with a LAB session and
  expects 403 with nothing changed, so new endpoints are covered automatically.

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
- **New people** are created `pending` and see position setup, then access-pending until an admin
  approves them (MM-T07). **Position grants nothing.** **Official initials** are only ever set by
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
  first Microsoft sign-in (`StaffService.resolveMicrosoftSignIn`, called by MM-T05) the entry is
  linked only when the UPN matches the expected UPN exactly (ignoring case) and the entry has no
  sign-in identity yet. Initials and names are never compared; anyone else becomes a new pending
  user.

## Projects (MM-T35)

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
  a unit there (migration 0028). Locations are never deleted.
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
