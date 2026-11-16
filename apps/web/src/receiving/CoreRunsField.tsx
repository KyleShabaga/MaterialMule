import { CORE_RUN_COUNTS, formatCoreRuns, type CoreRunCount } from '@materialmule/shared';
import { ChoiceGroup } from './LabeledField';

const RUN_OPTIONS = CORE_RUN_COUNTS.map((runs) => ({
  value: String(runs) as `${CoreRunCount}`,
  label: formatCoreRuns(runs),
}));

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
    <ChoiceGroup
      id={id}
      label="Core runs"
      required
      options={RUN_OPTIONS}
      value={value === null ? '' : (String(value) as `${CoreRunCount}`)}
      onChange={(runs) => onChange(Number(runs) as CoreRunCount)}
      error={error}
      hint="Each run is 1.52 m. A full box holds 3; usually only a hole’s last box holds fewer."
    />
  );
}
