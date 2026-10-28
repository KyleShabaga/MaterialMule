import {
  LIFECYCLE_REASON_MAX_LENGTH,
  formatPerson,
  type LabLine,
  type LabProgram,
  type LaterReceipts,
  type ProgramWork,
  type TestRequest,
  type TestType,
} from '@materialmule/shared';
import { useEffect, useId, useState } from 'react';
import { shortDateTime } from '../dashboard/format';
import {
  amendProgram,
  changeTestRequest,
  fetchCatalogue,
  fetchLaterReceipts,
  type WriteResult,
} from './api';
import { problemText } from './problem-text';

// Amendments to an open program (D02) and changes to an accepted test (D09), MM-T26. Every
// change here is explicit: later receipts join a line only when ticked, and changing an accepted
// test says that it returns to Requested and needs a fresh review and acceptance. New testing
// lines are added through the API (`addLines`); this screen offers tests and later receipts.

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
