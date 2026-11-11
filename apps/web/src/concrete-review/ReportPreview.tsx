import {
  concreteSnapshotChanged,
  type ConcreteSnapshotChange,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { ReactNode } from 'react';
import { FactCells } from '../concrete/ledger';
import { shortDateTime } from '../dashboard/format';

// MM-V2-C28: the interim review preview of one submitted version, built from its frozen snapshot
// (never the live report). It is not the issued format: C32 owns the final layout. Changed fields
// since the previous version carry a visible "Changed" mark and the previous value (AC3); every
// field is still shown, so the full record stays available.
// Field Ledger (ConcreteReport board, only for what this preview already shows): the project as
// fact cells, framed tables for specification / ticket and readings, specimens as letter cards.

type Snapshot = Record<string, unknown>;

const FIELD_SECTIONS: { title: string; fields: [string, string][] }[] = [
  {
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

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function formatValue(value: unknown): string {
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

function Changed({ change }: { change: ConcreteSnapshotChange | undefined }) {
  return (
    // `review-changed-mark` is the hook the E2E specs count changed fields by.
    <span className="review-changed-mark">
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
    <div className={changed ? 'crv-field crv-changed' : 'crv-field'} data-path={path}>
      <dt>{label}</dt>
      <dd>
        {value}
        {changed ? <Changed change={exact} /> : null}
      </dd>
    </div>
  );
}

export function ReportPreview({
  snapshot,
  changes,
  versionNo,
}: {
  snapshot: Snapshot;
  changes: readonly ConcreteSnapshotChange[];
  versionNo: number;
}) {
  const fields = obj(snapshot.fields);
  const technician = snapshot.technician as PersonSnapshot | null | undefined;
  const readings = list(fields.readings);
  const sets = list(snapshot.specimenSets);
  const attachments = list(fields.attachmentRefs);
  const mix = obj(snapshot.mixSnapshot);
  const mixSpec = obj(mix.spec);
  return (
    <article className="crv-preview" aria-labelledby="review-preview-heading">
      <header className="crv-preview-head">
        <h2 id="review-preview-heading">Review preview · version {versionNo}</h2>
        <p className="crv-preview-notice">
          Interim review preview of the version as submitted. This is not the issued report format.
        </p>
        <FactCells
          label="Project"
          cells={[
            {
              key: 'project',
              label: 'Project',
              value: (
                <>
                  <span className="mono">{String(snapshot.projectNumber ?? '')}</span>{' '}
                  {String(snapshot.projectName ?? '')}
                </>
              ),
            },
            { key: 'client', label: 'Client', value: String(snapshot.client ?? '') || '—' },
            { key: 'technician', label: 'Technician', value: technician?.name ?? '—' },
          ]}
        />
      </header>

      {FIELD_SECTIONS.map((section) => (
        <section key={section.title} className="crv-preview-section">
          <h3>{section.title}</h3>
          <dl className="crv-fields">
            {section.fields.map(([key, label]) => (
              <Field
                key={key}
                label={label}
                path={`fields.${key}`}
                value={formatValue(fields[key])}
                changes={changes}
              />
            ))}
            {section.title === 'Project and load' ? (
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

      <section className="crv-preview-section">
        <h3>Specification and ticket</h3>
        <div
          className="table-scroll table-frame"
          role="region"
          aria-label="Specification and ticket"
          tabIndex={0}
        >
          <table className="crv-table">
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
                  <th scope="row">{label}</th>
                  {(['projectSpec', 'ticketSpec'] as const).map((column) => {
                    const path = `fields.${column}.${key}`;
                    const changed = concreteSnapshotChanged(changes, path);
                    return (
                      <td key={column} className={changed ? 'mono crv-changed' : 'mono'}>
                        {formatValue(obj(fields[column])[key])}
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

      <section className="crv-preview-section">
        <h3>Slump and air readings</h3>
        {readings.length === 0 ? (
          <p>No readings.</p>
        ) : (
          <div
            className="table-scroll table-frame"
            role="region"
            aria-label="Readings"
            tabIndex={0}
          >
            <table className="crv-table">
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
                    <tr key={String(r.id)} className={changed ? 'crv-row-changed' : undefined}>
                      <td>
                        {r.test === 'slump' ? 'Slump (mm)' : 'Air (%)'}
                        {changed ? <Changed change={undefined} /> : null}
                      </td>
                      <td>{formatValue(r.context)}</td>
                      <td className="mono">{formatValue(r.value)}</td>
                      <td className="mono">{formatValue(r.measuredAt)}</td>
                      <td>{formatValue(r.note)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="crv-preview-section">
        <h3>Specimens</h3>
        {sets.length === 0 ? (
          <p>No specimen sets.</p>
        ) : (
          <ul className="crv-sets">
            {sets.map((set) => {
              const changed = concreteSnapshotChanged(changes, `specimenSets.${String(set.id)}`);
              const specimens = list(set.specimens);
              const letters = specimens.map((s) => formatValue(s.letter));
              return (
                <li key={String(set.id)} className={changed ? 'crv-set crv-changed' : 'crv-set'}>
                  <span>
                    {formatValue(set.specimenType)} · mould {formatValue(set.mouldSize)} ·{' '}
                    {specimens.length} {specimens.length === 1 ? 'specimen' : 'specimens'}
                  </span>
                  {letters.length > 0 ? (
                    <ul className="crv-letters" aria-label={`Specimens ${letters.join(', ')}`}>
                      {letters.map((letter, i) => (
                        <li key={i} className="specimen-letter">
                          {letter}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {changed ? <Changed change={undefined} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="crv-preview-section">
        <h3>Attachments</h3>
        {attachments.length === 0 ? (
          <p>No ticket attachments recorded.</p>
        ) : (
          <ul className="crv-list">
            {attachments.map((a) => (
              <li key={String(a.id)}>
                {a.kind === 'ticket_photo' ? 'Ticket photo' : 'Ticket file'}:{' '}
                {formatValue(a.fileName)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
