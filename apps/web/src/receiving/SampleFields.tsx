import {
  SAMPLE_REFERENCE_MAX_LENGTH,
  SAMPLING_SOURCE_TYPE_LABEL,
  SAMPLING_SOURCE_TYPES,
  SOURCE_LOCATION_REFERENCE_MAX_LENGTH,
} from '@materialmule/shared';
import type { ReactNode } from 'react';
import { FormField } from '../components/ui';
import { fieldId, type SampleDraft } from './draft';
import { TestHolePicker } from './TestHolePicker';

// Sampling source, sample reference and depth (MM-T36): a Shelby tube's own, or a new bulk
// sample's. "Sampling source" is where the material came from (a test hole of this project, or
// a standalone sampling location typed on this row); it is never the unit's storage location.
// There is no list of standalone locations: each row keeps the text typed for it.

export function SampleFields({
  sample,
  path,
  errors,
  onChange,
  projectId,
  projectNumber,
  receiverUserId,
  online,
  required,
  referencePlaceholder,
  children,
}: {
  sample: SampleDraft;
  /** Request path these fields report under, e.g. `units.0.sample`. */
  path: string;
  errors: ReadonlyMap<string, string>;
  onChange: (changes: Partial<SampleDraft>) => void;
  projectId: string | null;
  projectNumber: string | null;
  receiverUserId: string | null;
  online: boolean;
  /** Bulk samples need a sample reference and a depth; a tube records them where supplied. */
  required: boolean;
  referencePlaceholder: string;
  /** Extra fields after the depth (a bulk sample's description). */
  children?: ReactNode;
}) {
  const at = (field: string) => `${path}.${field}`;
  const error = (field: string) => errors.get(at(field)) ?? null;
  const optional = required ? '' : ' (optional)';
  const sourceId = fieldId(at('sourceType'));
  const sourceError = error('sourceType');
  const unitId = fieldId(at('depthUnit'));
  const unitError = error('depthUnit');

  return (
    <div className="sample-fields">
      <div className="form-field">
        <span id={`${sourceId}-label`} className="label">
          Sampling source
        </span>
        <div
          id={sourceId}
          role="radiogroup"
          className="source-type"
          aria-labelledby={`${sourceId}-label`}
          aria-required="true"
          aria-invalid={Boolean(sourceError)}
          aria-describedby={sourceError ? `${sourceId}-error` : undefined}
        >
          {SAMPLING_SOURCE_TYPES.map((type) => (
            <label key={type} className="radio">
              <input
                type="radio"
                name={sourceId}
                value={type}
                checked={sample.sourceType === type}
                // Switching source type drops the other kind's value, so none is kept hidden.
                onChange={() =>
                  onChange({
                    sourceType: type,
                    testHole: null,
                    holeQuery: '',
                    locationReference: '',
                  })
                }
              />
              {SAMPLING_SOURCE_TYPE_LABEL[type]}
            </label>
          ))}
        </div>
        {sourceError ? (
          <p id={`${sourceId}-error`} className="field-error">
            {sourceError}
          </p>
        ) : null}
      </div>

      {sample.sourceType === 'test_hole' ? (
        <div id={fieldId(at('testHoleId'))}>
          {projectId ? (
            <TestHolePicker
              key={projectId}
              single
              legend="Test hole"
              projectId={projectId}
              selected={sample.testHole ? [sample.testHole] : []}
              onChange={(holes) => onChange({ testHole: holes.at(-1) ?? null })}
              query={sample.holeQuery}
              onQueryChange={(holeQuery) => onChange({ holeQuery })}
              receiverUserId={receiverUserId}
              online={online}
              addedNote={(name) =>
                `Added test hole ${name}${projectNumber ? ` to ${projectNumber}` : ''}. It stays on the project even if you discard this draft.`
              }
            />
          ) : (
            <p className="field-hint">Choose the project first, then the test hole.</p>
          )}
          {error('testHoleId') ? <p className="field-error">{error('testHoleId')}</p> : null}
        </div>
      ) : null}

      {sample.sourceType === 'standalone_location' ? (
        <FormField
          id={fieldId(at('sourceLocationReference'))}
          label="Location reference"
          hint="The standalone sampling location as written in the field (e.g. Embankment Location 03). Not where it is stored."
          error={error('sourceLocationReference')}
        >
          {(props) => (
            <input
              {...props}
              type="text"
              required
              maxLength={SOURCE_LOCATION_REFERENCE_MAX_LENGTH}
              value={sample.locationReference}
              onChange={(e) => onChange({ locationReference: e.target.value })}
            />
          )}
        </FormField>
      ) : null}

      <FormField
        id={fieldId(at('sampleReference'))}
        label={`Sample reference${optional}`}
        hint={required ? 'Usually starts with B, but any reference is fine.' : undefined}
        error={error('sampleReference')}
      >
        {(props) => (
          <input
            {...props}
            type="text"
            required={required}
            maxLength={SAMPLE_REFERENCE_MAX_LENGTH}
            placeholder={referencePlaceholder}
            value={sample.sampleReference}
            onChange={(e) => onChange({ sampleReference: e.target.value })}
          />
        )}
      </FormField>

      <div className="range">
        <FormField
          id={fieldId(at('depthFrom'))}
          label={`Depth${optional}`}
          hint="A single depth, or the top of an interval."
          error={error('depthFrom')}
        >
          {(props) => (
            <input
              {...props}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              required={required}
              value={sample.depthFrom}
              onChange={(e) => onChange({ depthFrom: e.target.value })}
            />
          )}
        </FormField>
        <FormField
          id={fieldId(at('depthTo'))}
          label="Depth to (optional)"
          hint="For an interval."
          error={error('depthTo')}
        >
          {(props) => (
            <input
              {...props}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={sample.depthTo}
              onChange={(e) => onChange({ depthTo: e.target.value })}
            />
          )}
        </FormField>
        <div className="form-field">
          <span id={`${unitId}-label`} className="label">
            Depth unit
          </span>
          <div
            id={unitId}
            role="radiogroup"
            className="depth-unit"
            aria-labelledby={`${unitId}-label`}
            aria-required={required || sample.depthFrom.trim() !== ''}
            aria-invalid={Boolean(unitError)}
            aria-describedby={unitError ? `${unitId}-error` : undefined}
          >
            {(['ft', 'm'] as const).map((unit) => (
              <label key={unit} className="radio">
                <input
                  type="radio"
                  name={unitId}
                  value={unit}
                  checked={sample.depthUnit === unit}
                  onChange={() => onChange({ depthUnit: unit })}
                />
                {unit}
              </label>
            ))}
          </div>
          {unitError ? (
            <p id={`${unitId}-error`} className="field-error">
              {unitError}
            </p>
          ) : null}
        </div>
      </div>
      {children}
    </div>
  );
}
