---
name: Field Ledger
status: proposal (not implemented in apps/web)
colors:
  paper: '#F4F4EF' # page ground
  sheet: '#FFFFFF' # cards, tables, inputs
  rail: '#E8E9E2' # navigation, table heads, panel heads
  ink: '#14140F' # text, rules, borders, selected fills
  ink-soft: '#45463E' # secondary text, caps labels
  hairline: '#CFCFC4' # row and cell dividers
  flag: '#FF5A1F' # the one next action; "in progress" / "due" cells
  flag-wash: '#FFF0E8' # selected row, current shelf
  link: '#A8340A' # text links on paper or sheet
  status-storage: { bg: '#DDEFE8', fg: '#0B5D4B' }
  status-lab: { bg: '#E9E3F7', fg: '#4A2D8F' }
  status-waiting: { bg: '#FBEBC2', fg: '#7A4E00' } # draft, retention due
  status-danger: { bg: '#F9DFDC', fg: '#A3201A' } # overdue, destructive
  status-closed: { bg: '#E6E6DE', fg: '#55564E' } # disposed
type:
  sans: "'Archivo', system-ui, sans-serif"
  mono: "'IBM Plex Mono', ui-monospace, monospace"
  page-title: { family: sans, weight: 800, size: 44, line: 44, tracking: -0.02em }
  phone-title: { family: sans, weight: 800, size: 36, line: 36, tracking: -0.02em }
  section: { family: sans, weight: 700, size: 20, line: 28 }
  body: { family: sans, weight: 400, size: 15, line: 21 }
  body-strong: { family: sans, weight: 600, size: 15, line: 21 }
  small: { family: sans, weight: 400, size: 13, line: 18 }
  unit-id: { family: mono, weight: 600, size: 30, line: 33 }
  data: { family: mono, weight: 400, size: 13, line: 18 }
  field-label: { family: mono, weight: 600, size: 12, case: upper }
  big-count: { family: sans, weight: 800, size: 40, line: 40 }
radius:
  tag: 3
  control: 4
  card: 6
border:
  rule: 2px solid ink # frames, section rules, controls
  divider: 1px solid hairline # inside a frame
space: [4, 8, 12, 16, 20, 24, 32, 48]
touch-target: 44 # minimum; primary phone actions 60
---

# Field Ledger

A new design language for Material Mule. It replaces the dark navy/sky look entirely; nothing here
derives from the previous `docs/design.md`.

Canvas with every screen: https://claude.ai/artifact/2qaBxcY3C8zckbThvETqVJ

## The idea

The app looks like the labels it prints. A storage unit's label is the most-read object in the
building, so the screen uses the same materials: a paper ground, black rules, one hi-vis colour,
and IDs in monospace. A unit reads the same on a monitor, on a phone in the storage room and on
the side of a bucket.

Three rules carry the whole look:

1. **Ink draws structure.** Frames and section headings use a 2 px ink rule. Dividers inside a
   frame are 1 px hairlines. No shadows, no gradients, no fully rounded shapes.
2. **Flag means "do this next".** Orange is spent on one primary action per screen and on cells
   that are in progress or due. It is always a fill behind ink text, never a text colour.
3. **Mono means "this is a record".** Unit IDs, projects, test holes, depths, dates in tables and
   caps field labels are IBM Plex Mono. Everything a person writes or reads as a sentence is Archivo.

## UX changes

- **Today opens with a greeting block.** An ink-filled panel at the top of Today: a mono caps line
  with the date and lab, a 44 px sentence that greets the person by first name and says how many
  things need them, then one flag button for the most urgent item and a mono note saying why it is
  first. It replaces the plain page title on Today only; other screens keep the standard title.
- **Today replaces the dashboard.** The home screen is a queue ("Needs you"), a ledger of the last
  24 hours, and the storage room drawn as shelf cells. Each count links to the screen that clears it.
- **Seven destinations, no numbers or icons:** Today, Projects, Receive, Inventory, Lab programs,
  Retention, Concrete (Settings sits in the rail footer). On a phone they become a bottom bar with Scan as the centre action.
- **Find and Scan are on every desktop screen**, in the top strip with the primary action.
- **Receiving is a draft you finish.** Three steps: Delivery, Units, Confirm and label. Each unit is
  one row: holder prefix block, one samples/depth summary line per test hole, target shelf. The
  "On confirm" panel says which ID prefixes will be issued and prints labels. Drafts show no ID.
- **The unit page leads with the label**, then where it is, its lab program progress and its
  history, newest first.
- **Retention is three bands:** overdue, this month, next 90 days. Units are added to a disposal
  list at the side, then recorded together with a reason.

## Logo

The mark is the existing walking donkey from `apps/web/src/layout/DonkeyMark.tsx`, paths unchanged.
Only its colour and setting change:

- **Colour:** ink `#14140F`, one colour, no outline.
- **Tile:** it sits centred on a flag `#FF5A1F` square with a 2 px ink border and 4 px radius.
  Sizes: 38 px tile (28 × 22 donkey) in the desktop rail and on standalone pages, 32 px in phone
  headers, 52 px on the sign-in panel.
- **On an ink ground** (the sign-in panel) the tile's border is paper `#F4F4EF`; the donkey stays ink.
- **Wordmark:** "MATERIAL MULE" in Archivo 800 caps with 0.04em tracking, to the right of the tile.
- Never recolour the donkey orange, place it straight on a photo, or use the tile without its border.

## Components

- **Unit label.** 2 px ink frame; ink header strip with holder type (sans 800, caps) and project
  (mono); the ID in `unit-id`; then test hole, samples summary and depth range as mono text.
  Depth is always written (for example `0.8–5.4 m`), never drawn as a bar.
- **Counted cells.** Progress and shelf fill are rows of bordered cells (ink = done or occupied,
  flag = in progress or due, sheet = empty). One cell is one real thing. Always paired with a count
  in text and an accessible label.
- **Status tag.** Mono 12/600 caps on a tinted fill, 3 px radius. Status is always written, never
  colour alone.
- **Buttons.** 44 px minimum height, 2 px ink border, 4 px radius, sans 700. Primary: flag fill, ink
  text. Secondary: sheet fill. Selected/toggled on: ink fill, paper text. Destructive: borderless,
  `status-danger.fg` text. One primary per screen.
- **Fields.** Mono caps label above; 44 px input (48 px on phone) with a 2 px ink border. Values that
  are records (holes, depths) are mono.
- **Segmented filter.** Buttons joined in one 2 px frame; the active one is ink-filled and carries
  `aria-pressed`.
- **Tables.** Sheet ground in a 2 px frame, rail-coloured mono caps header, hairline rows, flag-wash
  for selected rows. Wide tables scroll inside their frame on narrow screens. A selection shows an
  ink action bar above the table.
- **Table view selector.** A two-button icon control (three thick lines = comfortable, five thin
  lines = compact) at the right of the table's filter or title row; the active one is ink-filled
  with `aria-pressed`. Comfortable rows have 10–12 px cell padding and 44 px row actions. Compact
  rows have 3 px padding, 13 px IDs, 28 px row actions and fold secondary lines onto the main line.
  Compact is for mouse use on desktop; phones always use comfortable.
- **Side panel.** 2 px frame with a rail-coloured head; used for "On confirm" and "Disposal list".

## Layout

- Desktop: 232 px rail on the left, content capped at 1240 px with 32 px padding. Two-column
  screens use a 3:1 or 2:1 split that wraps to one column.
- Phone (390 px): header strip, scrolling content with 16 px padding, primary action pinned above
  the five-slot bottom bar.
- Spacing comes from the `space` scale; sections are 24–32 px apart, rows 8–12 px.

## Hover states

Desktop only; phones have no hover. One rule covers every fill, so nothing needs its own hover
colour. Nothing moves, grows a shadow or changes text colour.

- Buttons, button-shaped links and rail links: a 10% ink tint (`rgba(20,20,15,.1)`) laid over
  whatever fill the control has (white, flag, rail or none).
- Ink-filled controls (selected segment, dark buttons): a 20% paper tint instead, so they lighten.
- Table rows and list rows: a 5% ink tint across the whole row, clickable or not, as a reading aid.
- Text fields, selects and the search bar: a 3 px hairline (`#CFCFC4`) ring outside the ink border.
- Checkboxes and radios: a 3 px hairline outline.
- Text links: the underline thickens to 2 px; links without their own colour turn ink.
- Pointer cursor on links, buttons, selects and checkbox labels; `not-allowed` on disabled
  controls, which get no tint.

## Size rules (checked 2026-11-10)

Every artboard was rendered and measured at its board size. These are the rules it now meets:

- **Type sizes in use:** 12, 13, 14, 15, 16, 18, 20, 24, 26, 28, 30, 32, 36, 40 and 44 px, plus 56,
  64 and 72 px for one-off display lines. Nothing in the interface is smaller than 12 px. 10 px
  appears only inside the paper previews of a printed report.
- **Roles:** 12 mono caps for labels and tags; 13 for notes; 14–15 for body and table text; 16 for
  IDs in rows; 18–20 for section and panel titles; 24–32 for large values; 44 for page titles.
- **Controls:** every button, link-button, input, select and rail link is at least 44 px high.
  Compact table rows (28 px actions) are the one deliberate exception, on desktop only.
- **Spacing:** 32 px page padding; 24 px between page sections; 12–16 px inside cards; 8–12 px
  between rows; 2 px between rail links.
- **Widths:** content is capped at 1240 px; the rail is 232 px; side panels start at 300 px; wide
  tables scroll inside their own frame instead of widening the page.
- **Heights:** a page artboard is as tall as its content needs (minimum 800 px), so nothing is cut
  off and no board ends in a large blank area. Phone screens are 390 × 844 with nothing clipped.

## Accessibility

- Body and label text meets 4.5:1 on its ground (ink-soft on rail is the lowest pairing in use).
- Flag never carries text meaning alone and is never used as text.
- Statuses differ in lightness as well as hue and always include the word.
- Real `button`, `a`, `input` and `label` elements; icon-only controls need an `aria-label`.

## Domain rules the design must keep

- Receiving is per storage unit, with one samples/depth summary per test hole. No sample inventory.
- IDs (`BKT-`, `ST-`, `CRE-`, `CT-` + year + six digits) appear only after confirmation, never on a
  draft, and never change or get reused. Disposed units keep their ID and history.
- Lab programs show progress only.
- No pill-shaped components: radii stay at 3, 4 and 6 px.

## Shell additions

- **Seven destinations:** Projects sits second, after Today; Concrete is last. Rail links are plain text labels. Projects is ink-filled on the projects list and on a project page.
- **Top bar: search and notifications only.** On every desktop screen the top strip holds exactly
  two things: the search field at the left (magnifier icon inside, placeholder "Search units,
  samples, projects, programs…", 44 px high, 2 px ink border, paper fill, up to 520 px wide,
  `aria-label="Search"` in a `role="search"` wrapper) and the notification bell at the right.
  Nothing else goes in it.
- **Context row.** Everything a page used to put in the top strip sits in one row at the top of the
  page content, above the title: back links, draft or status tags, the step control, the concrete
  section switch, and the page's actions. A row that holds only actions is right-aligned; a row
  that starts with a back link, tag or switch is left-aligned.
- **Rail groups (drop-downs).** A destination with more than one list-level page gets a chevron
  button at the right of its rail link. The link still opens the section's first page; the chevron
  shows or hides the sub-pages, indented under a 2 px ink line. A group opens by itself while you
  are inside that section. The current sub-page has a flag-wash fill and bold text. Two groups
  exist: **Concrete** (Breaks, Receiving, Specimens, Holds, Field reports, Review) and
  **Retention** (Due and overdue, Disposal scan). Destinations with a single page have no chevron.
  The rail group replaces the in-page concrete section switch, which is removed.
- **Rail footer.** Pinned to the bottom of the rail: Settings (gear icon) and Help & Feedback
  (question icon) as plain rail links, then a 2 px ink rule and the account row: a 38 px ink square
  with the person's initials in mono, name in sans 700, role in mono caps, and a 44 px sign-out
  icon button at the right. Settings is ink-filled while a settings page is open.
- **Notifications.** A 44 px square bell button sits last in the top strip on every desktop screen.
  The unread count is a small flag-filled square tag on its top-right corner, mono 11/600.
- **Section switch.** Inside Concrete, a segmented control at the left of the top strip moves
  between Breaks, Field reports and Review.

## Sign-in

Split screen: an ink panel with the wordmark and one line, and the form on paper. Microsoft is the
primary (flag) action; the shared receiving station (LAB) form sits below an "or" rule in a framed
panel with secondary weight. Session notices appear above the options as a `status-waiting` strip.

## Settings

A grouped list on the left (You, Lab, Tests and reports, System) and the chosen page on the right.
Items a person may not manage are hidden; read-only pages say who can change them. Destructive row
actions (Retire) use the borderless danger button.

## Concrete (V2)

Concrete uses the same materials but never storage-unit IDs, receipts or label blocks.

- **Specimen identity** is the set ID in mono followed by the letter in a small ink square
  (`26-03` + `A`). Unnumbered sets show their temporary ID and explain why actions are unavailable.
- **Breaks worklist.** Five view tiles with counts (Today, Overdue, Next 7 days, HOLD, Exceptions),
  then one framed table per project. Flags are status tags. Reschedule is the row action.
- **Field report.** The four status dimensions are four separate cells and are never merged into
  one status. Readings are compared against project spec and ticket in one table. Each specimen is
  a small card: letter, age, target or hold-until date, state.
- **Before you submit** panel: missing required fields (danger, block submit) are listed apart from
  warnings (waiting, never block), then who the report goes to for review.
- **Review queue.** Bands for Submitted, Returned and Reviewed. A reviewer's own report shows no
  Review action and says who reviews it instead.

Units (mm, %), mix names, element names and the reviewed-to-issued step shown on the canvas are
placeholders; the open gates (G2, G8, templates, limits) are not decided by this design.

## Empty and error states

- **Empty** is a dashed 2 px frame on paper: one bold sentence, one line of explanation, at most one
  action. Three kinds: nothing to do, no matches (offer Clear filters), first use (offer the
  action that creates the first record).
- **Error** is a solid 2 px frame on sheet with a status tag, a bold sentence saying what happened,
  a line saying what was kept or not saved, and one primary way forward.
- **Field errors:** a summary strip at the top of the form linking to each field, plus the field's
  label in danger colour, a 3 px danger border and a message under it (`aria-invalid`,
  `aria-describedby`).
- **Partial success** (for example IDs issued but labels not printed) uses the waiting colour, not
  danger, and always states the part that succeeded.
- **Conflict:** name who changed the record and when, say the edit was not saved, offer "Show the
  latest".
- **Not allowed:** neutral tag, say who can do it and what the person can still do.
- Messages never include server values, stack traces or codes.

## User flows

The canvas has a flow map ("User flows") with one row per job. Each step names its screen.

| Flow                         | Who                       | Screens, in order                                                                               |
| ---------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| A. Receive a delivery        | Receiving                 | Receiving log → Receive (Delivery, Units, Confirm) → Receipt confirmed → Move units → Inventory |
| B. Find and move a unit      | Anyone                    | Find or Scan → Search results → Storage unit → Move units → Storage unit                        |
| C. Request lab testing       | Engineer, then lab        | Project → New lab program → Today → Storage unit (check out) → Lab programs → Move units        |
| D. Retention and disposal    | Lab Manager               | Today → Retention (review, extend or list, record disposal) → Storage unit                      |
| E. Concrete report to review | Technician, lab, reviewer | Field report → Concrete breaks → Testing table → Field report (submit) → Review                 |

Rules every flow follows:

- **A draft can be left at any step.** It is saved, tagged DRAFT, drawn with a dashed frame in
  lists, and offered back on Today and in the Receiving log with a Continue action.
- **Every finished step names the next one.** The confirmation screen is not a dead end: it shows
  what was created and a primary action for the next physical task ("Put these 4 away").
- **Scan first, type second.** Any field that takes a unit or shelf accepts a scan or typing.
- **Show the effect before confirming.** Move units shows the shelf's cells after the move; the
  "On confirm" and "What the lab gets" panels summarise what the action will create.
- **A scan that matches one unit skips search results** and opens the unit.

## Screens added for the flows

- **Receiving log:** drafts (dashed, Continue) above a table of confirmed deliveries with label state.
- **Receipt confirmed:** one unit label block per issued ID, and a done / now / then checklist panel.
- **Move units:** scanned units on the left; destination shelf, capacity cells and confirm on the right.
- **New lab program:** samples and tests listed under each storage unit; the only place individual
  samples appear. A summary panel counts tests and names the shelves the lab will visit.
- **Project:** counts strip, a section switch, and units grouped by test hole.
- **Search results:** grouped by kind (test holes, units, deliveries, lab programs); each row is one link.
- **Notifications:** unread rows have a flag-filled square and bold title; each row links to its
  record. The bell is ink-filled while this page is open.
- **Concrete testing table:** one row per specimen with inline inputs, saved row by row; "Tested by"
  is chosen at the top for shared LAB stations. Columns and units are placeholders.
- **Access pending:** a single centred message with who approves and a Check again action.

## Phone screens

All phone screens are 390 px wide with a five-slot bottom bar: Today, Find, Scan (flag-filled,
centre), Receive, More. The current slot is ink-filled.

- **Scan:** the only dark screen. Ink ground, a framed viewfinder with flag corner brackets, one
  instruction line, then a paper panel with the last scanned unit and "Type an ID instead".
- **Find:** search field and a four-way filter in the header; results as stacked cards with the ID,
  status tag, title and one detail line.
- **Move a unit:** the scanned units, the scanned shelf in the bay / shelf block, capacity cells
  after the move, and a 60 px primary action pinned above the bottom bar.
- **Notifications:** the same unread square and tag as desktop, in single-column cards.
- **Concrete breaks:** four view tiles with counts in the header, specimens grouped by project.
  Read-only; results are entered on the desktop testing table.
- **More:** the destinations that do not fit the bottom bar, each with a count, then Settings and
  Help & Feedback, then the account row with sign out.

### Concrete field report on a phone

Three steps, started from "New field report" on the phone Concrete breaks screen. This is a design
for on-site entry; offline field entry is not built.

- **Shape.** The bottom bar is replaced by Back and a flag Next action, so the form has the full
  height. The header carries Save and close, a `DRAFT · SAVED ON DEVICE` tag (the sync dimension)
  and a three-step control: 1 Load, 2 Tests, 3 Specimens. Any step can be opened directly.
- **1 Load.** Project, report date, supplier, ticket number with a ticket photo, mix, arrival time
  and element. Picking a mix shows its project spec (slump, air, ages) in an ink-headed block.
- **2 Tests.** One framed block per test with the spec in its head. Each reading is a row: context
  (first reading, retest, after superplasticizer, after water), a large right-aligned number, a
  time, and an IN SPEC / ABOVE SPEC tag. A retest is added as a new row and never replaces the
  first reading. Concrete temperature and the air meter sit below.
- **3 Specimens.** Cast yes/no, cast time, then the set under its temporary ID with a − / + count
  and one row per letter: letter block, age select, target or hold-until date. A summary lists
  missing fields (block) apart from warnings (do not block), then "Ready to submit" and who reviews.
- Number inputs use the decimal keypad; fields are 48 px high; nothing is defaulted to 0 or No.

## More desktop screens

- **Projects:** a filter (Mine, All active, Closed) and a grid of project cards: number and state
  in the head, name and lead, three counts, one line on what is next.
- **Staff and access:** access requests as dashed rows with a role select and Approve, above the
  people table (initials block, role, sign-in method, last seen, state).
- **Concrete holds:** bands for "hold period has ended" and "still inside the hold period", with
  checkboxes; a side panel requires a reason before Schedule a break, Keep on hold longer or
  Dispose without testing.

## Flow coverage

Every step on the flow map has a screen. The steps that were missing and are now designed:

| Flow step                            | Screen                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| A1 Start a delivery                  | Receive: delivery (step 1)                                                     |
| A2 Add each storage unit, on desktop | Receive: add a unit                                                            |
| C4 Check out to lab                  | Dialog 01, opened from Storage unit or Lab program                             |
| C5 Mark tests done                   | Lab program (one row per sample and test; press the state to move it on)       |
| D3 Extend retention                  | Dialog 02                                                                      |
| D5 Disposed                          | Storage unit: disposed (closed record, grey label block, no actions)           |
| E5 Reviewer checks it                | Concrete: review a report (warnings first, then the report, then the decision) |

**Dialogs** are a 2 px framed panel with a rail-coloured head naming the record, one sentence on
what will change, only the fields that are needed, and Cancel plus one flag action at the bottom
right. A correction or reschedule always asks why. The four designed: check out to lab, extend
retention, correct details, reschedule a specimen.

## Settings pages

Every settings page uses the same frame: the "Settings" title, the grouped list on the left (You,
Lab, Tests and reports, System) and one section on the right with its title, a one-line statement
of who can change it, and its actions at the top right. All thirteen pages are designed.

- **My profile:** name, initials, read-only email and position, then personal preferences (table
  rows, the Today greeting, which notifications).
- **My access:** role, a YES / NO list of what the account can do, and per-project grants. Read-only.
- **Staff and access, Locations:** described above.
- **Equipment:** the testing machine as a framed block with calibration state, the air meters as a
  table, and the calibration history.
- **Suppliers:** one framed block per supplier with its plants as rows.
- **Holidays:** an add form and the calendar by year; a holiday flags a break date, never moves it.
- **Tests:** the catalogue as one framed table per group (code, test, subgroup, sample ID tag).
- **Templates:** a card per template listing its tests as outlined chips.
- **Report header:** the fields on the left and a paper preview of the printed header on the right.
- **Printers:** a framed block per printer with state, queue and a test-label action.
- **Receiving:** the draft auto-delete rule, and the drafts it currently applies to.
- **System status:** four framed cards (service, backups, print queue, disk space), state only.

## Concrete pages

Concrete has six pages, reached from the Concrete group in the rail: Breaks, Receiving, Specimens,
Holds, Field reports, Review. Screens reached from a row (a set, a strength report, issuing, the
testing table) show a back link and keep their parent page marked in the rail.

- **Receive specimens:** pickup and first-curing facts, then one row per specimen with its
  unmoulded mass in grams to one decimal, saved row by row. The side holds the marker check and
  the three "something is off" actions (missing, extra, markings do not match).
- **Specimen sets:** one row per set; its specimens are lettered cells coloured by state (tested,
  due, waiting, on hold), with the next break and the strength report state.
- **Specimen set:** the set as a label block, its specimens with age, target, mass and state, the
  strength report state, and the schedule history.
- **Strength report:** version, workflow, specified strength and method as four cells, then one
  framed table per test age with its average and an advisory note. Results on an issued version
  are shown as locked.
- **Issue a report:** a paper preview of what will go out beside a checklist of issue checks. The
  issue action is disabled while any check is open.
- **Concrete search:** one large field and results grouped by field reports, sets and strength
  reports; a duplicate ticket number is tagged on both reports.
- **Project concrete, Mixes:** the project's Overview / Concrete switch, five underlined tabs
  (Reports, Specimens, Summary, Mixes, Settings) and the mixes table with approval state.
- **Mix:** approved and draft revisions side by side, changed values tinted, then the revision
  history. Approving leads to the update step.
- **Update open records:** after a revision is approved, the records made from the earlier revision
  are listed with the old value struck through and the new one beside it. Nothing changes unless
  chosen; records that will be left alone are listed with the reason.

Units, strength values, the calculation method, report numbers, the report layout and who may issue
are placeholders. The open gates in docs/concrete.md are not decided by this design.

## Remaining screens

- **Action requests:** work routed to a person (corrections, cancel a test, close a program,
  retention, lead appointment). Rows show the kind as a tag, who asked, one flag action that opens
  the real record, and Reassign. There is no approve button: a request closes when the real action
  is done, and shows who did it.
- **Team and permissions (project):** Leadership, people on the project, a table of who reviews and
  who issues per scope, a YES / NO panel of the viewer's own permissions, and the history.
- **Project concrete section:** the Overview / Concrete / Team switch and five underlined tabs.
  Reports and Specimens are filterable tables, Summary is a date range and a generate action,
  Mixes is the mix table, Settings holds default ages, hold length and the testing-machine choice.
- **Disposal scan:** a large scan field, results newest first (on the list, not on the list,
  unknown label), and the disposal list with scanned / not-yet state. Only scanned units are
  disposed of.
- **Print labels:** label previews at about actual size with a checkbox each, then printer, copies
  and the print action. The printed label is the unit label block in black and white.
- **Sample tags:** tag previews (sample, tag code, test hole, depth) and the sheets to print, with
  the two "no tag" cases listed.
- **Shelf:** the bay / shelf block with capacity cells, the units on it, and recent comings and
  goings. This is where a scanned shelf label lands. Not in the current code.
- **Help & Feedback:** six short guides that link to the screens, four standing answers, a feedback
  form that stays inside the office, and who to ask. Not in the current code.
- **Page not found:** one sentence, a search field and three ways out.
- **Phone:** Lab programs (units to pull, then progress per program), Retention (three counted tabs,
  Extend and Add to disposal per unit, a pinned scan-out action) and Settings (grouped list; the
  heavier pages stay on a computer).

Every route in `apps/web/src/routes.tsx` now has a screen on the canvas except the test sign-in
and the Microsoft sign-in callback, which have no interface of their own.

## Not designed yet

A lab-wide activity log, export or print of a list, a dark variant, and tablet layouts. Placeholders
on the concrete screens (units, strength method, report layout, who issues) wait on the open gates.
