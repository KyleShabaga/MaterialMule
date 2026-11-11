---
name: Strata
status: draft 2026-11-11, for Kyle's review. Nothing in apps/web uses it yet.
replaces: Field Ledger (docs/redesign/design.md), which stays the spec for the shipped app until Strata ships
colors: # light; dark values under "Dark theme"
  ground: '#F3F1EC' # page ground, warm stone
  surface: '#FFFFFF' # cards, tables, inputs, sheets
  sunk: '#EAE6DE' # navigation, table heads, wells, the inactive part of a track
  ink: '#1F1C17' # text
  ink-soft: '#57524A' # secondary text, labels
  line: '#DAD5CB' # card edges, row dividers
  control: '#8A8276' # input and checkbox borders (3:1 on every ground)
  primary: '#0E5E5A' # deep core-sample teal: the primary action, focus, current item
  primary-hover: '#0A4C49'
  on-primary: '#FFFFFF'
  primary-soft: '#DDEEEB' # selected row, current nav item, toggled-on chip
  primary-ink: '#0B4F4B' # text on primary-soft
  link: '#0B5C57'
  disabled: '#7A746A'
  stage: # one hue per point in a unit's life; { bg, fg }. fg doubles as the solid stripe colour
    draft: { bg: '#F6E7C8', fg: '#6B4A06' } # received, not confirmed (sand)
    storage: { bg: '#DCEBDD', fg: '#245C2E' } # on a shelf (moss)
    lab: { bg: '#E4E5F7', fg: '#3A3D8F' } # checked out or in a lab program (slate blue)
    due: { bg: '#FCE3C4', fg: '#8A3B00' } # retention due, break due, waiting on someone (clay)
    danger: { bg: '#F8DCD8', fg: '#9E1F17' } # overdue, HOLD, destructive (oxide red)
    closed: { bg: '#E6E3DD', fg: '#57524A' } # disposed, closed, cancelled (stone)
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
radius:
  pill: 999 # buttons, tags, chips, segmented controls, search, the lifecycle track
  field: 10 # text inputs, selects, text areas
  card: 14 # cards, tables, side panels
  sheet: 20 # dialogs, the detail sheet, the phone bottom sheet
elevation: # only for things that float over the page
  raised: '0 1px 2px rgba(31,28,23,.06), 0 4px 12px rgba(31,28,23,.08)' # menus, sticky action bar
  overlay: '0 8px 32px rgba(31,28,23,.18)' # dialogs, detail sheet
space: [4, 8, 12, 16, 20, 24, 32, 48, 64]
touch-target: 44 # minimum; primary phone actions 56
---

# Strata

A complete new design for Material Mule. It replaces Field Ledger's look and several of its
patterns. Kyle asked for it on 2026-11-11 and lifted the "no pill shapes" rule the same day.

This file is the foundation: the idea, tokens, components, shell and the UX changes. Screens come
next, on a new Design canvas, and are added here as they are approved. Every choice made without
Kyle is listed under [Choices made in this draft](#choices-made-in-this-draft) so it can be
overruled in one place.

## The idea

A geotechnical log reads top to bottom as layers, each with its own colour and a written
description. Material Mule's records are layered the same way: a storage unit is received, stored,
tested, kept and disposed of, and a concrete set is cast, received, broken and reported. Strata
makes that life the backbone of the interface.

Three rules carry the look:

1. **Every record wears its stage.** Each stage has one hue (sand, moss, slate, clay, oxide,
   stone). The same hue is the tag, the left stripe on a row or card, and the filled segment of
   the lifecycle track. The stage is always written too; colour never stands alone.
2. **Teal is for acting.** The primary action, focus, the current navigation item and selection
   are teal. Teal is never a status, and stage colours are never buttons.
3. **Soft outside, exact inside.** Shapes are rounded (pill buttons and tags, 14 px cards), but
   the content is precise: IDs, depths, dates and readings are mono, aligned and never abbreviated.

What changes from Field Ledger, in short: warm stone instead of paper and black rules; soft
rounded shapes instead of 2 px ink frames; teal plus stage hues instead of one orange; sentence
case labels instead of mono caps; shadows for floating layers only. What stays: the domain rules,
the monospace record text, the donkey, and the decisions under
[Carried over from Field Ledger](#carried-over-from-field-ledger).

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

The **lifecycle track** shows where a storage unit is: five pill segments, Received, Stored,
In lab, Retention, Disposed. Past segments use their stage `bg` with `fg` text and a check, the
current one is a solid stage `fg` fill with its name in `surface` text (white in light, near-black
in dark; 7:1 or more for every stage), future ones are `sunk` with `ink-soft` text. It is one `ol` with `aria-current="step"` on the current item. A unit that goes back to
storage after the lab simply shows Stored as current again; the history below says it was in the
lab. Concrete sets use the same track with their own steps (Cast, Received, Testing, Reported).

## Logo

The walking donkey from `apps/web/src/layout/DonkeyMark.tsx`, paths unchanged.

- **Colour:** `on-primary` white donkey on a 12 px-radius `primary` teal tile (40 px in the rail,
  32 px in phone headers, 56 px on sign-in). In dark, the tile is `primary` and the donkey
  `on-primary` (dark ink).
- **Wordmark:** "Material Mule" in sans 700, sentence case, beside the tile.
- Never recolour the donkey in a stage colour, outline it, or place it on a photo.

## Shape and depth

- **Pill** (`radius.pill`): every button, tag, filter chip, segmented control, the search field,
  the lifecycle track, the phone Scan button (a 64 px circle) and count badges.
- **Field** (10 px): text inputs, selects and text areas. They are not pills because long values,
  multi-line text and validation messages read better in a squarer box.
- **Card** (14 px): cards, tables, side panels, banners. **Sheet** (20 px): dialogs and the detail
  sheet, top corners only on the phone bottom sheet.
- **Borders:** cards and tables have a 1 px `line` edge and no shadow. Inputs have a 1.5 px
  `control` border. Nothing on the page has a heavy frame.
- **Shadows** (`elevation`) only on layers that float: menus and pickers, the sticky selection
  bar, dialogs, the detail sheet, the phone bottom bar. A card never has one.
- **Stripes:** a 4 px stage-coloured stripe on the left inside edge of a row or card marks its
  stage. Rows without a stage have none.

## Type

Atkinson Hyperlegible Next and Mono, bundled with `@fontsource` (OFL; no network fonts on the
office PC). Chosen for the lab floor: they separate `0`/`O`, `1`/`l`/`I` and `5`/`S`, which
matters in IDs like `CRE-2026-000110`, and they stay readable on a phone in a dim storage room.

- Mono is for records: storage unit IDs, project numbers, test holes, depths, dates and times in
  tables, readings, set IDs, report numbers. Everything else is sans.
- **Sentence case everywhere**, labels included. No caps labels, no letter-spaced text. Table
  heads are `label` style (13/600) in `ink-soft` on `sunk`.
- Numbers in tables use `font-variant-numeric: tabular-nums` and right-align when they are amounts.
- Minimum size 13 px in the interface. Phones never go below 15 px for body text.

## Components

- **Buttons.** Pill, 44 px high (48 px on phone, 56 px for the pinned phone primary), 20 px side
  padding, sans 600. Primary: teal fill, white text, one per screen. Secondary: `surface` fill with
  a 1.5 px `control` border. Quiet: no fill or border, `link` text, for less important actions in
  rows. Destructive: `stage.danger` fill and text, and it always opens a confirmation. Icon
  buttons are 44 px circles with an `aria-label`.
- **Tags.** Pill, 24 px high, sans 600 13 px on the stage `bg`, text in the stage `fg`, a 6 px dot
  of the stage `fg` before the word. Always a word, never a dot alone.
- **Filter chips.** Pill, 36 px (44 px on phone), `surface` with a `line` border; on: `primary-soft`
  fill, `primary-ink` text, a check icon, `aria-pressed="true"`. A count can follow the label.
- **Segmented control.** A `sunk` pill track; the chosen option is a `surface` pill with the
  `raised` shadow. For two to four views of the same thing (Comfortable / Compact, Mine / All).
- **Fields.** Label above in `label` style; 44 px input (48 on phone), 10 px radius, `surface`
  fill, 1.5 px `control` border; focus: a 3 px teal ring outside the border. Record values (holes,
  depths, IDs) are typed in mono. Hint text below in `small`; errors below in `stage.danger.fg`
  with an icon, the border turns danger, `aria-invalid` and `aria-describedby`.
- **Search and scan field.** A pill, 44 px, magnifier at the left, a scan icon button at the right
  (opens the camera on a phone, focuses for the wedge scanner on desktop). Placeholder "Search or
  scan a label". `Ctrl+K` or `/` focuses it from anywhere.
- **Cards.** `surface`, 14 px radius, 1 px `line`, 16–20 px padding. Head: title in `section`, meta
  in `small` `ink-soft`, actions at the right. Optional stage stripe.
- **Tables.** A card holding the table: `sunk` head row, 1 px `line` row dividers, 52 px
  comfortable rows or 36 px compact rows, stage stripe on the first cell when rows have a stage,
  `primary-soft` for selected rows, a checkbox column when rows can be selected. Wide tables
  scroll inside the card. On a phone, tables become stacked row cards.
- **Unit label block.** The on-screen version of the printed label: a `surface` card with the
  holder type and project at the top, the ID in `unit-id`, then test hole, samples summary and
  depth range in mono. Depth is text (`0.8–5.4 m`), never a bar. The printed label itself stays
  black on white and is not restyled.
- **Lifecycle track.** See [Lifecycle](#lifecycle). Compact form in rows: five 8 px dots joined by
  a line, with the current stage written beside them.
- **Counters.** A count in `count` style over a sentence-case label, in a card. The whole card is
  a link to the list that clears it. Concrete progress (specimens tested of a set) is written as
  "2 of 4" with a thin track bar, not cells.
- **Detail sheet.** On desktop, choosing a row in a list opens the record in a 520 px sheet from
  the right (`overlay` shadow, 20 px left corners) with its key facts, its track and its main
  actions, plus "Open full page". `Esc` closes it and focus returns to the row. The URL changes
  (`?open=<id>`), so the sheet can be linked and the back button closes it. Phones always open the
  full page.
- **Selection bar.** When rows are selected, a pill bar floats centred at the bottom of the screen
  with the count and the bulk actions (`raised` shadow). It replaces Field Ledger's ink bar above
  the table.
- **Banners.** A card with a stage stripe, an icon, one bold sentence and one line. Info uses
  `primary-soft`; warnings `due`; errors `danger`; partial success `due` and says what worked.
- **Dialogs.** 480 px, 20 px radius, `overlay` shadow, `rgba(21,19,15,.5)` scrim. Title says the
  action and the record; one sentence on what will change; only the needed fields; Cancel
  (secondary) and one primary at the bottom right. Destructive dialogs name what cannot be undone.
- **Empty states.** A small line drawing of the donkey or a storage unit in `ink-soft`, one bold
  sentence, one line, at most one action. Kinds: nothing to do, no matches (Clear filters), first
  use (create the first record).
- **Toasts.** Bottom left on desktop, above the bottom bar on phone, pill-shaped, 5 s, with Undo
  where the action allows it. Never the only place a failure is reported.

## Shell

### Desktop (1024 px and wider)

- **Rail**, 248 px, `sunk`: logo, then the destinations as 44 px pill rows with a 20 px outline
  icon and a label. The current one is `primary-soft` with `primary-ink` text and a filled icon.
  Destinations with sub-pages expand under the parent (Concrete, Retention), indented, with a
  chevron button. The rail collapses to 72 px (icons only, labels as tooltips) with a button at its
  foot; the choice is remembered per browser.
- **Rail footer:** Settings, Help & Feedback, then the account row (initials circle, name, role,
  sign-out icon button). Shared LAB stations show "Switch user" and the session end under it.
- **Top bar**, 64 px, `ground`: the search and scan field (up to 560 px) at the left and the
  notification bell at the right. Nothing else.
- **Page head:** a context row (back link, record tags, step control) above the page title, with
  the page's actions at the right of the title. One primary action at most.
- **Content** is capped at 1280 px with 32 px padding. Two-column pages split 2:1 and wrap to one
  column below 1180 px.

### Tablet (641–1023 px)

The rail starts collapsed (72 px icons). Detail sheets open as full pages. Everything else as desktop.

### Phone (640 px and narrower)

- **Header**, 56 px: logo tile, page title, the bell.
- **Bottom bar**, five slots with icon and label: Today, Find, **Scan** (a raised 64 px teal
  circle in the centre), Receive, More. The current slot has a `primary-soft` pill behind its icon.
- **More** is a bottom sheet listing the other destinations, Settings, Help and the account row.
- The page's primary action is pinned above the bottom bar as a full-width 56 px pill.
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
4. **Today is a work queue.** The greeting block stays (Kyle kept it), now on `primary` teal with
   white text, with one primary button for the most urgent item. Under it: counters (each a link),
   "Needs you" as stage-striped cards grouped by job (Receive, Put away, Lab, Retention,
   Concrete), and the last 24 hours as a short timeline.
5. **Filters are chips with counts.** Every list leads with its common filters as chips that show
   how many records match, plus a "More filters" sheet. Filters stay in the URL as today.
6. **Undo before confirm.** Reversible actions (move, add to disposal list, mark test done) show a
   toast with Undo instead of asking first. Irreversible ones (confirm receipt and issue IDs,
   record disposal, issue a report) keep a confirmation dialog that names what cannot be undone.
7. **Keyboard first on desktop.** `Ctrl+K` / `/` search, `N` new record on list pages, `J`/`K` to
   move through rows, `Enter` to open, `Esc` to close the sheet. Shortcuts are listed in Help and
   shown in tooltips; none fire while typing in a field.

## Carried over from Field Ledger

Kyle's decisions on the Field Ledger canvas that Strata keeps:

- Depth is always text, never a bar.
- Projects is second, after Today. No counts in the rail.
- The top bar holds only search and the bell; page tags, steps and actions sit in the page head.
- Rail drop-downs only for Concrete and Retention.
- The donkey logo with unchanged paths; only its colour and tile change.
- Tables offer Comfortable and Compact, remembered per table; phones are always comfortable.
- The greeting block on Today.
- Receiving is a draft you finish (Delivery, Units, Confirm and label); drafts show no ID.
- Every finished step names the next physical task.

Field Ledger patterns Strata drops: 2 px ink frames, mono caps labels, counted cells for progress
(replaced by "n of m" with a track bar for lab and concrete progress; shelf capacity keeps cells,
see choices), the ink selection bar, the dashed-frame drafts (drafts now carry the `draft` stage).

## Hover, focus and motion

- **Hover** (desktop only, `@media (hover: hover)`): buttons darken (`primary-hover`) or gain a
  6 % ink tint; rows gain a 4 % ink tint; chips gain a `line` border darkening to `control`.
- **Focus:** every focusable element shows a 3 px teal ring 2 px outside its edge
  (`:focus-visible`). In dark the ring is the dark `primary`.
- **Motion:** 150 ms ease-out for hover and chip state, 200 ms for the detail sheet and bottom
  sheets sliding in. Nothing bounces. `prefers-reduced-motion` turns all of it into instant
  changes.

## Accessibility

- Text pairs meet 4.5:1 (lowest in light: `ink-soft` on `sunk`, 6.2:1; all tags 6.0:1 or more).
  Control borders and the primary fill meet 3:1 against every ground.
- Status is always a word; stripes and dots are decoration (`aria-hidden`).
- The lifecycle track is an ordered list with `aria-current="step"`; the detail sheet is a
  `dialog` with a label naming the record and returns focus on close.
- Targets 44 px minimum; phone primaries 56 px; the bottom bar 64 px tall plus the safe area.
- `forced-colors`: tags and stripes fall back to `CanvasText` borders; the focus ring uses
  `Highlight`.

## Dark theme

Same structure, warm near-black grounds, lighter teal. Contrast checked 2026-11-11.

| Token         | Light                 | Dark                  |
| ------------- | --------------------- | --------------------- |
| ground        | `#F3F1EC`             | `#15130F`             |
| surface       | `#FFFFFF`             | `#1E1B17`             |
| sunk          | `#EAE6DE`             | `#28251F`             |
| ink           | `#1F1C17`             | `#F1EEE7`             |
| ink-soft      | `#57524A`             | `#C4BDB1`             |
| line          | `#DAD5CB`             | `#3A362F`             |
| control       | `#8A8276`             | `#8C8579`             |
| primary       | `#0E5E5A`             | `#5FC2BA`             |
| on-primary    | `#FFFFFF`             | `#0A1F1D`             |
| primary-soft  | `#DDEEEB`             | `#163633`             |
| primary-ink   | `#0B4F4B`             | `#8ED8D1`             |
| link          | `#0B5C57`             | `#7FD3CB`             |
| disabled      | `#7A746A`             | `#9A9388`             |
| stage draft   | `#F6E7C8` / `#6B4A06` | `#3A2E12` / `#EBCB86` |
| stage storage | `#DCEBDD` / `#245C2E` | `#183322` / `#9ED3A6` |
| stage lab     | `#E4E5F7` / `#3A3D8F` | `#262848` / `#C3C5F2` |
| stage due     | `#FCE3C4` / `#8A3B00` | `#3F2510` / `#F5B57A` |
| stage danger  | `#F8DCD8` / `#9E1F17` | `#451915` / `#F4A79E` |
| stage closed  | `#E6E3DD` / `#57524A` | `#2E2B26` / `#C4BDB1` |

Contrast (WCAG ratio), light / dark: ink on ground 15.0 / 16.0, on surface 17.0 / 14.8, on sunk
13.6 / 13.2; ink-soft on sunk 6.2 / 8.2 (lowest text pairing); link on surface 7.8 / 9.9;
on-primary on primary 7.6 / 8.1; primary-ink on primary-soft 7.8 / 8.0; tags 6.0–7.5 / 7.6–8.5;
control on sunk 3.1 / 4.2 (non-text); primary on surface 7.6 / 8.1 (non-text). In dark, shadows
are replaced by a 1 px `line` edge plus a slightly lighter surface (`#25221D`) for floating layers.

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

- Tokens go in `apps/web/src/styles.css` as CSS variables, in the same three blocks Field Ledger
  uses (light, OS dark, explicit dark). Strata names (`--ground`, `--surface`, `--sunk`,
  `--primary`, `--stage-<name>-bg/fg`, `--radius-pill`, …) are added beside the Field Ledger
  names, and the Field Ledger names are re-pointed at Strata values, so pages keep working until
  each is rebuilt. The mapping table is added here in wave 0.
- Fonts: add `@fontsource/atkinson-hyperlegible-next` and `@fontsource/atkinson-hyperlegible-mono`
  (both 5.3.0, OFL-1.1); remove Archivo and IBM Plex Mono when no page uses them.
- Icons: one outline set at 20 px, 1.75 px stroke, bundled as inline SVG components (proposal:
  Lucide, ISC licence, tree-shaken per icon). No icon font, no CDN.
- Components live in `apps/web/src/components/ui.tsx` as today; class names may stay where specs
  rely on them, with the styles replaced.

## Choices made in this draft

Kyle's standing rule: choose the recommendation and note it. Each row can be overruled on its own.

| What came up             | Choice                                                                | Why                                                                                   | Alternative                                    |
| ------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Where the new spec lives | `docs/strata/design.md`; Field Ledger's `docs/redesign/` is untouched | The shipped app and its code comments still point at Field Ledger                     | Replace `docs/redesign/design.md` in place     |
| Name                     | Strata                                                                | Geotechnical layers; records shown by their stage                                     | Any other name                                 |
| Direction                | Warm light ground, rounded shapes, teal action, stage hues            | Distinct from both the navy look and Field Ledger; uses the newly allowed pill shapes | Keep Field Ledger structure and only soften it |
| Pill buttons             | All buttons are pills                                                 | Kyle lifted the no-pill rule; pills read clearly as "press me" next to squarer fields | Pill tags and chips only, 10 px buttons        |
| Inputs                   | 10 px radius, not pills                                               | Long values, text areas and errors fit a squarer box                                  | Pill inputs                                    |
| Fonts                    | Atkinson Hyperlegible Next + Mono                                     | Distinct 0/O and 1/l/I in IDs; legible on phones; OFL and bundled                     | Inter + JetBrains Mono (the navy look's pair)  |
| Caps labels              | Dropped; sentence case labels                                         | Easier to read, and a clear break from Field Ledger                                   | Keep mono caps labels                          |
| Rail icons               | Icons beside labels, collapsible rail                                 | Lets the rail collapse on tablets; matches the phone bar                              | Text-only rail (Field Ledger decision)         |
| Shadows                  | Floating layers only                                                  | Depth tells you what sits above the page; cards stay flat                             | No shadows                                     |
| Progress display         | "n of m" with a track bar; shelf capacity keeps cells                 | Cells grew long on big programs; a shelf's places are real, countable things          | Keep counted cells everywhere                  |
| Detail sheet             | Rows open a sheet on desktop with `?open=` in the URL                 | Keeps the list and filters while checking records                                     | Always navigate to the full page               |
| Scan from anywhere       | Unfocused wedge scans open the record                                 | The scanner is the fastest input in the storage room                                  | Scans only in scan fields                      |
| Undo vs confirm          | Undo toasts for reversible actions; dialogs for irreversible ones     | Fewer interruptions without hiding anything permanent                                 | Confirm everything                             |
| Logo                     | White donkey on a teal tile                                           | Teal is the brand action colour; paths unchanged as Kyle decided                      | Ink donkey on orange (Field Ledger)            |
| Icon set                 | Lucide (proposal)                                                     | Outline style fits; ISC; per-icon imports                                             | Phosphor, or hand-drawn                        |

## Next

1. Kyle reviews this file (direction, pill buttons, fonts, icons, the UX changes).
2. A new Design canvas: foundations board (tokens, type, components in both themes), then Today,
   Receive, Inventory and the unit page, then the phone screens, then the rest of the routes in
   `apps/web/src/routes.tsx`. Screens are recorded here as they are approved.
3. An implementation plan in the same shape as Field Ledger's (wave 0 tokens and shell, parallel
   lanes by folder, an integration branch, one release PR).
