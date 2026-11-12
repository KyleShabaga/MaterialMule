---
target: every board on both canvases (design/strata-canvas/project), after the critique fixes
date: 2026-11-12
canvas_version: main 88, concrete-and-settings 5
total_score: 15
max_score: 20
p0: 0
p1: 1
p2: 5
p3: 2
---

# Strata audit: every board on both canvases (after the critique fixes)

Scope: 517 board files: main canvas v88 (12 pages) and concrete-and-settings canvas v5. Evidence:
- an in-page probe in every frame of 461 boards (component files excluded): text contrast against the real background, accessible names, target sizes, headings, landmarks, labels and duplicate IDs;
- an h1 and main-landmark recount that includes screen-reader-only headings;
- the Impeccable detector, static on all 516 files and rendered on 30 representative boards (light, dark, 1024);
- a table-overflow probe on every board;
- source greps for colours and animations;
- a visual check of the flagged boards.

Phones remain out of scope (Kyle, 2026-11-11).

## Audit Health Score
| # | Dimension | Score | Key Finding |
|---|---|---|---|
| 1 | Accessibility | 3 | Dark mode: red error text (3.4:1) and indigo link-style buttons (3.3:1) fail AA; 52 list and state boards have no h1 |
| 2 | Performance | 3 | Width and margin transitions on the sidebar and quick actions; the canvas bundle is 1.39 MB (mock-up only, not shipped) |
| 3 | Theming | 3 | Tokens everywhere, light and dark; `--destructive` is the same in both themes, and link buttons use `primary` instead of `link` |
| 4 | Responsive Design | 3 | Every page has a 1024 px board; column priority holds on all boards; Move's sticky count bar covers the last rows |
| 5 | Implementation Integrity | 3 | 65 static detector hits, 44 false positives; real: nested cards in Retention, Project and Program, skipped headings in R8, Move overlap |
| **Total** | | **15/20** | **Good** |

## Implementation Integrity Verdict
**Pass.** The canvases express one product-specific system:
- One stage token set drives stripes, tags and the lifecycle track.
- Tables follow one column-priority rule; the overflow probe finds nothing on every board apart from the intended scrolling sample grid.
- Station attribution comes from one state.
- Red is reserved for act-now states.

There are no raw Tailwind palette colours. Hard-coded hex is confined to the printed label and report paper (black on white by rule) and the component showcase boards.

The detector agrees:
- 8 of 30 rendered boards came back clean.
- The 44 static `flat-type-hierarchy` hits are false positives: the boards' relative stylesheet link doesn't resolve in a static scan, and the rendered scan clears them.

## Executive Summary
- Audit Health Score: **15/20 (Good)**. The previous audit, of 46 boards, also scored 15; this one covers all 517.
- Issues: P0 0 · P1 1 · P2 5 · P3 2.
- Top issues:
  1. Dark-mode text contrast for red error text and link-style buttons (P1, systemic, token-level).
  2. List pages with no h1: Lab programs, Workboard, Projects and the Review queue, plus loading and error states (P2).
  3. h1 → h3 skips on the field report and strength report review pages (P2).
  4. Move's sticky count bar covers the last scanned rows (P2).
  5. Cards nested inside cards in Retention, Project overview and Program (P2).
- Next: fix the two dark tokens and the link-button colour once in `strata-ui` (one change fixes about 40 places), add page h1s, then polish.

## Detailed Findings by Severity

**[P1] Dark-mode red text and link buttons below 4.5:1**
- Location: `strata-ui/src/index.css` (`.dark --destructive: #ce2c31`, identical to light) and the `link`/ghost button variants, which use `primary` (#555bdc) as text.
- Seen on R6ScanDark (scan error rows, 3.4:1), R9StaffDark and R9LocationsDark ("Disable access…" and "Retire location…", 2.5:1), R7TestingDark ("Retry", 3.3:1), R7SetDark, R10CallbackDark and R10HelpPageDark ("Help", "Feedback & bugs", 3.5:1), and R3MoveDark (3.6:1).
- Category: Accessibility / Theming.
- Impact: error messages and actions are hard to read on dark screens at the bench.
- Standard: WCAG 2.2 SC 1.4.3.
- Fix: give `.dark` its own `--destructive` (Radix red dark step 11, about #ff9592) or a `destructive-text` token. Make link-style buttons use `text-link` (#9eadff in dark).
- Command: /impeccable colorize.

**[P2] Pages without an h1**
- Location: 52 boards, including:
  - R5ListOpen/Drafts/Closed/Peek, R5WorkboardBoard/List;
  - R4List* (Projects);
  - R8Queue* (Review);
  - loading and error states (UnitLoading, R4Loading/Error, R8ReportLoading/Error, R7OverviewLoading, R7SetLoading).
- The title exists only as text in the top bar.
- Category: Accessibility.
- Impact: screen-reader users can't jump to the page title, and heading navigation starts mid-page.
- Standard: WCAG 2.4.6 / 1.3.1 (best practice).
- Fix: an `sr-only` h1 per page, as Inventory and Testing already have; loading and error states keep the page's h1.
- Command: /impeccable harden.

**[P2] Heading level skips on review pages**
- Location: R8ReportContent (h1 "Field report…" then h3 "Project") and R8StrengthContent (h1 then h3 "Set"); 18 boards.
- Category: Accessibility.
- Impact: the report outline reads as missing a level.
- Fix: the paper's section headings become h2, or add an h2 "Review copy" above them.
- Command: /impeccable harden.

**[P2] Sticky count bar covers the last rows on Move**
- Location: R3Move (the detector's text-occlusion ×4, confirmed on screen) and similar sticky bars (R6Scan, R2Entry).
- Category: Responsive.
- Impact: the last scanned unit's destination and message sit under the bar.
- Fix: bottom padding on the scroll area equal to the bar's height.
- Command: /impeccable layout.

**[P2] Nested cards**
- Location: R6RetentionContent (×10), R4Project overview (×3–4), R5Program (×1–2).
- Category: Implementation Integrity.
- Impact: extra borders compete with the stage stripes and add depth with no meaning.
- Fix: inner groups become rows or sections divided by borders.
- Command: /impeccable distill.

**[P2] Small text at reduced opacity**
- Location: R8Project* tab counts (`font-mono text-[11px] opacity-80`, 3.8:1) and R6Scan's "Already scanned. Counted once." (opacity stack, 3.4:1).
- Category: Accessibility.
- Fix: `text-muted-foreground` with no opacity.
- Command: /impeccable polish.

**[P2] Controls without names**
- Location:
  - The command palette input (`data-slot=command-input`, a placeholder only) on R3InventoryCtrlK, R3InventoryScanRedirect and R5EditorAddtest.
  - The disabled switch on R9TechNotifications.
- Category: Accessibility.
- Fix: `aria-label` "Search or scan a label" on CommandInput, and `aria-labelledby` on the switch.
- Command: /impeccable harden.

**[P3] Two h1s when a dialog is open over a page**
- Location: the R9 modal boards (Settings "Profile" over Today's "Good morning, Pat").
- Fix: the dialog title becomes h2, and the page behind becomes `inert`.
- Command: /impeccable harden.

**[P3] Em-dash run and stragglers**
- Location: R8StrengthContent (15 em-dashes) and the two-word last lines in R8 copy.
- Command: /impeccable clarify.

**Not issues (verified):**
- The 345 "Toggle Sidebar 16×800" hits are the sidebar rail; Ctrl B and the trigger are the equivalent control.
- The 20 px breadcrumb and inline links fall under the inline-text exception.
- The 16 px checkboxes and 19 px ID link buttons in 52 px rows pass by spacing (SC 2.5.8).
- Contrast hits on disabled buttons ("New field report", "Record disposal", "Mark reviewed"…) are exempt.
- The radial glow on R10 is Kyle's sign-in gradient.
- Text-occlusion on the R9 modal boards is the dialog over a dimmed page.

## Patterns & Systemic Issues
- **Dark-mode text colours come from tokens chosen for fills.** `destructive` and `primary` work as backgrounds but fail as text on dark surfaces. One token fix covers about 40 places.
- **Page titles live only in the top bar** on boards drawn in the earlier rounds (5, 4, 8); the later rounds added sr-only h1s.
- **Sticky action bars** need matching scroll padding wherever they are used.

## Positive Findings
- No unlabelled inputs, no duplicate IDs, no images without alt, and a `prefers-reduced-motion` rule in every frame.
- Tokens are used throughout; no raw palette colours. Dark mode exists for every page family.
- Every page now has a 1024 px board, and the overflow probe is clean apart from the intended scrolling grid.
- Tables carry `aria-sort`, named resize handles and labelled row checkboxes; scan lists use `role=status`/`aria-live`.
- Disabled actions say why; confirm dialogs name IDs and counts.

## Recommended Actions
1. **[P1] `/impeccable colorize`:** give `.dark` its own `--destructive` text value and make link and ghost-link buttons use `text-link`. Re-check R6ScanDark, R9StaffDark, R7TestingDark and R10HelpPageDark.
2. **[P2] `/impeccable harden`:**
   - add sr-only h1s on Lab programs, Workboard, Projects and the Review queue, and keep them in loading and error states;
   - fix the h1 → h3 skips in R8 review;
   - name the CommandInput and the disabled switch;
   - make dialog titles h2.
3. **[P2] `/impeccable layout`:** add bottom scroll padding under sticky count bars (Move, Disposal scan, Receive).
4. **[P2] `/impeccable distill`:** flatten the nested cards in Retention, Project overview and Program.
5. **[P3] `/impeccable clarify`:** trim the em-dashes in the strength report copy.
6. **`/impeccable polish`:** remove the opacity-reduced small text (R8 tab counts, R6Scan) and do a final pass.
