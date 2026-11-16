import {
  POSITIONS,
  POSITION_LABELS,
  ROLE_LABELS,
  type StaffMember,
  type StaffPosition,
  type StaffRole,
  type UpdateStaffRequest,
} from '@materialmule/shared';
import { Check, Lock, RotateCcw, Shield, ShieldOff, UserX } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { PersonAvatar } from '../../components/strata/person-avatar';
import { isStaffForbidden, staffApi, staffErrorMessage } from './api';
import { ACCOUNT_LABELS, approvedChange, dateOnly, statusChangeText, when } from './format';
import { JobTitleSection, StaffAccessSummary, StaffGrantsSection } from './StaffGrantsSection';
import {
  ErrorAlert,
  InlineInfo,
  LabelledSelect,
  ReasonField,
  SectionTitle,
  TOUCH,
  StaffStatusBadge,
} from './staff-ui';

/** Roles chosen with checkboxes; Admin has its own section (round 9). */
const CHECKBOX_ROLES: StaffRole[] = ['lab_technician', 'lab_manager'];
const NOT_SET = 'none';

const POSITION_OPTIONS = [
  { value: NOT_SET, label: 'Not set' },
  ...POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] })),
];

type Confirming = 'make-admin' | 'remove-admin' | null;

export interface StaffDrawerBodyProps {
  member: StaffMember;
  isSelf: boolean;
  /** The person's name as the drawer's title: an h2 in the peek, the SheetTitle in the sheet. */
  renderTitle: (name: string) => ReactNode;
  /** Permissions of the viewer (STRATA-118). */
  canAdmin: boolean;
  canPosition: boolean;
  onChanged: (member: StaffMember, message: string) => void;
  onForbidden: () => void;
  className?: string;
}

/**
 * One person (round 9 Staff drawer): who they are, Roles with a reason, Admin, Access (Disable as
 * an inline confirm with a required reason, Re-enable without one: owner decision, D08), access
 * history, then profile, job title, grants and current access. STRATA-118: only administrators
 * make or remove admins or change an administrator's account; positions move review eligibility
 * (MISC-06), so they stay with whoever manages eligibility. The server enforces all of it.
 */
export function StaffDrawerBody({
  member,
  isSelf,
  renderTitle,
  canAdmin,
  canPosition,
  onChanged,
  onForbidden,
  className,
}: StaffDrawerBodyProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isLab = member.accountType === 'shared_lab';
  const protectedAdmin = member.roles.includes('admin') && !canAdmin;

  async function run(action: () => Promise<StaffMember>, message: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action(), message);
      return true;
    } catch (caught) {
      if (isStaffForbidden(caught)) onForbidden();
      else setError(staffErrorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const meta = [
    member.position ? POSITION_LABELS[member.position] : null,
    ACCOUNT_LABELS[member.accountType],
    member.workEmail ?? member.signInUsername ?? member.expectedUpn,
  ].filter(Boolean);
  const approved = approvedChange(member);

  return (
    <div className={cn('grid gap-5 p-4 md:p-6', className)}>
      <header className="flex items-start gap-3">
        <PersonAvatar
          name={member.displayName}
          userId={member.id}
          size="lg"
          className="size-10 [&_[data-slot=avatar-fallback]]:text-sm"
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          {renderTitle(member.displayName)}
          <p className="truncate text-sm text-muted-foreground">
            {meta.join(' · ')}
            {isSelf ? ' · You' : ''}
          </p>
        </div>
        <StaffStatusBadge status={member.status} />
      </header>

      {error ? <ErrorAlert title={error} /> : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Official initials</dt>
        <dd className="font-mono">
          {member.officialInitials ?? '—'}
          {member.officialInitials && !member.initialsConfirmed ? (
            <span className="ml-2 font-sans text-muted-foreground">Not confirmed</span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Sign-in</dt>
        <dd className="min-w-0 break-words">
          {member.signInUsername ??
            (member.expectedUpn ? `Expected: ${member.expectedUpn}` : 'Not linked')}
        </dd>
        <dt className="text-muted-foreground">Last sign-in</dt>
        <dd>{when(member.lastSignInAt)}</dd>
        {approved ? (
          <>
            <dt className="text-muted-foreground">Approved</dt>
            <dd>
              {dateOnly.format(new Date(approved.at))}
              {approved.byName ? ` by ${approved.byName}` : ''}
            </dd>
          </>
        ) : null}
        {member.disabledReason ? (
          <>
            <dt className="text-muted-foreground">Disabled</dt>
            <dd>{member.disabledReason}</dd>
          </>
        ) : null}
      </dl>

      {protectedAdmin ? (
        <p
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
          data-testid="admin-protected"
        >
          <Lock aria-hidden="true" className="size-4 shrink-0" />
          Only administrators can change an administrator’s account.
        </p>
      ) : (
        <>
          {member.status === 'pending' ? (
            <PendingSection member={member} busy={busy} run={run} />
          ) : null}
          <Separator />
          {isLab ? (
            <p className="text-sm text-muted-foreground">
              The shared LAB account can't hold roles.
            </p>
          ) : (
            <>
              <RolesSection member={member} busy={busy} run={run} />
              <Separator />
              <AdminSection member={member} canAdmin={canAdmin} busy={busy} run={run} />
            </>
          )}
          {member.status !== 'pending' ? (
            <>
              <Separator />
              <AccessSection member={member} isSelf={isSelf} busy={busy} run={run} />
            </>
          ) : null}
        </>
      )}

      {member.statusHistory.length > 0 ? (
        <div className="grid gap-2">
          <SectionTitle>Access history</SectionTitle>
          <ul className="grid gap-1.5 text-sm" aria-label="Access history">
            {member.statusHistory.map((change) => (
              <li key={`${change.change}-${change.at}`}>{statusChangeText(change)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {protectedAdmin ? null : (
        <>
          <Separator />
          <ProfileSection member={member} canPosition={canPosition} busy={busy} run={run} />
          {isLab ? null : (
            <>
              <Separator />
              <JobTitleSection member={member} onChanged={onChanged} onForbidden={onForbidden} />
            </>
          )}
        </>
      )}

      {isLab ? null : (
        <>
          <Separator />
          <StaffGrantsSection
            key={`grants-${member.status}`}
            member={member}
            onForbidden={onForbidden}
          />
          <StaffAccessSummary key={`access-${member.status}`} member={member} />
        </>
      )}
    </div>
  );
}

type Run = (action: () => Promise<StaffMember>, message: string) => Promise<boolean>;

function PendingSection({ member, busy, run }: { member: StaffMember; busy: boolean; run: Run }) {
  const [rejecting, setRejecting] = useState(false);
  return (
    <section className="grid gap-3" aria-label="Approval">
      <p className="text-sm">
        Signed in for the first time on {when(member.createdAt)} and is waiting for approval. Until
        then they see “You are signed in, but not set up yet.”
      </p>
      {rejecting ? (
        <InlineDisable
          member={member}
          title={`Reject ${member.displayName}?`}
          confirmLabel="Reject"
          busy={busy}
          onCancel={() => setRejecting(false)}
          run={run}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            className={TOUCH}
            disabled={busy}
            onClick={() =>
              void run(() => staffApi.approve(member.id), `${member.displayName} is approved.`)
            }
          >
            <Check aria-hidden="true" />
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={cn('text-destructive-text', TOUCH)}
            disabled={busy}
            onClick={() => setRejecting(true)}
          >
            Reject (disable)…
          </Button>
        </div>
      )}
    </section>
  );
}

const sameRoles = (a: readonly StaffRole[], b: readonly StaffRole[]) =>
  [...a].sort().join(',') === [...b].sort().join(',');

/** Every role change needs a reason (D15, MM-AO03), given inline beside Save roles. */
function RolesSection({ member, busy, run }: { member: StaffMember; busy: boolean; run: Run }) {
  const held = member.roles.filter((role) => role !== 'admin');
  const [roles, setRoles] = useState<StaffRole[]>(held);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [noChanges, setNoChanges] = useState(false);
  const idPrefix = useId();

  async function save(event: FormEvent) {
    event.preventDefault();
    if (sameRoles(roles, held)) {
      setNoChanges(true);
      return;
    }
    setNoChanges(false);
    if (!reason.trim()) {
      setReasonError('Enter a reason.');
      return;
    }
    setReasonError(null);
    const next = member.roles.includes('admin') ? [...roles, 'admin' as const] : roles;
    if (
      await run(
        () => staffApi.setRoles(member.id, next, reason),
        `Roles updated for ${member.displayName}.`,
      )
    ) {
      setReason('');
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <FieldSet disabled={busy} className="gap-3">
        <FieldLegend variant="label" className="mb-0 text-sm font-semibold">
          Roles
        </FieldLegend>
        <div className="grid gap-2">
          {CHECKBOX_ROLES.map((role) => (
            <Field key={role} orientation="horizontal">
              <Checkbox
                id={`${idPrefix}-${role}`}
                checked={roles.includes(role)}
                onCheckedChange={(checked) => {
                  setNoChanges(false);
                  setRoles((current) =>
                    checked === true ? [...current, role] : current.filter((r) => r !== role),
                  );
                }}
              />
              <FieldLabel htmlFor={`${idPrefix}-${role}`} className="font-normal">
                {ROLE_LABELS[role]}
              </FieldLabel>
            </Field>
          ))}
        </div>
        <ReasonField
          value={reason}
          error={reasonError}
          placeholder="Why the roles change"
          description="The change applies from their next request. The reason is kept in the audit log."
          onChange={(value) => {
            setReason(value);
            if (value.trim()) setReasonError(null);
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" className={TOUCH}>
            Save roles
          </Button>
          {noChanges ? <InlineInfo>No changes to save.</InlineInfo> : null}
        </div>
      </FieldSet>
    </form>
  );
}

function AdminSection({
  member,
  canAdmin,
  busy,
  run,
}: {
  member: StaffMember;
  canAdmin: boolean;
  busy: boolean;
  run: Run;
}) {
  const [confirming, setConfirming] = useState<Confirming>(null);
  const isAdmin = member.roles.includes('admin');
  return (
    <section className="grid gap-2" aria-label="Admin">
      <SectionTitle>Admin</SectionTitle>
      {!canAdmin ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Lock aria-hidden="true" className="size-4 shrink-0" />
          Only administrators can make or remove admins.
        </p>
      ) : confirming ? (
        <InlineReasonConfirm
          title={
            isAdmin
              ? `Remove admin from ${member.displayName}?`
              : `Make ${member.displayName} an admin?`
          }
          description={
            isAdmin
              ? 'They lose staff and session management straight away.'
              : 'They can manage staff, the LAB account and every setting from their next request.'
          }
          confirmLabel={isAdmin ? 'Remove admin' : 'Make admin'}
          destructive={isAdmin}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={async (reason) => {
            const next: StaffRole[] = isAdmin
              ? member.roles.filter((r) => r !== 'admin')
              : [...member.roles, 'admin'];
            const ok = await run(
              () => staffApi.setRoles(member.id, next, reason),
              isAdmin
                ? `Admin removed from ${member.displayName}.`
                : `${member.displayName} is now an admin.`,
            );
            if (ok) setConfirming(null);
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={TOUCH}
            disabled={busy}
            onClick={() => setConfirming(isAdmin ? 'remove-admin' : 'make-admin')}
          >
            {isAdmin ? <ShieldOff aria-hidden="true" /> : <Shield aria-hidden="true" />}
            {isAdmin ? 'Remove admin…' : 'Make admin…'}
          </Button>
          <span className="text-sm text-muted-foreground">Asks for a reason.</span>
        </div>
      )}
    </section>
  );
}

function AccessSection({
  member,
  isSelf,
  busy,
  run,
}: {
  member: StaffMember;
  isSelf: boolean;
  busy: boolean;
  run: Run;
}) {
  const [disabling, setDisabling] = useState(false);
  return (
    <section className="grid gap-2" aria-label="Access">
      {disabling ? (
        <InlineDisable
          member={member}
          title={`Disable ${member.displayName}'s access`}
          confirmLabel="Disable access"
          busy={busy}
          onCancel={() => setDisabling(false)}
          run={run}
        />
      ) : (
        <>
          <SectionTitle>Access</SectionTitle>
          {member.status === 'disabled' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={TOUCH}
                disabled={busy}
                onClick={() =>
                  void run(
                    () => staffApi.enable(member.id),
                    // D08 (MM-AO03): technical grants don't come back with the account.
                    `${member.displayName} is re-enabled. Their reviewer, issuer and delegate grants were revoked for revalidation.`,
                  )
                }
              >
                <RotateCcw aria-hidden="true" />
                Re-enable access
              </Button>
              <span className="text-sm text-muted-foreground">
                Reviewer, issuer and delegate grants stay revoked until granted again.
              </span>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={cn('text-destructive-text', TOUCH)}
                  disabled={busy}
                  onClick={() => setDisabling(true)}
                >
                  <UserX aria-hidden="true" />
                  Disable access…
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                They are signed out everywhere and can no longer be chosen as a receiver. Past
                records keep their name.
              </p>
            </div>
          )}
          {isSelf ? (
            <p className="text-sm text-muted-foreground">This is your own account.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Disable (or reject) as an inline confirm with a required reason (round 9, not a dialog). */
function InlineDisable({
  member,
  title,
  confirmLabel,
  busy,
  onCancel,
  run,
}: {
  member: StaffMember;
  title: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  run: Run;
}) {
  return (
    <InlineReasonConfirm
      title={title}
      description="They are signed out everywhere and can no longer be chosen as a receiver. Past records keep their name. You can re-enable them later."
      placeholder="Why their access ends"
      confirmLabel={confirmLabel}
      destructive
      busy={busy}
      onCancel={onCancel}
      onConfirm={async (reason) => {
        const ok = await run(
          () => staffApi.disable(member.id, reason),
          `${member.displayName} is disabled and signed out everywhere.`,
        );
        if (ok) onCancel();
      }}
    />
  );
}

function InlineReasonConfirm({
  title,
  description,
  placeholder,
  confirmLabel,
  destructive,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  placeholder?: string;
  confirmLabel: string;
  destructive: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  return (
    <form
      role="group"
      aria-labelledby={headingId}
      className={cn(
        'grid gap-3 rounded-lg border p-3',
        destructive && 'border-destructive/40 bg-destructive/5',
      )}
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) {
          setError('Enter a reason.');
          return;
        }
        void onConfirm(reason);
      }}
    >
      <SectionTitle id={headingId}>{title}</SectionTitle>
      <p className="text-sm text-muted-foreground">{description}</p>
      <ReasonField
        value={reason}
        error={error}
        placeholder={placeholder}
        onChange={(value) => {
          setReason(value);
          if (value.trim()) setError(null);
        }}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          variant={destructive ? 'destructive' : 'default'}
          className={TOUCH}
          disabled={busy}
        >
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}

/** Name, official initials (MM-T44) and position (MM-T43, admins only). */
function ProfileSection({
  member,
  canPosition,
  busy,
  run,
}: {
  member: StaffMember;
  canPosition: boolean;
  busy: boolean;
  run: Run;
}) {
  const [displayName, setDisplayName] = useState(member.displayName);
  const [initials, setInitials] = useState(member.officialInitials ?? '');
  const [position, setPosition] = useState<StaffPosition | ''>(member.position ?? '');
  const [noChanges, setNoChanges] = useState(false);
  const nameId = useId();
  const initialsId = useId();
  const initialsUnconfirmed = Boolean(member.officialInitials) && !member.initialsConfirmed;

  // Only changed fields are sent, so an unrelated edit never re-confirms initials (MM-T44) or
  // touches the position (MM-T43).
  function save(event: FormEvent) {
    event.preventDefault();
    const patch: UpdateStaffRequest = {};
    if (displayName !== member.displayName) patch.displayName = displayName;
    if (initials.trim() && initials.trim() !== member.officialInitials) {
      patch.officialInitials = initials;
    }
    if (canPosition && (position || null) !== member.position) patch.position = position || null;
    if (Object.keys(patch).length === 0) {
      setNoChanges(true);
      return;
    }
    setNoChanges(false);
    void run(
      () => staffApi.update(member.id, patch),
      `Saved ${displayName.trim() || member.displayName}.`,
    );
  }

  /** Explicitly confirms initials that are on record but were never confirmed (MM-T44). */
  function confirmInitials() {
    const value = member.officialInitials;
    if (!value) return;
    void run(
      () => staffApi.update(member.id, { officialInitials: value }),
      `Initials ${value} confirmed for ${member.displayName}.`,
    );
  }

  return (
    <form onSubmit={save} className="grid gap-3" aria-label="Profile">
      <SectionTitle>Profile</SectionTitle>
      <Field>
        <FieldLabel htmlFor={nameId}>Display name</FieldLabel>
        <Input
          id={nameId}
          value={displayName}
          className={TOUCH}
          onChange={(e) => {
            setNoChanges(false);
            setDisplayName(e.target.value);
          }}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={initialsId}>Official initials</FieldLabel>
        <Input
          id={initialsId}
          value={initials}
          maxLength={5}
          autoCapitalize="characters"
          className={cn('font-mono', TOUCH)}
          onChange={(e) => {
            setNoChanges(false);
            setInitials(e.target.value.toUpperCase());
          }}
        />
        <FieldDescription>
          {initialsUnconfirmed
            ? 'Not confirmed yet: save new initials or confirm these. 1 to 5 letters. Not unique.'
            : '1 to 5 letters, confirmed by an admin. Not unique.'}
        </FieldDescription>
      </Field>
      {initialsUnconfirmed ? (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={TOUCH}
            disabled={busy}
            onClick={confirmInitials}
          >
            Confirm initials {member.officialInitials}
          </Button>
        </div>
      ) : null}
      {canPosition ? (
        <LabelledSelect
          label="Position"
          value={position || NOT_SET}
          onValueChange={(value) => {
            setNoChanges(false);
            setPosition(value === NOT_SET ? '' : (value as StaffPosition));
          }}
          options={POSITION_OPTIONS}
          description="Describes their work; grants no permissions. Only shown here."
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" variant="outline" className={TOUCH} disabled={busy}>
          Save profile
        </Button>
        {noChanges ? <InlineInfo>No changes to save.</InlineInfo> : null}
      </div>
    </form>
  );
}
