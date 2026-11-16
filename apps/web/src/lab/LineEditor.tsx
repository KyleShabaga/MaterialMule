import {
  LINE_SCOPE_LABEL,
  LINE_SCOPES,
  depthKey,
  type CoverageUnit,
  type LabSource,
  type LabSourceUnit,
  type LineReview,
  type LineScope,
  type TestCatalogue,
  type TestTemplate,
} from '@materialmule/shared';
import { Copy, EllipsisVertical, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Item } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { fetchSourceUnits } from './api';
import { sourceLabel } from './editor/labels';
import { type LineDraft } from './line-draft';
import { TestChip, TestPicker } from './TestPicker';

// One sample line (STRATA-86 Lines view; MM-T23 program entry, MM-T83 a line added by an
// amendment): the sampling source with its exact identity (a test hole, a standalone Shelby tube
// or a standalone bulk sample), ALL / Grabs / SPT / Specific with the sample's own depth, the
// tests as chips with + Add test, and the storage units the line covers.

const SOURCE_GROUPS: [string, LabSource['kind']][] = [
  ['Test holes', 'test_hole'],
  ['Standalone Shelby tubes', 'standalone_unit'],
  ['Standalone bulk samples', 'standalone_bulk_group'],
];

const FIELD = 'grid content-start gap-1.5';
const LABEL = 'text-[13px] font-medium text-muted-foreground';
const CONTROL_SM = 'h-9 pointer-coarse:h-11';

export function LineEditor({
  index,
  line,
  projectId,
  sources,
  catalogue,
  templates,
  review,
  coverage,
  problems = [],
  title,
  marker,
  testNames,
  readOnly = false,
  onChange,
  onRemove,
  onDuplicate,
  testsExtra,
}: {
  index: number;
  line: LineDraft;
  projectId: string;
  sources: LabSource[];
  /** Null while the catalogue can't load: chips stay, adding tests waits. */
  catalogue: TestCatalogue | null;
  templates: TestTemplate[];
  /** The depth discrepancy from a review (or an amendment's refusal) to acknowledge. */
  review: Pick<LineReview, 'discrepancy'> | null;
  /** What the latest review says this line covers (ALL / Grabs / SPT / Specific links). */
  coverage?: CoverageUnit[] | null;
  /** What keeps this line from being submitted (the editor's one validator). */
  problems?: string[];
  /** Accessible name of the row; "Line {index + 1}" by default. */
  title?: string;
  /** A tag beside the line number, e.g. "Added by amendment". */
  marker?: ReactNode;
  /** Names of tests on the line when the catalogue isn't there. */
  testNames?: Map<string, string>;
  readOnly?: boolean;
  onChange: (change: Partial<LineDraft>) => void;
  onRemove?: () => void;
  onDuplicate?: () => void;
  /** Drawn after the line's chips (amendments add their own). */
  testsExtra?: ReactNode;
}) {
  const id = useId();
  const number = index + 1;
  const name = title ?? `Line ${number}`;
  const [loaded, setLoaded] = useState<{ key: string; units: LabSourceUnit[] } | null>(null);
  const sourceValue = line.source ? `${line.source.kind}:${line.source.id}` : '';
  const unitsKey = `${sourceValue}|${line.scope}`;
  const units = loaded?.key === unitsKey ? loaded.units : null;
  useEffect(() => {
    if (!line.source || line.scope === 'all') return;
    let current = true;
    fetchSourceUnits(projectId, line.source).then(
      (found) => current && setLoaded({ key: unitsKey, units: found }),
      () => current && setLoaded({ key: unitsKey, units: [] }),
    );
    return () => {
      current = false;
    };
  }, [projectId, line.source, line.scope, unitsKey]);

  const specific = line.scope === 'specific';
  const source = line.source ? sourceLabel(line, sources) : null;
  const included = coverage?.filter((unit) => unit.included) ?? null;

  return (
    <Item
      asChild
      variant="outline"
      className="@container flex-col items-stretch gap-3 bg-card scroll-mt-28 data-[highlight=true]:ring-2 data-[highlight=true]:ring-ring/50"
    >
      <section aria-label={name} data-line-key={line.key} id={`line-${line.key}`}>
        <div className="flex items-start gap-3">
          <span className="mt-2 w-9 shrink-0 font-mono text-sm font-semibold" aria-hidden="true">
            L{number}
          </span>
          <div className="grid min-w-0 flex-1 gap-3 @2xl:grid-cols-[minmax(13rem,20rem)_1fr]">
            <div className={FIELD}>
              <Label htmlFor={`${id}-source`} className={LABEL}>
                Sampling source
              </Label>
              <Select
                value={sourceValue}
                disabled={readOnly}
                onValueChange={(value) => {
                  const [kind, sourceId] = value.split(':');
                  onChange({
                    source: sourceId ? { kind: kind as LabSource['kind'], id: sourceId } : null,
                    unitIds: [],
                  });
                }}
              >
                <SelectTrigger id={`${id}-source`} className={cn('w-full', CONTROL_SM)}>
                  <SelectValue placeholder="Choose a source" />
                </SelectTrigger>
                <SelectContent position="popper">
                  {SOURCE_GROUPS.map(([label, kind]) => {
                    const options = sources.filter((s) => s.kind === kind);
                    return options.length > 0 ? (
                      <SelectGroup key={kind}>
                        <SelectLabel>{label}</SelectLabel>
                        {options.map((s) => (
                          <SelectItem key={s.id} value={`${s.kind}:${s.id}`}>
                            {s.label} — {s.unitCount} unit{s.unitCount === 1 ? '' : 's'}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null;
                  })}
                  {sources.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">
                      No sampling sources on this project yet.
                    </p>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
            <div className={FIELD}>
              <span id={`${id}-scope`} className={LABEL}>
                Samples
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                aria-labelledby={`${id}-scope`}
                value={line.scope}
                disabled={readOnly}
                className="flex-wrap"
                onValueChange={(value) => {
                  if (value) onChange({ scope: value as LineScope, unitIds: [] });
                }}
              >
                {LINE_SCOPES.map((scope) => (
                  <ToggleGroupItem key={scope} value={scope} className={CONTROL_SM}>
                    {LINE_SCOPE_LABEL[scope]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>
          {marker}
          {onRemove || onDuplicate ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-coarse:size-11"
                  aria-label={`More actions for ${name.toLowerCase()}`}
                >
                  <EllipsisVertical aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onDuplicate ? (
                  <DropdownMenuItem onSelect={onDuplicate}>
                    <Copy aria-hidden="true" />
                    Duplicate line
                  </DropdownMenuItem>
                ) : null}
                {onDuplicate && onRemove ? <DropdownMenuSeparator /> : null}
                {onRemove ? (
                  <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                    <Trash2 aria-hidden="true" />
                    Remove line
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        <div className="grid gap-3 pl-12 max-sm:pl-0">
          {specific ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className={FIELD}>
                <Label htmlFor={`${id}-label`} className={LABEL}>
                  Sample label
                </Label>
                <Input
                  id={`${id}-label`}
                  className={cn('w-28', CONTROL_SM)}
                  value={line.sampleLabel}
                  placeholder="G3"
                  maxLength={40}
                  readOnly={readOnly}
                  onChange={(event) => onChange({ sampleLabel: event.target.value })}
                />
              </div>
              <div className={FIELD}>
                <Label htmlFor={`${id}-mode`} className={LABEL}>
                  Depth
                </Label>
                <Select
                  value={line.depthMode}
                  disabled={readOnly}
                  onValueChange={(value) => onChange({ depthMode: value as 'point' | 'interval' })}
                >
                  <SelectTrigger id={`${id}-mode`} className={cn('w-44', CONTROL_SM)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="point">Single depth</SelectItem>
                    <SelectItem value="interval">Interval (from–to)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className={FIELD}>
                <Label htmlFor={`${id}-from`} className={LABEL}>
                  {line.depthMode === 'interval' ? 'From' : 'At'}
                </Label>
                <Input
                  id={`${id}-from`}
                  inputMode="decimal"
                  className={cn('w-20 font-mono', CONTROL_SM)}
                  value={line.depthFrom}
                  readOnly={readOnly}
                  onChange={(event) => onChange({ depthFrom: event.target.value })}
                />
              </div>
              {line.depthMode === 'interval' ? (
                <div className={FIELD}>
                  <Label htmlFor={`${id}-to`} className={LABEL}>
                    To
                  </Label>
                  <Input
                    id={`${id}-to`}
                    inputMode="decimal"
                    className={cn('w-20 font-mono', CONTROL_SM)}
                    value={line.depthTo}
                    readOnly={readOnly}
                    onChange={(event) => onChange({ depthTo: event.target.value })}
                  />
                </div>
              ) : null}
              <div className={FIELD}>
                <Label htmlFor={`${id}-unit`} className={LABEL}>
                  Unit
                </Label>
                <Select
                  value={line.depthUnit}
                  disabled={readOnly}
                  onValueChange={(value) => onChange({ depthUnit: value as 'ft' | 'm' })}
                >
                  <SelectTrigger id={`${id}-unit`} className={cn('w-20', CONTROL_SM)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="ft">ft</SelectItem>
                    <SelectItem value="m">m</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}

          <div className={FIELD}>
            <span id={`${id}-tests`} className={LABEL}>
              Tests
            </span>
            {catalogue ? (
              <TestPicker
                labelId={`${id}-tests`}
                catalogue={catalogue}
                templates={templates}
                selected={line.testTypeIds}
                addLabel={`Add test to ${name.toLowerCase()}`}
                extra={testsExtra}
                readOnly={readOnly}
                onChange={(testTypeIds) => onChange({ testTypeIds })}
              />
            ) : (
              <ul className="flex flex-wrap gap-1.5" aria-label="Requested tests">
                {line.testTypeIds.map((testId) => (
                  <TestChip key={testId} label={testNames?.get(testId) ?? 'Test'} />
                ))}
              </ul>
            )}
          </div>

          <UnitsCovered
            id={id}
            line={line}
            source={source}
            units={units}
            included={included}
            readOnly={readOnly}
            onChange={onChange}
          />

          {review?.discrepancy ? (
            <Alert className="border-stage-due-fg/40">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription className="grid gap-2">
                <p>
                  Depth differs: this sample is also requested at{' '}
                  {review.discrepancy.others
                    .map(
                      (other) =>
                        `${other.depth} (${other.programNumber ?? 'this draft'}, line ${other.lineNumber})`,
                    )
                    .join('; ')}
                  .
                </p>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-ack`}
                    disabled={readOnly}
                    checked={review.discrepancy.depths.every((depth) =>
                      line.acknowledgedDepths.map(depthKey).includes(depthKey(depth)),
                    )}
                    onCheckedChange={(checked) =>
                      onChange({
                        acknowledgedDepths: checked === true ? review.discrepancy!.depths : [],
                      })
                    }
                  />
                  <Label htmlFor={`${id}-ack`} className="font-normal">
                    I’ve checked the depths; request it at this depth anyway
                  </Label>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          {problems.length > 0 ? (
            <ul
              className="grid gap-1 text-[13px] text-stage-danger-fg"
              aria-label={`${name} still needs`}
            >
              {problems.map((problem) => (
                <li key={problem} className="flex items-center gap-1.5">
                  <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                  {problem}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    </Item>
  );
}

/**
 * "Storage units covered": ALL lists what the review found for the source; Grabs and SPT tick
 * the units that hold them (units don't record G/S); a Specific sample may link the units
 * holding it. Coverage is frozen when the program is submitted.
 */
function UnitsCovered({
  id,
  line,
  source,
  units,
  included,
  readOnly,
  onChange,
}: {
  id: string;
  line: LineDraft;
  source: string | null;
  units: LabSourceUnit[] | null;
  included: CoverageUnit[] | null;
  readOnly: boolean;
  onChange: (change: Partial<LineDraft>) => void;
}) {
  if (!line.source) return null;
  if (line.scope === 'all') {
    return (
      <div className={FIELD}>
        <span className={LABEL}>Storage units covered</span>
        {included === null ? (
          <p className="text-[13px] text-muted-foreground">Shown once the line is saved.</p>
        ) : included.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No units received for {source} yet. Units received before you submit are covered.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[13px]">
            {included.map((unit) => (
              <li key={unit.storageUnitId}>{unit.readableId}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const specific = line.scope === 'specific';
  return (
    <fieldset className={FIELD} data-slot="fieldset">
      <legend className={cn(LABEL, 'mb-1.5')}>
        {specific ? 'Physical units holding this sample (if known)' : 'Storage units covered'}
      </legend>
      <p className="text-[13px] text-muted-foreground">
        {specific
          ? 'Leave all unticked when you don’t know which unit holds it.'
          : `Units don’t record whether they hold ${line.scope === 'grabs' ? 'grab (G)' : 'SPT (S)'} samples. Tick the units that do; the others are recorded as excluded.`}
      </p>
      {units === null ? (
        <p aria-busy="true" className="text-[13px] text-muted-foreground">
          Loading units…
        </p>
      ) : units.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No units received for {source} yet. Units received before you submit can be ticked here.
        </p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {units.map((unit) => {
            const boxId = `${id}-unit-${unit.storageUnitId}`;
            return (
              <div key={unit.storageUnitId} className="flex items-center gap-2">
                <Checkbox
                  id={boxId}
                  disabled={readOnly}
                  checked={line.unitIds.includes(unit.storageUnitId)}
                  onCheckedChange={(checked) =>
                    onChange({
                      unitIds:
                        checked === true
                          ? [...line.unitIds, unit.storageUnitId]
                          : line.unitIds.filter((other) => other !== unit.storageUnitId),
                    })
                  }
                />
                <Label htmlFor={boxId} className="font-normal">
                  <span className="font-mono">{unit.readableId}</span>
                  {unit.contents ? (
                    <span className="text-muted-foreground"> {unit.contents}</span>
                  ) : null}
                </Label>
              </div>
            );
          })}
        </div>
      )}
      {included && included.length > 0 && !specific ? (
        <p className="text-[13px] text-muted-foreground">
          Covers <span className="font-mono">{included.map((u) => u.readableId).join(', ')}</span>.
        </p>
      ) : null}
    </fieldset>
  );
}
