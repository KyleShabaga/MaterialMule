import type { ConfirmReceiptResponse, MeResponse, StaffOption } from '@trapezoid/shared';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { listActiveStaff } from '../api/projects';
import { ReceiverSelect } from '../components/ReceiverSelect';
import { ConfirmDialog, FormField, PageHeader } from '../components/ui';
import { useOnline } from '../lib/online';
import { LAB_EXPIRED_MESSAGE } from '../pages/SignInPage';
import { useSession } from '../session/context';
import { confirmReceipt } from './api';
import {
  describeErrors,
  duplicateUnit,
  fieldId,
  formatUnitCount,
  newUnit,
  toConfirmRequest,
  validateDraft,
  type DraftProblem,
  type ReceiptDraft,
  type UnitDraft,
} from './draft';
import { DraftStatusLine } from './drafts/DraftStatusLine';
import { ReceiverHandover } from './drafts/ReceiverHandover';
import type { StoredDraft } from './drafts/record';
import { ErrorSummary } from './ErrorSummary';
import { focusField } from './focus';
import { LabelsStep } from './LabelsStep';
import { ProjectPicker } from './ProjectPicker';
import { ReceiptReview } from './ReviewStep';
import { UnitEditor } from './UnitEditor';
import { useReceiptDraft } from './useReceiptDraft';

// Receiving wizard (TRP-T10): Details and storage units → Review receipt → Labels and finish.
// One SAMPLE#/DEPTH summary per test hole per storage unit; never an individual sample list.
// The draft is autosaved on this workstation and survives reloads, crashes and an expired
// session (TRP-T11); it is deleted once the receipt is confirmed or the user discards it.

type Step = 'details' | 'review' | 'labels';

const STEPS: { key: Step; label: string }[] = [
  { key: 'details', label: 'Details and storage units' },
  { key: 'review', label: 'Review receipt' },
  { key: 'labels', label: 'Labels and finish' },
];

const ADD_UNIT_SHORTCUT = 'Alt+N';
const OFFLINE_CONFIRM_MESSAGE = "You're offline. Your draft is kept. Connect to confirm.";
const PERSONAL_EXPIRED_MESSAGE =
  'Your session has expired. Your draft is saved. Sign in to confirm.';
const RESUMED_CONFIRMING_MESSAGE =
  "This receipt was being confirmed when Trapezoid closed. Confirming again sends the same receipt and won't create duplicates.";

export function ReceiptWizard({
  initial,
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
  const { refresh } = useSession();
  const online = useOnline();
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [staffError, setStaffError] = useState(false);
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
    resumed ? (initial.status === 'confirming' ? 'review' : initial.step) : 'details',
  );
  /** LAB handover (TRP-T11): the receiver stays until someone explicitly picks another. */
  const [handover, setHandover] = useState<'ask' | 'changed' | 'kept'>(() =>
    resumed && initial.owner.type === 'lab' && initial.data.receiver ? 'ask' : 'kept',
  );
  const [sessionExpired, setSessionExpired] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const autoResent = useRef(false);
  /** Problems are shown once the user tries to move on, then kept live as they fix them. */
  const [attempts, setAttempts] = useState(0);
  const [serverProblems, setServerProblems] = useState<DraftProblem[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [result, setResult] = useState<ConfirmReceiptResponse | null>(null);
  /** Element id to focus after the next render (a unit heading, the step heading, a field). */
  const focusTarget = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    listActiveStaff().then(
      (people) => current && setStaff(people),
      () => current && setStaffError(true),
    );
    return () => {
      current = false;
    };
  }, []);

  // After a step change or a new unit, put focus where the user expects it once it's rendered.
  useEffect(() => {
    if (focusTarget.current) {
      focusField(focusTarget.current);
      focusTarget.current = null;
    }
  });

  const problems = useMemo(() => validateDraft(draft), [draft]);
  const shown = useMemo(
    () => (attempts > 0 ? [...problems, ...serverProblems] : serverProblems),
    [attempts, problems, serverProblems],
  );
  const errorByField = useMemo(() => {
    const map = new Map<string, string>();
    for (const problem of shown)
      if (!map.has(problem.field)) map.set(problem.field, problem.message);
    return map;
  }, [shown]);

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

  function addUnit() {
    const unit = newUnit();
    change((current) => ({ ...current, units: [...current.units, unit] }));
    focusTarget.current = `unit-${unit.clientRowId}-heading`;
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
    focusTarget.current = `unit-${copy.clientRowId}-heading`;
  }

  function remove(clientRowId: string) {
    change((current) => ({
      ...current,
      units: current.units.filter((u) => u.clientRowId !== clientRowId),
    }));
  }

  function goToStep(next: Step, focus = 'wizard-step-heading') {
    setStep(next);
    if (next !== 'labels') void saveStep(next);
    focusTarget.current = focus;
  }

  function next() {
    setAttempts((n) => n + 1);
    if (problems.length > 0 || serverProblems.length > 0) return;
    goToStep('review');
  }

  async function confirm() {
    if (!online || confirming) return;
    setConfirmError(null);
    setSessionExpired(false);
    if (problems.length > 0) {
      // The error summary takes focus on the details step.
      setAttempts((n) => n + 1);
      setStep('details');
      void saveStep('details');
      return;
    }
    setConfirming(true);
    // Stored as "confirming" before the request leaves, so a crash before the answer resumes by
    // resending with the same idempotency key (TRP-T09 then returns the original IDs).
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
      case 'invalid':
        void setStatus('editing');
        setServerProblems(describeErrors(draft, outcome.errors));
        setAttempts((n) => n + 1);
        setStep('details');
        void saveStep('details');
        break;
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

  async function discard() {
    setDiscardOpen(false);
    try {
      await removeDraft();
      onDiscarded();
    } catch {
      setDiscardError("The draft couldn't be discarded. Try again.");
    }
  }

  function onDetailsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Add unit shortcut (shown next to the button). Enter never submits the receipt: there is
    // no form, and only Next moves on.
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      addUnit();
    }
  }

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div onBlur={() => void flush()}>
      <PageHeader
        title="Receive samples"
        actions={
          step !== 'labels' ? (
            <button type="button" onClick={() => setDiscardOpen(true)} disabled={confirming}>
              Discard draft
            </button>
          ) : null
        }
      />
      {step !== 'labels' ? (
        <DraftStatusLine saveState={saveState} receiver={draft.receiver} />
      ) : null}
      {discardError ? (
        <p className="field-error" role="alert">
          {discardError}
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
      <ol className="wizard-steps" aria-label="Receiving steps">
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
      <h2 id="wizard-step-heading" className="visually-hidden" tabIndex={-1}>
        Step {stepIndex + 1} of 3: {STEPS[stepIndex]!.label}
      </h2>

      {step === 'details' ? (
        <div className="receipt-draft wizard-step" onKeyDown={onDetailsKeyDown}>
          {!online ? (
            <p className="badge badge-warning" role="status">
              Offline: your entries are kept here. Connect to add a project or test hole.
            </p>
          ) : null}
          <ErrorSummary problems={shown} attempt={attempts} />

          <div className="card">
            <div id={fieldId('projectId')}>
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
                receiverUserId={draft.receiver?.id ?? null}
                online={online}
              />
              {errorByField.get('projectId') ? (
                <p className="field-error">{errorByField.get('projectId')}</p>
              ) : null}
            </div>

            <FormField
              id={fieldId('receivedDate')}
              label="Received date"
              error={errorByField.get('receivedDate')}
            >
              {(props) => (
                <input
                  {...props}
                  type="date"
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

            <FormField
              id={fieldId('description')}
              label="Description (optional)"
              hint="What arrived, e.g. 4 buckets from the drill crew."
              error={errorByField.get('description')}
            >
              {(props) => (
                <textarea
                  {...props}
                  rows={2}
                  maxLength={2000}
                  value={draft.description}
                  onChange={(e) => set({ description: e.target.value })}
                />
              )}
            </FormField>
          </div>

          <section className="card" aria-labelledby="units-heading">
            <div className="section-header">
              <h2 id="units-heading">Storage units</h2>
              <p className="quantity" aria-live="polite">
                {formatUnitCount(draft.units.length)}
              </p>
            </div>
            <p className="field-hint">
              One summary per test hole (ALL, sample range, depth range or custom). Individual
              samples are listed later, in lab requests.
            </p>
            <div className="unit-list">
              {draft.units.map((unit, index) => (
                <UnitEditor
                  key={unit.clientRowId}
                  unit={unit}
                  index={index}
                  projectId={draft.project?.id ?? null}
                  receiverUserId={draft.receiver?.id ?? null}
                  online={online}
                  errors={errorByField}
                  onChange={(recipe) => changeUnit(unit.clientRowId, recipe)}
                  onDuplicate={() => duplicate(unit.clientRowId)}
                  onRemove={() => remove(unit.clientRowId)}
                />
              ))}
            </div>
            <div id={fieldId('units')}>
              {errorByField.get('units') ? (
                <p className="field-error">{errorByField.get('units')}</p>
              ) : null}
              <button type="button" onClick={addUnit} aria-keyshortcuts={ADD_UNIT_SHORTCUT}>
                Add bucket
              </button>{' '}
              <span className="field-hint">Shortcut: {ADD_UNIT_SHORTCUT}</span>
            </div>
          </section>

          <div className="wizard-actions">
            <span className="quantity">{formatUnitCount(draft.units.length)}</span>
            <button type="button" className="primary" onClick={next}>
              Next: Review
            </button>
          </div>
        </div>
      ) : null}

      {step === 'review' ? (
        <div className="wizard-step">
          <ErrorSummary problems={serverProblems} attempt={0} />
          {resumed && initial.status === 'confirming' ? (
            <p className="notice" role="status">
              {RESUMED_CONFIRMING_MESSAGE}
            </p>
          ) : null}
          <ReceiptReview
            draft={draft}
            onEditDetails={() => goToStep('details', fieldId('projectId'))}
            onEditUnit={(clientRowId) => goToStep('details', `unit-${clientRowId}-heading`)}
          />
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
          {sessionExpired ? (
            <div className="notice offline-notice" role="alert">
              <p>
                {me.accountType === 'shared_lab' ? LAB_EXPIRED_MESSAGE : PERSONAL_EXPIRED_MESSAGE}
              </p>
              <button type="button" className="primary" onClick={() => void signIn()}>
                Sign in
              </button>
            </div>
          ) : null}
          <div className="wizard-actions">
            <button type="button" onClick={() => goToStep('details')} disabled={confirming}>
              Back
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void confirm()}
              disabled={!online || confirming}
              aria-busy={confirming}
            >
              {confirming ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Confirming…
                </>
              ) : (
                'Confirm receipt'
              )}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'labels' && result ? (
        <div className="wizard-step">
          <LabelsStep draft={draft} result={result} onReceiveAnother={onStartNew} />
        </div>
      ) : null}

      <ConfirmDialog
        open={discardOpen}
        title="Discard this draft?"
        confirmLabel="Discard draft"
        onConfirm={() => void discard()}
        onCancel={() => setDiscardOpen(false)}
      >
        <p>
          Everything entered in this receipt is removed from this computer. This can't be undone.
          {record.status === 'confirming'
            ? ' If its confirmation already went through, the storage units stay in Trapezoid.'
            : ''}
        </p>
      </ConfirmDialog>
    </div>
  );
}
