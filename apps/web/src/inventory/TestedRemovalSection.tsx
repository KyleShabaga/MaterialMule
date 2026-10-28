import {
  DISPOSED_AFTER_TESTING_LABEL,
  SHELBY_CONTENTS_DESTROYED_LABEL,
  formatPerson,
  testedRemovalReasonLabel,
  type StorageUnitDetail,
  type StorageUnitTesting,
  type TestedRemovalBlocker,
} from '@materialmule/shared';
import { useId, useState, type FormEvent } from 'react';
import { BandedCard } from '../components/ui';
import { confirmTestedRemoval } from './api';

const timeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function when(iso: string) {
  return <time dateTime={iso}>{timeFormat.format(new Date(iso))}</time>;
}

const BLOCKER_TEXT: Record<Exclude<TestedRemovalBlocker, 'not_eligible_unit_type'>, string> = {
  no_tested_evidence:
    'No completed test has recorded this exact unit. A test of the same hole, source, bulk sample or another unit doesn’t count.',
  already_removed: 'Already removed after testing.',
  storage_unit_disposed: 'This unit was disposed another way.',
  location_conflict_open: 'Confirm this unit’s actual location before recording its removal.',
};

/**
 * Testing and removal (MM-T36) for Shelby tubes and bulk soil buckets: the completed tests that
 * used this exact unit, a tested tube's destroyed contents, and the separate personal-account
 * confirmation that the whole unit has physically left the lab. No retention, hold, approval or
 * program closure applies; review and acceptance may stay open.
 */
export function TestedRemovalSection({
  unit,
  testing,
  canRemove,
  onRemoved,
  onStale,
}: {
  unit: StorageUnitDetail;
  testing: StorageUnitTesting;
  canRemove: boolean;
  onRemoved: (message: string) => void;
  onStale: () => void;
}) {
  if (testing.reason === null) return null;
  const isTube = testing.reason === 'tested_shelby';
  return (
    <BandedCard id="testing" title="Testing and removal">
      <dl className="details">
        {isTube ? (
          <div>
            <dt>Contents</dt>
            <dd>
              {testing.contentsDestroyed ? (
                <strong>{SHELBY_CONTENTS_DESTROYED_LABEL}</strong>
              ) : (
                'Available for testing'
              )}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Tested in</dt>
          <dd>
            {testing.evidence.length === 0 ? (
              'No completed test has recorded this unit.'
            ) : (
              <ul className="tested-evidence" aria-label="Completed tests that used this unit">
                {testing.evidence.map((evidence) => (
                  <li key={evidence.completionEventId}>
                    <strong>{evidence.programNumber}</strong> · {evidence.testCode} · completed{' '}
                    {when(evidence.completedAt)} by{' '}
                    {evidence.completedBy.account.accountType === 'shared_lab'
                      ? `${evidence.completedBy.account.name} for ${formatPerson(evidence.completedBy.person.initials, evidence.completedBy.person.name)}`
                      : formatPerson(
                          evidence.completedBy.person.initials,
                          evidence.completedBy.person.name,
                        )}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        {testing.removal ? (
          <div>
            <dt>Removal</dt>
            <dd>
              <strong>{DISPOSED_AFTER_TESTING_LABEL}</strong> {when(testing.removal.removedAt)} by{' '}
              {formatPerson(testing.removal.removedBy.initials, testing.removal.removedBy.name)} ·
              basis {testing.removal.programNumber} {testing.removal.testCode} · last location{' '}
              {testing.removal.location.name} ({testing.removal.location.code})
            </dd>
          </div>
        ) : null}
      </dl>
      {testing.removal ? null : testing.blocker === null ? (
        canRemove ? (
          <RemovalForm unit={unit} testing={testing} onRemoved={onRemoved} onStale={onStale} />
        ) : (
          <p className="field-hint">
            Tested. Confirming the physical removal needs a personal account.
          </p>
        )
      ) : testing.blocker !== 'not_eligible_unit_type' ? (
        <p className="field-hint">{BLOCKER_TEXT[testing.blocker]}</p>
      ) : null}
    </BandedCard>
  );
}

function RemovalForm({
  unit,
  testing,
  onRemoved,
  onStale,
}: {
  unit: StorageUnitDetail;
  testing: StorageUnitTesting;
  onRemoved: (message: string) => void;
  onStale: () => void;
}) {
  const id = useId();
  const [testRequestId, setTestRequestId] = useState(testing.evidence[0]!.testRequestId);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // One key per confirmation the person makes: a retry after a lost answer reuses it.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const what = removalSubject(testing);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed) {
      setMessage(`Confirm that the whole ${what} has physically left the lab.`);
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await confirmTestedRemoval(unit.id, {
      testRequestId,
      confirmPhysicalRemoval: true,
      version: unit.version,
      idempotencyKey: key,
    });
    setBusy(false);
    if (result.kind === 'removed') {
      onRemoved(`${unit.readableId} recorded as ${DISPOSED_AFTER_TESTING_LABEL.toLowerCase()}.`);
      return;
    }
    if (result.kind === 'unreachable') {
      setMessage('Material Mule couldn’t be reached. Try again; it won’t be recorded twice.');
      return;
    }
    setMessage(result.message);
    setKey(crypto.randomUUID());
    if (result.code === 'version_conflict' || result.code === 'already_removed') onStale();
  }

  return (
    <form className="tested-removal-form" onSubmit={(event) => void submit(event)}>
      <p className="field-hint">
        Removal after testing ({testedRemovalReasonLabel(testing.reason!)}): no retention wait,
        hold, disposal approval or program closure applies. Review and acceptance aren’t changed.
      </p>
      {testing.evidence.length > 1 ? (
        <fieldset className="form-field">
          <legend>Completed test that used this {what}</legend>
          {testing.evidence.map((evidence) => (
            <label key={evidence.testRequestId} className="radio-option">
              <input
                type="radio"
                name={`${id}-evidence`}
                value={evidence.testRequestId}
                checked={testRequestId === evidence.testRequestId}
                onChange={() => setTestRequestId(evidence.testRequestId)}
              />{' '}
              {evidence.programNumber} · {evidence.testCode}
            </label>
          ))}
        </fieldset>
      ) : null}
      <label className="checkbox-option">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />{' '}
        The whole {what} {unit.readableId} has physically left the lab
      </label>
      {message ? (
        <p className="field-error" role="alert">
          {message}
        </p>
      ) : null}
      <div>
        <button type="submit" className="primary" disabled={busy}>
          Confirm removal after testing
        </button>
      </div>
    </form>
  );
}

function removalSubject(testing: StorageUnitTesting): string {
  return testing.reason === 'tested_shelby' ? 'Shelby tube and its contents' : 'bulk sample bucket';
}
