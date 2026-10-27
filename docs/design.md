---
name: Material Mule
theme: system # follows prefers-color-scheme; dark values first, light values under Colors
source: https://claude.ai/artifact/2NqGwsbofmjSShjyCn1iti # the Material Mule design system
colors: # dark theme
  shell: '#000F21'
  page: '#031427'
  card: '#07182C'
  card-head: '#0B1F38'
  inset: '#061426'
  line: '#1B385A'
  line-shell: '#1E3A5F'
  line-control: '#64748B'
  ink: '#F1F5F9'
  ink-soft: '#CBD5E1'
  muted: '#94A3B8'
  disabled: '#64748B'
  accent: '#38BDF8'
  accent-ink: '#7DD3FC'
  accent-bg: '#082F49'
  accent-line: '#075985'
  primary: '#0369A1'
  primary-active: '#075985'
  on-primary: '#FFFFFF'
  focus: '#38BDF8'
  success: '#34D399'
  success-bg: '#064E3B'
  success-line: '#059669'
  warning: '#F59E0B'
  warning-bg: '#451A03'
  warning-line: '#D97706'
  warning-panel: '#1D1203'
  warning-panel-ink: '#FDE68A'
  danger: '#F87171'
  danger-bg: '#450A0A'
  danger-line: '#DC2626'
  danger-panel: '#1F0A10'
  danger-panel-ink: '#FCA5A5'
  info: '#38BDF8'
  info-bg: '#082F49'
  info-line: '#0284C7'
  neutral: '#94A3B8'
  neutral-bg: '#1E293B'
  neutral-line: '#475569'
  review: '#C084FC'
  review-bg: '#2E1065'
  review-line: '#7C3AED'
  label-paper: '#FFFFFF'
  label-ink: '#000000'
  scrim: 'rgba(0, 0, 0, 0.6)'
typography:
  page-title:
    {
      fontFamily: Inter,
      fontSize: 24px,
      fontWeight: '700',
      lineHeight: 32px,
      letterSpacing: -0.6px,
    }
  card-title: { fontFamily: Inter, fontSize: 17px, fontWeight: '700', lineHeight: 24px }
  section-label:
    {
      fontFamily: Inter,
      fontSize: 13px,
      fontWeight: '600',
      lineHeight: 20px,
      letterSpacing: 0.35px,
    }
  scan-message: { fontFamily: Inter, fontSize: 28px, fontWeight: '700', lineHeight: 36px }
  body-lg: { fontFamily: Inter, fontSize: 16px, fontWeight: '400', lineHeight: 24px }
  body: { fontFamily: Inter, fontSize: 14px, fontWeight: '400', lineHeight: 20px }
  small: { fontFamily: Inter, fontSize: 12px, fontWeight: '400', lineHeight: 16px }
  header-ui: { fontFamily: Inter, fontSize: 12px, fontWeight: '500', lineHeight: 16px }
  id-xl: { fontFamily: JetBrains Mono, fontSize: 32px, fontWeight: '700', lineHeight: 40px }
  id-lg: { fontFamily: JetBrains Mono, fontSize: 22px, fontWeight: '700', lineHeight: 28px }
  id: { fontFamily: JetBrains Mono, fontSize: 14px, fontWeight: '600', lineHeight: 20px }
  label-mono:
    {
      fontFamily: JetBrains Mono,
      fontSize: 11px,
      fontWeight: '600',
      lineHeight: 16px,
      letterSpacing: 1px,
    }
  badge:
    {
      fontFamily: JetBrains Mono,
      fontSize: 11px,
      fontWeight: '500',
      lineHeight: 14px,
      letterSpacing: 0.55px,
    }
rounded:
  radius-tag: 2px # badges, ID badges, tags, chips, step numbers, menu items, header buttons
  radius-control: 4px # buttons, inputs, cards, dialogs, drawers
  # No pill radius: nothing in the app is pill-shaped (Kyle, 2026-10-26).
spacing:
  space-1: 4px
  space-2: 8px
  space-3: 12px
  space-4: 16px
  space-5: 20px
  space-6: 24px
  space-8: 32px
  space-16: 64px
breakpoints:
  phone: 640px # and below
  tablet: 1024px # 641-1024
sizes:
  target: 44px # phone, tablet and the LAB station
  control: 40px # desktop controls; never below 36px
  header-height: 56px
  sidebar-width: 224px
  drawer-width: 512px
  dialog-width: 480px
  content-max: 896px
---

# Material Mule design guide

Material Mule tracks laboratory sample **storage units** for a geotechnical and materials consulting
firm: receiving and labelling, inventory and location, lab testing progress, retention and disposal.
This guide sets how its screens look, read and behave. The front matter above holds the tokens; the
sections below say how to use them.

Status of this guide (2026-10-27): the **source of truth for tokens and components is the
[Material Mule design system](https://claude.ai/artifact/2NqGwsbofmjSShjyCn1iti)** (its
`tokens.json`, brand book and `mm-` component previews). This file mirrors it for people working in
the repo; the approved screens live on the
[Material Mule UI canvas](https://claude.ai/artifact/5VUohfcm8SJdYtiHSuME3B). The palette is the navy
look from Kyle's Figma, checked for WCAG 2.2 AA in both themes, and `apps/web/src/styles.css` uses
these tokens as of the consistency pass. Items marked **Proposal — pending Kyle** are not decided;
don't build them until Kyle confirms.

## Who uses it, and where

| Setting                        | Device and input                                                        | What that means for the UI                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Office desks                   | Windows PCs, mouse and keyboard, sometimes two monitors                 | Dense tables are fine; keep every action reachable by keyboard.                                              |
| Receiving station (shared LAB) | Shared PC signed in as LAB, DS3678-XR scanner (keyboard wedge)          | One person after another; show who is receiving, keep scan focus, big status text readable from a step back. |
| Warehouse and core library     | Phones on the office/warehouse Wi-Fi, phone camera for occasional scans | Single column, ≥44px targets, sticky primary action, readable under fluorescent light and glare.             |
| Label printer                  | Zebra ZD621, 3.5 × 1.5 in labels                                        | Labels and print views are black on white and never follow the screen theme.                                 |

There is no off-site access and no installed phone app (D22, D25). Pages must work in current Edge
and Chrome on Windows, and Safari and Chrome on phones.

## Brand and style

Authoritative, industrial and plain. The interface is a tool on a lab floor, not a product page: it
favours fast reading, clear accountability (who did what, when) and honest status over decoration.

- **Look:** structural lines, tonal layers, high-contrast status, monospaced identifiers. No
  gradients, glows, illustrations or emoji.
- **Shape:** "soft industrial" — square-ish corners. **Nothing is pill-shaped** (Kyle, 2026-10-26): badges,
  ID badges, tags and chips use `radius-tag` (2px) like the header and sidebar; buttons, inputs,
  cards, dialogs and drawers use `radius-control` (4px). Badges are told apart from buttons by size,
  mono type and having no hover state.
- **Name and mark:** the product is **Material Mule** (renamed from Trapezoid on 2026-10-26). The
  mark is the **walking donkey** (design system Logos, adopted 2026-10-26): a one-colour silhouette
  drawn in `currentColor` (`apps/web/src/layout/DonkeyMark.tsx`), so it is `accent` — cyan in dark,
  blue in light. It sits in a 32px `card-head` box with a 1px `accent-line` edge in the header (48px
  on sign-in pages), always beside the name in uppercase, and is decorative (`aria-hidden`).

## Voice and wording

Write for a lab technician holding a bucket: short, plain, specific.

### Confirmed terms (App Idea "Purpose" and decisions)

| Use                   | Not                                       | Notes                                                                                            |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Storage unit          | container, item, sample (for the holder)  | General term for any tracked holder. "Bucket" is a storage-unit type.                            |
| Storage unit ID       | barcode, tag, SU number                   | Format `PREFIX-YYYY-NNNNNN`: `BKT-2026-000019`, `ST-…`, `CRE-…`, `CT-…`. Never shortened.        |
| SAMPLE#/DEPTH summary | sample list, sample inventory             | One per test hole per storage unit at receiving. Individual samples appear only in lab requests. |
| Receiving lab         | lab, location (for where it was received) | Reference data.                                                                                  |
| Test hole             | borehole, TH (alone)                      | IDs like `TH26-01`.                                                                              |
| Shared station: LAB   | kiosk, generic account                    | The badge text in the header.                                                                    |

Navigation labels follow the side-menu order Kyle set on 2026-10-25 (Dashboard, Receiving Log,
Sample Storage, Lab Testing Worklist, Testing Programs, Disposal & Retention, Projects, Settings).
Don't rename them in a design pass.

### Writing rules

- **Sentence case** for headings, buttons and labels ("Receive samples", not "Receive Samples").
  Uppercase appears only through CSS (`text-transform`) on badges and table headers, so screen
  readers still read normal words.
- **Buttons say what happens:** a verb plus the thing — "Confirm receipt", "Print labels",
  "Save correction". Avoid "OK", "Submit", "Yes".
- **Plain-language errors** say what went wrong and what to do next, in the person's terms, without
  codes, stack traces or blame: "The printer didn't answer. Check it's on and try again." Not
  "ECONNREFUSED" or "Invalid input". Field errors name the field and the fix: "Enter a reason (at
  least 5 characters)."
- **Honest status:** never claim more than the app knows. A print job is "Sent to printer" until a
  person confirms it printed; "Unknown — check the printer before reprinting" when it can't tell.
- **Times** are shown in the firm's local time (America/Edmonton) with `en-CA` formatting
  (`Oct 26, 2026, 2:05 p.m.`), never UTC. Durations read like "4 min" or "2 h 5 min".
- **Numbers and units:** depths always carry their unit (m or ft); keep the unit the person chose.
- **Fictional data only** in examples, screenshots and tests: project DEMO-2601, test holes TH26-01
  and TH26-02.

## Colors

Navy tonal layers separated by 1px lines, a cyan accent for "where you are" and links, one blue
primary button per view, and status tones that always come with a word. Every token is defined for
both themes; the app follows the operating system's light or dark setting (decided by Kyle,
2026-10-26). Labels and print views are black on white in both.

| Token                                     | Dark                      | Light                     | Use                                                                                                           |
| ----------------------------------------- | ------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `shell`                                   | #000F21                   | #F8FAFC                   | Header, side menu, field fill                                                                                 |
| `page`                                    | #031427                   | #F1F5F9                   | Page ground                                                                                                   |
| `card`                                    | #07182C                   | #FFFFFF                   | Cards, tables, drawers                                                                                        |
| `card-head`                               | #0B1F38                   | #F8FAFC                   | Card header band, table header, dialogs, secondary buttons                                                    |
| `inset`                                   | #061426                   | #F8FAFC                   | Nested groups (fieldsets), striped rows                                                                       |
| `line`                                    | #1B385A                   | #E2E8F0                   | Decorative edges only                                                                                         |
| `line-shell`                              | #1E3A5F                   | #CBD5E1                   | Header and menu borders                                                                                       |
| `line-control`                            | #64748B                   | #64748B                   | Edges of inputs, selects, checkboxes, secondary buttons (4.0:1 on `shell`, 3.8:1 on `card` dark; 4.8:1 light) |
| `ink`                                     | #F1F5F9                   | #0F172A                   | Body text (16.3:1 / 17.9:1 on `card`)                                                                         |
| `ink-soft`                                | #CBD5E1                   | #334155                   | Secondary text, dialog body (12.0:1 / 10.4:1)                                                                 |
| `muted`                                   | #94A3B8                   | #475569                   | Labels, hints (7.0:1 / 7.6:1 on `card`)                                                                       |
| `disabled`                                | #64748B                   | #64748B                   | Disabled control text, with the `disabled` attribute                                                          |
| `accent`                                  | #38BDF8                   | #0369A1                   | Links, the active menu item and tab (8.3:1 / 5.9:1)                                                           |
| `accent-ink`, `accent-bg`, `accent-line`  | #7DD3FC, #082F49, #075985 | #075985, #E0F2FE, #7DD3FC | Mono tags for project numbers and test holes (8.3:1 / 6.6:1)                                                  |
| `primary`, `primary-active`, `on-primary` | #0369A1, #075985, #FFFFFF | same                      | The one primary button per view (white text 5.9:1)                                                            |
| `focus`                                   | #38BDF8                   | #0369A1                   | 2px focus ring, 2px offset                                                                                    |
| `success`, `success-bg`, `success-line`   | #34D399, #064E3B, #059669 | #047857, #ECFDF5, #059669 | Success badges and notices (5.1:1 / 5.2:1)                                                                    |
| `warning`, `warning-bg`, `warning-line`   | #F59E0B, #451A03, #D97706 | #B45309, #FFFBEB, #D97706 | Warning badges (7.0:1 / 4.8:1); attention card edges                                                          |
| `warning-panel`, `warning-panel-ink`      | #1D1203, #FDE68A          | #FFFBEB, #92400E          | Amber notices (14.8:1 / 6.8:1)                                                                                |
| `danger`, `danger-bg`, `danger-line`      | #F87171, #450A0A, #DC2626 | #B91C1C, #FEF2F2, #DC2626 | Danger badges, field errors, destructive buttons (5.8:1 / 5.9:1)                                              |
| `danger-panel`, `danger-panel-ink`        | #1F0A10, #FCA5A5          | #FEF2F2, #991B1B          | Error summaries, red notices (10.0:1 / 7.6:1)                                                                 |
| `info`, `info-bg`, `info-line`            | #38BDF8, #082F49, #0284C7 | #0369A1, #F0F9FF, #0284C7 | Info badges; the "Changed" bar on corrected fields                                                            |
| `neutral`, `neutral-bg`, `neutral-line`   | #94A3B8, #1E293B, #475569 | #475569, #F1F5F9, #94A3B8 | Neutral badges (Disposed, Disabled)                                                                           |
| `review`, `review-bg`, `review-line`      | #C084FC, #2E1065, #7C3AED | #6D28D9, #F5F3FF, #7C3AED | Reserved: lab review states                                                                                   |
| `label-paper`, `label-ink`                | #FFFFFF, #000000          | same                      | Stickers and print pages                                                                                      |
| `scrim`                                   | rgba(0, 0, 0, 0.6)        | rgba(15, 23, 42, 0.45)    | Behind dialogs and drawers                                                                                    |

Rules: never put `muted` or a status colour on a ground its note doesn't name; `line` is never a
control's only edge (use `line-control`); red is only for failure and destructive actions; amber
means attention; every status also has a word. Kyle's Figma used white text on `#0284C7` buttons
(4.1:1) and `#64748B` for upcoming wizard steps on navy (3.9:1); both fail AA, so the system uses
`primary` (#0369A1) and `muted` instead.

## Typography

Two roles: **Inter** for the interface and **JetBrains Mono** for anything a person matches against a
physical label or types from one.

- **Inter:** headings, body, form labels, buttons, table headers, messages.
- **JetBrains Mono:** storage unit IDs (`BKT-2026-000019`), test hole IDs (`TH26-01`), project
  numbers (`DEMO-2601`), printer addresses, and later location codes (`BAY-04-R2`).
- **Tabular figures** (`font-variant-numeric: tabular-nums`) on depths, counts, quantities, sizes and
  times in tables, so columns line up.

Rules:

- Body text on forms is `body-lg` (16px). Inputs are **never below 16px**, or phone Safari zooms the
  page when a field gets focus. Dense desktop tables may use `body` (14px).
- One `h1` per page (`page-title`, `page-title` at phone width). The storage unit ID on its
  detail page is `id-xl` in mono.
- The scan result message is `scan-message` (28px bold; 22px at phone width) so it reads from a
  step back.
- Smallest text is 11px (`badge`, badges) and must still meet 4.5:1.

**Fonts (decided by Kyle, 2026-10-27): bundled.** Inter and JetBrains Mono (SIL Open Font Licence)
ship in the web build from the `@fontsource/inter` and `@fontsource/jetbrains-mono` packages,
imported in `apps/web/src/main.tsx`: Latin subset, Inter 400–800 and JetBrains Mono 400–700,
`font-display: swap`. Never load fonts from Google Fonts or another CDN: the host has no guaranteed
internet and pages must load on the LAN alone. Fallbacks while they load: `system-ui, 'Segoe UI',
Roboto, sans-serif` and `ui-monospace, 'Cascadia Mono', Consolas, monospace`. Add a weight only by
importing its `latin-<weight>.css` next to the others.

## Layout and spacing

### Breakpoints

| Name    | Width      | Layout                                                                                                                                      |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone   | ≤ 640px    | One column. Side menu becomes a full-screen drawer behind a "Menu" button. Tables become stacked cards. Wizard actions stick to the bottom. |
| Tablet  | 641–1024px | Side menu stays; forms one column; tables keep columns and scroll in their own box if wider.                                                |
| Desktop | > 1024px   | Side menu (14rem) + content. Content max width 72rem for tables, 48rem for forms and scan panels.                                           |

Use the single `640px` phone breakpoint everywhere; don't add others without updating this table.

### Spacing

Use the scale only: 4, 8, 12, 20, 32px (`space-xs`…`space-xl`). Page padding is `space-4` (16px) on
phone, `space-6` (24px) on desktop. Related fields sit `space-md` apart; sections `space-xl`.
Lay out groups with flex/grid and `gap`, not margins on children.

### Density

- Desktop table rows: 36px tall, 8px vertical cell padding, hairline dividers (`line`).
- Phone rows (stacked cards): 52px minimum per row of content.
- Nested detail (for example the SAMPLE#/DEPTH summaries under a unit) indents 1.5rem with a 2px
  `line` line on the left.

## Elevation and depth

Depth comes from **tonal layers and 1px lines**, never drop shadows (they vanish on glare and cheap
panels).

| Level | Surface     | Used for                                              |
| ----- | ----------- | ----------------------------------------------------- |
| 0     | `shell`     | Header, side menu, input fields                       |
| 1     | `page`      | Page ground                                           |
| 2     | `card`      | Cards, tables, drawers                                |
| 3     | `card-head` | Card header bands, table headers, open lists, dialogs |
| —     | `inset`     | Nested groups inside a card, striped table rows       |
| —     | `scrim`     | Behind dialogs and drawers                            |

## Components

The shared React components live in `apps/web/src/components/ui.tsx`. Use them before writing new
markup; add a variant there rather than restyling one screen.

### Buttons

| Variant      | Look                                                                                                             | Use                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Primary      | `primary` fill, white text, 4px corners, 40px tall (44px on phones), 16px side padding; pressed `primary-active` | One per view: the step forward ("Next: Review", "Confirm receipt") |
| Secondary    | `card` fill, 1px `line-control`; hover `card-head`                                                               | Everything else ("Back", "Retry", "Reprint")                       |
| Destructive  | `danger-bg` fill, 1px `danger-line`, `danger`                                                                    | Discard draft, disable a staff member, later disposal              |
| Link button  | No fill, `accent` colour, underlined                                                                             | Low-weight actions inside text                                     |
| Scan trigger | Full width on phone, 2px `warning-line` border, label "Scan with camera"                                         | Opens the phone-camera scanner                                     |

- Minimum size: **44 × 44px** at phone width, on tablets and on the LAB station; 36px on desktop.
  This includes small "×" buttons on chips and the "Menu" button.
- Disabled: `disabled`, `cursor: not-allowed`, and the real `disabled` attribute. Don't use
  opacity alone.
- Busy: keep the label, add the spinner, set `aria-busy`, and block a second click.
- Disposal (future): confirmation is online-only (App Idea); the button is disabled
  with a reason shown while offline.

### Status badges

`StatusBadge` shows status as **text first**; colour only supports it. Badges have 2px corners, uppercase
via CSS, `badge`, 1px border, tone background.

| Tone    | Material Mule statuses today                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| success | In stock · Active (staff) · Sent to printer · Printed (confirmed) · Marked as printed · Backups OK                                            |
| warning | Approved for disposal · Pending (staff) · Stale · Confirmation interrupted · Overdue · No record · Unknown — check the printer · TEST account |
| danger  | Print failed · Backups failed                                                                                                                 |
| info    | Waiting to print · Sending to printer… · Personal · Shared station: LAB                                                                       |
| neutral | Disposed · Disabled (staff) · Not set up                                                                                                      |
| review  | Reserved for lab review states (Lab Testing Worklist, future)                                                                                 |

"Urgent" and "Hold" from the starting direction map to danger and warning when lab requests and
retention holds arrive; they are not V1 statuses.

### Storage unit ID badge

2px corners, `card` fill, `ink` in `id`, with a small barcode glyph before the ID
(inline SVG, `aria-hidden="true"`). The ID text is selectable and is the accessible name. Use it in
tables, scan results and the issued-units list; the detail page heading shows the ID large instead.

### Print status chip

`PrintJobStatus` is a status badge inside a `role="status"` live region, then a hint line
(`field-hint`) and the follow-up buttons (Reprint, "Mark as printed"). It never says "Printed" until
someone confirms the labels came out.

### Form fields

- Use `FormField` so the label, hint and error are wired with `for`/`id`, `aria-describedby` and
  `aria-invalid`.
- Label above the field, hint under it in `muted`, error under that in `danger` starting
  with the fix.
- Field: `shell` fill, 1px `line-control`, 4px corners, 16px text, 44px tall at phone width.
- Focus: 2px `focus` ring with 2px offset. Invalid: `danger-line` outline plus the error text.
- Read-only fields: `card` fill and the `readonly` attribute, not `disabled` (so they can be
  read and copied).

### Barcode (keyboard-wedge) fields

The scan panel keeps a dedicated field focused so a scan is never lost:

- Show **"Ready to scan"** in `success` while it has focus. When focus leaves, cover the panel
  with the **"Scanning paused — Click here to resume scanning"** button (amber dashed border). Text,
  not just colour or animation, tells the state.
- A scanner/target icon on the right edge is decorative (`aria-hidden`). A gentle pulse on the ready
  border is allowed but is turned off under `prefers-reduced-motion`.
- Results go to an `aria-live="polite"` region in `scan-message` size with a coloured left bar
  (success, warning, danger, info) **and** a word that says the result.
- The field never autocompletes, autocorrects or spell-checks (`autocomplete="off"`,
  `autocapitalize="off"`, `spellcheck="false"`).

### Pickers and lists (project, test hole, receiver)

Combobox pattern: a text input with `role="combobox"`, an overlaid `role="listbox"` that never pushes
the content below it, arrow keys to move, Enter to choose, Escape to close. Options are ≥44px tall
at phone width. Hover and the active option use `card`; the chosen option also shows a check
or "Selected" text.

### Cards

`card` fill, 1px `line`, 4px corners (`radius-control`), 20px padding (16px on phones), and a `card-head` header band. A card heading is
`card-title`. Attention cards (handover, offline, pending staff) add a 1px `warning-line` and a
heading that says why — never the border alone.

### Data tables → stacked cards

- Use `DataTable` (real `<table>`, `<th scope="col">`, a visually hidden `<caption>`).
- Header row: `card`, `label-mono` uppercase via CSS, sort state in the header's text and
  `aria-sort`.
- Rows: alternate `shell` / `page`; hover `card`.
- At phone width each row becomes a card: header hidden, each cell shows its column name from
  `data-label` above or beside the value; the row's main link (the storage unit ID) comes first and
  the whole card is ≥52px tall.
- Wide tables on tablets scroll inside their own box (`overflow-x: auto`), never the page.
- Future offline-queued rows (moves queued during a connection drop): 3px `sync-offline` left bar
  plus "Waiting to sync" text.

### Dialogs and drawers

- `ConfirmDialog` uses native `<dialog>` (`showModal`) for focus trapping and Escape. Max width
  480px, `card-head`, scrim as in Elevation. Title in `card-title`, actions right-aligned with
  Cancel first and the primary action last.
- Drawers (staff detail) slide from the right, max 32rem, full width on phone.
- Focus moves into the dialog on open and returns to the opener on close.

**Correction dialogs (justification).** Changing a received storage unit asks for a reason
(at least 5 characters, `STORAGE_UNIT_CORRECTION_REASON_MIN_LENGTH`). Who and when come from the
session and the server clock, shown in local time. The starting direction's "initials/PIN" and "UTC
timestamp" fields are **not** used: people are already identified by Microsoft sign-in or the LAB
receiver selector, and times are local.

### Error, empty and loading states

| State       | Pattern                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loading     | Skeleton rows in `card` for lists; a spinner with text ("Loading storage units…") for actions. Announce with `aria-busy`. No spinner for under 300ms.  |
| Empty       | `EmptyState`: one sentence on what would appear here and, if possible, the action that makes it appear ("No drafts. Start one with Receive samples."). |
| Error       | `ErrorState` (`role="alert"`): plain message + Retry button. The message is `danger`; the button stays a normal secondary button.                      |
| Form errors | `ErrorSummary` at the top of the step with links to each field, plus each field's own error.                                                           |
| Offline     | Amber notice that says what still works, e.g. "You're offline. Your draft is kept. Connect to confirm." Never promise syncing that doesn't exist.      |

### Navigation and header

- Header (`shell`): product name, then the person (initials and name) and the account badge
  ("Personal", "Shared station: LAB", "TEST"), then the LAB session end time.
- Side menu (`shell`): links ≥44px tall on touch; the current page has a 3px `primary` bar on
  the left, `card` fill and `aria-current="page"`.
- A "Skip to content" link is the first focusable element.

## Scanner and keyboard rules

- Everything works with a keyboard alone: Tab order follows the visual order (top to bottom, left to
  right); no positive `tabindex`.
- The DS3678-XR types the ID followed by Enter. Any field that accepts a storage unit ID treats
  Enter as "look it up" and trims spaces; lookups are case-insensitive.
- After a scan, focus returns to the scan field automatically; after a lookup elsewhere, focus goes
  to the result heading.
- Never move focus on a timer, and never steal focus from a field the person is typing in.
- No global keyboard shortcuts that a scanner's characters could trigger.

## Accessibility checklist

- Every control has a visible label (or `aria-label` for icon-only buttons). Placeholders are not
  labels.
- Use real elements: `<button>`, `<a href>`, `<input>` + `<label>`, `<table>`. No click handlers on
  `div` or `span`.
- Status, errors and changes are shown with **text or an icon with text**, never colour alone (for
  example corrected fields show a "Changed" badge as well as the left bar).
- Focus is always visible: 2px `focus` ring, 2px offset, never removed.
- Live regions: `role="status"` for print and scan results, `role="alert"` for errors that block.
- Respect `prefers-reduced-motion` (spinners stop, pulses off).
- Touch targets ≥44px at phone width and on the LAB station.
- Pages pass at 200% zoom and at 320px width without horizontal page scroll.

## Shared receiving station (LAB)

- The header always shows **"Shared station: LAB"** and the session end time, so nobody mistakes it
  for a personal sign-in.
- The person receiving is chosen with the receiver selector on each receipt; their name shows on
  the review step and in the audit.
- Drafts belong to the receipt, not the screen: the handover card (amber) says who started it and
  lets the next person resume.
- Large type for scan results and step titles so they read from a step back; no information only in
  hover tooltips.
- Nothing private (other people's email, profile) is shown beyond what receiving needs.

## Labels and print views

- Labels are 3.5 × 1.5 in, black (`label-ink`) on white (`label-paper`), whatever the screen theme.
  The preview shows true size by default and says when it is scaled down.
- The print page (`LabelPrintPage`) is a light page with its own `@page` rule: no app header, menu or
  dark backgrounds, steps in plain text, one label per page.
- The storage unit ID is printed in text as well as the barcode, so a person can read it without a
  scanner.
- **Labels section layout (decided by Kyle, 2026-10-26):** on a storage unit's page, the label
  preview (true size, fit warnings, Zoom in, "Print / Save as PDF") sits **next to the print view**
  (the instructions and one page per label) on desktop; on a phone the print view stacks below.
  Canvas: "APPROVED — Labels: preview and print side by side".
- **Guide pages:** two help pages are linked from the Labels section, not shown inline:
  - **How to print labels** — the browser print settings as a numbered checklist (Print / Save as
    PDF, scale 100% (Actual size), margins None, one 3.5 × 1.5 in label per page), light like the
    print page.
  - **What's on a label** — the label at twice the size with its 3.5 × 1.5 in size marked and each
    part numbered (QR code, storage unit ID, project number, project name, test holes, Code 128
    barcode, received date); parts with a fit warning are marked in amber with the warning text.

## Current app: gaps and inconsistencies

Found while writing this guide (main at 57978f3).

**Fixed in the consistency pass:**

- The GitHub-style palette is replaced by the tokens above, in light and dark; the camera scanner's
  hard-coded colours and `correction-changed`'s fallback now use tokens.
- Corners are 2px / 4px everywhere: filter chips and wizard step numbers are no longer round.
- Pop-up lists use layers and lines, not drop shadows.
- Buttons are 40px on desktop and 44px at phone width; chip remove buttons and `.link-button` are
  at least 36px (44px on phones); side-menu links are 36px (48px in the phone menu).
- Disabled buttons use `disabled` text and an edge, not opacity.
- `ErrorState` shows the message in a red panel and keeps its Retry button normal.
- Badges have tone fills, mono type and 2px corners.
- `.checkbox`, `.notice` and `.muted` are defined once, in `styles.css`.
- All text inputs are 16px; the skip link has an edge; storage unit IDs are mono.
- The primary button keeps white text in both themes.
- Destructive confirmations (Discard draft, Disable) use the red danger button.
- The header shows the walking-donkey mark; the side menu shows Kyle's icons. Both use
  `currentColor`.

**Still open** (not styling, left for separate cards):

1. Many error messages still include raw HTTP codes, e.g. "Your position wasn’t saved (HTTP 500)."
   and "That didn’t work (HTTP 409)." (`PositionSetupPage`, `LabAccountCard`, several `api.ts`).
2. The screens on the canvas reorganise several pages (card header bands, the Receive samples bottom
   bar, the Settings layouts, the Labels section beside the print view); this pass restyles the
   existing structure only.
3. The header doesn't show the app version yet (the Figma shows it under the name).

## Proposals — pending Kyle

1. ~~Dark-only app screens or follow the OS setting~~ — **decided 2026-10-26: follow the OS
   setting** with the light and dark sets above.
2. ~~Self-hosted Inter and JetBrains Mono~~ — **decided 2026-10-27: bundled** (`@fontsource`, see
   Typography).
3. ~~Logo or wordmark~~ — **the walking donkey (2026-10-26)**; the header uses the mark.
4. ~~Uppercase mono status badges~~ — **adopted from Kyle's Figma screens.**
5. **Storage unit ID badge with a barcode glyph** — not on the approved screens; not built.
6. ~~Striped table rows~~ — **adopted** (`inset` on even rows).

## Not in V1 (reserved)

From the starting direction, kept here so they aren't reinvented, but **not built** in V1:

- Sample-type single-letter badges (G, S, T, B, C): only for lab requests. Receiving never creates
  individual samples.
- Urgent/Hold/Requested/In progress/Completed/Review lifecycle badges: Lab Testing Worklist and
  Disposal & Retention.
- Offline-queued rows and sync indicators: offline queuing of ordinary location moves.
- Location codes (`BAY-04-R2`) and the location scan.
