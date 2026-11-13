import {
  SAMPLE_REFERENCE_MAX_LENGTH,
  SAMPLING_SOURCE_TYPE_LABEL,
  SAMPLING_SOURCE_TYPES,
  SOURCE_LOCATION_REFERENCE_MAX_LENGTH,
} from '@materialmule/shared';
import { MapPin } from 'lucide-react';
import type { ReactNode } from 'react';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Input } from '@/components/ui/input';
import { fieldId, withSourceType, type SampleDraft } from './draft';
import { ChoiceGroup, FieldErrorText, LabeledField } from './LabeledField';
import { TestHolePicker } from './TestHolePicker';

// Sampling source, sample reference and depth (MM-T36): a Shelby tube's own, or a new bulk
// sample's. "Sampling source" is where the material came from (a test hole of this project, or
// a standalone sampling location typed on this row); it is never the unit's storage location.
// There is no list of standalone locations: each row keeps the text typed for it.

const SOURCE_OPTIONS = SAMPLING_SOURCE_TYPES.map((type) => ({
  value: type,
  label: SAMPLING_SOURCE_TYPE_LABEL[type],
}));

const DEPTH_UNITS = [
  { value: 'ft', label: 'ft' },
  { value: 'm', label: 'm' },
] as const;

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
  holeReloadKey = 0,
  onHolesLoadError,
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
  /** Changing it reloads the project's test holes (Receive samples' Try again). */
  holeReloadKey?: number;
  onHolesLoadError?: (failed: boolean) => void;
  /** Extra fields after the depth (a bulk sample's description). */
  children?: ReactNode;
}) {
  const at = (field: string) => `${path}.${field}`;
  const error = (field: string) => errors.get(at(field)) ?? null;
  const optional = required ? '' : ' (optional)';
  const mono = 'font-mono';

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ChoiceGroup
        id={fieldId(at('sourceType'))}
        label="Sampling source"
        required
        options={SOURCE_OPTIONS}
        value={sample.sourceType}
        onChange={(type) => onChange(withSourceType(type))}
        error={error('sourceType')}
      />

      <div className="flex min-w-0 flex-wrap items-start gap-3">
        {sample.sourceType === 'test_hole' ? (
          <div id={fieldId(at('testHoleId'))} className="flex w-56 min-w-0 flex-col gap-1.5">
            {projectId ? (
              <TestHolePicker
                key={`${projectId}:${holeReloadKey}`}
                single
                legend="Test hole"
                projectId={projectId}
                selected={sample.testHole ? [sample.testHole] : []}
                onChange={(holes) => onChange({ testHole: holes.at(-1) ?? null })}
                query={sample.holeQuery}
                onQueryChange={(holeQuery) => onChange({ holeQuery })}
                receiverUserId={receiverUserId}
                online={online}
                onLoadError={onHolesLoadError}
                addedNote={(name) =>
                  `Added test hole ${name}${projectNumber ? ` to ${projectNumber}` : ''}. It stays on the project even if you discard this draft.`
                }
              />
            ) : (
              <p className="text-muted-foreground m-0 text-[13px]">
                Choose the project first, then the test hole.
              </p>
            )}
            {error('testHoleId') ? <FieldErrorText>{error('testHoleId')}</FieldErrorText> : null}
          </div>
        ) : null}

        {sample.sourceType === 'standalone_location' ? (
          <LabeledField
            id={fieldId(at('sourceLocationReference'))}
            label="Location reference"
            hint="The sampling location as written in the field (e.g. Embankment Location 03). Not where it is stored."
            error={error('sourceLocationReference')}
            className="w-64"
          >
            {(props) => (
              <InputGroup>
                <InputGroupAddon title="Location reference">
                  <MapPin aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  {...props}
                  required
                  maxLength={SOURCE_LOCATION_REFERENCE_MAX_LENGTH}
                  value={sample.locationReference}
                  onChange={(e) => onChange({ locationReference: e.target.value })}
                />
              </InputGroup>
            )}
          </LabeledField>
        ) : null}

        <LabeledField
          id={fieldId(at('sampleReference'))}
          label={`Sample reference${optional}`}
          hint={required ? 'Usually starts with B, but any reference is fine.' : undefined}
          error={error('sampleReference')}
          className="w-40"
        >
          {(props) => (
            <Input
              {...props}
              className={mono}
              required={required}
              maxLength={SAMPLE_REFERENCE_MAX_LENGTH}
              placeholder={referencePlaceholder}
              value={sample.sampleReference}
              onChange={(e) => onChange({ sampleReference: e.target.value })}
            />
          )}
        </LabeledField>

        <LabeledField
          id={fieldId(at('depthFrom'))}
          label={`Depth${optional}`}
          hint="A single depth, or the top of an interval."
          error={error('depthFrom')}
          className="w-32"
        >
          {(props) => (
            <Input
              {...props}
              className={mono}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              required={required}
              value={sample.depthFrom}
              onChange={(e) => onChange({ depthFrom: e.target.value })}
            />
          )}
        </LabeledField>
        <LabeledField
          id={fieldId(at('depthTo'))}
          label="Depth to (optional)"
          hint="For an interval."
          error={error('depthTo')}
          className="w-32"
        >
          {(props) => (
            <Input
              {...props}
              className={mono}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={sample.depthTo}
              onChange={(e) => onChange({ depthTo: e.target.value })}
            />
          )}
        </LabeledField>
        <ChoiceGroup
          id={fieldId(at('depthUnit'))}
          label="Depth unit"
          required={required || sample.depthFrom.trim() !== ''}
          options={DEPTH_UNITS}
          value={sample.depthUnit}
          onChange={(depthUnit) => onChange({ depthUnit })}
          error={error('depthUnit')}
        />
      </div>
      {children}
    </div>
  );
}
