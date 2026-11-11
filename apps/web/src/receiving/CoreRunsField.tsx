import { CORE_RUN_COUNTS, formatCoreRuns, type CoreRunCount } from '@materialmule/shared';

/**
 * A core box's runs (Kyle, 2026-11-10): 3 runs · 4.56 m is the usual full box and comes first;
 * usually only a test hole's last box holds 2 or 1. Each run is 1.52 m.
 */
export function CoreRunsField({
  id,
  value,
  onChange,
  error,
}: {
  id: string;
  value: CoreRunCount | null;
  onChange: (runs: CoreRunCount) => void;
  error?: string | null;
}) {
  return (
    <div className="form-field">
      <span id={`${id}-label`} className="label">
        Core runs
      </span>
      <div
        id={id}
        role="radiogroup"
        className="depth-unit"
        aria-labelledby={`${id}-label`}
        aria-required="true"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
      >
        {CORE_RUN_COUNTS.map((runs) => (
          <label key={runs} className="radio">
            <input
              type="radio"
              name={id}
              value={runs}
              checked={value === runs}
              onChange={() => onChange(runs)}
            />
            {formatCoreRuns(runs)}
          </label>
        ))}
      </div>
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className="field-hint">
          Each run is 1.52 m. A full box holds 3; usually only a hole’s last box holds fewer.
        </p>
      )}
    </div>
  );
}
