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
import { useEffect, useId, useState } from 'react';
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
import { LineEditor } from './LineEditor';
import { emptyLine, numberOrNull, type LineDraft } from './line-draft';
import { problemText } from './problem-text';

// Amendments to an open program (D02) and changes to an accepted test (D09), MM-T26. Every
// change here is explicit: later receipts join a line only when ticked, and changing an accepted
// test says that it returns to Requested and needs a fresh review and acceptance. A new testing
// line (MM-T83) is added only after the person has seen and confirmed what it will cover.

const newKey = () => crypto.randomUUID();

function useActiveTests(): TestType[] {
  const [tests, setTests] = useState<TestType[]>([]);
  useEffect(() => {
    fetchCatalogue().then(
      (catalogue) => setTests(catalogue.tests.filter((test) => test.active)),
      () => setTests([]),
    );
  }, []);
  return tests;
}

/** Program-level: add a test to a line, include later receipts, amendment history. */
export function AmendProgram({
  program,
  work,
  onDone,
}: {
  program: LabProgram;
  work: ProgramWork;
  onDone: (message: string | null) => void;
}) {
  const id = useId();
  const life = work.lifecycle;
  const [open, setOpen] = useState(false);
  const tests = useActiveTests();
  const [lineId, setLineId] = useState(program.lines[0]?.id ?? '');
  const [testId, setTestId] = useState('');
  const [later, setLater] = useState<LaterReceipts | null>(null);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);

  const history =
    life.amendments.length > 0 ? (
      <details className="lifecycle-history">
        <summary>Amendments ({life.amendments.length})</summary>
        <ol>
          {life.amendments.map((amendment) => (
            <li key={amendment.id}>
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
              {amendment.reason ? <span className="pre-wrap">: {amendment.reason}</span> : null}
            </li>
          ))}
        </ol>
      </details>
    ) : null;

  if (!life.canAmend) return history;
  if (!open) {
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Amend program
        </button>
        {history}
      </>
    );
  }
  const line = program.lines.find((l) => l.id === lineId);
  const onLine = new Set(line?.requests.map((r) => r.testTypeId) ?? []);
  const addable = tests.filter((test) => !onLine.has(test.id));
  const laterPicks = Object.entries(picked).filter(([, ids]) => ids.length > 0);

  async function submit(body: {
    addTests?: { lineId: string; testTypeIds: string[] }[];
    includeLaterReceipts?: { lineId: string; unitIds: string[] }[];
  }) {
    setBusy(true);
    const result: WriteResult<unknown> = await amendProgram(program.id, {
      version: life.version,
      idempotencyKey: key,
      reason: reason.trim() || null,
      ...body,
    });
    setBusy(false);
    if (!result.ok && result.kind === 'network') {
      onDone(problemText(result));
      return;
    }
    setKey(newKey());
    if (result.ok) {
      setOpen(false);
      setTestId('');
      setPicked({});
      setLater(null);
      setReason('');
    }
    onDone(result.ok ? null : problemText(result));
  }

  return (
    <div className="action-panel" role="group" aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="action-title">
        Amend program
      </p>
      <label htmlFor={`${id}-reason`}>Reason (optional)</label>
      <textarea
        id={`${id}-reason`}
        value={reason}
        maxLength={LIFECYCLE_REASON_MAX_LENGTH}
        onChange={(event) => setReason(event.target.value)}
      />
      <fieldset>
        <legend>Add a test to a line</legend>
        <label htmlFor={`${id}-line`}>Line</label>
        <select id={`${id}-line`} value={lineId} onChange={(e) => setLineId(e.target.value)}>
          {program.lines.map((l: LabLine) => (
            <option key={l.id} value={l.id}>
              Line {l.lineNumber}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-test`}>Test</label>
        <select id={`${id}-test`} value={testId} onChange={(e) => setTestId(e.target.value)}>
          <option value="">Choose a test</option>
          {addable.map((test) => (
            <option key={test.id} value={test.id}>
              {test.code} · {test.name ?? test.description}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !testId || !lineId}
          onClick={() => void submit({ addTests: [{ lineId, testTypeIds: [testId] }] })}
        >
          Add test
        </button>
      </fieldset>
      <AddTestingLine
        program={program}
        version={life.version}
        reason={reason}
        onDone={(message) => {
          if (message === null) {
            setOpen(false);
            setReason('');
          }
          onDone(message);
        }}
      />
      <fieldset>
        <legend>Include later receipts</legend>
        <p className="field-hint">
          Units received after submission are never added on their own. Tick the exact units to
          include; Grabs and SPT units have no recorded G/S classification, so ticking one is your
          review that includes it.
        </p>
        {later === null ? (
          <button
            type="button"
            onClick={() =>
              fetchLaterReceipts(program.id).then(setLater, () =>
                onDone('Later receipts couldn’t be loaded. Try again.'),
              )
            }
          >
            Check later receipts
          </button>
        ) : later.lines.every((l) => l.units.length === 0) ? (
          <p>No units have been received for these lines since submission.</p>
        ) : (
          <>
            {later.lines
              .filter((l) => l.units.length > 0)
              .map((l) => (
                <div key={l.lineId} className="unit-choices">
                  <p className="action-title">Line {l.lineNumber}</p>
                  {l.units.map((unit) => (
                    <label key={unit.storageUnitId} className="unit-choice">
                      <input
                        type="checkbox"
                        checked={(picked[l.lineId] ?? []).includes(unit.storageUnitId)}
                        onChange={(event) =>
                          setPicked((current) => {
                            const ids = current[l.lineId] ?? [];
                            return {
                              ...current,
                              [l.lineId]: event.target.checked
                                ? [...ids, unit.storageUnitId]
                                : ids.filter((other) => other !== unit.storageUnitId),
                            };
                          })
                        }
                      />
                      <span className="mono">{unit.readableId}</span> {unit.contents ?? ''}{' '}
                      (received {unit.receivedDate}
                      {unit.unknownClassification ? ', G/S unknown' : ''})
                    </label>
                  ))}
                </div>
              ))}
            <button
              type="button"
              disabled={busy || laterPicks.length === 0}
              onClick={() =>
                void submit({
                  includeLaterReceipts: laterPicks.map(([lineId, unitIds]) => ({
                    lineId,
                    unitIds,
                  })),
                })
              }
            >
              Include ticked units
            </button>
          </>
        )}
      </fieldset>
      <div className="form-actions">
        <button type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      {history}
    </div>
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
 * Add a testing line to a submitted program (MM-T83): source, scope, explicit Grabs/SPT units
 * and tests, then a preview of what it will cover before anything is saved. The coverage is the
 * server's own answer, so disposed units and tubes destroyed in testing are never included.
 */
function AddTestingLine({
  program,
  version,
  reason,
  onDone,
}: {
  program: LabProgram;
  version: number;
  reason: string;
  onDone: (message: string | null) => void;
}) {
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [line, setLine] = useState<LineDraft>(emptyLine);
  const [catalogue, setCatalogue] = useState<TestCatalogue | null>(null);
  const [templates, setTemplates] = useState<TestTemplate[]>([]);
  const [sources, setSources] = useState<LabSource[]>([]);
  // What the line would freeze (ALL/Grabs/SPT, from the server); [] for a Specific line.
  const [preview, setPreview] = useState<CoverageUnit[] | null>(null);
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
      <div className="form-actions">
        <button type="button" onClick={() => setAdding(true)}>
          Add a testing line
        </button>
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
    setProblem(
      result.kind === 'conflict'
        ? 'This program changed since you opened it. Close the amendment and open it again.'
        : problemText(result),
    );
  }

  async function showPreview() {
    if (specific) {
      // A Specific line covers only the units linked to it: nothing to compare with the server.
      setPreview([]);
      return;
    }
    const result = await send([PREVIEW_PROBE_UNIT_ID]);
    if (!result.ok && result.kind === 'conflict' && result.coverageChanged) {
      setPreview(result.coverageChanged[0]?.coverage ?? []);
      return;
    }
    if (result.ok) {
      reset();
      onDone(null);
      return;
    }
    refused(result);
  }

  async function confirm() {
    if (preview === null) return;
    const result = await send(preview.filter((u) => u.included).map((u) => u.storageUnitId));
    if (result.ok) {
      reset();
      onDone(null);
      return;
    }
    if (result.kind === 'conflict' && result.coverageChanged) {
      setPreview(result.coverageChanged[0]?.coverage ?? []);
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
    <section className="add-line" aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="action-title">
        Add a testing line
      </p>
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
          onChange={(change) => {
            // Acknowledging a depth keeps the preview; any other change needs a fresh one.
            if (Object.keys(change).some((field) => field !== 'acknowledgedDepths')) {
              setPreview(null);
              setDiscrepancy(null);
            }
            setLine((current) => ({ ...current, ...change }));
          }}
        />
      ) : problem ? null : (
        <p aria-busy="true">Loading the test catalogue…</p>
      )}
      {preview ? (
        <div className="review-line" role="region" aria-label={`Preview of new line ${lineNumber}`}>
          <p className="action-title">
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
            <p className="text-warning">Covers no units.</p>
          )}
          {!specific && excluded.length > 0 ? (
            <p className="text-warning">
              {excluded.length} unit{excluded.length === 1 ? '' : 's'} with unknown G/S
              classification excluded ({excluded.map((unit) => unit.readableId).join(', ')}).
            </p>
          ) : null}
          {preview.length > 0 ? (
            <ul className="coverage-list">
              {preview.map((unit) => (
                <li key={unit.storageUnitId}>
                  <span className="mono">{unit.readableId}</span> {unit.contents ?? ''} —{' '}
                  {MATCHING_BASIS_LABEL[unit.matchingBasis]}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="field-hint">
            The new tests start as Requested. Coverage is frozen when you add the line; later
            receipts join it only by another amendment.
          </p>
        </div>
      ) : null}
      {problem ? (
        <p className="notice notice-warning" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="button" onClick={reset} disabled={busy}>
          Cancel new line
        </button>
        {preview ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void confirm()}>
            Add line {lineNumber}
          </button>
        ) : (
          <button type="button" disabled={busy || !ready} onClick={() => void showPreview()}>
            Preview line
          </button>
        )}
      </div>
    </section>
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
  const tests = useActiveTests();
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
      <details className="review-history">
        <summary>Changed after acceptance ({revisions.length})</summary>
        <ol>
          {revisions.map((revision) => (
            <li key={revision.id}>
              {revision.before.test}
              {revision.before.sample ? ` (${revision.before.sample})` : ''} → {revision.after.test}
              {revision.after.sample ? ` (${revision.after.sample})` : ''} by{' '}
              {formatPerson(revision.person.initials, revision.person.name)},{' '}
              {shortDateTime(revision.changedAt)}:{' '}
              <span className="pre-wrap">{revision.reason}</span>
            </li>
          ))}
        </ol>
      </details>
    ) : null;
  if (!progress?.lifecycle.canChange) return history;
  if (!open) {
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Change sample, depth or test
        </button>
        {history}
      </>
    );
  }
  const specific = line.scope === 'specific';
  const interval = identity.depthMode === 'interval';
  return (
    <form
      className="action-panel"
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
      <p id={`${id}-title`} className="action-title">
        Change {request.code}
      </p>
      <p className="field-hint">
        This test returns to Requested and needs a fresh review and acceptance. Other tests stay as
        they are; the earlier acceptance stays in the history.
      </p>
      <label htmlFor={`${id}-test`}>Test</label>
      <select id={`${id}-test`} value={testId} onChange={(e) => setTestId(e.target.value)}>
        <option value={request.testTypeId}>{request.code} (current)</option>
        {tests
          .filter((test) => test.id !== request.testTypeId)
          .map((test) => (
            <option key={test.id} value={test.id}>
              {test.code} · {test.name ?? test.description}
            </option>
          ))}
      </select>
      {specific ? (
        <>
          <label htmlFor={`${id}-label`}>Sample label</label>
          <input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} />
          <label htmlFor={`${id}-from`}>{interval ? 'Depth from' : 'Depth'}</label>
          <input
            id={`${id}-from`}
            inputMode="decimal"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          {interval ? (
            <>
              <label htmlFor={`${id}-to`}>Depth to</label>
              <input
                id={`${id}-to`}
                inputMode="decimal"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </>
          ) : null}
          <label htmlFor={`${id}-unit`}>Unit</label>
          <select
            id={`${id}-unit`}
            value={unit}
            onChange={(e) => setUnit(e.target.value as 'ft' | 'm')}
          >
            <option value="ft">ft</option>
            <option value="m">m</option>
          </select>
        </>
      ) : null}
      <label htmlFor={`${id}-reason`}>Reason (required)</label>
      <textarea
        id={`${id}-reason`}
        value={reason}
        maxLength={LIFECYCLE_REASON_MAX_LENGTH}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="form-actions">
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || !reason.trim()}>
          Change and reset to Requested
        </button>
      </div>
      {history}
    </form>
  );
}
