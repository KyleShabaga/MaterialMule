import {
  POSITION_SHORT_LABELS,
  ROLE_LABELS,
  type StaffMember,
  type StaffPosition,
  type StaffRole,
  type StaffStatus,
  type UpdateStaffRequest,
} from '@materialmule/shared';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  BandedCard,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  StatusBadge,
  type BadgeTone,
} from '../../components/ui';
import { useMe } from '../../session/context';
import { StaffApiError, listStaff, staffApi } from './api';
import { LabAccountCard } from './LabAccountCard';

const STATUS_LABELS: Record<StaffStatus, string> = {
  pending: 'Pending',
  active: 'Active',
  disabled: 'Disabled',
};
const STATUS_TONES: Record<StaffStatus, BadgeTone> = {
  pending: 'warning',
  active: 'success',
  disabled: 'neutral',
};
const ACCOUNT_LABELS: Record<StaffMember['accountType'], string> = {
  personal: 'Personal',
  shared_lab: 'Shared LAB',
  test: 'Test',
};
const POSITIONS = Object.keys(POSITION_SHORT_LABELS) as StaffPosition[];
const POSITION_NAMES: Record<StaffPosition, string> = {
  technician: 'Technician',
  engineer: 'Engineer',
  project_engineer: 'Project Engineer',
  lab_manager: 'Lab Manager',
};

const dateTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  dateStyle: 'medium',
  timeStyle: 'short',
});
const when = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : 'Never');

function errorMessage(error: unknown): string {
  return error instanceof StaffApiError ? error.message : 'Something went wrong. Try again.';
}

type Load<T> =
  | { state: 'loading' }
  | { state: 'error'; message: string; forbidden: boolean }
  | { state: 'ready'; data: T };

const isForbidden = (error: unknown) => error instanceof StaffApiError && error.forbidden;
const REVOKED_MESSAGE = 'You no longer have permission to manage staff.';

/** Loads `fetcher()` whenever `key` changes, without setting state synchronously in the effect. */
function useLoad<T>(key: string, fetcher: () => Promise<T>): Load<T> {
  const [latest, setLatest] = useState<{ key: string; load: Load<T> } | null>(null);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  useEffect(() => {
    let current = true;
    fetcherRef.current().then(
      (data) => current && setLatest({ key, load: { state: 'ready', data } }),
      (error: unknown) =>
        current &&
        setLatest({
          key,
          load: { state: 'error', message: errorMessage(error), forbidden: isForbidden(error) },
        }),
    );
    return () => {
      current = false;
    };
  }, [key]);
  return latest?.key === key ? latest.load : { state: 'loading' };
}

/** Settings → Staff & access (MM-T07). The server enforces admin-only; this only hides. */
export function StaffPage() {
  const me = useMe();
  if (!me.permissions.includes('staff.manage')) {
    return (
      <section aria-labelledby="staff-heading">
        <h2 id="staff-heading">Staff &amp; access</h2>
        <EmptyState>Only administrators can manage staff and access.</EmptyState>
      </section>
    );
  }
  return <StaffAccess currentUserId={me.id} />;
}

/**
 * MM-T52: once any staff request is refused (403), the caller has lost Admin. The whole page,
 * including Add staff, the pending card and the LAB account card, gives way to one message with
 * Retry; Retry loads everything again, so a re-granted Admin gets the page back without signing
 * in again.
 */
function StaffAccess({ currentUserId }: { currentUserId: string }) {
  const [revoked, setRevoked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (revoked) {
    return (
      <section aria-labelledby="staff-heading" className="staff">
        <h2 id="staff-heading">Staff &amp; access</h2>
        <ErrorState
          message={REVOKED_MESSAGE}
          onRetry={() => {
            setRevoked(false);
            setAttempt((n) => n + 1);
          }}
        />
      </section>
    );
  }
  return (
    <div key={attempt}>
      <StaffDirectory currentUserId={currentUserId} onForbidden={() => setRevoked(true)} />
      {/* The shared receiving account's password and stations (MM-T06). */}
      <LabAccountCard onForbidden={() => setRevoked(true)} />
    </div>
  );
}

function StaffDirectory({
  currentUserId,
  onForbidden,
}: {
  currentUserId: string;
  onForbidden: () => void;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StaffStatus | ''>('');
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<StaffMember | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const list = useLoad(`${version}|${status}|${search.trim()}`, () =>
    listStaff({ search, status }),
  );
  const pending = useLoad(`${version}|pending`, () => listStaff({ search: '', status: 'pending' }));
  const refresh = () => setVersion((v) => v + 1);
  const forbidden =
    (list.state === 'error' && list.forbidden) || (pending.state === 'error' && pending.forbidden);
  useEffect(() => {
    if (forbidden) onForbidden();
  }, [forbidden, onForbidden]);

  function changed(member: StaffMember, message: string) {
    setNotice(message);
    setRowError(null);
    setSelected((open) => (open && open.id === member.id ? member : open));
    refresh();
  }

  async function approve(member: StaffMember) {
    try {
      changed(await staffApi.approve(member.id), `${member.displayName} is approved.`);
    } catch (error) {
      if (isForbidden(error)) onForbidden();
      else setRowError(errorMessage(error));
    }
  }

  return (
    <section aria-labelledby="staff-heading" className="staff">
      <div className="section-header">
        <h2 id="staff-heading">Staff &amp; access</h2>
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          Add staff
        </button>
      </div>
      <p role="status" className="notice">
        {notice}
      </p>
      {rowError ? <ErrorState message={rowError} /> : null}

      {pending.state === 'ready' && pending.data.length > 0 ? (
        <BandedCard
          className="pending-staff"
          tone="attention"
          headingLevel={3}
          title={`Waiting for approval (${pending.data.length})`}
          aside={<StatusBadge tone="warning">Pending</StatusBadge>}
        >
          <ul>
            {pending.data.map((member) => (
              <li key={member.id}>
                <span>
                  <strong>{member.displayName}</strong>
                  {member.signInUsername ? ` · ${member.signInUsername}` : ''}
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="primary"
                    aria-label={`Approve ${member.displayName}`}
                    onClick={() => void approve(member)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    aria-label={`Manage ${member.displayName}`}
                    onClick={() => setSelected(member)}
                  >
                    Manage
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </BandedCard>
      ) : null}

      <div className="filters filter-bar" role="search">
        <FormField label="Search staff">
          {(props) => (
            <input
              {...props}
              type="search"
              value={search}
              placeholder="Name, initials or email"
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="Status">
          {(props) => (
            <select
              {...props}
              value={status}
              onChange={(event) => setStatus(event.target.value as StaffStatus | '')}
            >
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          )}
        </FormField>
      </div>

      {list.state === 'loading' ? (
        <p aria-busy="true">Loading staff…</p>
      ) : list.state === 'error' ? (
        // A 403 hands over to StaffAccess's single message (MM-T52); don't show it twice.
        list.forbidden ? null : (
          <ErrorState message={list.message} onRetry={refresh} />
        )
      ) : (
        <DataTable
          rows={list.data}
          rowKey={(member) => member.id}
          caption="Staff"
          empty="No staff match these filters."
          columns={[
            {
              header: 'Name',
              cell: (m) => (
                <>
                  {m.displayName}
                  {m.id === currentUserId ? ' (you)' : ''}
                </>
              ),
            },
            { header: 'Initials', cell: (m) => m.officialInitials ?? '—' },
            { header: 'Position', cell: (m) => (m.position ? POSITION_NAMES[m.position] : '—') },
            { header: 'Account', cell: (m) => ACCOUNT_LABELS[m.accountType] },
            {
              header: 'Status',
              cell: (m) => (
                <StatusBadge tone={STATUS_TONES[m.status]}>{STATUS_LABELS[m.status]}</StatusBadge>
              ),
            },
            {
              header: 'Roles',
              cell: (m) => (m.roles.length ? m.roles.map((r) => ROLE_LABELS[r]).join(', ') : '—'),
            },
            { header: 'Last sign-in', cell: (m) => when(m.lastSignInAt) },
            {
              header: 'Actions',
              cell: (m) => (
                <button
                  type="button"
                  aria-label={`Manage ${m.displayName}`}
                  onClick={() => setSelected(m)}
                >
                  Manage
                </button>
              ),
            },
          ]}
        />
      )}

      {selected ? (
        <StaffDrawer
          key={selected.id}
          member={selected}
          isSelf={selected.id === currentUserId}
          onChanged={changed}
          onForbidden={onForbidden}
          onClose={() => setSelected(null)}
        />
      ) : null}
      {adding ? (
        <AddStaffDialog
          onForbidden={onForbidden}
          onClose={() => setAdding(false)}
          onAdded={(member) => {
            setAdding(false);
            changed(member, `${member.displayName} was added.`);
          }}
        />
      ) : null}
    </section>
  );
}

/** Native modal <dialog>: focus stays inside and Escape closes it. */
function Modal({
  title,
  className,
  onClose,
  children,
}: {
  title: string;
  className: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal?.();
    return () => dialog?.close?.();
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="drawer-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}

function StaffDrawer({
  member,
  isSelf,
  onChanged,
  onForbidden,
  onClose,
}: {
  member: StaffMember;
  isSelf: boolean;
  onChanged: (member: StaffMember, message: string) => void;
  onForbidden: () => void;
  onClose: () => void;
}) {
  const [displayName, setDisplayName] = useState(member.displayName);
  const [initials, setInitials] = useState(member.officialInitials ?? '');
  const [position, setPosition] = useState<StaffPosition | ''>(member.position ?? '');
  const [roles, setRoles] = useState<StaffRole[]>(member.roles);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'disable' | 'remove-admin' | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reasonId = useId();
  const isLab = member.accountType === 'shared_lab';

  async function run(action: () => Promise<StaffMember>, message: string) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action(), message);
      return true;
    } catch (caught) {
      if (isForbidden(caught)) onForbidden();
      else setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Only changed fields are sent, so an unrelated edit never re-confirms initials (MM-T44) or
  // touches the position (MM-T43).
  function saveProfile(event: FormEvent) {
    event.preventDefault();
    const patch: UpdateStaffRequest = {};
    if (displayName !== member.displayName) patch.displayName = displayName;
    if (initials.trim() && initials.trim() !== member.officialInitials) {
      patch.officialInitials = initials;
    }
    if ((position || null) !== member.position) patch.position = position || null;
    if (Object.keys(patch).length === 0) {
      onChanged(member, 'No changes to save.');
      return;
    }
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

  const initialsUnconfirmed = Boolean(member.officialInitials) && !member.initialsConfirmed;
  const clearsPosition =
    member.accountType === 'personal' && member.position !== null && position === '';

  function saveRoles(event: FormEvent) {
    event.preventDefault();
    if (member.roles.includes('admin') && !roles.includes('admin')) {
      setConfirm('remove-admin');
      return;
    }
    void run(() => staffApi.setRoles(member.id, roles), `Roles updated for ${member.displayName}.`);
  }

  async function confirmAction() {
    if (!reason.trim()) {
      setReasonError('Enter a reason.');
      return;
    }
    const kind = confirm;
    setConfirm(null);
    if (kind === 'disable') {
      await run(
        () => staffApi.disable(member.id, reason),
        `${member.displayName} is disabled and signed out everywhere.`,
      );
    } else if (kind === 'remove-admin') {
      await run(
        () => staffApi.setRoles(member.id, roles, reason),
        `Admin removed from ${member.displayName}.`,
      );
    }
    setReason('');
    setReasonError(null);
  }

  return (
    <Modal title={member.displayName} className="drawer" onClose={onClose}>
      <dl className="details">
        <dt>Status</dt>
        <dd>
          <StatusBadge tone={STATUS_TONES[member.status]}>
            {STATUS_LABELS[member.status]}
          </StatusBadge>
          {member.disabledReason ? ` · ${member.disabledReason}` : ''}
        </dd>
        <dt>Account</dt>
        <dd>{ACCOUNT_LABELS[member.accountType]}</dd>
        <dt>Sign-in</dt>
        <dd>
          {member.signInUsername ??
            (member.expectedUpn ? `Expected: ${member.expectedUpn}` : 'Not linked')}
        </dd>
        <dt>Last sign-in</dt>
        <dd>{when(member.lastSignInAt)}</dd>
      </dl>
      {error ? <ErrorState message={error} /> : null}

      <form onSubmit={saveProfile} className="drawer-section">
        <h3>Profile</h3>
        <FormField label="Display name">
          {(props) => (
            <input
              {...props}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Official initials"
          hint={
            initialsUnconfirmed
              ? 'Not confirmed yet: save new initials or confirm these. 1 to 5 letters. Not unique.'
              : '1 to 5 letters, confirmed by an admin. Not unique.'
          }
        >
          {(props) => (
            <input
              {...props}
              value={initials}
              maxLength={5}
              autoCapitalize="characters"
              onChange={(e) => setInitials(e.target.value.toUpperCase())}
            />
          )}
        </FormField>
        {initialsUnconfirmed ? (
          <p>
            <button type="button" onClick={confirmInitials} disabled={busy}>
              Confirm initials {member.officialInitials}
            </button>
          </p>
        ) : null}
        <FormField
          label="Position"
          hint={
            clearsPosition
              ? 'Not set: they will be asked to choose a position again at their next sign-in.'
              : 'Describes their work; grants no permissions.'
          }
        >
          {(props) => (
            <select
              {...props}
              value={position}
              onChange={(e) => setPosition(e.target.value as StaffPosition | '')}
            >
              <option value="">Not set</option>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {POSITION_NAMES[p]}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <button type="submit" disabled={busy}>
          Save profile
        </button>
      </form>

      <form onSubmit={saveRoles} className="drawer-section">
        <fieldset disabled={isLab || busy}>
          <legend>Roles</legend>
          {isLab ? <p className="field-hint">The shared LAB account can't hold roles.</p> : null}
          {(Object.keys(ROLE_LABELS) as StaffRole[]).map((role) => (
            <label key={role} className="checkbox">
              <input
                type="checkbox"
                checked={roles.includes(role)}
                onChange={(e) =>
                  setRoles((current) =>
                    e.target.checked ? [...current, role] : current.filter((r) => r !== role),
                  )
                }
              />
              {ROLE_LABELS[role]}
            </label>
          ))}
          <button type="submit">Save roles</button>
        </fieldset>
      </form>

      <div className="drawer-section">
        <h3>Access</h3>
        {member.status === 'pending' ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(() => staffApi.approve(member.id), `${member.displayName} is approved.`)
            }
          >
            Approve access
          </button>
        ) : null}
        {member.status !== 'disabled' ? (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => setConfirm('disable')}
          >
            {member.status === 'pending' ? 'Reject (disable)…' : 'Disable access…'}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() => staffApi.enable(member.id), `${member.displayName} is re-enabled.`)
            }
          >
            Re-enable access
          </button>
        )}
        {isSelf ? <p className="field-hint">This is your own account.</p> : null}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === 'disable'
            ? `Disable ${member.displayName}?`
            : `Remove admin from ${member.displayName}?`
        }
        confirmLabel={confirm === 'disable' ? 'Disable' : 'Remove admin'}
        danger
        onConfirm={() => void confirmAction()}
        onCancel={() => {
          setConfirm(null);
          setReasonError(null);
        }}
      >
        <p>
          {confirm === 'disable'
            ? 'They are signed out everywhere and can no longer be chosen as a receiver. Past records keep their name.'
            : 'They lose staff and session management straight away.'}
        </p>
        <label htmlFor={reasonId}>Reason</label>
        <textarea
          id={reasonId}
          value={reason}
          maxLength={2000}
          aria-invalid={Boolean(reasonError)}
          onChange={(e) => setReason(e.target.value)}
        />
        {reasonError ? <p className="field-error">{reasonError}</p> : null}
      </ConfirmDialog>
    </Modal>
  );
}

function AddStaffDialog({
  onClose,
  onAdded,
  onForbidden,
}: {
  onClose: () => void;
  onAdded: (member: StaffMember) => void;
  onForbidden: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [initials, setInitials] = useState('');
  const [upn, setUpn] = useState('');
  const [position, setPosition] = useState<StaffPosition | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAdded(
        await staffApi.preprovision({
          displayName,
          officialInitials: initials,
          expectedUpn: upn,
          position: position || null,
        }),
      );
    } catch (caught) {
      if (isForbidden(caught)) onForbidden();
      else setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add staff" className="drawer" onClose={onClose}>
      <p className="field-hint">
        Add someone before their first Microsoft sign-in. Their account links only when they sign in
        with exactly this work email; never by initials or name.
      </p>
      {error ? <ErrorState message={error} /> : null}
      <form onSubmit={(event) => void submit(event)} className="drawer-section">
        <FormField label="Full name">
          {(props) => (
            <input
              {...props}
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Official initials">
          {(props) => (
            <input
              {...props}
              required
              maxLength={5}
              value={initials}
              onChange={(e) => setInitials(e.target.value.toUpperCase())}
            />
          )}
        </FormField>
        <FormField label="Work email (sign-in name)">
          {(props) => (
            <input
              {...props}
              required
              type="email"
              value={upn}
              onChange={(e) => setUpn(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Position">
          {(props) => (
            <select
              {...props}
              value={position}
              onChange={(e) => setPosition(e.target.value as StaffPosition | '')}
            >
              <option value="">Not set</option>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {POSITION_NAMES[p]}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <button type="submit" className="primary" disabled={busy}>
          Add staff
        </button>
      </form>
    </Modal>
  );
}
