import type { MeResponse, ReceiverOption } from '@trapezoid/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorState, PageHeader } from '../components/ui';
import { useMe } from '../session/context';
import { newDraft } from './draft';
import { DraftList } from './drafts/DraftList';
import { newRecord, visibleTo, type StoredDraft } from './drafts/record';
import { indexedDbDraftStore, toStorageError } from './drafts/store';
import { ReceiptWizard } from './ReceiptWizard';

// Receiving landing (TRP-T11): "Drafts on this computer" above "Start new receipt". With no
// drafts to show it goes straight to a new receipt. The open draft's ID is kept in the URL
// (?draft=…) so signing in again after an expired session comes back to the same draft.

/**
 * Who receives by default: a personal account receives as itself (changeable); the shared LAB
 * station starts blank on every new receipt and must choose (Quick Ideas note, TRP-T07).
 */
function defaultReceiver(me: MeResponse): ReceiverOption | null {
  return me.accountType !== 'shared_lab' && me.initials
    ? {
        id: me.id,
        initials: me.initials,
        displayName: me.displayName,
        position: me.position ?? null,
      }
    : null;
}

type Listing =
  | { state: 'loading' }
  | { state: 'ready'; drafts: StoredDraft[]; unreadable: number }
  | { state: 'error'; message: string };

interface OpenDraft {
  record: StoredDraft;
  persisted: boolean;
}

export function ReceiveSamplesPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const requested = params.get('draft');
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  const [open, setOpen] = useState<OpenDraft | null>(null);
  /** Whether the first listing has been acted on (open the linked draft, or start a new one). */
  const decided = useRef(false);

  const load = useCallback(async (): Promise<Listing> => {
    try {
      const { drafts, unreadable } = await indexedDbDraftStore.list();
      return { state: 'ready', drafts: drafts.filter((d) => visibleTo(d, me)), unreadable };
    } catch (error) {
      return { state: 'error', message: toStorageError(error).message };
    }
  }, [me]);

  const show = useCallback(
    (next: OpenDraft | null) => {
      setOpen(next);
      setParams(next ? { draft: next.record.draftId } : {}, { replace: true });
    },
    [setParams],
  );

  const startNew = useCallback(
    () => show({ record: newRecord(newDraft(defaultReceiver(me)), me), persisted: false }),
    [me, show],
  );

  const backToList = useCallback(async () => {
    show(null);
    setListing({ state: 'loading' });
    setListing(await load());
  }, [load, show]);

  useEffect(() => {
    let current = true;
    void load().then((result) => {
      if (!current) return;
      setListing(result);
      if (decided.current) return;
      decided.current = true;
      const drafts = result.state === 'ready' ? result.drafts : [];
      const linked = drafts.find((d) => d.draftId === requested);
      if (linked) show({ record: linked, persisted: true });
      else if (result.state === 'ready' && drafts.length === 0) startNew();
      else if (requested) setParams({}, { replace: true });
    });
    return () => {
      current = false;
    };
    // Runs once per mount: later changes to the URL come from this page itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (open) {
    return (
      <ReceiptWizard
        key={open.record.draftId}
        initial={open.record}
        persisted={open.persisted}
        resumed={open.persisted}
        me={me}
        onStartNew={startNew}
        onDiscarded={() => void backToList()}
      />
    );
  }

  return (
    <>
      <PageHeader title="Receive samples" />
      {listing.state === 'loading' ? (
        <p aria-busy="true">Loading drafts on this computer…</p>
      ) : null}
      {listing.state === 'error' ? (
        <ErrorState message={`Drafts on this computer couldn't load. ${listing.message}`} />
      ) : null}
      {listing.state === 'ready' ? (
        <DraftList
          drafts={listing.drafts}
          unreadable={listing.unreadable}
          onResume={(record) => show({ record, persisted: true })}
          onDiscard={async (record) => {
            await indexedDbDraftStore.remove(record.draftId);
            setListing(await load());
          }}
        />
      ) : null}
      {listing.state !== 'loading' ? (
        <div className="wizard-actions">
          <button type="button" className="primary" onClick={startNew}>
            Start new receipt
          </button>
        </div>
      ) : null}
    </>
  );
}
