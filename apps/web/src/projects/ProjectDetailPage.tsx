import {
  formatPerson,
  type InventoryPage,
  type ProjectDetail,
  type StaffOption,
} from '@materialmule/shared';
import { ProjectRetentionSection } from '../retention/RetentionSections';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { createTestHole } from '../api/projects';
import { BandedCard, DataTable, EmptyState, ErrorState, PageHeader } from '../components/ui';
import { fetchInventory } from '../inventory/api';
import '../inventory/inventory.css';
import { StorageUnitTable, type StorageUnitLinkState } from '../inventory/StorageUnitTable';
import { useMe } from '../session/context';
import { AcceptanceDelegatesSection } from './AcceptanceDelegates';
import { fetchProjectDetail, type LoadResult } from './api';
import { EditProjectDialog } from './EditProjectDialog';
import { LeadSection } from './LeadSection';
import type { ProjectLinkState } from './ProjectsPage';
import './projects.css';

/** Units shown on the project page; the full list is a link to Sample Storage. */
const PROJECT_UNITS_PAGE_SIZE = 25;

function personLabel(person: StaffOption | null): string {
  if (!person) return 'None';
  return formatPerson(person.initials, person.displayName);
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-CA')} ${count === 1 ? one : many}`;
}

/** Sample Storage filtered to this project (any status), optionally one test hole. */
function sampleStorageLink(projectId: string, testHoleId?: string): string {
  const params = new URLSearchParams({ projectId });
  if (testHoleId) params.set('testHoleId', testHoleId);
  params.set('status', 'all');
  return `/sample-storage?${params.toString()}`;
}

/**
 * Project detail (MM-T35): header fields, copyable server folder path, test holes with unit
 * counts, receipts, and the project's storage units in the T12 table.
 */
export function ProjectDetailPage() {
  const { projectId = '' } = useParams();
  const location = useLocation();
  const me = useMe();
  const from = (location.state as ProjectLinkState | null)?.from ?? '';

  const [result, setResult] = useState<(LoadResult<ProjectDetail> & { key: string }) | null>(null);
  const [reloads, setReloads] = useState(0);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchProjectDetail(projectId).then((response) => {
      if (!cancelled) setResult({ ...response, key: projectId });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloads]);

  const back = (
    <p className="back-link">
      <Link to={`/projects${from}`}>← Back to Projects</Link>
    </p>
  );

  if (!result || result.key !== projectId) {
    return (
      <>
        {back}
        <p role="status">Loading…</p>
      </>
    );
  }
  if (!result.ok) {
    return (
      <>
        {back}
        <PageHeader title="Project" />
        {result.notFound ? (
          <EmptyState>Project not found.</EmptyState>
        ) : (
          <ErrorState message={result.message} onRetry={() => setReloads((n) => n + 1)} />
        )}
      </>
    );
  }

  const project = result.data;
  const replace = (next: ProjectDetail) => setResult({ ok: true, data: next, key: projectId });
  const canAddHoles = me.permissions.includes('test_hole.create');

  return (
    <>
      {back}
      <div className="project-header">
        <div>
          <h1 className="project-number-heading">{project.projectNumber}</h1>
          <p className="project-name">{project.name}</p>
        </div>
        <div className="page-actions">
          {me.permissions.includes('project_access.read') ? (
            <Link className="button" to={`/projects/${encodeURIComponent(project.id)}/team`}>
              Team &amp; Permissions
            </Link>
          ) : null}
          {project.canEdit ? (
            <button type="button" onClick={() => setEditing(true)}>
              Edit project
            </button>
          ) : null}
        </div>
      </div>
      <p className={notice ? 'notice notice-success' : 'notice'} role="status">
        {notice}
      </p>

      <Section title="Project details">
        <dl className="stat-tiles project-tiles">
          <Detail term="Client">{project.client}</Detail>
          <Detail term="Lead Project Engineer">
            {project.leadProjectEngineer ? (
              personLabel(project.leadProjectEngineer)
            ) : (
              <span className="badge badge-warning">Waiting for a lead</span>
            )}
          </Detail>
          <Detail term="Storage units">
            <strong>{plural(project.inStockUnitCount, 'unit', 'units')}</strong> in stock of{' '}
            {plural(project.unitCount, 'unit', 'units')} received
          </Detail>
          <Detail term="Server folder" wide>
            {project.serverFolderPath ? <FolderPath path={project.serverFolderPath} /> : 'Not set'}
          </Detail>
        </dl>
      </Section>

      {me.permissions.includes('project_access.read') ? (
        <LeadSection
          projectId={project.id}
          lead={project.leadProjectEngineer}
          reloadKey={reloads}
          onChanged={(message) => {
            setNotice(message);
            setReloads((n) => n + 1);
          }}
        />
      ) : null}

      <div className="project-columns">
        <Section title="Test holes">
          {project.testHoles.length === 0 ? (
            <EmptyState>No test holes yet.</EmptyState>
          ) : (
            <ul className="project-holes" aria-label="Test holes">
              {project.testHoles.map((hole) => (
                <li key={hole.id}>
                  <span className="hole-name">{hole.name}</span>{' '}
                  {hole.unitCount > 0 ? (
                    <Link to={sampleStorageLink(project.id, hole.id)}>
                      {plural(hole.unitCount, 'unit', 'units')}
                    </Link>
                  ) : (
                    <span className="muted">0 units</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canAddHoles ? (
            <AddTestHoleForm
              projectId={project.id}
              onAdded={(name) => {
                setNotice(`Added test hole ${name}.`);
                setReloads((n) => n + 1);
              }}
            />
          ) : null}
        </Section>

        <Section title="Receipts">
          {project.receipts.length === 0 ? (
            <EmptyState>Nothing received for this project yet.</EmptyState>
          ) : (
            <>
              <DataTable
                rows={project.receipts}
                rowKey={(receipt) => receipt.id}
                caption="Receipts"
                empty="No receipts."
                columns={[
                  {
                    header: 'Received',
                    cell: (receipt) => <span className="nowrap">{receipt.receivedDate}</span>,
                  },
                  {
                    header: 'Received by',
                    cell: (receipt) =>
                      formatPerson(receipt.receiver.initials, receipt.receiver.name),
                  },
                  { header: 'Units', cell: (receipt) => receipt.unitCount },
                ]}
              />
              {project.receiptCount > project.receipts.length ? (
                <p className="field-hint">
                  Showing the newest {project.receipts.length} of {project.receiptCount} receipts.
                </p>
              ) : null}
            </>
          )}
        </Section>
      </div>

      <Section
        title="Storage units"
        actions={
          <Link to={sampleStorageLink(project.id)} aria-label="Open in Sample Storage">
            Open in Sample Storage →
          </Link>
        }
      >
        <ProjectUnits projectId={project.id} total={project.unitCount} reloadKey={reloads} />
      </Section>

      {/* MM-T29: project-wide holds, extensions and retention requests. */}
      <ProjectRetentionSection projectId={project.id} />

      {me.permissions.includes('acceptance_delegation.read') ? (
        <AcceptanceDelegatesSection projectId={project.id} />
      ) : null}

      {editing ? (
        <EditProjectDialog
          project={project}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            replace(saved);
            setEditing(false);
            setNotice('Project saved.');
          }}
          onStale={(current) => replace(current)}
        />
      ) : null}
    </>
  );
}

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <BandedCard className="project-section" title={title} aside={actions}>
      {children}
    </BandedCard>
  );
}

/** One stat tile; `wide` spans the whole row (the server folder path and its Copy button). */
function Detail({ term, wide, children }: { term: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? 'project-tile-wide' : undefined}>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Copies via the Clipboard API, or the older selection copy where that's unavailable (http). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection copy.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** The folder path as text with a Copy button. Browsers block file:// links, so no link. */
function FolderPath({ path }: { path: string }) {
  const [status, setStatus] = useState<string | null>(null);
  return (
    <span className="folder-path">
      <code>{path}</code>
      <button
        type="button"
        onClick={() => {
          void copyText(path).then((copied) =>
            setStatus(copied ? 'Copied' : "Couldn't copy. Select the path and copy it."),
          );
        }}
      >
        Copy
      </button>
      <span role="status" className="field-hint">
        {status}
      </span>
    </span>
  );
}

function AddTestHoleForm({
  projectId,
  onAdded,
}: {
  projectId: string;
  onAdded: (name: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === '') {
      setError('Test hole name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createTestHole(projectId, { name });
      if (result.kind === 'created') {
        setName('');
        onAdded(result.record.name);
      } else if (result.kind === 'exists') {
        setError(`${result.existing.name} already exists in this project.`);
      } else {
        setError(result.fieldErrors.name?.[0] ?? 'Check the test hole name.');
      }
    } catch {
      setError("Couldn't add the test hole. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-hole" aria-label="Add test hole" onSubmit={(event) => void submit(event)}>
      <label htmlFor={id}>Add test hole</label>
      <div className="inline-input">
        <input
          id={id}
          type="text"
          value={name}
          maxLength={40}
          autoComplete="off"
          placeholder="e.g. TH26-03"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" disabled={busy}>
          Add test hole
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** The project's storage units in the shared T12 table (first page, any status). */
function ProjectUnits({
  projectId,
  total,
  reloadKey,
}: {
  projectId: string;
  total: number;
  reloadKey: number;
}) {
  const [result, setResult] = useState<LoadResult<InventoryPage> | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      projectId,
      status: 'all',
      pageSize: String(PROJECT_UNITS_PAGE_SIZE),
    });
    void fetchInventory(params).then((response) => {
      if (!cancelled) setResult(response);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey, reloads]);

  if (total === 0) {
    return <EmptyState>No storage units received for this project yet.</EmptyState>;
  }
  if (!result) return <p role="status">Loading…</p>;
  if (!result.ok) {
    return <ErrorState message={result.message} onRetry={() => setReloads((n) => n + 1)} />;
  }
  const linkState: StorageUnitLinkState = {
    from: `?${new URLSearchParams({ projectId, status: 'all' }).toString()}`,
  };
  return (
    <>
      <StorageUnitTable items={result.data.items} linkState={linkState} showProject={false} />
      {result.data.total > result.data.items.length ? (
        <p className="field-hint">
          Showing {result.data.items.length} of {result.data.total}.{' '}
          <Link to={sampleStorageLink(projectId)}>See all in Sample Storage</Link>
        </p>
      ) : null}
    </>
  );
}
