import {
  formatPerson,
  movementSourceLabel,
  type LocationConflictDetail,
  type MovementEvent,
  type StorageLocation,
} from '@materialmule/shared';
import { CircleAlert, MapPin, RotateCw } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { formatEventTime } from '../inventory/unit-record';
import { UnitSection } from '../inventory/UnitRecordParts';
import { NATIVE_SELECT_CLASS } from '../receiving/LabeledField';
import { fetchAllLocations, fetchConflict, resolveConflict } from './api';
import { indexedDbMoveStore, type QueuedMove } from './store';

function describe(event: MovementEvent): string {
  const who = formatPerson(event.actor.initials, event.actor.name);
  const credited = event.mover
    ? ` for ${formatPerson(event.mover.initials, event.mover.name)}`
    : '';
  const station = event.station ? ` · station ${event.station}` : '';
  return `${who}${credited}${station}`;
}

function EventItem({ event, title }: { event: MovementEvent; title: string }) {
  return (
    <Item size="sm" variant="outline" role="listitem">
      <ItemMedia variant="icon">
        <MapPin aria-hidden="true" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex-wrap">
          <span>{title}:</span>
          <span>
            {event.from.name} → {event.to.name}
          </span>
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {describe(event)}. {movementSourceLabel(event.source)}.{' '}
          {event.scannedAt ? `Scanned ${formatEventTime(event.scannedAt)} (device clock), ` : ''}
          saved {formatEventTime(event.savedAt)}.
          {event.note ? (
            <>
              <br />
              Note: {event.note}
            </>
          ) : null}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/**
 * An open location conflict on a storage unit (MM-T28, D29): both stories with times and people,
 * and, for a personal account, the form to confirm where the unit actually is after checking.
 * LAB can read it but never resolve it, whoever is chosen at the station. Device scan times are
 * shown as reported; nothing is chosen for the person by time. Strata record section (lane C).
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
      <UnitSection id="location-conflict" title="Location conflict">
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle className="line-clamp-none">{error}</AlertTitle>
          <AlertDescription>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-foreground pointer-coarse:h-11"
              onClick={() => setReloads((n) => n + 1)}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </UnitSection>
    );
  }
  if (!conflict) return null;

  return (
    <UnitSection id="location-conflict" title="Location conflict">
      <p className="m-0 text-sm">
        Moves of this unit disagree, so nothing was decided automatically. Its saved location is
        still <strong>{conflict.storageUnit.savedLocation.name}</strong>. Check where it actually
        is, then confirm.
      </p>
      <ItemGroup role="list" className="gap-2">
        {conflict.savedEvent ? <EventItem event={conflict.savedEvent} title="Saved move" /> : null}
        {conflict.events.map((event) => (
          <EventItem
            key={event.id}
            event={event}
            title={event.kind === 'resolution' ? 'Confirmed' : 'Move not applied'}
          />
        ))}
      </ItemGroup>
      {!conflict.savedEvent ? (
        <p className="m-0 text-sm text-muted-foreground">
          The unit’s details were changed after these scans were taken (for example a correction).
        </p>
      ) : null}
      {canResolve ? (
        <ResolveForm conflict={conflict} onResolved={onResolved} onStale={setConflict} />
      ) : (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertDescription className="text-foreground">
            A personal account must check the unit and confirm its location. The shared LAB station
            can’t, whoever is chosen there.
          </AlertDescription>
        </Alert>
      )}
    </UnitSection>
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

  const errorId = `${id}-error`;
  return (
    <form className="grid gap-4" noValidate onSubmit={(event) => void submit(event)}>
      <Field className="max-w-md gap-1.5">
        <FieldLabel htmlFor={`${id}-location`}>Actual location</FieldLabel>
        {/* Native select, as lane B keeps for long location lists; data-slot keeps it Strata. */}
        <select
          id={`${id}-location`}
          data-slot="native-select"
          className={NATIVE_SELECT_CLASS}
          value={locationId}
          aria-invalid={message !== null && !locationId ? true : undefined}
          aria-describedby={message ? errorId : undefined}
          onChange={(event) => setLocationId(event.target.value)}
        >
          <option value="">Choose after checking…</option>
          {ordered.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name} ({location.code})
            </option>
          ))}
        </select>
        <FieldDescription>Where you found it. The history keeps every scan.</FieldDescription>
      </Field>
      <Field className="max-w-md gap-1.5">
        <FieldLabel htmlFor={`${id}-note`}>Note (optional)</FieldLabel>
        <Textarea
          id={`${id}-note`}
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      {message ? <FieldError id={errorId}>{message}</FieldError> : null}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? <Spinner aria-hidden="true" /> : null}
          Confirm location
        </Button>
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
