import {
  parseScanPayload,
  type ReceiverOption,
  type StorageUnitDetail,
} from '@materialmule/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { PageHeader, StatusBadge } from '../components/ui';
import { ReceiverSelect } from '../components/ReceiverSelect';
import { useOnline } from '../lib/online';
import { CameraScanner } from '../scanning/CameraScanner';
import { readDecoderPreference } from '../scanning/decoder';
import { playScanTone, useScanSound } from '../scanning/feedback';
import { displayScannedValue } from '../scanning/scan-core';
import { ScanInput, type ScanStatusView } from '../scanning/ScanInput';
import { useScanner } from '../scanning/useScanner';
import { useMe, useSession } from '../session/context';
import { fetchAllLocations, fetchUnit, resolveScan } from './api';
import {
  EMPTY_BATCH,
  inBatch,
  loadBatch,
  saveBatch,
  type BatchItem,
  type BatchState,
} from './batch';
import { isoWithOffset, moveStatus } from './format';
import { predecessorFor } from './queue';
import {
  indexedDbMoveStore,
  stationId,
  toStorageError,
  type CachedUnit,
  type PlaceRef,
  type QueuedMove,
} from './store';
import { useMoveQueue, type QueueStatus } from './useMoveQueue';
import './moves.css';

function toCached(detail: StorageUnitDetail): CachedUnit {
  return {
    readableId: detail.readableId,
    id: detail.id,
    version: detail.version,
    status: detail.status,
    location: detail.location,
    cachedAt: new Date().toISOString(),
  };
}

function queueLine(status: QueueStatus, online: boolean, waiting: number): string {
  const moves = waiting === 1 ? '1 move waiting to sync' : `${waiting} moves waiting to sync`;
  if (status.kind === 'signin') return `Signed out: ${moves}. Sign in again to send them.`;
  if (status.kind === 'forbidden') return status.message;
  if (status.kind === 'storage') return status.message;
  if (!online)
    return waiting > 0 ? `Offline: ${moves}.` : 'Offline: moves are kept on this computer.';
  if (status.kind === 'syncing') return `Syncing… ${moves}.`;
  if (status.kind === 'offline') return `Material Mule can’t be reached: ${moves}. Retrying.`;
  return waiting > 0 ? `${moves}.` : 'All moves saved.';
}

/**
 * Sample Storage → Move (MM-T28). Scan a destination label (LOC-…), then storage units: each
 * becomes a move to that destination until another destination is scanned or it is cleared.
 * Every scan is stored on this computer before it is sent, so a dropped connection never loses
 * it; until the server saves it, it shows as Pending and never replaces the saved location.
 */
export function MovePage() {
  const me = useMe();
  const { refresh } = useSession();
  const online = useOnline();
  const sound = useScanSound();
  const station = useMemo(() => stationId(), []);
  const isLab = me.accountType === 'shared_lab';
  const [batch, setBatchState] = useState<BatchState>(() => loadBatch(me.id));
  const [status, setStatus] = useState<ScanStatusView>({
    tone: 'ready',
    message: batch.destination ? 'Scan storage units' : 'Scan a destination label',
  });
  const [lastScanned, setLastScanned] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const store = indexedDbMoveStore;

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
                readableId: move.unit.readableId,
                id: move.unit.id,
                version: move.result!.resultingVersion!,
                status: cached?.status ?? 'in_stock',
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

  // Keep this computer's location list current while online, so offline destination scans work.
  useEffect(() => {
    if (!online) return;
    void fetchAllLocations().then((result) => {
      if (result.kind !== 'ok') return;
      const cachedAt = new Date().toISOString();
      void store
        .putLocations(
          result.data.map((l) => ({
            id: l.id,
            code: l.code,
            name: l.name,
            active: l.active,
            cachedAt,
          })),
        )
        .catch(() => undefined);
    });
  }, [online, store]);

  const byId = useMemo(
    () => new Map(queue.moves.map((move) => [move.clientMoveId, move])),
    [queue.moves],
  );
  const dismissed = useMemo(
    () => new Set(queue.moves.filter((m) => m.state === 'dismissed').map((m) => m.clientMoveId)),
    [queue.moves],
  );
  const mine = queue.moves.filter((move) => move.request.captureContext.accountId === me.id);
  const waiting = mine.filter((move) => move.state === 'pending' || move.state === 'waiting');
  const heldForOthers = queue.moves.filter(
    (move) =>
      move.request.captureContext.accountId !== me.id &&
      (move.state === 'pending' || move.state === 'waiting'),
  );
  const inThisBatch = new Set(
    batch.items.flatMap((item) => (item.kind === 'move' ? [item.clientMoveId] : [])),
  );
  const earlier = mine.filter(
    (move) =>
      !inThisBatch.has(move.clientMoveId) &&
      (move.state === 'pending' ||
        move.state === 'waiting' ||
        move.state === 'attention' ||
        move.state === 'conflict'),
  );
  const syncingId = queue.status.kind === 'syncing' ? queue.status.clientMoveId : null;

  function report(view: ScanStatusView) {
    setStatus(view);
    if (sound.on) playScanTone(view.tone === 'success' ? 'success' : 'failure');
  }

  async function setDestination(code: string) {
    let place: PlaceRef & { active: boolean };
    const answer = await resolveScan(code);
    if (answer.kind === 'ok') {
      if (answer.data.type !== 'location') {
        report({ tone: 'error', message: `No location found for ${displayScannedValue(code)}` });
        return;
      }
      place = answer.data.location;
      void store
        .putLocations([{ ...answer.data.location, cachedAt: new Date().toISOString() }])
        .catch(() => undefined);
    } else if (answer.kind === 'unavailable') {
      const parsed = parseScanPayload(code);
      const cached =
        parsed.type === 'location' ? await store.getLocation(parsed.code).catch(() => null) : null;
      if (!cached) {
        report({
          tone: 'error',
          message: `${displayScannedValue(code)} needs online lookup`,
          detail: 'This location isn’t in this computer’s list yet. Reconnect, then scan it again.',
        });
        return;
      }
      place = cached;
    } else {
      report({ tone: 'error', message: `Couldn’t look up ${displayScannedValue(code)}` });
      return;
    }
    if (!place.active) {
      report({
        tone: 'error',
        message: `${place.name} is retired`,
        detail: 'Retired locations can’t receive storage units. Scan another destination.',
      });
      return;
    }
    const destination = { id: place.id, code: place.code, name: place.name };
    setBatch((current) => ({ ...current, destination }));
    report({
      tone: 'success',
      message: `Destination: ${destination.name}`,
      detail: 'Now scan storage units.',
    });
  }

  /** The unit as the server has it now, or this computer's last copy when offline. */
  async function findUnit(
    readableId: string,
  ): Promise<{ unit: CachedUnit; fromCache: boolean } | 'not_found' | 'uncached' | 'signin'> {
    const answer = await fetchUnit(readableId);
    if (answer.kind === 'ok') {
      const unit = toCached(answer.data);
      void store.putUnit(unit).catch(() => undefined);
      return { unit, fromCache: false };
    }
    if (answer.kind === 'not_found') return 'not_found';
    if (answer.kind === 'error' && answer.status === 401) return 'signin';
    const cached = await store.getUnit(readableId).catch(() => null);
    return cached ? { unit: cached, fromCache: true } : 'uncached';
  }

  async function queueMove(
    unit: CachedUnit,
    destination: PlaceRef,
    capturedOffline: boolean,
    scannedAt: string,
  ): Promise<boolean> {
    const mover = batchRef.current.mover;
    const previous = predecessorFor(queueRef.current.moves, unit.id, me.id, station);
    const clientMoveId = crypto.randomUUID();
    try {
      await queueRef.current.enqueue({
        clientMoveId,
        request: {
          clientMoveId,
          storageUnitId: unit.id,
          toLocationId: destination.id,
          baseVersion: previous ? previous.request.baseVersion : unit.version,
          scannedAt,
          capturedOffline,
          ...(previous ? { previousClientMoveId: previous.clientMoveId } : {}),
          captureContext: {
            stationId: station,
            accountId: me.id,
            ...(isLab && mover ? { moverUserId: mover.id } : {}),
          },
        },
        unit: { id: unit.id, readableId: unit.readableId },
        base: {
          version: previous ? previous.request.baseVersion : unit.version,
          location: previous ? previous.destination : unit.location,
        },
        destination,
        account: { id: me.id, name: me.displayName },
        mover:
          isLab && mover
            ? { id: mover.id, initials: mover.initials, name: mover.displayName }
            : null,
        state: 'pending',
        attempts: 0,
        message: null,
        result: null,
      });
    } catch (error) {
      report({
        tone: 'error',
        message: `${unit.readableId} was not queued`,
        detail: `${toStorageError(error).message} Nothing was saved or sent.`,
      });
      return false;
    }
    setBatch((current) => ({
      ...current,
      items: [
        ...current.items,
        {
          key: clientMoveId,
          kind: 'move',
          clientMoveId,
          readableId: unit.readableId,
          unitId: unit.id,
          destination,
        },
      ],
    }));
    return true;
  }

  async function addUnit(readableId: string) {
    const { destination, mover, items } = batchRef.current;
    if (!destination) {
      report({
        tone: 'error',
        message: 'Scan a destination label first',
        detail: `${readableId} was not moved.`,
      });
      return;
    }
    if (isLab && !mover) {
      report({
        tone: 'error',
        message: 'Choose who is moving these units first',
        detail: `${readableId} was not moved.`,
      });
      return;
    }
    if (inBatch(items, readableId, destination.id, dismissed)) {
      report({
        tone: 'warning',
        message: `${readableId} is already in this batch`,
        detail: `Ignored: it is already going to ${destination.name}.`,
      });
      return;
    }
    const scannedAt = isoWithOffset(new Date());
    const found = await findUnit(readableId);
    if (found === 'not_found') {
      report({ tone: 'error', message: `No storage unit found for ${readableId}` });
      return;
    }
    if (found === 'signin') {
      report({
        tone: 'error',
        message: 'Your session has ended',
        detail: 'Sign in again, then scan it again.',
      });
      return;
    }
    if (found === 'uncached') {
      // Never invent a unit, version or status: keep the scan visibly, queue nothing.
      setBatch((current) => ({
        ...current,
        items: [
          ...current.items,
          { key: crypto.randomUUID(), kind: 'lookup', readableId, destination, scannedAt },
        ],
      }));
      report({
        tone: 'warning',
        message: `${readableId} needs online lookup`,
        detail: 'This computer hasn’t seen this unit yet, so nothing was queued.',
      });
      return;
    }
    if (found.unit.status === 'disposed') {
      report({
        tone: 'error',
        message: `${readableId} is disposed`,
        detail: 'Disposed units can’t be moved.',
      });
      return;
    }
    const queued = await queueMove(
      found.unit,
      destination,
      found.fromCache || !navigator.onLine,
      scannedAt,
    );
    if (queued) {
      report({
        tone: 'success',
        message: `${readableId} → ${destination.name}`,
        detail: found.fromCache ? 'Pending: it will sync when the connection is back.' : undefined,
      });
    }
  }

  async function handleScan(code: string) {
    setLastScanned(displayScannedValue(code));
    const parsed = parseScanPayload(code);
    if (parsed.type === 'location') return setDestination(code);
    if (parsed.type === 'storage_unit') return addUnit(parsed.readableId);
    report({ tone: 'error', message: `${displayScannedValue(code)} isn’t a Material Mule label` });
  }

  // Scans are handled one at a time, in the order they were read.
  const chain = useRef(Promise.resolve());
  function onScan(code: string) {
    chain.current = chain.current.then(() => handleScan(code)).catch(() => undefined);
  }
  const scanner = useScanner({
    onScan,
    onDuplicate: (code) => {
      setLastScanned(displayScannedValue(code));
      setStatus((current) => ({ ...current, detail: 'Already scanned' }));
    },
  });

  async function lookUp(item: Extract<BatchItem, { kind: 'lookup' }>) {
    const found = await findUnit(item.readableId);
    if (typeof found === 'string' || found.fromCache) {
      report({
        tone: 'error',
        message: `${item.readableId} still needs online lookup`,
        detail:
          found === 'not_found' ? 'No storage unit has this ID.' : 'Reconnect, then try again.',
      });
      return;
    }
    if (found.unit.status === 'disposed') {
      report({
        tone: 'error',
        message: `${item.readableId} is disposed`,
        detail: 'Disposed units can’t be moved.',
      });
      return;
    }
    // A new, validated intent, confirmed by the person (base = the version just read).
    if (await queueMove(found.unit, item.destination, true, item.scannedAt)) {
      setBatch((current) => ({
        ...current,
        items: current.items.filter((i) => i.key !== item.key),
      }));
      report({ tone: 'success', message: `${item.readableId} → ${item.destination.name}` });
    }
  }

  function removeItem(key: string) {
    setBatch((current) => ({ ...current, items: current.items.filter((i) => i.key !== key) }));
  }

  return (
    <>
      <p className="back-link">
        <Link to="/sample-storage">← Back to Sample Storage</Link>
      </p>
      <PageHeader title="Move storage units" />
      <p className="scan-intro">
        Scan the destination&apos;s location label, then each storage unit you put there. Moves are
        kept on this computer until Material Mule saves them. To only look a unit up, use{' '}
        <Link to="/sample-storage/scan">Scan labels</Link>.
      </p>

      <p
        className={`move-connection ${online && queue.status.kind !== 'signin' ? '' : 'move-connection-off'}`}
        role="status"
      >
        <StatusBadge tone={online ? 'success' : 'warning'}>
          {online ? 'Online' : 'Offline'}
        </StatusBadge>{' '}
        {queueLine(queue.status, online, waiting.length)}
        {queue.status.kind === 'signin' ? (
          <button type="button" className="move-inline-button" onClick={() => void refresh()}>
            Sign in again
          </button>
        ) : null}
        {queue.status.kind === 'offline' && online ? (
          <button type="button" className="move-inline-button" onClick={queue.syncNow}>
            Retry now
          </button>
        ) : null}
      </p>
      {heldForOthers.length > 0 ? (
        <p className="notice notice-warning">
          {heldForOthers.length === 1 ? '1 move' : `${heldForOthers.length} moves`} scanned on this
          computer by {heldForOthers[0]!.account.name} {heldForOthers.length === 1 ? 'is' : 'are'}{' '}
          waiting. {heldForOthers.length === 1 ? 'It is' : 'They are'} only sent when{' '}
          {heldForOthers[0]!.account.name} signs in here.
        </p>
      ) : null}
      {queue.unreadable > 0 ? (
        <p className="notice notice-warning">
          {queue.unreadable} queued move record(s) were saved by a newer version of Material Mule.
          They are kept, not sent. Update this computer&apos;s page to send them.
        </p>
      ) : null}

      {isLab ? (
        <div className="move-mover">
          <ReceiverSelect
            label="Moved by"
            required
            value={batch.mover}
            onChange={(mover: ReceiverOption | null) =>
              setBatch((current) => ({ ...current, mover }))
            }
            hint="Who is carrying the units at this computer. Recorded with each move; it grants nothing."
          />
        </div>
      ) : null}

      <section className="move-destination card" aria-labelledby="move-destination-heading">
        <h2 id="move-destination-heading" className="visually-hidden">
          Destination
        </h2>
        {batch.destination ? (
          <>
            <p className="move-destination-label">Moving to</p>
            <p className="move-destination-name" data-testid="move-destination">
              {batch.destination.name}{' '}
              <span className="move-destination-code">{batch.destination.code}</span>
            </p>
            <button
              type="button"
              onClick={() => {
                setBatch((current) => ({ ...current, destination: null }));
                setStatus({ tone: 'ready', message: 'Scan a destination label' });
                scanner.resume();
              }}
            >
              Clear destination
            </button>
          </>
        ) : (
          <p className="move-destination-empty">
            No destination yet: scan a location label (LOC-…).
          </p>
        )}
      </section>

      <button type="button" className="camera-scan-button" onClick={() => setCamera(true)}>
        Scan with camera
      </button>
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
      <ScanInput
        scanner={scanner}
        label={batch.destination ? 'Scan a storage unit label' : 'Scan the destination label'}
        status={status}
        lastScanned={lastScanned}
        sound={sound}
      />

      <section className="move-batch" aria-labelledby="move-batch-heading">
        <div className="move-batch-header">
          <h2 id="move-batch-heading">This batch</h2>
          {batch.items.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setBatch((current) => ({
                  ...EMPTY_BATCH,
                  destination: current.destination,
                  mover: current.mover,
                }));
                scanner.resume();
              }}
            >
              Start a new batch
            </button>
          ) : null}
        </div>
        {batch.items.length === 0 ? (
          <p className="empty-state">Nothing scanned in this batch yet.</p>
        ) : (
          <ul className="move-list">
            {batch.items.map((item) =>
              item.kind === 'move' ? (
                <MoveRow
                  key={item.key}
                  readableId={item.readableId}
                  destination={item.destination}
                  move={byId.get(item.clientMoveId)}
                  syncingId={syncingId}
                  onDismiss={(id) => void queue.dismiss(id)}
                />
              ) : (
                <li key={item.key} className="move-row" data-testid="move-row">
                  <span className="move-unit">{item.readableId}</span>
                  <span>→ {item.destination.name}</span>
                  <StatusBadge tone="warning">Needs online lookup</StatusBadge>
                  <span className="move-row-actions">
                    <button type="button" disabled={!online} onClick={() => void lookUp(item)}>
                      Look up and move
                    </button>
                    <button type="button" onClick={() => removeItem(item.key)}>
                      Remove
                    </button>
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      {earlier.length > 0 ? (
        <section className="move-batch" aria-labelledby="move-earlier-heading">
          <h2 id="move-earlier-heading">Queued earlier on this computer</h2>
          <ul className="move-list">
            {earlier.map((move) => (
              <MoveRow
                key={move.clientMoveId}
                readableId={move.unit.readableId}
                destination={move.destination}
                move={move}
                syncingId={syncingId}
                onDismiss={(id) => void queue.dismiss(id)}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function MoveRow({
  readableId,
  destination,
  move,
  syncingId,
  onDismiss,
}: {
  readableId: string;
  destination: PlaceRef;
  move: QueuedMove | undefined;
  syncingId: string | null;
  onDismiss: (clientMoveId: string) => void;
}) {
  const status = moveStatus(move, syncingId);
  return (
    <li className="move-row" data-testid="move-row">
      <span className="move-unit">{readableId}</span>
      <span>→ {destination.name}</span>
      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      {move?.message ? <span className="move-message">{move.message}</span> : null}
      {move?.mover ? <span className="move-meta">Moved by {move.mover.name}</span> : null}
      <span className="move-row-actions">
        {move?.state === 'conflict' ? (
          <Link to={`/sample-storage/${encodeURIComponent(readableId)}`} state={{ from: '' }}>
            Open {readableId} to confirm its location
          </Link>
        ) : null}
        {move && (move.state === 'attention' || move.state === 'waiting') ? (
          <button type="button" onClick={() => onDismiss(move.clientMoveId)}>
            Dismiss
          </button>
        ) : null}
      </span>
    </li>
  );
}
