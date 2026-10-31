import {
  LOCATION_AREA_MAX,
  LOCATION_CODE_MESSAGE,
  LOCATION_NAME_MAX,
  LOCATION_REASON_MAX,
  SELECTABLE_LOCATION_KINDS,
  locationKindLabel,
  normalizeLocationCode,
  type FieldError,
  type LocationKind,
  type StorageLocation,
  type UpdateLocationRequest,
} from '@materialmule/shared';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { DataTable, ErrorState, FormField, StatusBadge } from '../../components/ui';
import { useMe } from '../../session/context';
import {
  createLocation,
  fetchLocation,
  listLocations,
  retireLocation,
  updateLocation,
  type Failure,
} from './api';
import { LocationDrawer } from './LocationDrawer';
import { MANAGE_PERMISSION, NOT_ALLOWED_TEXT, inventoryLink } from './location-links';
import { useFocusFirstInvalid } from '../../components/useFocusFirstInvalid';
import { Modal } from './Modal';
import './locations.css';

// Settings → Locations (MM-T37). Everyone signed in sees the list and can open a location's
// label; only admins and Lab Managers (`location.manage`) add, edit and retire. The server
// enforces the same rule, so a LAB station never gains these actions from the person selected.

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; locations: StorageLocation[]; total: number };

function unitsText(count: number): string {
  return count === 1 ? '1 unit' : `${count} units`;
}

function statusBadge(location: StorageLocation) {
  if (!location.active) return <StatusBadge tone="neutral">Retired</StatusBadge>;
  if (location.isSystem) return <StatusBadge tone="info">System</StatusBadge>;
  return <StatusBadge tone="success">Active</StatusBadge>;
}

function fieldError(errors: FieldError[], field: string): string | null {
  return errors.find((error) => error.field === field)?.message ?? null;
}

/** Add or edit a location. The code can't change once a label was requested for it. */
/**
 * Reads the location again before an edit or retirement, so the form reflects the latest saved
 * state (e.g. a code locked by a print a moment ago) rather than a list row that may be stale.
 */
function WithFreshLocation({
  location,
  onClose,
  children,
}: {
  location: StorageLocation;
  onClose: () => void;
  children: (fresh: StorageLocation) => ReactNode;
}) {
  const [load, setLoad] = useState<
    | { state: 'loading' }
    | { state: 'error'; message: string }
    | { state: 'ready'; location: StorageLocation }
  >({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    void fetchLocation(location.id).then((result) => {
      if (cancelled) return;
      setLoad(
        result.ok
          ? { state: 'ready', location: result.data.location }
          : { state: 'error', message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [location.id]);
  if (load.state === 'ready') return <>{children(load.location)}</>;
  return (
    <Modal title={location.name} onClose={onClose}>
      {load.state === 'loading' ? (
        <p aria-busy="true">Loading…</p>
      ) : (
        <ErrorState message={load.message} />
      )}
    </Modal>
  );
}

function LocationFormDialog({
  location,
  onClose,
  onSaved,
  onConflict,
}: {
  location: StorageLocation | null;
  onClose: () => void;
  onSaved: (location: StorageLocation, message: string) => void;
  onConflict: (current: StorageLocation, message: string) => void;
}) {
  const [code, setCode] = useState(location?.code ?? '');
  const [name, setName] = useState(location?.name ?? '');
  const [kind, setKind] = useState<LocationKind>(location?.kind ?? 'warehouse');
  const [area, setArea] = useState(location?.area ?? '');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeLocked = Boolean(location?.codeLocked || location?.isSystem);
  const { formRef, focusFirstInvalid } = useFocusFirstInvalid();
  const codeError = fieldError(errors, 'code');

  function localErrors(): FieldError[] {
    const found: FieldError[] = [];
    if (!/^[A-Z0-9-]{2,20}$/.test(normalizeLocationCode(code))) {
      found.push({ field: 'code', code: 'invalid', message: LOCATION_CODE_MESSAGE });
    }
    if (!name.trim()) found.push({ field: 'name', code: 'required', message: 'Name is required' });
    return found;
  }

  function show(failure: Failure) {
    if (failure.kind === 'invalid') {
      setErrors(failure.errors);
      setError(failure.message);
      focusFirstInvalid();
    } else if (failure.kind === 'failed' && failure.field) {
      setErrors([
        { field: failure.field, code: failure.code ?? 'invalid', message: failure.message },
      ]);
      setError(null);
      focusFirstInvalid();
    } else if (failure.kind === 'conflict') {
      onConflict(failure.current, failure.message);
    } else {
      setError(failure.message);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = localErrors();
    setErrors(found);
    setError(null);
    if (found.length > 0) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    const values = {
      code: normalizeLocationCode(code),
      name: name.trim(),
      kind,
      area: area.trim() || null,
    };
    let result;
    if (location) {
      const changes: UpdateLocationRequest = { version: location.version };
      if (!codeLocked && values.code !== location.code) changes.code = values.code;
      if (values.name !== location.name) changes.name = values.name;
      if (!location.isSystem && values.kind !== location.kind) {
        changes.kind = values.kind as (typeof SELECTABLE_LOCATION_KINDS)[number];
      }
      if (!location.isSystem && values.area !== location.area) changes.area = values.area;
      result = await updateLocation(location.id, changes);
    } else {
      result = await createLocation({
        ...values,
        kind: values.kind as (typeof SELECTABLE_LOCATION_KINDS)[number],
      });
    }
    setBusy(false);
    if (result.ok) {
      onSaved(
        result.data,
        location ? `${result.data.name} was saved.` : `${result.data.name} was added.`,
      );
    } else {
      show(result);
    }
  }

  return (
    <Modal title={location ? `Edit ${location.name}` : 'Add location'} onClose={onClose}>
      <form
        ref={formRef}
        className="drawer-section"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <FormField
          label="Code"
          error={codeError}
          required={!codeLocked}
          hint={
            codeLocked
              ? location?.isSystem
                ? 'The system location’s code can’t change.'
                : 'A label has been printed or queued for this code, so it can’t change.'
              : // MTR-133: the error already gives the rule, so the hint doesn't repeat it.
                `${codeError ? '' : `${LOCATION_CODE_MESSAGE}. `}Printed on the label as LOC-${normalizeLocationCode(code) || 'CODE'}.`
          }
        >
          {(props) => (
            <input
              {...props}
              className="location-code-input"
              value={code}
              maxLength={24}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              readOnly={codeLocked}
              required
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
          )}
        </FormField>
        <FormField label="Name" error={fieldError(errors, 'name')} required>
          {(props) => (
            <input
              {...props}
              value={name}
              maxLength={LOCATION_NAME_MAX}
              required
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="Kind" error={fieldError(errors, 'kind')}>
          {(props) => (
            <select
              {...props}
              value={kind}
              disabled={location?.isSystem}
              onChange={(event) => setKind(event.target.value as LocationKind)}
            >
              {location?.isSystem ? (
                <option value="receiving_lab">{locationKindLabel('receiving_lab')}</option>
              ) : null}
              {SELECTABLE_LOCATION_KINDS.map((option) => (
                <option key={option} value={option}>
                  {locationKindLabel(option)}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField
          label="Area or group (optional)"
          error={fieldError(errors, 'area')}
          hint="For example Warehouse C or Lab. Used for searching and sorting only."
        >
          {(props) => (
            <input
              {...props}
              value={area}
              maxLength={LOCATION_AREA_MAX}
              disabled={location?.isSystem}
              onChange={(event) => setArea(event.target.value)}
            />
          )}
        </FormField>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : location ? 'Save' : 'Add location'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Retire with a reason. Blocked while units are still there: says how many and links to them. */
function RetireDialog({
  location,
  onClose,
  onRetired,
  onConflict,
}: {
  location: StorageLocation;
  onClose: () => void;
  onRetired: (location: StorageLocation) => void;
  onConflict: (current: StorageLocation, message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ message: string; count: number } | null>(
    location.inStockCount > 0
      ? {
          message: `${unitsText(location.inStockCount)} ${location.inStockCount === 1 ? 'is' : 'are'} still at this location. Move ${location.inStockCount === 1 ? 'it' : 'them'} before retiring the location.`,
          count: location.inStockCount,
        }
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { formRef, focusFirstInvalid } = useFocusFirstInvalid();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim()) {
      setReasonError('Give a reason');
      focusFirstInvalid();
      return;
    }
    setReasonError(null);
    setError(null);
    setBusy(true);
    const result = await retireLocation(location.id, {
      reason: reason.trim(),
      version: location.version,
    });
    setBusy(false);
    if (result.ok) onRetired(result.data);
    else if (result.kind === 'occupied') {
      setBlocked({ message: result.message, count: result.inStockCount });
    } else if (result.kind === 'conflict') onConflict(result.current, result.message);
    else if (result.kind === 'invalid') {
      setReasonError(fieldError(result.errors, 'reason') ?? result.message);
      focusFirstInvalid();
    } else setError(result.message);
  }

  return (
    <Modal title={`Retire ${location.name}`} onClose={onClose}>
      <form
        ref={formRef}
        className="drawer-section"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <p>
          A retired location stays on every record that names it, but no storage unit can be moved
          there. Retiring can’t be undone here.
        </p>
        {blocked ? (
          <div className="notice notice-warning" role="alert">
            <p>{blocked.message}</p>
            <p>
              <Link to={inventoryLink(location)}>
                Show the {unitsText(blocked.count)} at {location.code}
              </Link>
            </p>
          </div>
        ) : null}
        <FormField label="Reason" error={reasonError} required>
          {(props) => (
            <textarea
              {...props}
              rows={3}
              value={reason}
              maxLength={LOCATION_REASON_MAX}
              required
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </FormField>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="danger" disabled={busy}>
            {busy ? 'Retiring…' : 'Retire location'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Settings → Locations (MM-T37). */
export function LocationsPage() {
  const me = useMe();
  const canManage = me.permissions.includes(MANAGE_PERMISSION);
  const [search, setSearch] = useState('');
  const [includeRetired, setIncludeRetired] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<StorageLocation | 'new' | null>(null);
  const [retiring, setRetiring] = useState<StorageLocation | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const reload = () => setReloads((count) => count + 1);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void listLocations({ search, includeRetired }).then((result) => {
        if (cancelled) return;
        setLoad(
          result.ok
            ? { state: 'ready', ...result.data }
            : { state: 'error', message: `Locations couldn’t load. ${result.message}` },
        );
      });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, includeRetired, reloads]);

  function conflict(current: StorageLocation, message: string) {
    // Someone else saved first: close the form, show the latest values and say so.
    setEditing(null);
    setRetiring(null);
    setNotice(`${message} The list now shows the latest details for ${current.name}.`);
    reload();
  }

  return (
    <section aria-labelledby="locations-heading" className="locations">
      <div className="section-header">
        <h2 id="locations-heading">Locations</h2>
        {canManage ? (
          <button type="button" className="primary" onClick={() => setEditing('new')}>
            Add location
          </button>
        ) : null}
      </div>
      <p className="field-hint">
        Shelves, benches and staging areas where storage units are kept. Each has a code printed on
        its own label as LOC-CODE.
        {canManage ? '' : ` ${NOT_ALLOWED_TEXT}`}
      </p>
      <p role="status" className="notice">
        {notice}
      </p>

      <div className="filters filter-bar" role="search">
        <FormField label="Search locations">
          {(props) => (
            <input
              {...props}
              type="search"
              value={search}
              placeholder="Code, name or area"
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </FormField>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeRetired}
            onChange={(event) => setIncludeRetired(event.target.checked)}
          />{' '}
          Include retired
        </label>
      </div>

      {load.state === 'loading' ? (
        <p aria-busy="true">Loading locations…</p>
      ) : load.state === 'error' ? (
        <ErrorState message={load.message} onRetry={reload} />
      ) : (
        <div className="table-stack">
          {load.total > load.locations.length ? (
            <p className="notice notice-warning" role="status">
              Showing the first {load.locations.length} of {load.total} locations. Search by code,
              name or area to find the rest.
            </p>
          ) : null}
          <DataTable
            rows={load.locations}
            rowKey={(location) => location.id}
            caption="Locations"
            empty={search.trim() ? 'No locations match this search.' : 'No locations yet.'}
            columns={[
              {
                header: 'Name',
                cell: (location) => (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setOpenId(location.id)}
                  >
                    {location.name}
                  </button>
                ),
              },
              { header: 'Code', cell: (location) => <code>{location.code}</code> },
              { header: 'Kind', cell: (location) => locationKindLabel(location.kind) },
              { header: 'Area', cell: (location) => location.area ?? '—' },
              { header: 'Status', cell: statusBadge },
              {
                header: 'In stock',
                cell: (location) =>
                  location.inStockCount > 0 ? (
                    <Link
                      to={inventoryLink(location)}
                      aria-label={`${unitsText(location.inStockCount)} at ${location.code}`}
                    >
                      {location.inStockCount}
                    </Link>
                  ) : (
                    '0'
                  ),
              },
              {
                header: 'Actions',
                cell: (location) => (
                  <span className="row-actions">
                    <button
                      type="button"
                      aria-label={`Label and history for ${location.name}`}
                      onClick={() => setOpenId(location.id)}
                    >
                      Label
                    </button>
                    {canManage && location.active ? (
                      <button
                        type="button"
                        aria-label={`Edit ${location.name}`}
                        onClick={() => setEditing(location)}
                      >
                        Edit
                      </button>
                    ) : null}
                    {canManage && location.active && !location.isSystem ? (
                      <button
                        type="button"
                        aria-label={`Retire ${location.name}`}
                        onClick={() => setRetiring(location)}
                      >
                        Retire
                      </button>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}

      {editing === 'new' ? (
        <LocationFormDialog
          location={null}
          onClose={() => setEditing(null)}
          onConflict={conflict}
          onSaved={(_location, message) => {
            setEditing(null);
            setNotice(message);
            reload();
          }}
        />
      ) : editing ? (
        <WithFreshLocation location={editing} onClose={() => setEditing(null)}>
          {(fresh) => (
            <LocationFormDialog
              location={fresh}
              onClose={() => setEditing(null)}
              onConflict={conflict}
              onSaved={(_location, message) => {
                setEditing(null);
                setNotice(message);
                reload();
              }}
            />
          )}
        </WithFreshLocation>
      ) : null}
      {retiring ? (
        <RetireDialog
          location={retiring}
          onClose={() => setRetiring(null)}
          onConflict={conflict}
          onRetired={(location) => {
            setRetiring(null);
            setNotice(`${location.name} was retired.`);
            reload();
          }}
        />
      ) : null}
      {openId ? (
        <LocationDrawer
          key={openId}
          locationId={openId}
          onClose={() => setOpenId(null)}
          onChanged={reload}
        />
      ) : null}
    </section>
  );
}
