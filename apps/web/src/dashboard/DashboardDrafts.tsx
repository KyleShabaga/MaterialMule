import { Link } from 'react-router';
import { EmptyState, StatusBadge } from '../components/ui';
import { formatUnitCount } from '../receiving/draft';
import { receiverText } from '../receiving/drafts/format';
import { isStale, type StoredDraft } from '../receiving/drafts/record';
import { resumeDraftPath, type DraftsState } from './drafts';
import { shortDateTime } from './format';

// "Drafts on this computer" on the dashboard: the newest few, each with Resume.

const SHOWN = 3;

export function DraftsCard({ drafts }: { drafts: DraftsState }) {
  return (
    <section className="dash-panel" aria-labelledby="dash-drafts">
      <div className="dash-head">
        <h2 id="dash-drafts">Drafts on this computer</h2>
      </div>
      <div className="dash-body">
        {drafts.state === 'loading' ? (
          <p aria-busy="true" className="muted">
            Loading drafts on this computer…
          </p>
        ) : drafts.state === 'error' ? (
          <p className="field-error">
            Drafts on this computer couldn&apos;t load. {drafts.message}
          </p>
        ) : drafts.drafts.length === 0 ? (
          <EmptyState>No drafts on this computer.</EmptyState>
        ) : (
          <>
            <ul className="dash-drafts">
              {drafts.drafts.slice(0, SHOWN).map((record) => (
                <DraftRow key={record.draftId} record={record} />
              ))}
            </ul>
            {drafts.drafts.length > SHOWN ? (
              <p className="dash-more">
                <Link to="/receiving-log/new">
                  All {drafts.drafts.length} drafts in Receive samples →
                </Link>
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function DraftRow({ record }: { record: StoredDraft }) {
  const project = record.data.project;
  const title = project ? `${project.projectNumber} · ${project.name}` : 'No project chosen yet';
  const stale = isStale(record);
  return (
    <li>
      <span className="dash-draft-title">
        {project ? (
          <>
            <span className="dash-project">{project.projectNumber}</span> · {project.name}
          </>
        ) : (
          <em className="muted">No project chosen yet</em>
        )}
      </span>
      <span className="dash-draft-facts muted">
        {record.status === 'confirming' ? (
          <StatusBadge tone="warning">Confirmation interrupted</StatusBadge>
        ) : null}
        {stale ? <StatusBadge tone="warning">Stale</StatusBadge> : null}
        {formatUnitCount(record.data.units.length)} · {receiverText(record.receiver)} · Last saved{' '}
        {shortDateTime(record.lastSavedAt)}
      </span>
      <Link className="button" to={resumeDraftPath(record)} aria-label={`Resume draft ${title}`}>
        Resume
      </Link>
    </li>
  );
}
