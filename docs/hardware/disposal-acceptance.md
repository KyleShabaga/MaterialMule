# Disposal, retention and post-testing removal: hardware acceptance (MM-T27/T29/T30/T36)

A repeatable check on the real kit: the Zebra DS3678-XR scanner ([ds3678-xr.md](ds3678-xr.md)),
a phone using the camera ([phone-camera.md](phone-camera.md)) and two shared LAB computers. It does
not replace the existing gates: the MM-T16 scanner test, the MM-T17 phone test, the MM-T22 pilot
and the hosting/HTTPS/backup gates in [../operations/runbook.md](../operations/runbook.md) all stay
open until recorded there.

**Status: Not Run.** No physical scanner, phone or second LAB station was available when MM-T30
was built; the automated suites cover the same rules with simulated input. Kyle (or whoever runs it)
records each result below. Use fictional data only (project DEMO-2601, test hole TH26-01).

## Before you start

- Build under test: commit SHA \_\_\_\_\_\_\_\_ (`GET /api/health` shows the version), host \_\_\_\_\_\_\_\_.
- Devices: scanner serial \_\_\_\_\_\_\_\_; phone model / OS / browser \_\_\_\_\_\_\_\_; LAB station A
  \_\_\_\_\_\_\_\_; LAB station B \_\_\_\_\_\_\_\_.
- People (personal sign-ins): a Lab Manager (LM), the project's Lead Project Engineer (PE) and a Technician (AT).
- Units, printed with real labels on DEMO-2601:
  - **U1** a bucket received more than a year ago on its own hole, no program, no hold;
  - **U2** a second bucket like U1;
  - **T1** a Shelby tube sourced from TH26-01, and **T2** an untested Shelby tube;
  - **BKT-A** and **BKT-B**, two buckets of one bulk sample group;
  - a lab program on TH26-01 covering T1, and one on the bulk group, both left open.
- Evidence for each check: a photo or screenshot of the device screen, plus the storage unit's
  History section afterwards.

## Checks

| #   | Steps                                                                                                                                                                                       | Expected                                                                                                                                                     | Actual | Device / evidence | Date / initials |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------- | --------------- |
| 1   | Scan U1's Code 128, then its QR, on Sample Storage → Scan labels (scanner), then with the phone camera.                                                                                     | Each opens U1's own page; no other unit.                                                                                                                     |        |                   |                 |
| 2   | As LM, Disposal & Retention → DEMO-2601: tick U1 and U2, Approve, confirm.                                                                                                                  | Summary lists both with their retain-until dates; both show **Approved for disposal**; neither is disposed; both still at their location in Sample Storage.  |        |                   |                 |
| 3   | As LM, place a hold on U2 (unit page → Retention → Add hold). Then Disposal scan (scanner) U2.                                                                                              | Red **Blocked: On hold: …**; U2 stays approved and at its location; its History shows the refused scan.                                                      |        |                   |                 |
| 4   | Disposal scan U1 with the scanner, then again.                                                                                                                                              | First **Disposed**; second "already disposed". U1 leaves Current stock, shows under Status: Disposed, and keeps its History and last location.               |        |                   |                 |
| 5   | Phone: open Disposal scan, switch to airplane mode, try to scan U2; switch back.                                                                                                            | Offline: input disabled with "switched off while offline, and nothing is saved or queued". After reconnecting nothing has been recorded for U2.              |        |                   |                 |
| 6   | Release U2's hold (reason), Disposal scan U2 on the phone.                                                                                                                                  | **Disposed**, with the phone user as remover and the time.                                                                                                   |        |                   |                 |
| 7   | LAB station A, selecting LM for lab work, then LAB station B selecting PE: open Disposal scan; open U-units' Retention; open T1's page.                                                     | Both stations: "Disposal scans need a personal sign-in", no hold/extension or approval controls, no Confirm removal after testing, no Action requests bell.  |        |                   |                 |
| 8   | On LAB station A (person JS), mark T1's test In progress then Completed, ticking T1 as tested; do the same for BKT-A on the bulk program.                                                   | Progress records LAB for JS. T1 and BKT-A stay in stock at their locations; Retention shows "Not applicable"; nothing is disposed by completion.             |        |                   |                 |
| 9   | Put a project-wide hold on DEMO-2601 and an extension to a future date (LM). As AT (personal, on a third computer), open T1 → Confirm removal after testing, tick the physical-removal box. | T1 becomes **Disposed after testing**, with the completed test named, despite the hold, extension and open program. No approval was asked for.               |        |                   |                 |
| 10  | Same for BKT-A. Then check BKT-B and T2.                                                                                                                                                    | BKT-A **Disposed after testing**. BKT-B and T2 stay in stock at their own locations, **On hold**, with no removal offered; the project hold is still active. |        |                   |                 |
| 11  | On LAB station B (still showing the old page), try to move T1 and U1 to another shelf, and replay a queued offline move of U1 if one exists.                                                | Each move is refused as disposed; refreshing shows Disposed / Disposed after testing; nothing returns to stock.                                              |        |                   |                 |
| 12  | Scan U1's and T1's labels on Scan labels after removal; open Sample Storage → Status: Disposed.                                                                                             | Both still open their pages (searchable), with full History (receipt, moves, tests, approval, removal) and last location.                                    |        |                   |                 |
| 13  | As AT, request a hold on U-unit of your choice (Retention → Request); as PE, open the bell → the request → Approve on the project page.                                                     | PE and LM both saw one item; after approval it shows **Resolved by PE · Approved** for both; the hold is active with AT's reason.                            |        |                   |                 |
| 14  | Location occupancy: after the removals, open Settings → Locations for the shelves the units were on.                                                                                        | Removed units no longer count as occupying their last location.                                                                                              |        |                   |                 |

## Result

Physical acceptance: **Not Run** until every row has an actual result. A failed row is recorded
as Failed with what happened; do not mark MM-T30 acceptance Passed from the automated suites alone.
Email is not part of this check: sending stays disabled until IT approves it (MM-T27).
