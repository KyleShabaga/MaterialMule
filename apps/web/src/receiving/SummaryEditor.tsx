import { HOLE_SUMMARY_TYPES, type HoleSummaryType } from '@materialmule/shared';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { fieldId, SUMMARY_TYPE_LABEL, type SummaryDraft } from './draft';
import { ChoiceGroup, LabeledField, NATIVE_SELECT_CLASS } from './LabeledField';

// SAMPLE#/DEPTH summary for one test hole in one storage unit (MM-T10). One summary per hole:
// ALL, a sample range, a depth range in ft or m (no default, never converted) or custom text.
// Laid out as one wrapping line, so it sits in a receiving row (STRATA-76) and in corrections.

const DEPTH_UNITS = [
  { value: 'ft', label: 'ft' },
  { value: 'm', label: 'm' },
] as const;

export function SummaryEditor({
  summary,
  path,
  errors,
  onChange,
  showNote = true,
  className,
}: {
  summary: SummaryDraft;
  /** Request path of this summary, e.g. `units.0.holeSummaries.1`. */
  path: string;
  errors: ReadonlyMap<string, string>;
  onChange: (changes: Partial<SummaryDraft>) => void;
  /** The per-hole note (receiving rows keep it; it is optional everywhere). */
  showNote?: boolean;
  className?: string;
}) {
  const at = (field: string) => `${path}.${field}`;
  const error = (field: string) => errors.get(at(field)) ?? null;
  const hole = summary.testHole.name;
  const mono = 'font-mono';

  return (
    <fieldset
      className={cn('m-0 flex min-w-0 flex-wrap items-start gap-3 border-0 p-0', className)}
    >
      <legend className="sr-only">{hole} summary</legend>
      <LabeledField
        id={fieldId(at('type'))}
        label="Summary type"
        error={error('type')}
        className="w-40"
      >
        {(props) => (
          <select
            {...props}
            data-slot="native-select"
            className={NATIVE_SELECT_CLASS}
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
      </LabeledField>

      {summary.type === 'sample_range' ? (
        <>
          <LabeledField
            id={fieldId(at('sampleFrom'))}
            label="Sample from"
            error={error('sampleFrom')}
            className="w-28"
          >
            {(props) => (
              <Input
                {...props}
                className={mono}
                maxLength={20}
                placeholder="G1"
                value={summary.sampleFrom}
                onChange={(e) => onChange({ sampleFrom: e.target.value })}
              />
            )}
          </LabeledField>
          <LabeledField
            id={fieldId(at('sampleTo'))}
            label="Sample to"
            error={error('sampleTo')}
            className="w-28"
          >
            {(props) => (
              <Input
                {...props}
                className={mono}
                maxLength={20}
                placeholder="S12"
                value={summary.sampleTo}
                onChange={(e) => onChange({ sampleTo: e.target.value })}
              />
            )}
          </LabeledField>
        </>
      ) : null}

      {summary.type === 'depth_range' ? (
        <>
          <LabeledField
            id={fieldId(at('depthFrom'))}
            label="Depth from"
            error={error('depthFrom')}
            className="w-28"
          >
            {(props) => (
              <Input
                {...props}
                className={mono}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={summary.depthFrom}
                onChange={(e) => onChange({ depthFrom: e.target.value })}
              />
            )}
          </LabeledField>
          <LabeledField
            id={fieldId(at('depthTo'))}
            label="Depth to"
            error={error('depthTo')}
            className="w-28"
          >
            {(props) => (
              <Input
                {...props}
                className={mono}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={summary.depthTo}
                onChange={(e) => onChange({ depthTo: e.target.value })}
              />
            )}
          </LabeledField>
          <ChoiceGroup
            id={fieldId(at('depthUnit'))}
            label="Depth unit"
            required
            options={DEPTH_UNITS}
            value={summary.depthUnit}
            onChange={(depthUnit) => onChange({ depthUnit })}
            error={error('depthUnit')}
          />
        </>
      ) : null}

      {summary.type === 'custom' ? (
        <LabeledField
          id={fieldId(at('customText'))}
          label="Custom summary"
          hint="State units if you describe depths."
          error={error('customText')}
          className="min-w-56 flex-1"
        >
          {(props) => (
            <Textarea
              {...props}
              rows={1}
              maxLength={500}
              className="min-h-11"
              value={summary.customText}
              onChange={(e) => onChange({ customText: e.target.value })}
            />
          )}
        </LabeledField>
      ) : null}

      {showNote ? (
        <LabeledField
          id={fieldId(at('note'))}
          label="Summary note (optional)"
          error={error('note')}
          className="min-w-44 flex-1"
        >
          {(props) => (
            <Input
              {...props}
              maxLength={500}
              value={summary.note}
              onChange={(e) => onChange({ note: e.target.value })}
            />
          )}
        </LabeledField>
      ) : null}
    </fieldset>
  );
}
