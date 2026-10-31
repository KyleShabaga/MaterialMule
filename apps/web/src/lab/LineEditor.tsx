import {
  LINE_SCOPE_LABEL,
  LINE_SCOPES,
  depthKey,
  lineSubmitProblems,
  type LabSource,
  type LabSourceUnit,
  type LineReview,
  type TestCatalogue,
  type TestTemplate,
} from '@materialmule/shared';
import { useEffect, useId, useState } from 'react';
import { BandedCard } from '../components/ui';
import { fetchSourceUnits } from './api';
import { numberOrNull, toInput, type LineDraft } from './line-draft';
import { TestPicker } from './TestPicker';

// One testing line: source, ALL / Grabs / SPT / Specific, explicit units and tests. Used by
// program entry (MM-T23) and by "Add a testing line" on a submitted program (MM-T83).

export function LineEditor({
  index,
  line,
  projectId,
  sources,
  catalogue,
  templates,
  review,
  title,
  onChange,
  onRemove,
}: {
  index: number;
  line: LineDraft;
  projectId: string;
  sources: LabSource[];
  catalogue: TestCatalogue;
  templates: TestTemplate[];
  /** The depth discrepancy from a review (or an amendment's refusal) to acknowledge. */
  review: Pick<LineReview, 'discrepancy'> | null;
  /** Card title; "Line {index + 1}" by default. */
  title?: string;
  onChange: (change: Partial<LineDraft>) => void;
  onRemove?: () => void;
}) {
  const id = useId();
  const [units, setUnits] = useState<LabSourceUnit[] | null>(null);
  const sourceValue = line.source ? `${line.source.kind}:${line.source.id}` : '';
  useEffect(() => {
    if (!line.source || line.scope === 'all') return;
    let current = true;
    fetchSourceUnits(projectId, line.source).then(
      (found) => current && setUnits(found),
      () => current && setUnits([]),
    );
    return () => {
      current = false;
    };
  }, [projectId, line.source, line.scope]);

  const problems = lineSubmitProblems({
    ...toInput(line),
    source: line.source,
    sampleLabel: line.scope === 'specific' && line.sampleLabel.trim() ? line.sampleLabel : null,
    depthMode: line.scope === 'specific' ? line.depthMode : null,
    depthFrom: line.scope === 'specific' ? numberOrNull(line.depthFrom) : null,
    depthTo: line.scope === 'specific' ? numberOrNull(line.depthTo) : null,
    depthUnit: line.scope === 'specific' ? line.depthUnit : null,
    scope: line.scope,
    testCount: line.testTypeIds.length,
  });
  const groups: [string, LabSource['kind']][] = [
    ['Test holes', 'test_hole'],
    ['Standalone Shelby tubes', 'standalone_unit'],
    ['Standalone bulk samples', 'standalone_bulk_group'],
  ];

  return (
    <BandedCard
      title={title ?? `Line ${index + 1}`}
      headingLevel={3}
      aside={
        onRemove ? (
          <button type="button" onClick={onRemove}>
            Remove line
          </button>
        ) : null
      }
    >
      <div className="line-grid">
        <div className="form-field">
          <label htmlFor={`${id}-source`}>Sampling source</label>
          <select
            id={`${id}-source`}
            value={sourceValue}
            onChange={(event) => {
              const [kind, sourceId] = event.target.value.split(':');
              setUnits(null);
              onChange({
                source: sourceId ? { kind: kind as LabSource['kind'], id: sourceId } : null,
                unitIds: [],
              });
            }}
          >
            <option value="">Choose a source</option>
            {groups.map(([label, kind]) => {
              const options = sources.filter((source) => source.kind === kind);
              return options.length > 0 ? (
                <optgroup key={kind} label={label}>
                  {options.map((source) => (
                    <option key={source.id} value={`${source.kind}:${source.id}`}>
                      {source.label} — {source.unitCount} unit{source.unitCount === 1 ? '' : 's'}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </div>
        <fieldset className="scope-toggle">
          <legend>Samples</legend>
          {LINE_SCOPES.map((scope) => (
            <label key={scope}>
              <input
                type="radio"
                name={`${id}-scope`}
                value={scope}
                checked={line.scope === scope}
                onChange={() => onChange({ scope, unitIds: [] })}
              />
              {LINE_SCOPE_LABEL[scope]}
            </label>
          ))}
        </fieldset>
      </div>

      {line.scope === 'specific' ? (
        <div className="specific-sample">
          <div className="form-field">
            <label htmlFor={`${id}-label`}>Sample label</label>
            <input
              id={`${id}-label`}
              value={line.sampleLabel}
              placeholder="G3"
              maxLength={40}
              onChange={(event) => onChange({ sampleLabel: event.target.value })}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-mode`}>Depth</label>
            <select
              id={`${id}-mode`}
              value={line.depthMode}
              onChange={(event) =>
                onChange({ depthMode: event.target.value as 'point' | 'interval' })
              }
            >
              <option value="point">Single depth</option>
              <option value="interval">Interval (from–to)</option>
            </select>
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-from`}>{line.depthMode === 'interval' ? 'From' : 'At'}</label>
            <input
              id={`${id}-from`}
              inputMode="decimal"
              value={line.depthFrom}
              onChange={(event) => onChange({ depthFrom: event.target.value })}
            />
          </div>
          {line.depthMode === 'interval' ? (
            <div className="form-field">
              <label htmlFor={`${id}-to`}>To</label>
              <input
                id={`${id}-to`}
                inputMode="decimal"
                value={line.depthTo}
                onChange={(event) => onChange({ depthTo: event.target.value })}
              />
            </div>
          ) : null}
          <div className="form-field">
            <label htmlFor={`${id}-unit`}>Unit</label>
            <select
              id={`${id}-unit`}
              value={line.depthUnit}
              onChange={(event) => onChange({ depthUnit: event.target.value as 'ft' | 'm' })}
            >
              <option value="ft">ft</option>
              <option value="m">m</option>
            </select>
          </div>
        </div>
      ) : null}

      {line.source && line.scope !== 'all' ? (
        <fieldset className="unit-choices">
          <legend>
            {line.scope === 'specific'
              ? 'Physical units holding this sample (if known)'
              : 'Units to include'}
          </legend>
          {line.scope !== 'specific' ? (
            <p className="field-hint">
              Units don’t record whether they hold {line.scope === 'grabs' ? 'grab (G)' : 'SPT (S)'}{' '}
              samples. Tick the units that do; unticked units are recorded as excluded after your
              review.
            </p>
          ) : (
            <p className="field-hint">
              Leave all unticked when you don’t know which unit holds it.
            </p>
          )}
          {units === null ? (
            <p aria-busy="true">Loading units…</p>
          ) : units.length === 0 ? (
            <p className="field-hint">No units from this source are in storage.</p>
          ) : (
            units.map((unit) => (
              <label key={unit.storageUnitId} className="unit-choice">
                <input
                  type="checkbox"
                  checked={line.unitIds.includes(unit.storageUnitId)}
                  onChange={(event) =>
                    onChange({
                      unitIds: event.target.checked
                        ? [...line.unitIds, unit.storageUnitId]
                        : line.unitIds.filter((other) => other !== unit.storageUnitId),
                    })
                  }
                />
                <span className="mono">{unit.readableId}</span> {unit.contents ?? ''}
              </label>
            ))
          )}
        </fieldset>
      ) : null}

      <h4 id={`${id}-tests`}>Tests</h4>
      <TestPicker
        labelId={`${id}-tests`}
        catalogue={catalogue}
        templates={templates}
        selected={line.testTypeIds}
        onChange={(testTypeIds) => onChange({ testTypeIds })}
      />

      {review?.discrepancy ? (
        <div className="notice notice-warning">
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
          <label>
            <input
              type="checkbox"
              checked={review.discrepancy.depths.every((depth) =>
                line.acknowledgedDepths.map(depthKey).includes(depthKey(depth)),
              )}
              onChange={(event) =>
                onChange({
                  acknowledgedDepths: event.target.checked ? review.discrepancy!.depths : [],
                })
              }
            />{' '}
            I’ve checked the depths; request it at this depth anyway
          </label>
        </div>
      ) : null}
      {problems.length > 0 ? (
        <ul className="line-problems" aria-label={`Line ${index + 1} still needs`}>
          {problems.map((problem) => (
            <li key={problem.field}>{problem.message}</li>
          ))}
        </ul>
      ) : null}
    </BandedCard>
  );
}
