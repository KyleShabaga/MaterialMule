import {
  LIFECYCLE_REASON_MAX_LENGTH,
  LINE_SCOPE_LABEL,
  MATCHING_BASIS_LABEL,
  formatPerson,
  type AmendmentLineInput,
  type CoverageUnit,
  type DepthDiscrepancy,
  type LabLine,
  type LabProgram,
  type LabSource,
  type LaterReceipts,
  type ProgramWork,
  type TestCatalogue,
  type TestRequest,
  type TestTemplate,
  type TestType,
} from '@materialmule/shared';
import { ChevronDown, FilePlus2, History, Info, Plus, Send } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Item, ItemContent, ItemGroup } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { shortDateTime } from '../dashboard/format';
import {
  amendProgram,
  changeTestRequest,
  fetchCatalogue,
  fetchLaterReceipts,
  fetchSources,
  fetchTemplates,
  type WriteResult,
} from './api';
import { testLabel } from './editor/labels';
import { TEST_STATE_WORDS, lineTitle } from './format';
import { LineEditor } from './LineEditor';
import { emptyLine, numberOrNull, type LineDraft } from './line-draft';
import { problemText } from './problem-text';
import { AddTestButton, TestChip } from './TestPicker';

// Amendments to an open program (D02, MM-T26) and changes to an accepted test (D09), in the
// editor's line and test UI (STRATA-86). Submitted tests stay as they are; what an amendment
// adds is marked "Added by amendment" and keeps its history. Every change is explicit: later
// receipts join a line only when ticked, and a new testing line (MM-T83) is added only after the
// person has seen and confirmed what it will cover. Changing an accepted test says that it
// returns to Requested and needs a fresh review and acceptance.

const newKey = () => crypto.randomUUID();
const ADDED = 'Added by amendment';
const LABEL = 'text-[13px] font-medium text-muted-foreground';
const CONTROL_SM = 'h-9 pointer-coarse:h-11';

function useActiveTests(): { tests: TestType[]; catalogue: TestCatalogue | null } {
  const [catalogue, setCatalogue] = useState<TestCatalogue | null>(null);
  useEffect(() => {
    let current = true;
    fetchCatalogue().then(
      (loaded) => current && setCatalogue(loaded),
      () => current && setCatalogue({ groups: [], tests: [] }),
    );
    return () => {
      current = false;
    };
  }, []);
  return { tests: catalogue?.tests.filter((test) => test.active) ?? [], catalogue };
}

function AmendmentHistory({ amendments }: { amendments: ProgramWork['lifecycle']['amendments'] }) {
  if (amendments.length === 0) return null;
  return (
    <Collapsible className="grid gap-2">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="w-fit pointer-coarse:h-11">
          <History aria-hidden="true" />
          Amendments ({amendments.length})
          <ChevronDown aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ItemGroup className="gap-1">
          {amendments.map((amendment) => (
            <Item key={amendment.id} size="sm" variant="muted">
              <ItemContent className="text-[13px]">
                <p>
                  Amendment {amendment.amendmentNumber} by{' '}
                  {formatPerson(amendment.person.initials, amendment.person.name)},{' '}
                  {shortDateTime(amendment.createdAt)}
                  {amendment.addedRequestIds.length > 0
                    ? ` · ${amendment.addedRequestIds.length} test(s) added`
                    : ''}
                  {amendment.addedLineIds.length > 0
                    ? ` · ${amendment.addedLineIds.length} line(s) added`
                    : ''}
                  {amendment.addedUnitReadableIds.length > 0
                    ? ` · later receipts included: ${amendment.addedUnitReadableIds.join(', ')}`
                    : ''}
                </p>
                {amendment.reason ? (
                  <p className="whitespace-pre-wrap text-muted-foreground">{amendment.reason}</p>
                ) : null}
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A submitted test on a line: its name and state, "Added by amendment" when one added it. */
function RequestChip({ request }: { request: TestRequest }) {
  const state = TEST_STATE_WORDS[request.status];
  return (
    <TestChip
      label={`${request.code} · ${request.name ?? request.description} · ${state.label}`}
      description={request.description}
      marker={request.amendmentId ? ADDED : undefined}
    />
  );
}

/**
 * Program-level amending: add tests to submitted lines, include later receipts, add a testing
 * line, and the amendment history. Opened with "Amend program"; nothing is sent until Submit
 * amendment (tests and receipts) or Add line (a new line, after its preview).
 */
export function AmendProgram({
  program,
  work,
  onDone,
  onRefresh,
}: {
  program: LabProgram;
  work: ProgramWork;
  onDone: (message: string | null) => void;
  /** Reloads the program and its lifecycle (version) without closing anything open here. */
  onRefresh?: () => void;
}) {
  const id = useId();
  const life = work.lifecycle;
  const [open, setOpen] = useState(false);
  const { catalogue } = useActiveTests();
  const [added, setAdded] = useState<Record<string, string[]>>({});
  const [later, setLater] = useState<LaterReceipts | null>(null);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const history = <AmendmentHistory amendments={life.amendments} />;
  if (!life.canAmend) return history;
  if (!open) {
    return (
      <div className="grid gap-2">
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => setOpen(true)}
          >
            <FilePlus2 aria-hidden="true" />
            Amend program
          </Button>
        </div>
        {history}
      </div>
    );
  }
  const addTests = Object.entries(added)
    .filter(([, ids]) => ids.length > 0)
    .map(([lineId, testTypeIds]) => ({ lineId, testTypeIds }));
  const laterPicks = Object.entries(picked).filter(([, ids]) => ids.length > 0);
  const testsAdded = addTests.reduce((sum, entry) => sum + entry.testTypeIds.length, 0);
  const unitsAdded = laterPicks.reduce((sum, [, ids]) => sum + ids.length, 0);
  const byId = new Map(catalogue?.tests.map((test) => [test.id, test]) ?? []);

  function close() {
    setOpen(false);
    setAdded({});
    setPicked({});
    setLater(null);
    setReason('');
    setProblem(null);
  }

  async function submit() {
    setBusy(true);
    setProblem(null);
    const result: WriteResult<unknown> = await amendProgram(program.id, {
      version: life.version,
      idempotencyKey: key,
      reason: reason.trim() || null,
      addTests,
      includeLaterReceipts: laterPicks.map(([lineId, unitIds]) => ({ lineId, unitIds })),
    });
    setBusy(false);
    if (!result.ok && result.kind === 'network') {
      setProblem(problemText(result));
      return;
    }
    setKey(newKey());
    if (result.ok) {
      close();
      onDone(null);
      return;
    }
    if (result.kind === 'conflict') onRefresh?.();
    onDone(problemText(result));
  }

  return (
    <section
      className="grid gap-4 rounded-lg border bg-card p-4"
      role="group"
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        Amend program
      </h2>
      <Alert role="status">
        <Info aria-hidden="true" />
        <AlertTitle>You are amending a submitted program.</AlertTitle>
        <AlertDescription>
          Submitted tests stay as they are. Added tests and lines are marked Added by amendment,
          keep their history and go to the Lab Manager for review.
        </AlertDescription>
      </Alert>

      <ItemGroup className="gap-3">
        {program.lines.map((line: LabLine) => {
          const onLine = line.requests.map((request) => request.testTypeId);
          const mine = added[line.id] ?? [];
          const covered = line.coverage.filter((unit) => unit.included);
          return (
            <Item key={line.id} asChild variant="outline" className="flex-col items-stretch gap-2">
              <section aria-label={`Amend line ${line.lineNumber}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-9 font-mono text-sm font-semibold" aria-hidden="true">
                    L{line.lineNumber}
                  </span>
                  <span className="text-sm">{lineTitle(line)}</span>
                  {line.amendmentId ? (
                    <Badge variant="outline">
                      <FilePlus2 aria-hidden="true" />
                      {ADDED}
                    </Badge>
                  ) : null}
                </div>
                <div className="grid gap-2 pl-11 max-sm:pl-0">
                  <span className={LABEL}>Tests</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ul className="flex flex-wrap gap-1.5" aria-label="Submitted tests">
                      {line.requests.map((request) => (
                        <RequestChip key={request.id} request={request} />
                      ))}
                    </ul>
                    {mine.length > 0 ? (
                      <ul className="flex flex-wrap gap-1.5" aria-label="Tests to add">
                        {mine.map((testId) => {
                          const test = byId.get(testId);
                          return (
                            <TestChip
                              key={testId}
                              marker={ADDED}
                              label={test ? testLabel(test) : 'Test'}
                              removeLabel={`Remove ${test?.code ?? 'test'}`}
                              onRemove={() =>
                                setAdded((current) => ({
                                  ...current,
                                  [line.id]: (current[line.id] ?? []).filter((t) => t !== testId),
                                }))
                              }
                            />
                          );
                        })}
                      </ul>
                    ) : null}
                    {catalogue ? (
                      <AddTestButton
                        catalogue={catalogue}
                        selected={[...onLine, ...mine]}
                        accessibleLabel={`Add test to line ${line.lineNumber}`}
                        onAdd={(testId) =>
                          setAdded((current) => ({
                            ...current,
                            [line.id]: [...(current[line.id] ?? []), testId],
                          }))
                        }
                      />
                    ) : null}
                  </div>
                  {covered.length > 0 ? (
                    <p className="text-[13px] text-muted-foreground">
                      Storage units covered:{' '}
                      <span className="font-mono">
                        {covered.map((unit) => unit.readableId).join(', ')}
                      </span>
                    </p>
                  ) : null}
                </div>
              </section>
            </Item>
          );
        })}
      </ItemGroup>

      <AddTestingLine
        program={program}
        version={life.version}
        reason={reason}
        onRefresh={onRefresh}
        onDone={(message) => {
          if (message === null) close();
          onDone(message);
        }}
      />

      <fieldset className="grid gap-2" data-slot="fieldset">
        <legend className="mb-1 text-sm font-semibold">Include later receipts</legend>
        <p className="text-[13px] text-muted-foreground">
          Units received after submission are never added on their own. Tick the exact units to
          include; Grabs and SPT units have no recorded G/S classification, so ticking one is your
          review that includes it.
        </p>
        {later === null ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              onClick={() =>
                fetchLaterReceipts(program.id).then(setLater, () =>
                  setProblem('Later receipts couldn’t be loaded. Try again.'),
                )
              }
            >
              Check later receipts
            </Button>
          </div>
        ) : later.lines.every((l) => l.units.length === 0) ? (
          <p className="text-sm">No units have been received for these lines since submission.</p>
        ) : (
          later.lines
            .filter((l) => l.units.length > 0)
            .map((l) => (
              <div key={l.lineId} className="grid gap-1.5">
                <p className={LABEL}>Line {l.lineNumber}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {l.units.map((unit) => {
                    const boxId = `${id}-later-${l.lineId}-${unit.storageUnitId}`;
                    return (
                      <div key={unit.storageUnitId} className="flex items-center gap-2">
                        <Checkbox
                          id={boxId}
                          checked={(picked[l.lineId] ?? []).includes(unit.storageUnitId)}
                          onCheckedChange={(checked) =>
                            setPicked((current) => {
                              const ids = current[l.lineId] ?? [];
                              return {
                                ...current,
                                [l.lineId]:
                                  checked === true
                                    ? [...ids, unit.storageUnitId]
                                    : ids.filter((other) => other !== unit.storageUnitId),
                              };
                            })
                          }
                        />
                        <Label htmlFor={boxId} className="font-normal">
                          <span className="font-mono">{unit.readableId}</span>
                          <span className="text-muted-foreground">
                            {' '}
                            {unit.contents ?? ''} (received {unit.receivedDate}
                            {unit.unknownClassification ? ', G/S unknown' : ''})
                          </span>
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
        )}
      </fieldset>

      <div className="grid max-w-2xl gap-1.5">
        <Label htmlFor={`${id}-reason`} className={LABEL}>
          Reason (optional)
        </Label>
        <Textarea
          id={`${id}-reason`}
          value={reason}
          maxLength={LIFECYCLE_REASON_MAX_LENGTH}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>

      {problem ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 border-t pt-3">
        <span className="text-sm font-medium" aria-live="polite">
          {testsAdded} test{testsAdded === 1 ? '' : 's'} added
          {unitsAdded > 0 ? ` · ${unitsAdded} later receipt${unitsAdded === 1 ? '' : 's'}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            disabled={busy}
            onClick={close}
          >
            Discard amendment
          </Button>
          <Button
            type="button"
            size="sm"
            className="pointer-coarse:h-11"
            disabled={busy || testsAdded + unitsAdded === 0}
            onClick={() => void submit()}
          >
            <Send aria-hidden="true" />
            Submit amendment
          </Button>
        </div>
      </div>
      {history}
    </section>
  );
}

// Never a real unit: sent as the reviewed coverage of the first request so the server always
// answers 409 `coverage_changed` with the coverage it would freeze now. That answer is the
// preview; nothing changes until the person confirms it and the line goes with that coverage.
const PREVIEW_PROBE_UNIT_ID = '00000000-0000-4000-8000-000000000000';

function amendmentLine(line: LineDraft, reviewedCoverageUnitIds: string[]): AmendmentLineInput {
  const specific = line.scope === 'specific';
  return {
    source: line.source!,
    scope: line.scope,
    identity: specific
      ? {
          sampleLabel: line.sampleLabel.trim(),
          depthMode: line.depthMode,
          depthFrom: Number(line.depthFrom),
          depthTo: line.depthMode === 'interval' ? numberOrNull(line.depthTo) : null,
          depthUnit: line.depthUnit,
        }
      : null,
    testTypeIds: line.testTypeIds,
    unitIds: line.scope === 'all' ? [] : line.unitIds,
    reviewedCoverageUnitIds: specific ? [] : reviewedCoverageUnitIds,
    acknowledgedDepths: specific ? line.acknowledgedDepths : [],
  };
}

/**
 * Add a testing line to a submitted program (MM-T83): the editor's line row (source, scope,
 * explicit Grabs/SPT units and tests), then a preview of what it will cover before anything is
 * saved. The coverage is the server's own answer, so disposed units and tubes destroyed in
 * testing are never included.
 */
function AddTestingLine({
  program,
  version,
  reason,
  onDone,
  onRefresh,
}: {
  program: LabProgram;
  version: number;
  reason: string;
  onDone: (message: string | null) => void;
  onRefresh?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [line, setLine] = useState<LineDraft>(emptyLine);
  const [catalogue, setCatalogue] = useState<TestCatalogue | null>(null);
  const [templates, setTemplates] = useState<TestTemplate[]>([]);
  const [sources, setSources] = useState<LabSource[]>([]);
  // Review fix (#106): each change that can alter coverage starts a new draft revision. A
  // preview belongs to the revision and program version it was asked for: a late answer for an
  // earlier draft is ignored, and a preview is shown (and can be confirmed) only while both match.
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);
  // What the line would freeze (ALL/Grabs/SPT, from the server); [] for a Specific line.
  const [stored, setStored] = useState<{
    revision: number;
    version: number;
    units: CoverageUnit[];
  } | null>(null);
  const preview =
    stored && stored.revision === revision && stored.version === version ? stored.units : null;
  const setPreview = (units: CoverageUnit[] | null, forRevision = revisionRef.current) =>
    setStored(units === null ? null : { revision: forRevision, version, units });
  const [discrepancy, setDiscrepancy] = useState<DepthDiscrepancy | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const projectId = program.project.id;

  useEffect(() => {
    if (!adding) return;
    Promise.all([fetchCatalogue(), fetchTemplates(), fetchSources(projectId)]).then(
      ([c, t, s]) => {
        setCatalogue(c);
        setTemplates(t);
        setSources(s);
      },
      () => setProblem('The test catalogue or sampling sources couldn’t be loaded. Try again.'),
    );
  }, [adding, projectId]);

  if (!adding) {
    return (
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={() => setAdding(true)}
        >
          <Plus aria-hidden="true" />
          Add a testing line
        </Button>
      </div>
    );
  }

  const specific = line.scope === 'specific';
  const lineNumber = program.lines.length + 1;
  const ready =
    line.source !== null &&
    line.testTypeIds.length > 0 &&
    (!specific || (line.sampleLabel.trim() !== '' && numberOrNull(line.depthFrom) !== null));

  function reset() {
    setAdding(false);
    setLine(emptyLine());
    setPreview(null);
    setDiscrepancy(null);
    setProblem(null);
  }

  async function send(reviewed: string[]): Promise<WriteResult<unknown>> {
    setBusy(true);
    setProblem(null);
    const result = await amendProgram(program.id, {
      version,
      idempotencyKey: key,
      reason: reason.trim() || null,
      addLines: [amendmentLine(line, reviewed)],
    });
    setBusy(false);
    // Same key on a network retry: an amendment that did commit is returned, never duplicated.
    if (result.ok || result.kind !== 'network') setKey(newKey());
    return result;
  }

  function refused(result: Exclude<WriteResult<unknown>, { ok: true }>) {
    if (result.kind === 'invalid' && result.discrepancy) {
      setDiscrepancy(result.discrepancy);
    }
    if (result.kind === 'forbidden') {
      onDone(problemText(result));
      return;
    }
    if (result.kind === 'conflict') {
      // Review fix (#106): the program moved on (another amendment, a close). Load its current
      // state through the parent so the next attempt sends the new version; the draft stays and
      // any preview made against the old version is dropped.
      setPreview(null);
      onRefresh?.();
      setProblem(
        'This program changed since you opened it. Its latest version has been loaded: check the line and preview it again.',
      );
      return;
    }
    setProblem(problemText(result));
  }

  async function showPreview() {
    if (specific) {
      // A Specific line covers only the units linked to it: nothing to compare with the server.
      setPreview([]);
      return;
    }
    const draft = revisionRef.current;
    const result = await send([PREVIEW_PROBE_UNIT_ID]);
    if (result.ok) {
      reset();
      onDone(null);
      return;
    }
    // The line changed while the preview was on its way: this answer is for an earlier draft.
    if (revisionRef.current !== draft) return;
    if (result.kind === 'conflict' && result.coverageChanged) {
      setPreview(result.coverageChanged[0]?.coverage ?? [], draft);
      return;
    }
    refused(result);
  }

  async function confirm() {
    if (preview === null) return;
    const draft = revisionRef.current;
    const result = await send(preview.filter((u) => u.included).map((u) => u.storageUnitId));
    if (result.ok) {
      reset();
      onDone(null);
      return;
    }
    if (revisionRef.current !== draft) return;
    if (result.kind === 'conflict' && result.coverageChanged) {
      setPreview(result.coverageChanged[0]?.coverage ?? [], draft);
      setProblem(
        'The material for this line changed since the preview (for example a new receipt or a disposal). Check the updated coverage and add the line again.',
      );
      return;
    }
    if (result.kind === 'invalid' && result.discrepancy) setPreview(null);
    refused(result);
  }

  const included = preview?.filter((unit) => unit.included) ?? [];
  const excluded = preview?.filter((unit) => !unit.included) ?? [];
  const tests = line.testTypeIds.length;

  return (
    <div className="grid gap-3">
      {catalogue ? (
        <LineEditor
          index={lineNumber - 1}
          line={line}
          projectId={projectId}
          sources={sources}
          catalogue={catalogue}
          templates={templates}
          review={discrepancy ? { discrepancy } : null}
          title={`New line ${lineNumber}`}
          marker={
            <Badge variant="outline" className="mt-2 shrink-0">
              <FilePlus2 aria-hidden="true" />
              {ADDED}
            </Badge>
          }
          onChange={(change) => {
            // Acknowledging a depth keeps the preview; any other change needs a fresh one.
            if (Object.keys(change).some((field) => field !== 'acknowledgedDepths')) {
              revisionRef.current += 1;
              setRevision(revisionRef.current);
              setStored(null);
              setDiscrepancy(null);
            }
            setLine((current) => ({ ...current, ...change }));
          }}
        />
      ) : problem ? null : (
        <p aria-busy="true" className="text-sm text-muted-foreground">
          Loading the test catalogue…
        </p>
      )}
      {preview ? (
        <div
          className="grid gap-2 rounded-lg border border-dashed p-3 text-sm"
          role="region"
          aria-label={`Preview of new line ${lineNumber}`}
        >
          <p className="font-semibold">
            Preview: line {lineNumber} · {LINE_SCOPE_LABEL[line.scope]} · {tests} test
            {tests === 1 ? '' : 's'}
          </p>
          {specific ? (
            <p>
              Sample {line.sampleLabel.trim()} at {line.depthFrom}
              {line.depthMode === 'interval' ? `–${line.depthTo}` : ''} {line.depthUnit}
              {line.unitIds.length > 0
                ? `, linked to ${line.unitIds.length} unit${line.unitIds.length === 1 ? '' : 's'}`
                : ', no physical unit linked'}
              .
            </p>
          ) : included.length > 0 ? (
            <p>Covers {included.map((unit) => unit.readableId).join(', ')} received so far.</p>
          ) : (
            <p className="text-stage-due-fg">Covers no units.</p>
          )}
          {!specific && excluded.length > 0 ? (
            <p className="text-stage-due-fg">
              {excluded.length} unit{excluded.length === 1 ? '' : 's'} with unknown G/S
              classification excluded ({excluded.map((unit) => unit.readableId).join(', ')}).
            </p>
          ) : null}
          {preview.length > 0 ? (
            <ul className="grid gap-0.5 text-[13px]">
              {preview.map((unit) => (
                <li key={unit.storageUnitId}>
                  <span className="font-mono">{unit.readableId}</span> {unit.contents ?? ''} —{' '}
                  {MATCHING_BASIS_LABEL[unit.matchingBasis]}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-[13px] text-muted-foreground">
            The new tests start as Requested. Coverage is frozen when you add the line; later
            receipts join it only by another amendment.
          </p>
        </div>
      ) : null}
      {problem ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={reset}
          disabled={busy}
        >
          Cancel new line
        </Button>
        {preview ? (
          <Button
            type="button"
            size="sm"
            className="pointer-coarse:h-11"
            disabled={busy}
            onClick={() => void confirm()}
          >
            Add line {lineNumber}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            disabled={busy || !ready}
            onClick={() => void showPreview()}
          >
            Preview line
          </Button>
        )}
      </div>
    </div>
  );
}

/** Change the sample, depth or test of an Accepted test; only it returns to Requested. */
export function ChangeAcceptedTest({
  request,
  line,
  work,
  onDone,
}: {
  request: TestRequest;
  line: LabLine;
  work: ProgramWork;
  onDone: (message: string | null) => void;
}) {
  const id = useId();
  const progress = work.requests.find((r) => r.testRequestId === request.id);
  const [open, setOpen] = useState(false);
  const { tests } = useActiveTests();
  const identity = request.identity ?? {
    sampleLabel: line.sampleLabel ?? '',
    depthMode: line.depthMode ?? 'point',
    depthFrom: line.depthFrom ?? 0,
    depthTo: line.depthTo,
    depthUnit: line.depthUnit ?? 'ft',
  };
  const [testId, setTestId] = useState(request.testTypeId);
  const [label, setLabel] = useState(identity.sampleLabel);
  const [from, setFrom] = useState(String(identity.depthFrom));
  const [to, setTo] = useState(identity.depthTo === null ? '' : String(identity.depthTo));
  const [unit, setUnit] = useState<'ft' | 'm'>(identity.depthUnit);
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const revisions = work.lifecycle.identityRevisions.filter((r) => r.testRequestId === request.id);
  const history =
    revisions.length > 0 ? (
      <Collapsible className="grid gap-1">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="w-fit pointer-coarse:h-11">
            Changed after acceptance ({revisions.length})
            <ChevronDown aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ItemGroup className="gap-1">
            {revisions.map((revision) => (
              <Item key={revision.id} size="sm" variant="muted">
                <ItemContent className="text-[13px]">
                  <p>
                    {revision.before.test}
                    {revision.before.sample ? ` (${revision.before.sample})` : ''} →{' '}
                    {revision.after.test}
                    {revision.after.sample ? ` (${revision.after.sample})` : ''} by{' '}
                    {formatPerson(revision.person.initials, revision.person.name)},{' '}
                    {shortDateTime(revision.changedAt)}:
                  </p>
                  <p className="whitespace-pre-wrap text-muted-foreground">{revision.reason}</p>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </CollapsibleContent>
      </Collapsible>
    ) : null;
  if (!progress?.lifecycle.canChange) return history;
  if (!open) {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={() => setOpen(true)}
        >
          Change sample, depth or test
        </Button>
        {history}
      </>
    );
  }
  const specific = line.scope === 'specific';
  const interval = identity.depthMode === 'interval';
  return (
    <form
      className="grid gap-3 rounded-lg border bg-card p-3"
      aria-labelledby={`${id}-title`}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const result = await changeTestRequest(request.id, {
          reason: reason.trim(),
          version: progress.version,
          idempotencyKey: key,
          ...(testId !== request.testTypeId ? { testTypeId: testId } : {}),
          ...(specific
            ? {
                identity: {
                  sampleLabel: label.trim(),
                  depthMode: identity.depthMode,
                  depthFrom: Number(from),
                  depthTo: interval ? Number(to) : null,
                  depthUnit: unit,
                },
              }
            : {}),
        });
        setBusy(false);
        if (!result.ok && result.kind === 'network') {
          onDone(problemText(result));
          return;
        }
        setKey(newKey());
        if (result.ok) setOpen(false);
        onDone(result.ok ? null : problemText(result));
      }}
    >
      <p id={`${id}-title`} className="text-sm font-semibold">
        Change {request.code}
      </p>
      <p className="text-[13px] text-muted-foreground">
        This test returns to Requested and needs a fresh review and acceptance. Other tests stay as
        they are; the earlier acceptance stays in the history.
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-test`} className={LABEL}>
          Test
        </Label>
        <Select value={testId} onValueChange={setTestId}>
          <SelectTrigger id={`${id}-test`} className={`w-full max-w-md ${CONTROL_SM}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={request.testTypeId}>{request.code} (current)</SelectItem>
            {tests
              .filter((test) => test.id !== request.testTypeId)
              .map((test) => (
                <SelectItem key={test.id} value={test.id}>
                  {testLabel(test)}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
      {specific ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-label`} className={LABEL}>
              Sample label
            </Label>
            <Input
              id={`${id}-label`}
              className={`w-28 ${CONTROL_SM}`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-from`} className={LABEL}>
              {interval ? 'Depth from' : 'Depth'}
            </Label>
            <Input
              id={`${id}-from`}
              inputMode="decimal"
              className={`w-20 font-mono ${CONTROL_SM}`}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          {interval ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-to`} className={LABEL}>
                Depth to
              </Label>
              <Input
                id={`${id}-to`}
                inputMode="decimal"
                className={`w-20 font-mono ${CONTROL_SM}`}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-unit`} className={LABEL}>
              Unit
            </Label>
            <Select value={unit} onValueChange={(value) => setUnit(value as 'ft' | 'm')}>
              <SelectTrigger id={`${id}-unit`} className={`w-20 ${CONTROL_SM}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="ft">ft</SelectItem>
                <SelectItem value="m">m</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-reason`} className={LABEL}>
          Reason (required)
        </Label>
        <Textarea
          id={`${id}-reason`}
          value={reason}
          maxLength={LIFECYCLE_REASON_MAX_LENGTH}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="pointer-coarse:h-11"
          disabled={busy || !reason.trim()}
        >
          Change and reset to Requested
        </Button>
      </div>
      {history}
    </form>
  );
}
