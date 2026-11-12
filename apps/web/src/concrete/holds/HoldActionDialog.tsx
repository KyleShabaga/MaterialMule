import {
  CONCRETE_HOLD_KIND_LABEL,
  concreteRescheduledTarget,
  type ConcreteHoldKind,
  type ReceiverOption,
} from '@materialmule/shared';
import { useState } from 'react';
import { ReceiverSelect } from '../../components/ReceiverSelect';
import { ConfirmDialog, FormField } from '../../components/app-ui';
import {
  authorizeDisposal,
  recordDisposal,
  scheduleTest,
  type ActionProblem,
  type ActionResult,
} from './api';

export type HoldAction = 'schedule_test' | 'authorize_disposal' | 'record_disposal';

/** What the confirmation list needs of each selected specimen. */
export interface HoldTarget {
  specimenId: string;
  label: string;
  projectNumber: string;
  holdKind: ConcreteHoldKind;
  castingDate: string | null;
  holdExpiresOn: string | null;
  version: number;
}

const TITLE: Record<HoldAction, string> = {
  schedule_test: 'Schedule test',
  authorize_disposal: 'Authorize disposal',
  record_disposal: 'Record disposal',
};

/** Fields this dialog shows an error beside; any other error (or none) is the alert below. */
const SHOWN_FIELDS: Record<HoldAction, readonly string[]> = {
  schedule_test: ['newAge'],
  authorize_disposal: [],
  record_disposal: ['disposedAt', 'performedByUserId'],
};

/** `datetime-local` value for now, in the browser's time zone, to the minute. */
function localNow(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`;
}

/**
 * The confirmation step of one HOLD action on one or more specimens (card §3: the confirmation
 * shows each specimen and its change). Nothing is sent until Confirm; the server checks every
 * specimen again and changes all or none. The reason for Schedule test and Authorize disposal is
 * written in the Holds page's side panel and shown here before it is sent.
 */
export function HoldActionDialog({
  action,
  targets,
  reason: givenReason = '',
  sharedStation,
  onClose,
  onDone,
}: {
  action: HoldAction | null;
  targets: HoldTarget[];
  /** Schedule test and Authorize disposal: the reason from the side panel. */
  reason?: string;
  /** A shared LAB station must name who physically removed the specimens. */
  sharedStation: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const reason = givenReason.trim();
  const [age, setAge] = useState('');
  const [removedAt, setRemovedAt] = useState(localNow);
  const [performer, setPerformer] = useState<ReceiverOption | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [problems, setProblems] = useState<ActionProblem[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const ageNumber = /^\d{1,3}$/.test(age.trim()) ? Number(age.trim()) : null;
  const problemOf = (id: string) =>
    problems.find((p) => p.specimenId === id)?.label ??
    (refused.includes(id) ? 'You can’t act on this specimen' : null);

  function changeOf(target: HoldTarget): string {
    if (action === 'schedule_test') {
      if (ageNumber === null || ageNumber < 1 || !target.castingDate) return 'HOLD → test age';
      return `HOLD → ${ageNumber} d, target ${concreteRescheduledTarget(target.castingDate, ageNumber)}`;
    }
    if (action === 'authorize_disposal') {
      return `${CONCRETE_HOLD_KIND_LABEL[target.holdKind]} → Disposal authorized`;
    }
    return 'Disposal authorized → Disposed';
  }

  async function confirm() {
    if (!action || busy) return;
    setError(null);
    if (action === 'schedule_test' && (ageNumber === null || ageNumber < 1 || ageNumber > 999)) {
      setError({ message: 'Enter a test age of 1 to 999 days', field: 'newAge' });
      return;
    }
    if (action !== 'record_disposal' && reason === '') {
      setError({ message: 'A reason is required: write it in the side panel.', field: 'reason' });
      return;
    }
    if (action === 'record_disposal' && sharedStation && !performer) {
      setError({ message: 'Choose who removed the specimens', field: 'performedByUserId' });
      return;
    }
    if (action === 'record_disposal' && !removedAt) {
      setError({ message: 'Enter the date and time of removal', field: 'disposedAt' });
      return;
    }
    setBusy(true);
    const items = targets.map((t) => ({ specimenId: t.specimenId, version: t.version }));
    let result: ActionResult;
    if (action === 'schedule_test') {
      result = await scheduleTest({
        idempotencyKey: key,
        items,
        newAge: ageNumber!,
        reason,
      });
    } else if (action === 'authorize_disposal') {
      result = await authorizeDisposal({ idempotencyKey: key, items, reason });
    } else {
      result = await recordDisposal({
        idempotencyKey: key,
        specimenIds: targets.map((t) => t.specimenId),
        disposedAt: new Date(removedAt).toISOString(),
        ...(sharedStation && performer ? { performedByUserId: performer.id } : {}),
      });
    }
    setBusy(false);
    if (result.ok) {
      const n = result.data.rows.length;
      const what =
        action === 'schedule_test'
          ? 'scheduled for testing'
          : action === 'authorize_disposal'
            ? 'authorized for disposal'
            : 'recorded as disposed';
      onDone(`${n} ${n === 1 ? 'specimen' : 'specimens'} ${what}.`);
      return;
    }
    // A refusal changed nothing: a new key for the next attempt.
    setKey(crypto.randomUUID());
    setProblems(result.problems ?? []);
    setRefused(result.refused ?? []);
    setError({ message: result.message, field: result.field });
  }

  if (!action) return null;
  const fieldError = (field: string) => (error?.field === field ? error.message : null);
  return (
    <ConfirmDialog
      open
      title={`${TITLE[action]}: ${targets.length} ${targets.length === 1 ? 'specimen' : 'specimens'}`}
      confirmLabel={busy ? 'Saving…' : `Confirm ${TITLE[action].toLowerCase()}`}
      danger={action === 'record_disposal'}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      <div className="hold-dialog">
        {action === 'authorize_disposal' ? (
          <p className="field-hint">
            This authorizes disposal only. Lab staff record the actual removal later from Ready for
            disposal.
          </p>
        ) : null}
        {action === 'schedule_test' ? (
          <FormField label="Test age (days)" required error={fieldError('newAge')}>
            {(props) => (
              <input
                {...props}
                inputMode="numeric"
                value={age}
                onChange={(e) => setAge(e.target.value)}
                required
              />
            )}
          </FormField>
        ) : null}
        {action !== 'record_disposal' ? (
          <div className="hold-dialog-reason">
            <span className="field-label">Reason</span>
            <p>{reason || 'None written yet.'}</p>
          </div>
        ) : (
          <>
            <FormField label="Removed at" required error={fieldError('disposedAt')}>
              {(props) => (
                <input
                  {...props}
                  type="datetime-local"
                  value={removedAt}
                  onChange={(e) => setRemovedAt(e.target.value)}
                  required
                />
              )}
            </FormField>
            {sharedStation ? (
              <ReceiverSelect
                label="Removed by"
                required
                value={performer}
                onChange={setPerformer}
                error={fieldError('performedByUserId')}
                hint="Who physically removed the specimens. Attribution only."
              />
            ) : (
              <p className="field-hint">Recorded as removed by you.</p>
            )}
          </>
        )}
        <h3 className="hold-dialog-heading">Specimens and changes</h3>
        <ul className="hold-confirm-list" aria-label="Specimens and changes">
          {targets.map((t) => {
            const problem = problemOf(t.specimenId);
            return (
              <li key={t.specimenId}>
                <strong>{t.label}</strong> <span className="field-hint">{t.projectNumber}</span>
                <span className="hold-change"> {changeOf(t)}</span>
                {problem ? <span className="field-error"> {problem}</span> : null}
              </li>
            );
          })}
        </ul>
        {error && !SHOWN_FIELDS[action].includes(error.field ?? '') ? (
          <p className="field-error" role="alert">
            {error.message}
          </p>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
