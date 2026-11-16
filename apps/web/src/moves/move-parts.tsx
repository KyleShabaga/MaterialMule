import { formatClockTime, type ReceiverOption } from '@materialmule/shared';
import {
  ArrowRight,
  Check,
  ChevronsUpDown,
  CircleAlert,
  CloudOff,
  Info,
  MapPin,
  UserPlus,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { UnitStatusTag } from '@/components/strata/stage-tag';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import type { StationPeople } from '../session/recording-person-store';
import { PersonAvatar } from '../session/recording-person';
import { roleLineOf, type RecordingPerson } from '../session/station-people';
import type { ShelfItem, UnitItem } from './batch';
import { moveStatus, plural } from './format';
import type { PlaceRef, QueuedMove } from './store';

// Presentational parts of the Move screen (STRATA-80, round 3 boards R3Move*, R3PutAway).

const CODE = 'font-mono whitespace-nowrap';

/**
 * shadcn Item makes an ItemContent that follows another one `flex-none` (its content width), so
 * a long shelf path pushed the row past a phone's width. These grow, shrink and wrap instead.
 */
const SECOND_CONTENT = 'min-w-0 [flex:1_1_14rem]!';

/** "Moved by Pat Example · recording here", with Change on a LAB station. Attribution only. */
export function MovedBy({
  isLab,
  mover,
  recordingPerson,
  people,
  onChoose,
}: {
  isLab: boolean;
  mover: ReceiverOption | null;
  recordingPerson: RecordingPerson | null;
  people: StationPeople;
  onChoose: (mover: ReceiverOption) => void;
}) {
  const [searching, setSearching] = useState(false);
  const listed = people.state === 'ready' ? people.people : [];
  const choices =
    recordingPerson && !listed.some((person) => person.id === recordingPerson.id)
      ? [recordingPerson, ...listed]
      : listed;
  const staff = people.state === 'ready' ? people.staff.filter((person) => person.initials) : [];
  const recordingHere = recordingPerson !== null && mover?.id === recordingPerson.id;
  const choose = (person: { id: string; displayName: string; initials: string }) =>
    onChoose({ id: person.id, displayName: person.displayName, initials: person.initials });

  const menu = isLab ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="pointer-coarse:h-11"
          type="button"
          variant={mover ? 'ghost' : 'default'}
          size="sm"
          aria-label={mover ? `Change who is moving these units` : 'Choose who is moving'}
        >
          {mover ? 'Change' : 'Choose who is moving'}
          <ChevronsUpDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[13px] font-normal text-muted-foreground">
          Who is moving these units?
        </DropdownMenuLabel>
        {choices.map((person) => (
          <DropdownMenuItem
            key={person.id}
            className="gap-3 pointer-coarse:min-h-11"
            onSelect={() => choose(person)}
          >
            <PersonAvatar person={person} className="size-7" />
            <span className="grid leading-tight">
              <span>{person.displayName}</span>
              <span className="text-[13px] text-muted-foreground">
                {person.roleLine}
                {person.id === recordingPerson?.id ? ' · recording here' : ''}
              </span>
            </span>
            {person.id === mover?.id ? <Check aria-hidden="true" className="ml-auto" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-3 pointer-coarse:min-h-11"
          onSelect={() => setSearching(true)}
        >
          <UserPlus aria-hidden="true" />
          Someone else…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="moved-by">
      {mover ? (
        <>
          <span className="text-muted-foreground">Moved by</span>
          <PersonAvatar person={{ initials: mover.initials }} className="size-6" />
          <span className="font-semibold">{mover.displayName}</span>
          <span className="text-muted-foreground">
            · {recordingHere ? 'recording here' : 'recorded when you save'}
          </span>
        </>
      ) : (
        <span className="font-semibold text-destructive-text">
          Choose who is moving these units first
        </span>
      )}
      {menu ? <span className="ml-auto">{menu}</span> : null}
      {isLab ? (
        <Dialog open={searching} onOpenChange={setSearching}>
          <DialogContent className="overflow-hidden p-0">
            <DialogHeader className="sr-only">
              <DialogTitle>Who is moving these units?</DialogTitle>
              <DialogDescription>
                Search active staff by name or initials. It is attribution only.
              </DialogDescription>
            </DialogHeader>
            <Command>
              <CommandInput placeholder="Search by name or initials" aria-label="Search staff" />
              <CommandList>
                <CommandEmpty>
                  {people.state === 'error'
                    ? 'Staff couldn’t be loaded. Close this and try again.'
                    : 'No active staff match. Not listed? Ask an administrator to add them.'}
                </CommandEmpty>
                <CommandGroup heading="Active staff">
                  {staff.map((person) => (
                    <CommandItem
                      key={person.id}
                      value={`${person.initials} ${person.displayName}`}
                      onSelect={() => {
                        choose({ ...person, initials: person.initials! });
                        setSearching(false);
                      }}
                    >
                      <PersonAvatar person={{ initials: person.initials! }} className="size-7" />
                      <span className="grid leading-tight">
                        <span>{person.displayName}</span>
                        <span className="text-[13px] text-muted-foreground">
                          {roleLineOf(person)}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/** The "Moving to" card: the shelf, its term and the places after this move. */
export function DestinationCard({
  destination,
  path,
  termLabel,
  shelfLine,
  over,
  thereNow,
  coming,
  countsFrom,
  others,
  putAway,
}: {
  destination: PlaceRef | null;
  path: string;
  termLabel: string | null;
  shelfLine: string;
  over: number;
  thereNow: number;
  coming: number;
  /** When the counts are this computer's last copy (offline): the time it was online. */
  countsFrom: string | null;
  others: { place: PlaceRef; count: number }[];
  putAway: boolean;
}) {
  return (
    <section
      aria-labelledby="move-to-heading"
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5"
    >
      <h2 id="move-to-heading" className="m-0 text-sm font-semibold text-muted-foreground">
        Moving to
      </h2>
      {destination ? (
        <>
          <div className="grid gap-0.5">
            <p className="m-0 text-lg font-semibold" data-testid="move-destination">
              {path}
              {path.endsWith(destination.name) ? null : (
                <span className="sr-only"> ({destination.name})</span>
              )}
            </p>
            <p className="m-0 text-sm text-muted-foreground">
              <span className={CODE}>{destination.code}</span>
              {termLabel ? ` · ${termLabel}` : ''}
            </p>
          </div>
          <div className="grid gap-0.5">
            <p
              className={`m-0 text-sm font-semibold${over > 0 ? ' text-destructive-text' : ''}`}
              data-testid="move-shelf-after"
            >
              {shelfLine}
            </p>
            <p className="m-0 text-sm text-muted-foreground">
              {thereNow} there now · {coming} coming in this move
            </p>
            {over > 0 ? (
              <p className="m-0 text-sm text-destructive-text">
                More units than places. Check the shelf before you save.
              </p>
            ) : null}
          </div>
          {countsFrom ? (
            <p className="m-0 text-sm text-muted-foreground">
              Shelf counts are from {formatClockTime(countsFrom)}, the last time this computer was
              online.
            </p>
          ) : null}
          {others.length > 0 ? (
            <p className="m-0 text-sm text-muted-foreground">
              Earlier units go to{' '}
              {others.map((other, index) => (
                <span key={other.place.id}>
                  {index > 0 ? ', ' : ''}
                  <span className={CODE}>{other.place.code}</span> ({plural(other.count, 'unit')})
                </span>
              ))}
              . Each row says where it’s going.
            </p>
          ) : null}
          {putAway ? (
            <p className="m-0 text-sm text-muted-foreground">
              Units you don’t scan stay at Receiving until they’re put away.
            </p>
          ) : null}
        </>
      ) : (
        <div className="flex items-start gap-3">
          <MapPin aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="grid gap-0.5">
            <p className="m-0 font-semibold" data-testid="move-destination">
              No shelf yet
            </p>
            <p className="m-0 text-sm text-muted-foreground">
              Scan a shelf label to choose where units go. Units scanned first wait for it.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function Route({ from, to, note }: { from: PlaceRef | null; to: PlaceRef | null; note?: string }) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 text-sm">
      <span className="text-muted-foreground">From</span>
      <span className={CODE}>{from ? from.code : 'Unknown'}</span>
      {from ? <span className="sr-only"> ({from.name})</span> : null}
      <ArrowRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
      <span className="sr-only">to</span>
      {to ? (
        <>
          <span className="text-muted-foreground" aria-hidden="true">
            to
          </span>
          <span className={CODE}>{to.code}</span>
          <span className="sr-only"> ({to.name})</span>
        </>
      ) : (
        <span className="font-semibold">Scan a shelf label to set where these go</span>
      )}
      {note ? <span className="text-muted-foreground">{note}</span> : null}
    </p>
  );
}

function Problem({ children }: { children: string }) {
  return (
    <p className="m-0 flex items-start gap-1.5 text-sm text-destructive-text">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {children}
    </p>
  );
}

const UNIT_PROBLEM_TEXT = {
  not_found: 'No storage unit has this ID. Check the label and scan it again.',
  disposed: 'Disposed units can’t be moved. It keeps its ID and history.',
} as const;

/** One unit label: from → to, its stage tag, and its problem or saved state on its own row. */
export function UnitRow({
  item,
  move,
  syncingId,
  online,
  onRemove,
  onLookUp,
  onDismiss,
}: {
  item: UnitItem;
  move: QueuedMove | undefined;
  syncingId: string | null;
  online: boolean;
  onRemove: () => void;
  onLookUp: () => void;
  onDismiss: (clientMoveId: string) => void;
}) {
  const fromLab = item.unit?.recordStatus === 'in_lab';
  const queued = item.clientMoveId !== null;
  const status = queued ? moveStatus(move, syncingId, online) : null;
  const from = queued && move ? move.base.location : (item.unit?.location ?? null);
  const to = queued && move ? move.destination : item.destination;
  return (
    <Item size="sm" role="listitem" data-testid="move-row" className="items-start">
      <ItemContent className="min-w-40 flex-none basis-48">
        <ItemTitle className={CODE}>{item.readableId}</ItemTitle>
        <ItemDescription>
          {item.unit?.description ??
            (item.problem === 'lookup'
              ? 'This computer hasn’t seen this unit'
              : item.problem === 'not_found'
                ? 'Storage unit label'
                : 'Storage unit')}
        </ItemDescription>
      </ItemContent>
      <ItemContent className={`${SECOND_CONTENT} gap-1`}>
        {item.problem === 'not_found' || item.problem === 'disposed' ? (
          <Problem>{UNIT_PROBLEM_TEXT[item.problem]}</Problem>
        ) : (
          <Route from={from} to={to} note={fromLab ? 'back from the soils lab' : undefined} />
        )}
        {item.problem === 'lookup' ? (
          <p className="m-0 flex items-start gap-1.5 text-sm text-muted-foreground">
            <CloudOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {online
              ? 'Looking it up… If it’s disposed or unknown, you’ll see it here.'
              : 'Looked up when this computer is back online, then you save it. If it’s disposed or unknown, you’ll see it here.'}
          </p>
        ) : null}
        {move?.message &&
        (move.state === 'attention' || move.state === 'waiting' || move.state === 'conflict') ? (
          <Problem>{move.message}</Problem>
        ) : null}
        {item.repeats.length > 0 ? (
          <p className="m-0 flex items-start gap-1.5 text-sm text-muted-foreground">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            Scanned {item.repeats.length === 1
              ? 'twice'
              : `${item.repeats.length + 1} times`} at{' '}
            {formatClockTime(item.repeats[item.repeats.length - 1]!)} · listed once
          </p>
        ) : null}
        {move?.mover ? (
          <p className="m-0 text-[13px] text-muted-foreground">Moved by {move.mover.name}</p>
        ) : null}
        {move?.state === 'conflict' ? (
          <p className="m-0 text-sm">
            <Link
              className="text-link underline underline-offset-4"
              to={`/sample-storage/${encodeURIComponent(item.readableId)}`}
            >
              Open {item.readableId} to confirm its location
            </Link>
          </p>
        ) : null}
      </ItemContent>
      <ItemActions className="ml-auto">
        {item.undone ? (
          <Badge variant="closed">Move undone</Badge>
        ) : status ? (
          <Badge variant={status.variant}>
            {move?.state === 'saved' ? <Check aria-hidden="true" /> : null}
            {status.label}
          </Badge>
        ) : item.problem === 'lookup' ? (
          <>
            <Badge variant="due">Needs online lookup</Badge>
            <Button
              className="pointer-coarse:h-11"
              type="button"
              variant="outline"
              size="sm"
              disabled={!online}
              onClick={onLookUp}
            >
              Look up
            </Button>
          </>
        ) : item.unit?.recordStatus ? (
          <UnitStatusTag status={item.unit.recordStatus} />
        ) : null}
        {move && (move.state === 'attention' || move.state === 'waiting') ? (
          <Button
            className="pointer-coarse:h-11"
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onDismiss(move.clientMoveId)}
          >
            Dismiss
          </Button>
        ) : null}
        {!queued ? (
          <Button
            className="pointer-coarse:size-11"
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${item.readableId}`}
            onClick={onRemove}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </ItemActions>
    </Item>
  );
}

/** A queued move from an earlier list on this computer that the server hasn't settled. */
export function QueuedRow({
  move,
  syncingId,
  online,
  onDismiss,
}: {
  move: QueuedMove;
  syncingId: string | null;
  online: boolean;
  onDismiss: (clientMoveId: string) => void;
}) {
  const item: UnitItem = {
    key: move.clientMoveId,
    kind: 'unit',
    readableId: move.unit.readableId,
    scannedAt: move.createdAt,
    repeats: [],
    unit: null,
    destination: move.destination,
    problem: null,
    clientMoveId: move.clientMoveId,
  };
  return (
    <UnitRow
      item={item}
      move={move}
      syncingId={syncingId}
      online={online}
      onRemove={() => undefined}
      onLookUp={() => undefined}
      onDismiss={onDismiss}
    />
  );
}

const SHELF_PROBLEM_TEXT = {
  retired: 'This shelf is retired and can’t receive units.',
  not_found: 'No location has this label. Check it and scan again.',
  lookup: 'This computer hasn’t seen this shelf. Reconnect, then scan it again.',
} as const;

/** A shelf label in the list: where the units scanned after it go, or why it changed nothing. */
export function ShelfRow({
  item,
  units,
  path,
  stillGoingTo,
  onRemove,
}: {
  item: ShelfItem;
  units: number;
  path: string;
  /** For a problem shelf: where the units after it still go. */
  stillGoingTo: PlaceRef | null;
  onRemove: () => void;
}) {
  if (item.problem) {
    return (
      <Item size="sm" role="listitem" data-testid="move-shelf-row" className="items-start">
        <ItemContent className="min-w-40 flex-none basis-48">
          <ItemTitle className={CODE}>{item.place?.code ?? item.code}</ItemTitle>
          <ItemDescription>Shelf label</ItemDescription>
        </ItemContent>
        <ItemContent className={SECOND_CONTENT}>
          <Problem>
            {`${SHELF_PROBLEM_TEXT[item.problem]}${
              stillGoingTo ? ` Units scanned after it still go to ${stillGoingTo.code}.` : ''
            }`}
          </Problem>
        </ItemContent>
        <ItemActions className="ml-auto">
          <Button
            className="pointer-coarse:size-11"
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${item.place?.code ?? item.code}`}
            onClick={onRemove}
          >
            <X aria-hidden="true" />
          </Button>
        </ItemActions>
      </Item>
    );
  }
  return (
    <Item size="sm" variant="muted" role="listitem" data-testid="move-shelf-row">
      <ItemMedia variant="icon">
        <MapPin aria-hidden="true" />
      </ItemMedia>
      <ItemContent className="min-w-32 flex-none">
        <ItemTitle className={CODE}>{item.place!.code}</ItemTitle>
      </ItemContent>
      <ItemContent className={SECOND_CONTENT}>
        <ItemDescription className="line-clamp-none break-words">
          Shelf scanned. Units scanned after it go to {path}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="text-sm text-muted-foreground">{plural(units, 'unit')}</ItemActions>
    </Item>
  );
}

/** Put away: a receipt unit not scanned yet. Save never takes it. */
export function WaitingReceiptRow({
  readableId,
  description,
  from,
}: {
  readableId: string;
  description: string;
  from: PlaceRef;
}) {
  return (
    <Item size="sm" role="listitem" data-testid="move-waiting-row" className="opacity-80">
      <ItemContent className="min-w-40 flex-none basis-48">
        <ItemTitle className={CODE}>{readableId}</ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
      <ItemContent className={SECOND_CONTENT}>
        <p className="m-0 flex flex-wrap items-center gap-x-1.5 text-sm">
          <span className={CODE}>{from.code}</span>
          <ArrowRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Waiting for its label</span>
        </p>
      </ItemContent>
      <ItemActions className="ml-auto text-sm text-muted-foreground">Not scanned</ItemActions>
    </Item>
  );
}
