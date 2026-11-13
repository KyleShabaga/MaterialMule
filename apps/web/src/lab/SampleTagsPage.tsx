import {
  LINE_SCOPE_LABEL,
  TAG_SHEET,
  TAG_SLOTS_PER_SHEET,
  TEST_REQUEST_STATUS_LABEL,
  formatTagDate,
  layoutTagSheets,
  splitSampleTag,
  type SampleTag,
  type SampleTagSheet,
} from '@materialmule/shared';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Info,
  Pencil,
  Printer,
  RotateCw,
  Tag,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchSampleTags, type SampleTagsResult } from './api';
import { TagCard } from './tags/TagCard';
import { useFitText } from './tags/fit-text';
import './lab.css';
import './lab-ledger.css';
import './sample-tags.css';

/**
 * Letter paper with no margins while this view is open, so card positions are true inches from
 * the sheet's corner. A fixed string: no user data is ever placed in it.
 */
const PRINT_CSS = `
@page { size: letter; margin: 0; }
@media print {
  :root, html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  .tag-print { margin: 0; padding: 0; max-width: none; }
  .tag-print-controls { display: none !important; }
  .tag-preview { display: block; margin: 0; padding: 0; overflow: visible; background: none; }
  .tag-sheet-label { display: none; }
  .tag-sheet { margin: 0; box-shadow: none; border: 0; break-after: page; }
  .tag-sheet:last-child { break-after: auto; }
  .tag-slot-blank { visibility: hidden; }
  .tag-card.tag-card-overflow { outline: none; }
}
`;

/** Per computer (each printer feeds a little differently), never per person. */
const NUDGE_KEY = 'materialmule.sampleTags.nudge';
const NUDGE_LIMIT_IN = 0.25;

type Nudge = { x: number; y: number };

function readNudge(): Nudge {
  try {
    const value = JSON.parse(localStorage.getItem(NUDGE_KEY) ?? 'null') as Partial<Nudge> | null;
    const clamp = (n: unknown) =>
      typeof n === 'number' && Number.isFinite(n)
        ? Math.min(Math.max(n, -NUDGE_LIMIT_IN), NUDGE_LIMIT_IN)
        : 0;
    return { x: clamp(value?.x), y: clamp(value?.y) };
  } catch {
    return { x: 0, y: 0 };
  }
}

function writeNudge(nudge: Nudge) {
  try {
    localStorage.setItem(NUDGE_KEY, JSON.stringify(nudge));
  } catch {
    // Remembering the nudge is a convenience only.
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * /lab-testing/programs/:programId/tags (MM-T69, Strata STRATA-89): choose and print sample ID
 * tags for a submitted program on letter sheets of ten 2 × 4 in cards, in the round 1 print
 * pattern: which tags, start at card, this computer's nudge, a true-size preview, Print. The
 * preview chrome follows the theme; the cards are always black on white. The sheets that print
 * are laid out off screen exactly as before (PRINT_CSS), so printing is unchanged. Tags are
 * computed from the program's current requests; printing (or not) changes nothing.
 */
export function SampleTagsPage() {
  const { programId = '' } = useParams();
  const [result, setResult] = useState<{ id: string; value: SampleTagsResult } | null>(null);
  const [reloads, setReloads] = useState(0);
  const [split, setSplit] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string> | null>(null);
  const [start, setStart] = useState(1);
  const [outlines, setOutlines] = useState(false);
  const [nudge, setNudge] = useState<Nudge>(readNudge);
  const [previewAt, setPreviewAt] = useState(0);
  // Review fix (#103): a tab left open past midnight must not print yesterday's date, so the
  // date is refreshed when printing starts, from the button and from the browser's own print
  // command (beforeprint). flushSync puts the new date in the DOM before print layout is taken.
  const [date, setDate] = useState(() => formatTagDate(new Date()));
  const refreshDate = useCallback(() => {
    const today = formatTagDate(new Date());
    flushSync(() => setDate(today));
  }, []);
  useEffect(() => {
    window.addEventListener('beforeprint', refreshDate);
    return () => window.removeEventListener('beforeprint', refreshDate);
  }, [refreshDate]);
  const loadId = `${programId}:${reloads}`;

  useEffect(() => {
    let cancelled = false;
    void fetchSampleTags(programId).then((value) => {
      if (!cancelled) setResult({ id: loadId, value });
    });
    return () => {
      cancelled = true;
    };
  }, [programId, loadId]);

  const sheet = result?.id === loadId && result.value.ok ? result.value.sheet : null;
  const tags = useMemo(
    () => (sheet?.tags ?? []).flatMap((tag) => (split.has(tag.key) ? splitSampleTag(tag) : [tag])),
    [sheet, split],
  );
  // By default only tags with work still to do are printed (reprints don't waste cards).
  const notSelected = useMemo(
    () => excluded ?? new Set(tags.filter((tag) => !tag.pending).map((tag) => tag.key)),
    [excluded, tags],
  );
  const chosen = tags.filter((tag) => !notSelected.has(tag.key));
  const sheets = layoutTagSheets(chosen.length, start);
  const rootRef = useRef<HTMLElement>(null);
  const shown = Math.min(previewAt, Math.max(0, chosen.length - 1));
  const overflowing = useFitText(rootRef, [
    chosen.map((tag) => tag.key).join('|'),
    start,
    date,
    shown,
  ]);

  const toggle = useCallback(
    (key: string) => {
      const next = new Set(notSelected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setExcluded(next);
    },
    [notSelected],
  );
  const splitTag = (tag: SampleTag) => {
    setSplit(new Set(split).add(tag.key));
    if (notSelected.has(tag.key)) {
      const next = new Set(notSelected);
      for (const part of splitSampleTag(tag)) next.add(part.key);
      setExcluded(next);
    }
  };
  const changeNudge = (axis: keyof Nudge, value: number) => {
    const next = {
      ...nudge,
      [axis]: Number.isFinite(value)
        ? Math.min(Math.max(value, -NUDGE_LIMIT_IN), NUDGE_LIMIT_IN)
        : 0,
    };
    setNudge(next);
    writeNudge(next);
  };

  const programHref = `/lab-testing/programs/${encodeURIComponent(programId)}`;
  const loading = !result || result.id !== loadId;
  const failure = !loading && !result.value.ok ? result.value.reason : null;

  let body: React.ReactNode = null;
  if (loading) {
    body = (
      <div aria-busy="true" className="grid gap-4">
        <p role="status" className="sr-only">
          Loading tags…
        </p>
        <Skeleton className="h-4 w-64" />
        <div className="grid gap-8 @min-[60rem]:grid-cols-[minmax(0,1fr)_400px]">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      </div>
    );
  } else if (failure === 'not_found') {
    body = (
      <StateEmpty title="This program doesn’t exist, or it is someone else’s draft.">
        <Button asChild variant="outline">
          <Link to="/lab-testing/programs">
            <ArrowLeft aria-hidden="true" />
            All lab programs
          </Link>
        </Button>
      </StateEmpty>
    );
  } else if (failure === 'not_submitted') {
    body = (
      <StateEmpty
        title="Sample ID tags are available once the program is submitted."
        description="Tags carry the LP number, which the program gets when it is submitted to the lab."
      >
        <Button asChild variant="outline">
          <Link to={programHref}>
            <Pencil aria-hidden="true" />
            Continue editing
          </Link>
        </Button>
      </StateEmpty>
    );
  } else if (failure) {
    body = (
      <Alert variant="destructive" role="alert">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>The tags couldn’t be loaded.</AlertTitle>
        <AlertDescription>
          Couldn’t reach Material Mule. Check the connection and try again.
          <div className="mt-2">
            <Button
              variant="outline"
              size="sm"
              className="text-foreground"
              onClick={() => setReloads((n) => n + 1)}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  } else if (sheet && tags.length === 0) {
    body = (
      <>
        <StateEmpty
          title="No test in this program needs a sample ID tag."
          description="Which tests need a tag is set in Settings › Lab tests."
        >
          <Button asChild variant="outline">
            <Link to={programHref}>
              <ArrowLeft aria-hidden="true" />
              Back to the program
            </Link>
          </Button>
        </StateEmpty>
        <UntaggedNotes sheet={sheet} />
      </>
    );
  } else if (sheet) {
    const previewTag = chosen[shown] ?? null;
    const position = previewTag ? positionOf(sheets, shown) : null;
    body = (
      <div className="grid items-start gap-8 @min-[60rem]:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-6">
          <TagChoices
            tags={tags}
            chosenCount={chosen.length}
            notSelected={notSelected}
            overflowing={overflowing}
            onToggle={toggle}
            onSplit={splitTag}
            onSelectAll={(all) =>
              setExcluded(all ? new Set() : new Set(tags.map((tag) => tag.key)))
            }
          />
          <UntaggedNotes sheet={sheet} />
          <div className="grid items-start gap-4 @min-[36rem]:grid-cols-[14rem_minmax(0,1fr)]">
            <Field>
              <FieldLabel htmlFor="tag-start">Start at card</FieldLabel>
              <Select value={String(start)} onValueChange={(value) => setStart(Number(value))}>
                <SelectTrigger id="tag-start" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: TAG_SLOTS_PER_SHEET }, (_, i) => i + 1).map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      Card {n}
                      {n === 1 ? ' (full sheet)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                For a partly used sheet: cards count left to right, top to bottom.
              </FieldDescription>
            </Field>
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-semibold">
                Nudge for this computer’s printer (inches)
              </legend>
              <div className="flex flex-wrap items-center gap-3">
                {(
                  [
                    ['x', 'Across'],
                    ['y', 'Down'],
                  ] as const
                ).map(([axis, label]) => (
                  <Label key={axis} className="flex items-center gap-2 text-sm font-normal">
                    {label}
                    <Input
                      type="number"
                      step={0.01}
                      min={-NUDGE_LIMIT_IN}
                      max={NUDGE_LIMIT_IN}
                      value={nudge[axis]}
                      onChange={(event) => changeNudge(axis, event.target.valueAsNumber)}
                      className="w-24"
                    />
                  </Label>
                ))}
              </div>
              <p className="text-[13px] text-muted-foreground">Saved on this computer only.</p>
            </fieldset>
          </div>
          <div className="grid gap-1">
            <Label className="flex items-center gap-2 text-sm font-normal">
              <Checkbox checked={outlines} onCheckedChange={(on) => setOutlines(on === true)} />
              Print card outlines (plain-paper alignment test)
            </Label>
            <p className="text-[13px] text-muted-foreground">
              New printer or card stock? Print one sheet on plain paper with outlines, hold it over
              a card sheet, then adjust the nudge.
            </p>
          </div>
          {overflowing.size > 0 ? (
            <Alert role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>
                {overflowing.size === 1 ? 'One tag has' : `${overflowing.size} tags have`} text that
                doesn’t fit.
              </AlertTitle>
              <AlertDescription>
                They are marked in the list. Split the tag or check the printed card.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={chosen.length === 0}
              onClick={() => {
                refreshDate();
                window.print();
              }}
            >
              <Printer aria-hidden="true" />
              Print {plural(chosen.length, 'tag')}
            </Button>
            <span role="status" className="text-sm text-muted-foreground">
              {chosen.length} of {plural(tags.length, 'tag')} selected ·{' '}
              {plural(sheets.length, 'sheet')}
            </span>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Load Uline S-15619 insert card sheets, one side. In the print dialog choose Letter, 100
            % scale (Actual size), margins None, headers and footers off.
          </p>
        </div>
        <aside aria-labelledby="tag-preview-heading" className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="tag-preview-heading" className="text-base font-semibold">
              Preview
            </h2>
            <span className="text-sm text-muted-foreground">True size, 4 × 2 in</span>
          </div>
          {previewTag ? (
            <>
              <div className="flex flex-col items-center gap-3 overflow-x-auto rounded-xl border bg-muted px-4 py-6">
                {/* The real card at true size: black on white, never themed. */}
                <div
                  className="tag-card-frame flex-none bg-white text-black shadow-[0_0_0_1px_rgba(0,0,0,0.15)]"
                  data-slot="tag-card-frame"
                >
                  <TagCard
                    tag={previewTag}
                    sheet={sheet}
                    date={date}
                    overflow={overflowing.has(previewTag.key)}
                  />
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Previous tag"
                    disabled={shown <= 0}
                    onClick={() => setPreviewAt(shown - 1)}
                  >
                    <ChevronLeft aria-hidden="true" />
                  </Button>
                  <span className="px-1 text-sm text-muted-foreground tabular-nums">
                    {shown + 1} of {chosen.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Next tag"
                    disabled={shown >= chosen.length - 1}
                    onClick={() => setPreviewAt(shown + 1)}
                  >
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </div>
              </div>
              {position ? (
                <SheetMap
                  slots={sheets[position.sheet]!}
                  sheetIndex={position.sheet}
                  sheetCount={sheets.length}
                  current={position.slot}
                  chosen={chosen}
                />
              ) : null}
            </>
          ) : (
            <p className="rounded-xl border bg-muted px-4 py-6 text-sm text-muted-foreground">
              Choose a tag to see it here.
            </p>
          )}
          <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
            <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            Tags show today’s date ({date}) and the program’s current tests, and name the sample,
            not the storage unit. Printing never changes the program, its tests or any storage unit.
          </p>
        </aside>
      </div>
    );
  }

  return (
    <main className="tag-print" ref={rootRef}>
      <style>{PRINT_CSS}</style>
      <div className="tag-print-controls @container mx-auto flex w-full max-w-[1120px] flex-col gap-6">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/lab-testing/programs">Lab programs</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to={programHref} className={sheet ? 'font-mono' : undefined}>
                  {sheet?.program.programNumber ??
                    (failure === 'not_submitted' ? 'Draft lab program' : 'Lab program')}
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Sample ID tags</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <header className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Print sample ID tags</h1>
          {sheet ? (
            <p className="text-sm text-muted-foreground">
              Tags for{' '}
              <span className="font-mono whitespace-nowrap">{sheet.program.programNumber}</span> (
              {sheet.program.project.projectNumber} · {sheet.program.project.name}) on Uline S-15619
              card sheets (2 × 4 in, ten per sheet).
            </p>
          ) : null}
        </header>
        {body}
      </div>
      {sheet && chosen.length > 0 ? (
        // The sheets exactly as they print. On screen they sit off the page (sample-tags.css) so
        // text fitting still measures them; the preview above shows one card at true size.
        <div className="tag-preview" aria-hidden="true" data-testid="tag-sheets">
          {sheets.map((slots, sheetIndex) => (
            <section
              key={sheetIndex}
              className={outlines ? 'tag-sheet tag-sheet-outlines' : 'tag-sheet'}
              data-sheet={`${sheetIndex + 1} of ${sheets.length}`}
            >
              {slots.map((index, slot) => {
                const column = slot % TAG_SHEET.columns;
                const row = Math.floor(slot / TAG_SHEET.columns);
                const tag = index === null ? null : chosen[index]!;
                return (
                  <div
                    key={slot}
                    className={tag ? 'tag-slot' : 'tag-slot tag-slot-blank'}
                    style={{
                      left: `${TAG_SHEET.columnLeftIn[column]! + nudge.x}in`,
                      top: `${TAG_SHEET.topIn + row * TAG_SHEET.rowPitchIn + nudge.y}in`,
                    }}
                  >
                    {tag ? (
                      <TagCard
                        tag={tag}
                        sheet={sheet}
                        date={date}
                        overflow={overflowing.has(tag.key)}
                      />
                    ) : null}
                  </div>
                );
              })}
              <p className="tag-sheet-footer">
                Sample ID Tags · {sheet.program.programNumber} · {date} · Sheet {sheetIndex + 1} of{' '}
                {sheets.length}
              </p>
            </section>
          ))}
        </div>
      ) : null}
    </main>
  );
}

/** Where chosen tag `index` lands: its sheet and slot (0-based). */
function positionOf(sheets: (number | null)[][], index: number) {
  for (const [sheet, slots] of sheets.entries()) {
    const slot = slots.indexOf(index);
    if (slot >= 0) return { sheet, slot };
  }
  return null;
}

function StateEmpty({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <Empty className="border py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Tag aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}

/** The sheet the previewed card prints on, scaled: which cards hold a tag, and this one. */
function SheetMap({
  slots,
  sheetIndex,
  sheetCount,
  current,
  chosen,
}: {
  slots: (number | null)[];
  sheetIndex: number;
  sheetCount: number;
  current: number;
  chosen: SampleTag[];
}) {
  const used = slots.flatMap((index, slot) => (index === null ? [] : [slot + 1]));
  const range =
    used.length === 0
      ? 'no cards'
      : used.length === 1
        ? `card ${used[0]}`
        : `cards ${used[0]} to ${used[used.length - 1]}`;
  return (
    <div className="flex items-center gap-4 rounded-xl border bg-muted p-4">
      <div
        role="img"
        aria-label={`Sheet ${sheetIndex + 1} of ${sheetCount}: ${plural(used.length, 'tag')} on ${range}; this tag is card ${current + 1}`}
        data-slot="tag-sheet-map"
        className="grid w-[170px] flex-none grid-cols-2 gap-0.5 bg-white p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.15)]"
      >
        {slots.map((index, slot) => (
          <span
            key={slot}
            className={
              index === null
                ? 'flex h-[38px] flex-col rounded-[2px] border border-dashed border-[#9a9a9a] px-1 text-[9px] text-[#555]'
                : slot === current
                  ? 'flex h-[38px] flex-col rounded-[2px] border-2 border-black bg-black px-1 text-[9px] font-bold text-white'
                  : 'flex h-[38px] flex-col rounded-[2px] border-2 border-black px-1 text-[9px] font-bold text-black'
            }
          >
            {slot + 1}
            {index !== null ? (
              <span className="font-normal">L{chosen[index]!.lineNumbers.join(', L')}</span>
            ) : null}
          </span>
        ))}
      </div>
      <div className="grid gap-1 text-[13px]">
        <p className="font-semibold">On the sheet, scaled</p>
        <p className="text-muted-foreground">
          Sheet {sheetIndex + 1} of {sheetCount}: {plural(used.length, 'tag')} on {range}.
        </p>
      </div>
    </div>
  );
}

function TagChoices({
  tags,
  chosenCount,
  notSelected,
  overflowing,
  onToggle,
  onSplit,
  onSelectAll,
}: {
  tags: SampleTag[];
  chosenCount: number;
  notSelected: Set<string>;
  overflowing: Set<string>;
  onToggle: (key: string) => void;
  onSplit: (tag: SampleTag) => void;
  onSelectAll: (all: boolean) => void;
}) {
  return (
    <section aria-labelledby="tag-list-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 id="tag-list-heading" className="text-base font-semibold">
          Which tags
        </h2>
        <span className="text-sm text-muted-foreground">
          {chosenCount} of {tags.length} selected
        </span>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => onSelectAll(true)}>
          Select all
        </Button>
        <Button variant="outline" size="sm" onClick={() => onSelectAll(false)}>
          Select none
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <ItemGroup aria-label="Tags to print">
          {tags.map((tag) => {
            const id = `tag-${tag.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            return (
              <Item
                key={tag.key}
                role="listitem"
                size="sm"
                className="rounded-none border-b last:border-b-0"
              >
                <ItemMedia>
                  <Checkbox
                    id={id}
                    checked={!notSelected.has(tag.key)}
                    onCheckedChange={() => onToggle(tag.key)}
                    aria-label={`Print the tag for ${tag.sampleLabel} at ${tag.depth}, ${tag.source.label}, line ${tag.lineNumbers.join(', ')}`}
                  />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    <span className="font-mono text-[13px] font-semibold text-muted-foreground">
                      L{tag.lineNumbers.join(', L')}
                    </span>{' '}
                    <span className="font-mono font-semibold whitespace-nowrap">
                      {tag.source.label}
                    </span>{' '}
                    <span className="font-mono text-[13px]">
                      {tag.sampleLabel} · {tag.depth}
                    </span>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {tag.tests.map((test, i) => (
                      <span key={test.requestId}>
                        {i > 0 ? ', ' : ''}
                        {test.name} ({TEST_REQUEST_STATUS_LABEL[test.status].toLowerCase()})
                      </span>
                    ))}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {overflowing.has(tag.key) ? (
                    <Badge variant="outline">Text doesn’t fit</Badge>
                  ) : null}
                  {tag.tests.length > 1 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-link"
                      onClick={() => onSplit(tag)}
                    >
                      Split into {tag.tests.length} tags
                    </Button>
                  ) : null}
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      </div>
      <p className="text-[13px] text-muted-foreground">
        Only tests that need a tag are listed, and only tags with work still to do are ticked. Tests
        set to share a tag print on one card; Split prints them on separate cards.
      </p>
    </section>
  );
}

/**
 * The two "no tag" cases (Field Ledger "Sample tags"), always listed so nothing is silently
 * dropped: tests set to need no tag in the test list, and lines that name no single sample.
 */
function UntaggedNotes({ sheet }: { sheet: SampleTagSheet }) {
  return (
    <div className="grid gap-4 text-sm">
      <section aria-labelledby="no-tag-needed" className="grid gap-1">
        <h3 id="no-tag-needed" className="font-semibold">
          No tag needed
        </h3>
        <p className="text-[13px] text-muted-foreground">Set in the test list.</p>
        {sheet.noTagTests.length > 0 ? (
          <ul className="grid gap-0.5">
            {sheet.noTagTests.map((item) => (
              <li key={item.test.requestId}>
                Line {item.lineNumber} · {item.sampleLabel} · {item.depth}: {item.test.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">None on this program.</p>
        )}
      </section>
      <section aria-labelledby="no-individual-sample" className="grid gap-1">
        <h3 id="no-individual-sample" className="font-semibold">
          No individual sample
        </h3>
        {sheet.untaggedLines.length > 0 ? (
          <>
            <p className="text-[13px] text-muted-foreground">
              {LINE_SCOPE_LABEL.all}, grabs and SPT lines name no single sample, so no tag is
              printed for them.
            </p>
            <ul className="grid gap-0.5">
              {sheet.untaggedLines.map((item) => (
                <li key={item.lineNumber}>
                  Line {item.lineNumber} · {LINE_SCOPE_LABEL[item.scope]} · {item.sourceLabel}:{' '}
                  {item.tests.map((test) => test.name).join(', ')}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-muted-foreground">None on this program.</p>
        )}
      </section>
    </div>
  );
}
