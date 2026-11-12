---
name: Strata
status: draft 2026-11-11, for Kyle's review. Nothing in apps/web uses it yet.
replaces: Field Ledger (docs/redesign/design.md), which stays the spec for the shipped app until Strata ships
components: shadcn/ui (Radix primitives, Tailwind CSS v4, lucide-react icons)
palette:
  Radix custom, accent #21206D in light and dark, with Radix's matched gray
  # https://www.radix-ui.com/colors/custom?accent-light=21206D&accent-dark=21206D (Kyle, 2026-11-11)
colors: # shadcn theme variables, light; dark values under "Dark theme"
  background: '#FFFFFF' # page (Radix background)
  foreground: '#1E1F24' # text (gray 12)
  card: '#FFFFFF'
  card-foreground: '#1E1F24'
  popover: '#FFFFFF'
  popover-foreground: '#1E1F24'
  primary: '#21206D' # indigo (accent 9): the primary action, the Today greeting, the logo tile
  primary-foreground: '#FFFFFF'
  secondary: '#EFF0F3' # gray 3
  secondary-foreground: '#1E1F24'
  muted: '#EFF0F3' # gray 3: table heads, tracks, wells
  muted-foreground: '#62636C' # gray 11: secondary text, labels
  accent: '#EEF1FF' # accent 3: hover, current nav item, selected row, toggled-on chip
  accent-foreground: '#242471' # accent 12
  destructive: '#CE2C31' # Radix red 11 (white text 5.2:1)
  border: '#D8D9E0' # gray 6: card edges, dividers
  input: '#8B8D98' # gray 9: input, select and checkbox borders (3.3:1, meets 1.4.11)
  ring: '#21206D' # focus ring
  link: '#5159BD' # accent 11 (Strata addition)
  sidebar: '#F9F9FB' # gray 2
  sidebar-foreground: '#1E1F24'
  sidebar-primary: '#21206D'
  sidebar-primary-foreground: '#FFFFFF'
  sidebar-accent: '#EEF1FF'
  sidebar-accent-foreground: '#242471'
  sidebar-border: '#D8D9E0'
  sidebar-ring: '#21206D'
  stage: # Strata additions; { bg: step 3, fg: tag text, mark: stripes, dots, solid fills (step 11) }
    draft: { bg: '#FFF7C2', fg: '#4F3422', mark: '#AB6400' } # Radix amber: received, not confirmed
    storage: { bg: '#E9F6E9', fg: '#2A7E3B', mark: '#2A7E3B' } # Radix grass: on a shelf
    lab: { bg: '#DEF7F9', fg: '#0D3C48', mark: '#107D98' } # Radix cyan: checked out, in a program
    due: { bg: '#FFEFD6', fg: '#582D1D', mark: '#CC4E00' } # Radix orange: due, waiting on someone
    danger: { bg: '#FEEBEC', fg: '#CE2C31', mark: '#CE2C31' } # Radix red: overdue, HOLD
    closed: { bg: '#EFF0F3', fg: '#62636C', mark: '#62636C' } # gray: disposed, closed, cancelled
type:
  sans: "'Atkinson Hyperlegible Next', system-ui, sans-serif" # @fontsource, bundled
  mono: "'Atkinson Hyperlegible Mono', ui-monospace, monospace" # @fontsource, bundled
  display: { family: sans, weight: 700, size: 40, line: 44, tracking: -0.015em } # Today greeting only
  page-title: { family: sans, weight: 700, size: 30, line: 36, tracking: -0.01em }
  phone-title: { family: sans, weight: 700, size: 26, line: 32 }
  section: { family: sans, weight: 700, size: 19, line: 26 }
  body: { family: sans, weight: 400, size: 15, line: 22 }
  body-strong: { family: sans, weight: 600, size: 15, line: 22 }
  small: { family: sans, weight: 400, size: 13, line: 18 }
  label: { family: sans, weight: 600, size: 13, line: 18 } # sentence case, never caps
  unit-id: { family: mono, weight: 700, size: 28, line: 34 }
  row-id: { family: mono, weight: 600, size: 15, line: 22 }
  data: { family: mono, weight: 400, size: 14, line: 20 }
  count: { family: sans, weight: 700, size: 32, line: 36 }
radius: # shadcn --radius 0.625rem; derived steps as shadcn defines them
  sm: 6 # checkboxes, kbd, small chips
  md: 8 # buttons, inputs, selects, nav items, menu items
  lg: 10 # popovers, dropdowns, alerts
  xl: 14 # cards, tables, side panels
  sheet: 20 # dialogs, the detail sheet, the Today greeting
  full: 999 # tags (Badge), avatars, the search field, count badges, the phone Scan button
elevation: # only for things that float over the page
  raised: '0 1px 2px rgba(30,31,36,.06), 0 4px 12px rgba(30,31,36,.08)' # menus, sticky action bar
  overlay: '0 8px 32px rgba(30,31,36,.18)' # dialogs, detail sheet
space: [4, 8, 12, 16, 20, 24, 32, 48, 64]
touch-target: 44 # minimum; primary phone actions 56
---

# Strata

A complete new design for Material Mule. It replaces Field Ledger's look and several of its
patterns. Kyle asked for it on 2026-11-11, lifted the "no pill shapes" rule, chose shadcn/ui as
the component library and gave the palette: Radix custom colours from accent `#21206D`.

This file is the foundation: the idea, tokens, components, shell and the UX changes. Screens are
on the [Strata canvas](https://claude.ai/artifact/8yageikqVDfVbrptmtWqGi) and listed under
[Screens](#screens) as they are drawn. Every choice made without Kyle is listed under
[Choices made in this draft](#choices-made-in-this-draft) so it can be overruled in one place.

## The idea

A geotechnical log reads top to bottom as layers, each with its own colour and a written
description. Material Mule's records are layered the same way: a storage unit is received, stored,
tested, kept and disposed of, and a concrete set is cast, received, broken and reported. Strata
makes that life the backbone of the interface.

Three rules carry the look:

1. **Every record wears its stage.** Each stage has one hue (amber, grass, cyan, orange, red,
   gray). The same hue is the tag, the left stripe on a row or card, and the filled segment of the
   lifecycle track. The stage is always written too; colour never stands alone.
2. **Indigo is for acting.** The primary action, focus, the current navigation item and selection
   use the indigo accent scale. Indigo is never a status, and stage colours are never buttons.
3. **Familiar outside, exact inside.** The parts are standard shadcn/ui components on a calm
   cool-gray ground, so they behave the way people expect; the content is precise: IDs, depths,
   dates and readings are mono, aligned and never abbreviated.

What changes from Field Ledger, in short: white and cool gray instead of paper and black rules;
shadcn's rounded shapes instead of 2 px ink frames; indigo plus stage hues instead of one orange;
sentence case labels instead of mono caps; shadows for floating layers only. What stays: the
domain rules, the monospace record text, the donkey, and the decisions under
[Carried over from Field Ledger](#carried-over-from-field-ledger).

## Built on shadcn/ui

shadcn/ui is copied into the repo as source (no runtime CDN, which suits the office-only host), on
Radix primitives and Tailwind CSS v4. Strata themes it through shadcn's CSS variables (front
matter above) and adds two things shadcn does not have: the stage colours and `link`.

| Strata part               | shadcn/ui component                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rail and its drop-downs   | `Sidebar` (`collapsible="icon"`), `Collapsible`                                                                                                                     |
| Search and scan, `Ctrl+K` | `Command` in a `Dialog`, opened from the top-bar field                                                                                                              |
| Buttons, icon buttons     | `Button` (`default`, `secondary`, `outline`, `ghost`, `destructive`, `link`; size `icon`)                                                                           |
| Stage tags                | `Badge` with a Strata `stage` variant per stage                                                                                                                     |
| Filter chips, view switch | `ToggleGroup`; `Tabs` for page sections                                                                                                                             |
| Fields                    | `Form` (react-hook-form + the zod schemas in `packages/shared`), `Input`, `Label`, `Select`, `Checkbox`, `RadioGroup`, `Textarea`, `Calendar` + `Popover` for dates |
| Cards, counters           | `Card`                                                                                                                                                              |
| Tables                    | `Table` with TanStack Table (shadcn's data table pattern)                                                                                                           |
| Detail sheet, phone More  | `Sheet` (right on desktop, bottom on phone)                                                                                                                         |
| Dialogs                   | `Dialog`; `AlertDialog` for irreversible actions                                                                                                                    |
| Banners                   | `Alert` with a stage stripe                                                                                                                                         |
| Toasts with Undo          | `Sonner`                                                                                                                                                            |
| Menus, tooltips           | `DropdownMenu`, `Tooltip`, `Popover`                                                                                                                                |
| Progress "n of m"         | `Progress`                                                                                                                                                          |
| Loading                   | `Skeleton`                                                                                                                                                          |
| Account row               | `Avatar` (initials only)                                                                                                                                            |

Rules for using it:

- Use the shadcn component when one exists; restyle through variables and variants, not by forking
  its markup. Strata-only parts (unit label block, lifecycle track, stage stripe, counted shelf
  cells) are small components built from the same tokens.
- Default sizes are raised for touch: `Button` and `Input` are 44 px (`h-11`), 48 px on phones;
  shadcn's 36 px default is used only in compact tables on desktop.
- Every component keeps its Radix accessibility (roles, focus management, keyboard); do not swap a
  Radix primitive for a plain `div`.

## Lifecycle

The stage list is the vocabulary for colour across the app. A screen never invents a new status
colour; it maps its status onto one of these.

| Stage     | Storage units                       | Concrete                                     | Other records                  |
| --------- | ----------------------------------- | -------------------------------------------- | ------------------------------ |
| `draft`   | Receipt draft (no ID yet)           | Field report draft, set not yet received     | Lab program draft              |
| `storage` | On a shelf                          | Received, curing, waiting for its break date | Active project                 |
| `lab`     | Checked out, in a lab program       | Break today, in testing                      | Program in progress            |
| `due`     | Retention due, extension requested  | Submitted, waiting for review; break due     | Action request waiting         |
| `danger`  | Retention overdue                   | HOLD, overdue break, returned for correction | Failed print, blocked step     |
| `closed`  | Disposed (keeps its ID and history) | Issued, disposed without testing             | Closed project, closed program |

The **lifecycle track** shows where a storage unit is: five fully rounded segments, Received,
Stored, In lab, Retention, Disposed. Past segments use their stage `bg` with `fg` text and a check,
the current one is a solid stage `mark` fill with `card` text (white in light, near-black in dark;
4.5:1 or more for every stage), future ones are `muted` with `muted-foreground` text. It is one
`ol` with `aria-current="step"` on the current item. A unit that goes back to storage after the
lab simply shows Stored as current again; the history below says it was in the lab. Concrete sets
use the same track with their own steps (Cast, Received, Testing, Reported).

## Logo

The walking donkey from `apps/web/src/layout/DonkeyMark.tsx`, paths unchanged.

- **Colour:** `primary-foreground` donkey on a 12 px-radius `primary` indigo tile (40 px in the
  rail, 32 px in phone headers, 56 px on sign-in). On an indigo ground (sign-in panel) the tile is
  `primary-foreground` and the donkey `primary`.
- **Wordmark:** "Material Mule" in sans 700, sentence case, beside the tile.
- Never recolour the donkey in a stage colour, outline it, or place it on a photo.

## Shape and depth

- **Radius** follows shadcn's `--radius: 0.625rem`: buttons, inputs, selects and nav items 8 px;
  popovers and alerts 10 px; cards and tables 14 px; dialogs, the detail sheet and the Today
  greeting 20 px.
- **Fully round:** tags (`Badge`), avatars, count badges, the top-bar search field, the lifecycle
  track and the phone Scan button (a 64 px circle). Buttons are not pills.
- **Borders:** cards and tables have a 1 px `border` edge and no shadow. Inputs have a 1.5 px
  `input` border. Nothing on the page has a heavy frame.
- **Shadows** (`elevation`) only on layers that float: menus and pickers, the sticky selection
  bar, dialogs, the detail sheet, the phone bottom bar. A card never has one.
- **Stripes:** a 4 px stage `mark` stripe on the left inside edge of a row or card marks its
  stage. Rows without a stage have none.

## Type

Atkinson Hyperlegible Next and Mono, bundled with `@fontsource` (OFL; no network fonts on the
office PC), set as Tailwind's `--font-sans` and `--font-mono`. Chosen for the lab floor: they
separate `0`/`O`, `1`/`l`/`I` and `5`/`S`, which matters in IDs like `CRE-2026-000110`, and they
stay readable on a phone in a dim storage room.

- Mono is for records: storage unit IDs, project numbers, test holes, depths, dates and times in
  tables, readings, set IDs, report numbers. Everything else is sans.
- **Sentence case everywhere**, labels included. No caps labels, no letter-spaced text. Table
  heads are `label` style (13/600) in `muted-foreground` on `muted`.
- Numbers in tables use `tabular-nums` and right-align when they are amounts.
- Minimum size 13 px in the interface. Phones never go below 15 px for body text.

## Components

- **Buttons** (`Button`). 44 px high (48 px on phone, 56 px for the pinned phone primary), 8 px
  radius, 20 px side padding, sans 600. `default`: indigo fill, white text, one per screen.
  `outline`: `card` fill with a 1.5 px `input` border, for the other actions. `ghost` and `link`
  for less important actions in rows. `destructive`: red fill, white text, and it always opens an
  `AlertDialog`. Icon buttons are 44 px circles with an `aria-label`.
- **Tags** (`Badge`, stage variants). Fully round, 24 px high, sans 600 13 px on the stage `bg`,
  text in the stage `fg`, a 6 px dot before the word. Always a word, never a dot alone.
- **Filter chips** (`ToggleGroup`). 36 px (44 px on phone), 6 px radius, `card` with a `border`
  edge; on: `accent` fill, `accent-foreground` text, a check icon, `aria-pressed="true"`. A count
  can follow the label.
- **Segmented control** (`ToggleGroup` or `Tabs`). A `muted` track; the chosen option is a `card`
  segment with the `raised` shadow. For two to four views of the same thing (Comfortable /
  Compact, Mine / All).
- **Fields** (`Form`, `Input`, `Select`). Label above in `label` style; 44 px input (48 on phone),
  8 px radius, `card` fill, 1.5 px `input` border; focus: a 3 px `ring` outside the border. Record
  values (holes, depths, IDs) are typed in mono. Hint text below in `small`; errors below in
  `destructive` with an icon, the border turns destructive, `aria-invalid` and `aria-describedby`
  (shadcn's `FormMessage` wires these).
- **Search and scan field.** Fully round, 44 px, magnifier at the left, `Ctrl K` hint, a scan icon
  button at the right (opens the camera on a phone, focuses for the wedge scanner on desktop).
  Placeholder "Search or scan a label". `Ctrl+K` or `/` opens the `Command` palette from anywhere.
- **Cards** (`Card`). `card`, 14 px radius, 1 px `border`, 16–20 px padding. Head: title in
  `section`, meta in `small` `muted-foreground`, actions at the right. Optional stage stripe.
- **Tables** (`Table` + TanStack). A card holding the table: `muted` head row, 1 px `border` row
  dividers, 52 px comfortable rows or 36 px compact rows, stage stripe on the first cell when rows
  have a stage, `accent` for selected rows, a checkbox column when rows can be selected. Wide
  tables scroll inside the card. On a phone, tables become stacked row cards.
- **Unit label block.** The on-screen version of the printed label: a `card` with the holder type
  and project at the top, the ID in `unit-id`, then test hole, samples summary and depth range in
  mono. Depth is text (`0.8–5.4 m`), never a bar. The printed label itself stays black on white
  and is not restyled.
- **Lifecycle track.** See [Lifecycle](#lifecycle). Compact form in rows: five 8 px dots joined by
  a line, with the current stage written beside them.
- **Counters** (`Card`). A count in `count` style over a sentence-case label. The whole card is a
  link to the list that clears it. Concrete and lab progress is written as "2 of 4" with a thin
  `Progress` bar, not cells.
- **Detail sheet** (`Sheet`, right). On desktop, choosing a row in a list opens the record in a
  520 px sheet (`overlay` shadow, 20 px left corners) with its key facts, its track and its main
  actions, plus "Open full page". `Esc` closes it and focus returns to the row. The URL changes
  (`?open=<id>`), so the sheet can be linked and the back button closes it. Phones always open the
  full page.
- **Selection bar.** When rows are selected, a bar floats centred at the bottom of the screen with
  the count and the bulk actions (`raised` shadow, 10 px radius).
- **Banners** (`Alert`). A stage stripe, an icon, one bold sentence and one line. Info uses
  `accent`; warnings `due`; errors `danger`; partial success `due` and says what worked.
- **Dialogs** (`Dialog`, `AlertDialog`). 480 px, 20 px radius, `overlay` shadow, 50 % black
  scrim. Title says the action and the record; one sentence on what will change; only the needed
  fields; Cancel (`outline`) and one primary at the bottom right. Irreversible actions use
  `AlertDialog` and name what cannot be undone.
- **Empty states.** A small line drawing of the donkey or a storage unit in `muted-foreground`, one
  bold sentence, one line, at most one action. Kinds: nothing to do, no matches (Clear filters),
  first use (create the first record).
- **Toasts** (`Sonner`). Bottom right on desktop, above the bottom bar on phone, 5 s, with Undo where
  the action allows it. Never the only place a failure is reported.

## Shell

### Desktop (1024 px and wider)

- **Rail** (`Sidebar`), 248 px, `sidebar` gray: logo, then the destinations as 44 px rows (8 px
  radius) with a 16 px Lucide icon and a label. The current one is `sidebar-accent` with
  `sidebar-accent-foreground` text and a filled icon. Destinations with sub-pages expand under the
  parent (Concrete, Retention), indented, with a chevron button. The rail collapses to icons
  (`collapsible="icon"`, labels as tooltips); the choice is remembered per browser.
- **Rail footer:** Settings, Help & Feedback, then the account row (initials avatar, name, role,
  sign-out icon button). Shared LAB stations show "Switch user" (no session end time: session
  length is decision D38, deferred).
- **Top bar**, 56 px, `background`, bottom border: the sidebar toggle and the page title at the
  left; at the right, on every page, the quick actions button and, always last, the notification bell, 8 px apart. Search lives in
  the sidebar.
  - **Quick actions** (`zap`, a `DropdownMenu`: Scan (`scan-line`, Ctrl K), Receive
    (`arrow-down-to-line`), New project (`folder-plus`)). At rest a 44 px outline icon button.
    On hover, keyboard focus or while its menu is open it widens to the left into a filled
    `primary` button: bolt, "Quick actions", a divider and a `chevron-down` that turns up while
    open. The whole button opens the menu.
    Motion, plain CSS (no motion library: a hover expand needs no springs or layout animation):
    - Hover waits 100 ms before opening, so passing the cursor over it does nothing. Keyboard
      focus and an open menu skip the wait.
    - The width animates a grid track from `0fr` to `1fr`, so the easing runs over the label's
      real width (animating `max-width` to a guessed size made it finish early and look
      instant). 250 ms, `cubic-bezier(0.77, 0, 0.175, 1)` (ease-in-out: the button moves on
      screen). The fill cross-fades over 200 ms with the same 100 ms wait. Fully open at 350 ms
      (was 450 ms; Kyle asked for a little faster, 2026-11-11).
    - The label and chevron fade in (200 ms ease-out) once the width is under way, at 200 ms.
    - Leaving closes at once and faster (200 ms; text out in 100 ms).
    - No transitions under `prefers-reduced-motion`.
  - **Notifications** (`bell`, a `Popover` listing recent notifications with Mark all read and
    Open Inbox): a 44 px outline icon button (border, `background` fill, `shadow-xs`). When any
    are unread, a 20 px `primary` count badge sits on its top-right corner, e.g. "2", "9+" past
    nine.
- **Page head:** a context row (back link, record tags, step control) above the page title, with
  the page's actions at the right of the title. One primary action at most.
- **Content** is capped at 1280 px with 32 px padding. Two-column pages split 2:1 and wrap to one
  column below 1180 px.

### Tablet (641–1023 px)

The rail starts collapsed to icons. Detail sheets open as full pages. Everything else as desktop.

### Phone (640 px and narrower)

- **Header**, 56 px: logo tile, page title, the bell.
- **Bottom bar**, five slots with icon and label: Today, Find, **Scan** (a raised 64 px indigo
  circle in the centre), Receive, More. The current slot has an `accent` pill behind its icon.
- **More** is a bottom `Sheet` listing the other destinations, Settings, Help and the account row.
- The page's primary action is pinned above the bottom bar as a full-width 56 px button.
- Content is one column with 16 px padding; tables become row cards; filters collapse into a
  "Filters" chip that opens a bottom sheet.

### Destinations

Today, Projects, Receive, Inventory, Lab programs, Retention (Due and overdue, Disposal scan),
Concrete (Breaks, Receiving, Specimens, Holds, Review). The same seven as Field Ledger and in the
same order; the icons are new.

## UX changes

These are the behaviour changes Strata proposes on top of the new look. Each is open to Kyle's
review (see the choices table).

1. **Scan from anywhere.** On desktop, a wedge scanner read (fast keystrokes ending in Enter) that
   arrives while no field has focus is treated as a search: one matching unit or shelf opens
   directly, anything else opens search results. A toast says what was scanned. Fields that take
   scans (Move, Disposal scan, Receive) keep their own handling.
2. **Lists keep their place.** Rows open in the detail sheet, so checking five units in Inventory
   no longer means five round trips. The full page is one click away.
3. **The stage is visible everywhere.** Lists, cards, search results and the unit page all carry
   the stage tag and stripe; the unit page leads with its lifecycle track.
4. **Today is a work queue.** The greeting block stays (Kyle kept it), now on `primary` indigo with
   white text, with one button for the most urgent item. Under it: counters (each a link), "Needs
   you" as stage-striped cards grouped by job, and the last 24 hours as a short timeline.
5. **Filters are chips with counts.** Every list leads with its common filters as chips that show
   how many records match, plus a "More filters" sheet. Filters stay in the URL as today.
6. **Undo before confirm.** Reversible actions (move, add to disposal list, mark test done) show a
   toast with Undo instead of asking first. Irreversible ones (confirm receipt and issue IDs,
   record disposal, issue a report) keep an `AlertDialog` that names what cannot be undone.
7. **Keyboard first on desktop.** `Ctrl+K` / `/` command palette, `N` new record on list pages,
   `J`/`K` to move through rows, `Enter` to open, `Esc` to close the sheet. Shortcuts are listed in
   Help and shown in tooltips; none fire while typing in a field.

## Carried over from Field Ledger

Kyle's decisions on the Field Ledger canvas that Strata keeps:

- Depth is always text, never a bar.
- Projects is second, after Today. No counts in the rail.
- The top bar holds only the page title, quick actions and the bell; page tags, steps and actions sit in the page head.
- Rail drop-downs only for Concrete and Retention.
- The donkey logo with unchanged paths; only its colour and tile change.
- Tables offer Comfortable and Compact, remembered per table; phones are always comfortable.
- The greeting block on Today.
- Receiving is a draft you finish (Delivery, Units, Confirm and label); drafts show no ID.
- Every finished step names the next physical task.

Field Ledger patterns Strata drops: 2 px ink frames, mono caps labels, counted cells for progress
(replaced by "n of m" with a progress bar for lab and concrete progress; shelf capacity keeps
cells, see choices), the ink selection bar, the dashed-frame drafts (drafts now carry the `draft`
stage).

## Hover, focus and motion

- **Hover** (desktop only, `@media (hover: hover)`): the indigo button lightens to accent 10
  (`#323684`); outline and ghost buttons, rows and nav items take `accent`; chips darken their
  border to `input`. These are shadcn's default hover rules with Strata's variables.
- **Focus:** every focusable element shows a 3 px `ring` 2 px outside its edge (`:focus-visible`).
- **Motion:** 150 ms ease-out for hover and chip state, 200 ms for sheets sliding in (shadcn's
  defaults). Nothing bounces. `prefers-reduced-motion` turns all of it into instant changes.

## Accessibility

- Text pairs meet 4.5:1. Lowest in light: grass and red tag text on their step 3 (4.5:1), then
  `muted-foreground` on `muted` (5.2:1). Lowest in dark: `muted-foreground` on `muted` (7.6:1).
- In light mode, Radix step 11 text on step 3 fails 4.5:1 for amber (4.3), cyan (4.3) and orange
  (4.0), so those tags use step 12 text (10.3:1 or more). Step 11 stays the stripe, dot and fill
  colour (`mark`).
- Control borders (`input`) meet 3:1 on `card` (3.3 light, 4.2 dark). Primary fills meet 3:1 as
  non-text (14.1 light, 3.3 dark).
- Status is always a word; stripes and dots are decoration (`aria-hidden`).
- The lifecycle track is an ordered list with `aria-current="step"`; the detail sheet is a Radix
  `Dialog` with a title naming the record and returns focus on close.
- Targets 44 px minimum; phone primaries 56 px; the bottom bar 64 px tall plus the safe area.
- `forced-colors`: tags and stripes fall back to `CanvasText` borders; the focus ring uses
  `Highlight`.

## Dark theme

The same Radix custom palette's dark scales. Radix lifts accent step 9 to `#555BDC` in dark, since
`#21206D` would vanish on a near-black ground. Contrast checked 2026-11-11.

| Variable                 | Light                             | Dark                              |
| ------------------------ | --------------------------------- | --------------------------------- |
| background               | `#FFFFFF`                         | `#111113`                         |
| foreground               | `#1E1F24`                         | `#EEEEF0`                         |
| card, popover            | `#FFFFFF`                         | `#19191B`                         |
| primary                  | `#21206D`                         | `#555BDC`                         |
| primary-foreground       | `#FFFFFF`                         | `#FFFFFF`                         |
| secondary, muted         | `#EFF0F3`                         | `#222325`                         |
| muted-foreground         | `#62636C`                         | `#B2B3BD`                         |
| accent                   | `#EEF1FF`                         | `#1D2050`                         |
| accent-foreground        | `#242471`                         | `#D8E0FF`                         |
| destructive              | `#CE2C31`                         | `#CE2C31`                         |
| border                   | `#D8D9E0`                         | `#393A40`                         |
| input                    | `#8B8D98`                         | `#797B86`                         |
| ring                     | `#21206D`                         | `#9EADFF`                         |
| link                     | `#5159BD`                         | `#9EADFF`                         |
| sidebar                  | `#F9F9FB`                         | `#19191B`                         |
| stage draft bg/fg/mark   | `#FFF7C2` / `#4F3422` / `#AB6400` | `#302008` / `#FFCA16` / `#FFCA16` |
| stage storage bg/fg/mark | `#E9F6E9` / `#2A7E3B` / `#2A7E3B` | `#1B2A1E` / `#71D083` / `#71D083` |
| stage lab bg/fg/mark     | `#DEF7F9` / `#0D3C48` / `#107D98` | `#082C36` / `#4CCCE6` / `#4CCCE6` |
| stage due bg/fg/mark     | `#FFEFD6` / `#582D1D` / `#CC4E00` | `#331E0B` / `#FFA057` / `#FFA057` |
| stage danger bg/fg/mark  | `#FEEBEC` / `#CE2C31` / `#CE2C31` | `#3B1219` / `#FF9592` / `#FF9592` |
| stage closed bg/fg/mark  | `#EFF0F3` / `#62636C` / `#62636C` | `#222325` / `#B2B3BD` / `#B2B3BD` |

Contrast (WCAG ratio), light / dark: foreground on background 16.5 / 16.3; muted-foreground on
card 6.0 / 8.4; link on card 6.0 / 8.3; white on primary 14.1 / 5.4; accent-foreground on accent
11.9 / 11.7; white on destructive 5.2; tags 4.5–10.9 / 7.6–10.3. In dark, shadows are replaced by
a 1 px `border` edge plus the lighter `card` for floating layers.

## Wording

Unchanged from the app's current voice: sentence case, buttons say what happens ("Confirm
receipt", "Print labels"), errors say what went wrong and what to do in the person's terms, never
codes or server values, and status never claims more than the app knows ("Sent to printer").
Navigation labels are the seven destinations above.

## Domain rules the design must keep

- Receiving is per storage unit, with one samples/depth summary per test hole. No sample
  inventory at receiving; individual samples appear only in lab programs.
- IDs (`BKT-`, `ST-`, `CRE-`, `CT-` + year + six digits) appear only after confirmation, never on
  a draft, and never change or get reused. Disposed units keep their ID, label block (in `closed`)
  and history.
- Lab programs show progress only.
- Printed labels and sample tags are physical output: black on white, matched to the Zebra
  printers, never themed.
- Concrete uses its own records (set IDs with specimen letters, field and strength reports) and
  never storage-unit IDs or label blocks. Gated items (G2, G8, templates, limits, offline field
  entry, set numbering) are not decided by this design; placeholders are marked.
- Permissions are enforced on the server; hiding an action is a courtesy, not the rule.

## Implementation notes

- **Setup (wave 0):** add Tailwind CSS v4 (`@tailwindcss/vite`), `components.json` for the shadcn
  CLI, the `@/` alias in `apps/web`, `lucide-react`, `class-variance-authority`, `clsx`,
  `tailwind-merge` and the Radix packages each component pulls in. Components land in
  `apps/web/src/components/ui/` as source.
- **Name clash:** `apps/web/src/components/ui.tsx` (today's shared parts) collides with the shadcn
  folder `components/ui/`. Wave 0 renames it to `components/app-ui.tsx` and updates imports.
- **Tokens:** the shadcn variables above go in `apps/web/src/styles.css` under `:root` and `.dark`
  (plus the OS-dark media query the app uses today), mapped with Tailwind's `@theme inline`. The
  Field Ledger variable names stay, re-pointed at Strata values, until every page is rebuilt.
- **Preflight:** Tailwind's base reset changes margins and form styles app-wide. Wave 0 turns it on
  with the shell and checks every page once, so no page breaks half-restyled.
- **Forms:** shadcn's `Form` uses react-hook-form with `zodResolver`, so screens reuse the zod
  schemas in `packages/shared` instead of new validation.
- **Fonts:** add `@fontsource/atkinson-hyperlegible-next` and `@fontsource/atkinson-hyperlegible-mono`
  (both 5.3.0, OFL-1.1); remove Archivo and IBM Plex Mono when no page uses them.
- **Icons:** Lucide only (https://lucide.dev/icons/, Kyle 2026-11-11): `lucide-react` in the app, the
  exact Lucide SVGs on the canvas (currently lucide-static 1.72.0), never hand-drawn look-alikes.
  Lucide's default 2 px stroke; 16 px in the sidebar and menus, 20 px elsewhere. Names in use:
  `house` Today, `inbox` Inbox, `square-check-big` My requests, `folder` Projects,
  `arrow-down-to-line` Receive, `package` Inventory, `flask-conical` Lab programs, `hourglass`
  Retention, `cylinder` Concrete, `search`, `scan-line`, `zap` Quick actions, `bell`, `settings`,
  `circle-question-mark` Help, `bug` Feedback & bugs, `log-out` Sign out, `chevrons-up-down`,
  `chevron-down`, `chevron-right`, `arrow-right`, `check`, `lock`, `clock`, `circle-alert`, `pause`.
- **Checks:** `npm run check:bundle` and `npm run verify` stay the gate; no new runtime network
  requests (the office host has no internet assumption).

## Choices made in this draft

Kyle's standing rule: choose the recommendation and note it. Each row can be overruled on its own.

| What came up             | Choice                                                                                                                            | Why                                                                                | Alternative                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------ |
| Where the new spec lives | Repo-root `DESIGN.md` (moved from `docs/strata/` 2026-11-11 so Impeccable reads it); Field Ledger's `docs/redesign/` is untouched | The shipped app and its code comments still point at Field Ledger                  | Replace `docs/redesign/design.md` in place |
| Name                     | Strata                                                                                                                            | Geotechnical layers; records shown by their stage                                  | Any other name                             |
| Theme variable names     | shadcn's names, plus `link` and `stage-*`                                                                                         | Kyle chose shadcn; its components read these names directly                        | Strata's own names with a mapping layer    |
| Radix steps used         | 9 primary, 3 accent, 12 accent text, 11 links; gray 2/3/6/9/11/12                                                                 | The roles Radix documents for each step                                            | Other steps                                |
| Stage colour scales      | Radix amber, grass, cyan, orange, red and the custom gray                                                                         | Same system as the palette; cyan keeps the lab apart from the indigo action colour | Indigo for lab (clashes with primary)      |
| Light tag text           | Step 12 for amber, cyan and orange; step 11 for grass, red and gray                                                               | Step 11 on step 3 fails 4.5:1 for the first three                                  | Darker tag fills                           |
| Input border             | Gray 9, not shadcn's lighter default                                                                                              | Inputs need 3:1 against the card (WCAG 1.4.11)                                     | Gray 7 (fails 3:1)                         |
| Destructive              | Radix red 11 in both themes                                                                                                       | White text on red 9 is only 3.9:1                                                  | Red 9                                      |
| Buttons                  | shadcn's 8 px radius; tags, avatars and search stay fully round                                                                   | Matches shadcn; replaces the earlier all-pill buttons                              | Pill buttons via a variant                 |
| Inputs                   | 8 px radius (shadcn `rounded-md`)                                                                                                 | Matches shadcn                                                                     | 10 px                                      |
| Sizes                    | 44 px buttons and inputs (48 on phone), not shadcn's 36 px                                                                        | The app's 44 px touch-target rule                                                  | shadcn defaults                            |
| Fonts                    | Atkinson Hyperlegible Next + Mono, not shadcn's Geist                                                                             | Distinct 0/O and 1/l/I in IDs; legible on phones; OFL and bundled                  | Geist + Geist Mono                         |
| Caps labels              | Dropped; sentence case labels                                                                                                     | Easier to read, and a clear break from Field Ledger                                | Keep mono caps labels                      |
| Rail icons               | Icons beside labels, collapsible `Sidebar`                                                                                        | Lets the rail collapse on tablets; matches the phone bar                           | Text-only rail (Field Ledger decision)     |
| Shadows                  | Floating layers only                                                                                                              | Depth tells you what sits above the page; cards stay flat                          | No shadows                                 |
| Progress display         | "n of m" with a `Progress` bar; shelf capacity keeps cells                                                                        | Cells grew long on big programs; a shelf's places are real, countable things       | Keep counted cells everywhere              |
| Detail sheet             | Rows open a `Sheet` on desktop with `?open=` in the URL                                                                           | Keeps the list and filters while checking records                                  | Always navigate to the full page           |
| Scan from anywhere       | Unfocused wedge scans open the record                                                                                             | The scanner is the fastest input in the storage room                               | Scans only in scan fields                  |
| Undo vs confirm          | Undo toasts for reversible actions; `AlertDialog` for irreversible ones                                                           | Fewer interruptions without hiding anything permanent                              | Confirm everything                         |
| Logo                     | White donkey on an indigo tile                                                                                                    | Indigo is the brand action colour; paths unchanged as Kyle decided                 | Ink donkey on orange (Field Ledger)        |
| Icon set                 | `lucide-react`                                                                                                                    | shadcn's default; outline style; ISC; per-icon imports                             | Phosphor                                   |
| `ui.tsx` clash           | Rename to `components/app-ui.tsx` in wave 0                                                                                       | shadcn's CLI writes to `components/ui/`                                            | Point the shadcn alias at another folder   |
| Today storage room       | One fill bar per place with the count written; cells stay for a shelf                                                             | Today summarises places, not shelf slots; the shelf page keeps countable cells     | Cells on Today too                         |
| Needs you actions        | The first card's action is the primary, the others outline                                                                        | One primary per screen, and it matches the greeting's choice                       | All outline                                |
| Canvas tooling           | Today boards here, Sign in boards by a parallel agent, one canvas                                                                 | Kyle allowed multiple agents; separate files never overlap                         | One session draws everything               |

## Screens

Canvas: https://claude.ai/artifact/8yageikqVDfVbrptmtWqGi ("Material Mule — Strata", private). Every
board has a Dark tweak. Drafts for review, not approved.

### Components (board: Components) — real shadcn/ui

Every shadcn/ui component the web app will use, mounted for real from the Strata UI bundle
(`design/strata-ui`) so they can be adjusted in one place. Grouped as:

- **Actions:** Button (all variants and sizes, icon, disabled, loading), Button group, Dropdown menu,
  Toggle and Toggle group.
- **Display:** Badge (the six stage tags plus shadcn's variants), Avatar, Hover card, Tooltip, Card,
  Item, Table with Checkbox and Pagination, Progress, Spinner, Skeleton, Kbd, Separator, Empty,
  Accordion, Collapsible, Scroll area.
- **Forms:** Field (label, hint, error), Input, Textarea, Input group, Select, Combobox (Popover +
  Command), Checkbox, Radio group, Switch, Calendar, Date picker (Popover + Calendar).
- **Navigation:** Breadcrumb, Tabs, Command (the Ctrl K palette); Sidebar on its own board.
- **Overlays and feedback:** Dialog, Alert dialog, Sheet, Popover, Alert (info, partial success,
  error), Sonner toasts with Undo.

Not used, so not on the board: AI elements, Carousel, Chart, Drawer, Input OTP, Menubar,
Navigation menu, Resizable, Slider, Aspect ratio, Context menu, Native select, Typography.

Strata changes to shadcn's source: 44 px default height for Button, Input, Select, Input group
and Toggle (36 px small); Badge variants `draft`, `storage`, `lab`, `due`, `danger`, `closed`.

Today and Sign in were taken off the canvas for now (Kyle, 2026-11-11); their descriptions are in
this file's history (commit b43c23a) and will be redrawn from these components.

### Sidebar (boards: real shadcn/ui, mock variants, mock component)

shadcn `Sidebar`, desk-style (Linear and Notion), reworked after the shell critique of
2026-11-11 (`.impeccable/critique/`, 19/36). Kyle chose: navigation first, keep the desk-style
shell, fix all five issues, leave the top bar as it is.

- **Header:** a static logo (the donkey mark from `apps/web/src/layout/DonkeyMark.tsx` in a tile),
  "Material Mule" and the lab; no switcher or buttons. Under it one 44 px search-or-scan field
  (`scan-search`, rounded-full, `Ctrl K`).
- **Pages, never folded** (the old collapsible "Lab" group is gone): Today, Projects, My requests;
  **Storage units:** Receive (`arrow-down-to-line`), Inventory (`package`), Retention
  (`hourglass`); **Soils:** Lab programs (`flask-conical`), Workboard (`square-kanban`; today's
  Lab Testing Worklist, renamed); **Concrete:** Breaks (`hammer`), Receiving (`truck`), Specimens
  (`cylinder`), Holds (`octagon-pause`), Review (`clipboard-check`). Kyle split the earlier
  "Testing" group into Soils and Concrete (2026-11-11), so Concrete's pages are rows of their own,
  not a sub-menu. Section labels are fixed `SidebarGroupLabel`s at 13 px. Retention (Due and
  overdue, Disposal scan) unfolds its sub-pages in place, closed by default.
- **No Inbox row:** the bell is the inbox. Its panel's rows link to their records, unread rows say
  "Unread" to screen readers, and "See all notifications" opens the full list.
- **Pinned** records: stage-tinted square, mono ID, short name.
- **Footer:** the account row; its menu holds Settings, Help, Feedback & bugs and Sign out.
- **Shared LAB station** (board "Shell — shared LAB station", or the Station tweak): above the
  account a "Recording as Pat Example" control (no end time: D38 is deferred) that opens a person picker (Who is
  working here?, the station's people, Someone else…); the account row reads "LAB station ·
  Shared · Receiving lab" and its menu starts with Switch user and ends with End station session.
- **Spacing** (Kyle, 2026-11-11: tighter, then "Try 36 px rows"): rows are 36 px and touch,
  with no gap between them (was 44 px rows with 4 px gaps), and groups sit closer (4 px vertical
  group padding, no gap between groups). This is a deliberate exception to the 44 px control
  rule for the expanded sidebar's rows and sub-rows (36 px still clears the 24 px minimum). The
  search-or-scan field stays 44 px, the account row 48 px, and the collapsed sidebar's icons
  44 px.
- **Sizes and access:** rows are links
  (`href`) with `aria-current="page"` on the current one, inside `<nav aria-label="Main">`; one
  2 px `sidebar-ring` focus ring on every sidebar control; text is 13 px or larger; a "Skip to
  content" link comes first.
- **Collapsed** (Ctrl B): 60 px wide, every item a 44 px icon with a tooltip. Retention
  and Pinned open their pages in a menu to the right (`Strata.NavCollapsible`, `Strata.NavFlyout`
  in the bundle), so nothing is unreachable.
- **Browser surfaces:** `color-scheme` follows the theme and scrollbars use `input`, thin in the
  sidebar.

Left as they are because the top bar is out of scope: the 28 px sidebar toggle and its
"Toggle Sidebar" label, and Ctrl K shown on both the search field and quick actions' Scan (both
open the same palette).

### Sign in (canvas page "Sign in": the page, LAB, picker, dark, and every state)

Shaped with Impeccable on 2026-11-11. Kyle chose: the computer remembers its kind, LAB goes
straight on to a person picker, and the first pass covers the page plus every state.

- **One centred 400 px column** on `background`: the donkey tile and "Material Mule · Sample
  storage and lab testing", then the form, then "Works on the office network only". No brand
  panel (the teal split screen of the first draft belonged to the old palette).
- **A normal computer:** "Sign in", the hint "Use your own work account. What you do is recorded
  under your name.", a full-width "Sign in with Microsoft" button (Microsoft's four-square mark,
  the one non-Lucide mark, as today), then "Shared receiving station? Sign in as LAB".
- **The LAB station computer** opens straight to "Shared receiving station": Username (LAB
  filled in), Password, "Sign in as LAB", "Forgot password? Ask an administrator.", then "Not the
  station? Sign in with your Microsoft account instead".
- **Step 2 on LAB: "Who is working here?"** "Signed in as LAB. Receipts, moves and labels are
  recorded under the name you pick." One 48 px row per person (initials avatar, name, role),
  then "Someone else…", then "Wrong station? Sign out of LAB". This changes today's model, where
  LAB picks the person on each receipt. Empty: a dashed panel ("No one is listed for this station
  yet.") with Someone else….
- **States, in the app's current wording:**
  - Session ended (info).
  - LAB session expired (amber `due`).
  - Wrong password (red field error under Password, `aria-invalid`).
  - Paused after failed attempts (amber alert with the pause help; Sign in as LAB disabled).
  - Sign-in options couldn't load (red alert and Try again; no methods shown).
  - No sign-in method set up.
  - Development builds add "Test sign-in (development only)" above the footer.
- **Open, proposed on the boards:**
  - How a computer becomes the LAB station: an admin setting, saved in that browser.
  - Who the picker lists: receiving-lab staff.
  - What Someone else… searches: all staff.
  - Session length stays D38 (deferred), so nothing shows an end time.

Phone screens are set aside for now (Kyle, 2026-11-11: web screens first).

## Next

1. Kyle reviews this file and the Today and Sign in boards (palette mapping, shadcn shapes, fonts,
   the UX changes).
2. More boards on the same canvas: foundations (tokens, type, the shadcn components in both
   themes), then Receive, Inventory and the unit page, then the remaining phone screens and the
   rest of the routes in `apps/web/src/routes.tsx`. Screens are recorded here as they are approved.
3. An implementation plan in the same shape as Field Ledger's (wave 0 Tailwind, shadcn, tokens
   and shell; parallel lanes by folder; an integration branch). Nothing is merged without Kyle
   (Kyle, 2026-11-11: "Do not merge anything").
