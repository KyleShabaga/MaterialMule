import { HOLE_SUMMARY_TYPES, type HoleSummaryType } from '@materialmule/shared';
import { FormField } from '../components/ui';
import { fieldId, SUMMARY_TYPE_LABEL, type SummaryDraft } from './draft';

// SAMPLE#/DEPTH summary for one test hole in one storage unit (MM-T10). One summary per hole:
// ALL, a sample range, a depth range in ft or m (no default, never converted) or custom text.

export function SummaryEditor({
  summary,
  path,
  errors,
  onChange,
}: {
  summary: SummaryDraft;
  /** Request path of this summary, e.g. `units.0.holeSummaries.1`. */
  path: string;
  errors: ReadonlyMap<string, string>;
  onChange: (changes: Partial<SummaryDraft>) => void;
}) {
  const at = (field: string) => `${path}.${field}`;
  const error = (field: string) => errors.get(at(field)) ?? null;
  const hole = summary.testHole.name;
  const unitError = error('depthUnit');

  return (
    <fieldset className="hole-summary">
      <legend>{hole} summary</legend>
      <FormField id={fieldId(at('type'))} label="Summary type" error={error('type')}>
        {(props) => (
          <select
            {...props}
            value={summary.type}
            onChange={(e) => onChange({ type: e.target.value as HoleSummaryType | '' })}
          >
            <option value="">Choose…</option>
            {HOLE_SUMMARY_TYPES.map((type) => (
              <option key={type} value={type}>
                {SUMMARY_TYPE_LABEL[type]}
              </option>
            ))}
          </select>
        )}
      </FormField>

      {summary.type === 'sample_range' ? (
        <div className="range">
          <FormField id={fieldId(at('sampleFrom'))} label="Sample from" error={error('sampleFrom')}>
            {(props) => (
              <input
                {...props}
                type="text"
                maxLength={20}
                placeholder="e.g. G1"
                value={summary.sampleFrom}
                onChange={(e) => onChange({ sampleFrom: e.target.value })}
              />
            )}
          </FormField>
          <FormField id={fieldId(at('sampleTo'))} label="Sample to" error={error('sampleTo')}>
            {(props) => (
              <input
                {...props}
                type="text"
                maxLength={20}
                placeholder="e.g. S12"
                value={summary.sampleTo}
                onChange={(e) => onChange({ sampleTo: e.target.value })}
              />
            )}
          </FormField>
        </div>
      ) : null}

      {summary.type === 'depth_range' ? (
        <div className="range">
          <FormField id={fieldId(at('depthFrom'))} label="Depth from" error={error('depthFrom')}>
            {(props) => (
              <input
                {...props}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={summary.depthFrom}
                onChange={(e) => onChange({ depthFrom: e.target.value })}
              />
            )}
          </FormField>
          <FormField id={fieldId(at('depthTo'))} label="Depth to" error={error('depthTo')}>
            {(props) => (
              <input
                {...props}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={summary.depthTo}
                onChange={(e) => onChange({ depthTo: e.target.value })}
              />
            )}
          </FormField>
          <div className="form-field">
            <span id={`${fieldId(at('depthUnit'))}-label`} className="label">
              Depth unit
            </span>
            <div
              id={fieldId(at('depthUnit'))}
              role="radiogroup"
              className="depth-unit"
              aria-labelledby={`${fieldId(at('depthUnit'))}-label`}
              aria-required="true"
              aria-invalid={Boolean(unitError)}
              aria-describedby={unitError ? `${fieldId(at('depthUnit'))}-error` : undefined}
            >
              {(['ft', 'm'] as const).map((unit) => (
                <label key={unit} className="radio">
                  <input
                    type="radio"
                    name={fieldId(at('depthUnit'))}
                    value={unit}
                    checked={summary.depthUnit === unit}
                    onChange={() => onChange({ depthUnit: unit })}
                  />
                  {unit}
                </label>
              ))}
            </div>
            {unitError ? (
              <p id={`${fieldId(at('depthUnit'))}-error`} className="field-error">
                {unitError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {summary.type === 'custom' ? (
        <FormField
          id={fieldId(at('customText'))}
          label="Custom summary"
          hint="State units if you describe depths."
          error={error('customText')}
        >
          {(props) => (
            <textarea
              {...props}
              rows={2}
              maxLength={500}
              value={summary.customText}
              onChange={(e) => onChange({ customText: e.target.value })}
            />
          )}
        </FormField>
      ) : null}

      <FormField id={fieldId(at('note'))} label="Summary note (optional)" error={error('note')}>
        {(props) => (
          <input
            {...props}
            type="text"
            maxLength={500}
            value={summary.note}
            onChange={(e) => onChange({ note: e.target.value })}
          />
        )}
      </FormField>
    </fieldset>
  );
}
