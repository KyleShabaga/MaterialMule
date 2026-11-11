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

| Date       | Session | What came up                        | Choice                                                                                                    | Why                                                          | To undo                                  |
| ---------- | ------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| 2026-11-10 | plan    | Where lanes merge                   | An integration branch `redesign/field-ledger`; one PR to `main` at the end                                | `main` never shows a half-restyled app                       | Merge lanes to `main` one by one instead |
| 2026-11-10 | plan    | How lanes see the design            | A copy of the 75 artboards in `docs/redesign/canvas/`, excluded from Prettier                             | The canvas is private; sessions need exact sizes             | Delete the folder after release          |
| 2026-11-10 | plan    | How to split the screens            | Six lanes by folder (A Today and entry, B Receiving, C Inventory, D Lab, E Projects/settings, F Concrete) | Lanes never edit the same files                              | Re-split in the plan                     |
| 2026-11-10 | plan    | Printed labels and tags             | Not restyled; only their on-screen preview chrome changes                                                 | They are physical output matched to the printers             | Separate card                            |
| 2026-11-10 | plan    | Lab-staff "Concrete Lab" menu group | Folded into the Concrete drop-down in the rail                                                            | The canvas has one Concrete group; two would duplicate links | Restore the group in `layout/nav.ts`     |
