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
import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { notifySuccess } from '../../components/strata/toast';
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
import {
  ConfirmReasonDialog,
  ErrorAlert,
  LabelledSelect,
  ReasonField,
  SectionTitle,
  TOUCH,
} from './staff-ui';

// The Staff drawer's MM-AO06 parts: the job-title override (D16), reviewer eligibility (D05) and
// "Can create and lead projects" (D01), and a read-only summary of the person's current access.
// Every change needs a reason and is confirmed by the server before it shows. A 403 means the
// viewer lost staff management; the drawer's `onForbidden` takes over.

const message = (error: unknown) =>
  error instanceof StaffApiError ? error.message : 'Something went wrong. Try again.';
const forbidden = (error: unknown) => error instanceof StaffApiError && error.forbidden;

const by = (person: { initials: string | null; name: string | null }, at: string) =>
  `by ${formatPerson(person.initials, person.name)}, ${shortDateTime(at)}`;

/** One held grant, rule or exclusion: what, who and when, and its end action. */
function GrantRow({
  label,
  meta,
  action,
}: {
  label: string;
  meta: string;
  action?: { label: string; onClick: () => void; disabled: boolean };
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <span className="min-w-0 flex-1">
        <strong className="font-medium">{label}</strong>{' '}
        <span className="text-sm text-muted-foreground">{meta}</span>
      </span>
      {action ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={TOUCH}
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ) : null}
    </li>
  );
}

/** A collapsed history list ("Grant history (3)"). */
function History({ title, items }: { title: string; items: { key: string; text: string }[] }) {
  if (items.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={`group -ml-2 ${TOUCH}`}>
          <ChevronRight
            aria-hidden="true"
            className="transition-transform group-data-[state=open]:rotate-90"
          />
          {title} ({items.length})
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="grid gap-1 pl-6 text-sm text-muted-foreground">
          {items.map((item) => (
            <li key={item.key}>{item.text}</li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------------------------
// Job title (D16): Microsoft's, and an override with a reason
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
  const headingId = useId();

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
      className="grid gap-3"
      aria-label="Job title"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (title.trim()) void save(title);
        else setError('Enter a job title, or clear the override.');
      }}
    >
      <SectionTitle id={headingId}>Job title</SectionTitle>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">From Microsoft</dt>
        <dd>{member.jobTitle ?? 'Not set'}</dd>
        <dt className="text-muted-foreground">Override</dt>
        <dd>
          {member.jobTitleOverride
            ? `${member.jobTitleOverride} (set by ${member.jobTitleOverrideSetBy ?? 'an administrator'}${
                member.jobTitleOverrideSetAt
                  ? `, ${shortDateTime(member.jobTitleOverrideSetAt)}`
                  : ''
              })`
            : 'None'}
        </dd>
      </dl>
      <Field>
        <FieldLabel htmlFor={titleId}>Firm job title</FieldLabel>
        <Input
          id={titleId}
          value={title}
          maxLength={200}
          className={TOUCH}
          onChange={(event) => setTitle(event.target.value)}
        />
        <FieldDescription>
          Shown instead of Microsoft’s title. It describes the work; it grants nothing.
        </FieldDescription>
      </Field>
      <ReasonField value={reason} onChange={setReason} />
      {error ? <FieldError>{error}</FieldError> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="outline" className={TOUCH} disabled={busy}>
          Save job title
        </Button>
        {member.jobTitleOverride ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={TOUCH}
            disabled={busy}
            onClick={() => void save(null)}
          >
            Clear override
          </Button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Reviewer eligibility and staff capabilities
// ---------------------------------------------------------------------------------------------

type Ending = { kind: 'eligibility' | 'capability' | 'exclusion'; id: string; label: string };

/** A small "choose, give a reason, submit" form for one kind of grant. */
function GrantForm({
  name,
  selectLabel,
  value,
  onValueChange,
  options,
  placeholder,
  description,
  reason,
  onReasonChange,
  submitLabel,
  busy,
  onSubmit,
}: {
  name: string;
  selectLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  description?: string;
  reason: string;
  onReasonChange: (value: string) => void;
  submitLabel: string;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <form
      aria-label={name}
      className="grid gap-3 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (value && reason.trim()) onSubmit();
      }}
    >
      <LabelledSelect
        label={selectLabel}
        value={value}
        onValueChange={onValueChange}
        options={options}
        placeholder={placeholder}
        description={description}
      />
      <ReasonField value={reason} onChange={onReasonChange} />
      <div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className={TOUCH}
          disabled={busy || !value || !reason.trim()}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

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
  const [warning, setWarning] = useState<string | null>(null);
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
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState<Ending | null>(null);
  const headingId = useId();
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
      setWarning(null);
      notifySuccess(success);
      return true;
    } catch (caught) {
      if (forbidden(caught)) {
        onForbidden();
      } else {
        setWarning(message(caught));
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
  const scopeLabel = (code: string) => scopes.find((s) => s.code === code)?.label ?? code;
  const endAction = (target: Ending, label: string) =>
    grants?.canManage ? { label, disabled: busy, onClick: () => setEnding(target) } : undefined;

  return (
    <div className="grid gap-3" role="group" aria-labelledby={headingId}>
      <SectionTitle id={headingId}>Eligibility and capabilities</SectionTitle>
      <p className="text-sm text-muted-foreground">
        Granted to the person, not by their title or position. Each grant and revocation needs a
        reason.
      </p>
      {loadError ? <ErrorAlert title={loadError} onRetry={load} /> : null}
      {warning ? (
        <Alert role="status">
          <AlertTitle className="line-clamp-none">{warning}</AlertTitle>
        </Alert>
      ) : null}
      {!grants ? (
        loadError ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        )
      ) : (
        <>
          {/* MISC-08: effective eligibility per scope, with each source and any exclusion. */}
          <ul className="divide-y" aria-label="Effective review eligibility">
            {grants.effectiveEligibility.map((e) => (
              <li key={e.scope.code} className="py-2">
                <strong className="font-medium">
                  {e.scope.label}: {e.eligible ? 'Eligible to review' : 'Not eligible'}
                </strong>{' '}
                <span className="text-sm text-muted-foreground">
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
            <ul className="divide-y" aria-label="Exclusions">
              {grants.exclusions.active.map((x) => {
                const label = `Excluded from ${x.scope ? x.scope.label : 'all review scopes'}`;
                return (
                  <GrantRow
                    key={x.id}
                    label={label}
                    meta={`${by(x.startedBy, x.startedAt)}${x.startReason ? ` (${x.startReason})` : ''}`}
                    action={endAction(
                      { kind: 'exclusion', id: x.id, label },
                      `Remove exclusion (${x.scope ? x.scope.label : 'all scopes'})`,
                    )}
                  />
                );
              })}
            </ul>
          ) : null}
          {grants.capabilities.active.length + grants.reviewerEligibility.active.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No reviewer eligibility or capabilities.
            </p>
          ) : (
            <ul className="divide-y" aria-label="Current grants">
              {grants.capabilities.active.map((grant) => (
                <GrantRow
                  key={grant.id}
                  label={STAFF_CAPABILITY_LABEL[grant.capability]}
                  meta={`${by(grant.startedBy, grant.startedAt)}${grant.startReason ? ` (${grant.startReason})` : ''}`}
                  action={endAction(
                    {
                      kind: 'capability',
                      id: grant.id,
                      label: STAFF_CAPABILITY_LABEL[grant.capability],
                    },
                    `Revoke ${STAFF_CAPABILITY_LABEL[grant.capability]}`,
                  )}
                />
              ))}
              {grants.reviewerEligibility.active.map((grant) => (
                <GrantRow
                  key={grant.id}
                  label={`Eligible reviewer: ${grant.scope.label}`}
                  meta={`${by(grant.startedBy, grant.startedAt)}${grant.startReason ? ` (${grant.startReason})` : ''}`}
                  action={endAction(
                    {
                      kind: 'eligibility',
                      id: grant.id,
                      label: `Eligible reviewer: ${grant.scope.label}`,
                    },
                    `Revoke ${grant.scope.label} eligibility`,
                  )}
                />
              ))}
            </ul>
          )}

          {canGrant ? (
            <>
              <GrantForm
                name="Grant reviewer eligibility"
                selectLabel="Reviewer eligibility"
                value={scope}
                onValueChange={setScope}
                options={scopes
                  .filter((s) => !heldScopes.has(s.code))
                  .map((s) => ({ value: s.code, label: s.label }))}
                placeholder="Choose a scope"
                reason={scopeReason}
                onReasonChange={setScopeReason}
                submitLabel="Grant eligibility"
                busy={busy}
                onSubmit={async () => {
                  const ok = await run(
                    () => grantsApi.grantEligibility(member.id, scope, scopeReason, keys.scope),
                    `${member.displayName} is now an eligible ${scopeLabel(scope)} reviewer.`,
                  );
                  setKeys((k) => ({ ...k, scope: crypto.randomUUID() }));
                  if (ok) {
                    setScope('');
                    setScopeReason('');
                  }
                }}
              />
              <GrantForm
                name="Exclude from review"
                selectLabel="Exclude from review"
                value={excludeScope}
                onValueChange={setExcludeScope}
                options={[
                  { value: '*', label: 'All review scopes' },
                  ...scopes.map((s) => ({ value: s.code, label: s.label })),
                ]}
                placeholder="Choose a scope"
                description="Overrides position rules and individual grants. Ends their review approvals in that scope."
                reason={excludeReason}
                onReasonChange={setExcludeReason}
                submitLabel="Exclude"
                busy={busy}
                onSubmit={async () => {
                  const scopeCode = excludeScope === '*' ? null : excludeScope;
                  const ok = await run(
                    () =>
                      grantsApi.addExclusion(member.id, scopeCode, excludeReason, keys.exclusion),
                    `${member.displayName} is excluded from ${
                      scopeCode ? scopeLabel(scopeCode) : 'all review scopes'
                    }.`,
                  );
                  setKeys((k) => ({ ...k, exclusion: crypto.randomUUID() }));
                  if (ok) {
                    setExcludeScope('');
                    setExcludeReason('');
                  }
                }}
              />
              {STAFF_CAPABILITIES.some((c) => !heldCapabilities.has(c)) ? (
                <GrantForm
                  name="Grant capability"
                  selectLabel="Capability"
                  value={capability}
                  onValueChange={(value) => setCapability(value as StaffCapability | '')}
                  options={STAFF_CAPABILITIES.filter((c) => !heldCapabilities.has(c)).map((c) => ({
                    value: c,
                    label: STAFF_CAPABILITY_LABEL[c],
                  }))}
                  placeholder="Choose a capability"
                  reason={capabilityReason}
                  onReasonChange={setCapabilityReason}
                  submitLabel="Grant capability"
                  busy={busy}
                  onSubmit={async () => {
                    if (!capability) return;
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
                />
              ) : null}
            </>
          ) : grants.canManage ? (
            <p className="text-sm text-muted-foreground">
              Grants can be added once the account is active.
            </p>
          ) : null}

          <History
            title="Grant history"
            items={[
              ...grants.capabilities.history.map((g) => ({
                ...g,
                label: STAFF_CAPABILITY_LABEL[g.capability],
              })),
              ...grants.reviewerEligibility.history.map((g) => ({
                ...g,
                label: `Eligible reviewer: ${g.scope.label}`,
              })),
            ].map((g) => ({
              key: g.id,
              text: `${g.label}: granted by ${formatPerson(g.startedBy.initials, g.startedBy.name)}, ${shortDateTime(g.startedAt)}; revoked by ${
                g.endedBy ? formatPerson(g.endedBy.initials, g.endedBy.name) : ''
              }, ${g.endedAt ? shortDateTime(g.endedAt) : ''}${g.endReason ? ` (${g.endReason})` : ''}`,
            }))}
          />
        </>
      )}
      <ConfirmReasonDialog
        open={ending !== null}
        title={
          ending?.kind === 'exclusion'
            ? `Remove: ${ending.label}?`
            : `Revoke ${ending?.label ?? ''}?`
        }
        description={
          ending?.kind === 'exclusion'
            ? 'Eligibility is recalculated. Project review approvals that ended stay ended: the lead approves again.'
            : 'It stops counting on their next request. Earlier work keeps their name.'
        }
        confirmLabel={ending?.kind === 'exclusion' ? 'Remove' : 'Revoke'}
        destructive
        requireReason
        onCancel={() => setEnding(null)}
        onConfirm={(reason) => {
          const target = ending;
          if (!target) return;
          setEnding(null);
          void run(
            () =>
              target.kind === 'capability'
                ? grantsApi.revokeCapability(member.id, target.id, reason)
                : target.kind === 'exclusion'
                  ? grantsApi.removeExclusion(member.id, target.id, reason)
                  : grantsApi.revokeEligibility(member.id, target.id, reason),
            target.kind === 'exclusion'
              ? `${target.label}: removed for ${member.displayName}.`
              : `${target.label} revoked for ${member.displayName}.`,
          );
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Read-only: the person's current access
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
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={`group -ml-2 ${TOUCH}`}>
          <ChevronRight
            aria-hidden="true"
            className="transition-transform group-data-[state=open]:rotate-90"
          />
          Current access
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2 pt-2">
        {error ? <ErrorAlert title={error} /> : null}
        {!summary && !error && open ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        ) : null}
        {summary ? <AccessSummaryView summary={summary} headingLevel={3} /> : null}
      </CollapsibleContent>
    </Collapsible>
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
  const [busy, setBusy] = useState(false);
  const headingId = useId();
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
    <section className="grid max-w-3xl gap-3" aria-labelledby={headingId}>
      <SectionTitle as="h2" id={headingId}>
        Review eligibility by position
      </SectionTitle>
      <p className="text-sm text-muted-foreground">
        No position is eligible to review until you enable it for a scope. A rule covers everyone
        with that position now and later. Each change needs a reason.
      </p>
      {error ? <ErrorAlert title={error} /> : null}
      {!rules ? (
        error ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        )
      ) : rules.active.length === 0 ? (
        <p className="text-sm text-muted-foreground">No position is eligible to review.</p>
      ) : (
        <ul className="divide-y rounded-lg border px-3" aria-label="Position rules">
          {rules.active.map((rule) => (
            <GrantRow
              key={rule.id}
              label={`${POSITION_LABELS[rule.position]}: ${rule.scope.label}`}
              meta={`${by(rule.startedBy, rule.startedAt)} (${rule.startReason})`}
              action={{
                label: `Disable ${POSITION_LABELS[rule.position]} (${rule.scope.label})`,
                disabled: busy,
                onClick: () => setDisabling(rule),
              }}
            />
          ))}
        </ul>
      )}
      <form
        aria-label="Enable a position rule"
        className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
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
        <LabelledSelect
          label="Position"
          value={position}
          onValueChange={(value) => setPosition(value as Position | '')}
          options={POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] }))}
          placeholder="Choose a position"
        />
        <LabelledSelect
          label="Review scope"
          value={scope}
          onValueChange={setScope}
          options={scopes.map((s) => ({ value: s.code, label: s.label }))}
          placeholder="Choose a scope"
        />
        <div className="sm:col-span-2">
          <ReasonField value={reason} onChange={setReason} />
        </div>
        <div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className={TOUCH}
            disabled={busy || !position || !scope || !reason.trim()}
          >
            Enable rule
          </Button>
        </div>
      </form>
      {rules ? (
        <History
          title="Rule history"
          items={rules.history.map((rule) => ({
            key: rule.id,
            text: `${POSITION_LABELS[rule.position]}: ${rule.scope.label}; enabled ${shortDateTime(rule.startedAt)}, disabled by ${
              rule.endedBy ? formatPerson(rule.endedBy.initials, rule.endedBy.name) : ''
            } ${rule.endedAt ? shortDateTime(rule.endedAt) : ''}${rule.endReason ? ` (${rule.endReason})` : ''}`,
          }))}
        />
      ) : null}
      <ConfirmReasonDialog
        open={disabling !== null}
        title={`Disable ${disabling ? POSITION_LABELS[disabling.position] : ''} for ${disabling?.scope.label ?? ''}?`}
        description="People left with no other source lose eligibility; their review approvals in this scope end and their leads are asked to reassign."
        confirmLabel="Disable"
        destructive
        requireReason
        onCancel={() => setDisabling(null)}
        onConfirm={(disableReason) => {
          const rule = disabling;
          if (!rule) return;
          setDisabling(null);
          void run(() => rulesApi.disable(rule.id, disableReason));
        }}
      />
    </section>
  );
}
