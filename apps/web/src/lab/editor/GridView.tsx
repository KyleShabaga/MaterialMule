import { LINE_SCOPE_LABEL, type LabSource, type TestCatalogue } from '@materialmule/shared';
import { TriangleAlert } from 'lucide-react';
import { useState, type Dispatch } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { LineDraft } from '../line-draft';
import { AddTestButton } from '../TestPicker';
import { sampleSummary, sourceLabel, testLabel, testShortName } from './labels';
import { gridTests, type EditAction } from './program-state';

// Grid view (STRATA-86): the same lines as the Lines view, samples down the side and tests
// across the top, one checkbox per cell. Ticking a column heading adds that test to every
// sample. Rows are the program's lines in order (stable while ticking); the sample column stays
// put while the grid scrolls sideways past about 12 tests.

const STICKY = 'sticky left-0 z-10 bg-card';

export function GridView({
  lines,
  sources,
  catalogue,
  testNames,
  problemLines,
  dispatch,
  readOnly = false,
}: {
  lines: LineDraft[];
  sources: LabSource[];
  catalogue: TestCatalogue | null;
  testNames: Map<string, string>;
  /** Lines (by key) with something to fix, flagged in the sample column. */
  problemLines: Set<string>;
  dispatch: Dispatch<EditAction>;
  readOnly?: boolean;
}) {
  // A column added from + Add test before any line has it: a view aid, not program data.
  const [extra, setExtra] = useState<string[]>([]);
  const columns = gridTests(lines, extra);
  const byId = new Map(catalogue?.tests.map((test) => [test.id, test]) ?? []);
  const nameOf = (id: string) => {
    const test = byId.get(id);
    return test ? testShortName(test) : (testNames.get(id) ?? 'Test');
  };
  const fullName = (id: string) => {
    const test = byId.get(id);
    return test ? testLabel(test) : (testNames.get(id) ?? 'Test');
  };

  return (
    <div className="grid gap-2">
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table aria-label="Samples and tests" className="border-separate border-spacing-0">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className={cn(STICKY, 'min-w-56 border-r border-b')}>
                Sample line
              </TableHead>
              {columns.map((testId) => {
                const on = lines.filter((line) => line.testTypeIds.includes(testId)).length;
                const state = on === 0 ? false : on === lines.length ? true : 'indeterminate';
                const name = nameOf(testId);
                return (
                  <TableHead
                    key={testId}
                    scope="col"
                    className="h-auto min-w-28 border-b px-3 py-2 align-bottom"
                    title={fullName(testId)}
                  >
                    <div className="grid justify-items-center gap-1.5 text-center">
                      <span className="max-w-32 text-[13px] leading-tight whitespace-normal">
                        {name}
                      </span>
                      <Checkbox
                        aria-label={`${name} on every line`}
                        checked={state}
                        disabled={readOnly}
                        className="pointer-coarse:size-6"
                        onCheckedChange={(checked) =>
                          dispatch({
                            type: 'set-test-everywhere',
                            testTypeId: testId,
                            on: checked === true,
                          })
                        }
                      />
                      <span className="text-[11px] font-normal text-muted-foreground">
                        {state === true
                          ? 'on every line'
                          : state === false
                            ? 'on no line'
                            : 'on some lines'}
                      </span>
                    </div>
                  </TableHead>
                );
              })}
              <TableHead scope="col" className="border-b px-3 align-bottom">
                {catalogue && !readOnly ? (
                  <AddTestButton
                    catalogue={catalogue}
                    selected={columns}
                    accessibleLabel="Add test column"
                    onAdd={(testId) => setExtra((current) => [...current, testId])}
                  />
                ) : null}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line, index) => {
              const number = index + 1;
              const source = sourceLabel(line, sources);
              const sample = sampleSummary(line, LINE_SCOPE_LABEL[line.scope]);
              return (
                <TableRow key={line.key} className="hover:bg-muted/40">
                  <TableHead
                    scope="row"
                    className={cn(STICKY, 'h-auto border-r border-b px-2 py-2 font-normal')}
                  >
                    <div className="flex items-start gap-2">
                      <span className="w-8 font-mono text-sm font-semibold">L{number}</span>
                      <span className="grid">
                        <span className="font-mono text-[13px]">{source}</span>
                        <span className="text-[12px] text-muted-foreground">{sample}</span>
                      </span>
                      {problemLines.has(line.key) ? (
                        <TriangleAlert
                          className="ml-auto size-3.5 text-stage-danger-fg"
                          aria-label="Needs attention"
                        />
                      ) : null}
                    </div>
                  </TableHead>
                  {columns.map((testId) => (
                    <TableCell key={testId} className="border-b text-center">
                      <Checkbox
                        aria-label={`${nameOf(testId)} on line ${number}`}
                        checked={line.testTypeIds.includes(testId)}
                        disabled={readOnly}
                        className="pointer-coarse:size-6"
                        onCheckedChange={(checked) =>
                          dispatch({
                            type: 'set-test',
                            key: line.key,
                            testTypeId: testId,
                            on: checked === true,
                          })
                        }
                      />
                    </TableCell>
                  ))}
                  <TableCell className="border-b" />
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-[13px] text-muted-foreground">
        Tick a column heading to add that test to every line. Grid and Lines show the same program.
      </p>
    </div>
  );
}
