import {
  BULK_GROUP_DESCRIPTION_MAX_LENGTH,
  bulkGroupOptionLabel,
  type BulkGroupSummary,
} from '@materialmule/shared';
import { CornerDownRight, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  fieldId,
  formatSampleDraft,
  newBulkChoice,
  UNIT_KIND_LABEL,
  UNIT_KINDS,
  unitKindOf,
  unitName,
  withHoles,
  withUnitKind,
  type BulkChoice,
  type BulkIdentityDraft,
  type ReceiptDraft,
  type SampleDraft,
  type UnitDraft,
  type UnitKind,
} from './draft';
import { CoreRunsField } from './CoreRunsField';
import { FieldErrorText, LabeledField, NATIVE_SELECT_CLASS } from './LabeledField';
import { SampleFields } from './SampleFields';
import { SummaryEditor } from './SummaryEditor';
import { TestHolePicker } from './TestHolePicker';

/** The project's existing bulk samples, loaded once per project by the page (MM-T36). */
export type BulkGroupsState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; retry: () => void }
  | { state: 'ready'; groups: BulkGroupSummary[] };

/**
 * What one storage unit row holds (STRATA-76; MM-T10, MM-T36): the holder (Bucket, Bulk bucket,
 * Shelby tube, Core box), then its contents. An ordinary bucket lists its test holes with one
 * SAMPLE#/DEPTH summary each, the second and later ones as "Also holds" lines; a bulk bucket
 * holds one bulk sample (new, the same as an earlier row, or an existing one of the project); a
 * Shelby tube has its own sampling source; a core box belongs to one test hole and holds 1–3
 * runs. Never asks for individual samples.
 */
export function UnitEditor({
  unit,
  index,
  draft,
  projectId,
  projectNumber = null,
  receiverUserId,
  online,
  errors,
  bulkGroups = { state: 'idle' },
  holeReloadKey = 0,
  onHolesLoadError,
  onChange,
}: {
  unit: UnitDraft;
  index: number;
  /** The whole receipt, for "same bulk sample as Bucket 1" choices. */
  draft?: Pick<ReceiptDraft, 'units'>;
  projectId: string | null;
  /** Named in the message after a test hole is added here. */
  projectNumber?: string | null;
  receiverUserId: string | null;
  online: boolean;
  errors: ReadonlyMap<string, string>;
  bulkGroups?: BulkGroupsState;
  /** Changing it reloads the project's test holes (the page's Try again). */
  holeReloadKey?: number;
  onHolesLoadError?: (failed: boolean) => void;
  onChange: (recipe: (unit: UnitDraft) => UnitDraft) => void;
}) {
  const path = `units.${index}`;
  const name = unitName(index, unit);
  const holesError = errors.get(`${path}.holeSummaries`);
  const receipt = draft ?? { units: [unit] };
  const kind = unitKindOf(unit);
  const coreBox = kind === 'core_box';
  const sampleProps = {
    projectId,
    projectNumber,
    receiverUserId,
    online,
    errors,
    holeReloadKey,
    onHolesLoadError,
  };
  const holderId = fieldId(`${path}.unitType`);

  const holder = (
    <div className="flex w-44 shrink-0 flex-col gap-1.5">
      <span className="text-[13px] leading-none font-semibold" aria-hidden="true">
        Holder
      </span>
      <Select
        value={kind}
        onValueChange={(next) => onChange((current) => withUnitKind(current, next as UnitKind))}
      >
        <SelectTrigger id={holderId} aria-label={`${name} holder`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {UNIT_KINDS.map((option) => (
            <SelectItem key={option} value={option}>
              {UNIT_KIND_LABEL[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const note = (
    <LabeledField
      id={fieldId(`${path}.note`)}
      label="Note (optional)"
      error={errors.get(`${path}.note`)}
      className="min-w-48 flex-1 basis-48"
    >
      {(props) => (
        <Input
          {...props}
          aria-label={`${name} note (optional)`}
          maxLength={2000}
          placeholder="Description (optional)"
          value={unit.note}
          onChange={(e) => onChange((current) => ({ ...current, note: e.target.value }))}
        />
      )}
    </LabeledField>
  );

  if (kind === 'bucket' || coreBox) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          {holder}
          <div
            id={fieldId(`${path}.holeSummaries`)}
            className="flex w-60 min-w-0 shrink-0 flex-col gap-1.5"
          >
            {projectId ? (
              <TestHolePicker
                key={`${projectId}:${holeReloadKey}`}
                projectId={projectId}
                legend={coreBox ? 'Test hole' : 'Test holes'}
                selected={unit.summaries.map((summary) => summary.testHole)}
                // A core box belongs to one test hole: choosing another replaces it.
                onChange={(holes) =>
                  onChange((current) => withHoles(current, coreBox ? holes.slice(-1) : holes))
                }
                query={unit.holeQuery}
                onQueryChange={(holeQuery) => onChange((current) => ({ ...current, holeQuery }))}
                receiverUserId={receiverUserId}
                online={online}
                required
                invalid={Boolean(holesError)}
                onLoadError={onHolesLoadError}
                // Holes are shared project data, kept even if the draft is discarded (decided
                // 2026-10-27, MM-T61).
                addedNote={(holeName) =>
                  `Added test hole ${holeName}${projectNumber ? ` to ${projectNumber}` : ''}. It stays on the project even if you discard this draft.`
                }
              />
            ) : (
              <>
                <span className="text-[13px] leading-none font-semibold">Test hole</span>
                <p className="text-muted-foreground m-0 text-[13px]">
                  Choose the project first, then this unit’s test holes.
                </p>
              </>
            )}
            {holesError ? <FieldErrorText>{holesError}</FieldErrorText> : null}
          </div>
          {coreBox ? (
            <CoreRunsField
              id={fieldId(`${path}.coreRunCount`)}
              value={unit.coreRunCount}
              error={errors.get(`${path}.coreRunCount`)}
              onChange={(coreRunCount) => onChange((current) => ({ ...current, coreRunCount }))}
            />
          ) : null}
          {note}
        </div>

        {unit.summaries.length > 0 ? (
          <ul
            className="m-0 flex list-none flex-col gap-3 p-0"
            aria-label={`${name} samples and depth`}
          >
            {unit.summaries.map((summary, summaryIndex) => (
              <li
                key={summary.testHole.id}
                className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2"
              >
                <span className="text-muted-foreground flex h-11 w-44 shrink-0 items-center gap-1.5 self-end text-[13px]">
                  {summaryIndex > 0 ? (
                    <>
                      <CornerDownRight aria-hidden="true" className="size-3.5" />
                      Also holds
                    </>
                  ) : (
                    'Samples and depth'
                  )}
                  <span className="text-foreground font-mono font-semibold">
                    {summary.testHole.name}
                  </span>
                </span>
                <SummaryEditor
                  summary={summary}
                  path={`${path}.holeSummaries.${summaryIndex}`}
                  errors={errors}
                  className="flex-1"
                  onChange={(changes) =>
                    onChange((current) => ({
                      ...current,
                      summaries: current.summaries.map((s) =>
                        s.testHole.id === summary.testHole.id ? { ...s, ...changes } : s,
                      ),
                    }))
                  }
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (kind === 'bulk') {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          {holder}
          <BulkSampleChoice
            unit={unit}
            index={index}
            draft={receipt}
            path={`${path}.bulkGroup`}
            bulkGroups={projectId ? bulkGroups : { state: 'idle' }}
            errors={errors}
            onChange={(recipe) =>
              onChange((current) => ({ ...current, bulkChoice: recipe(current.bulkChoice) }))
            }
          />
          {note}
        </div>
        {unit.bulkChoice.kind === 'new' ? (
          <SampleFields
            sample={unit.bulkChoice.identity}
            path={`${path}.bulkGroup.new`}
            required
            referencePlaceholder="B1"
            onChange={(changes) =>
              onChange((current) => ({
                ...current,
                bulkChoice: withIdentity(current.bulkChoice, changes),
              }))
            }
            {...sampleProps}
          >
            <LabeledField
              id={fieldId(`${path}.bulkGroup.new.description`)}
              label="Bulk sample description (optional)"
              error={errors.get(`${path}.bulkGroup.new.description`)}
              className="max-w-xl"
            >
              {(props) => (
                <Input
                  {...props}
                  maxLength={BULK_GROUP_DESCRIPTION_MAX_LENGTH}
                  value={unit.bulkChoice.kind === 'new' ? unit.bulkChoice.identity.description : ''}
                  onChange={(e) =>
                    onChange((current) => ({
                      ...current,
                      bulkChoice: withIdentity(current.bulkChoice, {
                        description: e.target.value,
                      }),
                    }))
                  }
                />
              )}
            </LabeledField>
          </SampleFields>
        ) : null}
        <p className="text-muted-foreground m-0 text-[13px]">
          A bulk sample commonly fills one or two buckets. Each bucket gets its own BKT- ID.
        </p>
      </div>
    );
  }

  // Shelby tube: its own sampling source, sample reference and depth.
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        {holder}
        {note}
      </div>
      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="sr-only">{name} sample</legend>
        <SampleFields
          sample={unit.tube}
          path={`${path}.sample`}
          required={false}
          referencePlaceholder="e.g. T5"
          onChange={(changes: Partial<SampleDraft>) =>
            onChange((current) => ({ ...current, tube: { ...current.tube, ...changes } }))
          }
          {...sampleProps}
        />
      </fieldset>
    </div>
  );
}

const NEW = 'new';

/** Applies edits to a new bulk sample; other choices are left as they are. */
function withIdentity(choice: BulkChoice, changes: Partial<BulkIdentityDraft>): BulkChoice {
  return choice.kind === 'new'
    ? { kind: 'new', identity: { ...choice.identity, ...changes } }
    : choice;
}

/**
 * The bulk sample a bulk bucket holds. Existing samples are offered by source, sample reference
 * and depth (B1 alone could be any hole's B1), with how many buckets they have so far. Joining
 * one takes its identity as it is: nothing about it is typed again.
 */
function BulkSampleChoice({
  unit,
  index,
  draft,
  path,
  bulkGroups,
  onChange,
  errors,
}: {
  unit: UnitDraft;
  index: number;
  draft: Pick<ReceiptDraft, 'units'>;
  path: string;
  bulkGroups: BulkGroupsState;
  /** Functional, so quick successive edits (pick a hole, clear its search) all apply. */
  onChange: (recipe: (choice: BulkChoice) => BulkChoice) => void;
  errors: ReadonlyMap<string, string>;
}) {
  const choice = unit.bulkChoice;
  // Earlier rows of this receipt that describe a new bulk sample.
  const earlier = draft.units
    .slice(0, index)
    .map((other, otherIndex) => ({ other, otherIndex }))
    .filter(
      ({ other }) => other.unitType === 'bucket' && other.bulk && other.bulkChoice.kind === 'new',
    );
  const groups = bulkGroups.state === 'ready' ? bulkGroups.groups : [];
  const value =
    choice.kind === 'new'
      ? NEW
      : choice.kind === 'same_as'
        ? `same:${choice.clientRowId}`
        : `existing:${choice.group.id}`;
  const known =
    value === NEW ||
    earlier.some(({ other }) => value === `same:${other.clientRowId}`) ||
    (choice.kind === 'existing' && groups.length === 0) ||
    // A sample corrected since it was chosen must be chosen again (the request names the
    // version the receiver saw).
    (choice.kind === 'existing' &&
      groups.some(
        (group) => group.id === choice.group.id && group.version === choice.group.version,
      ));

  function choose(next: string) {
    if (next === NEW) {
      onChange(() => newBulkChoice());
    } else if (next.startsWith('same:')) {
      onChange(() => ({ kind: 'same_as', clientRowId: next.slice('same:'.length) }));
    } else if (next.startsWith('existing:')) {
      const group = groups.find((g) => `existing:${g.id}` === next);
      if (group) onChange(() => ({ kind: 'existing', group }));
    }
  }

  return (
    <div className="flex w-72 min-w-0 flex-col gap-1.5">
      <LabeledField
        id={fieldId(path)}
        label="Bulk sample"
        hint="Choose an existing bulk sample of this project to add another bucket to it."
        error={errors.get(path)}
      >
        {(props) => (
          <select
            {...props}
            data-slot="native-select"
            className={NATIVE_SELECT_CLASS}
            value={known ? value : ''}
            onChange={(e) => choose(e.target.value)}
          >
            {known ? null : <option value="">Choose…</option>}
            <option value={NEW}>New bulk sample</option>
            {earlier.length > 0 ? (
              <optgroup label="New in this receipt">
                {earlier.map(({ other, otherIndex }) => (
                  <option key={other.clientRowId} value={`same:${other.clientRowId}`}>
                    {`Same as ${unitName(otherIndex, other)}: ${formatSampleDraft(
                      (other.bulkChoice as { identity: BulkIdentityDraft }).identity,
                    )}`}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {groups.length > 0 ? (
              <optgroup label="Already received for this project">
                {groups.map((group) => (
                  <option key={group.id} value={`existing:${group.id}`}>
                    {bulkGroupOptionLabel(group)}
                  </option>
                ))}
              </optgroup>
            ) : choice.kind === 'existing' ? (
              // Shown from the draft while the list loads (or if it can't).
              <option value={value}>{bulkGroupOptionLabel(choice.group)}</option>
            ) : null}
          </select>
        )}
      </LabeledField>
      {bulkGroups.state === 'loading' ? (
        <p className="text-muted-foreground m-0 text-[13px]" role="status">
          Loading this project’s bulk samples…
        </p>
      ) : null}
      {bulkGroups.state === 'error' ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <FieldErrorText>This project’s bulk samples couldn’t load.</FieldErrorText>
          <Button type="button" variant="outline" size="sm" onClick={bulkGroups.retry}>
            <RotateCw aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}
