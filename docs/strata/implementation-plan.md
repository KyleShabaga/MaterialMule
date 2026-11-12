# Strata: implementation plan

Approved by Kyle on 2026-11-12. Build board: Notion "Strata UI/UX build board" (STRATA-n cards).

## Context

The Strata redesign is fully designed: all ten rounds are on the two canvases (main v90,
concrete-and-settings v7), the spec is `DESIGN.md`, and the audit fixes are pushed to draft PR #181.
The Notion "Strata UI/UX build board" has 128 cards (STRATA-1…128). About 95 are open Build or
Tech-debt cards; 9 are open decisions. `main` (0482b27) today runs Field Ledger, built with plain
CSS (`apps/web/src/styles.css`, 2,448 lines, plus per-folder CSS), `components/ui.tsx`, 64 routes
and 77 E2E specs. Strata replaces that with Tailwind v4, shadcn/ui (new-york), the Radix indigo
theme, Kyle's stage scales, Atkinson Hyperlegible and Lucide, and adds new behaviour, some of which
needs API work.

This plan turns the board into waves and lanes, in the same shape as the Field Ledger plan
(`docs/redesign/implementation-plan.md`), with the corrections from the Notion handoff note
("Claude Code handoff — Strata build board / PR #181").

## Sources of truth (in this order)

1. `CLAUDE.md`, `docs/concrete.md`, `docs/permissions.md`: domain and permission rules always win.
2. Confirmed Notion decisions (card pages and the handoff note) over older brief wording.
3. `DESIGN.md`: tokens, components, shell, every screen.
4. The canvases and `design/strata-canvas/project/*.dc.html`: exact layout and states. Reference
   only. The canvas loaders, React 18 shims and DOM-sorting workarounds never ship (STRATA-44, 50).

## How the work runs

- **Integration branch `redesign/strata`**, cut from `origin/main`, with `DESIGN.md`,
  `design/strata-ui/` and the canvas snapshot brought over from PR #181. PR #181 itself stays a
  draft and is never merged.
- **Each card or small group of cards gets its own branch and PR into `redesign/strata`**, never
  into `main`. I merge lane PRs into `redesign/strata` once CI is green. Only you merge
  `redesign/strata` into `main` (your "do not merge anything" rule stays for `main`).
  _Approving this plan approves that one exception; say so if you would rather merge the lane PRs
  yourself._
- **No more than three lanes at once.** CLAUDE.md records that more lanes on this PC stall the API
  and PostgreSQL. All lanes share `materialmule_test`, each with its own `E2E_PORT`. Local E2E runs
  one lane at a time, and CI runs the full suite.
- **Migrations:** each lane that needs one takes the next free number when it opens its PR into
  `redesign/strata`. Lanes rebase before merging so numbers stay contiguous. They are forward-only,
  and every new rule gets a `schema*.test.ts` proof.
- **Every new API route:** a zod schema in `packages/shared`, a row in the security sweep, a
  `PROJECT_CAPABILITY_ACTIONS` entry if project-scoped, and tests beside the code. LAB's picked
  person stays attribution only and never inherits roles.
- **Gates stay gates.** Build up to the gate, leave the gated part as the app has it, and list it in
  the PR under "Stopped at a gate". The gates are D16–D18, D38, D39, G2, G8, report templates,
  offline field entry and set numbering. The open decision cards are STRATA-35, 36, 48, 62, 68, 99,
  110, 111, 112 and 113. I bring each one to you when its lane reaches it.
- **Phones:** no new phone designs (you set them aside). The phone keeps working through shadcn's
  responsive sidebar (a Sheet under 768 px) and the table column-priority rule, so the existing
  phone E2E project keeps passing. 44 px targets apply on touch only.
- **Notion:** each card moves to In progress when its branch starts and to Done when its PR merges
  into `redesign/strata`. Done cards get the completion evidence the handoff asks for: branch,
  commit or PR, commands and their results, and known limits. New findings become new cards.
- **Decisions** I make along the way follow your rule: I choose the recommendation and log it in
  `DESIGN.md › Choices made`.

## Wave 0: Foundation (one session, lands first, serial)

Cards: 1, 2, 3, 69, 4, 5, 6, 7, 44, 70, 57, 127 (tokens).

1. Rename `apps/web/src/components/ui.tsx` to `components/app-ui.tsx` and update imports (the name
   clash with shadcn's `components/ui/`).
2. Add Tailwind v4 (`@tailwindcss/vite`), the `@/` alias, `components.json`, `lucide-react`, cva,
   clsx, tailwind-merge and the shadcn components listed on the Components board. Port the Strata
   edits from `design/strata-ui/src/components/ui/*` (STRATA-6): `text-destructive-text`,
   `text-link`, sizes and the CommandInput label.
3. Theme tokens from `design/strata-ui/src/index.css` plus `radix-stage-light.css` and
   `radix-stage-dark.css` go into `styles.css` under `:root`, `.dark` and the OS-dark media query.
   Field Ledger variable names are re-pointed at Strata values, so un-rebuilt pages keep working.
4. Bundle Atkinson Hyperlegible Next and Mono fonts (no network) with `@fontsource`. Remove Archivo
   and Plex in wave 3.
5. Light, dark and system theme switching, reusing `apps/web/src/theme/`.
6. A single date/time format helper (STRATA-70) and a shared item-wording module (STRATA-57) in
   `packages/shared`.
7. Turn Tailwind preflight on and walk every route once, so no page is left half-broken.

Result: the whole app wears Strata colours and type, every page still works, and `npm run verify`
and E2E pass.

## Wave 1: Shell, shared components and API contracts (three parallel lanes)

| Lane                     | Cards                                                                                                                                | Folders it owns                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **1A Shell and entry**   | 8, 9, 10, 12, 13 (UI), 14, 15, 16, 61, 125, 45, 81, 82, 60 (UI), 42, 43, 17, 18, 67, 105                                             | `layout/`, `pages/` (sign-in and system pages), `search/`, `session/`                            |
| **1B Shared components** | 122, 124, 46, 65, 49, 30, 58 (UI), 59, 52 (UI), 31, 66, 24 and 73 (one resizable peek drawer), 64                                    | `components/` (new data table, toolbar, peek, stage tag, lifecycle track, avatar, Sonner toasts) |
| **1C API contracts**     | 41, 38 and 39 (data), 11, 40, 51 (storage), 25, 55, 54, 58 (stage on rows), 47, 123, 52 (directory photos, cached locally), 29 (API) | `apps/api`, `packages/shared`, migrations                                                        |

- **1A** builds the shadcn Sidebar shell: Today, Projects and Inbox at the top, then the five
  sections, the Concrete and Retention drop-downs, collapsed mode, the top bar (title, quick
  actions, bell) and the account menu. Ctrl K runs on the existing grouped search endpoints, and
  scanning works from anywhere. The desktop Scan page and Concrete search become redirects. The
  LAB station gets one recording-person controller (16, 61 and 125 together) and safe sign-in.
  Pinned, Recent, folding and the sidebar's customize mode are wired once 1C merges.
- **1B** delivers the table everything uses: column priority, Search, Filter, Sort and View,
  active-filter chips, comfortable and compact rows, the 28 px Inbox Table, avatars and stage
  stripes, plus the peek drawer with `?open=` in the URL, toasts and bulk-confirm dialogs.
- **1C** gives each piece of per-person data its own schema, authorization and tests: sidebar
  layout, pins, recents, column choices and preferences. It also adds a single Inbox feed (requests
  plus notifications) with one badge-eligible unread count, a job number field, a stage field on
  list rows, server paging, search and sort for long tables, and audited Undo. Undo uses
  compensating actions only and never touches disposal, issued IDs or reports, or destructive tests.

Order inside the wave: 1C's shared types land first, as a small PR, so 1A and 1B code against them.

## Wave 2: Screens (six lanes by folder, at most three at a time)

| Lane                                       | Cards                                                          | Folders it owns                                                                | Needs you for                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A Today, Inbox, station**                | 19, 20, 21, 22, 23, 56, 63, 24/26 screens, 27, 64, 62          | `dashboard/`, `notifications/`, `action-requests/`                             | 36, 48, 62; 27 needs a narrow, consent-based station Inbox route (no impersonation)                                                                 |
| **B Storage unit and receiving**           | 72, 74, 75, 76, 77, 78, 106 (location storage term, migration) | `inventory/` unit and shelf pages, `receiving/`, `receiving-log/`, `printing/` | none. Label and tag print output stay black on white and are not restyled                                                                           |
| **C Inventory, move, retention, disposal** | 79, 80, 90, 91, 92                                             | `inventory/` list, `moves/`, `retention/`, `disposal/`, `scanning/`            | 110, 111, 112, 113. The offline disposal queue replays with re-checks and idempotency, and never shows a unit as disposed before the server commits |
| **D Projects and soils lab**               | 83, 84, 85, 86, 87, 88, 89                                     | `projects/` (not concrete tabs), `lab/`                                        | none. Lab program routes stay `/lab-testing/programs`, with aliases if needed                                                                       |
| **E Concrete**                             | 93, 95 (Breaks A), 96, 97, 98, 120, 121, 99                    | `concrete/`, `concrete-review/`, the project Concrete tabs                     | 99 (G2): build up to the gate and keep the existing strength output                                                                                 |
| **F Settings, help, feedback**             | 28, 100, 101, 102, 118, 119, 128, 29, 103, 104                 | `settings/`, `pages/HelpPage`, `feedback`                                      | 68 (help content)                                                                                                                                   |

Suggested pairing to keep three lanes busy: B, D and F first, then A, C and E. A waits on 1C's
feed, C on the 106 storage term from B, and E is the largest lane.

## Wave 3: Integration and quality (one session)

Cards: 32, 33, 71, 50, plus cleanup.

1. Merge order on `redesign/strata`: wave-2 PRs as they finish, resolving shared-file conflicts.
2. Delete the Field Ledger CSS, variables, `app-ui.tsx` parts and fonts that nothing uses.
3. Accessibility pass: light and dark, 1024 px, 200 % zoom, keyboard and focus, reduced motion,
   forced colours, and Back and reload on every `?open=` URL.
4. Update unit tests and the 77 E2E specs for the new shell and labels in the same PRs that change
   them. Wave 3 runs the whole suite and fixes leftovers.
5. Re-run `/impeccable critique` and `audit` against the running app (STRATA-71), not the canvas,
   and fix what they find.
6. Mark Field Ledger's `docs/redesign/` as superseded by `DESIGN.md`.

## Wave 4: Release

Open one PR from `redesign/strata` into `main` with: what changed, what was built new, what
stopped at a gate, and the manual checks for you. **You merge it.**

```
wave 0 → wave 1 (1C types first; 1A 1B 1C in parallel) → wave 2 (B D F, then A C E) → wave 3 → PR to main (Kyle merges)
```

## Verification (every PR)

- `npm run verify` (lint, typecheck, tests, build, bundle check) and `npm run test:e2e` on Windows
  with the lane's `E2E_PORT`. I never call a skipped check passed.
- Changed state or permissions get focused behaviour and security tests, including direct API
  calls that must be refused.
- A screenshot pass with the preview browser at 1440 and 1024 px in light and dark, compared
  against the board it implements.
- Fictional data only (DEMO-2601, TH26-01 and the dev seed). No real people or email.

## Status

- 2026-11-12: plan approved by Kyle, including Claude merging lane PRs into `redesign/strata`
  (never into `main`). `redesign/strata` cut from `origin/main` 0482b27 with the design files from
  PR #181. Wave 0 started.
