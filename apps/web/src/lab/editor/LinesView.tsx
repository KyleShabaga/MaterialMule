import type {
  CoverageUnit,
  LabProgramReview,
  LabSource,
  TestCatalogue,
  TestTemplate,
} from '@materialmule/shared';
import { Plus } from 'lucide-react';
import { useId, useState, type Dispatch } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { LineEditor } from '../LineEditor';
import type { LineDraft } from '../line-draft';
import {
  LONG_PROGRAM_LINES,
  lineFilterOptions,
  lineMatchesFilter,
  type EditAction,
  type EditorProblem,
} from './program-state';

// Lines view (STRATA-86, the default): one row per sample line. Over about 12 lines a filter
// bar shows All / each test hole / Standalone with counts, and a Go to line field (Kyle
// 2026-11-12). All lines stay in one list, never paged; problems on hidden lines still show in
// the sticky bar.

export function LinesView({
  lines,
  projectId,
  sources,
  catalogue,
  templates,
  review,
  problems,
  testNames,
  filter,
  onFilter,
  onGoTo,
  dispatch,
  readOnly = false,
}: {
  lines: LineDraft[];
  projectId: string;
  sources: LabSource[];
  catalogue: TestCatalogue | null;
  templates: TestTemplate[];
  /** The latest review (coverage per line), even if the lines changed since. */
  review: LabProgramReview | null;
  problems: EditorProblem[];
  testNames: Map<string, string>;
  filter: string;
  onFilter: (filter: string) => void;
  /** Go to line N (1-based); the editor shows and focuses it. */
  onGoTo: (lineNumber: number) => void;
  dispatch: Dispatch<EditAction>;
  readOnly?: boolean;
}) {
  const id = useId();
  const [goTo, setGoTo] = useState('');
  const long = lines.length > LONG_PROGRAM_LINES;
  const active = long ? filter : 'all';
  const options = long ? lineFilterOptions(lines, sources) : [];
  const shown = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => lineMatchesFilter(line, active));
  const filterLabel = options.find((option) => option.id === active)?.label;
  const coverageOf = (line: LineDraft): CoverageUnit[] | null => {
    if (!line.id || !review) return null;
    return review.lines.find((other) => other.lineId === line.id)?.coverage ?? null;
  };

  return (
    <div className="grid gap-3">
      {long ? (
        <div
          className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-lg border bg-muted/40 px-3 py-2"
          role="group"
          aria-label="Find a line"
        >
          <div className="grid gap-1.5">
            <span id={`${id}-show`} className="text-[13px] font-medium text-muted-foreground">
              Show
            </span>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-labelledby={`${id}-show`}
              value={active}
              className="flex-wrap"
              onValueChange={(value) => onFilter(value || 'all')}
            >
              {options.map((option) => (
                <ToggleGroupItem
                  key={option.id}
                  value={option.id}
                  className="h-8 gap-1.5 pointer-coarse:h-11"
                >
                  {option.label}{' '}
                  <span className="font-mono text-xs text-muted-foreground">{option.count}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <form
            className="grid gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const n = Number(goTo);
              if (Number.isInteger(n) && n >= 1 && n <= lines.length) {
                onGoTo(n);
                setGoTo('');
              }
            }}
          >
            <Label htmlFor={`${id}-goto`} className="text-[13px] font-medium text-muted-foreground">
              Go to line
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={`${id}-goto`}
                inputMode="numeric"
                className="h-8 w-20 font-mono pointer-coarse:h-11"
                value={goTo}
                placeholder={`1–${lines.length}`}
                onChange={(event) => setGoTo(event.target.value.replace(/\D/g, ''))}
              />
              <Kbd>Enter</Kbd>
            </div>
          </form>
          {active !== 'all' ? (
            <p className="basis-full text-[13px] text-muted-foreground" role="status">
              Showing {shown.length} of {lines.length} lines: {filterLabel} only. Problems on hidden
              lines still show in the bar below.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3">
        {shown.map(({ line, index }) => (
          <LineEditor
            key={line.key}
            index={index}
            line={line}
            projectId={projectId}
            sources={sources}
            catalogue={catalogue}
            templates={templates}
            testNames={testNames}
            readOnly={readOnly}
            review={
              line.id ? (review?.lines.find((other) => other.lineId === line.id) ?? null) : null
            }
            coverage={coverageOf(line)}
            problems={problems
              .filter((problem) => problem.lineKey === line.key)
              .map((problem) => problem.message)}
            onChange={(change) => dispatch({ type: 'change-line', key: line.key, change })}
            onDuplicate={
              readOnly ? undefined : () => dispatch({ type: 'duplicate-line', key: line.key })
            }
            onRemove={
              readOnly || lines.length <= 1
                ? undefined
                : () => dispatch({ type: 'remove-line', key: line.key })
            }
          />
        ))}
      </div>
      {readOnly ? null : (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => {
              if (active !== 'all') onFilter('all');
              dispatch({ type: 'add-line' });
            }}
          >
            <Plus aria-hidden="true" />
            Add sample line
          </Button>
        </div>
      )}
    </div>
  );
}
