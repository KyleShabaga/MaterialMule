import {
  formatReceiver,
  projectLabel,
  type ConfirmReceiptResponse,
  type InventoryLocation,
  type MeResponse,
  type StaffOption,
} from '@materialmule/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { listActiveStaff, listBulkGroups } from '../api/projects';
import { ReceiverSelect } from '../components/ReceiverSelect';
import {
  ConfirmDialog,
  FormField,
  SectionHead,
  SidePanel,
  StatusBadge,
} from '../components/app-ui';
import { fetchLocations } from '../inventory/api';
import { ContextRow } from '../layout/ContextRow';
import { useOnline } from '../lib/online';
import { LAB_EXPIRED_MESSAGE } from '../pages/SignInPage';
import { useSession } from '../session/context';
import { useExpiryClaim } from '../session/expiry-claim';
import { confirmReceipt } from './api';
import {
  describeErrors,
  draftHoleNames,
  duplicateUnit,
  fieldId,
  formatUnitCount,
  isDeliveryField,
  issuePlan,
  newUnit,
  normalizeUnit,
  problemUnitIndex,
  toConfirmRequest,
  validateDraft,
  type DraftProblem,
  type ReceiptDraft,
  type UnitDraft,
} from './draft';
import { DraftStatusLine } from './drafts/DraftStatusLine';
import { ReceiverHandover } from './drafts/ReceiverHandover';
import { openingStep, type StoredDraft } from './drafts/record';
import { ErrorSummary } from './ErrorSummary';
import { focusField } from './focus';
import { ProjectPicker } from './ProjectPicker';
import { ReceiptDone } from './ReceiptDone';
import './receiving.css';
import { UnitEditor, type BulkGroupsState } from './UnitEditor';
import { UnitRow } from './UnitRow';
import { useReceiptDraft } from './useReceiptDraft';

// Receiving (MM-T10, Field Ledger): a draft you finish in three steps, Delivery → Units →
// Confirm and label. Each unit is one row (holder prefix, one SAMPLE#/DEPTH summary per test hole,
// where it will go); never an individual sample list. The draft is autosaved on this workstation
// and survives reloads, crashes and an expired session (MM-T11); it can be left at any step and
// continued from the receiving log. IDs are issued only on confirm, never for a draft.

type Step = 'delivery' | 'units' | 'labels';

const STEPS: { key: Step; label: string }[] = [
  { key: 'delivery', label: 'Delivery' },
  { key: 'units', label: 'Units' },
  { key: 'labels', label: 'Confirm and label' },
];

const ADD_UNIT_SHORTCUT = 'Alt+N';

const formatProblemCount = (count: number) =>
  count === 1 ? '1 problem to fix' : `${count} problems to fix`;
const OFFLINE_CONFIRM_MESSAGE = "You're offline. Your draft is kept. Connect to confirm.";
const PERSONAL_EXPIRED_MESSAGE =
  'Your session has expired. Your draft is saved. Sign in to confirm.';
const RESUMED_CONFIRMING_MESSAGE =
  "This receipt was being confirmed when Material Mule closed. Confirming again sends the same receipt and won't create duplicates.";

/** Rows that start open: those with something still to fill in. */
function rowsWithProblems(draft: ReceiptDraft, problems: DraftProblem[]): Set<string> {
  const open = new Set<string>();
  for (const problem of problems) {
    const index = problemUnitIndex(problem.field);
    const unit = index === null ? undefined : draft.units[index];
    if (unit) open.add(unit.clientRowId);
  }
  return open;
}

/** Drafts saved before a unit field existed open with it filled in (e.g. where it will go). */
function normalized(record: StoredDraft): StoredDraft {
  return {
    ...record,
    data: { ...record.data, units: record.data.units.map((unit) => normalizeUnit(unit)) },
  };
}

export function ReceiptWizard({
  initial: saved,
  persisted,
  resumed,
  me,
  onStartNew,
  onDiscarded,
}: {
  initial: StoredDraft;
  /** Already in storage (resumed), as opposed to a new draft saved on its first change. */
  persisted: boolean;
  /** Opened from the draft list or a link, rather than started here just now. */
  resumed: boolean;
  me: MeResponse;
  onStartNew: () => void;
  onDiscarded: () => void;
}) {
  const [initial] = useState(() => normalized(saved));
  const { refresh } = useSession();
  const navigate = useNavigate();
  const online = useOnline();
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [staffError, setStaffError] = useState(false);
  const [staffLoaded, setStaffLoaded] = useState(false);
  const locations = useActiveLocations();
  const {
    draft,
    record,
    saveState,
    update,
    flush,
    setStep: saveStep,
    setStatus,
    remove: removeDraft,
  } = useReceiptDraft(initial, { accountId: me.id, persisted });
  const [step, setStep] = useState<Step>(() =>
    resumed ? (initial.status === 'confirming' ? 'units' : openingStep(initial)) : 'delivery',
  );
  /** LAB handover (MM-T11): the receiver stays until someone explicitly picks another. */
  const [handover, setHandover] = useState<'ask' | 'changed' | 'kept'>(() =>
    resumed && initial.owner.type === 'lab' && initial.data.receiver ? 'ask' : 'kept',
  );
  const [sessionExpired, setSessionExpired] = useState(false);
  const markExpired = useCallback(() => setSessionExpired(true), []);
  // A session that ends in the background (window focus re-check, another request) shows the
  // saved-draft sign-in below instead of leaving the draft at once; confirming still needs a
  // session on the server. Once confirmed (labels), there is no draft left to keep.
  useExpiryClaim(step !== 'labels', markExpired);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const autoResent = useRef(false);
  /** Problems show once the user tries to move on, then stay live as they fix them. */
  const [deliveryAttempts, setDeliveryAttempts] = useState(0);
  const [unitAttempts, setUnitAttempts] = useState(0);
  const [serverProblems, setServerProblems] = useState<DraftProblem[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [result, setResult] = useState<ConfirmReceiptResponse | null>(null);
  const [printOnConfirm, setPrintOnConfirm] = useState(true);
  const [leaveError, setLeaveError] = useState(false);
  /** Unit rows whose editor is open. New and unfinished units start open. */
  const [openRows, setOpenRows] = useState<Set<string>>(() =>
    rowsWithProblems(initial.data, validateDraft(initial.data)),
  );
  /** Element id to focus after the next render (a unit heading, the step heading, a field). */
  const focusTarget = useRef<string | null>(null);
  const bulkGroups = useProjectBulkGroups(
    draft.project?.id ?? null,
    draft.units.some((unit) => unit.unitType === 'bucket' && unit.bulk),
    // A refused confirmation may mean a chosen bulk sample was corrected: offer the new identity.
    serverProblems.length,
  );

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

  // After a step change or a new unit, put focus where the user expects it once it's rendered.
  // Keep the target until it exists: effects of a commit made before the click (a list or save
  // resolving) can run after the handler set the target but before the new step renders (MM-T71).
  useEffect(() => {
    if (focusTarget.current && focusField(focusTarget.current)) {
      focusTarget.current = null;
    }
  });

  const problems = useMemo(() => validateDraft(draft), [draft]);
  const deliveryShown = useMemo(
    () =>
      [...(deliveryAttempts > 0 ? problems : []), ...serverProblems].filter((p) =>
        isDeliveryField(p.field),
      ),
    [deliveryAttempts, problems, serverProblems],
  );
  const unitsShown = useMemo(
    () =>
      [...(unitAttempts > 0 ? problems : []), ...serverProblems].filter(
        (p) => !isDeliveryField(p.field),
      ),
    [unitAttempts, problems, serverProblems],
  );
  const errorByField = useMemo(() => {
    const map = new Map<string, string>();
    for (const problem of [...deliveryShown, ...unitsShown])
      if (!map.has(problem.field)) map.set(problem.field, problem.message);
    return map;
  }, [deliveryShown, unitsShown]);
  // A row with a problem on show stays open, so the error summary's links reach its fields.
  const forcedOpen = useMemo(() => rowsWithProblems(draft, unitsShown), [draft, unitsShown]);

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
  const openRow = (clientRowId: string) => setOpenRows((rows) => new Set(rows).add(clientRowId));

  /**
   * Adds a unit and focuses its heading; with `toHoles` (the Alt+N shortcut, MM-T66 UI-05) its
   * test hole search instead, so typing goes straight into it. Without a project there is no
   * search yet, so the heading gets focus.
   */
  function addUnit(toHoles = false) {
    const unit = newUnit();
    const index = draft.units.length;
    change((current) => ({ ...current, units: [...current.units, unit] }));
    openRow(unit.clientRowId);
    focusTarget.current =
      toHoles && draft.project
        ? fieldId(`units.${index}.holeSummaries`)
        : `unit-${unit.clientRowId}-heading`;
  }

  function duplicate(clientRowId: string) {
    const source = draft.units.find((u) => u.clientRowId === clientRowId);
    if (!source) return;
    const copy = duplicateUnit(source);
    change((current) => {
      const index = current.units.findIndex((u) => u.clientRowId === clientRowId);
      const units = [...current.units];
      units.splice(index + 1, 0, copy);
      return { ...current, units };
    });
    openRow(copy.clientRowId);
    focusTarget.current = `unit-${copy.clientRowId}-heading`;
  }

  /** Removes a unit; focus goes to the unit before it, or Add a storage unit (MTR-136). */
  function remove(clientRowId: string) {
    const index = draft.units.findIndex((u) => u.clientRowId === clientRowId);
    const previous = index > 0 ? draft.units[index - 1] : undefined;
    change((current) => ({
      ...current,
      units: current.units.filter((u) => u.clientRowId !== clientRowId),
    }));
    focusTarget.current = previous ? `unit-${previous.clientRowId}-heading` : 'wizard-add-unit';
  }

  function toggleRow(clientRowId: string) {
    setOpenRows((rows) => {
      const next = new Set(rows);
      if (next.has(clientRowId)) next.delete(clientRowId);
      else next.add(clientRowId);
      return next;
    });
  }

  function goToStep(next: Step, focus = 'wizard-step-heading') {
    setStep(next);
    if (next !== 'labels') void saveStep(next);
    focusTarget.current = focus;
  }

  /** Delivery → Units, once the delivery's own fields are right. */
  function next() {
    setDeliveryAttempts((n) => n + 1);
    if ([...problems, ...serverProblems].some((p) => isDeliveryField(p.field))) return;
    goToStep('units');
  }

  /** Sends the user to the problems: Delivery's on Delivery, the units' open on Units. */
  function showProblems(found: DraftProblem[]) {
    const atDelivery = found.some((p) => isDeliveryField(p.field));
    setOpenRows((rows) => new Set([...rows, ...rowsWithProblems(draft, found)]));
    setUnitAttempts((n) => n + 1);
    if (atDelivery) {
      setDeliveryAttempts((n) => n + 1);
      setStep('delivery');
      void saveStep('delivery');
    }
  }

  async function confirm() {
    if (!online || confirming) return;
    setConfirmError(null);
    setSessionExpired(false);
    if (problems.length > 0) {
      // The error summary takes focus on the step that holds the first problem.
      showProblems(problems);
      return;
    }
    setConfirming(true);
    // Stored as "confirming" before the request leaves, so a crash before the answer resumes by
    // resending with the same idempotency key (MM-T09 then returns the original IDs).
    await setStatus('confirming');
    const outcome = await confirmReceipt(toConfirmRequest(draft));
    setConfirming(false);
    switch (outcome.kind) {
      case 'confirmed':
        setResult(outcome.response);
        goToStep('labels');
        // If this fails the draft stays listed; resuming it returns these same IDs.
        await removeDraft().catch(() => undefined);
        break;
      case 'invalid': {
        void setStatus('editing');
        const refused = describeErrors(draft, outcome.errors);
        setServerProblems(refused);
        showProblems(refused);
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
    void confirm();
  });

  /** Re-checks the session; once it has ended, the app goes to sign-in and back to this draft. */
  async function signIn() {
    await flush();
    await refresh();
  }

  /** Saves now and goes to the receiving log, where the draft is offered back with Continue. */
  async function leave() {
    setLeaveError(false);
    if (await flush()) navigate('/receiving-log');
    else setLeaveError(true);
  }

  const expiredNotice = sessionExpired ? (
    <div className="notice offline-notice" role="alert">
      <p>{me.accountType === 'shared_lab' ? LAB_EXPIRED_MESSAGE : PERSONAL_EXPIRED_MESSAGE}</p>
      <button type="button" className="primary" onClick={() => void signIn()}>
        Sign in
      </button>
    </div>
  ) : null;

  async function discard() {
    setDiscardOpen(false);
    try {
      await removeDraft();
      onDiscarded();
    } catch {
      setDiscardError("The draft couldn't be discarded. Try again.");
    }
  }

  // Add unit shortcut (shown next to the button), on the whole page while Units is open, so it
  // still works after Enter has left a test hole search (MM-T66 UI-06 leaves focus on the page).
  // Never while a dialog is open. Enter never submits the receipt: there is no form, and only
  // the step buttons move on.
  const addUnitByShortcut = useRef<() => void>(() => undefined);
  useEffect(() => {
    addUnitByShortcut.current = () => addUnit(true);
  });
  useEffect(() => {
    if (step !== 'units') return;
    function onKeyDown(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.key.toLowerCase() !== 'n')
        return;
      if (event.defaultPrevented || event.repeat) return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      addUnitByShortcut.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [step]);

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const discardButton = (
    <button
      type="button"
      className="danger"
      onClick={() => setDiscardOpen(true)}
      disabled={confirming}
    >
      Discard draft
    </button>
  );
  const leaveButton = (
    <button type="button" onClick={() => void leave()} disabled={confirming}>
      Save draft and leave
    </button>
  );
  const projectNumber = draft.project?.projectNumber ?? null;
  const holes = draftHoleNames(draft);
  const plan = issuePlan(draft);
  const unitCount = draft.units.length;
  const labelsText = unitCount === 1 ? 'Print 1 label' : `Print ${unitCount} labels`;
  const meta =
    step === 'delivery'
      ? 'Step 1 of 3 · Nothing is in inventory yet'
      : `${projectNumber ?? 'No project'} · Received ${draft.receivedDate}`;
  const title =
    step === 'labels' && result
      ? result.units.length === 1
        ? '1 ID issued'
        : `${result.units.length} IDs issued`
      : 'Receive samples';

  return (
    <div className="receive-wizard" onBlur={() => void flush()}>
      <ContextRow className="receive-context">
        {step === 'labels' ? (
          <StatusBadge tone="storage">CONFIRMED</StatusBadge>
        ) : (
          <StatusBadge tone="waiting">DRAFT</StatusBadge>
        )}
        <div className="receive-context-note">
          {step === 'labels' ? (
            'These units are now in inventory.'
          ) : (
            <>
              <DraftStatusLine saveState={saveState} receiver={draft.receiver} />
              <span>Nothing is in inventory until you confirm.</span>
            </>
          )}
        </div>
        <ol className="receive-steps" aria-label="Receiving steps">
          {STEPS.map((s, index) => (
            <li
              key={s.key}
              aria-current={s.key === step ? 'step' : undefined}
              className={index < stepIndex ? 'done' : undefined}
            >
              <span className="step-number">{index + 1}</span> {s.label}
            </li>
          ))}
        </ol>
      </ContextRow>
      <div className="receive-title">
        <h1>{title}</h1>
        <p className="receive-title-meta">{meta}</p>
      </div>
      {discardError ? (
        <p className="field-error" role="alert">
          {discardError}
        </p>
      ) : null}
      {leaveError ? (
        <p className="field-error" role="alert">
          The draft couldn&apos;t be saved on this computer, so it stays open. Try again.
        </p>
      ) : null}
      {handover === 'ask' && draft.receiver && step !== 'labels' ? (
        <ReceiverHandover
          receiver={draft.receiver}
          onChange={(receiver) => {
            set({ receiver });
            setHandover('changed');
          }}
          onKeep={() => setHandover('kept')}
        />
      ) : null}
      {handover === 'changed' && draft.receiver && step !== 'labels' ? (
        <p className="notice" role="status">
          Receiver changed to {draft.receiver.initials}. The change is recorded in this draft's
          history.
        </p>
      ) : null}
      <h2 id="wizard-step-heading" className="visually-hidden" tabIndex={-1}>
        Step {stepIndex + 1} of 3: {STEPS[stepIndex]!.label}
      </h2>

      {step === 'delivery' ? (
        <div className="receive-columns wizard-step">
          <section className="receive-main" aria-labelledby="delivery-heading">
            <h2 id="delivery-heading" className="visually-hidden">
              Delivery
            </h2>
            {!online ? (
              <p className="badge badge-warning" role="status">
                Offline: your entries are kept here. Connect to add a project or test hole.
              </p>
            ) : null}
            {expiredNotice}
            <ErrorSummary problems={deliveryShown} attempt={deliveryAttempts} />

            <div id={fieldId('projectId')} className="receive-project">
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
              />
              {errorByField.get('projectId') ? (
                <p className="field-error">{errorByField.get('projectId')}</p>
              ) : null}
            </div>

            <div className="receive-fields">
              <FormField
                id={fieldId('receivedDate')}
                label="Received date"
                error={errorByField.get('receivedDate')}
                required
              >
                {(props) => (
                  <input
                    {...props}
                    type="date"
                    className="mono"
                    required
                    value={draft.receivedDate}
                    onChange={(e) => set({ receivedDate: e.target.value })}
                  />
                )}
              </FormField>

              <div id={fieldId('receiverUserId')}>
                <ReceiverSelect
                  label="Received by"
                  required
                  value={draft.receiver}
                  onChange={(receiver) => set({ receiver })}
                  error={errorByField.get('receiverUserId')}
                />
                {staffError ? <p className="field-error">The staff list couldn't load.</p> : null}
              </div>
            </div>

            <FormField
              id={fieldId('description')}
              label="Description (optional)"
              hint="What arrived, e.g. 4 buckets from the drill crew."
              error={errorByField.get('description')}
            >
              {(props) => (
                <textarea
                  {...props}
                  rows={3}
                  maxLength={2000}
                  value={draft.description}
                  onChange={(e) => set({ description: e.target.value })}
                />
              )}
            </FormField>

            <div className="receive-actions">
              <button type="button" className="primary receive-big" onClick={next}>
                Next: add the units
              </button>
              {leaveButton}
              {discardButton}
              {deliveryShown.length > 0 ? (
                <span className="wizard-problems">{formatProblemCount(deliveryShown.length)}</span>
              ) : null}
            </div>
          </section>

          <SidePanel title="About this delivery" className="receive-side">
            <p>
              Nothing is in inventory until the delivery is confirmed. IDs are issued then, one per
              storage unit, and never change.
            </p>
            <p className="field-hint">
              “Received by” is the person who took the delivery.
              {me.accountType === 'shared_lab'
                ? ' On the shared LAB station it is chosen here, not taken from the sign-in.'
                : ' It starts as you; change it if someone else took it.'}
            </p>
            <p className="field-hint">
              You can leave this draft at any step. It is kept on this computer and listed in the
              receiving log with Continue.
            </p>
          </SidePanel>
        </div>
      ) : null}

      {step === 'units' ? (
        <div className="receive-columns wizard-step">
          <section className="receive-main" aria-labelledby="units-heading">
            {!online ? (
              <p className="badge badge-warning" role="status">
                Offline: your entries are kept here. Connect to add a project or test hole.
              </p>
            ) : null}
            <ErrorSummary problems={unitsShown} attempt={unitAttempts} />
            {resumed && initial.status === 'confirming' ? (
              <p className="notice" role="status">
                {RESUMED_CONFIRMING_MESSAGE}
              </p>
            ) : null}

            <div className="receive-facts" role="group" aria-label="Delivery">
              <dl>
                <div>
                  <dt>Project</dt>
                  <dd title={draft.project ? projectLabel(draft.project) : undefined}>
                    {projectNumber ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt>Received</dt>
                  <dd className="mono">{draft.receivedDate || '—'}</dd>
                </div>
                <div>
                  <dt>Received by</dt>
                  <dd>{draft.receiver ? formatReceiver(draft.receiver) : '—'}</dd>
                </div>
                <div>
                  <dt>Description</dt>
                  <dd>{draft.description.trim() || 'None'}</dd>
                </div>
              </dl>
              <button
                type="button"
                onClick={() => goToStep('delivery', fieldId('projectId'))}
                disabled={confirming}
              >
                Edit delivery
              </button>
            </div>

            <SectionHead
              id="units-heading"
              title="Storage units in this delivery"
              meta={
                <>
                  <span aria-live="polite">{formatUnitCount(unitCount)}</span>
                  {' · '}
                  <span>{holes.length === 1 ? '1 test hole' : `${holes.length} test holes`}</span>
                </>
              }
            />
            <div className="unit-list receive-units">
              {draft.units.map((unit, index) => {
                const forced = forcedOpen.has(unit.clientRowId);
                const open = forced || openRows.has(unit.clientRowId);
                return (
                  <UnitRow
                    key={unit.clientRowId}
                    unit={unit}
                    index={index}
                    draft={draft}
                    open={open}
                    canClose={!forced}
                    onToggle={() => toggleRow(unit.clientRowId)}
                    onDuplicate={() => duplicate(unit.clientRowId)}
                    onRemove={() => remove(unit.clientRowId)}
                  >
                    <UnitEditor
                      unit={unit}
                      index={index}
                      draft={draft}
                      bulkGroups={bulkGroups}
                      locations={locations}
                      projectId={draft.project?.id ?? null}
                      projectNumber={projectNumber}
                      receiverUserId={draft.receiver?.id ?? null}
                      online={online}
                      errors={errorByField}
                      onChange={(recipe) => changeUnit(unit.clientRowId, recipe)}
                    />
                  </UnitRow>
                );
              })}
            </div>
            <div id={fieldId('units')} className="receive-add">
              {errorByField.get('units') ? (
                <p className="field-error">{errorByField.get('units')}</p>
              ) : null}
              <button
                type="button"
                id="wizard-add-unit"
                className="receive-add-button"
                onClick={() => addUnit()}
                aria-keyshortcuts={ADD_UNIT_SHORTCUT}
              >
                Add a storage unit
              </button>
              {/* Alt+N (MM-T66 UI-05) still lands in the new unit's test-hole search: the
                  holder and Bulk soil sample controls above it are a Shift+Tab away (MM-T36). */}
              <p className="field-hint">
                One samples and depth summary per test hole. Individual samples are only listed
                later, in lab requests. Shortcut: {ADD_UNIT_SHORTCUT} adds a bucket and goes to its
                test-hole search.
              </p>
            </div>
          </section>

          <SidePanel title="On confirm" className="receive-side">
            <p>
              {unitCount === 1
                ? 'One permanent ID is issued.'
                : `${unitCount} permanent IDs are issued.`}{' '}
              They never change, even if a type, date or project is corrected later.
            </p>
            <ul className="receive-issue" aria-label="IDs to be issued">
              {plan.map((row) => (
                <li key={row.prefix}>
                  <span className="mono">{row.masked}</span>
                  <span>{row.text}</span>
                </li>
              ))}
            </ul>
            <label className="checkbox receive-print">
              <input
                type="checkbox"
                checked={printOnConfirm}
                onChange={(e) => setPrintOnConfirm(e.target.checked)}
              />
              <span>
                <strong>{labelsText}</strong>
                <span className="field-hint">Sent to the label printer when you confirm.</span>
              </span>
            </label>
            {!online ? (
              <p className="notice offline-notice" role="status">
                {OFFLINE_CONFIRM_MESSAGE}
              </p>
            ) : null}
            {confirmError ? (
              <p className="field-error" role="alert">
                {confirmError}
              </p>
            ) : null}
            {expiredNotice}
            {unitsShown.length > 0 ? (
              <p className="wizard-problems">{formatProblemCount(unitsShown.length)}</p>
            ) : null}
            <div className="receive-side-actions">
              <button
                type="button"
                className="primary receive-big"
                onClick={() => void confirm()}
                disabled={!online || confirming}
                aria-busy={confirming}
              >
                {confirming ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Confirming…
                  </>
                ) : (
                  'Confirm and issue IDs'
                )}
              </button>
              {leaveButton}
              <button type="button" onClick={() => goToStep('delivery')} disabled={confirming}>
                Back
              </button>
              {discardButton}
            </div>
          </SidePanel>
        </div>
      ) : null}

      {step === 'labels' && result ? (
        <div className="wizard-step">
          <ReceiptDone
            draft={draft}
            result={result}
            autoPrint={printOnConfirm}
            onReceiveAnother={onStartNew}
          />
        </div>
      ) : null}

      <ConfirmDialog
        open={discardOpen}
        title="Discard this draft?"
        confirmLabel="Discard draft"
        danger
        onConfirm={() => void discard()}
        onCancel={() => setDiscardOpen(false)}
      >
        <p>
          Everything entered in this receipt is removed from this computer. This can't be undone.
          {record.status === 'confirming'
            ? ' If its confirmation already went through, the storage units stay in Material Mule.'
            : ''}
        </p>
      </ConfirmDialog>
    </div>
  );
}

/** Active storage locations for "Where it will go"; none (free text only) if they can't load. */
function useActiveLocations(): InventoryLocation[] {
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  useEffect(() => {
    let current = true;
    void fetchLocations().then((result) => {
      if (current && result.ok) setLocations(result.data.filter((l) => l.active));
    });
    return () => {
      current = false;
    };
  }, []);
  return locations;
}

/**
 * The project's existing bulk samples for every bulk row (MM-T36), loaded once a bucket is marked
 * Bulk soil sample and again after the server refuses the receipt (`reload` changes).
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
