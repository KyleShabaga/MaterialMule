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
| test.accept (D04)                 |     |                   |             |       |       ✓       |          ✓          |
| program.close (D06)               |     |                   |             |       |       ✓       |                     |
| acceptance_delegation.manage      |     |                   |             |       |       ✓       |                     |
| staff.manage / session.revoke     |     |                   |             |   ✓   |               |                     |

"Project PM/PE" and "Acceptance delegate" apply only when the handler passes that project to
`can()`. "Any internal user" means an active personal or test account.

## Sessions

- Opaque random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production); only its
  SHA-256 is stored.
- Absolute expiry, never extended: personal and test accounts 12 hours (`PERSONAL_SESSION_HOURS`,
  owner decision 2026-10-25); LAB one calendar month (TRP-T06).
- Revocable one at a time or all for a user; disabling a user revokes all of them in the same
  transaction.

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
