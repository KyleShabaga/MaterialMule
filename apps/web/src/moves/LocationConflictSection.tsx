import {
  formatPerson,
  movementSourceLabel,
  type LocationConflictDetail,
  type MovementEvent,
  type StorageLocation,
} from '@materialmule/shared';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { BandedCard, ErrorState } from '../components/ui';
import { fetchAllLocations, fetchConflict, resolveConflict } from './api';
import { indexedDbMoveStore, type QueuedMove } from './store';
import './moves.css';

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
}

function describe(event: MovementEvent): string {
  const who = formatPerson(event.actor.initials, event.actor.name);
  const credited = event.mover
    ? ` for ${formatPerson(event.mover.initials, event.mover.name)}`
    : '';
  const station = event.station ? ` · station ${event.station}` : '';
  return `${who}${credited}${station}`;
}

function EventLine({ event, title }: { event: MovementEvent; title: string }) {
  return (
    <li className="conflict-event">
      <strong>{title}:</strong> {event.from.name} → {event.to.name}
      <br />
      <span className="muted">
        {describe(event)}. {movementSourceLabel(event.source)}.{' '}
        {event.scannedAt ? `Scanned ${formatTime(event.scannedAt)} (device clock), ` : ''}saved{' '}
        {formatTime(event.savedAt)}.
      </span>
      {event.note ? (
        <>
          <br />
          Note: {event.note}
        </>
      ) : null}
    </li>
  );
}

/**
 * An open location conflict on a storage unit (MM-T28, D29): both stories with times and people,
 * and, for a personal account, the form to confirm where the unit actually is after checking.
 * LAB can read it but never resolve it, whoever is chosen at the station. Device scan times are
 * shown as reported; nothing is chosen for the person by time.
 */
export function LocationConflictSection({
  conflictId,
  canResolve,
  onResolved,
}: {
  conflictId: string;
  canResolve: boolean;
  onResolved: () => void;
}) {
  const [conflict, setConflict] = useState<LocationConflictDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchConflict(conflictId).then((result) => {
      if (cancelled) return;
      if (result.kind === 'ok') {
        setConflict(result.data);
        setError(null);
      } else {
        setError('The location conflict couldn’t be loaded.');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conflictId, reloads]);

  if (error) {
    return (
      <BandedCard id="location-conflict" title="Location conflict" tone="attention">
        <ErrorState message={error} onRetry={() => setReloads((n) => n + 1)} />
      </BandedCard>
    );
  }
  if (!conflict) return null;

  return (
    <BandedCard id="location-conflict" title="Location conflict" tone="attention">
      <p>
        Moves of this unit disagree, so nothing was decided automatically. Its saved location is
        still <strong>{conflict.storageUnit.savedLocation.name}</strong>. Check where it actually
        is, then confirm.
      </p>
      <ul className="conflict-events">
        {conflict.savedEvent ? <EventLine event={conflict.savedEvent} title="Saved move" /> : null}
        {conflict.events.map((event) => (
          <EventLine
            key={event.id}
            event={event}
            title={event.kind === 'resolution' ? 'Confirmed' : 'Move not applied'}
          />
        ))}
      </ul>
      {!conflict.savedEvent ? (
        <p className="field-hint">
          The unit’s details were changed after these scans were taken (for example a correction).
        </p>
      ) : null}
      {canResolve ? (
        <ResolveForm conflict={conflict} onResolved={onResolved} onStale={setConflict} />
      ) : (
        <p className="notice notice-warning">
          A personal account must check the unit and confirm its location. The shared LAB station
          can’t, whoever is chosen there.
        </p>
      )}
    </BandedCard>
  );
}

function ResolveForm({
  conflict,
  onResolved,
  onStale,
}: {
  conflict: LocationConflictDetail;
  onResolved: () => void;
  onStale: (current: LocationConflictDetail) => void;
}) {
  const id = useId();
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  const [locationId, setLocationId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // One ID per confirmation the person makes: a retry after a lost answer reuses it.
  const [resolutionId, setResolutionId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    void fetchAllLocations().then((result) => {
      if (result.kind === 'ok') setLocations(result.data.filter((l) => l.active));
    });
  }, []);

  // Offer the locations named in the conflict first.
  const named = [
    conflict.storageUnit.savedLocation.id,
    ...conflict.events.map((event) => event.to.id),
  ];
  const ordered = [
    ...locations.filter((l) => named.includes(l.id)),
    ...locations.filter((l) => !named.includes(l.id)),
  ];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!locationId) {
      setMessage('Choose where the unit actually is.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await resolveConflict(conflict.id, {
      clientResolutionId: resolutionId,
      locationId,
      note: note.trim() || null,
      expectedUnitVersion: conflict.storageUnit.version,
      expectedConflictVersion: conflict.version,
    });
    setBusy(false);
    if (result.kind === 'ok') {
      onResolved();
      return;
    }
    if (result.kind === 'error' && result.status === 409) {
      const body = result.body as { message?: string; current?: LocationConflictDetail } | null;
      setMessage(body?.message ?? 'Something changed. Review the latest and confirm again.');
      setResolutionId(crypto.randomUUID());
      if (body?.current) onStale(body.current);
      return;
    }
    if (result.kind === 'error') {
      const body = result.body as { message?: string } | null;
      setMessage(body?.message ?? 'Material Mule refused this confirmation.');
      setResolutionId(crypto.randomUUID());
      return;
    }
    // No answer: the same confirmation can be sent again safely.
    setMessage('Material Mule couldn’t be reached. Try again; it won’t be recorded twice.');
  }

  return (
    <form className="conflict-form" onSubmit={(event) => void submit(event)}>
      <div className="form-field">
        <label htmlFor={`${id}-location`}>Actual location</label>
        <select
          id={`${id}-location`}
          value={locationId}
          onChange={(event) => setLocationId(event.target.value)}
        >
          <option value="">Choose after checking…</option>
          {ordered.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name} ({location.code})
            </option>
          ))}
        </select>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-note`}>Note (optional)</label>
        <textarea
          id={`${id}-note`}
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {message ? (
        <p className="field-error" role="alert">
          {message}
        </p>
      ) : null}
      <div>
        <button type="submit" className="primary" disabled={busy}>
          Confirm location
        </button>
      </div>
    </form>
  );
}

/**
 * Moves of this unit still queued on this computer (MM-T28): shown next to, never instead of,
 * the saved location. Read-only here; the Move screen sends them.
 */
export function PendingMoveNote({ unitId }: { unitId: string }) {
  const [pending, setPending] = useState<QueuedMove[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void indexedDbMoveStore
      .list()
      .then(({ moves }) => {
        if (cancelled) return;
        setPending(
          moves.filter(
            (move) =>
              move.unit.id === unitId && (move.state === 'pending' || move.state === 'waiting'),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setPending([]);
      });
    return () => {
      cancelled = true;
    };
  }, [unitId]);
  if (!pending || pending.length === 0) return <>None on this computer.</>;
  const last = pending[pending.length - 1]!;
  return (
    <span data-testid="pending-move">
      Pending → {last.destination.name} (scanned on this computer, not saved yet)
    </span>
  );
}
