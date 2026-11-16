import type { MeResponse, ReceiverOption } from '@materialmule/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorState } from '../components/app-ui';
import { useMe } from '../session/context';
import { useOptionalRecordingPerson } from '../session/recording-person-store';
import { newDraft } from './draft';
import { fetchDraftSettings } from '../settings/receiving/api';
import {
  autoDeleteDrafts,
  autoDeleteNotice,
  type DraftAutoDelete,
  type DraftSettingState,
} from './drafts/auto-delete';
import {
  runDraftCleanup,
  takeDraftCleanupNotice,
  type CleanupResult,
} from './drafts/cleanup-notice';
import { DraftList } from './drafts/DraftList';
import { newRecord, visibleTo, type StoredDraft } from './drafts/record';
import { indexedDbDraftStore, toStorageError } from './drafts/store';
import { ReceiptWizard } from './ReceiptWizard';
import './receiving.css';

// Receiving landing (MM-T11): "Drafts on this computer" above "Start a delivery". With no
// drafts to show, with ?new=1 (the receiving log's Start a delivery) or with ?project=new
// (Quick actions › New project: a new draft with Add project open), it goes straight to a new
// draft. The open draft's ID is kept in the URL (?draft=…, the receiving log's Continue) so
// signing in again after an expired session comes back to the same draft.
// On opening, draft auto-delete (MM-T45) runs first: only with the setting loaded from the
// server and switched on; if it can't load, nothing is deleted.

/**
 * Who receives by default: a personal account receives as itself (changeable); the shared LAB
 * station starts blank on every new receipt and must choose (Quick Ideas note, MM-T07).
 */
function defaultReceiver(me: MeResponse): ReceiverOption | null {
  return me.accountType !== 'shared_lab' && me.initials
    ? {
        id: me.id,
        initials: me.initials,
        displayName: me.displayName,
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
  /** Open Add project at once (`?project=new`). */
  addProject?: boolean;
  /** Pre-fill this project on a new draft (`?new=1&projectId=…`, a project's page). */
  projectId?: string;
}

export function ReceiveSamplesPage() {
  const me = useMe();
  const station = useOptionalRecordingPerson();
  // On a LAB station the person recording is the draft's starter (STRATA-108); never its
  // Received by, which starts blank there (T8/AC5).
  const starter =
    station?.isStation && station.person
      ? {
          userId: station.person.id,
          name: station.person.displayName,
          initials: station.person.initials,
        }
      : null;
  const starterKey = starter ? `${starter.userId}|${starter.name}|${starter.initials}` : '';
  const [params, setParams] = useSearchParams();
  const requested = params.get('draft');
  const addProjectRequested = params.get('project') === 'new';
  const projectIdRequested = params.get('projectId');
  const startRequested = params.get('new') === '1' || addProjectRequested;
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  const [open, setOpen] = useState<OpenDraft | null>(null);
  const [autoDelete, setAutoDelete] = useState<DraftAutoDelete | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
      // The clean-up notice is shown once, on the list it came with.
      if (next) setNotice(null);
      setParams(next ? { draft: next.record.draftId } : {}, { replace: true });
    },
    [setParams],
  );

  const startNew = useCallback(
    (addProject = false, projectId?: string) =>
      show({
        record: newRecord(newDraft(defaultReceiver(me)), me, new Date(), starter),
        persisted: false,
        addProject,
        projectId,
      }),
    // `starter` is rebuilt each render; its key says when it really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [me, show, starterKey],
  );

  const backToList = useCallback(async () => {
    show(null);
    setListing({ state: 'loading' });
    setListing(await load());
  }, [load, show]);

  /** Deletes old drafts when the setting says so; returns the setting and how many went. */
  const cleanUp = useCallback(async (): Promise<CleanupResult> => {
    const fetched = await fetchDraftSettings({ reportUnauthenticated: false });
    const setting: DraftSettingState = fetched.ok
      ? { ok: true, data: fetched.data }
      : { ok: false };
    if (!setting.ok) return { autoDelete: null, deleted: 0 };
    const autoDelete = setting.data.draftAutoDelete;
    if (!autoDelete.enabled) return { autoDelete, deleted: 0 };
    try {
      const { drafts } = await indexedDbDraftStore.list();
      return {
        autoDelete,
        deleted: await autoDeleteDrafts(indexedDbDraftStore, drafts, me, setting),
      };
    } catch {
      // Storage problems show up in the listing that follows; nothing more to do here.
      return { autoDelete, deleted: 0 };
    }
  }, [me]);

  useEffect(() => {
    let current = true;
    void (async () => {
      // One run per account at a time: a remount mid-run (StrictMode, or leaving and coming back)
      // joins it. Its count waits for whichever Receive samples page is still open, then is shown
      // once, so leaving during the clean-up never loses the notice (MM-T61).
      const { autoDelete: setting } = await runDraftCleanup(me.id, cleanUp);
      const result = await load();
      if (!current) return;
      const taken = takeDraftCleanupNotice(me.id);
      const cleaned = taken ? autoDeleteNotice(taken.deleted, taken.afterDays) : null;
      setAutoDelete(setting);
      setNotice(cleaned);
      setListing(result);
      if (decided.current) return;
      decided.current = true;
      const drafts = result.state === 'ready' ? result.drafts : [];
      const linked = drafts.find((d) => d.draftId === requested);
      // "Start a delivery" in the receiving log always starts a new draft (?new=1).
      if (startRequested) startNew(addProjectRequested, projectIdRequested ?? undefined);
      else if (linked) show({ record: linked, persisted: true });
      // After a clean-up, stay on the list so its notice is seen.
      else if (result.state === 'ready' && drafts.length === 0 && !cleaned) startNew();
      else if (requested) setParams({}, { replace: true });
    })();
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
        addProject={open.addProject}
        prefillProjectId={open.projectId}
        onStartNew={() => startNew()}
        onDiscarded={() => void backToList()}
      />
    );
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <h1 className="m-0 text-2xl font-semibold tracking-tight">Receive samples</h1>
      {listing.state === 'loading' ? (
        <p className="text-muted-foreground m-0 text-sm" aria-busy="true">
          Loading drafts on this computer…
        </p>
      ) : null}
      {listing.state === 'error' ? (
        <ErrorState message={`Drafts on this computer couldn't load. ${listing.message}`} />
      ) : null}
      {listing.state === 'ready' ? (
        <DraftList
          drafts={listing.drafts}
          unreadable={listing.unreadable}
          autoDelete={autoDelete}
          notice={notice}
          onResume={(record) => show({ record, persisted: true })}
          onDiscard={async (record) => {
            await indexedDbDraftStore.remove(record.draftId);
            setListing(await load());
          }}
        />
      ) : null}
      {listing.state !== 'loading' ? (
        <div>
          <Button type="button" size="lg" onClick={() => startNew()}>
            <Plus aria-hidden="true" />
            Start a delivery
          </Button>
        </div>
      ) : null}
    </div>
  );
}
