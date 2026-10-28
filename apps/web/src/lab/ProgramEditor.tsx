import {
  LINE_SCOPE_LABEL,
  LINE_SCOPES,
  MATCHING_BASIS_LABEL,
  depthKey,
  formatPerson,
  formatReceiver,
  lineSubmitProblems,
  type DraftLineInputValue,
  type LabProgram,
  type LabProgramReview,
  type LabSource,
  type LabSourceRef,
  type LabSourceUnit,
  type LineScope,
  type ProjectSummary,
  type ReceiverOption,
  type TestCatalogue,
  type TestTemplate,
} from '@materialmule/shared';
import { useEffect, useId, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { searchProjects } from '../api/projects';
import { ReceiverSelect } from '../components/ReceiverSelect';
import { BandedCard, ConfirmDialog, ErrorState, StatusBadge } from '../components/ui';
import { useMe } from '../session/context';
import {
  createProgram,
  discardProgram,
  fetchCatalogue,
  fetchReview,
  fetchSources,
  fetchSourceUnits,
  fetchTemplates,
  saveProgram,
  submitProgram,
  type WriteResult,
} from './api';
import { TestPicker } from './TestPicker';

// Program entry (MM-T23): project → testing lines (source, ALL / Grabs / SPT / Specific, tests)
// → review → submit. A shared LAB station names who the program is requested by first; that
// choice lives only in this screen on this station and is sent with every save and submission.
// Conflicts never throw away what the person typed: they choose when to load the newer version.

interface LineDraft {
  key: string;
  id?: string;
  source: LabSourceRef | null;
  scope: LineScope;
  sampleLabel: string;
  depthMode: 'point' | 'interval';
  depthFrom: string;
  depthTo: string;
  depthUnit: 'ft' | 'm';
  testTypeIds: string[];
  unitIds: string[];
  acknowledgedDepths: string[];
}

const newKey = () => crypto.randomUUID();

function emptyLine(): LineDraft {
  return {
    key: newKey(),
    source: null,
    scope: 'all',
    sampleLabel: '',
    depthMode: 'point',
    depthFrom: '',
    depthTo: '',
    depthUnit: 'ft',
    testTypeIds: [],
    unitIds: [],
    acknowledgedDepths: [],
  };
}

function fromProgram(program: LabProgram): LineDraft[] {
  return program.lines.map((line) => ({
    key: line.id,
    id: line.id,
    source: line.source ? { kind: line.source.kind, id: line.source.id } : null,
    scope: line.scope,
    sampleLabel: line.sampleLabel ?? '',
    depthMode: line.depthMode ?? 'point',
    depthFrom: line.depthFrom === null ? '' : String(line.depthFrom),
    depthTo: line.depthTo === null ? '' : String(line.depthTo),
    depthUnit: line.depthUnit ?? 'ft',
    testTypeIds: line.tests.map((test) => test.testTypeId),
    unitIds: line.unitIds,
    acknowledgedDepths: line.acknowledgedDepths,
  }));
}

const numberOrNull = (text: string) => (text.trim() === '' ? null : Number(text));

function toInput(line: LineDraft): DraftLineInputValue {
  const specific = line.scope === 'specific';
  return {
    id: line.id,
    source: line.source,
    scope: line.scope,
    sampleLabel: specific ? line.sampleLabel : null,
    depthMode: specific ? line.depthMode : null,
    depthFrom: specific ? numberOrNull(line.depthFrom) : null,
    depthTo: specific && line.depthMode === 'interval' ? numberOrNull(line.depthTo) : null,
    depthUnit: specific ? line.depthUnit : null,
    testTypeIds: line.testTypeIds,
    unitIds: line.scope === 'all' ? [] : line.unitIds,
    acknowledgedDepths: specific ? line.acknowledgedDepths : [],
  };
}

function personOption(program: LabProgram): ReceiverOption {
  return {
    id: program.requestedBy.userId,
    initials: program.requestedBy.initials ?? '',
    displayName: program.requestedBy.name,
    position: null,
  };
}

function failureMessage(result: Exclude<WriteResult<unknown>, { ok: true }>): string {
  switch (result.kind) {
    case 'conflict':
      if (result.code === 'version_conflict') {
        return 'Another station or tab saved this draft after you opened it. Your changes are still here: load the newer version to continue (your unsaved changes are then replaced), or copy what you need first.';
      }
      if (result.code === 'coverage_changed') {
        return 'The material for a line changed since the review (for example a new receipt). Check the updated coverage below and submit again.';
      }
      if (result.code === 'not_draft') return 'This program has already been submitted.';
      return 'This program changed. Reload it to continue.';
    case 'invalid':
      return result.errors.length > 0
        ? result.errors.map((error) => `${error.field}: ${error.message}`).join(' ')
        : 'Some details need attention.';
    case 'forbidden':
      return 'You don’t have permission to do this.';
    case 'unauthenticated':
      return 'Your session ended. Sign in again; this page keeps what you typed until you leave it.';
    case 'network':
      return 'Couldn’t reach Material Mule. Check the connection and try again.';
    default:
      return 'Something went wrong. Try again.';
  }
}

export function ProgramEditor({
  draft,
  onReload,
}: {
  draft: LabProgram | null;
  onReload?: () => void;
}) {
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const shared = me.accountType === 'shared_lab';
  const [programId, setProgramId] = useState(draft?.id ?? null);
  const [version, setVersion] = useState(draft?.version ?? 0);
  const [createKey] = useState(newKey);
  const [project, setProject] = useState<{ id: string; label: string } | null>(
    draft
      ? { id: draft.project.id, label: `${draft.project.projectNumber} · ${draft.project.name}` }
      : null,
  );
  const [requestedBy, setRequestedBy] = useState<ReceiverOption | null>(
    draft && shared ? personOption(draft) : null,
  );
  const [notes, setNotes] = useState(draft?.notes ?? '');
  const [lines, setLines] = useState<LineDraft[]>(draft ? fromProgram(draft) : [emptyLine()]);
  const [catalogue, setCatalogue] = useState<TestCatalogue | null>(null);
  const [templates, setTemplates] = useState<TestTemplate[]>([]);
  const [sources, setSources] = useState<LabSource[]>([]);
  const [review, setReview] = useState<LabProgramReview | null>(null);
  // Edited since the review: the review stays visible, but Submit waits for a fresh one.
  const [reviewStale, setReviewStale] = useState(false);
  const [message, setMessage] = useState<{ tone: 'warning' | 'success'; text: string } | null>(
    null,
  );
  const [conflict, setConflict] = useState<LabProgram | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [submitKey, setSubmitKey] = useState(newKey);

  useEffect(() => {
    Promise.all([fetchCatalogue(), fetchTemplates()]).then(
      ([c, t]) => {
        setCatalogue(c);
        setTemplates(t);
      },
      () => setLoadError(true),
    );
  }, []);
  useEffect(() => {
    if (!project) return;
    fetchSources(project.id).then(setSources, () => setLoadError(true));
  }, [project]);

  const openReviewOnArrival = Boolean(
    (location.state as { openReview?: boolean } | null)?.openReview,
  );
  useEffect(() => {
    if (draft && openReviewOnArrival) {
      void fetchReview(draft.id).then(
        (loaded) => {
          setReview(loaded);
          setReviewStale(false);
        },
        () => setMessage({ tone: 'warning', text: 'The review couldn’t be loaded. Try again.' }),
      );
    }
  }, [draft, openReviewOnArrival]);

  const personMissing = shared && requestedBy === null;

  function updateLine(key: string, change: Partial<LineDraft>) {
    setReviewStale(true);
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...change } : line)),
    );
  }

  async function save(openReview = false): Promise<LabProgram | null> {
    if (!project) {
      setMessage({ tone: 'warning', text: 'Choose a project first.' });
      return null;
    }
    if (personMissing) {
      setMessage({ tone: 'warning', text: 'Choose who this program is requested by.' });
      return null;
    }
    setBusy(true);
    setMessage(null);
    const person = shared ? { requestedByUserId: requestedBy!.id } : {};
    const body = { notes: notes.trim() || null, lines: lines.map(toInput), ...person };
    const result = programId
      ? await saveProgram(programId, { version, ...body })
      : await createProgram({ projectId: project.id, idempotencyKey: createKey, ...body });
    setBusy(false);
    if (!result.ok) {
      if (result.kind === 'conflict' && result.current) setConflict(result.current);
      setMessage({ tone: 'warning', text: failureMessage(result) });
      return null;
    }
    const saved = result.value;
    setProgramId(saved.id);
    setVersion(saved.version);
    // Keep the client keys stable but learn the server's line IDs.
    setLines((current) =>
      current.map((line, i) => ({ ...line, id: saved.lines[i]?.id ?? line.id })),
    );
    // The new draft opens at its own address (this editor is replaced by the draft's editor),
    // which then shows the review the person asked for.
    if (!programId)
      navigate(`/lab-testing/programs/${saved.id}`, { replace: true, state: { openReview } });
    return saved;
  }

  async function saveAndReview() {
    const created = programId === null;
    const saved = await save(true);
    if (!saved || created) return;
    await loadReview(saved.id);
  }

  async function loadReview(id: string) {
    try {
      setReview(await fetchReview(id));
      setReviewStale(false);
    } catch {
      setMessage({ tone: 'warning', text: 'The review couldn’t be loaded. Try again.' });
    }
  }

  async function submit() {
    if (!programId || !review) return;
    setBusy(true);
    const result = await submitProgram(programId, {
      version,
      idempotencyKey: submitKey,
      ...(shared ? { requestedByUserId: requestedBy?.id } : {}),
      coverage: review.lines.map((line) => ({
        lineId: line.lineId,
        unitIds: line.coverage.map((unit) => unit.storageUnitId),
      })),
    });
    setBusy(false);
    if (result.ok) {
      navigate(`/lab-testing/programs/${result.value.id}`, { replace: true });
      onReload?.();
      return;
    }
    if (result.kind === 'network') {
      // Same key on retry: a submission that did commit is returned, never duplicated.
      setMessage({ tone: 'warning', text: failureMessage(result) });
      return;
    }
    setSubmitKey(newKey());
    if ((result.kind === 'conflict' || result.kind === 'invalid') && result.review) {
      setReview(result.review);
      setReviewStale(false);
    }
    if (result.kind === 'conflict' && result.current) setConflict(result.current);
    setMessage({ tone: 'warning', text: failureMessage(result) });
  }

  async function discard() {
    setConfirmDiscard(false);
    if (!programId) {
      navigate('/lab-testing/programs');
      return;
    }
    const result = await discardProgram(programId, {
      version,
      ...(shared && requestedBy ? { requestedByUserId: requestedBy.id } : {}),
    });
    if (result.ok) navigate('/lab-testing/programs');
    else setMessage({ tone: 'warning', text: failureMessage(result) });
  }

  function loadLatest() {
    if (!conflict) return;
    setVersion(conflict.version);
    setNotes(conflict.notes ?? '');
    setLines(fromProgram(conflict));
    if (shared) setRequestedBy(personOption(conflict));
    setConflict(null);
    setReview(null);
    setMessage(null);
  }

  if (loadError)
    return (
      <ErrorState
        message="The test catalogue couldn’t be loaded."
        onRetry={() => window.location.reload()}
      />
    );

  return (
    <form
      className="program-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void saveAndReview();
      }}
      noValidate
    >
      <h2>{programId ? 'Draft program' : 'New program'}</h2>
      {shared ? (
        <div className="requested-by-station">
          <ReceiverSelect
            label="Requested by"
            required
            value={requestedBy}
            onChange={(option) => {
              setRequestedBy(option);
              setReview(null);
            }}
            error={personMissing && message ? 'Choose who this program is requested by.' : null}
            hint="Shared LAB station: choose the person requesting these tests. This is attribution only; it gives LAB none of their permissions."
          />
          <p className="requested-by-current" aria-live="polite">
            {requestedBy
              ? `Recorded as LAB for ${formatReceiver(requestedBy)}`
              : 'Nobody chosen yet'}
          </p>
        </div>
      ) : (
        <p className="field-hint">
          Requested by {formatPerson(me.initials ?? null, me.displayName)}.
        </p>
      )}

      {draft ? (
        <p>
          Project <strong>{project?.label}</strong>
        </p>
      ) : (
        <ProjectChooser
          value={project}
          onChange={(next) => {
            setProject(next);
            setLines([emptyLine()]);
            setReview(null);
          }}
        />
      )}

      {message ? (
        <div className={`notice notice-${message.tone}`} role="alert">
          <p>{message.text}</p>
          {conflict ? (
            <button type="button" onClick={loadLatest}>
              Load the newer version
            </button>
          ) : null}
        </div>
      ) : null}

      {project && catalogue ? (
        <>
          {lines.map((line, index) => (
            <LineEditor
              key={line.key}
              index={index}
              line={line}
              projectId={project.id}
              sources={sources}
              catalogue={catalogue}
              templates={templates}
              review={review?.lines.find((l) => l.lineId === line.id) ?? null}
              onChange={(change) => updateLine(line.key, change)}
              onRemove={
                lines.length > 1
                  ? () => {
                      setReview(null);
                      setLines((current) => current.filter((other) => other.key !== line.key));
                    }
                  : undefined
              }
            />
          ))}
          <button type="button" onClick={() => setLines((current) => [...current, emptyLine()])}>
            Add line
          </button>
          <div className="form-field">
            <label htmlFor="program-notes">Notes</label>
            <textarea
              id="program-notes"
              value={notes}
              maxLength={2000}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </>
      ) : project ? (
        <p aria-busy="true">Loading the test catalogue…</p>
      ) : null}

      {review ? <ReviewPanel review={review} lines={lines} /> : null}
      {review && reviewStale ? (
        <p className="field-hint" role="status">
          You changed the program after this review. Review again before submitting.
        </p>
      ) : null}

      <div className="form-actions program-actions">
        <button type="button" onClick={() => setConfirmDiscard(true)} disabled={busy}>
          Discard draft
        </button>
        <button type="button" onClick={() => void save()} disabled={busy || !project}>
          Save draft
        </button>
        <button type="submit" disabled={busy || !project}>
          Review
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !review?.ready || reviewStale || personMissing}
          onClick={() => void submit()}
        >
          Submit program
        </button>
      </div>
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard this draft?"
        confirmLabel="Discard draft"
        danger
        onConfirm={() => void discard()}
        onCancel={() => setConfirmDiscard(false)}
      >
        <p>The draft and its lines are deleted. Submitted programs are never affected.</p>
      </ConfirmDialog>
    </form>
  );
}

function ProjectChooser({
  value,
  onChange,
}: {
  value: { id: string; label: string } | null;
  onChange: (project: { id: string; label: string } | null) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    const text = query.trim();
    if (text === '') return;
    let current = true;
    const timer = window.setTimeout(() => {
      searchProjects(text).then(
        (found) => current && setResults(found),
        () => current && setResults([]),
      );
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query]);
  if (value) {
    return (
      <p>
        Project <strong>{value.label}</strong>{' '}
        <button type="button" onClick={() => onChange(null)}>
          Change project
        </button>
      </p>
    );
  }
  return (
    <div className="form-field">
      <label htmlFor={id}>Project</label>
      <input
        id={id}
        type="search"
        value={query}
        placeholder="Project number or name"
        onChange={(event) => setQuery(event.target.value)}
      />
      {query.trim() && results.length > 0 ? (
        <ul className="test-results" aria-label="Matching projects">
          {results.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                onClick={() =>
                  onChange({ id: project.id, label: `${project.projectNumber} · ${project.name}` })
                }
              >
                <span className="mono">{project.projectNumber}</span> {project.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function LineEditor({
  index,
  line,
  projectId,
  sources,
  catalogue,
  templates,
  review,
  onChange,
  onRemove,
}: {
  index: number;
  line: LineDraft;
  projectId: string;
  sources: LabSource[];
  catalogue: TestCatalogue;
  templates: TestTemplate[];
  review: LabProgramReview['lines'][number] | null;
  onChange: (change: Partial<LineDraft>) => void;
  onRemove?: () => void;
}) {
  const id = useId();
  const [units, setUnits] = useState<LabSourceUnit[] | null>(null);
  const sourceValue = line.source ? `${line.source.kind}:${line.source.id}` : '';
  useEffect(() => {
    if (!line.source || line.scope === 'all') return;
    let current = true;
    fetchSourceUnits(projectId, line.source).then(
      (found) => current && setUnits(found),
      () => current && setUnits([]),
    );
    return () => {
      current = false;
    };
  }, [projectId, line.source, line.scope]);

  const problems = lineSubmitProblems({
    ...toInput(line),
    source: line.source,
    sampleLabel: line.scope === 'specific' && line.sampleLabel.trim() ? line.sampleLabel : null,
    depthMode: line.scope === 'specific' ? line.depthMode : null,
    depthFrom: line.scope === 'specific' ? numberOrNull(line.depthFrom) : null,
    depthTo: line.scope === 'specific' ? numberOrNull(line.depthTo) : null,
    depthUnit: line.scope === 'specific' ? line.depthUnit : null,
    scope: line.scope,
    testCount: line.testTypeIds.length,
  });
  const groups: [string, LabSource['kind']][] = [
    ['Test holes', 'test_hole'],
    ['Standalone Shelby tubes', 'standalone_unit'],
    ['Standalone bulk samples', 'standalone_bulk_group'],
  ];

  return (
    <BandedCard
      title={`Line ${index + 1}`}
      headingLevel={3}
      aside={
        onRemove ? (
          <button type="button" onClick={onRemove}>
            Remove line
          </button>
        ) : null
      }
    >
      <div className="line-grid">
        <div className="form-field">
          <label htmlFor={`${id}-source`}>Sampling source</label>
          <select
            id={`${id}-source`}
            value={sourceValue}
            onChange={(event) => {
              const [kind, sourceId] = event.target.value.split(':');
              setUnits(null);
              onChange({
                source: sourceId ? { kind: kind as LabSource['kind'], id: sourceId } : null,
                unitIds: [],
              });
            }}
          >
            <option value="">Choose a source</option>
            {groups.map(([label, kind]) => {
              const options = sources.filter((source) => source.kind === kind);
              return options.length > 0 ? (
                <optgroup key={kind} label={label}>
                  {options.map((source) => (
                    <option key={source.id} value={`${source.kind}:${source.id}`}>
                      {source.label} — {source.unitCount} unit{source.unitCount === 1 ? '' : 's'}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </div>
        <fieldset className="scope-toggle">
          <legend>Samples</legend>
          {LINE_SCOPES.map((scope) => (
            <label key={scope}>
              <input
                type="radio"
                name={`${id}-scope`}
                value={scope}
                checked={line.scope === scope}
                onChange={() => onChange({ scope, unitIds: [] })}
              />
              {LINE_SCOPE_LABEL[scope]}
            </label>
          ))}
        </fieldset>
      </div>

      {line.scope === 'specific' ? (
        <div className="specific-sample">
          <div className="form-field">
            <label htmlFor={`${id}-label`}>Sample label</label>
            <input
              id={`${id}-label`}
              value={line.sampleLabel}
              placeholder="G3"
              maxLength={40}
              onChange={(event) => onChange({ sampleLabel: event.target.value })}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-mode`}>Depth</label>
            <select
              id={`${id}-mode`}
              value={line.depthMode}
              onChange={(event) =>
                onChange({ depthMode: event.target.value as 'point' | 'interval' })
              }
            >
              <option value="point">Single depth</option>
              <option value="interval">Interval (from–to)</option>
            </select>
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-from`}>{line.depthMode === 'interval' ? 'From' : 'At'}</label>
            <input
              id={`${id}-from`}
              inputMode="decimal"
              value={line.depthFrom}
              onChange={(event) => onChange({ depthFrom: event.target.value })}
            />
          </div>
          {line.depthMode === 'interval' ? (
            <div className="form-field">
              <label htmlFor={`${id}-to`}>To</label>
              <input
                id={`${id}-to`}
                inputMode="decimal"
                value={line.depthTo}
                onChange={(event) => onChange({ depthTo: event.target.value })}
              />
            </div>
          ) : null}
          <div className="form-field">
            <label htmlFor={`${id}-unit`}>Unit</label>
            <select
              id={`${id}-unit`}
              value={line.depthUnit}
              onChange={(event) => onChange({ depthUnit: event.target.value as 'ft' | 'm' })}
            >
              <option value="ft">ft</option>
              <option value="m">m</option>
            </select>
          </div>
        </div>
      ) : null}

      {line.source && line.scope !== 'all' ? (
        <fieldset className="unit-choices">
          <legend>
            {line.scope === 'specific'
              ? 'Physical units holding this sample (if known)'
              : 'Units to include'}
          </legend>
          {line.scope !== 'specific' ? (
            <p className="field-hint">
              Units don’t record whether they hold {line.scope === 'grabs' ? 'grab (G)' : 'SPT (S)'}{' '}
              samples. Tick the units that do; unticked units are recorded as excluded after your
              review.
            </p>
          ) : (
            <p className="field-hint">
              Leave all unticked when you don’t know which unit holds it.
            </p>
          )}
          {units === null ? (
            <p aria-busy="true">Loading units…</p>
          ) : units.length === 0 ? (
            <p className="field-hint">No units from this source are in storage.</p>
          ) : (
            units.map((unit) => (
              <label key={unit.storageUnitId} className="unit-choice">
                <input
                  type="checkbox"
                  checked={line.unitIds.includes(unit.storageUnitId)}
                  onChange={(event) =>
                    onChange({
                      unitIds: event.target.checked
                        ? [...line.unitIds, unit.storageUnitId]
                        : line.unitIds.filter((other) => other !== unit.storageUnitId),
                    })
                  }
                />
                <span className="mono">{unit.readableId}</span> {unit.contents ?? ''}
              </label>
            ))
          )}
        </fieldset>
      ) : null}

      <h4 id={`${id}-tests`}>Tests</h4>
      <TestPicker
        labelId={`${id}-tests`}
        catalogue={catalogue}
        templates={templates}
        selected={line.testTypeIds}
        onChange={(testTypeIds) => onChange({ testTypeIds })}
      />

      {review?.discrepancy ? (
        <div className="notice notice-warning">
          <p>
            Depth differs: this sample is also requested at{' '}
            {review.discrepancy.others
              .map(
                (other) =>
                  `${other.depth} (${other.programNumber ?? 'this draft'}, line ${other.lineNumber})`,
              )
              .join('; ')}
            .
          </p>
          <label>
            <input
              type="checkbox"
              checked={review.discrepancy.depths.every((depth) =>
                line.acknowledgedDepths.map(depthKey).includes(depthKey(depth)),
              )}
              onChange={(event) =>
                onChange({
                  acknowledgedDepths: event.target.checked ? review.discrepancy!.depths : [],
                })
              }
            />{' '}
            I’ve checked the depths; request it at this depth anyway
          </label>
        </div>
      ) : null}
      {problems.length > 0 ? (
        <ul className="line-problems" aria-label={`Line ${index + 1} still needs`}>
          {problems.map((problem) => (
            <li key={problem.field}>{problem.message}</li>
          ))}
        </ul>
      ) : null}
    </BandedCard>
  );
}

function ReviewPanel({ review, lines }: { review: LabProgramReview; lines: LineDraft[] }) {
  return (
    <BandedCard
      title="Review before submitting"
      aside={
        review.ready ? (
          <StatusBadge tone="success">Ready</StatusBadge>
        ) : (
          <StatusBadge tone="warning">Needs attention</StatusBadge>
        )
      }
    >
      <p className="field-hint">
        Coverage is the material received so far for each line. It is frozen when you submit; later
        receipts are not added. It is potential material, not a record of what was tested.
      </p>
      {review.lines.map((line) => {
        const draft = lines.find((l) => l.id === line.lineId);
        const included = line.coverage.filter((unit) => unit.included);
        const excluded = line.coverage.filter((unit) => !unit.included);
        return (
          <section key={line.lineId} className="review-line" aria-label={`Line ${line.lineNumber}`}>
            <h3>
              Line {line.lineNumber}
              {draft ? ` · ${LINE_SCOPE_LABEL[draft.scope]}` : ''}
            </h3>
            {included.length > 0 ? (
              <p>
                Covers {included.map((unit) => unit.readableId).join(', ')}
                {draft?.scope === 'specific' ? '' : ' received so far'}.
              </p>
            ) : draft?.scope === 'specific' ? (
              <p>No physical unit linked to this sample.</p>
            ) : (
              <p className="text-warning">Covers no units.</p>
            )}
            {line.unknownClassificationCount > 0 ? (
              <p className="text-warning">
                {line.unknownClassificationCount} unit
                {line.unknownClassificationCount === 1 ? '' : 's'} with unknown G/S classification:{' '}
                {excluded.length} excluded
                {excluded.length > 0
                  ? ` (${excluded.map((unit) => unit.readableId).join(', ')})`
                  : ''}
                .
              </p>
            ) : null}
            {line.coverage.length > 0 ? (
              <ul className="coverage-list">
                {line.coverage.map((unit) => (
                  <li key={unit.storageUnitId}>
                    <span className="mono">{unit.readableId}</span> {unit.contents ?? ''} —{' '}
                    {MATCHING_BASIS_LABEL[unit.matchingBasis]}
                  </li>
                ))}
              </ul>
            ) : null}
            {line.problems.length > 0 ? (
              <ul className="line-problems">
                {line.problems.map((problem) => (
                  <li key={problem.code + problem.field}>{problem.message}</li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </BandedCard>
  );
}
