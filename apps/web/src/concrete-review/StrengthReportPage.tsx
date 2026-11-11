import {
  CONCRETE_EXCEPTION_LABEL,
  CONCRETE_STRENGTH_ASSESSMENT_LABEL,
  CONCRETE_STRENGTH_FLAG_LABEL,
  CONCRETE_STRENGTH_REPORT_STATE_LABEL,
  CONCRETE_STRENGTH_SUBMIT_BLOCKER_MESSAGE,
  formatPerson,
  type ConcreteExceptionNote,
  type ConcreteReportAction,
  type ConcreteReportVersionList,
  type ConcreteStrengthAgeLine,
  type ConcreteStrengthReportDetail,
  type ConcreteStrengthReportSnapshot,
  type ConcreteStrengthResultRow,
  type StaffOption,
} from '@materialmule/shared';
import { useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { listActiveStaff } from '../api/projects';
import {
  ErrorState,
  Notice,
  PageHeader,
  SidePanel,
  StatusBadge,
  TableScroll,
} from '../components/ui';
import { FactCells, SpecimenId } from '../concrete/ledger';
import { shortDateTime } from '../dashboard/format';
import { ContextRow } from '../layout/ContextRow';
import { useMe } from '../session/context';
import { ActionButton, CommentDialog, Labelled } from './ReviewReportPage';
import {
  documentStrengthException,
  fetchStrengthNotes,
  fetchStrengthReport,
  fetchStrengthSnapshot,
  fetchStrengthVersions,
  sendStrengthCommand,
  setStrengthExclusion,
  strengthProblemText,
} from './strength-api';
import './review.css';

// MM-V2-C39: a concrete compressive strength report (provisional design, G2 section 4): one per
// specimen set, cumulative. The set block and results table as the report prints them, the
// lifecycle commands the server allows (lab staff submit; a reviewer reviews or returns; an issuer
// issues; revise after issue), and the exceptions a reviewer documents before Mark reviewed.
// MM-V2-C24: strength, area, the per-age average and the advisory assessment come from the
// provisional method P1 (the method line shows which); a strength reviewer can exclude a specimen
// from its strength test, with a reason, before the report is submitted.
// Field Ledger (ConcreteStrength board): version, workflow, specified strength and method as four
// fact cells, then one framed table per test age with its average and assessment; an issued
// version's results are marked locked.

const dash = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? '—' : String(value);

export function StrengthStateBadge({ state }: { state: ConcreteStrengthReportDetail['state'] }) {
  const tone =
    state === 'issued'
      ? 'storage'
      : state === 'returned'
        ? 'danger'
        : state === 'submitted' || state === 'reviewed'
          ? 'waiting'
          : 'closed';
  return <StatusBadge tone={tone}>{CONCRETE_STRENGTH_REPORT_STATE_LABEL[state]}</StatusBadge>;
}

const ACTION_LABEL: Partial<Record<ConcreteReportAction, string>> = {
  submit: 'Submit for review',
  resubmit: 'Resubmit',
  recall: 'Recall',
  review: 'Mark reviewed',
  issue: 'Issue',
};

function resultStatus(row: ConcreteStrengthResultRow): string {
  if (row.status === 'hold') return 'HOLD';
  if (row.status === 'disposed') return 'Disposed';
  if (row.status === 'not_yet_tested') {
    return row.targetDate ? `Not yet tested (target ${row.targetDate})` : 'Not yet tested';
  }
  return 'Tested';
}

const mpa = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)} MPa`);

/** The specified strength as the set block holds it ("32 MPa at 28 d"), or "—". */
function specifiedText(set: ConcreteStrengthReportSnapshot['set']): string {
  if (set.specifiedStrengthMpa === null) return '—';
  return `${set.specifiedStrengthMpa} MPa${set.specifiedStrengthAgeDays ? ` at ${set.specifiedStrengthAgeDays} d` : ''}`;
}

/** The specimen's set part and letter, for the ledger identity (set ID + letter in a square). */
function specimenParts(row: ConcreteStrengthResultRow): { set: string; letter: string | null } {
  return row.letter && row.specimenLabel.endsWith(row.letter)
    ? { set: row.specimenLabel.slice(0, -row.letter.length), letter: row.letter }
    : { set: row.specimenLabel, letter: null };
}

type AgeGroup = {
  key: string;
  title: string;
  age: ConcreteStrengthAgeLine | null;
  rows: ConcreteStrengthResultRow[];
};

/** One group per test age (in the report's age order), then held and unassigned specimens. */
function ageGroups(snapshot: ConcreteStrengthReportSnapshot): AgeGroup[] {
  const groups: AgeGroup[] = snapshot.ages.map((age) => ({
    key: `age-${age.ageDays}`,
    title: `${age.ageDays} days`,
    age,
    rows: snapshot.results.filter((row) => row.assignedAge === age.ageDays),
  }));
  const known = new Set(snapshot.ages.map((age) => age.ageDays));
  for (const row of snapshot.results) {
    if (typeof row.assignedAge !== 'number' || known.has(row.assignedAge)) continue;
    known.add(row.assignedAge);
    groups.push({
      key: `age-${row.assignedAge}`,
      title: `${row.assignedAge} days`,
      age: null,
      rows: snapshot.results.filter((r) => r.assignedAge === row.assignedAge),
    });
  }
  const held = snapshot.results.filter((row) => row.assignedAge === 'HOLD');
  if (held.length > 0) groups.push({ key: 'hold', title: 'On hold', age: null, rows: held });
  const unassigned = snapshot.results.filter((row) => row.assignedAge === null);
  if (unassigned.length > 0) {
    groups.push({ key: 'none', title: 'No age assigned', age: null, rows: unassigned });
  }
  return groups.filter((group) => group.rows.length > 0 || group.age !== null);
}

function AgeHead({ group, locked }: { group: AgeGroup; locked: boolean }) {
  const { age } = group;
  return (
    <div className="crv-age-head">
      <h3 id={`crv-${group.key}`}>{group.title}</h3>
      {age ? (
        <>
          <span className="mono crv-age-average">
            Average strength {mpa(age.averageStrength)}
            {age.single ? ' (single specimen)' : ''}
          </span>
          <span className="crv-age-count">
            {age.testedCount} of {age.specimenCount} tested{age.complete ? '' : ' (incomplete)'}
          </span>
          <span className="crv-age-assessment">
            <span className="field-label">Assessment</span>{' '}
            {age.assessment ? (
              <StatusBadge tone={age.failed ? 'danger' : 'closed'}>
                {CONCRETE_STRENGTH_ASSESSMENT_LABEL[age.assessment]}
              </StatusBadge>
            ) : (
              '—'
            )}
          </span>
          {age.runningAverage !== null ? (
            <span className="mono crv-age-count">Running average {mpa(age.runningAverage)}</span>
          ) : null}
        </>
      ) : null}
      {locked ? <StatusBadge tone="closed">Locked</StatusBadge> : null}
    </div>
  );
}

export function StrengthReportBody({
  snapshot,
  onExclude,
  excludable,
  locked = false,
}: {
  snapshot: ConcreteStrengthReportSnapshot;
  /** Offered on the live preview to a strength reviewer (MM-V2-C24). */
  onExclude?: (row: ConcreteStrengthResultRow) => void;
  /** The specimens whose exclusion may change now (review fix); others show no control. */
  excludable?: readonly string[];
  /** The shown version is issued: its results are locked (a change needs a revision). */
  locked?: boolean;
}) {
  const s = snapshot.set;
  const elements = [
    ...s.structureElements,
    ...(s.structureElementOther ? [s.structureElementOther] : []),
  ];
  return (
    <div className="crv-preview">
      <div className="crv-preview-head">
        <h2>Concrete compressive strength report · Rev {snapshot.revNo}</h2>
        {snapshot.revision ? (
          <p className="crv-preview-notice">
            Rev {snapshot.revNo}, supersedes Rev {snapshot.revision.supersedesRevNo} issued{' '}
            {snapshot.revision.supersedesIssuedAt.slice(0, 10)}: {snapshot.revision.reason}
          </p>
        ) : null}
      </div>
      {locked ? (
        <p className="crv-locked">
          <StatusBadge tone="closed">Locked</StatusBadge> These results are on an issued version.
          Changing one means starting a revision with a reason.
        </p>
      ) : null}
      <section className="crv-ages" aria-label="Results">
        {ageGroups(snapshot).map((group) => (
          <section key={group.key} className="crv-age" aria-labelledby={`crv-${group.key}`}>
            <AgeHead group={group} locked={locked && group.age !== null} />
            {group.rows.length === 0 ? (
              <p className="crv-age-empty">No specimens at this age.</p>
            ) : (
              <TableScroll label={`Strength results, ${group.title}`}>
                <table className="crv-table">
                  <caption className="visually-hidden">Strength results, {group.title}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Specimen</th>
                      <th scope="col">Test date</th>
                      <th scope="col">Actual age (d)</th>
                      <th scope="col">Diameters ({snapshot.units.dimension})</th>
                      <th scope="col">Heights ({snapshot.units.dimension})</th>
                      <th scope="col">Area</th>
                      <th scope="col">Max load ({snapshot.units.load})</th>
                      <th scope="col">Strength</th>
                      <th scope="col">Fracture</th>
                      <th scope="col">Tested by</th>
                      <th scope="col">Remarks</th>
                      {onExclude ? <th scope="col">Strength test</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row) => {
                      const parts = specimenParts(row);
                      return (
                        <tr key={row.specimenId}>
                          <th scope="row">
                            {/* Read as one ID ("26-07A"); shown as the set ID + letter square. */}
                            <span className="visually-hidden">{row.specimenLabel}</span>
                            <span aria-hidden="true">
                              <SpecimenId set={parts.set} letter={parts.letter} />
                            </span>
                          </th>
                          <td className="mono">
                            {row.status === 'tested' ? dash(row.testedOn) : resultStatus(row)}
                          </td>
                          <td className="mono">{dash(row.actualAgeDays)}</td>
                          <td className="mono">
                            {row.diameterReadings.length ? row.diameterReadings.join(', ') : '—'}
                          </td>
                          <td className="mono">
                            {row.heightReadings.length ? row.heightReadings.join(', ') : '—'}
                          </td>
                          <td className="mono">{row.area === null ? '—' : `${row.area} mm²`}</td>
                          <td className="mono crv-strong">{dash(row.maxLoad)}</td>
                          <td className="mono crv-strong">
                            <span className={row.excluded ? 'crv-struck' : undefined}>
                              {mpa(row.strength)}
                            </span>
                            {row.calculationMethodVersion ? (
                              <span className="crv-muted"> ({row.calculationMethodVersion})</span>
                            ) : null}
                            {row.excluded ? (
                              <span className="crv-muted crv-excluded">
                                {' '}
                                Excluded: {row.excluded.reason} ({row.excluded.by.name})
                              </span>
                            ) : null}
                          </td>
                          <td>{dash(row.fractureType)}</td>
                          <td>{dash(row.testedBy?.initials ?? row.testedBy?.name)}</td>
                          <td>
                            {dash(row.remarks)}
                            {row.flags.map((flag) => (
                              <StatusBadge key={flag} tone="waiting">
                                {CONCRETE_STRENGTH_FLAG_LABEL[flag]}
                              </StatusBadge>
                            ))}
                          </td>
                          {onExclude ? (
                            <td>
                              {(row.status === 'tested' || row.excluded) &&
                              (!excludable || excludable.includes(row.specimenId)) ? (
                                <button
                                  type="button"
                                  aria-label={`${row.excluded ? 'Reinstate' : 'Exclude'} ${row.specimenLabel}`}
                                  onClick={() => onExclude(row)}
                                >
                                  {row.excluded ? 'Reinstate' : 'Exclude'}
                                </button>
                              ) : null}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </section>
        ))}
        {snapshot.calculation.method ? (
          <p className="crv-advisory">
            The assessment is advisory, for the reviewer: never acceptance. Only the reference age
            is assessed; other ages are information only.
          </p>
        ) : null}
        <p className="field-hint">
          {snapshot.standardsLine} Units as entered ({snapshot.units.load},{' '}
          {snapshot.units.dimension}
          {snapshot.units.provisional ? ', provisional' : ''}).
        </p>
      </section>
      <section className="crv-preview-section" aria-label="Set">
        <h3>Set</h3>
        <dl className="crv-fields">
          <Labelled label="Project">
            {snapshot.projectNumber} · {snapshot.projectName}
          </Labelled>
          <Labelled label="Client">{dash(snapshot.client)}</Labelled>
          <Labelled label="Lead Project Engineer">
            {snapshot.leadProjectEngineer
              ? formatPerson(
                  snapshot.leadProjectEngineer.initials,
                  snapshot.leadProjectEngineer.name,
                )
              : '—'}
          </Labelled>
          <Labelled label="Set ID">
            {dash(s.identity.permanentId ?? s.identity.temporaryId)}
          </Labelled>
          <Labelled label="Field report">{dash(s.fieldReportNumber)}</Labelled>
          <Labelled label="Field ID">{dash(s.paperFieldId)}</Labelled>
          <Labelled label="Cast">{s.castAt ? shortDateTime(s.castAt) : '—'}</Labelled>
          <Labelled label="Structure / element">{dash(elements.join(', '))}</Labelled>
          <Labelled label="Location">{dash(s.location)}</Labelled>
          <Labelled label="Supplier">{dash(s.supplierName)}</Labelled>
          <Labelled label="Mix number">{dash(s.mixNumber)}</Labelled>
          <Labelled label="Specimen size">{dash(s.specimenSize)}</Labelled>
          <Labelled label="Received at the lab">{dash(s.receivedOn)}</Labelled>
          <Labelled label="Initial field curing">{dash(s.initialFieldCuring)}</Labelled>
          <Labelled label="Lab curing">{dash(s.labCuring)}</Labelled>
        </dl>
      </section>
    </div>
  );
}

function ExceptionList({
  snapshot,
  notes,
  canDocument,
  onDocument,
}: {
  snapshot: ConcreteStrengthReportSnapshot;
  notes: ConcreteExceptionNote[];
  canDocument: boolean;
  onDocument: (code: string, field: string | null, note: string) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (snapshot.warnings.length === 0) return <p className="crv-muted">No exceptions.</p>;
  return (
    <ul className="crv-checklist">
      {snapshot.warnings.map((w) => {
        const key = `${w.code}|${w.field ?? ''}`;
        const note = notes.find((n) => n.code === w.code && n.field === w.field);
        return (
          <li key={key} className={note ? 'crv-check-item' : 'crv-check-item crv-check-open'}>
            <strong>{CONCRETE_EXCEPTION_LABEL[w.code]}</strong> ·{' '}
            {w.field?.replace('results.', 'Specimen ')}
            {note ? (
              <p className="crv-note">
                Documented by {note.documentedBy.name}: {note.note}
              </p>
            ) : canDocument ? (
              <form
                className="crv-note-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const text = (drafts[key] ?? '').trim();
                  if (text) void onDocument(w.code, w.field, text);
                }}
              >
                <label>
                  How it was addressed
                  <textarea
                    value={drafts[key] ?? ''}
                    maxLength={2000}
                    onChange={(event) => setDrafts({ ...drafts, [key]: event.target.value })}
                  />
                </label>
                <button type="submit">Document</button>
              </form>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | {
      state: 'ready';
      detail: ConcreteStrengthReportDetail;
      /** The latest submitted, reviewed or issued version as frozen, or null (live preview). */
      frozen: ConcreteStrengthReportSnapshot | null;
      notes: ConcreteExceptionNote[];
      history: ConcreteReportVersionList | null;
    };

export function StrengthReportPage() {
  const { setId = '' } = useParams();
  const me = useMe();
  const sharedStation = me.accountType === 'shared_lab';
  const staffId = useId();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [dialog, setDialog] = useState<'return' | 'revise' | null>(null);
  const [excluding, setExcluding] = useState<ConcreteStrengthResultRow | null>(null);
  // Review fix: after an issue, the new later-age results can be viewed live (and excluded).
  const [live, setLive] = useState(false);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [performer, setPerformer] = useState('');

  useEffect(() => {
    if (!sharedStation) return;
    void listActiveStaff()
      .then((list) => setStaff(list.filter((p) => p.initials)))
      .catch(() => setStaff([]));
  }, [sharedStation]);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const detail = await fetchStrengthReport(setId);
        const latest = detail.latestVersion;
        const frozen =
          latest && !['not_started', 'draft', 'returned'].includes(detail.state)
            ? await fetchStrengthSnapshot(setId, latest.versionNo)
            : null;
        const notes =
          latest && frozen ? (await fetchStrengthNotes(setId, latest.versionNo)).notes : [];
        const history = detail.reportId ? await fetchStrengthVersions(setId) : null;
        if (current) {
          setLoad({ state: 'ready', detail, frozen, notes, history });
        }
      } catch (error) {
        if (current) setLoad({ state: 'error', message: strengthProblemText(error) });
      }
    })();
    return () => {
      current = false;
    };
  }, [setId, attempt]);

  if (load.state === 'loading') return <p aria-busy="true">Loading the strength report…</p>;
  if (load.state === 'error') {
    return (
      <div className="crv-page">
        <ContextRow>
          <Link to="/concrete/review">Back to the review queue</Link>
        </ContextRow>
        <ErrorState message={load.message} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    );
  }
  const { detail, frozen, notes, history } = load;
  const showLive = frozen === null || (live && detail.state === 'issued');
  const shown = showLive || frozen === null ? detail.preview : frozen;
  const allowed = new Set(detail.allowedActions);
  const label =
    shown.set.identity.permanentId ?? shown.set.identity.temporaryId ?? 'Unnumbered set';
  const needsPerformer = sharedStation && performer === '';

  async function run(action: ConcreteReportAction, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setMessage(null);
    try {
      const lab = action === 'submit' || action === 'resubmit' || action === 'recall';
      await sendStrengthCommand(setId, action, {
        idempotencyKey: crypto.randomUUID(),
        version: detail.version,
        ...(lab && sharedStation ? { performedByUserId: performer } : {}),
        ...extra,
      });
      setDialog(null);
      setMessage({ error: false, text: 'Saved.' });
      setAttempt((n) => n + 1);
    } catch (error) {
      setMessage({ error: true, text: strengthProblemText(error) });
    } finally {
      setBusy(false);
    }
  }

  const blockFor = (action: ConcreteReportAction): string | null => {
    if (allowed.has(action)) {
      return needsPerformer && ['submit', 'resubmit', 'recall'].includes(action)
        ? 'Choose who is doing this first.'
        : null;
    }
    if ((action === 'submit' || action === 'resubmit') && detail.submitBlocker) {
      return CONCRETE_STRENGTH_SUBMIT_BLOCKER_MESSAGE[detail.submitBlocker];
    }
    if ((action === 'review' || action === 'issue') && detail.selfReviewUserIds.includes(me.id)) {
      return 'You entered or tested these results alone: someone else reviews and issues it.';
    }
    return 'Not available to you at this stage.';
  };
  const offered = (['submit', 'resubmit', 'recall', 'review', 'issue'] as const).filter(
    (action) =>
      allowed.has(action) ||
      (action === 'submit' && ['not_started', 'draft', 'issued'].includes(detail.state)) ||
      (action === 'resubmit' && detail.state === 'returned') ||
      (action === 'review' && detail.state === 'submitted') ||
      (action === 'issue' && detail.state === 'reviewed'),
  );
  const canDocument = allowed.has('review') && detail.state === 'submitted';

  const shownFrozen = !showLive && frozen !== null;
  return (
    <div className="crv-page crv-strength">
      <ContextRow>
        <Link to="/concrete/review">Back to the review queue</Link>
        {detail.reportNumber ? <span className="mono">{detail.reportNumber}</span> : null}
        {detail.latestVersion?.issued?.file ? (
          <a href={`/api/concrete/report-files/${detail.latestVersion.issued.file.id}`}>
            Download Rev {detail.latestVersion.issued.file.revisionNo} (PDF)
          </a>
        ) : null}
        {detail.newResults && detail.state === 'issued' ? (
          <>
            <StatusBadge tone="lab">New results to submit</StatusBadge>
            <button type="button" aria-pressed={live} onClick={() => setLive((v) => !v)}>
              {live ? 'Show the issued version' : 'Show the new results'}
            </button>
          </>
        ) : null}
      </ContextRow>
      <PageHeader title={`Strength report ${label}`} />
      <FactCells
        label="Strength report"
        className="crv-facts"
        cells={[
          {
            key: 'version',
            label: 'Version',
            value: (
              <>
                <span className="crv-fact-value">Rev {shown.revNo}</span>
                <span className="crv-fact-note">
                  {shownFrozen
                    ? `Version ${shown.versionNo} as submitted`
                    : 'As it would be submitted now'}
                </span>
              </>
            ),
          },
          {
            key: 'workflow',
            label: 'Workflow',
            value: (
              <>
                <StrengthStateBadge state={detail.state} />
                <span className="crv-fact-note">
                  {detail.latestVersion
                    ? `Latest: version ${detail.latestVersion.versionNo}`
                    : 'No version submitted yet'}
                </span>
              </>
            ),
          },
          {
            key: 'specified',
            label: 'Specified',
            value: (
              <>
                <span className="crv-fact-value mono">{specifiedText(shown.set)}</span>
                <span className="crv-fact-note">From the project spec on the field report</span>
              </>
            ),
          },
          {
            key: 'method',
            label: 'Method',
            value: (
              <>
                <span className="crv-fact-value">
                  {shown.calculation.method ? shown.calculation.method.line : 'Not calculated'}
                </span>
                <span className="crv-fact-note">{shown.calculation.note}</span>
              </>
            ),
          },
        ]}
      />
      {message ? (
        <Notice tone={message.error ? 'danger' : 'success'} className="crv-message">
          {message.text}
        </Notice>
      ) : null}

      <div className="crv-layout">
        <div className="crv-main">
          <StrengthReportBody
            snapshot={shown}
            onExclude={detail.canExclude && showLive ? setExcluding : undefined}
            excludable={detail.excludableSpecimenIds}
            locked={shownFrozen && detail.state === 'issued'}
          />
        </div>
        <div className="crv-side">
          <SidePanel title="Actions">
            {sharedStation ? (
              <div className="form-field">
                <label htmlFor={staffId}>Who is doing this</label>
                <select
                  id={staffId}
                  value={performer}
                  onChange={(e) => setPerformer(e.target.value)}
                >
                  <option value="">Choose a person</option>
                  {staff.map((p) => (
                    <option key={p.id} value={p.id}>
                      {formatPerson(p.initials, p.displayName)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="crv-action-stack">
              {offered.map((action) => (
                <ActionButton
                  key={action}
                  label={ACTION_LABEL[action]!}
                  block={blockFor(action)}
                  primary={action === 'submit' || action === 'review' || action === 'issue'}
                  busy={busy}
                  onClick={() => void run(action)}
                />
              ))}
              {allowed.has('return') ? (
                <ActionButton
                  label="Return for correction"
                  block={null}
                  busy={busy}
                  onClick={() => setDialog('return')}
                />
              ) : null}
              {allowed.has('revise') ? (
                <ActionButton
                  label="Start a revision"
                  block={null}
                  busy={busy}
                  onClick={() => setDialog('revise')}
                />
              ) : null}
              {offered.length === 0 && !allowed.has('return') && !allowed.has('revise') ? (
                <p className="crv-muted">Nothing for you to do at this stage.</p>
              ) : null}
            </div>
          </SidePanel>
          <SidePanel title="Exceptions">
            <ExceptionList
              snapshot={shown}
              notes={notes}
              canDocument={canDocument}
              onDocument={async (code, field, note) => {
                try {
                  await documentStrengthException(setId, detail.latestVersion!.versionNo, {
                    code: code as never,
                    field,
                    note,
                  });
                  setAttempt((n) => n + 1);
                } catch (error) {
                  setMessage({ error: true, text: strengthProblemText(error) });
                }
              }}
            />
          </SidePanel>
          {history ? (
            <SidePanel title="Versions">
              <ol className="crv-history">
                {history.versions.map((v) => (
                  <li key={v.id}>
                    <span className="mono">v{v.versionNo}</span> · {v.state}
                    {v.revisionOfVersionNo ? ` (revises v${v.revisionOfVersionNo})` : ''} ·{' '}
                    {shortDateTime(v.submittedAt)}
                  </li>
                ))}
              </ol>
            </SidePanel>
          ) : null}
        </div>
      </div>

      <CommentDialog
        open={excluding !== null}
        title={
          excluding?.excluded ? 'Reinstate in the strength test' : 'Exclude from the strength test'
        }
        label="Reason"
        hint={
          excluding?.excluded
            ? 'The specimen counts in its age’s average again.'
            : 'The specimen stays listed, struck from its age’s average (e.g. defective specimen).'
        }
        confirmLabel={excluding?.excluded ? 'Reinstate' : 'Exclude'}
        busy={busy}
        error={message?.error ? message.text : null}
        onConfirm={(reason) => {
          const row = excluding!;
          setBusy(true);
          setMessage(null);
          void setStrengthExclusion(row.specimenId, !row.excluded, reason)
            .then(() => {
              setExcluding(null);
              setMessage({ error: false, text: 'Saved.' });
              setAttempt((n) => n + 1);
            })
            .catch((error: unknown) =>
              setMessage({ error: true, text: strengthProblemText(error) }),
            )
            .finally(() => setBusy(false));
        }}
        onCancel={() => setExcluding(null)}
      />

      <CommentDialog
        open={dialog !== null}
        title={dialog === 'revise' ? 'Start a revision' : 'Return for correction'}
        label={dialog === 'revise' ? 'Revision reason' : 'Changes needed'}
        hint={
          dialog === 'revise'
            ? 'Prints on the revised report. The issued version stays exactly as issued.'
            : 'The lab sees this comment and corrects the results.'
        }
        confirmLabel={dialog === 'revise' ? 'Start revision' : 'Return'}
        busy={busy}
        error={message?.error ? message.text : null}
        onConfirm={(comment) => void run(dialog!, { comment })}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
