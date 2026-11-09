import type { ConcreteMixSummary, ProjectDetail, ProjectSummary } from '@materialmule/shared';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { searchProjects } from '../../api/projects';
import { BandedCard, DataTable, ErrorState, StatusBadge, TableScroll } from '../../components/ui';
import { concreteProblem, copyMix, createMix, fetchMixes } from './api';
import { MixForm } from './MixForm';
import { MIX_STATUS, agesText, airText, slumpText, strengthText } from './mix-format';
import { mixPath } from './paths';
import { useLoad } from './useLoad';

// MM-V2-C30 Mixes tab: the project's mixes; Add mix and Copy from another project for the Lead
// (CD-52: only the project's Lead Project Engineer manages and approves mixes; the server refuses
// everyone else, AC3). A copy always starts Unapproved (AC2).

const LEAD_ONLY = 'Only the project’s Lead Project Engineer can add, copy, edit or approve mixes.';

export function MixesTab({ project }: { project: ProjectDetail }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'list' | 'add' | 'copy'>('list');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { load, reload } = useLoad(`mixes|${project.id}`, () => fetchMixes(project.id));

  const spec = (mix: ConcreteMixSummary) =>
    (mix.effectiveRevision ?? mix.draftRevision)?.spec ?? null;

  if (mode === 'add') {
    return (
      <BandedCard title="Add mix" className="concrete-tab">
        <MixForm
          initial={null}
          title="Add mix"
          submitLabel="Add mix"
          busy={busy}
          error={error}
          onCancel={() => {
            setError(null);
            setMode('list');
          }}
          onSubmit={(input) => {
            setBusy(true);
            setError(null);
            createMix(project.id, { idempotencyKey: crypto.randomUUID(), spec: input })
              .then((created) => navigate(mixPath(project.id, created.id)))
              .catch((caught: unknown) => setError(concreteProblem(caught)))
              .finally(() => setBusy(false));
          }}
        />
      </BandedCard>
    );
  }

  if (mode === 'copy') {
    return (
      <CopyMix
        project={project}
        onCancel={() => setMode('list')}
        onCopied={(id) => navigate(mixPath(project.id, id))}
      />
    );
  }

  return (
    <section className="concrete-tab" aria-label="Mixes">
      {load.state === 'loading' ? <p role="status">Loading…</p> : null}
      {load.state === 'error' ? (
        <ErrorState message={concreteProblem(load.error)} onRetry={reload} />
      ) : null}
      {load.state === 'ready' ? (
        <>
          <div className="concrete-toolbar">
            {load.data.canManage ? (
              <div className="page-actions">
                <button type="button" className="primary" onClick={() => setMode('add')}>
                  Add mix
                </button>
                <button type="button" onClick={() => setMode('copy')}>
                  Copy from another project
                </button>
              </div>
            ) : (
              <p className="field-hint concrete-lead-only">{LEAD_ONLY}</p>
            )}
          </div>
          <TableScroll label="Mixes">
            <DataTable<ConcreteMixSummary>
              rows={load.data.items}
              rowKey={(mix) => mix.id}
              caption="Mixes"
              empty="No mixes for this project yet."
              columns={[
                {
                  header: 'Supplier',
                  cell: (mix) => mix.supplierName,
                },
                {
                  header: 'Mix',
                  cell: (mix) => (
                    <Link to={mixPath(project.id, mix.id)} aria-label={`Open mix ${mix.mixNumber}`}>
                      {mix.mixNumber}
                    </Link>
                  ),
                },
                { header: 'Strength', cell: (mix) => (spec(mix) ? strengthText(spec(mix)!) : '—') },
                { header: 'Slump', cell: (mix) => (spec(mix) ? slumpText(spec(mix)!) : '—') },
                { header: 'Air', cell: (mix) => (spec(mix) ? airText(spec(mix)!) : '—') },
                {
                  header: 'Test ages',
                  cell: (mix) => (spec(mix) ? agesText(spec(mix)!.testAges) : '—'),
                },
                {
                  header: 'Status',
                  cell: (mix) => (
                    <StatusBadge tone={MIX_STATUS[mix.status].tone}>
                      {MIX_STATUS[mix.status].label}
                    </StatusBadge>
                  ),
                },
                {
                  header: 'Copied from',
                  cell: (mix) =>
                    mix.copiedFrom
                      ? `${mix.copiedFrom.projectNumber} ${mix.copiedFrom.mixNumber} (rev ${mix.copiedFrom.revisionNumber})`
                      : '—',
                },
              ]}
            />
          </TableScroll>
        </>
      ) : null}
    </section>
  );
}

/** Pick a project, then one of its mixes; the copy lands here as Unapproved. */
function CopyMix({
  project,
  onCancel,
  onCopied,
}: {
  project: ProjectDetail;
  onCancel: () => void;
  onCopied: (mixId: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [found, setFound] = useState<ProjectSummary[] | null>(null);
  const [source, setSource] = useState<ProjectSummary | null>(null);
  const [mixes, setMixes] = useState<ConcreteMixSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    fetchMixes(source.id).then(
      (list) => {
        if (!cancelled) setMixes(list.items);
      },
      (caught: unknown) => {
        if (!cancelled) setError(concreteProblem(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  function find(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setError(null);
    searchProjects(text.trim()).then(
      (list) => setFound(list.filter((p) => p.id !== project.id)),
      () => setError('Couldn’t search projects. Try again.'),
    );
  }

  function copy(mix: ConcreteMixSummary) {
    setBusy(true);
    setError(null);
    copyMix(project.id, { idempotencyKey: crypto.randomUUID(), sourceMixId: mix.id })
      .then((copied) => onCopied(copied.id))
      .catch((caught: unknown) => setError(concreteProblem(caught)))
      .finally(() => setBusy(false));
  }

  return (
    <BandedCard title="Copy a mix from another project" className="concrete-tab">
      <p className="field-hint">
        The copy starts Unapproved in {project.projectNumber}. The source mix and its approval don’t
        change.
      </p>
      {!source ? (
        <>
          <form role="search" className="concrete-search" onSubmit={find}>
            <label htmlFor={`${id}-q`}>Find the source project</label>
            <div className="inline-input">
              <input
                id={`${id}-q`}
                type="search"
                value={text}
                placeholder="Project number or name"
                onChange={(e) => setText(e.target.value)}
              />
              <button type="submit">Search</button>
            </div>
          </form>
          {found ? (
            found.length === 0 ? (
              <p>No other projects match.</p>
            ) : (
              <ul className="concrete-choices" aria-label="Projects">
                {found.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => setSource(p)}>
                      {p.projectNumber} · {p.name}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </>
      ) : (
        <>
          <p>
            Mixes in <strong>{source.projectNumber}</strong>{' '}
            <button
              type="button"
              onClick={() => {
                setSource(null);
                setMixes(null);
              }}
            >
              Choose another project
            </button>
          </p>
          {mixes === null ? <p role="status">Loading…</p> : null}
          {mixes && mixes.length === 0 ? <p>That project has no mixes.</p> : null}
          {mixes && mixes.length > 0 ? (
            <ul className="concrete-choices" aria-label="Source mixes">
              {mixes.map((mix) => (
                <li key={mix.id}>
                  <span>
                    {mix.supplierName} {mix.mixNumber}{' '}
                    <StatusBadge tone={MIX_STATUS[mix.status].tone}>
                      {MIX_STATUS[mix.status].label}
                    </StatusBadge>
                  </span>
                  <button type="button" disabled={busy} onClick={() => copy(mix)}>
                    Copy {mix.mixNumber}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="page-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </BandedCard>
  );
}
