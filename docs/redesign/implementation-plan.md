# Field Ledger: implementation plan

Turns the Field Ledger redesign into the real app (`apps/web`, plus the API where a screen needs
something the app cannot do yet). Written 2026-11-10. Starts when PR 170 is merged.

## Sources of truth

1. [design.md](design.md): the spec. Tokens, components, shell, sizes, hover, every screen.
2. [canvas/](canvas/): a copy of all 75 canvas artboards (`*.dc.html`). Each is plain HTML with
   inline styles and fictional data. Use them for exact spacing, sizes and structure. They are
   reference only: never import or ship them.
3. `CLAUDE.md`, `docs/concrete.md`, `docs/permissions.md`: domain rules. These win over the canvas.

`docs/design.md` (the current navy look) stays in the repo until wave 3 marks it superseded.

## Owner decisions (Kyle, 2026-11-10)

- **Dark mode: derive a dark variant.** The theme switch keeps working. The dark palette is new
  and has not been seen by Kyle, so wave 0 proposes it in `design.md` and it gets one review.
- **Scope: everything on the canvas**, including behaviour the app lacks today.
- The canvas decisions already recorded in `design.md` stand (seven destinations and their order,
  top bar holds only search and the bell, rail drop-downs, rail footer, donkey logo recoloured
  only, no depth bars, no numbers in the rail, compact table view).

## Not built, whatever the canvas shows

The canvas has placeholder screens for things that are gated or deferred. Restyle what exists;
do not invent the rest.

- Concrete gates in `docs/concrete.md`: G2 strength report, G8 units, readings and methods,
  workbook and CSA/ASTM limits, report templates, set numbering, **offline field entry** (the
  phone field report screens: Load, Tests, Specimens) and **final issued reports**.
- Deferred decisions: billing D16–D18, sign-in timing D38, IT/pilot D39.
- Role names "Engineer" and "Field technician", lab bench locations, holiday dates, printer
  addresses and Help content on the canvas are placeholders. Use what the app has.
- An individual sample inventory at receiving. Never.

If a screen cannot be finished without one of these, build up to the gate, leave the gated part
as the app has it today, and list it in the lane's PR under "Stopped at a gate".

## Rules for every lane

- Branch from `redesign/field-ledger` (the integration branch), PR back into it. Not into `main`.
- Colours, type, radii and spacing come only from the CSS variables wave 0 defines. No raw hex in
  feature CSS or TSX. No pill shapes. Flag orange is always a fill behind ink text.
- Keep every permission check on the server. The redesign changes no authority.
- Keep accessible names, roles and visible labels unless `design.md` renames them. Where a label
  changes, update the unit and E2E tests in the same PR.
- Both themes, desktop and phone (390 px), keyboard focus, hover (desktop only), forced-colours.
- The printed label and printed tag layouts (`printing/labels.css`, `lab/sample-tags.css` print
  rules) are physical output: restyle the on-screen preview chrome only.
- Fictional data only (DEMO-2601, TH26-01).
- Gate: `npm run verify` locally, and the PR's CI E2E shards. Worktrees share `materialmule_test`,
  so run local E2E one lane at a time with its own `E2E_PORT`; rely on CI for the full suite.
- New API routes: zod schema in `packages/shared`, a row in the security sweep, tests beside the
  code, forward-only migration only if truly needed (none is expected).

## Waves

### Wave 0: foundation (one session, lands first)

Everything later depends on this, so it is not parallel.

1. Create `redesign/field-ledger` from `origin/main` (after PR 170) and bring in `docs/redesign/`.
2. **Tokens.** Rewrite the `:root` blocks in `apps/web/src/styles.css` to Field Ledger: paper,
   sheet, rail, ink, ink-soft, hairline, flag, flag-wash, link, the five status tags, radii 3/4/6,
   the type scale and the spacing scale. Keep the existing variable names where the meaning is the
   same so feature CSS keeps working; add new ones; list the mapping in `design.md`
   ("Implementation map").
3. **Dark variant.** Derive it (ink ground, paper text, flag unchanged, tag fills darkened), check
   every pair for contrast, write it into `design.md` as "Dark variant (proposed)", keep the two
   dark blocks identical and the theme tests passing.
4. **Fonts.** Replace `@fontsource/inter` and `@fontsource/jetbrains-mono` with Archivo and
   IBM Plex Mono, bundled (no network: the host has no cloud access).
5. **Shared components** (`components/ui.tsx`, base rules in `styles.css`): buttons (flag,
   secondary, ink, danger), inputs, selects, tags, tables with the **view selector** (comfortable
   and compact, remembered per table), counted cells, unit label block, dialogs, notices, empty and
   error states, hover and focus rules.
6. **Shell** (`layout/`): rail with plain-text destinations in the new order and names, drop-down
   groups for Concrete and Retention, rail footer (Settings, Help & Feedback, account row with
   name, role and sign-out, theme switch kept), top bar with only search and the bell, the context
   row, the phone bottom bar with Scan in the centre and the More sheet, donkey mark recoloured.
   The lab-staff Concrete Lab group folds into the Concrete drop-down.
7. Update `shell.test.tsx`, `SidebarFooter.test.tsx`, theme tests, and the E2E specs that assert
   the shell (`app-shell`, `link-contrast`, `forced-colors`, `focus-management`).
8. PR into `redesign/field-ledger`, CI green, merged.

After wave 0 the whole app already wears the new colours and shell; pages are then rebuilt to
their canvas layouts.

### Wave 1: screens (six parallel sessions, one worktree each)

Lanes own separate folders, so they do not edit the same files. A lane that needs a change in
`styles.css`, `ui.tsx` or `layout/` asks for it in its PR rather than editing those files, unless
the change is a pure addition at the end of the file.

| Lane                     | Folders                                                                                                    | Canvas boards                                                                                                                                                                                                                                                           | New behaviour to build                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Today and entry       | `dashboard/`, `notifications/`, `pages/` (sign-in, access pending, not found, profile), global search page | Main, Notifications, Search, SignIn, AccessPending, NotFound, States, Help, PhoneToday, PhoneNotifications, PhoneFind, PhoneMore                                                                                                                                        | Greeting block and "Needs you" queue, 24-hour ledger, storage room cells; top-bar search wired to the search route across units, samples, projects, programs; Help & Feedback page (feedback stays on the host) |
| B. Receiving             | `receiving/`, `receiving/drafts/`, `receiving-log/`, `scanning/`                                           | Receive, ReceiveDelivery, ReceiveUnit, ReceiptDone, ReceivingLog, PhoneReceive, PhoneScan                                                                                                                                                                               | Three-step draft (Delivery, Units, Confirm and label), "On confirm" panel, confirmation screen that names the next task                                                                                         |
| C. Inventory and units   | `inventory/`, `moves/`, `printing/`, `retention/`, `disposal/`                                             | Inventory, Unit, UnitDisposed, Move, Shelf, LabelPrint, Retention, DisposalScan, PhoneUnit, PhoneMove, PhoneRetention                                                                                                                                                   | Shelf page (where a scanned shelf label lands), shelf cells preview on Move, retention in three bands with a disposal list                                                                                      |
| D. Lab                   | `lab/`, `action-requests/`                                                                                 | Lab, LabProgram, LabRequest, SampleTags, ActionRequests, PhoneLab                                                                                                                                                                                                       | "What the lab gets" panel, units-to-pull list on the phone                                                                                                                                                      |
| E. Projects and settings | `projects/` (not its concrete tabs), `settings/*`                                                          | Projects, Project, ProjectTeam, Staff, Settings and the ten Settings* boards, PhoneSettings                                                                                                                                                                             | Project cards with Mine / All active / Closed, settings sub-navigation                                                                                                                                          |
| F. Concrete              | `concrete/*`, `concrete-review/`, project concrete tabs                                                    | Concrete, ConcreteReceiving, ConcreteSpecimens, ConcreteSet, ConcreteTesting, ConcreteHolds, ConcreteSearch, ConcreteReport, ConcreteReview, ConcreteReviewReport, ConcreteStrength, ConcreteIssue, ProjectConcrete, ConcreteMix, ConcreteMixPropagation, PhoneConcrete | Hold bands with the reason panel. Gated parts stay as they are                                                                                                                                                  |

Each lane session may split its folders across Opus 5.5 subagents at medium effort, and opens one
PR into `redesign/field-ledger`.

### Wave 2: integration (one session)

1. Merge the six lane PRs in order A, B, C, D, E, F; resolve conflicts in shared files.
2. `npm run verify` and the full `npm run test:e2e` on the integration branch.
3. Sweep every route at 1440 px and 390 px in both themes: sizes against the "Size rules" in
   `design.md`, contrast, focus order, hover, forced-colours. Fix what is off.
4. Delete CSS and variables nothing uses any more.

### Wave 3: release (same session as wave 2)

1. Mark `docs/design.md` superseded by `docs/redesign/design.md`; update `README.md` screenshots
   or wording that names old destinations.
2. Open one PR from `redesign/field-ledger` into `main` with: what changed, what was built new,
   what stopped at a gate, the proposed dark palette for Kyle's review. **Kyle merges it.**

## Order and dependencies

```
PR 170 merged → wave 0 → wave 1 (A B C D E F in parallel) → wave 2 → wave 3 → Kyle reviews
```

## Follow-ups this plan does not cover

Lab-wide activity log, export or print of a list, tablet layouts, and everything under
"Not built" above. Each becomes its own card when its decision is made.
