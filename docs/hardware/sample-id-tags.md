# Sample ID tags on Uline S-15619 insert cards (MM-T69)

Lab programs print **sample ID tags** for the physical testing portions: one 2 × 4 in card per
sample, depth and tag group, ten cards per letter sheet (Uline S-15619W, 2 columns × 5 rows, laser
or inkjet). Open a submitted program and choose **Print sample ID tags** (also offered right after
submitting). Printing reads the program only: it never changes a program, a test or its status.

## What goes on a tag

| Field                         | Source                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Date                          | The print date (America/Edmonton), e.g. 26-Oct-26                                                              |
| Sample No. / Depth            | The Specific sample's full label and depth with units (a test's own identity after an accepted-request change) |
| Project / Project No.         | The program's project                                                                                          |
| Location                      | The line's sampling source (test hole, or standalone location)                                                 |
| Test Required                 | Every test on the tag                                                                                          |
| Pan #, Series No., USC Symbol | Blank, handwritten                                                                                             |
| Small print, bottom right     | Program number and line, e.g. LP-2026-0012 · L3                                                                |

Which tests share a tag is set per test in **Settings → Tests → Sample ID tag** (Lab Managers):

- **No tag**: listed in the preview, never printed (e.g. moisture content, visual identification).
- **Own tag**: the default. Every test not yet configured gets its own tag.
- **Shared tag group**: tests with the same group name share one tag, only for the same sample
  (project + source + full label) at the same depth.

ALL / All grabs / All SPT lines name no individual sample, so they get no tag; the preview lists
them under _Not tagged_. Cancelled tests are left out. By default only tags with a test still
Requested or In progress are selected, so a reprint doesn't waste cards. A shared tag can be split
into one tag per test in the preview (not saved); tags are never merged beyond the catalogue
setting.

## Sheet geometry (from Uline's S-15619 template)

Letter 8.5 × 11 in portrait. Cards 4.0 × 2.0 in. Column left edges 0.236 in and 4.264 in; first row
top 0.5 in; rows every 2.0 in. Card text stays at least 0.12 in inside each card edge.
**Start at card** (1–10, left to right then down) uses a partly used sheet.

## Printer settings

In the browser's print dialog:

1. Destination: the office laser printer (or Save as PDF). Paper **Letter**, portrait.
2. Scale **100% / Actual size** (never Fit to page). Margins **None**. Headers and footers **off**.
3. **One side only.** Feed the card sheet the way the printer's label/cardstock path expects.

New printer or new stock: tick **Print card outlines**, print one sheet on plain paper, hold it
against a card sheet to the light, and set **Nudge** (right/down, ±0.25 in). The nudge is
remembered on that computer only.

## Physical validation (acceptance AC4)

**Status: Not Run.** Automated E2E checks the PDF is letter-sized and every card is at the template
position to 0.01 in; the real printer and stock are still to be checked. Record each run:

| Date | Printer / driver | Browser | Settings used | Nudge | Result (all ten positions, long names, 3+ tests) | Initials |
| ---- | ---------------- | ------- | ------------- | ----- | ------------------------------------------------ | -------- |
|      |                  |         |               |       |                                                  |          |
