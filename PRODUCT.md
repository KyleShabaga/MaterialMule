# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

React 19 browser app (`apps/web`) used on office and lab Windows PCs and on phones over the office
Wi-Fi. There is no installed phone app and no off-site access (D22, D25). Phone screens are set
aside during the current redesign; web screens come first (Kyle, 2026-11-11).

## Users

Every role weighs equally in design decisions (Kyle, 2026-11-11). The Today page is tailored to
each role.

- **Technicians and technologists:** receive deliveries, label and store storage units, move them,
  and find them again. Often at the shared receiving station, signed in as LAB, one person after
  another, with a USB barcode scanner.
- **Lab technicians and the Lab Manager:** pull units for lab programs, mark tests done, receive
  and break concrete specimens, enter results, and run retention and disposal.
- **Engineers and project leads:** request lab programs, own their projects' mixes, review concrete
  field and strength reports, and decide retention.
- **Admins:** approve new staff, set roles and positions, manage printers, locations, the LAB
  password and system settings.

## Product Purpose

Material Mule tracks laboratory sample storage units (buckets, Shelby tubes, core boxes, other
containers) for a geotechnical and materials consulting firm: receiving and labelling, inventory
and location, lab testing progress, retention and disposal. Version 2 adds a separate concrete
domain: field reports, specimen sets, pickup and receiving, breaks and results, review, HOLD and
issued reports.

Success means every storage unit can be found where the record says it is, everyone can see who
did what and when, and nothing is kept past retention or thrown away early.

## Positioning

It replaces spreadsheets, paper logs and tags, and memory of where things are, with one audited
record per storage unit that follows it from the receiving bench to disposal. The printed label,
the scan and the screen all show the same permanent ID.

## Operating Context

- Receiving happens at shared lab computers signed in as LAB; each receipt records who received it.
- A Zebra DS3678-XR scanner types a label's ID and Enter; phones scan with the camera over HTTPS.
- A Zebra ZD621 prints 3.5 × 1.5 in labels, black on white; labels and print views never follow the
  screen theme.
- Storage is spread over warehouses, a core library, lab benches and a cold room, by bay and shelf.
- Staff sign in with their Microsoft work account; the shared station uses the LAB account.
- Hosted on one Windows PC on the office network (NestJS API and PostgreSQL); no cloud.
- Times are local to America/Edmonton.

## Capabilities and Constraints

- **Receiving is per storage unit,** with one SAMPLE#/DEPTH summary per test hole. Never an
  individual sample inventory at receiving; individual samples appear only in lab requests.
- **Storage unit IDs** are `PREFIX-YYYY-NNNNNN` (`BKT` bucket, `ST` Shelby tube, `CRE` core box,
  `CT` other). Issued only at confirmation, never on a draft, never changed or reused. The year is
  the confirmation date in Edmonton.
- Receipt drafts live in the browser that made them until confirmed.
- Lab programs show progress only.
- Disposed units keep their ID and history.
- Concrete specimens have individual records by design; that never relaxes the storage-unit rule.
  Concrete authority is project-scoped (Lead, designated reviewers, lab staff).
- Every permission is enforced on the server; the interface only reflects it.
- **Open gates, not defaults:** billing D16–D18, sign-in timing D38, IT/pilot choices D39; concrete
  G2 strength report, G8 units/readings/methods, workbook and CSA/ASTM limits, report templates,
  offline field entry on phones, set numbering. Current concrete report layouts and the strength
  method are marked "Provisional".
- Terminology: storage unit (not container or sample), storage unit ID (not barcode), test hole
  (`TH26-01`), SAMPLE#/DEPTH summary, receiving lab, shared station LAB.

## Brand Commitments

- Name: **Material Mule** (renamed from Trapezoid on 2026-10-26).
- Mark: the walking donkey in `apps/web/src/layout/DonkeyMark.tsx`. Its paths never change; only
  its colour and setting may.
- Voice: plain and specific, written for a technician holding a bucket. Sentence case. Buttons say
  what happens ("Confirm receipt", "Print labels"). Errors say what went wrong and what to do,
  without codes, server values or blame. Status never claims more than the app knows ("Sent to
  printer", not "Printed").
- Kyle has chosen shadcn/ui as the component library and a Radix custom palette from accent
  `#21206D` for light and dark (2026-11-11).

## Evidence on Hand

- Fictional seed and demo data only: projects DEMO-2601 to DEMO-2616, test holes TH26-01 and
  TH26-02, test identities such as Alex Tester and Pat Example (`seed/dev.sql`, `npm run
db:seed:demo`).
- Requirements and decisions: Notion "App Idea" (D01–D52) and the development boards.
- No testimonials, usage figures or customer names exist. Never use real production data or real
  people's records.

## Product Principles

1. **The record matches the shelf.** Where a unit is, and who put it there, is never in doubt.
2. **Accountability without friction.** Every action is attributed and audited, and a shared
   station still records the real person.
3. **Scan first, type second.** Any field that takes a unit or a shelf accepts a scan.
4. **Honest status.** Show only what the app knows; partial success says what worked.
5. **Permanent identity.** IDs, history and disposed records never change or disappear.

## Accessibility & Inclusion

WCAG 2.2 AA in both light and dark themes: 4.5:1 text, 3:1 for control borders, 44 px touch
targets, keyboard access throughout, status always written and never colour alone. Screens must
stay readable on a phone under fluorescent light and glare, and from a step back at the shared
station.
