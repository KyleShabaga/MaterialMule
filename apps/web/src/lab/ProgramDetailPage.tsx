import {
  MATCHING_BASIS_LABEL,
  TEST_REQUEST_STATUS_LABEL,
  formatAttribution,
  programLabel,
  type LabLine,
  type LabProgram,
  type TestRequest,
} from '@materialmule/shared';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { BandedCard, ErrorState, StatusBadge } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { fetchProgram } from './api';
import { lineTitle, requestName } from './format';
import { ProgramEditor } from './ProgramEditor';

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'missing' }
  | { state: 'ready'; program: LabProgram };

/** A frozen line: tests with their snapshots and the coverage captured at submission. */
export function FrozenLine({
  line,
  testActions,
  children,
}: {
  line: LabLine;
  /** Per-test controls added by MM-T24 (status buttons, who/when). */
  testActions?: (request: TestRequest) => ReactNode;
  children?: ReactNode;
}) {
  const included = line.coverage.filter((unit) => unit.included);
  const excluded = line.coverage.filter((unit) => !unit.included);
  return (
    <BandedCard title={`Line ${line.lineNumber} · ${lineTitle(line)}`} headingLevel={3}>
      <ul className="request-list">
        {line.requests.map((request) => (
          <li key={request.id}>
            <span title={request.description}>{requestName(request)}</span>{' '}
            <StatusBadge tone="info">{TEST_REQUEST_STATUS_LABEL[request.status]}</StatusBadge>
            {testActions ? testActions(request) : null}
          </li>
        ))}
      </ul>
      <details className="coverage-details">
        <summary>
          {line.scope === 'specific'
            ? included.length > 0
              ? `Linked units: ${included.map((u) => u.readableId).join(', ')}`
              : 'No physical unit linked'
            : `Covers ${included.length} unit${included.length === 1 ? '' : 's'} received by submission${
                excluded.length > 0 ? `, ${excluded.length} excluded after review` : ''
              }`}
        </summary>
        <p className="field-hint">
          Frozen {line.coverageCapturedAt ? shortDateTime(line.coverageCapturedAt) : ''}. Potential
          material only, not a record of which unit was tested.
        </p>
        <ul className="coverage-list">
          {line.coverage.map((unit) => (
            <li key={unit.storageUnitId} className={unit.included ? undefined : 'excluded'}>
              <Link className="mono" to={`/sample-storage/${unit.readableId}`}>
                {unit.readableId}
              </Link>{' '}
              {unit.contents ?? ''} — {MATCHING_BASIS_LABEL[unit.matchingBasis]}
            </li>
          ))}
        </ul>
      </details>
      {children}
    </BandedCard>
  );
}

export function ProgramSummary({ program }: { program: LabProgram }) {
  return (
    <dl className="program-summary">
      <dt>Project</dt>
      <dd>
        <Link to={`/projects/${program.project.id}`}>
          {program.project.projectNumber} · {program.project.name}
        </Link>
      </dd>
      <dt>Requested by</dt>
      <dd>
        {formatAttribution(
          program.submittedBy ?? program.createdBy,
          program.submittedFor ?? program.requestedBy,
        )}
      </dd>
      <dt>Submitted</dt>
      <dd>{program.submittedAt ? shortDateTime(program.submittedAt) : 'Not yet'}</dd>
      <dt>Priority</dt>
      <dd>
        {program.priority === 'urgent' ? (
          <StatusBadge tone="danger">Urgent</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Normal</StatusBadge>
        )}
      </dd>
      {program.notes ? (
        <>
          <dt>Notes</dt>
          <dd className="pre-wrap">{program.notes}</dd>
        </>
      ) : null}
    </dl>
  );
}

/** /lab-testing/programs/:id — a draft opens in the editor, a submitted program read-only. */
export function ProgramDetailPage({
  renderSubmitted,
}: {
  /** MM-T24 swaps in the worked program view (status, priority, comments). */
  renderSubmitted?: (program: LabProgram, reload: () => void) => ReactNode;
}) {
  const { programId = '' } = useParams();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const reload = useCallback(() => {
    fetchProgram(programId).then(
      (program) => setLoad(program ? { state: 'ready', program } : { state: 'missing' }),
      () => setLoad({ state: 'error' }),
    );
  }, [programId]);
  useEffect(reload, [reload]);

  if (load.state === 'loading') return <p aria-busy="true">Loading program…</p>;
  if (load.state === 'error')
    return <ErrorState message="The program couldn’t be loaded." onRetry={reload} />;
  if (load.state === 'missing') {
    return (
      <p>
        This program doesn’t exist, or it is someone else’s draft.{' '}
        <Link to="/lab-testing/programs">Back to programs</Link>
      </p>
    );
  }
  const { program } = load;
  if (program.status === 'draft')
    return <ProgramEditor key={program.id} draft={program} onReload={reload} />;
  if (renderSubmitted) return <>{renderSubmitted(program, reload)}</>;
  return (
    <article aria-labelledby="program-heading">
      <h2 id="program-heading" className="mono">
        {programLabel(program)}
      </h2>
      <ProgramSummary program={program} />
      {program.lines.map((line) => (
        <FrozenLine key={line.id} line={line} />
      ))}
    </article>
  );
}
