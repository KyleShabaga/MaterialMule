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
import { Eye, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { listActiveStaff } from '../api/projects';
import { StageTag } from '../components/strata/stage-tag';
import { shortDateTime } from '../dashboard/format';
import { useMe } from '../session/context';
import { useOptionalRecordingPerson } from '../session/recording-person-store';
import {
  PanelSection,
  ReportHeader,
  ReportLoading,
  ReportPaper,
  ReportSplit,
  ReportSteps,
  type StepState,
} from './ReportLayout';
import { ActionButton, CommentDialog, Labelled, PANEL_DL } from './ReviewReportPage';
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
// STRATA-99 (boards R8Strength*), gated by G2: only restyled into the report page's structure
// (paper left, panel right). The output, calculations, units, methods line and actions are
// exactly the existing ones; the paper is marked provisional. Review and issue use the separate
// concrete_strength scope (the server decides who may act; this page shows its answer).

const dash = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? '—' : String(value);

const STRENGTH_STAGE = {
  not_started: 'draft',
  draft: 'draft',
  submitted: 'due',
  returned: 'danger',
  reviewed: 'due',
  issued: 'closed',
} as const;

export function StrengthStateBadge({ state }: { state: ConcreteStrengthReportDetail['state'] }) {
  return (
    <StageTag
      stage={STRENGTH_STAGE[state as keyof typeof STRENGTH_STAGE] ?? 'closed'}
      label={CONCRETE_STRENGTH_REPORT_STATE_LABEL[state]}
    />
  );
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
    <div className="mb-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-foreground/20 pb-1 text-sm">
      <h3 id={`crv-${group.key}`} className="text-xs font-semibold tracking-wide uppercase">
        {group.title}
      </h3>
      {age ? (
        <>
          <span className="font-mono">
            Average strength {mpa(age.averageStrength)}
            {age.single ? ' (single specimen)' : ''}
          </span>
          <span className="text-muted-foreground">
            {age.testedCount} of {age.specimenCount} tested{age.complete ? '' : ' (incomplete)'}
          </span>
          <span className="flex items-center gap-1">
            <span className="text-muted-foreground">Assessment</span>{' '}
            {age.assessment ? (
              <Badge variant={age.failed ? 'danger' : 'closed'}>
                {CONCRETE_STRENGTH_ASSESSMENT_LABEL[age.assessment]}
              </Badge>
            ) : (
              '—'
            )}
          </span>
          {age.runningAverage !== null ? (
            <span className="font-mono text-muted-foreground">
              Running average {mpa(age.runningAverage)}
            </span>
          ) : null}
        </>
      ) : null}
      {locked ? <Badge variant="closed">Locked</Badge> : null}
    </div>
  );
}

const TABLE =
  'w-full border-collapse text-sm [&_td]:border-t [&_td]:border-foreground/15 [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_thead_th]:border-b [&_thead_th]:border-foreground/40 [&_thead_th]:text-xs [&_thead_th]:font-semibold';

/** The report as it prints (provisional design, G2): kept exactly as before, drawn as paper. */
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
    <div className="flex flex-col gap-6 text-foreground">
      <p className="text-xs font-semibold text-stage-due-fg">
        Provisional design · G2 open · not for issue as drawn
      </p>
      <div className="border-b-2 border-foreground pb-3">
        <p className="text-sm font-semibold">Material Mule Testing Laboratory</p>
        <h2 className="text-lg font-semibold">
          Concrete compressive strength report · Rev {snapshot.revNo}
        </h2>
        {snapshot.revision ? (
          <p className="text-sm text-muted-foreground">
            Rev {snapshot.revNo}, supersedes Rev {snapshot.revision.supersedesRevNo} issued{' '}
            {snapshot.revision.supersedesIssuedAt.slice(0, 10)}: {snapshot.revision.reason}
          </p>
        ) : null}
      </div>
      {locked ? (
        <p className="flex items-center gap-2 text-sm">
          <Badge variant="closed">Locked</Badge> These results are on an issued version. Changing
          one means starting a revision with a reason.
        </p>
      ) : null}
      <section className="flex flex-col gap-4" aria-label="Results">
        {ageGroups(snapshot).map((group) => (
          <section key={group.key} aria-labelledby={`crv-${group.key}`}>
            <AgeHead group={group} locked={locked && group.age !== null} />
            {group.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No specimens at this age.</p>
            ) : (
              <div
                className="overflow-x-auto"
                role="region"
                aria-label={`Strength results, ${group.title}`}
                tabIndex={0}
              >
                <table className={TABLE}>
                  <caption className="sr-only">Strength results, {group.title}</caption>
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
                    {group.rows.map((row) => (
                      <tr key={row.specimenId}>
                        <th scope="row" className="font-mono font-semibold">
                          {row.specimenLabel}
                        </th>
                        <td className="font-mono">
                          {row.status === 'tested' ? dash(row.testedOn) : resultStatus(row)}
                        </td>
                        <td className="font-mono">{dash(row.actualAgeDays)}</td>
                        <td className="font-mono">
                          {row.diameterReadings.length ? row.diameterReadings.join(', ') : '—'}
                        </td>
                        <td className="font-mono">
                          {row.heightReadings.length ? row.heightReadings.join(', ') : '—'}
                        </td>
                        <td className="font-mono">{row.area === null ? '—' : `${row.area} mm²`}</td>
                        <td className="font-mono font-semibold">{dash(row.maxLoad)}</td>
                        <td className="font-mono font-semibold">
                          <span className={row.excluded ? 'line-through' : undefined}>
                            {mpa(row.strength)}
                          </span>
                          {row.calculationMethodVersion ? (
                            <span className="font-normal text-muted-foreground">
                              {' '}
                              ({row.calculationMethodVersion})
                            </span>
                          ) : null}
                          {row.excluded ? (
                            <span className="font-sans font-normal text-muted-foreground">
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
                            <Badge key={flag} variant="due" className="ml-1">
                              {CONCRETE_STRENGTH_FLAG_LABEL[flag]}
                            </Badge>
                          ))}
                        </td>
                        {onExclude ? (
                          <td>
                            {(row.status === 'tested' || row.excluded) &&
                            (!excludable || excludable.includes(row.specimenId)) ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={`${row.excluded ? 'Reinstate' : 'Exclude'} ${row.specimenLabel}`}
                                onClick={() => onExclude(row)}
                              >
                                {row.excluded ? 'Reinstate' : 'Exclude'}
                              </Button>
                            ) : null}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
        {snapshot.calculation.method ? (
          <p className="text-sm text-muted-foreground">
            The assessment is advisory, for the reviewer: never acceptance. Only the reference age
            is assessed; other ages are information only.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {snapshot.standardsLine} Units as entered ({snapshot.units.load},{' '}
          {snapshot.units.dimension}
          {snapshot.units.provisional ? ', provisional' : ''}).
        </p>
      </section>
      <section aria-label="Set">
        <h3 className="mb-2 border-b border-foreground/20 pb-1 text-xs font-semibold tracking-wide uppercase">
          Set
        </h3>
        <dl className="grid grid-cols-[minmax(8rem,12rem)_1fr] gap-x-4 gap-y-1 text-sm">
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
      <footer className="flex flex-wrap justify-between gap-2 border-t border-foreground/20 pt-2 text-xs text-muted-foreground">
        <span>Strength report template · Provisional (G2 open)</span>
        <span>Results relate only to the items tested.</span>
      </footer>
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
  const [missing, setMissing] = useState<string | null>(null);
  const baseId = useId();
  if (snapshot.warnings.length === 0) {
    return <p className="text-sm text-muted-foreground">No exceptions.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {snapshot.warnings.map((w, i) => {
        const key = `${w.code}|${w.field ?? ''}`;
        const note = notes.find((n) => n.code === w.code && n.field === w.field);
        const fieldId = `${baseId}-${i}`;
        return (
          <li key={key} className="flex flex-col gap-2 rounded-md border p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <span>
                <strong>{CONCRETE_EXCEPTION_LABEL[w.code]}</strong>
                {w.field ? ` · ${w.field.replace('results.', 'Specimen ')}` : ''}
              </span>
              {note ? (
                <StageTag stage="closed" label="Documented" />
              ) : (
                <StageTag stage="danger" label="Open" />
              )}
            </div>
            {note ? (
              <p className="rounded-md bg-muted px-2 py-1.5">
                Documented by {note.documentedBy.name}: {note.note}
              </p>
            ) : canDocument ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const text = (drafts[key] ?? '').trim();
                  if (!text) {
                    setMissing(key);
                    return;
                  }
                  void onDocument(w.code, w.field, text);
                }}
              >
                <Field data-invalid={missing === key ? true : undefined}>
                  <FieldLabel htmlFor={fieldId}>How it was addressed</FieldLabel>
                  <Textarea
                    id={fieldId}
                    rows={2}
                    maxLength={2000}
                    placeholder="Enter a note explaining how it was addressed."
                    value={drafts[key] ?? ''}
                    onChange={(event) => {
                      setDrafts({ ...drafts, [key]: event.target.value });
                      setMissing(null);
                    }}
                  />
                  {missing === key ? (
                    <FieldError>Enter a note explaining how it was addressed.</FieldError>
                  ) : null}
                </Field>
                <div>
                  <Button type="submit" variant="outline" size="sm">
                    Document
                  </Button>
                </div>
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

function strengthSteps(state: ConcreteStrengthReportDetail['state']): {
  review: StepState;
  issue: StepState;
} {
  if (state === 'issued') return { review: 'done', issue: 'done' };
  if (state === 'reviewed') return { review: 'done', issue: 'now' };
  return { review: 'now', issue: 'later' };
}

export function StrengthReportPage() {
  const { setId = '' } = useParams();
  const me = useMe();
  const recording = useOptionalRecordingPerson();
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
  const [chosenPerformer, setPerformer] = useState('');
  // A LAB station's picked person is the starting choice (attribution only); it can be changed.
  const performer = chosenPerformer || (recording?.isStation ? (recording.person?.id ?? '') : '');

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

  if (load.state === 'loading') return <ReportLoading label="Loading the strength report" />;
  if (load.state === 'error') {
    return (
      <div className="flex flex-col gap-4">
        <ReportHeader crumb="Strength report" title="Strength report" />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlert aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Couldn’t load this strength report.</EmptyTitle>
            <EmptyDescription>{load.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button onClick={() => setAttempt((n) => n + 1)}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
            <Button variant="outline" asChild>
              <Link to="/concrete/review">Back to the review queue</Link>
            </Button>
          </EmptyContent>
        </Empty>
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
  const steps = strengthSteps(detail.state);
  const file = detail.latestVersion?.issued?.file ?? null;

  const footer = (
    <>
      {message ? (
        message.error ? (
          <FieldError>{message.text}</FieldError>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {message.text}
          </p>
        )
      ) : null}
      <div className="flex flex-col gap-2">
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
          <p className="text-sm text-muted-foreground">Nothing for you to do at this stage.</p>
        ) : null}
      </div>
    </>
  );

  const panel = (
    <>
      <PanelSection id="strength-report" title="Report">
        <dl className={PANEL_DL} aria-label="Strength report">
          <Labelled label="Version">
            Rev {shown.revNo}
            <span className="block text-xs text-muted-foreground">
              {shownFrozen
                ? `Version ${shown.versionNo} as submitted`
                : 'As it would be submitted now'}
            </span>
          </Labelled>
          <Labelled label="Workflow">
            {/* The status word itself is the header's tag (once on the page). */}
            <span className="block text-muted-foreground">
              {detail.latestVersion
                ? `Latest: version ${detail.latestVersion.versionNo}`
                : 'No version submitted yet'}
            </span>
          </Labelled>
          <Labelled label="Specified">
            <span className="font-mono">{specifiedText(shown.set)}</span>
            <span className="block text-xs text-muted-foreground">
              From the project spec on the field report
            </span>
          </Labelled>
          <Labelled label="Method">
            {shown.calculation.method ? shown.calculation.method.line : 'Not calculated'}
            <span className="block text-xs text-muted-foreground">{shown.calculation.note}</span>
          </Labelled>
        </dl>
      </PanelSection>
      {sharedStation ? (
        <PanelSection id="strength-performer" title="Who is doing this">
          <Select value={performer} onValueChange={setPerformer}>
            <SelectTrigger id={staffId} aria-label="Who is doing this" className="w-full">
              <SelectValue placeholder="Choose a person" />
            </SelectTrigger>
            <SelectContent>
              {staff.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {formatPerson(p.initials, p.displayName)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PanelSection>
      ) : null}
      <PanelSection id="strength-exceptions" title="Exceptions">
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
      </PanelSection>
      <PanelSection id="strength-who" title="Who reviews">
        <p className="text-sm text-muted-foreground">
          The lead and reviewers designated for strength reports (concrete_strength). Never the only
          person who tested or entered these results.
        </p>
      </PanelSection>
      {history ? (
        <PanelSection id="strength-versions" title="Versions">
          <ol className="flex flex-col gap-1 text-sm">
            {history.versions.map((v) => (
              <li key={v.id}>
                <span className="font-mono">v{v.versionNo}</span> · {v.state}
                {v.revisionOfVersionNo ? ` (revises v${v.revisionOfVersionNo})` : ''} ·{' '}
                {shortDateTime(v.submittedAt)}
              </li>
            ))}
          </ol>
        </PanelSection>
      ) : null}
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportHeader
        crumb={
          <>
            <span className="font-mono">{shown.projectNumber}</span> · {label} strength
          </>
        }
        steps={<ReportSteps review={steps.review} issue={steps.issue} />}
        title={`Strength report ${label}`}
        meta={
          <>
            <span className="font-mono">{shown.projectNumber}</span>
            <span>{shown.projectName}</span>
            {detail.reportNumber ? (
              <span className="font-mono text-foreground">{detail.reportNumber}</span>
            ) : null}
            {file ? (
              <Button variant="link" size="sm" className="h-auto p-0" asChild>
                <a href={`/api/concrete/report-files/${file.id}`}>
                  Download Rev {file.revisionNo} (PDF)
                </a>
              </Button>
            ) : null}
          </>
        }
        tags={
          <>
            <StrengthStateBadge state={detail.state} />
            {detail.latestVersion ? (
              <Badge variant="outline">Version {detail.latestVersion.versionNo}</Badge>
            ) : null}
            <Badge variant="draft">Provisional · G2 open</Badge>
            {detail.newResults && detail.state === 'issued' ? (
              <>
                <Badge variant="lab">New results to submit</Badge>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={live}
                  onClick={() => setLive((v) => !v)}
                >
                  {live ? 'Show the issued version' : 'Show the new results'}
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <ReportSplit
        panelLabel="Review panel"
        alert={
          <Alert>
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Provisional: the strength report is an open decision (G2)</AlertTitle>
            <AlertDescription>
              This is the placeholder design until the office’s report examples arrive. Its layout,
              numbering, units and anything calculated can change.
            </AlertDescription>
          </Alert>
        }
        paper={
          <ReportPaper
            icon={Eye}
            label="Strength report, provisional review preview. Not the issued file."
          >
            <StrengthReportBody
              snapshot={shown}
              onExclude={detail.canExclude && showLive ? setExcluding : undefined}
              excludable={detail.excludableSpecimenIds}
              locked={shownFrozen && detail.state === 'issued'}
            />
          </ReportPaper>
        }
        panel={panel}
        footer={footer}
      />

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
