import {
  retentionSummary,
  type ProjectRetention,
  type StorageUnitRetention,
} from '@materialmule/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BandedCard, StatusBadge } from '../components/ui';
import { formatExpiry } from '../lib/format';
import { fetchProjectRetention, fetchUnitRetention, postRetention } from './api';
import { RetentionForm, RetentionHistory } from './RetentionParts';

function useLoad<T>(load: () => Promise<T | null>) {
  const [data, setData] = useState<T | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let active = true;
    // A failed read (offline, unmounted mid-request) leaves the section hidden; never rejects.
    load()
      .catch(() => null)
      .then((next) => {
        if (active) setData(next);
      });
    return () => {
      active = false;
    };
  }, [load, tick]);
  return [data, reload] as const;
}

/**
 * Storage unit → Retention (MM-T29): received date, minimum and effective retain-until, active
 * holds and extensions with reasons and who set them, history and the tested-unit exception.
 */
export function UnitRetentionCard({
  unitId,
  unitType,
  disposed,
  onChanged,
}: {
  unitId: string;
  unitType: string;
  disposed: boolean;
  onChanged?: () => void;
}) {
  const load = useCallback(() => fetchUnitRetention(unitId), [unitId]);
  const [data, reload] = useLoad<StorageUnitRetention>(load);
  const [adding, setAdding] = useState(false);
  if (!data) return null;
  const r = data.retention;
  const changed = () => {
    setAdding(false);
    reload();
    onChanged?.();
  };
  return (
    <BandedCard
      id="retention"
      title="Retention"
      aside={
        r.retentionExempt ? (
          <StatusBadge tone="info">Not applicable</StatusBadge>
        ) : r.onHold ? (
          <StatusBadge tone="warning">On hold</StatusBadge>
        ) : r.eligibleByDate ? (
          <StatusBadge tone="neutral">Eligible by date</StatusBadge>
        ) : null
      }
    >
      <p className="retention-summary">{retentionSummary(r, unitType)}</p>
      {r.retentionExempt ? (
        <p className="field-hint">
          Completed testing is linked to this exact unit, so it is removed after testing instead of
          by retention. The holds and dates below stay as history; they don’t block that removal and
          still apply to other units.
        </p>
      ) : null}
      <dl className="details">
        <div>
          <dt>Received</dt>
          <dd className="nowrap">{r.receivedDate}</dd>
        </div>
        <div>
          <dt>Minimum retain-until</dt>
          <dd className="nowrap">{r.minimumRetainUntil}</dd>
        </div>
        <div>
          <dt>Effective retain-until</dt>
          <dd className="nowrap">{r.effectiveRetainUntil}</dd>
        </div>
      </dl>
      <p className="field-hint">
        Received date + 1 year, or later with an extension. Eligible by date on that day itself.
      </p>
      <RetentionHistory
        holds={data.holds}
        extensions={data.extensions}
        canManage={data.canManage}
        onChanged={changed}
      />
      {!disposed && (data.canManage || data.canRequest) ? (
        adding ? (
          <RetentionForm
            projectId={data.projectId}
            unitIds={[unitId]}
            mode={data.canManage ? 'manage' : 'request'}
            onDone={changed}
          />
        ) : (
          <button type="button" onClick={() => setAdding(true)}>
            {data.canManage ? 'Add hold or extension' : 'Request hold or extension'}
          </button>
        )
      ) : null}
    </BandedCard>
  );
}

/** Project → Retention (MM-T29): project-wide holds/extensions, requests and decisions. */
export function ProjectRetentionSection({
  projectId,
  onChanged,
}: {
  projectId: string;
  /** Called after a hold, extension or request changes, so the page can refresh what it shows. */
  onChanged?: () => void;
}) {
  const load = useCallback(() => fetchProjectRetention(projectId), [projectId]);
  const [data, reload] = useLoad<ProjectRetention>(load);
  const [adding, setAdding] = useState(false);
  if (!data) return null;
  const changed = () => {
    setAdding(false);
    reload();
    onChanged?.();
  };
  return (
    <BandedCard
      id="retention"
      className="project-section"
      title="Retention"
      aside={
        <span className="field-hint">
          {data.counts.onHold} of {data.counts.current} current units on hold
        </span>
      }
    >
      <RetentionHistory
        holds={data.holds}
        extensions={data.extensions}
        canManage={data.canManage}
        onChanged={changed}
      />
      {data.requests.length > 0 ? (
        <>
          <h3>Requests</h3>
          <ul className="retention-history">
            {data.requests.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                canDecide={data.canManage}
                onChanged={changed}
              />
            ))}
          </ul>
        </>
      ) : null}
      {data.canManage || data.canRequest ? (
        adding ? (
          <RetentionForm
            projectId={projectId}
            mode={data.canManage ? 'manage' : 'request'}
            onDone={changed}
          />
        ) : (
          <button type="button" onClick={() => setAdding(true)}>
            {data.canManage ? 'Add project hold or extension' : 'Request project hold or extension'}
          </button>
        )
      ) : null}
    </BandedCard>
  );
}

function RequestRow({
  request,
  canDecide,
  onChanged,
}: {
  request: ProjectRetention['requests'][number];
  canDecide: boolean;
  onChanged: () => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const what =
    request.kind === 'hold'
      ? 'Hold'
      : `Extension ${request.retainUntil ? `to ${request.retainUntil}` : `+${request.extendMonths} months`}`;
  const scope =
    request.scope === 'project'
      ? 'whole project'
      : request.units.map((unit) => unit.readableId).join(', ');

  async function decide(decision: 'approve' | 'decline', event?: FormEvent) {
    event?.preventDefault();
    const outcome = await postRetention(`/api/retention/requests/${request.id}/${decision}`, {
      ...(decision === 'decline' ? { reason } : {}),
      idempotencyKey: key,
    });
    if (!outcome.ok) setError(outcome.message);
    onChanged();
  }

  return (
    <li className="retention-item" aria-label={`${what} request`}>
      <p>
        <StatusBadge tone={request.status === 'open' ? 'warning' : 'neutral'}>
          {request.status === 'open'
            ? 'Requested'
            : request.status === 'approved'
              ? 'Approved'
              : 'Declined'}
        </StatusBadge>{' '}
        <strong>
          {what} for {scope}
        </strong>
        : {request.reason}
      </p>
      <p className="field-hint">
        Requested by {request.requestedBy.initials ?? request.requestedBy.name} ·{' '}
        {formatExpiry(request.requestedAt)}
        {request.decidedBy
          ? ` · ${request.status === 'approved' ? 'Approved' : 'Declined'} by ${request.decidedBy.initials ?? request.decidedBy.name}${request.decisionReason ? `: ${request.decisionReason}` : ''}`
          : ''}
      </p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {canDecide && request.status === 'open' ? (
        declining ? (
          <form aria-label="Decline" onSubmit={(event) => void decide('decline', event)}>
            <label>
              Reason for declining (required)
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <button type="submit" disabled={!reason.trim()}>
              Decline
            </button>
          </form>
        ) : (
          <div className="dialog-actions">
            <button type="button" onClick={() => setDeclining(true)}>
              Decline…
            </button>
            <button type="button" className="primary" onClick={() => void decide('approve')}>
              Approve
            </button>
          </div>
        )
      ) : null}
    </li>
  );
}
