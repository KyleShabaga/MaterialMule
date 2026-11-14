import {
  parseScanPayload,
  STORAGE_TERM_LABELS,
  type ReceiptDetail,
  type ReceiverOption,
  type StorageLocation,
  type StorageUnitDetail,
} from '@materialmule/shared';
import {
  Camera,
  Check,
  CircleAlert,
  ListX,
  LogIn,
  RefreshCw,
  ScanLine,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { initialsFor } from '@/components/strata/person-avatar';
import { notifySuccess } from '@/components/strata/toast';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { ItemGroup } from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { unitRecordStatus } from '../inventory/unit-record';
import { useOnline } from '../lib/online';
import { formatConfirmedAt, receiptName } from '../receiving-log/format';
import { CameraScanner } from '../scanning/CameraScanner';
import { readDecoderPreference } from '../scanning/decoder';
import { playScanTone, readScanSoundSetting } from '../scanning/feedback';
import { ScanField } from '../scanning/ScanField';
import { displayScannedValue } from '../scanning/scan-core';
import { useScanner } from '../scanning/useScanner';
import { useMe, useSession } from '../session/context';
import { useRecordingPerson } from '../session/recording-person';
import { toReceiver } from '../session/station-people';
import { fetchAllLocations, fetchReceipt, fetchUnit, resolveScan, undoMove } from './api';
import {
  addShelfItem,
  addUnitItem,
  comingTo,
  draftUnits,
  findDraftUnit,
  loadBatch,
  markSaved,
  otherDestinations,
  problemItems,
  readyUnits,
  removeItem,
  repeatUnit,
  replaceItem,
  saveBatch,
  startNewList,
  unitsAfterShelf,
  unitsWithoutShelf,
  type BatchState,
  type ShelfItem,
  type UnitFacts,
  type UnitItem,
} from './batch';
import { isoWithOffset, placePath, plural, shelfAfterText, unitDescription } from './format';
import { linkedUnits } from './move-link';
import {
  DestinationCard,
  MovedBy,
  QueuedRow,
  ShelfRow,
  UnitRow,
  WaitingReceiptRow,
} from './move-parts';
import { predecessorFor } from './queue';
import {
  indexedDbMoveStore,
  stationId,
  toStorageError,
  type CachedLocation,
  type CachedUnit,
  type PlaceRef,
} from './store';
import { useMoveQueue } from './useMoveQueue';
import { useToastClearance } from './useToastClearance';

function toFacts(detail: StorageUnitDetail): UnitFacts {
  return {
    id: detail.id,
    readableId: detail.readableId,
    version: detail.version,
    status: detail.status,
    location: detail.location,
    recordStatus: unitRecordStatus(detail),
    description: unitDescription(detail),
    fromCache: false,
  };
}

function cachedFacts(unit: CachedUnit): UnitFacts {
  return {
    id: unit.id,
    readableId: unit.readableId,
    version: unit.version,
    status: unit.status,
    location: unit.location,
    recordStatus: unit.recordStatus ?? null,
    description: unit.description ?? null,
    fromCache: true,
  };
}

function toCachedLocation(location: StorageLocation, cachedAt: string): CachedLocation {
  const term = location.effectiveStorageTerm?.term ?? location.storageTerm ?? null;
  return {
    id: location.id,
    code: location.code,
    name: location.name,
    active: location.active,
    cachedAt,
    parentId: location.parentId ?? null,
    capacity: location.capacity ?? null,
    inStockCount: location.inStockCount,
    termLabel: term ? `${STORAGE_TERM_LABELS[term]} storage` : null,
  };
}

type Announcement = { tone: 'success' | 'error' | 'warning'; text: string };

/**
 * Move storage units and Put away (STRATA-80, DESIGN.md › Round 3). Shelf and unit labels in any
 * order: a shelf label sets the destination for the units scanned after it, and units scanned
 * before any shelf wait for the first one; earlier rows keep theirs. Problems stay on their row.
 * Save moves stores each ready row as one durable intent in this computer's queue (MM-T28) and
 * sends it; a row reads as moved only after the server's acknowledgement. Offline, the moves wait
 * on this computer and go when it reconnects. Undo is lane 1C's audited compensating move.
 *
 * `?to=CODE` (a shelf's Move units here), `?units=ID1,ID2` or router state `{ units }`
 * (Inventory's selection, a unit's Move) add the shelf and the units as if scanned.
 * `?receipt=<id>` with `?units=` is Put away: the receipt's units wait for their labels.
 */
export function MovePage() {
  const me = useMe();
  const { refresh } = useSession();
  const online = useOnline();
  const recording = useRecordingPerson();
  const station = useMemo(() => stationId(), []);
  const isLab = me.accountType === 'shared_lab';
  const routerLocation = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const receiptId = searchParams.get('receipt');
  const store = indexedDbMoveStore;

  const [batch, setBatchState] = useState<BatchState>(() => loadBatch(me.id));
  const setBatch = useCallback(
    (update: (current: BatchState) => BatchState) => {
      setBatchState((current) => {
        const next = update(current);
        saveBatch(me.id, next);
        return next;
      });
    },
    [me.id],
  );
  const batchRef = useRef(batch);
  useEffect(() => {
    batchRef.current = batch;
  });

  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [camera, setCamera] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * Queue IDs of the save in progress. Between storing a row's intent and marking the row with its
   * ID, the move is already in the queue: it must not also show under "Waiting to send".
   */
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sessionEnded, setSessionEnded] = useState(false);
  // A toast ("4 moves saved · Undo") never covers the Save bar: the bar rises above it.
  const saveBar = useRef<HTMLDivElement | null>(null);
  const toastClearance = useToastClearance(saveBar);
  const [places, setPlaces] = useState<{ byId: Map<string, CachedLocation>; cached: boolean }>(
    () => ({ byId: new Map(), cached: false }),
  );
  const [receipt, setReceipt] = useState<ReceiptDetail | null>(null);

  // Moved by: on a LAB station the recording person until someone is chosen here by hand.
  const stationMover = recording.person ? toReceiver(recording.person) : null;
  const mover: ReceiverOption | null = isLab
    ? (batch.mover ?? stationMover)
    : {
        id: me.id,
        displayName: me.displayName,
        initials: me.initials ?? initialsFor(me.displayName),
      };
  const moverRef = useRef(mover);
  useEffect(() => {
    moverRef.current = mover;
  });

  const queue = useMoveQueue({
    accountId: me.id,
    onSettled: (settled) => {
      // Keep this computer's copy current so the next offline scan has an honest base.
      for (const move of settled) {
        if (move.state === 'saved' && move.result?.resultingVersion) {
          void store
            .getUnit(move.unit.readableId)
            .then((cached) =>
              store.putUnit({
                ...(cached ?? { status: 'in_stock' as const }),
                readableId: move.unit.readableId,
                id: move.unit.id,
                version: move.result!.resultingVersion!,
                location: move.destination,
                cachedAt: new Date().toISOString(),
              }),
            )
            .catch(() => undefined);
        }
      }
    },
  });
  const queueRef = useRef(queue);
  useEffect(() => {
    queueRef.current = queue;
  });
  const byId = useMemo(
    () => new Map(queue.moves.map((move) => [move.clientMoveId, move])),
    [queue.moves],
  );

  // This computer's location list: current while online (so offline shelf scans work), and its
  // last copy offline. Saved moves refresh it, so the shelf preview counts what the server has.
  const savedCount = queue.moves.filter((move) => move.state === 'saved').length;
  useEffect(() => {
    let cancelled = false;
    if (!online) {
      void store
        .listLocations?.()
        .then((list) => {
          if (cancelled || list.length === 0) return;
          setPlaces((current) =>
            current.byId.size > 0
              ? current
              : { byId: new Map(list.map((l) => [l.id, l])), cached: true },
          );
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
    void fetchAllLocations().then((result) => {
      if (cancelled || result.kind !== 'ok') return;
      const cachedAt = new Date().toISOString();
      const list = result.data.map((location) => toCachedLocation(location, cachedAt));
      setPlaces({ byId: new Map(list.map((l) => [l.id, l])), cached: false });
      void store.putLocations(list).catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [online, store, savedCount]);

  // Put away: the receipt, named by its date and receiver.
  useEffect(() => {
    if (!receiptId) return;
    let cancelled = false;
    void fetchReceipt(receiptId).then((result) => {
      if (!cancelled && result.kind === 'ok') setReceipt(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [receiptId]);

  function announce(next: Announcement) {
    setAnnouncement(next);
    if (readScanSoundSetting()) playScanTone(next.tone === 'success' ? 'success' : 'failure');
  }

  /** The next label after a save starts a new list (settled rows leave it). */
  function beginScan() {
    if (batchRef.current.lastSave) {
      setBatch((current) =>
        startNewList(
          current,
          (id) => queueRef.current.moves.find((m) => m.clientMoveId === id)?.state,
        ),
      );
    }
  }

  /** The unit as the server has it now, or this computer's last copy when offline. */
  async function findUnit(
    readableId: string,
  ): Promise<UnitFacts | 'not_found' | 'uncached' | 'signin'> {
    const answer = await fetchUnit(readableId);
    if (answer.kind === 'ok') {
      const facts = toFacts(answer.data);
      void store
        .putUnit({
          readableId: facts.readableId,
          id: facts.id,
          version: facts.version,
          status: facts.status,
          location: facts.location,
          recordStatus: facts.recordStatus,
          description: facts.description,
          cachedAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      return facts;
    }
    if (answer.kind === 'not_found') return 'not_found';
    if (answer.kind === 'error' && answer.status === 401) return 'signin';
    const cached = await store.getUnit(readableId).catch(() => null);
    return cached ? cachedFacts(cached) : 'uncached';
  }

  async function addUnit(readableId: string, fromLink = false) {
    const existing = findDraftUnit(batchRef.current.items, readableId);
    if (existing) {
      if (fromLink) return;
      setBatch((current) => repeatUnit(current, existing.key, new Date().toISOString()));
      const going = existing.destination ? ` It still goes to ${existing.destination.code}.` : '';
      announce({
        tone: 'warning',
        text: `${readableId} is already in this batch. Listed once.${going}`,
      });
      return;
    }
    const scannedAt = isoWithOffset(new Date());
    const found = await findUnit(readableId);
    const base = {
      key: crypto.randomUUID(),
      kind: 'unit' as const,
      readableId,
      scannedAt,
      repeats: [],
      clientMoveId: null,
    };
    if (found === 'signin') {
      // Nothing lost: the label stays on the list and is looked up after signing in again.
      setSessionEnded(true);
      setBatch((current) => addUnitItem(current, { ...base, unit: null, problem: 'lookup' }));
      announce({
        tone: 'error',
        text: `Your session has ended. ${readableId} is kept on the list.`,
      });
      return;
    }
    if (found === 'not_found') {
      setBatch((current) => addUnitItem(current, { ...base, unit: null, problem: 'not_found' }));
      announce({ tone: 'error', text: `No storage unit has the ID ${readableId}.` });
      return;
    }
    if (found === 'uncached') {
      // Never invent a unit, version or status: keep the label visibly; nothing is queued.
      setBatch((current) => addUnitItem(current, { ...base, unit: null, problem: 'lookup' }));
      announce({ tone: 'warning', text: `${readableId} needs online lookup.` });
      return;
    }
    if (found.status === 'disposed') {
      setBatch((current) => addUnitItem(current, { ...base, unit: found, problem: 'disposed' }));
      announce({
        tone: 'error',
        text: `${readableId} is disposed. Disposed units can’t be moved.`,
      });
      return;
    }
    setBatch((current) => addUnitItem(current, { ...base, unit: found, problem: null }));
    const destination = batchRef.current.destination;
    announce({
      tone: 'success',
      text: destination
        ? `Added ${readableId}, moving from ${found.location.code} to ${destination.code}.`
        : `Added ${readableId}. Scan a shelf label to set where it goes.`,
    });
  }

  async function addShelf(code: string) {
    const parsed = parseScanPayload(code);
    const locationCode = parsed.type === 'location' ? parsed.code : code;
    const scannedAt = isoWithOffset(new Date());
    const shelf = (place: PlaceRef | null, problem: ShelfItem['problem']): ShelfItem => ({
      key: crypto.randomUUID(),
      kind: 'shelf',
      code: locationCode,
      place,
      scannedAt,
      problem,
    });
    let place: PlaceRef & { active: boolean };
    const answer = await resolveScan(code);
    if (answer.kind === 'ok') {
      if (answer.data.type !== 'location') {
        setBatch((current) => addShelfItem(current, shelf(null, 'not_found')));
        announce({ tone: 'error', text: `No location has the label ${locationCode}.` });
        return;
      }
      place = answer.data.location;
    } else if (answer.kind === 'error' && answer.status === 401) {
      setSessionEnded(true);
      announce({
        tone: 'error',
        text: 'Your session has ended. Sign in again, then scan the shelf.',
      });
      return;
    } else {
      const cached = await store.getLocation(locationCode).catch(() => null);
      if (!cached) {
        setBatch((current) => addShelfItem(current, shelf(null, 'lookup')));
        announce({ tone: 'warning', text: `${locationCode} needs online lookup.` });
        return;
      }
      place = cached;
    }
    const ref = { id: place.id, code: place.code, name: place.name };
    if (!place.active) {
      setBatch((current) => addShelfItem(current, shelf(ref, 'retired')));
      const still = batchRef.current.destination;
      announce({
        tone: 'error',
        text: `${ref.code} is retired and can’t receive units.${still ? ` Units still go to ${still.code}.` : ''}`,
      });
      return;
    }
    if (batchRef.current.destination?.id === ref.id) {
      announce({ tone: 'warning', text: `Already moving to ${ref.code}.` });
      return;
    }
    const waiting = unitsWithoutShelf(batchRef.current.items).length;
    setBatch((current) => addShelfItem(current, shelf(ref, null)));
    announce({
      tone: 'success',
      text: `Moving to ${ref.code}.${waiting > 0 ? ` ${plural(waiting, 'waiting unit')} go there too.` : ' Units scanned next go here.'}`,
    });
  }

  async function handleScan(code: string, fromLink = false) {
    if (isLab && !moverRef.current) {
      announce({ tone: 'error', text: 'Choose who is moving these units first.' });
      return;
    }
    beginScan();
    const parsed = parseScanPayload(code);
    if (parsed.type === 'location') return addShelf(code);
    if (parsed.type === 'storage_unit') return addUnit(parsed.readableId, fromLink);
    announce({ tone: 'error', text: `${displayScannedValue(code)} isn’t a Material Mule label.` });
  }

  // Labels are handled one at a time, in the order they were read.
  const chain = useRef(Promise.resolve());
  function onScan(code: string, fromLink = false) {
    chain.current = chain.current.then(() => handleScan(code, fromLink)).catch(() => undefined);
  }
  const scanner = useScanner({
    onScan: (code) => onScan(code),
    onDuplicate: (code) => {
      const parsed = parseScanPayload(code);
      const existing =
        parsed.type === 'storage_unit'
          ? findDraftUnit(batchRef.current.items, parsed.readableId)
          : null;
      if (existing) {
        setBatch((current) => repeatUnit(current, existing.key, new Date().toISOString()));
        announce({
          tone: 'warning',
          text: `${parsed.type === 'storage_unit' ? parsed.readableId : code} is already in this batch. Listed once.`,
        });
      } else {
        announce({ tone: 'warning', text: `${displayScannedValue(code)} was already scanned.` });
      }
    },
  });

  // Linked shelf and units (a shelf page, Inventory's selection, a unit's Move): once per page.
  const linked = useMemo(
    () => linkedUnits(searchParams, routerLocation.state),
    // Read once from the link that opened the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const destinationCode = searchParams.get('to');
  const appliedLink = useRef(false);
  useEffect(() => {
    if (appliedLink.current) return;
    if (isLab && !moverRef.current) return;
    appliedLink.current = true;
    if (destinationCode && batchRef.current.destination?.code !== destinationCode) {
      onScan(`LOC-${destinationCode}`, true);
    }
    // Put away lists the receipt's units as waiting for their labels instead.
    if (!receiptId && linked.length > 0) {
      for (const id of linked) onScan(id, true);
      // Applied once: take them out of the URL and router state, so a remount or reload (the list
      // itself is kept in this tab) never scans them in again after a save.
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('units');
          return next;
        },
        { replace: true, state: null },
      );
    }
    // onScan only chains the scan; it is safe to call once per link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mover?.id]);

  /** A label kept for lookup (offline, or session ended): look it up again. */
  async function lookUp(item: UnitItem) {
    const found = await findUnit(item.readableId);
    if (found === 'signin') {
      setSessionEnded(true);
      return;
    }
    if (found === 'uncached' || (typeof found !== 'string' && found.fromCache)) return;
    const next: UnitItem =
      found === 'not_found'
        ? { ...item, unit: null, problem: 'not_found' }
        : { ...item, unit: found, problem: found.status === 'disposed' ? 'disposed' : null };
    setBatch((current) => replaceItem(current, item.key, next));
    announce({
      tone: next.problem ? 'error' : 'success',
      text: next.problem
        ? `${item.readableId}: ${next.problem === 'disposed' ? 'disposed units can’t be moved' : 'no storage unit has this ID'}.`
        : `${item.readableId} looked up. Save to move it.`,
    });
  }

  // Back online (or signed in again): look up the labels this computer couldn't.
  const lookups = draftUnits(batch.items).filter((item) => item.problem === 'lookup');
  const lookupKeys = lookups.map((item) => item.key).join(',');
  useEffect(() => {
    if (!online || sessionEnded || lookups.length === 0) return;
    chain.current = chain.current
      .then(async () => {
        for (const item of lookups) await lookUp(item);
      })
      .catch(() => undefined);
    // Keyed on the rows waiting, not on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, sessionEnded, lookupKeys]);

  async function save() {
    const current = batchRef.current;
    const rows = readyUnits(current.items);
    const who = moverRef.current;
    if (rows.length === 0 || (isLab && !who)) return;
    setSaving(true);
    const ids = rows.map(() => crypto.randomUUID());
    setSavingIds(new Set(ids));
    const saved = new Map<string, string>();
    let failure: string | null = null;
    for (const [index, row] of rows.entries()) {
      const unit = row.unit!;
      const destination = row.destination!;
      const previous = predecessorFor(queueRef.current.moves, unit.id, me.id, station);
      const clientMoveId = ids[index]!;
      const baseVersion = previous ? previous.request.baseVersion : unit.version;
      try {
        await queueRef.current.enqueue({
          clientMoveId,
          request: {
            clientMoveId,
            storageUnitId: unit.id,
            toLocationId: destination.id,
            baseVersion,
            scannedAt: row.scannedAt,
            capturedOffline: unit.fromCache || !navigator.onLine,
            ...(previous ? { previousClientMoveId: previous.clientMoveId } : {}),
            captureContext: {
              stationId: station,
              accountId: me.id,
              ...(isLab && who ? { moverUserId: who.id } : {}),
            },
          },
          unit: { id: unit.id, readableId: unit.readableId },
          base: {
            version: baseVersion,
            location: previous ? previous.destination : unit.location,
          },
          destination,
          account: { id: me.id, name: me.displayName },
          mover:
            isLab && who ? { id: who.id, initials: who.initials, name: who.displayName } : null,
          state: 'pending',
          attempts: 0,
          message: null,
          result: null,
        });
        saved.set(row.key, clientMoveId);
      } catch (error) {
        // Durable first: a row that couldn't be stored stays on the list, unsaved and unsent.
        failure = `${toStorageError(error).message} ${unit.readableId} and the rows after it weren’t saved.`;
        break;
      }
    }
    if (saved.size > 0) {
      setBatch((state) => markSaved(state, saved, new Date().toISOString()));
    }
    // One render: the rows take their IDs as the in-progress set is cleared.
    setSavingIds(new Set());
    setSaving(false);
    if (failure) announce({ tone: 'error', text: failure });
    else
      announce({
        tone: 'success',
        text: navigator.onLine
          ? `Saving ${plural(saved.size, 'move')}…`
          : `${plural(saved.size, 'move')} kept on this computer. They are sent when it reconnects.`,
      });
  }

  // "All moves saved." once the server answered every move of the last save, with Undo.
  const lastSave = batch.lastSave;
  const lastMoves = lastSave ? lastSave.clientMoveIds.map((id) => byId.get(id)) : [];
  const lastSettled =
    lastSave !== null &&
    lastMoves.length > 0 &&
    lastMoves.every((move) => move && move.state !== 'pending' && move.state !== 'waiting');
  const lastSaved = lastMoves.filter((move) => move?.state === 'saved');
  const allSaved = lastSettled && lastSaved.length === lastMoves.length;
  function notifySaved() {
    setBatch((current) =>
      current.lastSave
        ? { ...current, lastSave: { ...current.lastSave, notified: true } }
        : current,
    );
    const done = lastSaved.filter((move) => move?.result?.movementEventId);
    if (allSaved) announce({ tone: 'success', text: 'All moves saved.' });
    else
      announce({
        tone: 'warning',
        text: `${plural(lastSaved.length, 'move')} saved. ${plural(lastMoves.length - lastSaved.length, 'move')} need attention.`,
      });
    if (done.length === 0) return;
    const keys = new Map(done.map((move) => [move!.clientMoveId, crypto.randomUUID()]));
    notifySuccess(`${plural(done.length, 'move')} saved`, {
      description: done[0]!.mover ? `Moved by ${done[0]!.mover.name}.` : undefined,
      undo: {
        doneMessage: done.length === 1 ? 'Move undone' : 'Moves undone',
        run: async () => {
          const undone: string[] = [];
          let refused: unknown = null;
          for (const move of done) {
            const result = await undoMove({
              sourceId: move!.result!.movementEventId!,
              idempotencyKey: keys.get(move!.clientMoveId)!,
              ...(move!.request.captureContext.moverUserId
                ? { moverUserId: move!.request.captureContext.moverUserId }
                : {}),
            });
            if (result.kind === 'ok') undone.push(move!.clientMoveId);
            else
              refused ??=
                result.kind === 'error'
                  ? result.body
                  : result.kind === 'not_found'
                    ? { blockedReason: 'not_found' }
                    : new Error('Material Mule couldn’t be reached. The moves stay saved.');
          }
          if (undone.length > 0) {
            setBatch((current) => ({
              ...current,
              items: current.items.map((item) =>
                item.kind === 'unit' && item.clientMoveId && undone.includes(item.clientMoveId)
                  ? { ...item, undone: true }
                  : item,
              ),
            }));
          }
          if (refused) throw refused;
        },
      },
    });
  }

  const notifiedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!lastSave || lastSave.notified || !lastSettled) return;
    if (notifiedFor.current === lastSave.at) return;
    notifiedFor.current = lastSave.at;
    // After this render: the toast and the "notified" mark belong to the settled save.
    queueMicrotask(() => notifySaved());
    // Runs once per save, when it settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSettled, lastSave?.at]);

  // What the list and the bar say.
  const ready = readyUnits(batch.items);
  const problems = problemItems(batch.items);
  const noShelf = unitsWithoutShelf(batch.items);
  const mine = queue.moves.filter((move) => move.request.captureContext.accountId === me.id);
  const inList = new Set(
    batch.items.flatMap((item) =>
      item.kind === 'unit' && item.clientMoveId ? [item.clientMoveId] : [],
    ),
  );
  const earlier = mine.filter(
    (move) =>
      !inList.has(move.clientMoveId) &&
      !savingIds.has(move.clientMoveId) &&
      (move.state === 'pending' ||
        move.state === 'waiting' ||
        move.state === 'attention' ||
        move.state === 'conflict'),
  );
  const waitingToSend = mine.filter((move) => move.state === 'pending' || move.state === 'waiting');
  const heldForOthers = queue.moves.filter(
    (move) =>
      move.request.captureContext.accountId !== me.id &&
      (move.state === 'pending' || move.state === 'waiting'),
  );
  const syncingId = queue.status.kind === 'syncing' ? queue.status.clientMoveId : null;
  const signedOut = sessionEnded || queue.status.kind === 'signin';

  // Destination card.
  const destination = batch.destination;
  const info = destination ? places.byId.get(destination.id) : undefined;
  const thereNow = info?.inStockCount ?? 0;
  const coming = destination ? comingTo(batch.items, destination.id) : 0;
  const shelf = shelfAfterText(thereNow, coming, info?.capacity ?? null);
  const pathOf = (place: PlaceRef) => placePath(place, places.byId);

  // Put away: the receipt's units not scanned yet.
  const onList = new Set(
    batch.items.flatMap((item) => (item.kind === 'unit' ? [item.readableId] : [])),
  );
  const waitingFromReceipt = receipt
    ? receipt.units.filter((unit) => unit.status !== 'disposed' && !onList.has(unit.readableId))
    : [];
  const linkedWaiting = receiptId && !receipt ? linked.filter((id) => !onList.has(id)) : [];
  const putAway = receiptId !== null;
  const receiptTitle = receipt ? `Receipt ${receiptName(receipt)}` : 'Receipt';

  const rows = [...batch.items].reverse();
  const listHeading = putAway
    ? 'From this receipt'
    : lastSave && draftUnits(batch.items).length === 0
      ? allSaved
        ? 'Saved in this move'
        : 'Waiting to send'
      : 'Scanned';
  const scannedCount = batch.items.filter((item) => item.kind === 'unit').length;
  const listMeta = putAway
    ? `${scannedCount} of ${scannedCount + waitingFromReceipt.length + linkedWaiting.length} scanned`
    : lastSave && draftUnits(batch.items).length === 0
      ? plural(lastSave.clientMoveIds.length, 'unit')
      : rows.length > 0
        ? `newest first · ${plural(rows.length, 'label')}`
        : '';

  let barText: string;
  if (ready.length === 0 && problems.length === 0 && noShelf.length === 0) {
    barText =
      waitingToSend.length > 0
        ? `${plural(waitingToSend.length, 'move')} waiting to send`
        : lastSave && allSaved
          ? 'Scan the next shelf or unit to start a new move.'
          : 'Nothing to save yet';
  } else {
    const parts = [`${plural(ready.length, 'unit')} ready to move`];
    if (problems.length > 0) parts.push(`${plural(problems.length, 'problem')} won’t be saved`);
    if (noShelf.length > 0) parts.push(`${noShelf.length} waiting for a shelf`);
    if (putAway && waitingFromReceipt.length + linkedWaiting.length > 0)
      parts.push(`${waitingFromReceipt.length + linkedWaiting.length} still to scan`);
    if (signedOut) parts.push('sign in to save');
    barText = parts.join(' · ');
  }
  if (isLab && mover && ready.length === 0 && !lastSave)
    barText += ` · moves are recorded as ${mover.displayName}`;
  const canSave = ready.length > 0 && !saving && !signedOut && !(isLab && !mover);

  return (
    <div className="relative flex min-h-full flex-col">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 pt-6 pb-28 md:px-8">
        <div className="flex flex-col gap-3">
          <Breadcrumb>
            <BreadcrumbList>
              {putAway ? (
                <>
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <Link to="/receiving-log">Receiving log</Link>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <Link to={`/receiving-log/${encodeURIComponent(receiptId)}`}>
                        {receiptTitle}
                      </Link>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>Put away</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              ) : (
                <>
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <Link to="/sample-storage">Inventory</Link>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>Move</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="grid gap-1">
            <h1 className="m-0 text-3xl font-semibold tracking-tight">
              {putAway ? 'Put away' : 'Move storage units'}
            </h1>
            <p className="m-0 text-sm text-muted-foreground">
              {putAway && receipt
                ? `${plural(receipt.units.filter((unit) => unit.status !== 'disposed').length, 'storage unit')} from ${receipt.receiver.name}’s receipt, confirmed ${formatConfirmedAt(receipt.confirmedAt)}. Scan the shelf and the units in any order.`
                : 'Scan shelf and unit labels in any order. A shelf label sets where the units after it go.'}
            </p>
          </div>
        </div>

        {signedOut ? (
          <Alert variant="destructive">
            <LogIn aria-hidden="true" />
            <AlertTitle className="line-clamp-none">Your session has ended.</AlertTitle>
            <AlertDescription>
              <p>
                Sign in again to save these moves. Nothing is lost: the list stays on this computer.
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-2 pointer-coarse:h-11"
                onClick={() => {
                  setSessionEnded(false);
                  void refresh();
                }}
              >
                <LogIn aria-hidden="true" />
                Sign in again
              </Button>
            </AlertDescription>
          </Alert>
        ) : !online ? (
          <Alert>
            <WifiOff aria-hidden="true" />
            <AlertTitle className="line-clamp-none">This computer is offline.</AlertTitle>
            <AlertDescription>
              Moves are kept on this computer and sent when it reconnects. Nothing is lost, and you
              can keep scanning.
            </AlertDescription>
          </Alert>
        ) : lastSave && allSaved && draftUnits(batch.items).length === 0 ? (
          <Alert>
            <Check aria-hidden="true" />
            <AlertTitle className="line-clamp-none">All moves saved.</AlertTitle>
            <AlertDescription>
              {plural(lastSaved.length, 'storage unit')} moved
              {lastSaved[0]?.mover ? ` by ${lastSaved[0].mover.name}` : ` by ${me.displayName}`}.
              Inventory and the shelves show their new places.
            </AlertDescription>
          </Alert>
        ) : null}
        {queue.status.kind === 'forbidden' || queue.status.kind === 'storage' ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle className="line-clamp-none">{queue.status.message}</AlertTitle>
          </Alert>
        ) : null}
        {heldForOthers.length > 0 ? (
          <Alert>
            <CircleAlert aria-hidden="true" />
            <AlertDescription className="text-foreground">
              {plural(heldForOthers.length, 'move')} scanned on this computer by{' '}
              {heldForOthers[0]!.account.name} {heldForOthers.length === 1 ? 'is' : 'are'} waiting.{' '}
              {heldForOthers.length === 1 ? 'It is' : 'They are'} only sent when{' '}
              {heldForOthers[0]!.account.name} signs in here.
            </AlertDescription>
          </Alert>
        ) : null}
        {queue.unreadable > 0 ? (
          <Alert>
            <CircleAlert aria-hidden="true" />
            <AlertDescription className="text-foreground">
              {queue.unreadable} queued move record(s) were saved by a newer version of Material
              Mule. They are kept, not sent. Update this computer’s page to send them.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="@container">
          <div className="grid gap-4 @[44rem]:grid-cols-2">
            <section
              aria-labelledby="move-scan-heading"
              className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5"
            >
              <h2 id="move-scan-heading" className="sr-only">
                Scan
              </h2>
              <MovedBy
                isLab={isLab}
                mover={mover}
                recordingPerson={recording.person}
                people={recording.people}
                onChoose={(next) => {
                  setBatch((current) => ({
                    ...current,
                    mover: next.id === stationMover?.id ? null : next,
                  }));
                  scanner.resume();
                }}
              />
              <ScanField
                scanner={scanner}
                disabled={isLab && !mover}
                description={
                  isLab && !mover ? 'Scanning starts once you choose who is moving.' : undefined
                }
              >
                <div>
                  <Button
                    className="pointer-coarse:h-11"
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCamera(true)}
                  >
                    <Camera aria-hidden="true" />
                    Scan with camera
                  </Button>
                </div>
              </ScanField>
              {camera ? (
                <CameraScanner
                  decoderPreference={readDecoderPreference(window.location.search)}
                  onClose={() => setCamera(false)}
                  onFound={() => setCamera(false)}
                  onDecoded={(code) => {
                    setCamera(false);
                    onScan(code);
                  }}
                />
              ) : null}
            </section>
            <DestinationCard
              destination={destination}
              path={destination ? pathOf(destination) : ''}
              termLabel={info?.termLabel ?? null}
              shelfLine={shelf.line}
              over={shelf.over}
              thereNow={thereNow}
              coming={coming}
              countsFrom={places.cached && info ? info.cachedAt : null}
              others={otherDestinations(batch.items, destination?.id ?? null)}
              putAway={putAway}
            />
          </div>
        </div>

        <section aria-labelledby="move-list-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="move-list-heading" className="m-0 text-base font-semibold">
              {listHeading}
            </h2>
            {listMeta ? (
              <span className="text-[13px] text-muted-foreground">{listMeta}</span>
            ) : null}
          </div>
          {lastSave && lastSave.dropped > 0 && draftUnits(batch.items).length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">
              {plural(lastSave.dropped, 'label')} {lastSave.dropped === 1 ? 'wasn’t' : 'weren’t'}{' '}
              saved. Scan {lastSave.dropped === 1 ? 'it' : 'them'} again once{' '}
              {lastSave.dropped === 1 ? 'it’s' : 'they’re'} fixed.
            </p>
          ) : null}
          {rows.length === 0 && waitingFromReceipt.length === 0 && linkedWaiting.length === 0 ? (
            <Empty className="rounded-xl border border-dashed py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ScanLine aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Scan a shelf or a unit label to start.</EmptyTitle>
                <EmptyDescription>
                  Labels can come in any order. Each unit shows where it’s going before you save.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup
              role="list"
              aria-labelledby="move-list-heading"
              className="gap-1 rounded-xl border bg-card p-1"
            >
              {rows.map((item) =>
                item.kind === 'unit' ? (
                  <UnitRow
                    key={item.key}
                    item={item}
                    move={item.clientMoveId ? byId.get(item.clientMoveId) : undefined}
                    syncingId={syncingId}
                    online={online}
                    onRemove={() => setBatch((current) => removeItem(current, item.key))}
                    onLookUp={() => {
                      chain.current = chain.current.then(() => lookUp(item)).catch(() => undefined);
                    }}
                    onDismiss={(id) => void queue.dismiss(id)}
                  />
                ) : (
                  <ShelfRow
                    key={item.key}
                    item={item}
                    units={unitsAfterShelf(batch.items, item.key)}
                    path={item.place ? pathOf(item.place) : item.code}
                    stillGoingTo={item.problem ? destination : null}
                    onRemove={() => setBatch((current) => removeItem(current, item.key))}
                  />
                ),
              )}
              {waitingFromReceipt.map((unit) => (
                <WaitingReceiptRow
                  key={unit.id}
                  readableId={unit.readableId}
                  description={unitDescription(unit)}
                  from={unit.location}
                />
              ))}
              {linkedWaiting.map((id) => (
                <WaitingReceiptRow
                  key={id}
                  readableId={id}
                  description="From this receipt"
                  from={{ id: 'receiving', code: 'Receiving', name: 'Receiving' }}
                />
              ))}
            </ItemGroup>
          )}
        </section>

        {earlier.length > 0 ? (
          <section aria-labelledby="move-earlier-heading" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="move-earlier-heading" className="m-0 text-base font-semibold">
                Waiting to send
              </h2>
              <span className="text-[13px] text-muted-foreground">
                queued on this computer · {plural(earlier.length, 'unit')}
              </span>
            </div>
            <ItemGroup
              role="list"
              aria-labelledby="move-earlier-heading"
              className="gap-1 rounded-xl border bg-card p-1"
            >
              {earlier.map((move) => (
                <QueuedRow
                  key={move.clientMoveId}
                  move={move}
                  syncingId={syncingId}
                  online={online}
                  onDismiss={(id) => void queue.dismiss(id)}
                />
              ))}
            </ItemGroup>
          </section>
        ) : null}
      </div>

      {/* The sticky Save bar: one primary per screen. */}
      <div
        ref={saveBar}
        data-testid="move-save-bar"
        className="sticky bottom-0 z-10 mt-auto border-t bg-background/95 backdrop-blur"
        style={toastClearance > 0 ? { bottom: toastClearance } : undefined}
      >
        <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-3 px-4 py-3 md:px-8">
          <p className="m-0 min-w-0 flex-1 text-sm text-muted-foreground" data-testid="move-bar">
            {barText}
          </p>
          {waitingToSend.length > 0 && online && !signedOut ? (
            <Button
              className="pointer-coarse:h-11"
              type="button"
              variant="outline"
              size="sm"
              onClick={queue.syncNow}
            >
              <RefreshCw aria-hidden="true" />
              Try sending now
            </Button>
          ) : null}
          {draftUnits(batch.items).length > 0 ||
          batch.items.some((item) => item.kind === 'shelf') ? (
            <Button
              className="pointer-coarse:h-11"
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setBatch((current) => ({
                  ...current,
                  items: current.items.filter((item) => item.kind === 'unit' && item.clientMoveId),
                }));
                scanner.resume();
              }}
            >
              <ListX aria-hidden="true" />
              Clear list
            </Button>
          ) : null}
          <Button
            type="button"
            variant={signedOut ? 'outline' : 'default'}
            disabled={!canSave}
            onClick={() => void save()}
          >
            {saving ? <Spinner aria-hidden="true" /> : <Check aria-hidden="true" />}
            {ready.length > 0 ? `Save ${plural(ready.length, 'move')}` : 'Save moves'}
          </Button>
        </div>
      </div>

      {/* Each result, announced (the list keeps the newest scan at the top). */}
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="move-announcement"
      >
        {announcement
          ? `${announcement.tone === 'error' ? 'Problem: ' : ''}${announcement.text}`
          : ''}
      </p>
    </div>
  );
}
