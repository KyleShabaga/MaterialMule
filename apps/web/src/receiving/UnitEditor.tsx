import {
  BULK_GROUP_DESCRIPTION_MAX_LENGTH,
  bulkGroupOptionLabel,
  type BulkGroupSummary,
} from '@materialmule/shared';
import { BandedCard, FormField } from '../components/ui';
import {
  fieldId,
  formatSampleDraft,
  newBulkChoice,
  unitHeadline,
  unitName,
  withHoles,
  withUnitKind,
  type BulkChoice,
  type BulkIdentityDraft,
  type ReceiptDraft,
  type SampleDraft,
  type UnitDraft,
} from './draft';
import { SampleFields } from './SampleFields';
import { SummaryEditor } from './SummaryEditor';
import { TestHolePicker } from './TestHolePicker';

/** The project's existing bulk samples, loaded once per project by the wizard (MM-T36). */
export type BulkGroupsState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; retry: () => void }
  | { state: 'ready'; groups: BulkGroupSummary[] };

/**
 * One storage unit row (MM-T10, MM-T36): its physical holder (Bucket or Shelby tube), then what
 * it holds. An ordinary bucket lists its test holes with one summary each; a bucket marked Bulk
 * soil sample holds one bulk sample (new, or an existing one of the project) and nothing else; a
 * Shelby tube has its own sampling source. Never asks for individual samples.
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
  onChange,
  onDuplicate,
  onRemove,
}: {
  unit: UnitDraft;
  index: number;
  /** The whole receipt, for "same bulk sample as Bucket 1" choices and the band. */
  draft?: Pick<ReceiptDraft, 'units'>;
  projectId: string | null;
  /** Named in the message after a test hole is added here. */
  projectNumber?: string | null;
  receiverUserId: string | null;
  online: boolean;
  errors: ReadonlyMap<string, string>;
  bulkGroups?: BulkGroupsState;
  onChange: (recipe: (unit: UnitDraft) => UnitDraft) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const path = `units.${index}`;
  const name = unitName(index, unit);
  const headingId = `unit-${unit.clientRowId}-heading`;
  const holesError = errors.get(`${path}.holeSummaries`);
  const receipt = draft ?? { units: [unit] };
  const kind = unit.unitType === 'shelby_tube' ? 'shelby_tube' : unit.bulk ? 'bulk' : 'bucket';
  const sampleProps = { projectId, projectNumber, receiverUserId, online, errors };

  return (
    <BandedCard
      id={`unit-${unit.clientRowId}`}
      className="unit-card"
      headingLevel={3}
      headingId={headingId}
      focusableHeading
      title={name}
      // The heading already names the unit ("Bucket 1"); the band adds what it holds.
      subtitle={
        <span className="unit-headline">
          {unitHeadline(index, unit, receipt).split(' · ').slice(1).join(' · ')}
        </span>
      }
      aside={
        <div className="row-actions">
          <button type="button" onClick={onDuplicate} aria-label={`Duplicate ${name}`}>
            Duplicate
          </button>
          <button type="button" onClick={onRemove} aria-label={`Remove ${name}`}>
            Remove
          </button>
        </div>
      }
    >
      <div className="unit-body">
        <div className="unit-kind">
          <FormField id={fieldId(`${path}.unitType`)} label="Physical holder">
            {(props) => (
              <select
                {...props}
                value={unit.unitType}
                onChange={(e) =>
                  onChange((current) =>
                    withUnitKind(
                      current,
                      e.target.value === 'shelby_tube' ? 'shelby_tube' : 'bucket',
                    ),
                  )
                }
              >
                <option value="bucket">Bucket</option>
                <option value="shelby_tube">Shelby tube</option>
              </select>
            )}
          </FormField>
          {unit.unitType === 'bucket' ? (
            <div className="form-field checkbox-field">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={unit.bulk}
                  aria-describedby={`${fieldId(`${path}.bulk`)}-hint`}
                  onChange={(e) =>
                    onChange((current) =>
                      withUnitKind(current, e.target.checked ? 'bulk' : 'bucket'),
                    )
                  }
                />
                Bulk soil sample
              </label>
              <p id={`${fieldId(`${path}.bulk`)}-hint`} className="field-hint">
                A bulk sample commonly fills one or two buckets. Each bucket gets its own BKT ID.
              </p>
            </div>
          ) : null}
        </div>

        {kind === 'bucket' ? (
          <>
            <div id={fieldId(`${path}.holeSummaries`)}>
              {projectId ? (
                <TestHolePicker
                  key={projectId}
                  projectId={projectId}
                  selected={unit.summaries.map((summary) => summary.testHole)}
                  onChange={(holes) => onChange((current) => withHoles(current, holes))}
                  query={unit.holeQuery}
                  onQueryChange={(holeQuery) => onChange((current) => ({ ...current, holeQuery }))}
                  receiverUserId={receiverUserId}
                  online={online}
                  // Holes are shared project data, kept even if the draft is discarded (decided
                  // 2026-10-27, MM-T61).
                  addedNote={(holeName) =>
                    `Added test hole ${holeName}${projectNumber ? ` to ${projectNumber}` : ''}. It stays on the project even if you discard this draft.`
                  }
                />
              ) : (
                <p className="field-hint">Choose the project first, then this unit’s test holes.</p>
              )}
              {holesError ? <p className="field-error">{holesError}</p> : null}
            </div>

            {unit.summaries.map((summary, summaryIndex) => (
              <SummaryEditor
                key={summary.testHole.id}
                summary={summary}
                path={`${path}.holeSummaries.${summaryIndex}`}
                errors={errors}
                onChange={(changes) =>
                  onChange((current) => ({
                    ...current,
                    summaries: current.summaries.map((s) =>
                      s.testHole.id === summary.testHole.id ? { ...s, ...changes } : s,
                    ),
                  }))
                }
              />
            ))}
          </>
        ) : null}

        {kind === 'bulk' ? (
          <BulkSampleChoice
            unit={unit}
            index={index}
            draft={receipt}
            path={`${path}.bulkGroup`}
            bulkGroups={projectId ? bulkGroups : { state: 'idle' }}
            onChange={(recipe) =>
              onChange((current) => ({ ...current, bulkChoice: recipe(current.bulkChoice) }))
            }
            {...sampleProps}
          />
        ) : null}

        {kind === 'shelby_tube' ? (
          <fieldset className="hole-summary">
            <legend>{name} sample</legend>
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
        ) : null}

        <FormField
          id={fieldId(`${path}.note`)}
          label={`${name} note (optional)`}
          error={errors.get(`${path}.note`)}
        >
          {(props) => (
            <input
              {...props}
              type="text"
              maxLength={2000}
              value={unit.note}
              onChange={(e) => onChange((current) => ({ ...current, note: e.target.value }))}
            />
          )}
        </FormField>
      </div>
    </BandedCard>
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
 * The bulk sample a bulk soil bucket holds. Existing samples are offered by source, sample
 * reference and depth (B1 alone could be any hole's B1), with how many buckets they have so far.
 * Joining one takes its identity as it is: nothing about it is typed again.
 */
function BulkSampleChoice({
  unit,
  index,
  draft,
  path,
  bulkGroups,
  onChange,
  errors,
  ...sampleProps
}: {
  unit: UnitDraft;
  index: number;
  draft: Pick<ReceiptDraft, 'units'>;
  path: string;
  bulkGroups: BulkGroupsState;
  /** Functional, so quick successive edits (pick a hole, clear its search) all apply. */
  onChange: (recipe: (choice: BulkChoice) => BulkChoice) => void;
  errors: ReadonlyMap<string, string>;
  projectId: string | null;
  projectNumber: string | null;
  receiverUserId: string | null;
  online: boolean;
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
    <fieldset className="hole-summary bulk-sample">
      <legend>{unitName(index, unit)} bulk sample</legend>
      <FormField
        id={fieldId(path)}
        label="Bulk sample"
        hint="Choose an existing bulk sample of this project to add another bucket to it."
        error={errors.get(path)}
      >
        {(props) => (
          <select {...props} value={known ? value : ''} onChange={(e) => choose(e.target.value)}>
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
              <optgroup label="Existing bulk samples">
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
      </FormField>
      {bulkGroups.state === 'loading' ? (
        <p className="field-hint" role="status">
          Loading this project’s bulk samples…
        </p>
      ) : null}
      {bulkGroups.state === 'error' ? (
        <div className="error-state" role="alert">
          <p>This project’s bulk samples couldn’t load.</p>
          <button type="button" onClick={bulkGroups.retry}>
            Retry
          </button>
        </div>
      ) : null}

      {choice.kind === 'new' ? (
        <SampleFields
          sample={choice.identity}
          path={`${path}.new`}
          required
          referencePlaceholder="B1"
          errors={errors}
          onChange={(changes) => onChange((current) => withIdentity(current, changes))}
          {...sampleProps}
        >
          <FormField
            id={fieldId(`${path}.new.description`)}
            label="Bulk sample description (optional)"
            error={errors.get(`${path}.new.description`)}
          >
            {(props) => (
              <input
                {...props}
                type="text"
                maxLength={BULK_GROUP_DESCRIPTION_MAX_LENGTH}
                value={choice.identity.description}
                onChange={(e) =>
                  onChange((current) => withIdentity(current, { description: e.target.value }))
                }
              />
            )}
          </FormField>
        </SampleFields>
      ) : null}
    </fieldset>
  );
}
