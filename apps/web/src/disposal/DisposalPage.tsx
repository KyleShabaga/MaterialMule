import type { DisposalCandidate, DisposalCandidates, ProjectSummary } from '@materialmule/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { BandedCard, ConfirmDialog, EmptyState, PageHeader, StatusBadge } from '../components/ui';
import { formatExpiry } from '../lib/format';
import { ProjectFilter } from '../inventory/ProjectFilter';
import { approveUnits, fetchCandidates, revokeApproval } from './api';

/**
 * Disposal & Retention (MM-T30): pick a project, see each current unit's standard eligibility
 * and reasons, approve eligible units (single or batch) or revoke an approval with a reason.
 * Approval never disposes: approved units are scanned out in Disposal scan mode.
 */
export function DisposalPage() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('projectId') ?? undefined;
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [data, setData] = useState<DisposalCandidates | null>(null);
  const [tick, setTick] = useState(0);
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    void fetchCandidates(projectId).then((next) => {
      if (active) setData(next);
    });
    return () => {
      active = false;
    };
  }, [projectId, tick]);

  const reload = () => {
    setChosen([]);
    setTick((n) => n + 1);
  };
  const shown = projectId ? data : null;
  const eligible = shown?.units.filter((u) => u.eligible) ?? [];
  const approved = shown?.units.filter((u) => u.approval) ?? [];
  const others = shown?.units.filter((u) => !u.eligible && !u.approval) ?? [];
  const selected = eligible.filter((u) => chosen.includes(u.storageUnitId));

  async function approve() {
    setConfirming(false);
    const outcome = await approveUnits(
      selected.map((u) => u.storageUnitId),
      key,
    );
    setKey(crypto.randomUUID());
    setNotice(outcome.ok ? `${selected.length} approved for disposal.` : outcome.message);
    reload();
  }

  return (
    <div className="disposal-page">
      <PageHeader
        title="Disposal & Retention"
        actions={
          <Link className="button" to="/disposal-retention/scan">
            Disposal scan
          </Link>
        }
      />
      <p className="field-hint">
        Approving marks units for disposal; it doesn’t dispose them. Approved units are scanned out
        in Disposal scan mode, which checks holds and programs again at that moment. Tested Shelby
        tubes and bulk samples use “Confirm removal after testing” on their own page instead.
      </p>
      <ProjectFilter
        selected={project}
        selectedId={projectId}
        onSelect={(next) => {
          setProject(next);
          setData(null);
          setChosen([]);
          setParams(next ? { projectId: next.id } : {});
        }}
      />
      {notice ? <p role="status">{notice}</p> : null}
      {!projectId ? <EmptyState>Choose a project to see its units.</EmptyState> : null}
      {shown ? (
        <>
          <BandedCard
            title="Eligible for disposal"
            subtitle={`As of ${shown.asOf}: retain-until reached, no hold, every covering program closed.`}
          >
            {eligible.length === 0 ? (
              <EmptyState>No units are eligible.</EmptyState>
            ) : (
              <ul className="disposal-list">
                {eligible.map((unit) => (
                  <li key={unit.storageUnitId}>
                    <label>
                      {shown.canApprove ? (
                        <input
                          type="checkbox"
                          checked={chosen.includes(unit.storageUnitId)}
                          onChange={(event) =>
                            setChosen((list) =>
                              event.target.checked
                                ? [...list, unit.storageUnitId]
                                : list.filter((id) => id !== unit.storageUnitId),
                            )
                          }
                        />
                      ) : null}{' '}
                      <UnitLine unit={unit} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {shown.canApprove && eligible.length > 0 ? (
              <button
                type="button"
                className="primary"
                disabled={selected.length === 0}
                onClick={() => setConfirming(true)}
              >
                Approve {selected.length || ''} for disposal
              </button>
            ) : null}
          </BandedCard>
          <BandedCard title="Approved, waiting for the disposal scan">
            {approved.length === 0 ? (
              <EmptyState>None approved.</EmptyState>
            ) : (
              <ul className="disposal-list">
                {approved.map((unit) => (
                  <ApprovedRow
                    key={unit.storageUnitId}
                    unit={unit}
                    canRevoke={shown.canApprove}
                    onChanged={reload}
                  />
                ))}
              </ul>
            )}
          </BandedCard>
          <BandedCard title="Not eligible">
            {others.length === 0 ? (
              <EmptyState>None.</EmptyState>
            ) : (
              <ul className="disposal-list">
                {others.map((unit) => (
                  <li key={unit.storageUnitId}>
                    <UnitLine unit={unit} />
                    <span className="field-hint">
                      {' '}
                      {unit.blockers.map((b) => b.label).join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </BandedCard>
        </>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={`Approve ${selected.length} for disposal?`}
        confirmLabel="Approve"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void approve()}
      >
        <p>Each is eligible: retain-until reached, no hold, programs closed.</p>
        <ul>
          {selected.map((unit) => (
            <li key={unit.storageUnitId}>
              {unit.readableId} · retain until {unit.effectiveRetainUntil}
            </li>
          ))}
        </ul>
        <p>Approval doesn’t dispose anything; the units stay in stock until scanned out.</p>
      </ConfirmDialog>
    </div>
  );
}

function UnitLine({ unit }: { unit: DisposalCandidate }) {
  return (
    <>
      <Link to={`/sample-storage/${unit.readableId}`}>{unit.readableId}</Link> ·{' '}
      {unit.location.name} · retain until {unit.effectiveRetainUntil}
    </>
  );
}

function ApprovedRow({
  unit,
  canRevoke,
  onChanged,
}: {
  unit: DisposalCandidate;
  canRevoke: boolean;
  onChanged: () => void;
}) {
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const approval = unit.approval!;

  async function revoke(event: FormEvent) {
    event.preventDefault();
    const outcome = await revokeApproval(approval.id, reason, key);
    if (!outcome.ok) setError(outcome.message);
    onChanged();
  }

  return (
    <li aria-label={`Approved ${unit.readableId}`}>
      <StatusBadge tone="warning">Approved for disposal</StatusBadge> <UnitLine unit={unit} />
      <span className="field-hint">
        {' '}
        · approved by {approval.approvedBy.initials ?? approval.approvedBy.name} ·{' '}
        {formatExpiry(approval.approvedAt)}
        {unit.blockers.length > 0
          ? ` · Now blocked: ${unit.blockers.map((b) => b.label).join(' · ')}`
          : ''}
      </span>
      {canRevoke && !revoking ? (
        <button type="button" onClick={() => setRevoking(true)}>
          Revoke
        </button>
      ) : null}
      {revoking ? (
        <form aria-label="Revoke approval" onSubmit={(event) => void revoke(event)}>
          <label>
            Reason for revoking (required)
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={!reason.trim()}>
            Revoke approval
          </button>
        </form>
      ) : null}
    </li>
  );
}
