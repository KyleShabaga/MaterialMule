import {
  retentionSummary,
  type ProjectRetention,
  type StorageUnitRetention,
} from '@materialmule/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { UnitFact, UnitFacts, UnitSection } from '../inventory/UnitRecordParts';
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
 * Storage unit → Retention (MM-T29; Strata styles, STRATA-90): received date, minimum and
 * effective retain-until, active holds and extensions with reasons and who set them, history and
 * the tested-unit exception.
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
    <UnitSection
      id="retention"
      title="Retention"
      meta={
        r.retentionExempt ? (
          <Badge variant="outline">Not applicable</Badge>
        ) : r.onHold ? (
          <Badge variant="outline">On hold</Badge>
        ) : r.eligibleByDate ? (
          <Badge variant="outline">Eligible by date</Badge>
        ) : null
      }
    >
      <p className="text-sm font-semibold">{retentionSummary(r, unitType)}</p>
      {r.retentionExempt ? (
        <p className="text-muted-foreground text-[13px]">
          Completed testing is linked to this exact unit, so it is removed after testing instead of
          by retention. The holds and dates below stay as history; they don’t block that removal and
          still apply to other units.
        </p>
      ) : null}
      <UnitFacts wide>
        <UnitFact term="Received">
          <span className="font-mono">{r.receivedDate}</span>
        </UnitFact>
        <UnitFact term="Minimum retain-until">
          <span className="font-mono">{r.minimumRetainUntil}</span>
        </UnitFact>
        <UnitFact term="Effective retain-until">
          <span className="font-mono">{r.effectiveRetainUntil}</span>
        </UnitFact>
      </UnitFacts>
      <p className="text-muted-foreground text-[13px]">
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
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => setAdding(true)}
          >
            {data.canManage ? 'Add hold or extension' : 'Request hold or extension'}
          </Button>
        )
      ) : null}
    </UnitSection>
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
    <UnitSection
      id="retention"
      className="project-section gap-4 p-5 shadow-none"
      title="Retention"
      meta={`${data.counts.onHold} of ${data.counts.current} current units on hold`}
    >
      <RetentionHistory
        holds={data.holds}
        extensions={data.extensions}
        canManage={data.canManage}
        onChanged={changed}
      />
      {data.requests.length > 0 ? (
        <>
          <h3 className="text-sm font-semibold">Requests</h3>
          <ul className="flex flex-col divide-y">
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
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => setAdding(true)}
          >
            {data.canManage ? 'Add project hold or extension' : 'Request project hold or extension'}
          </Button>
        )
      ) : null}
    </UnitSection>
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
  const holdDate =
    request.kind === 'hold' && request.holdUntil ? ` until ${request.holdUntil}` : '';
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
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" aria-label={`${what} request`}>
      <p className="text-sm">
        <Badge variant="outline">
          {request.status === 'open'
            ? 'Requested'
            : request.status === 'approved'
              ? 'Approved'
              : 'Declined'}
        </Badge>{' '}
        <strong className="font-semibold">
          {what}
          {holdDate} for {scope}
        </strong>
        : {request.reason}
      </p>
      <p className="text-muted-foreground text-[13px]">
        Requested by {request.requestedBy.initials ?? request.requestedBy.name} ·{' '}
        {formatExpiry(request.requestedAt)}
        {request.decidedBy
          ? ` · ${request.status === 'approved' ? 'Approved' : 'Declined'} by ${request.decidedBy.initials ?? request.decidedBy.name}${request.decisionReason ? `: ${request.decisionReason}` : ''}`
          : ''}
      </p>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}
      {canDecide && request.status === 'open' ? (
        declining ? (
          <form
            aria-label="Decline"
            className="flex flex-col gap-3"
            onSubmit={(event) => void decide('decline', event)}
          >
            <Field>
              <FieldLabel htmlFor={`decline-${request.id}`}>
                Reason for declining (required)
              </FieldLabel>
              <Textarea
                id={`decline-${request.id}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <Button type="submit" size="sm" className="self-start" disabled={!reason.trim()}>
              Decline
            </Button>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDeclining(true)}>
              Decline…
            </Button>
            <Button type="button" size="sm" onClick={() => void decide('approve')}>
              Approve
            </Button>
          </div>
        )
      ) : null}
    </li>
  );
}
