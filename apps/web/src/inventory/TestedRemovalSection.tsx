import {
  DISPOSED_AFTER_TESTING_LABEL,
  TESTED_CONTENTS_LABEL,
  formatPerson,
  testedRemovalReasonLabel,
  type StorageUnitDetail,
  type StorageUnitTesting,
  type TestedRemovalBlocker,
} from '@materialmule/shared';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { confirmTestedRemoval } from './api';
import { formatEventTime } from './unit-record';
import { UnitFact, UnitFacts, UnitSection } from './UnitRecordParts';

function when(iso: string) {
  return (
    <time dateTime={iso} className="font-mono whitespace-nowrap">
      {formatEventTime(iso)}
    </time>
  );
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
    <UnitSection id="testing" title="Testing and removal">
      <UnitFacts>
        {isTube ? (
          <UnitFact term="Contents">
            {testing.contentsDestroyed ? (
              <>
                <strong>{TESTED_CONTENTS_LABEL}</strong>
                {testing.removal ? null : (
                  <span className="text-muted-foreground">
                    {' '}
                    Can’t be tested again. The tube stays tracked here until its removal is
                    confirmed.
                  </span>
                )}
              </>
            ) : (
              'Available for testing'
            )}
          </UnitFact>
        ) : null}
        <UnitFact term="Tested in">
          {testing.evidence.length === 0 ? (
            'No completed test has recorded this unit.'
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Completed tests that used this unit">
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
                  {evidence.sameSourceConfirmation ? (
                    <span className="text-muted-foreground">
                      {' '}
                      · outside the line’s coverage, same source confirmed by{' '}
                      {formatPerson(
                        evidence.sameSourceConfirmation.person.initials,
                        evidence.sameSourceConfirmation.person.name,
                      )}{' '}
                      {when(evidence.sameSourceConfirmation.confirmedAt)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </UnitFact>
        {testing.removal ? (
          <UnitFact term="Removal">
            <strong>{DISPOSED_AFTER_TESTING_LABEL}</strong> {when(testing.removal.removedAt)} by{' '}
            {formatPerson(testing.removal.removedBy.initials, testing.removal.removedBy.name)} ·
            basis {testing.removal.programNumber} {testing.removal.testCode} · last location{' '}
            {testing.removal.location.name} ({testing.removal.location.code})
          </UnitFact>
        ) : null}
      </UnitFacts>
      {testing.removal ? null : testing.blocker === null ? (
        canRemove ? (
          <RemovalForm unit={unit} testing={testing} onRemoved={onRemoved} onStale={onStale} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Tested. Confirming the physical removal needs a personal account.
          </p>
        )
      ) : testing.blocker !== 'not_eligible_unit_type' ? (
        <p className="text-sm text-muted-foreground">{BLOCKER_TEXT[testing.blocker]}</p>
      ) : null}
    </UnitSection>
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
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <p className="text-[13px] text-muted-foreground">
        Removal after testing ({testedRemovalReasonLabel(testing.reason!)}): no retention wait,
        hold, disposal approval or program closure applies. Review and acceptance aren’t changed.
      </p>
      {testing.evidence.length > 1 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">
            Completed test that used this {what}
          </legend>
          <RadioGroup value={testRequestId} onValueChange={setTestRequestId}>
            {testing.evidence.map((evidence) => (
              <div key={evidence.testRequestId} className="flex items-center gap-2">
                <RadioGroupItem
                  id={`${id}-${evidence.testRequestId}`}
                  value={evidence.testRequestId}
                />
                <Label htmlFor={`${id}-${evidence.testRequestId}`} className="font-normal">
                  {evidence.programNumber} · {evidence.testCode}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
      ) : null}
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${id}-confirm`}
          checked={confirmed}
          onCheckedChange={(value) => setConfirmed(value === true)}
          className="mt-0.5"
        />
        <Label htmlFor={`${id}-confirm`} className="leading-snug font-normal">
          The whole {what} {unit.readableId} has physically left the lab
        </Label>
      </div>
      {message ? (
        <p className="text-sm text-destructive-text" role="alert">
          {message}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={busy}>
          Confirm removal after testing
        </Button>
      </div>
    </form>
  );
}

function removalSubject(testing: StorageUnitTesting): string {
  return testing.reason === 'tested_shelby' ? 'Shelby tube and its contents' : 'bulk sample bucket';
}
