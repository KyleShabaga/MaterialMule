---
name: Material Mule
theme: system # follows prefers-color-scheme; these are the dark values, light values are under Colors
colors:
  # Surfaces, darkest to lightest (tonal layers, no shadows)
  surface-base: '#090D16'
  surface-canvas: '#0F172A'
  surface-card: '#1E293B'
  surface-raised: '#334155'
  # Lines
  border-subtle: '#1E293B'
  border-strong: '#475569'
  border-control: '#64748B'
  # Text
  text: '#F1F5F9'
  text-muted: '#94A3B8'
  text-muted-raised: '#CBD5E1'
  text-disabled: '#64748B'
  # Actions
  primary: '#2563EB'
  primary-active: '#1D4ED8'
  on-primary: '#FFFFFF'
  link: '#60A5FA'
  focus: '#60A5FA'
  secondary: '#D97706'
  secondary-text: '#F59E0B'
  # Status tones (text / background / border)
  danger-text: '#F87171'
  danger-bg: '#450A0A'
  danger-border: '#DC2626'
  warning-text: '#F59E0B'
  warning-bg: '#451A03'
  warning-border: '#D97706'
  info-text: '#38BDF8'
  info-bg: '#082F49'
  info-border: '#0284C7'
  success-text: '#34D399'
  success-bg: '#064E3B'
  success-border: '#059669'
  neutral-text: '#94A3B8'
  neutral-bg: '#1E293B'
  neutral-border: '#475569'
  review-text: '#C084FC'
  review-bg: '#2E1065'
  review-border: '#7C3AED'
  # Connection
  sync-live: '#10B981'
  sync-offline: '#F59E0B'
  # Labels and print views (always light, whatever the theme)
  label-paper: '#FFFFFF'
  label-ink: '#000000'
typography:
  headline-xl:
    {
      fontFamily: Inter,
      fontSize: 2rem,
      fontWeight: '700',
      lineHeight: 2.5rem,
      letterSpacing: -0.02em,
    }
  headline-lg:
    {
      fontFamily: Inter,
      fontSize: 1.5rem,
      fontWeight: '600',
      lineHeight: 2rem,
      letterSpacing: -0.01em,
    }
  headline-lg-mobile:
    {
      fontFamily: Inter,
      fontSize: 1.25rem,
      fontWeight: '600',
      lineHeight: 1.75rem,
      letterSpacing: -0.01em,
    }
  headline-md: { fontFamily: Inter, fontSize: 1.25rem, fontWeight: '600', lineHeight: 1.75rem }
  headline-sm: { fontFamily: Inter, fontSize: 1.125rem, fontWeight: '600', lineHeight: 1.5rem }
  body-lg: { fontFamily: Inter, fontSize: 1rem, fontWeight: '400', lineHeight: 1.5rem }
  body-md: { fontFamily: Inter, fontSize: 0.875rem, fontWeight: '400', lineHeight: 1.25rem }
  body-sm: { fontFamily: Inter, fontSize: 0.75rem, fontWeight: '400', lineHeight: 1rem }
  label-ui:
    {
      fontFamily: Inter,
      fontSize: 0.75rem,
      fontWeight: '600',
      lineHeight: 1rem,
      letterSpacing: 0.02em,
    }
  label-mono-lg:
    {
      fontFamily: JetBrains Mono,
      fontSize: 0.875rem,
      fontWeight: '600',
      lineHeight: 1.25rem,
      letterSpacing: 0.04em,
    }
  label-mono-md:
    {
      fontFamily: JetBrains Mono,
      fontSize: 0.75rem,
      fontWeight: '500',
      lineHeight: 1rem,
      letterSpacing: 0.02em,
    }
  label-mono-sm:
    {
      fontFamily: JetBrains Mono,
      fontSize: 0.6875rem,
      fontWeight: '500',
      lineHeight: 0.875rem,
      letterSpacing: 0.05em,
    }
  scan-message: { fontFamily: Inter, fontSize: 1.75rem, fontWeight: '700', lineHeight: 2.25rem }
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  # No `full` radius: nothing in the app is pill-shaped (Kyle, 2026-10-26).
spacing:
  gutter: 1rem
  gutter-desktop: 1.5rem
  margin: 1rem
  margin-desktop: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 2rem
breakpoints:
  phone: 640px # and below
  tablet: 1024px # 641–1024
sizes:
  touch-target: 44px # phone, tablet and the LAB station
  control-desktop: 36px # mouse-driven office PCs
  row-desktop: 36px
  row-phone: 52px
  dialog-max: 480px
  drawer-max: 32rem
---

# Material Mule design guide

Material Mule tracks laboratory sample **storage units** for a geotechnical and materials consulting
firm: receiving and labelling, inventory and location, lab testing progress, retention and disposal.
This guide sets how its screens look, read and behave. The front matter above holds the tokens; the
sections below say how to use them.

Status of this guide (2026-10-26): it is the **target**. The tokens and rules here start from a
dark, industrial direction Kyle supplied, adapted to Material Mule's decisions (App Idea D01–D52)
and checked for WCAG 2.2 AA contrast. The app as built still uses an earlier light/dark palette
(see [Current app: gaps and inconsistencies](#current-app-gaps-and-inconsistencies)). Items marked
**Proposal — pending Kyle** are not decided; don't build them until Kyle confirms.

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
  ID badges, tags and chips use 2px corners like the header and sidebar; controls 4px; containers
  8px. Badges are told apart from buttons by size, mono type and having no hover state.
- **Name:** the product is **Material Mule** (renamed from Trapezoid on 2026-10-26). A logo or
  wordmark is **Proposal — pending Kyle**; until then the header shows the name in `headline-sm`.

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

The palette is calibrated for dark rooms, glare and cheap displays: tonal surfaces separated by
crisp 1px lines.

- **Primary — Blueprint blue `#2563EB`:** the one main action per view, selected items, active nav.
- **Secondary — Safety amber `#D97706` / `#F59E0B`:** attention: warnings, approvals for disposal,
  stale drafts, paused scanning, offline. Never decorative.
- **Neutral — Slate `#0F172A` → `#64748B`:** surfaces, borders, secondary text, disabled.
- **Red is only for failure and destructive actions.** Never decorative.

### Contrast (WCAG 2.2 AA)

Text needs 4.5:1 (3:1 at 24px+ or 19px bold); control boundaries, focus indicators and meaningful
icons need 3:1 against what's next to them. Measured ratios:

| Pair                                             | Ratio             | Use                                                           |
| ------------------------------------------------ | ----------------- | ------------------------------------------------------------- |
| `text` #F1F5F9 on `surface-base` #090D16         | 17.7:1            | Body text                                                     |
| `text` on `surface-canvas` #0F172A               | 16.3:1            | Body text                                                     |
| `text` on `surface-card` #1E293B                 | 13.4:1            | Body text in cards                                            |
| `text` on `surface-raised` #334155               | 9.5:1             | Dialog text                                                   |
| `text-muted` #94A3B8 on canvas / card            | 7.0 / 5.7:1       | Hints, metadata                                               |
| `text-muted` on `surface-raised`                 | 4.0:1 ✗           | **Don't.** Use `text-muted-raised` #CBD5E1 (7.0:1)            |
| `on-primary` #FFFFFF on `primary` #2563EB        | 5.2:1             | Primary button                                                |
| `on-primary` on `primary-active` #1D4ED8         | 6.7:1             | Pressed primary button                                        |
| `link` / `focus` #60A5FA on canvas / card / base | 7.0 / 5.8 / 7.6:1 | Links, focus ring                                             |
| `primary` #2563EB as text on canvas              | 3.4:1 ✗           | **Don't** use the button blue for links or focus on dark      |
| `border-control` #64748B on base / canvas / card | 4.1 / 3.8 / 3.1:1 | Input, checkbox and select outlines                           |
| `border-strong` #475569 on canvas                | 2.4:1             | Decorative card outlines only, never a control's only edge    |
| `danger-text` #F87171 on `danger-bg` #450A0A     | 5.8:1             | Danger badge, destructive button                              |
| `danger-text` on canvas / card                   | 6.5 / 5.3:1       | Error messages                                                |
| `warning-text` #F59E0B on `warning-bg` #451A03   | 7.0:1             | Warning badge                                                 |
| `warning-text` on canvas / card                  | 8.3 / 6.8:1       | Warning text                                                  |
| `info-text` #38BDF8 on `info-bg` #082F49         | 6.5:1             | Info badge                                                    |
| `success-text` #34D399 on `success-bg` #064E3B   | 5.1:1             | Success badge                                                 |
| `neutral-text` #94A3B8 on `neutral-bg` #1E293B   | 5.7:1             | Neutral badge                                                 |
| `review-text` #C084FC on `review-bg` #2E1065     | 5.8:1             | Review badge (future lab review states)                       |
| `text-disabled` #64748B on canvas                | 3.8:1             | Disabled controls only (exempt; still paired with `disabled`) |

Changes from the starting palette, made to pass AA: urgent/danger text `#EF4444` → `#F87171` (was
4.3:1 on `#450A0A`); links and focus use `#60A5FA`, not `#2563EB`; input outlines use `#64748B`, not
`#475569`; muted text on raised surfaces uses `#CBD5E1`.

### Light and dark themes

**Decided by Kyle on 2026-10-26: the app follows the operating system's light or dark setting**
(`prefers-color-scheme`). The front matter is the dark set; this is the light set, with the same
token names. Print views and label previews are black on white in both.

| Token                      | Light value                 | Check (WCAG AA)                           |
| -------------------------- | --------------------------- | ----------------------------------------- |
| surface-base               | #F8FAFC                     | Frame, side menu, input fill              |
| surface-canvas             | #FFFFFF                     | Page content                              |
| surface-card               | #F1F5F9                     | Cards, table header, hover                |
| surface-raised             | #FFFFFF                     | Dialogs (with a 1px `border-strong` edge) |
| border-subtle              | #E2E8F0                     | Dividers only                             |
| border-strong              | #CBD5E1                     | Decorative outlines only                  |
| border-control             | #64748B                     | 4.8 / 4.6 / 4.3:1 on canvas / base / card |
| text                       | #0F172A                     | 17.9:1 on canvas, 16.3:1 on card          |
| text-muted, -raised        | #475569                     | 7.6:1 on canvas, 6.9:1 on card            |
| text-disabled              | #64748B                     | 4.8:1                                     |
| primary / primary-active   | #2563EB / #1D4ED8           | White text 5.2 / 6.7:1                    |
| link / focus               | #1D4ED8                     | 6.7:1 on canvas, 6.1:1 on card            |
| secondary / -text          | #D97706 / #B45309           | Text 5.0:1 on canvas, 4.6:1 on card       |
| danger text / bg / border  | #B91C1C / #FEF2F2 / #DC2626 | 5.9:1 on its bg, 5.9:1 on card            |
| warning text / bg / border | #B45309 / #FFFBEB / #D97706 | 4.8:1 on its bg, 4.6:1 on card            |
| info text / bg / border    | #0369A1 / #F0F9FF / #0284C7 | 5.6:1 on its bg, 5.4:1 on card            |
| success text / bg / border | #047857 / #ECFDF5 / #059669 | 5.2:1 on its bg, 5.0:1 on card            |
| neutral text / bg / border | #475569 / #F1F5F9 / #94A3B8 | 6.9:1 on its bg                           |
| review text / bg / border  | #6D28D9 / #F5F3FF / #7C3AED | 6.5:1 on its bg                           |
| sync-live / sync-offline   | #047857 / #B45309           | As success / warning text                 |

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
  page when a field gets focus. Dense desktop tables may use `body-md` (14px).
- One `h1` per page (`headline-lg`, `headline-lg-mobile` at phone width). The storage unit ID on its
  detail page is `headline-xl` in mono.
- The scan result message is `scan-message` (28px bold; 22px at phone width) so it reads from a
  step back.
- Smallest text is 11px (`label-mono-sm`, badges) and must still meet 4.5:1.

**Fonts — Proposal — pending Kyle:** Inter and JetBrains Mono are both SIL Open Font Licence. They
must be **self-hosted** in the web build (for example the `@fontsource` packages, MIT/OFL), never
loaded from Google Fonts or another CDN — the host has no guaranteed internet and pages must load on
the LAN alone. Fallback stack: `system-ui, 'Segoe UI', Roboto, sans-serif` and
`ui-monospace, Consolas, monospace`. Until confirmed, the app keeps the system stack.

## Layout and spacing

### Breakpoints

| Name    | Width      | Layout                                                                                                                                      |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone   | ≤ 640px    | One column. Side menu becomes a full-screen drawer behind a "Menu" button. Tables become stacked cards. Wizard actions stick to the bottom. |
| Tablet  | 641–1024px | Side menu stays; forms one column; tables keep columns and scroll in their own box if wider.                                                |
| Desktop | > 1024px   | Side menu (14rem) + content. Content max width 72rem for tables, 48rem for forms and scan panels.                                           |

Use the single `640px` phone breakpoint everywhere; don't add others without updating this table.

### Spacing

Use the scale only: 4, 8, 12, 20, 32px (`space-xs`…`space-xl`). Page padding is `margin` (16px) on
phone, `gutter-desktop` (24px) on desktop. Related fields sit `space-md` apart; sections `space-xl`.
Lay out groups with flex/grid and `gap`, not margins on children.

### Density

- Desktop table rows: 36px tall, 8px vertical cell padding, hairline dividers (`border-subtle`).
- Phone rows (stacked cards): 52px minimum per row of content.
- Nested detail (for example the SAMPLE#/DEPTH summaries under a unit) indents 1.5rem with a 2px
  `border-strong` line on the left.

## Elevation and depth

Depth comes from **tonal layers and 1px lines**, never drop shadows (they vanish on glare and cheap
panels).

| Level | Surface          | Used for                                                                         |
| ----- | ---------------- | -------------------------------------------------------------------------------- |
| 0     | `surface-base`   | App frame, side menu, input fields                                               |
| 1     | `surface-canvas` | Page content, tables                                                             |
| 2     | `surface-card`   | Cards, table header, row hover, selected row, open dropdown list                 |
| 3     | `surface-raised` | Dialogs and drawers, over a 60% black scrim (`#00000099`) with 4px backdrop blur |

## Components

The shared React components live in `apps/web/src/components/ui.tsx`. Use them before writing new
markup; add a variant there rather than restyling one screen.

### Buttons

| Variant      | Look                                                                                  | Use                                                                |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Primary      | `primary` fill, white text, 4px corners, 8px × 16px padding; pressed `primary-active` | One per view: the step forward ("Next: Review", "Confirm receipt") |
| Secondary    | `surface-card` fill, 1px `border-control`; hover `surface-raised`                     | Everything else ("Back", "Retry", "Reprint")                       |
| Destructive  | `danger-bg` fill, 1px `danger-border`, `danger-text`                                  | Discard draft, disable a staff member, later disposal              |
| Link button  | No fill, `link` colour, underlined                                                    | Low-weight actions inside text                                     |
| Scan trigger | Full width on phone, 2px `secondary` border, label "Scan with camera"                 | Opens the phone-camera scanner                                     |

- Minimum size: **44 × 44px** at phone width, on tablets and on the LAB station; 36px on desktop.
  This includes small "×" buttons on chips and the "Menu" button.
- Disabled: `text-disabled`, `cursor: not-allowed`, and the real `disabled` attribute. Don't use
  opacity alone.
- Busy: keep the label, add the spinner, set `aria-busy`, and block a second click.
- Disposal (future): confirmation is online-only (App Idea); the button is disabled
  with a reason shown while offline.

### Status badges

`StatusBadge` shows status as **text first**; colour only supports it. Badges have 2px corners, uppercase
via CSS, `label-mono-sm`, 1px border, tone background.

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

2px corners, `surface-card` fill, `text` in `label-mono-lg`, with a small barcode glyph before the ID
(inline SVG, `aria-hidden="true"`). The ID text is selectable and is the accessible name. Use it in
tables, scan results and the issued-units list; the detail page heading shows the ID large instead.

### Print status chip

`PrintJobStatus` is a status badge inside a `role="status"` live region, then a hint line
(`field-hint`) and the follow-up buttons (Reprint, "Mark as printed"). It never says "Printed" until
someone confirms the labels came out.

### Form fields

- Use `FormField` so the label, hint and error are wired with `for`/`id`, `aria-describedby` and
  `aria-invalid`.
- Label above the field, hint under it in `text-muted`, error under that in `danger-text` starting
  with the fix.
- Field: `surface-base` fill, 1px `border-control`, 4px corners, 16px text, 44px tall at phone width.
- Focus: 2px `focus` ring with 2px offset. Invalid: `danger-border` outline plus the error text.
- Read-only fields: `surface-card` fill and the `readonly` attribute, not `disabled` (so they can be
  read and copied).

### Barcode (keyboard-wedge) fields

The scan panel keeps a dedicated field focused so a scan is never lost:

- Show **"Ready to scan"** in `success-text` while it has focus. When focus leaves, cover the panel
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
at phone width. Hover and the active option use `surface-card`; the chosen option also shows a check
or "Selected" text.

### Cards

`surface-card` fill, 1px `border-subtle`, 8px corners, 16px padding. A card heading is
`headline-sm`. Attention cards (handover, offline, pending staff) add a 1px `warning-border` and a
heading that says why — never the border alone.

### Data tables → stacked cards

- Use `DataTable` (real `<table>`, `<th scope="col">`, a visually hidden `<caption>`).
- Header row: `surface-card`, `label-ui` uppercase via CSS, sort state in the header's text and
  `aria-sort`.
- Rows: alternate `surface-base` / `surface-canvas`; hover `surface-card`.
- At phone width each row becomes a card: header hidden, each cell shows its column name from
  `data-label` above or beside the value; the row's main link (the storage unit ID) comes first and
  the whole card is ≥52px tall.
- Wide tables on tablets scroll inside their own box (`overflow-x: auto`), never the page.
- Future offline-queued rows (moves queued during a connection drop): 3px `sync-offline` left bar
  plus "Waiting to sync" text.

### Dialogs and drawers

- `ConfirmDialog` uses native `<dialog>` (`showModal`) for focus trapping and Escape. Max width
  480px, `surface-raised`, scrim as in Elevation. Title in `headline-sm`, actions right-aligned with
  Cancel first and the primary action last.
- Drawers (staff detail) slide from the right, max 32rem, full width on phone.
- Focus moves into the dialog on open and returns to the opener on close.

**Correction dialogs (justification).** Changing a received storage unit asks for a reason
(at least 5 characters, `STORAGE_UNIT_CORRECTION_REASON_MIN_LENGTH`). Who and when come from the
session and the server clock, shown in local time. The starting direction's "initials/PIN" and "UTC
timestamp" fields are **not** used: people are already identified by Microsoft sign-in or the LAB
receiver selector, and times are local.

### Error, empty and loading states

| State       | Pattern                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading     | Skeleton rows in `surface-card` for lists; a spinner with text ("Loading storage units…") for actions. Announce with `aria-busy`. No spinner for under 300ms. |
| Empty       | `EmptyState`: one sentence on what would appear here and, if possible, the action that makes it appear ("No drafts. Start one with Receive samples.").        |
| Error       | `ErrorState` (`role="alert"`): plain message + Retry button. The message is `danger-text`; the button stays a normal secondary button.                        |
| Form errors | `ErrorSummary` at the top of the step with links to each field, plus each field's own error.                                                                  |
| Offline     | Amber notice that says what still works, e.g. "You're offline. Your draft is kept. Connect to confirm." Never promise syncing that doesn't exist.             |

### Navigation and header

- Header (`surface-base`): product name, then the person (initials and name) and the account badge
  ("Personal", "Shared station: LAB", "TEST"), then the LAB session end time.
- Side menu (`surface-base`): links ≥44px tall on touch; the current page has a 3px `primary` bar on
  the left, `surface-card` fill and `aria-current="page"`.
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

Found while writing this guide (main at 57978f3). These are what the consistency pass should fix.

**Tokens and theme**

1. Palette is GitHub-style (`#0969da`, `#1f2328`…) in light and dark, not this guide's tokens
   (`apps/web/src/styles.css` `:root`).
2. The camera scanner hard-codes its own colours (`#3fb950`, `#ff7b72`, `#f0c000`, `#c9d1d9`) instead
   of tokens (`scanning/scanning.css`).
3. `correction-changed` uses `var(--accent, currentColor)`; the fallback hides a missing token.
4. Corner radii are mixed: 4px (badges), 6px (buttons, inputs), 8px (cards), 10px (scan panel).
5. Pop-up lists use drop shadows (`.listbox`, `.receiver-options`); this guide uses layers and lines.
6. The phone breakpoint `@media (max-width: 640px)` is repeated in five places in `styles.css` and
   again in each feature file — fine, but `.data-table td::before` min-width is 7rem globally and
   overridden to 6rem in two feature files.

**Components**

7. Buttons are about 34px tall (`padding: 0.4rem 0.8rem`) everywhere, below 44px on phones and the
   LAB station.
8. Chip remove buttons (`.chips button`, `padding: 0 0.4rem`) and `.link-button` (`padding: 0.25rem`)
   are far below 44px.
9. Side-menu links are about 34px tall; phone menu items should be ≥44px.
10. `button:disabled` uses `opacity: 0.6` only.
11. `ErrorState` colours the whole block red, including the Retry button's surroundings; the button
    itself has no danger style, so it looks mismatched.
12. Status badges are outline-only (`border: currentColor`, no fill) at 12px; this guide adds tone
    backgrounds and mono type.
13. `.checkbox` and `.notice` are each defined twice in `styles.css` with different rules.
14. `.muted` is defined in `projects/projects.css` but is a general utility.
15. Inputs are 1rem in some places (`.receiver-select input`) and inherit 16px elsewhere, but the
    camera manual-entry field and scan field set their own sizes; phone inputs must all be ≥16px.
16. The skip link appears with `var(--bg)` and no border or focus ring offset rule of its own.
17. The issued-unit heading uses `ui-monospace`; storage unit IDs elsewhere (tables, unit detail
    heading) use the body font.
    17a. Filter chips (`.chips li`, `border-radius: 999px`) and wizard step numbers (`.step-number`, a circle) are round; with the no-pill rule they get 2px corners.

**Wording**

18. Most buttons and headings are sentence case; nav items use title case by Kyle's decision (keep).
19. Dark-mode `--accent-text: #0d1117` makes primary buttons dark text on light blue in dark mode and
    white text in light mode — the primary button changes character with the theme.

## Proposals — pending Kyle

1. ~~Dark-only app screens or follow the OS setting~~ — **decided 2026-10-26: follow the OS
   setting** with the light and dark sets above.
2. **Self-hosted Inter and JetBrains Mono** (OFL; adds a font package and some font files to the web build)
   or keep the system fonts.
3. **Logo or wordmark** for Material Mule in the header and sign-in page.
4. **Uppercase mono status badges** with tone backgrounds — changes the look of every status.
5. **Storage unit ID badge with a barcode glyph** in tables and scan results.
6. **Striped table rows** (alternating base/canvas) on desktop.

Until Kyle decides 2–6, the code pass applies only what doesn't depend on them: the light and dark
tokens, touch targets, focus, contrast, disabled states, duplicated rules and hard-coded colours.

## Not in V1 (reserved)

From the starting direction, kept here so they aren't reinvented, but **not built** in V1:

- Sample-type single-letter badges (G, S, T, B, C): only for lab requests. Receiving never creates
  individual samples.
- Urgent/Hold/Requested/In progress/Completed/Review lifecycle badges: Lab Testing Worklist and
  Disposal & Retention.
- Offline-queued rows and sync indicators: offline queuing of ordinary location moves.
- Location codes (`BAY-04-R2`) and the location scan.
