import {
  concreteSnapshotChanged,
  type ConcreteSnapshotChange,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { shortDateTime } from '../dashboard/format';

// MM-V2-C28 / STRATA-96: the review preview of one submitted version, built from its frozen
// snapshot (never the live report), drawn as paper in the report's printed order. It is not the
// issued file: the page labels it, and template P1 is provisional (report templates are an open
// item). Changed fields since the previous version are highlighted with a visible "Changed" mark
// and the previous value (AC3); every field is still shown, so the full record stays available.
// Exception markers (numbered) sit on the sections their exceptions point at and link to the
// exception in the review panel. Tables here are plain HTML: they are the print preview.

type Snapshot = Record<string, unknown>;

/** Sections of the paper; `key` is what an exception's field path maps to (markers). */
export type PaperSectionKey =
  'load' | 'location' | 'tests' | 'notes' | 'spec' | 'readings' | 'specimens' | 'attachments';

const FIELD_SECTIONS: { key: PaperSectionKey; title: string; fields: [string, string][] }[] = [
  {
    key: 'load',
    title: 'Project and load',
    fields: [
      ['reportDate', 'Report date'],
      ['contractorName', 'Contractor'],
      ['paperFieldId', 'Paper field ID'],
      ['supplierName', 'Supplier'],
      ['mixNumber', 'Mix number'],
      ['ticketNumber', 'Ticket number'],
      ['truckNumber', 'Truck number'],
      ['plantName', 'Plant'],
      ['batchedAt', 'Batched'],
      ['loadVolumeM3', 'Load volume (m³)'],
      ['cumulativeVolumeM3', 'Cumulative volume (m³)'],
    ],
  },
  {
    key: 'location',
    title: 'Location and times',
    fields: [
      ['locationElements', 'Elements'],
      ['locationElementOther', 'Other element'],
      ['locationDescription', 'Location'],
      ['samplingLocation', 'Sampling location'],
      ['samplingLocationOther', 'Other sampling location'],
      ['placementMethods', 'Placement method'],
      ['placementMethodOther', 'Other placement method'],
      ['arrivedAt', 'Arrived'],
      ['sampledAt', 'Sampled'],
      ['testedAt', 'Tested'],
      ['castAt', 'Cast'],
      ['timeLimitExceeded', 'Time limit exceeded'],
      ['timeLimitInformed', 'Who was informed'],
      ['loadRejected', 'Load rejected'],
      ['loadDecisionByName', 'Accepted or rejected by'],
      ['loadDecisionByCompany', 'Company'],
    ],
  },
  {
    key: 'tests',
    title: 'Field tests',
    fields: [
      ['material', 'Material'],
      ['superplasticizerAdded', 'Superplasticizer'],
      ['concreteTempC', 'Concrete temperature (°C)'],
      ['ambientTempC', 'Ambient temperature (°C)'],
      ['unitWeightKgM3', 'Unit weight (kg/m³)'],
      ['waterAdded', 'Water added'],
      ['waterAddedAuthorizedBy', 'Water authorized by'],
      ['airMeterEquipmentId', 'Air meter'],
    ],
  },
  {
    key: 'notes',
    title: 'Notes',
    fields: [
      ['specimensCast', 'Specimens cast'],
      ['comments', 'Comments'],
      ['resultsReportedToName', 'Results reported to'],
      ['resultsReportedToCompany', 'Company'],
    ],
  },
];

const SPEC_ROWS: [string, string][] = [
  ['specifiedStrengthMpa', 'Strength (MPa)'],
  ['specifiedStrengthAgeDays', 'Strength age (days)'],
  ['slumpTargetMm', 'Slump target (mm)'],
  ['slumpToleranceMm', 'Slump tolerance (± mm)'],
  ['airMinPercent', 'Air minimum (%)'],
  ['airMaxPercent', 'Air maximum (%)'],
  ['maxAggregateSizeMm', 'Max aggregate (mm)'],
  ['cementType', 'Cement type'],
];

const SECTION_TITLE: Record<PaperSectionKey, string> = {
  load: 'Project and load',
  location: 'Location and times',
  tests: 'Field tests',
  notes: 'Notes',
  spec: 'Specification and ticket',
  readings: 'Slump and air readings',
  specimens: 'Specimens',
  attachments: 'Attachments',
};

/** The paper section an exception's (or a change's) field path belongs to, or null. */
// eslint-disable-next-line react-refresh/only-export-components -- paper helpers beside the paper
export function paperSectionOf(path: string | null): PaperSectionKey | null {
  if (!path) return null;
  const [head, second] = path.replace(/^fields\./, '').split('.');
  if (head === 'readings') return 'readings';
  if (head === 'projectSpec' || head === 'ticketSpec') return 'spec';
  if (head === 'specimenSets') return 'specimens';
  if (head === 'attachmentRefs') return 'attachments';
  if (head === 'mixSnapshot') return 'load';
  const key = head === 'fields' ? second : head;
  return FIELD_SECTIONS.find((s) => s.fields.some(([k]) => k === key))?.key ?? null;
}

// eslint-disable-next-line react-refresh/only-export-components -- paper helpers beside the paper
export function paperSectionTitle(key: PaperSectionKey): string {
  return SECTION_TITLE[key];
}

/** "Project and load › Ticket number" for a change's path (the panel's change list). */
// eslint-disable-next-line react-refresh/only-export-components -- paper helpers beside the paper
export function changeLabel(path: string): string {
  const section = paperSectionOf(path);
  const rest = path.replace(/^fields\./, '');
  const [head, key] = rest.split('.');
  let field: string | undefined;
  if (head === 'projectSpec' || head === 'ticketSpec') {
    const row = SPEC_ROWS.find(([k]) => k === key)?.[1];
    field = `${head === 'projectSpec' ? 'Project specification' : 'Ticket'}${row ? `, ${row}` : ''}`;
  } else if (head === 'readings') field = 'a reading';
  else if (head === 'specimenSets') field = 'a specimen set';
  else if (head === 'mixSnapshot') field = 'Registry mix';
  else field = FIELD_SECTIONS.flatMap((s) => s.fields).find(([k]) => k === head)?.[1];
  if (!section) return field ?? rest;
  return field ? `${SECTION_TITLE[section]} › ${field}` : SECTION_TITLE[section];
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// eslint-disable-next-line react-refresh/only-export-components -- paper helpers beside the paper
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') {
    if (ISO_TIME.test(value)) return shortDateTime(value);
    return value.replace(/_/g, ' ');
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((v) => formatValue(v)).join(', ');
  }
  return JSON.stringify(value);
}

const obj = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(obj) : [];

const CHANGED_BG = 'rounded-sm bg-stage-due-bg px-1';

function Changed({ change }: { change: ConcreteSnapshotChange | undefined }) {
  return (
    // `review-changed-mark` is the hook the E2E specs count changed fields by.
    <span className="review-changed-mark ml-1 text-xs font-semibold text-stage-due-fg">
      Changed{change ? <> (was {formatValue(change.before)})</> : null}
    </span>
  );
}

function Field({
  label,
  value,
  path,
  changes,
}: {
  label: string;
  value: ReactNode;
  path: string;
  changes: readonly ConcreteSnapshotChange[];
}) {
  const changed = concreteSnapshotChanged(changes, path);
  const exact = changes.find((c) => c.path === path);
  return (
    <div className="contents" data-path={path}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">
        <span className={changed ? CHANGED_BG : undefined}>{value}</span>
        {changed ? <Changed change={exact} /> : null}
      </dd>
    </div>
  );
}

/** A numbered exception marker on a section, linking to that exception in the review panel. */
export interface PaperMarker {
  n: number;
  section: PaperSectionKey;
  /** The exception's name, for the marker's accessible name. */
  label: string;
}

function SectionHead({
  section,
  markers,
  onMarker,
  changed,
}: {
  section: PaperSectionKey;
  markers: readonly PaperMarker[];
  onMarker?: (n: number) => void;
  changed?: boolean;
}) {
  const mine = markers.filter((m) => m.section === section);
  return (
    <div className="mb-2 flex items-center gap-2 border-b border-foreground/20 pb-1">
      {changed ? (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-stage-due-mark"
          title="Changed on this version"
        />
      ) : null}
      <h3 className="text-xs font-semibold tracking-wide uppercase">{SECTION_TITLE[section]}</h3>
      <span className="ml-auto flex gap-1">
        {mine.map((m) =>
          onMarker ? (
            <a
              key={m.n}
              href={`#exception-${m.n}`}
              data-slot="exception-marker"
              aria-label={`Exception ${m.n} on ${SECTION_TITLE[section]}: ${m.label}`}
              onClick={(event) => {
                event.preventDefault();
                onMarker(m.n);
              }}
              className="flex size-5 items-center justify-center rounded-full bg-stage-due-bg text-[11px] font-semibold text-stage-due-fg no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {m.n}
            </a>
          ) : (
            <span
              key={m.n}
              aria-label={`Exception ${m.n}: ${m.label}`}
              className="flex size-5 items-center justify-center rounded-full bg-stage-due-bg text-[11px] font-semibold text-stage-due-fg"
            >
              {m.n}
            </span>
          ),
        )}
      </span>
    </div>
  );
}

const DL = 'grid grid-cols-[minmax(8rem,12rem)_1fr] gap-x-4 gap-y-1 text-sm';
const TABLE =
  'w-full border-collapse text-sm [&_td]:border-t [&_td]:border-foreground/15 [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_thead_th]:border-b [&_thead_th]:border-foreground/40 [&_thead_th]:text-xs [&_thead_th]:font-semibold';

export function ReportPreview({
  snapshot,
  changes,
  versionNo,
  reportNumber = null,
  issuedAt = null,
  markers = [],
  onMarker,
}: {
  snapshot: Snapshot;
  changes: readonly ConcreteSnapshotChange[];
  versionNo: number;
  /** The CF number once issued; before that the paper says "CF number at issue". */
  reportNumber?: string | null;
  issuedAt?: string | null;
  markers?: readonly PaperMarker[];
  onMarker?: (n: number) => void;
}) {
  const fields = obj(snapshot.fields);
  const technician = snapshot.technician as PersonSnapshot | null | undefined;
  const readings = list(fields.readings);
  const sets = list(snapshot.specimenSets);
  const attachments = list(fields.attachmentRefs);
  const mix = obj(snapshot.mixSnapshot);
  const mixSpec = obj(mix.spec);
  const sectionChanged = (key: PaperSectionKey) =>
    changes.some((c) => paperSectionOf(c.path) === key);
  const head = (key: PaperSectionKey) => (
    <SectionHead
      section={key}
      markers={markers}
      onMarker={onMarker}
      changed={sectionChanged(key)}
    />
  );
  return (
    <article
      className="flex flex-col gap-6 text-foreground"
      aria-labelledby="review-preview-heading"
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-foreground pb-3">
        <div>
          <p className="text-sm font-semibold">Material Mule Testing Laboratory</p>
          <p className="text-lg font-semibold">Concrete field report</p>
          <h2 id="review-preview-heading" className="text-xs text-muted-foreground">
            Review preview · version {versionNo}
          </h2>
        </div>
        <div className="text-right">
          <p className="font-mono text-sm font-semibold">{reportNumber ?? 'CF number at issue'}</p>
          <p className="text-xs text-muted-foreground">
            {reportNumber
              ? issuedAt
                ? `Issued ${issuedAt.slice(0, 10)}`
                : 'Issued'
              : 'Not issued'}
          </p>
        </div>
      </header>

      <section>
        <h3 className="mb-2 border-b border-foreground/20 pb-1 text-xs font-semibold tracking-wide uppercase">
          Project
        </h3>
        <dl className={DL}>
          <dt className="text-muted-foreground">Project</dt>
          <dd>
            <span className="font-mono">{String(snapshot.projectNumber ?? '')}</span>{' '}
            {String(snapshot.projectName ?? '')}
          </dd>
          <dt className="text-muted-foreground">Client</dt>
          <dd>{String(snapshot.client ?? '') || '—'}</dd>
          <dt className="text-muted-foreground">Field technician</dt>
          <dd>{technician?.name ?? '—'}</dd>
        </dl>
      </section>

      {FIELD_SECTIONS.map((section) => (
        <section key={section.key}>
          {head(section.key)}
          <dl className={DL}>
            {section.fields.map(([key, label]) => (
              <Field
                key={key}
                label={label}
                path={`fields.${key}`}
                value={formatValue(fields[key])}
                changes={changes}
              />
            ))}
            {section.key === 'load' ? (
              <Field
                label="Registry mix"
                path="mixSnapshot"
                changes={changes}
                value={
                  mix.mixId
                    ? `${formatValue(mixSpec.supplierName)} ${formatValue(mixSpec.mixNumber)}, revision ${formatValue(mix.revisionNumber)} (${formatValue(mix.revisionState)})`
                    : 'None chosen'
                }
              />
            ) : null}
          </dl>
        </section>
      ))}

      <section>
        {head('spec')}
        <div
          className="overflow-x-auto"
          role="region"
          aria-label="Specification and ticket"
          tabIndex={0}
        >
          <table className={TABLE}>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Project specification</th>
                <th scope="col">Ticket</th>
              </tr>
            </thead>
            <tbody>
              {SPEC_ROWS.map(([key, label]) => (
                <tr key={key}>
                  <th scope="row" className="font-normal">
                    {label}
                  </th>
                  {(['projectSpec', 'ticketSpec'] as const).map((column) => {
                    const path = `fields.${column}.${key}`;
                    const changed = concreteSnapshotChanged(changes, path);
                    return (
                      <td key={column} className="font-mono">
                        <span className={changed ? CHANGED_BG : undefined}>
                          {formatValue(obj(fields[column])[key])}
                        </span>
                        {changed ? <Changed change={changes.find((c) => c.path === path)} /> : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        {head('readings')}
        {readings.length === 0 ? (
          <p className="text-sm">No readings.</p>
        ) : (
          <div className="overflow-x-auto" role="region" aria-label="Readings" tabIndex={0}>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th scope="col">Test</th>
                  <th scope="col">Context</th>
                  <th scope="col">Value</th>
                  <th scope="col">Measured</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {readings.map((r) => {
                  const path = `fields.readings.${String(r.id)}`;
                  const changed = concreteSnapshotChanged(changes, path);
                  return (
                    <tr key={String(r.id)} className={changed ? 'bg-stage-due-bg' : undefined}>
                      <td>
                        {r.test === 'slump' ? 'Slump (mm)' : 'Air (%)'}
                        {changed ? <Changed change={undefined} /> : null}
                      </td>
                      <td>{formatValue(r.context)}</td>
                      <td className="font-mono">{formatValue(r.value)}</td>
                      <td className="font-mono">{formatValue(r.measuredAt)}</td>
                      <td>{formatValue(r.note)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        {head('specimens')}
        {sets.length === 0 ? (
          <p className="text-sm">No specimen sets.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {sets.map((set) => {
              const changed = concreteSnapshotChanged(changes, `specimenSets.${String(set.id)}`);
              const specimens = list(set.specimens);
              const letters = specimens.map((s) => formatValue(s.letter));
              return (
                <li key={String(set.id)} className={cn(changed && CHANGED_BG)}>
                  {formatValue(set.specimenType)} · mould {formatValue(set.mouldSize)} ·{' '}
                  {specimens.length} {specimens.length === 1 ? 'specimen' : 'specimens'}
                  {letters.length > 0 ? (
                    <span aria-label={`Specimens ${letters.join(', ')}`}>
                      {' '}
                      ({letters.join(', ')})
                    </span>
                  ) : null}
                  {changed ? <Changed change={undefined} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        {head('attachments')}
        {attachments.length === 0 ? (
          <p className="text-sm">No ticket attachments recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {attachments.map((a) => (
              <li key={String(a.id)}>
                {a.kind === 'ticket_photo' ? 'Ticket photo' : 'Ticket file'}:{' '}
                {formatValue(a.fileName)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="flex flex-wrap justify-between gap-2 border-t border-foreground/20 pt-2 text-xs text-muted-foreground">
        <span>Field report template P1 · Provisional template</span>
        <span>Results relate only to the items tested.</span>
      </footer>
    </article>
  );
}
