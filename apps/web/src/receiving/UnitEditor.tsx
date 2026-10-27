import { BandedCard, FormField } from '../components/ui';
import { fieldId, unitHeadline, unitName, withHoles, type UnitDraft } from './draft';
import { SummaryEditor } from './SummaryEditor';
import { TestHolePicker } from './TestHolePicker';

/**
 * One storage unit row (MM-T10): its type, the test holes it holds with one summary each, and
 * an optional note. Never asks for individual samples.
 */
export function UnitEditor({
  unit,
  index,
  projectId,
  projectNumber = null,
  receiverUserId,
  online,
  errors,
  onChange,
  onDuplicate,
  onRemove,
}: {
  unit: UnitDraft;
  index: number;
  projectId: string | null;
  /** Named in the message after a test hole is added here. */
  projectNumber?: string | null;
  receiverUserId: string | null;
  online: boolean;
  errors: ReadonlyMap<string, string>;
  onChange: (recipe: (unit: UnitDraft) => UnitDraft) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const path = `units.${index}`;
  const name = unitName(index, unit);
  const headingId = `unit-${unit.clientRowId}-heading`;
  const holesError = errors.get(`${path}.holeSummaries`);

  return (
    <BandedCard
      id={`unit-${unit.clientRowId}`}
      className="unit-card"
      headingLevel={3}
      headingId={headingId}
      focusableHeading
      title={name}
      // The heading already names the unit ("Bucket 1"); the band adds its test-hole summaries.
      subtitle={
        <span className="unit-headline">
          {unitHeadline(index, unit).split(' · ').slice(1).join(' · ')}
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
              addedNote={(name) =>
                `Added test hole ${name}${projectNumber ? ` to ${projectNumber}` : ''}. It stays on the project even if you discard this draft.`
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
