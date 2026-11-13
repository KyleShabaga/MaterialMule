import {
  type ConfirmReceiptResponse,
  type MeResponse,
  type StaffOption,
} from '@materialmule/shared';
import { Clock, CloudOff, Ellipsis, Plus, RotateCw, CopyPlus, Trash2, WifiOff } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { listActiveStaff, listBulkGroups } from '../api/projects';
import { fetchProjectDetail } from '../projects/api';
import { NOT_LISTED_MESSAGE, ReceiverSelect } from '../components/ReceiverSelect';
import { useOnline } from '../lib/online';
import { LAB_EXPIRED_MESSAGE } from '../pages/SignInPage';
import { useSession } from '../session/context';
import { useExpiryClaim } from '../session/expiry-claim';
import { useOptionalRecordingPerson } from '../session/recording-person-store';
import { confirmReceipt } from './api';
import {
  describeErrors,
  draftHoleNames,
  duplicateUnit,
  fieldId,
  formatFixCount,
  formatUnitCount,
  isDeliveryField,
  newUnit,
  normalizeUnit,
  problemUnitIndex,
  toConfirmRequest,
  UNIT_KIND_LABEL,
  UNIT_PREFIX,
  unitKindOf,
  unitSourceText,
  validateDraft,
  withSourceType,
  type DraftProblem,
  type ReceiptDraft,
  type UnitDraft,
} from './draft';
import { DraftStatusLine } from './drafts/DraftStatusLine';
import { DraftDeleteError } from './drafts/ownership';
import { ReceiverHandover } from './drafts/ReceiverHandover';
import type { StoredDraft } from './drafts/record';
import { ErrorSummary } from './ErrorSummary';
import { focusField } from './focus';
import { FieldErrorText, LabeledField } from './LabeledField';
import { ProjectPicker } from './ProjectPicker';
import { ReceiptDone } from './ReceiptDone';
import { UnitEditor, type BulkGroupsState } from './UnitEditor';
import { UnitRow } from './UnitRow';
import { useReceiptDraft } from './useReceiptDraft';

// Receive samples (STRATA-76, after MM-T10/T11): one page with a row per storage unit, not a
// wizard. Project at the top, the units in the middle (one SAMPLE#/DEPTH summary per test hole
// per unit; never an individual sample list), Received at the foot and a sticky bar with the
// count and Confirm and print labels. The draft is autosaved on this computer and survives
// reloads, crashes and an expired session; it is continued from the receiving log. IDs are
// issued only by the server's confirmation, never shown for a draft.

const ADD_UNIT_SHORTCUT = 'Alt+N';

const OFFLINE_CONFIRM_MESSAGE = "You're offline. Your draft is kept. Connect to confirm.";
const PERSONAL_EXPIRED_MESSAGE =
  'Your session has expired. Your draft is saved. Sign in to confirm.';
const RESUMED_CONFIRMING_MESSAGE =
  "This receipt was being confirmed when Material Mule closed. Confirming again sends the same receipt and won't create duplicates.";

/** Drafts saved before a unit field existed open with it filled in. */
function normalized(record: StoredDraft): StoredDraft {
  return {
    ...record,
    data: { ...record.data, units: record.data.units.map((unit) => normalizeUnit(unit)) },
  };
}

/** Problems in the order the page shows their fields: project, units, then Received. */
function inPageOrder(problems: DraftProblem[]): DraftProblem[] {
  const rank = (p: DraftProblem) =>
    p.field === 'projectId' ? 0 : isDeliveryField(p.field) ? 2 : 1;
  return problems
    .map((problem, index) => ({ problem, index }))
    .sort((a, b) => rank(a.problem) - rank(b.problem) || a.index - b.index)
    .map(({ problem }) => problem);
}

/** Focuses the first element matching `selector` inside the element with `id`. */
function focusInside(id: string, selector: string): boolean {
  const target = document.getElementById(id)?.querySelector<HTMLElement>(selector);
  if (!target) return focusField(id);
  target.focus();
  target.scrollIntoView?.({ block: 'center' });
  return true;
}

/** Enter in these adds a unit on the last row; pickers, buttons and text areas keep Enter. */
function entersNewUnit(target: EventTarget): boolean {
  return (
    target instanceof HTMLInputElement &&
    target.getAttribute('role') !== 'combobox' &&
    ['text', 'number', 'date', 'search', ''].includes(target.type)
  );
}

function dialogOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"], dialog[open]',
  );
}

export function ReceiptWizard({
  initial: saved,
  persisted,
  resumed,
  me,
  addProject = false,
  prefillProjectId,
  onStartNew,
  onDiscarded,
}: {
  initial: StoredDraft;
  /** Already in storage (resumed), as opposed to a new draft saved on its first change. */
  persisted: boolean;
  /** Opened from the draft list or a link, rather than started here just now. */
  resumed: boolean;
  me: MeResponse;
  /** Open Add project at once (Quick actions › New project, `?project=new`). */
  addProject?: boolean;
  /** A new draft started from a project's page (`?projectId=…`): fill that project in. */
  prefillProjectId?: string;
  onStartNew: () => void;
  onDiscarded: () => void;
}) {
  const [initial] = useState(() => normalized(saved));
  const { refresh } = useSession();
  const navigate = useNavigate();
  const online = useOnline();
  const station = useOptionalRecordingPerson();
  const onStation = me.accountType === 'shared_lab' || station?.isStation === true;
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [staffError, setStaffError] = useState(false);
  const [staffLoaded, setStaffLoaded] = useState(false);
  const {
    draft,
    record,
    saveState,
    update,
    flush,
    setStatus,
    remove: removeDraft,
    discard: discardDraft,
  } = useReceiptDraft(initial, { accountId: me.id, persisted });
  /** LAB handover (MM-T11): the receiver stays until someone explicitly picks another. */
  const [handover, setHandover] = useState<'ask' | 'changed' | 'kept'>(() =>
    resumed && initial.owner.type === 'lab' && initial.data.receiver ? 'ask' : 'kept',
  );
  const [result, setResult] = useState<ConfirmReceiptResponse | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const markExpired = useCallback(() => setSessionExpired(true), []);
  // A session that ends in the background shows the saved-draft sign-in instead of leaving the
  // draft at once; confirming still needs a session on the server. Once confirmed, there is no
  // draft left to keep.
  useExpiryClaim(result === null, markExpired);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const autoResent = useRef(false);
  /** Problems show once someone tries to confirm, then stay live as they are fixed. */
  const [attempts, setAttempts] = useState(0);
  const [serverProblems, setServerProblems] = useState<DraftProblem[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [leaveError, setLeaveError] = useState(false);
  /** Projects or test holes that couldn't load; Try again reloads them (rows stay editable). */
  const [projectLoadFailed, setProjectLoadFailed] = useState(false);
  const [holeLoadFailures, setHoleLoadFailures] = useState<ReadonlySet<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  /** Element id to focus after the next render (a new row's field, the done page heading). */
  const focusTarget = useRef<{ id: string; selector?: string } | null>(null);
  const bulkGroups = useProjectBulkGroups(
    draft.project?.id ?? null,
    draft.units.some((unit) => unit.unitType === 'bucket' && unit.bulk),
    // A refused confirmation may mean a chosen bulk sample was corrected: offer the new identity.
    serverProblems.length,
  );

  // Started from a project's page: look the project up and fill it in, unless a project is
  // already chosen. Not found, not allowed or unreachable: the project stays blank, with a note.
  const cannotReceive = Boolean(prefillProjectId) && !me.permissions.includes('receipt.confirm');
  const [loadNotice, setPrefillNotice] = useState<string | null>(null);
  const prefillNotice = cannotReceive
    ? "You can't receive samples for that project. Choose a project below."
    : loadNotice;
  const prefilled = useRef(false);
  useEffect(() => {
    if (!prefillProjectId || prefilled.current) return;
    prefilled.current = true;
    if (initial.data.project || cannotReceive) return;
    void fetchProjectDetail(prefillProjectId).then((loaded) => {
      if (!loaded.ok) {
        setPrefillNotice(
          loaded.notFound
            ? "That project wasn't found. Choose a project below."
            : "That project couldn't be loaded. Choose a project below.",
        );
        return;
      }
      const { id, projectNumber, name, client, leadProjectEngineer } = loaded.data;
      change((current) =>
        current.project
          ? current
          : { ...current, project: { id, projectNumber, name, client, leadProjectEngineer } },
      );
    });
    // Once, for the draft this page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillProjectId]);

  useEffect(() => {
    let current = true;
    listActiveStaff().then(
      (people) => {
        if (!current) return;
        setStaff(people);
        setStaffLoaded(true);
      },
      () => current && setStaffError(true),
    );
    return () => {
      current = false;
    };
  }, []);

  // Put focus where the person expects it once it's rendered. Keep the target until it exists:
  // effects of a commit made before the click can run before the new row renders (MM-T71).
  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    const done = target.selector ? focusInside(target.id, target.selector) : focusField(target.id);
    if (done) focusTarget.current = null;
  });

  const problems = useMemo(() => validateDraft(draft), [draft]);
  const shown = useMemo(() => {
    const all = [...(attempts > 0 ? problems : []), ...serverProblems];
    const seen = new Set<string>();
    return inPageOrder(
      all.filter((p) => {
        const key = `${p.field}|${p.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  }, [attempts, problems, serverProblems]);
  const errorByField = useMemo(() => {
    const map = new Map<string, string>();
    for (const problem of shown)
      if (!map.has(problem.field)) map.set(problem.field, problem.message);
    return map;
  }, [shown]);
  const rowsWithProblems = useMemo(() => {
    const rows = new Set<string>();
    for (const problem of shown) {
      const index = problemUnitIndex(problem.field);
      const unit = index === null ? undefined : draft.units[index];
      if (unit) rows.add(unit.clientRowId);
    }
    return rows;
  }, [draft.units, shown]);

  // Any edit invalidates what the server said about the previous payload.
  function change(recipe: (current: ReceiptDraft) => ReceiptDraft) {
    setServerProblems([]);
    update(recipe);
  }
  const set = (changes: Partial<ReceiptDraft>) => change((current) => ({ ...current, ...changes }));
  const changeUnit = (clientRowId: string, recipe: (unit: UnitDraft) => UnitDraft) =>
    change((current) => ({
      ...current,
      units: current.units.map((u) => (u.clientRowId === clientRowId ? recipe(u) : u)),
    }));

  const holderOf = (index: number) => ({ id: fieldId(`units.${index}.unitType`) });
  const holeSearchOf = (index: number) => ({
    id: fieldId(`units.${index}.holeSummaries`),
    selector: 'input[role="combobox"]',
  });

  /**
   * Adds a unit at the end. With `toHoles` (Enter on the last row, Alt+N: MM-T66 UI-05) focus
   * goes to its test hole search so typing or scanning goes straight in; otherwise its holder.
   */
  function addUnit(toHoles = false) {
    const index = draft.units.length;
    change((current) => ({ ...current, units: [...current.units, newUnit()] }));
    focusTarget.current = toHoles && draft.project ? holeSearchOf(index) : holderOf(index);
  }

  /** Copies a unit below itself (same hole, next unit): Shift+Enter, the row menu, the footer. */
  function copy(clientRowId: string) {
    const index = draft.units.findIndex((u) => u.clientRowId === clientRowId);
    const source = draft.units[index];
    if (!source) return;
    const duplicate = duplicateUnit(source);
    change((current) => {
      const at = current.units.findIndex((u) => u.clientRowId === clientRowId);
      const units = [...current.units];
      units.splice(at + 1, 0, duplicate);
      return { ...current, units };
    });
    focusTarget.current = holderOf(index + 1);
  }

  /** Removes a unit; focus goes to the unit before it, or Add unit (MTR-136). */
  function remove(clientRowId: string) {
    const index = draft.units.findIndex((u) => u.clientRowId === clientRowId);
    change((current) => ({
      ...current,
      units: current.units.filter((u) => u.clientRowId !== clientRowId),
    }));
    focusTarget.current = index > 0 ? holderOf(index - 1) : { id: 'receive-add-unit' };
  }

  /** Tubes and new bulk samples: switch the sampling source to a location reference. */
  function switchToLocationReference(index: number, unit: UnitDraft) {
    const kind = unitKindOf(unit);
    if (kind === 'shelby_tube') {
      changeUnit(unit.clientRowId, (current) => ({
        ...current,
        tube: { ...current.tube, ...withSourceType('standalone_location') },
      }));
      focusTarget.current = { id: fieldId(`units.${index}.sample.sourceLocationReference`) };
    } else if (kind === 'bulk' && unit.bulkChoice.kind === 'new') {
      changeUnit(unit.clientRowId, (current) =>
        current.bulkChoice.kind === 'new'
          ? {
              ...current,
              bulkChoice: {
                kind: 'new',
                identity: {
                  ...current.bulkChoice.identity,
                  ...withSourceType('standalone_location'),
                },
              },
            }
          : current,
      );
      focusTarget.current = {
        id: fieldId(`units.${index}.bulkGroup.new.sourceLocationReference`),
      };
    }
  }

  function rowKeyDownCapture(event: ReactKeyboardEvent<HTMLElement>, clientRowId: string) {
    if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey) return;
    if (event.metaKey || event.repeat || event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    event.stopPropagation();
    copy(clientRowId);
  }

  function rowKeyDown(event: ReactKeyboardEvent<HTMLElement>, isLast: boolean) {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey) return;
    if (event.metaKey || event.defaultPrevented || event.repeat) return;
    if (!entersNewUnit(event.target)) return;
    // Enter never submits the receipt: on the last row it adds a unit, elsewhere nothing.
    event.preventDefault();
    if (isLast) addUnit(true);
  }

  function showProblems() {
    setAttempts((n) => n + 1);
  }

  /** Confirm and print labels: problems first; otherwise the confirm dialog lists the IDs to issue. */
  function askToConfirm() {
    if (!online || confirming) return;
    setConfirmError(null);
    if (problems.length > 0) {
      showProblems();
      return;
    }
    setConfirmOpen(true);
  }

  async function send() {
    if (!online || confirming) return;
    setConfirmError(null);
    setSessionExpired(false);
    if (problems.length > 0) {
      showProblems();
      return;
    }
    setConfirming(true);
    // Stored as "confirming" before the request leaves, so a crash before the answer resumes by
    // resending with the same idempotency key (MM-T09 then returns the original IDs).
    await setStatus('confirming');
    // The draft's ID lets the server close its registry row with the receipt (migration 0049).
    const outcome = await confirmReceipt({ ...toConfirmRequest(draft), draftId: record.draftId });
    setConfirming(false);
    switch (outcome.kind) {
      case 'confirmed':
        setResult(outcome.response);
        focusTarget.current = { id: 'receipt-done-heading' };
        // If this fails the draft stays listed; resuming it returns these same IDs.
        await removeDraft().catch(() => undefined);
        break;
      case 'invalid': {
        void setStatus('editing');
        setServerProblems(describeErrors(draft, outcome.errors));
        showProblems();
        break;
      }
      case 'unauthenticated':
        void setStatus('editing');
        setSessionExpired(true);
        break;
      case 'lost':
        // Unknown outcome: it stays "confirming", so resuming resends it.
        setConfirmError(outcome.message);
        break;
      case 'failed':
        void setStatus('editing');
        setConfirmError(outcome.message);
        break;
    }
  }

  // Resuming a draft whose confirmation was interrupted resends it (same key, same body).
  useEffect(() => {
    if (autoResent.current || !resumed || initial.status !== 'confirming' || !online) return;
    autoResent.current = true;
    void send();
  });

  /** Re-checks the session; once it has ended, the app goes to sign-in and back to this draft. */
  async function signIn() {
    await flush();
    await refresh();
  }

  /** Saves now and goes to the receiving log, where the draft is offered back with Continue. */
  async function leave() {
    setLeaveError(false);
    if (await flush()) void navigate('/receiving-log');
    else setLeaveError(true);
  }

  async function discard() {
    setDiscardOpen(false);
    setDiscardError(null);
    try {
      // The server checks that this is the draft's starter or a Lab Manager (STRATA-108).
      await discardDraft();
      onDiscarded();
    } catch (error) {
      setDiscardError(
        error instanceof DraftDeleteError
          ? error.message
          : "The draft couldn't be discarded. Try again.",
      );
    }
  }

  // Alt+N adds a unit from anywhere on the page (MM-T66 UI-05), never while a dialog is open.
  const addUnitByShortcut = useRef<() => void>(() => undefined);
  useEffect(() => {
    addUnitByShortcut.current = () => addUnit(true);
  });
  useEffect(() => {
    if (result) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.key.toLowerCase() !== 'n')
        return;
      if (event.defaultPrevented || event.repeat || dialogOpen()) return;
      event.preventDefault();
      addUnitByShortcut.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [result]);

  if (result) {
    return (
      <div className="flex w-full flex-col gap-6">
        <ReceiptBreadcrumb page="Receipt confirmed" />
        <ReceiptDone draft={draft} result={result} onReceiveAnother={onStartNew} />
      </div>
    );
  }

  const unitCount = draft.units.length;
  const holes = draftHoleNames(draft);
  const enteredBy =
    station?.isStation && station.person
      ? { id: station.person.id, displayName: station.person.displayName }
      : me.accountType === 'shared_lab'
        ? null
        : { id: me.id, displayName: me.displayName };
  const forSomeoneElse =
    draft.receiver && enteredBy && draft.receiver.id !== enteredBy.id
      ? `Entered by ${enteredBy.displayName}, for ${draft.receiver.displayName}`
      : null;
  const loadFailed = projectLoadFailed || holeLoadFailures.size > 0;
  const unitsText = (count: number) => (count === 1 ? '1 unit' : `${count} units`);

  function holeLoadError(key: string) {
    return (failed: boolean) =>
      setHoleLoadFailures((current) => {
        if (current.has(key) === failed) return current;
        const next = new Set(current);
        if (failed) next.add(key);
        else next.delete(key);
        return next;
      });
  }

  return (
    <div className="flex min-h-full flex-col" onBlur={() => void flush()}>
      <div className="flex w-full flex-1 flex-col gap-6 pb-6">
        <ReceiptBreadcrumb page="New receipt" />
        <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="grid min-w-0 gap-2">
            <h1 className="m-0 text-2xl font-semibold tracking-tight">Receive samples</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <Badge variant="draft" className="h-6 px-2.5 text-[13px] font-semibold">
                <span aria-hidden="true" className="bg-stage-draft-mark size-1.5 rounded-full" />
                Draft
              </Badge>
              <span className="text-muted-foreground flex items-center gap-1.5">
                <CloudOff aria-hidden="true" className="size-3.5" />
                <DraftStatusLine saveState={saveState} receiver={draft.receiver} />
              </span>
              {station?.isStation && station.person ? (
                <span className="text-muted-foreground">
                  Recorded as{' '}
                  <span className="text-foreground font-semibold">
                    {station.person.displayName}
                  </span>
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void leave()}
              disabled={confirming}
            >
              Save draft and leave
            </Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="More actions"
                  title="More actions"
                >
                  <Ellipsis aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  variant="destructive"
                  disabled={confirming}
                  onSelect={() => setDiscardOpen(true)}
                >
                  <Trash2 aria-hidden="true" />
                  Discard draft
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {discardError ? <InlineAlert title={discardError} /> : null}
        {leaveError ? (
          <InlineAlert title="The draft couldn't be saved on this computer, so it stays open. Try again." />
        ) : null}
        {!online ? (
          <Alert role="status" className="border-stage-due-mark/50">
            <WifiOff aria-hidden="true" />
            <AlertTitle className="line-clamp-none">
              Offline: your entries are kept here.
            </AlertTitle>
            <AlertDescription>
              Connect to add a project or test hole, and to confirm.
            </AlertDescription>
          </Alert>
        ) : null}
        {loadFailed ? (
          <Alert variant="destructive">
            <RotateCw aria-hidden="true" />
            <AlertTitle className="line-clamp-none">
              {projectLoadFailed && holeLoadFailures.size > 0
                ? 'Projects and test holes couldn’t load.'
                : projectLoadFailed
                  ? 'Projects couldn’t load.'
                  : 'Test holes couldn’t load.'}
            </AlertTitle>
            <AlertDescription>
              <p>
                Keep filling in the rows: they are saved on this computer. The project and holes are
                checked again when you try again or confirm.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-foreground mt-1"
                onClick={() => {
                  setProjectLoadFailed(false);
                  setHoleLoadFailures(new Set());
                  setReloadKey((n) => n + 1);
                }}
              >
                <RotateCw aria-hidden="true" />
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {sessionExpired ? (
          <Alert className="border-stage-due-mark/50">
            <Clock aria-hidden="true" />
            <AlertTitle className="line-clamp-none">
              {onStation ? LAB_EXPIRED_MESSAGE : PERSONAL_EXPIRED_MESSAGE}
            </AlertTitle>
            <AlertDescription>
              <p>Nothing was lost, and no IDs were issued.</p>
              <Button type="button" className="mt-1" onClick={() => void signIn()}>
                Sign in
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {resumed && initial.status === 'confirming' ? (
          <Alert role="status">
            <AlertTitle className="line-clamp-none">{RESUMED_CONFIRMING_MESSAGE}</AlertTitle>
          </Alert>
        ) : null}
        {confirmError ? <InlineAlert title={confirmError} /> : null}
        {handover === 'ask' && draft.receiver ? (
          <ReceiverHandover
            receiver={draft.receiver}
            onChange={(receiver) => {
              set({ receiver });
              setHandover('changed');
            }}
            onKeep={() => setHandover('kept')}
          />
        ) : null}
        {handover === 'changed' && draft.receiver ? (
          <p className="text-muted-foreground m-0 text-sm" role="status">
            Receiver changed to {draft.receiver.initials}. The change is recorded in this draft's
            history.
          </p>
        ) : null}

        <ErrorSummary problems={shown} attempt={attempts} />

        <section aria-labelledby="receive-project" className="bg-card rounded-xl border p-5">
          <h2 id="receive-project" className="m-0 mb-4 text-base font-semibold">
            Project
          </h2>
          <div id={fieldId('projectId')} className="flex flex-col gap-1.5">
            {prefillNotice && !draft.project ? (
              <p className="text-muted-foreground m-0 text-sm" role="status">
                {prefillNotice}
              </p>
            ) : null}
            <ProjectPicker
              value={draft.project}
              query={draft.projectQuery}
              onQueryChange={(projectQuery) => set({ projectQuery })}
              // Holes belong to one project, so another project starts every unit's holes afresh.
              onSelect={(project) =>
                change((current) =>
                  project?.id === current.project?.id
                    ? { ...current, project }
                    : {
                        ...current,
                        project,
                        units: current.units.map((u) => ({ ...u, summaries: [], holeQuery: '' })),
                      },
                )
              }
              staff={staff}
              engineersOnly
              staffReady={staffLoaded}
              receiverUserId={draft.receiver?.id ?? null}
              online={online}
              required
              invalid={errorByField.has('projectId')}
              addOnOpen={addProject}
              retryKey={reloadKey}
              onLoadError={setProjectLoadFailed}
            />
            {errorByField.get('projectId') ? (
              <FieldErrorText>{errorByField.get('projectId')}</FieldErrorText>
            ) : null}
          </div>
        </section>

        <section
          aria-labelledby="units-heading"
          className="bg-card @container flex flex-col rounded-xl border"
        >
          <div className="flex flex-col gap-1 border-b p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id="units-heading" className="m-0 text-base font-semibold">
                Storage units
              </h2>
              <span className="text-muted-foreground text-[13px]" aria-live="polite">
                {unitsText(unitCount)} ·{' '}
                {holes.length === 1 ? '1 test hole' : `${holes.length} test holes`}
              </span>
            </div>
            <p className="text-muted-foreground m-0 text-[13px]">
              One row per bucket, tube or box. Match the test hole written on the holder (or the
              location reference), then summarise its samples and depth. Samples are never listed
              one by one.
            </p>
          </div>
          <ol
            aria-label="Storage units in this receipt"
            className="m-0 flex list-none flex-col p-0"
          >
            {draft.units.map((unit, index) => {
              const kind = unitKindOf(unit);
              const isLast = index === unitCount - 1;
              return (
                <UnitRow
                  key={unit.clientRowId}
                  unit={unit}
                  index={index}
                  canRemove={unitCount > 1}
                  invalid={rowsWithProblems.has(unit.clientRowId)}
                  onAddHole={
                    kind === 'bucket' && draft.project
                      ? () => (focusTarget.current = holeSearchOf(index))
                      : undefined
                  }
                  onUseLocation={
                    kind === 'shelby_tube' || (kind === 'bulk' && unit.bulkChoice.kind === 'new')
                      ? () => switchToLocationReference(index, unit)
                      : undefined
                  }
                  onCopy={() => copy(unit.clientRowId)}
                  onRemove={() => remove(unit.clientRowId)}
                  onKeyDownCapture={(event) => rowKeyDownCapture(event, unit.clientRowId)}
                  onKeyDown={(event) => rowKeyDown(event, isLast)}
                >
                  <UnitEditor
                    unit={unit}
                    index={index}
                    draft={draft}
                    bulkGroups={bulkGroups}
                    projectId={draft.project?.id ?? null}
                    projectNumber={draft.project?.projectNumber ?? null}
                    receiverUserId={draft.receiver?.id ?? null}
                    online={online}
                    errors={errorByField}
                    holeReloadKey={reloadKey}
                    onHolesLoadError={holeLoadError(unit.clientRowId)}
                    onChange={(recipe) => changeUnit(unit.clientRowId, recipe)}
                  />
                </UnitRow>
              );
            })}
          </ol>
          <div id={fieldId('units')} className="flex flex-col gap-2 border-t p-5">
            {errorByField.get('units') ? (
              <FieldErrorText>{errorByField.get('units')}</FieldErrorText>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                id="receive-add-unit"
                onClick={() => addUnit()}
                aria-keyshortcuts={ADD_UNIT_SHORTCUT}
              >
                <Plus aria-hidden="true" />
                Add unit
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={unitCount === 0}
                onClick={() => {
                  const last = draft.units.at(-1);
                  if (last) copy(last.clientRowId);
                }}
              >
                <CopyPlus aria-hidden="true" />
                Copy previous unit
              </Button>
            </div>
            <p className="text-muted-foreground m-0 text-[13px]">
              <Kbd>Enter</Kbd> on the last row adds a unit · <Kbd>Shift+Enter</Kbd> copies it (same
              hole, next unit) · <Kbd>{ADD_UNIT_SHORTCUT}</Kbd> adds a unit from anywhere. One
              samples and depth summary per test hole; individual samples are only listed later, in
              lab requests.
            </p>
          </div>
        </section>

        <section aria-labelledby="receive-received" className="bg-card rounded-xl border p-5">
          <h2 id="receive-received" className="m-0 mb-4 text-base font-semibold">
            Received
          </h2>
          <div className="grid gap-4 md:grid-cols-[12rem_minmax(0,1fr)] lg:grid-cols-[12rem_minmax(0,24rem)_minmax(0,1fr)]">
            <LabeledField
              id={fieldId('receivedDate')}
              label="Received date"
              error={errorByField.get('receivedDate')}
            >
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  className="font-mono"
                  required
                  value={draft.receivedDate}
                  onChange={(e) => set({ receivedDate: e.target.value })}
                />
              )}
            </LabeledField>
            <div id={fieldId('receiverUserId')} className="flex min-w-0 flex-col gap-1.5">
              {/* Never `stationPerson`: on LAB it starts blank and someone must choose
                  (T8/AC5, STRATA-107). Anyone can change it; it is attribution only. */}
              <ReceiverSelect
                label="Received by"
                required
                value={draft.receiver}
                onChange={(receiver) => set({ receiver })}
                error={errorByField.get('receiverUserId')}
                // MM-T07: say what to do when the person isn't in the list.
                hint={`${
                  onStation
                    ? 'Choose who took the delivery. Search by initials or name.'
                    : 'Starts as you. Change it when receiving for someone else.'
                } ${NOT_LISTED_MESSAGE}`}
              />
              {forSomeoneElse ? (
                <p className="text-muted-foreground m-0 text-[13px]" role="status">
                  {forSomeoneElse}
                </p>
              ) : null}
              {staffError ? <FieldErrorText>The staff list couldn't load.</FieldErrorText> : null}
            </div>
            <LabeledField
              id={fieldId('description')}
              label="Description (optional)"
              hint="What arrived, e.g. 4 buckets from the drill crew."
              error={errorByField.get('description')}
              className="md:col-span-2 lg:col-span-1"
            >
              {(props) => (
                <Textarea
                  {...props}
                  rows={2}
                  maxLength={2000}
                  value={draft.description}
                  onChange={(e) => set({ description: e.target.value })}
                />
              )}
            </LabeledField>
          </div>
        </section>
      </div>

      <div
        role="region"
        aria-label="Confirm receipt"
        className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky bottom-0 z-20 border-t backdrop-blur"
      >
        <div className="flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
          <div className="min-w-0 text-sm" aria-live="polite">
            {sessionExpired ? (
              <span>{formatUnitCount(unitCount)} · Sign in again to confirm them</span>
            ) : !online ? (
              <span>{OFFLINE_CONFIRM_MESSAGE}</span>
            ) : shown.length > 0 ? (
              <span className="text-destructive-text flex flex-wrap items-center gap-x-2">
                {formatFixCount(shown.length)}…
                <Button
                  type="button"
                  variant="link"
                  className="text-destructive-text h-auto p-0"
                  onClick={() => focusField(fieldId(shown[0]!.field || 'projectId'))}
                >
                  Go to the first
                </Button>
              </span>
            ) : (
              <span>
                <span className="font-semibold">{formatUnitCount(unitCount)}</span> · IDs issue on
                confirm
              </span>
            )}
          </div>
          {sessionExpired ? (
            <Button type="button" onClick={() => void signIn()}>
              Sign in to confirm
            </Button>
          ) : (
            <Button
              type="button"
              onClick={askToConfirm}
              disabled={!online || confirming}
              aria-busy={confirming}
            >
              {confirming ? (
                <>
                  <Spinner aria-hidden="true" role="presentation" /> Confirming…
                </>
              ) : (
                'Confirm and print labels'
              )}
            </Button>
          )}
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="sm:max-w-[480px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm receipt of {formatUnitCount(unitCount)}?</AlertDialogTitle>
            <AlertDialogDescription>
              This issues their IDs and can’t be undone: IDs never change and are never reused.
              Details can still be corrected afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul
            aria-label="IDs to be issued"
            className={cn(
              'm-0 flex list-none flex-col divide-y rounded-md border p-0',
              unitCount > 6 && 'max-h-72 overflow-y-auto',
            )}
          >
            {draft.units.map((unit) => (
              <li
                key={unit.clientRowId}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate">
                  {UNIT_KIND_LABEL[unitKindOf(unit)]} ·{' '}
                  <span className="font-mono">{unitSourceText(draft, unit)}</span>
                </span>
                <span className="text-muted-foreground shrink-0 font-mono text-[13px]">
                  New {UNIT_PREFIX[unit.unitType]}- ID
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground m-0 text-[13px]">
            Labels are sent to the label printer when you confirm.
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void send()}>
              Confirm {unitsText(unitCount)} and print labels
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent className="sm:max-w-[480px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything entered in this receipt is removed from this computer. This can't be
              undone.
              {record.status === 'confirming'
                ? ' If its confirmation already went through, the storage units stay in Material Mule.'
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void discard()}>
              Discard draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ReceiptBreadcrumb({ page }: { page: string }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link
              to="/receiving-log"
              className="pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              Receiving log
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage className="whitespace-nowrap">{page}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function InlineAlert({ title }: { title: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle className="line-clamp-none">{title}</AlertTitle>
    </Alert>
  );
}

/**
 * The project's existing bulk samples for every bulk row (MM-T36), loaded once a bucket is a
 * bulk bucket and again after the server refuses the receipt (`reload` changes).
 */
function useProjectBulkGroups(
  projectId: string | null,
  needed: boolean,
  reload: number,
): BulkGroupsState {
  const [loaded, setLoaded] = useState<{ key: string; state: BulkGroupsState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${projectId}|${reload}|${attempt}`;
  useEffect(() => {
    if (!projectId || !needed) return;
    let current = true;
    listBulkGroups(projectId).then(
      (groups) => current && setLoaded({ key, state: { state: 'ready', groups } }),
      () =>
        current &&
        setLoaded({
          key,
          state: { state: 'error', retry: () => setAttempt((n) => n + 1) },
        }),
    );
    return () => {
      current = false;
    };
  }, [projectId, needed, key]);
  if (!projectId || !needed) return { state: 'idle' };
  return loaded?.key === key ? loaded.state : { state: 'loading' };
}
