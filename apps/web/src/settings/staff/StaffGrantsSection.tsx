import {
  POSITIONS,
  POSITION_LABELS,
  STAFF_CAPABILITIES,
  STAFF_CAPABILITY_LABEL,
  formatPerson,
  type AccessSummary,
  type Position,
  type PositionRule,
  type PositionRules,
  type ReviewScope,
  type StaffCapability,
  type StaffGrants,
  type StaffMember,
} from '@materialmule/shared';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ConfirmDialog, EmptyState, ErrorState } from '../../components/ui';
import { shortDateTime } from '../../dashboard/format';
import { AccessSummaryView } from '../access/AccessSummaryView';
import {
  fetchPositionRules,
  fetchReviewScopes,
  fetchStaffAccess,
  fetchStaffGrants,
  grantsApi,
  rulesApi,
} from '../access/api';
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

type Ending = { kind: 'eligibility' | 'capability' | 'exclusion'; id: string; label: string };

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
  const [excludeScope, setExcludeScope] = useState('');
  const [excludeReason, setExcludeReason] = useState('');
  const [keys, setKeys] = useState(() => ({
    scope: crypto.randomUUID(),
    capability: crypto.randomUUID(),
    exclusion: crypto.randomUUID(),
  }));
  const excludeId = useId();
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
          {/* MISC-08: effective eligibility per scope, with each source and any exclusion. */}
          <ul className="access-list" aria-label="Effective review eligibility">
            {grants.effectiveEligibility.map((e) => (
              <li key={e.scope.code}>
                <strong>
                  {e.scope.label}: {e.eligible ? 'Eligible to review' : 'Not eligible'}
                </strong>{' '}
                <span className="field-hint">
                  {[
                    e.individualGrant ? 'individual grant' : null,
                    e.positionRule ? 'position rule' : null,
                    e.excluded ? 'excluded' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'no source'}
                </span>
              </li>
            ))}
          </ul>
          {grants.exclusions.active.length > 0 ? (
            <ul className="access-list" aria-label="Exclusions">
              {grants.exclusions.active.map((x) => {
                const label = `Excluded from ${x.scope ? x.scope.label : 'all review scopes'}`;
                return (
                  <li key={x.id}>
                    <strong>{label}</strong>{' '}
                    <span className="field-hint">
                      by {formatPerson(x.startedBy.initials, x.startedBy.name)},{' '}
                      {shortDateTime(x.startedAt)}
                      {x.startReason ? ` (${x.startReason})` : ''}
                    </span>{' '}
                    {grants.canManage ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEndReason('');
                          setEndError(null);
                          setEnding({ kind: 'exclusion', id: x.id, label });
                        }}
                      >
                        Remove exclusion ({x.scope ? x.scope.label : 'all scopes'})
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
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
              <form
                className="delegate-add"
                aria-label="Exclude from review"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!excludeScope || !excludeReason.trim()) return;
                  const scopeCode = excludeScope === '*' ? null : excludeScope;
                  const ok = await run(
                    () =>
                      grantsApi.addExclusion(member.id, scopeCode, excludeReason, keys.exclusion),
                    `${member.displayName} is excluded from ${
                      scopeCode
                        ? (scopes.find((s) => s.code === scopeCode)?.label ?? scopeCode)
                        : 'all review scopes'
                    }.`,
                  );
                  setKeys((k) => ({ ...k, exclusion: crypto.randomUUID() }));
                  if (ok) {
                    setExcludeScope('');
                    setExcludeReason('');
                  }
                }}
              >
                <div className="form-field">
                  <label htmlFor={excludeId}>Exclude from review</label>
                  <select
                    id={excludeId}
                    value={excludeScope}
                    onChange={(e) => setExcludeScope(e.target.value)}
                  >
                    <option value="">Choose a scope</option>
                    <option value="*">All review scopes</option>
                    {scopes.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint">
                    Overrides position rules and individual grants. Ends their review approvals in
                    that scope.
                  </p>
                </div>
                <ReasonInput value={excludeReason} onChange={setExcludeReason} />
                <button type="submit" disabled={busy || !excludeScope || !excludeReason.trim()}>
                  Exclude
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
        title={
          ending?.kind === 'exclusion'
            ? `Remove: ${ending.label}?`
            : `Revoke ${ending?.label ?? ''}?`
        }
        confirmLabel={ending?.kind === 'exclusion' ? 'Remove' : 'Revoke'}
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
                : target.kind === 'exclusion'
                  ? grantsApi.removeExclusion(member.id, target.id, endReason)
                  : grantsApi.revokeEligibility(member.id, target.id, endReason),
            target.kind === 'exclusion'
              ? `${target.label}: removed for ${member.displayName}.`
              : `${target.label} revoked for ${member.displayName}.`,
          );
        }}
        onCancel={() => setEnding(null)}
      >
        <p>
          {ending?.kind === 'exclusion'
            ? 'Eligibility is recalculated. Project review approvals that ended stay ended: the lead approves again.'
            : 'It stops counting on their next request. Earlier work keeps their name.'}
        </p>
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

// ---------------------------------------------------------------------------------------------
// Position-based review eligibility (MISC-08): no position is eligible until a rule says so
// ---------------------------------------------------------------------------------------------

export function PositionRulesSection({ onForbidden }: { onForbidden: () => void }) {
  const [rules, setRules] = useState<PositionRules | null>(null);
  const [scopes, setScopes] = useState<ReviewScope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<Position | ''>('');
  const [scope, setScope] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [disabling, setDisabling] = useState<PositionRule | null>(null);
  const [disableReason, setDisableReason] = useState('');
  const [busy, setBusy] = useState(false);
  const positionId = useId();
  const scopeId = useId();
  const disableId = useId();
  const onForbiddenRef = useRef(onForbidden);
  useEffect(() => {
    onForbiddenRef.current = onForbidden;
  });
  const load = useCallback(() => {
    Promise.all([fetchPositionRules(), fetchReviewScopes()]).then(
      ([loaded, loadedScopes]) => {
        setRules(loaded);
        setScopes(loadedScopes);
        setError(null);
      },
      (caught: unknown) => {
        if (forbidden(caught)) onForbiddenRef.current();
        else setError(message(caught));
      },
    );
  }, []);
  useEffect(load, [load]);

  async function run(action: () => Promise<PositionRules>): Promise<boolean> {
    setBusy(true);
    try {
      setRules(await action());
      setError(null);
      return true;
    } catch (caught) {
      if (forbidden(caught)) onForbidden();
      else setError(message(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="drawer-section" aria-label="Review eligibility by position">
      <h2>Review eligibility by position</h2>
      <p className="field-hint">
        No position is eligible to review until you enable it for a scope. A rule covers everyone
        with that position now and later. Each change needs a reason.
      </p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {!rules ? (
        error ? null : (
          <p role="status">Loading…</p>
        )
      ) : rules.active.length === 0 ? (
        <EmptyState>No position is eligible to review.</EmptyState>
      ) : (
        <ul className="access-list" aria-label="Position rules">
          {rules.active.map((rule) => (
            <li key={rule.id}>
              <strong>
                {POSITION_LABELS[rule.position]}: {rule.scope.label}
              </strong>{' '}
              <span className="field-hint">
                by {formatPerson(rule.startedBy.initials, rule.startedBy.name)},{' '}
                {shortDateTime(rule.startedAt)} ({rule.startReason})
              </span>{' '}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDisableReason('');
                  setDisabling(rule);
                }}
              >
                Disable {POSITION_LABELS[rule.position]} ({rule.scope.label})
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="delegate-add"
        aria-label="Enable a position rule"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!position || !scope || !reason.trim()) return;
          const ok = await run(() => rulesApi.enable(position, scope, reason, key));
          setKey(crypto.randomUUID());
          if (ok) {
            setPosition('');
            setScope('');
            setReason('');
          }
        }}
      >
        <div className="form-field">
          <label htmlFor={positionId}>Position</label>
          <select
            id={positionId}
            value={position}
            onChange={(e) => setPosition(e.target.value as Position | '')}
          >
            <option value="">Choose a position</option>
            {POSITIONS.map((p) => (
              <option key={p} value={p}>
                {POSITION_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor={scopeId}>Review scope</label>
          <select id={scopeId} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">Choose a scope</option>
            {scopes.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <ReasonInput value={reason} onChange={setReason} />
        <button type="submit" disabled={busy || !position || !scope || !reason.trim()}>
          Enable rule
        </button>
      </form>
      {rules && rules.history.length > 0 ? (
        <details className="delegate-history">
          <summary>Rule history ({rules.history.length})</summary>
          <ul className="delegate-list">
            {rules.history.map((rule) => (
              <li key={rule.id}>
                {POSITION_LABELS[rule.position]}: {rule.scope.label}; enabled{' '}
                {shortDateTime(rule.startedAt)}, disabled by{' '}
                {rule.endedBy ? formatPerson(rule.endedBy.initials, rule.endedBy.name) : ''}{' '}
                {rule.endedAt ? shortDateTime(rule.endedAt) : ''}
                {rule.endReason ? ` (${rule.endReason})` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <ConfirmDialog
        open={disabling !== null}
        title={`Disable ${disabling ? POSITION_LABELS[disabling.position] : ''} for ${disabling?.scope.label ?? ''}?`}
        confirmLabel="Disable"
        danger
        onConfirm={async () => {
          const rule = disabling;
          if (!rule || !disableReason.trim()) return;
          setDisabling(null);
          await run(() => rulesApi.disable(rule.id, disableReason));
        }}
        onCancel={() => setDisabling(null)}
      >
        <p>
          People left with no other source lose eligibility; their review approvals in this scope
          end and their leads are asked to reassign.
        </p>
        <label htmlFor={disableId}>Reason</label>
        <textarea
          id={disableId}
          value={disableReason}
          maxLength={2000}
          onChange={(event) => setDisableReason(event.target.value)}
        />
      </ConfirmDialog>
    </section>
  );
}
