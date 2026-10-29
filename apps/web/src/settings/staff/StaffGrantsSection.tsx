import {
  STAFF_CAPABILITIES,
  STAFF_CAPABILITY_LABEL,
  formatPerson,
  type AccessSummary,
  type ReviewScope,
  type StaffCapability,
  type StaffGrants,
  type StaffMember,
} from '@materialmule/shared';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ConfirmDialog, EmptyState, ErrorState } from '../../components/ui';
import { shortDateTime } from '../../dashboard/format';
import { AccessSummaryView } from '../access/AccessSummaryView';
import { fetchReviewScopes, fetchStaffAccess, fetchStaffGrants, grantsApi } from '../access/api';
import { StaffApiError, staffApi } from './api';

// The Staff drawer's MM-AO06 parts: the job-title override (D16), reviewer eligibility (D05) and
// "Can create and lead projects" (D01), and a read-only summary of the person's current access.
// Every change needs a reason and is confirmed by the server before it shows. A 403 means the
// admin lost staff management; the drawer's `onForbidden` takes over.

const message = (error: unknown) =>
  error instanceof StaffApiError ? error.message : 'Something went wrong. Try again.';
const forbidden = (error: unknown) => error instanceof StaffApiError && error.forbidden;

function ReasonInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="form-field">
      <label htmlFor={id}>Reason</label>
      <textarea
        id={id}
        rows={2}
        maxLength={2000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Job title (D16): Microsoft's, and an administrator's override with a reason
// ---------------------------------------------------------------------------------------------

export function JobTitleSection({
  member,
  onChanged,
  onForbidden,
}: {
  member: StaffMember;
  onChanged: (member: StaffMember, message: string) => void;
  onForbidden: () => void;
}) {
  const [title, setTitle] = useState(member.jobTitleOverride ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  async function save(value: string | null) {
    if (!reason.trim()) {
      setError('Enter a reason.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await staffApi.setJobTitleOverride(member.id, value, reason);
      setReason('');
      setTitle(saved.jobTitleOverride ?? '');
      onChanged(
        saved,
        value === null
          ? `Job title override cleared for ${member.displayName}.`
          : `Job title for ${member.displayName} set to ${value.trim()}.`,
      );
    } catch (caught) {
      if (forbidden(caught)) onForbidden();
      else setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  if (member.accountType === 'shared_lab') return null;
  return (
    <form
      className="drawer-section"
      aria-label="Job title"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (title.trim()) void save(title);
        else setError('Enter a job title, or clear the override.');
      }}
    >
      <h3>Job title</h3>
      <dl className="details">
        <dt>From Microsoft</dt>
        <dd>{member.jobTitle ?? 'Not set'}</dd>
        <dt>Override</dt>
        <dd>
          {member.jobTitleOverride
            ? `${member.jobTitleOverride} (set by ${member.jobTitleOverrideSetBy ?? 'an administrator'}, ${
                member.jobTitleOverrideSetAt ? shortDateTime(member.jobTitleOverrideSetAt) : ''
              })`
            : 'None'}
        </dd>
      </dl>
      <div className="form-field">
        <label htmlFor={titleId}>Firm job title</label>
        <input
          id={titleId}
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
        />
        <p className="field-hint">
          Shown instead of Microsoft’s title. It describes the work; it grants nothing.
        </p>
      </div>
      <ReasonInput value={reason} onChange={setReason} />
      {error ? <p className="field-error">{error}</p> : null}
      <div className="page-actions">
        <button type="submit" disabled={busy}>
          Save job title
        </button>
        {member.jobTitleOverride ? (
          <button type="button" disabled={busy} onClick={() => void save(null)}>
            Clear override
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Reviewer eligibility and staff capabilities
// ---------------------------------------------------------------------------------------------

type Ending = { kind: 'eligibility' | 'capability'; id: string; label: string };

export function StaffGrantsSection({
  member,
  onForbidden,
}: {
  member: StaffMember;
  onForbidden: () => void;
}) {
  const [grants, setGrants] = useState<StaffGrants | null>(null);
  const [scopes, setScopes] = useState<ReviewScope[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [scope, setScope] = useState('');
  const [scopeReason, setScopeReason] = useState('');
  const [capability, setCapability] = useState<StaffCapability | ''>('');
  const [capabilityReason, setCapabilityReason] = useState('');
  const [keys, setKeys] = useState(() => ({
    scope: crypto.randomUUID(),
    capability: crypto.randomUUID(),
  }));
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState<Ending | null>(null);
  const [endReason, setEndReason] = useState('');
  const [endError, setEndError] = useState<string | null>(null);
  const scopeId = useId();
  const capabilityId = useId();
  const endReasonId = useId();
  // The drawer's handler may change identity on every render; loading mustn't re-run for that.
  const onForbiddenRef = useRef(onForbidden);
  useEffect(() => {
    onForbiddenRef.current = onForbidden;
  });

  const load = useCallback(() => {
    Promise.all([fetchStaffGrants(member.id), fetchReviewScopes()]).then(
      ([loaded, loadedScopes]) => {
        setGrants(loaded);
        setScopes(loadedScopes);
        setLoadError(null);
      },
      (error: unknown) => {
        if (forbidden(error)) onForbiddenRef.current();
        else setLoadError(message(error));
      },
    );
  }, [member.id]);
  useEffect(load, [load]);

  async function run(action: () => Promise<StaffGrants>, success: string): Promise<boolean> {
    setBusy(true);
    try {
      setGrants(await action());
      setNotice({ tone: 'success', text: success });
      return true;
    } catch (caught) {
      if (forbidden(caught)) {
        onForbidden();
      } else {
        setNotice({ tone: 'warning', text: message(caught) });
        load();
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (member.accountType === 'shared_lab') return null;
  const canGrant = member.status === 'active' && Boolean(grants?.canManage);
  const heldCapabilities = new Set(grants?.capabilities.active.map((g) => g.capability));
  const heldScopes = new Set(grants?.reviewerEligibility.active.map((g) => g.scope.code));

  return (
    <div className="drawer-section" role="group" aria-label="Eligibility and capabilities">
      <h3>Eligibility and capabilities</h3>
      <p className="field-hint">
        Granted to the person, not by their title or position. Each grant and revocation needs a
        reason.
      </p>
      {loadError ? <ErrorState message={loadError} onRetry={load} /> : null}
      {notice ? (
        <p className={`notice notice-${notice.tone}`} role="status">
          {notice.text}
        </p>
      ) : null}
      {!grants ? (
        loadError ? null : (
          <p role="status">Loading…</p>
        )
      ) : (
        <>
          {grants.capabilities.active.length + grants.reviewerEligibility.active.length === 0 ? (
            <EmptyState>No reviewer eligibility or capabilities.</EmptyState>
          ) : (
            <ul className="access-list" aria-label="Current grants">
              {grants.capabilities.active.map((grant) => (
                <li key={grant.id}>
                  <strong>{STAFF_CAPABILITY_LABEL[grant.capability]}</strong>{' '}
                  <span className="field-hint">
                    by {formatPerson(grant.startedBy.initials, grant.startedBy.name)},{' '}
                    {shortDateTime(grant.startedAt)}
                    {grant.startReason ? ` (${grant.startReason})` : ''}
                  </span>{' '}
                  {grants.canManage ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEndReason('');
                        setEndError(null);
                        setEnding({
                          kind: 'capability',
                          id: grant.id,
                          label: STAFF_CAPABILITY_LABEL[grant.capability],
                        });
                      }}
                    >
                      Revoke {STAFF_CAPABILITY_LABEL[grant.capability]}
                    </button>
                  ) : null}
                </li>
              ))}
              {grants.reviewerEligibility.active.map((grant) => (
                <li key={grant.id}>
                  <strong>Eligible reviewer: {grant.scope.label}</strong>{' '}
                  <span className="field-hint">
                    by {formatPerson(grant.startedBy.initials, grant.startedBy.name)},{' '}
                    {shortDateTime(grant.startedAt)}
                    {grant.startReason ? ` (${grant.startReason})` : ''}
                  </span>{' '}
                  {grants.canManage ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEndReason('');
                        setEndError(null);
                        setEnding({
                          kind: 'eligibility',
                          id: grant.id,
                          label: `Eligible reviewer: ${grant.scope.label}`,
                        });
                      }}
                    >
                      Revoke {grant.scope.label} eligibility
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {canGrant ? (
            <>
              <form
                className="delegate-add"
                aria-label="Grant reviewer eligibility"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!scope || !scopeReason.trim()) return;
                  const label = scopes.find((s) => s.code === scope)?.label ?? scope;
                  const ok = await run(
                    () => grantsApi.grantEligibility(member.id, scope, scopeReason, keys.scope),
                    `${member.displayName} is now an eligible ${label} reviewer.`,
                  );
                  setKeys((k) => ({ ...k, scope: crypto.randomUUID() }));
                  if (ok) {
                    setScope('');
                    setScopeReason('');
                  }
                }}
              >
                <div className="form-field">
                  <label htmlFor={scopeId}>Reviewer eligibility</label>
                  <select id={scopeId} value={scope} onChange={(e) => setScope(e.target.value)}>
                    <option value="">Choose a scope</option>
                    {scopes
                      .filter((s) => !heldScopes.has(s.code))
                      .map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.label}
                        </option>
                      ))}
                  </select>
                </div>
                <ReasonInput value={scopeReason} onChange={setScopeReason} />
                <button type="submit" disabled={busy || !scope || !scopeReason.trim()}>
                  Grant eligibility
                </button>
              </form>
              {STAFF_CAPABILITIES.some((c) => !heldCapabilities.has(c)) ? (
                <form
                  className="delegate-add"
                  aria-label="Grant capability"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (!capability || !capabilityReason.trim()) return;
                    const ok = await run(
                      () =>
                        grantsApi.grantCapability(
                          member.id,
                          capability,
                          capabilityReason,
                          keys.capability,
                        ),
                      `${member.displayName}: ${STAFF_CAPABILITY_LABEL[capability]} granted.`,
                    );
                    setKeys((k) => ({ ...k, capability: crypto.randomUUID() }));
                    if (ok) {
                      setCapability('');
                      setCapabilityReason('');
                    }
                  }}
                >
                  <div className="form-field">
                    <label htmlFor={capabilityId}>Capability</label>
                    <select
                      id={capabilityId}
                      value={capability}
                      onChange={(e) => setCapability(e.target.value as StaffCapability | '')}
                    >
                      <option value="">Choose a capability</option>
                      {STAFF_CAPABILITIES.filter((c) => !heldCapabilities.has(c)).map((c) => (
                        <option key={c} value={c}>
                          {STAFF_CAPABILITY_LABEL[c]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <ReasonInput value={capabilityReason} onChange={setCapabilityReason} />
                  <button type="submit" disabled={busy || !capability || !capabilityReason.trim()}>
                    Grant capability
                  </button>
                </form>
              ) : null}
            </>
          ) : grants.canManage ? (
            <p className="field-hint">Grants can be added once the account is active.</p>
          ) : null}

          {grants.capabilities.history.length + grants.reviewerEligibility.history.length > 0 ? (
            <details className="delegate-history">
              <summary>
                Grant history (
                {grants.capabilities.history.length + grants.reviewerEligibility.history.length})
              </summary>
              <ul className="delegate-list">
                {[
                  ...grants.capabilities.history.map((g) => ({
                    ...g,
                    label: STAFF_CAPABILITY_LABEL[g.capability],
                  })),
                  ...grants.reviewerEligibility.history.map((g) => ({
                    ...g,
                    label: `Eligible reviewer: ${g.scope.label}`,
                  })),
                ].map((g) => (
                  <li key={g.id}>
                    {g.label}: granted by {formatPerson(g.startedBy.initials, g.startedBy.name)},{' '}
                    {shortDateTime(g.startedAt)}; revoked by{' '}
                    {g.endedBy ? formatPerson(g.endedBy.initials, g.endedBy.name) : ''},{' '}
                    {g.endedAt ? shortDateTime(g.endedAt) : ''}
                    {g.endReason ? ` (${g.endReason})` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
      <ConfirmDialog
        open={ending !== null}
        title={`Revoke ${ending?.label ?? ''}?`}
        confirmLabel="Revoke"
        danger
        onConfirm={async () => {
          if (!ending) return;
          if (!endReason.trim()) {
            setEndError('Enter a reason.');
            return;
          }
          const target = ending;
          setEnding(null);
          await run(
            () =>
              target.kind === 'capability'
                ? grantsApi.revokeCapability(member.id, target.id, endReason)
                : grantsApi.revokeEligibility(member.id, target.id, endReason),
            `${target.label} revoked for ${member.displayName}.`,
          );
        }}
        onCancel={() => setEnding(null)}
      >
        <p>It stops counting on their next request. Earlier work keeps their name.</p>
        <label htmlFor={endReasonId}>Reason</label>
        <textarea
          id={endReasonId}
          value={endReason}
          maxLength={2000}
          aria-invalid={Boolean(endError)}
          onChange={(event) => setEndReason(event.target.value)}
        />
        {endError ? <p className="field-error">{endError}</p> : null}
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Read-only: the person's current access (admin view)
// ---------------------------------------------------------------------------------------------

export function StaffAccessSummary({ member }: { member: StaffMember }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    fetchStaffAccess(member.id).then(
      (loaded) => current && setSummary(loaded),
      (caught: unknown) => current && setError(message(caught)),
    );
    return () => {
      current = false;
    };
  }, [open, member.id]);
  if (member.accountType === 'shared_lab') return null;
  return (
    <details
      className="drawer-section"
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>Current access</summary>
      {error ? <ErrorState message={error} /> : null}
      {!summary && !error && open ? <p role="status">Loading…</p> : null}
      {summary ? <AccessSummaryView summary={summary} headingLevel={3} /> : null}
    </details>
  );
}
