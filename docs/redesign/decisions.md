# Field Ledger: decision log

Kyle's instruction, 2026-11-10: "If anything comes up make and choose a recommendation. And
continue working until everything is completed. Make a note of your choices."

Every session adds a row here, in the same PR as the work, whenever it chooses between real
alternatives without asking. Keep rows short: what came up, what was chosen, why, and how to undo it.

This does not cover the gates and deferred decisions in `CLAUDE.md` and `docs/concrete.md`
(concrete G2/G8, report templates, offline entry, set numbering, billing D16–D18, sign-in timing
D38, IT/pilot D39). Those are never chosen for Kyle: build up to the gate and list it under
"Stopped at a gate".

## Decided by Kyle

| Date       | Question                 | Decision                                                           |
| ---------- | ------------------------ | ------------------------------------------------------------------ |
| 2026-11-10 | Dark mode                | Derive a dark variant; the theme switch keeps working              |
| 2026-11-10 | Scope                    | Build everything on the canvas, except gated items                 |
| 2026-11-10 | Models                   | Multiple sessions and agents, Opus 5.5 at medium effort            |
| 2026-11-10 | When to start            | After PR 170 is merged                                             |
| 2026-11-10 | Open questions from here | Sessions choose their own recommendation and note it here          |
| 2026-11-10 | Final merge into `main`  | Claude merges it when CI is green (Kyle: "Do the merge your self") |

## Chosen by Claude

| Date       | Session | What came up                               | Choice                                                                                                                              | Why                                                                                        | To undo                                       |
| ---------- | ------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 2026-11-10 | plan    | Where lanes merge                          | An integration branch `redesign/field-ledger`; one PR to `main` at the end                                                          | `main` never shows a half-restyled app                                                     | Merge lanes to `main` one by one instead      |
| 2026-11-10 | plan    | How lanes see the design                   | A copy of the 75 artboards in `docs/redesign/canvas/`, excluded from Prettier                                                       | The canvas is private; sessions need exact sizes                                           | Delete the folder after release               |
| 2026-11-10 | plan    | How to split the screens                   | Six lanes by folder (A Today and entry, B Receiving, C Inventory, D Lab, E Projects/settings, F Concrete)                           | Lanes never edit the same files                                                            | Re-split in the plan                          |
| 2026-11-10 | plan    | Printed labels and tags                    | Not restyled; only their on-screen preview chrome changes                                                                           | They are physical output matched to the printers                                           | Separate card                                 |
| 2026-11-10 | plan    | Lab-staff "Concrete Lab" menu group        | Folded into the Concrete drop-down in the rail                                                                                      | The canvas has one Concrete group; two would duplicate links                               | Restore the group in `layout/nav.ts`          |
| 2026-11-10 | wave 0  | Old variable names                         | Kept every old name (`--page`, `--card`, `--accent`, ...) mapped onto Field Ledger values; added the Field Ledger names beside them | Feature CSS keeps working until lanes rebuild pages                                        | Rename in wave 2 cleanup                      |
| 2026-11-10 | wave 0  | Dark rules and selected fills              | Rules soften to `#D9D9CF`; ink-filled controls invert to paper fill with ink text; hover tints flip                                 | A 2 px paper rule on ink glares; an ink fill would vanish on an ink ground                 | Edit the dark token blocks in `styles.css`    |
| 2026-11-10 | wave 0  | Badge tones                                | Old tones map onto the five tags (success = storage, info = lab, warning = waiting, neutral = closed); new tone `flag`              | No page call sites need changing                                                           | Change the `.badge-*` rules                   |
| 2026-11-10 | wave 0  | Rail destination targets                   | Receive opens `/receiving-log`, Lab programs `/lab-testing`, Retention `/disposal-retention`, Concrete `/concrete`; URLs unchanged  | The list-level page of each area; routes stay as they are                                  | `layout/nav.ts`                               |
| 2026-11-10 | wave 0  | Concrete group for non-lab staff           | Everyone sees Breaks, Holds and Review; lab staff also see Receiving and Specimens                                                  | Matches what each group reached before the fold; navigation only, the server still decides | `layout/nav.ts`                               |
| 2026-11-10 | wave 0  | Field reports in the Concrete group        | Omitted                                                                                                                             | No app-wide field-report list route exists and field entry is gated                        | Add the link when the route exists            |
| 2026-11-10 | wave 0  | Testing table and Concrete equipment links | Dropped from the rail                                                                                                               | Testing table opens from the Concrete dashboard; Equipment is in Settings                  | Add sub-pages in `layout/nav.ts`              |
| 2026-11-10 | wave 0  | Pending actions                            | A rail-footer link to `/action-requests` (and in the phone More sheet) with a flag count tag; the header preview panel is removed   | Kyle wants only search and the bell in the top bar; nothing else links to the page yet     | `SidebarFooter.tsx`, `ActionRequestsBell.tsx` |
| 2026-11-10 | wave 0  | Help & Feedback                            | A `/help` route with a placeholder page                                                                                             | Kyle wants the link in the rail footer; lane A builds the page                             | `routes.tsx`, `pages/HelpPage.tsx`            |
| 2026-11-10 | wave 0  | Shared LAB station controls                | "Switch user" and "Session ends" sit under the account row for LAB only                                                             | They left the top bar with the identity area                                               | `SidebarFooter.tsx`                           |
| 2026-11-10 | wave 0  | Account row name                           | Kept `role="group"` named "Signed in user"                                                                                          | Existing specs find the person there                                                       | `SidebarFooter.tsx`                           |
| 2026-11-10 | wave 0  | Top-bar search                             | Still the existing lab search (same gating), named "Search", text box not `type=search`                                             | Lane A wires search across units, samples, projects and programs                           | `LabSearchPage.tsx`                           |
| 2026-11-10 | wave 0  | Browser tab titles                         | Keep the old area names in wave 0                                                                                                   | Pages keep their headings until their lane rebuilds them                                   | `layout/page-title.ts`                        |
| 2026-11-10 | wave 0  | Table view hook                            | `useTableView` lives in `components/useTableView.ts`, stored as `materialmule:table-view:<key>`                                     | Fast-refresh lint rule; per-table memory in the browser                                    | Move it back to `ui.tsx`                      |
