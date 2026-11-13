import type { LabelPreview } from '@materialmule/shared';
import { ChevronLeft, ChevronRight, Info, Package } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fetchLabelPreview, fetchReceiptLabelPreviews, type PreviewResult } from './api';
import { LabelImage } from './LabelImage';
import { LabelPrintForm } from './LabelPrintForm';
import { MAX_CHOSEN_LABELS } from './print-paths';
import './labels.css';

/**
 * Page size for Print → Save as PDF: one 3.5 × 1.5 in label per page, no margins. Rendered only
 * while the print view is open, so printing any other screen keeps the browser's paper size.
 * A fixed string: no user data is ever placed in it. Physical output: never restyle it.
 */
const PRINT_CSS = `
@page { size: 3.5in 1.5in; margin: 0; }
@media print {
  :root, html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  .label-print { margin: 0; padding: 0; max-width: none; }
  .label-print-instructions { display: none !important; }
  .label-sheet { display: block; margin: 0; padding: 0; }
  .label-page { width: 3.5in; height: 1.5in; margin: 0; padding: 0; border: 0; box-shadow: none;
    overflow: hidden; break-inside: avoid; break-after: page; }
  .label-page:last-child { break-after: auto; }
  .label-page img { display: block; width: 3.5in; height: 1.5in; }
}
`;

type Labels = PreviewResult<LabelPreview[]>;
type Scope = 'unit' | 'receipt' | 'units';

/** MTR-48 (MM-T77): a disposed unit's ID never gets a fresh sticker. */
export const DISPOSED_NOTE = 'This storage unit is disposed; its label is not printed again.';

/** The browser print settings for a true-size PDF; shared with the unit page's print view card. */
export function LabelPrintSteps() {
  return (
    <ol className="label-print-steps text-muted-foreground m-0 list-decimal pl-5 text-sm">
      <li>
        In the print dialog, set the scale to <strong>100% (Actual size)</strong>, not Fit to page.
        Margins: None.
      </li>
      <li>
        Each page is one 3.5 × 1.5 in label. Save as PDF, or print on 3.5 × 1.5 in label stock.
      </li>
    </ol>
  );
}

/** Readable IDs from `?ids=`, de-duplicated, at most MAX_CHOSEN_LABELS. */
function chosenIds(searchParams: URLSearchParams): string[] {
  const ids = (searchParams.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(ids)].slice(0, MAX_CHOSEN_LABELS);
}

async function loadChosen(ids: string[]): Promise<Labels> {
  const results = await Promise.all(ids.map((id) => fetchLabelPreview(id)));
  const failed = results.find((r) => !r.ok && !r.notFound);
  if (failed && !failed.ok) return failed;
  return { ok: true, data: results.flatMap((r) => (r.ok ? [r.data] : [])) };
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground rounded-xl border border-dashed px-4 py-6 text-sm">
      {children}
    </div>
  );
}

/**
 * Label printing (MM-T39, Strata STRATA-75): one label, every label of a receipt in order, or
 * units chosen on Inventory. Choose the labels, see the real sticker at true size, then Print to
 * a Zebra printer (a print job, recorded on each unit) or Save as PDF (the browser's print
 * dialog, one 3.5 × 1.5 in label per page; never a print job and never recorded as a print).
 *
 * Strata restyles the screen chrome only. The sticker (template-v1) is the server's SVG,
 * black on white in both themes, and the printed pages (`.label-sheet`, PRINT_CSS) are unchanged.
 * The route has no app chrome, so the browser prints the labels alone.
 */
export function LabelPrintPage({ scope }: { scope: Scope }) {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const ids = scope === 'units' ? chosenIds(searchParams) : [];
  const idsKey = ids.join(',');
  const key = `${scope}:${id}:${idsKey}`;
  const [reloads, setReloads] = useState(0);
  const [result, setResult] = useState<{ key: string; value: Labels } | null>(null);
  const loadKey = `${key}:${reloads}`;
  /** Labels left out of this print, by storage unit ID. */
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [previewIndex, setPreviewIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load: Promise<Labels> =
      scope === 'unit'
        ? fetchLabelPreview(id).then((r) => (r.ok ? { ok: true, data: [r.data] } : r))
        : scope === 'receipt'
          ? fetchReceiptLabelPreviews(id).then((r) =>
              r.ok ? { ok: true, data: r.data.labels } : r,
            )
          : loadChosen(idsKey === '' ? [] : idsKey.split(','));
    void load.then((value) => {
      if (!cancelled) setResult({ key: loadKey, value });
    });
    return () => {
      cancelled = true;
    };
  }, [scope, id, idsKey, loadKey]);

  const loaded = result?.key === loadKey && result.value.ok ? result.value.data : null;
  // MTR-48: disposed units are never printed; a receipt's print view names the ones it skips.
  const labels = loaded?.filter((label) => !label.disposed) ?? null;
  const disposed = loaded?.filter((label) => label.disposed) ?? [];
  const chosen = labels?.filter((label) => !skipped.has(label.storageUnitId)) ?? [];
  const shown = chosen[Math.min(previewIndex, chosen.length - 1)] ?? null;
  const shownIndex = shown ? chosen.indexOf(shown) : -1;
  // The unit to return to: the one shown, or for a receipt the unit it was opened from, if that
  // unit is on the receipt (MM-T61).
  const from = searchParams.get('from');
  const backUnit =
    scope === 'unit' ? loaded?.[0] : loaded?.find((label) => label.readableId === from);

  function toggle(storageUnitId: string, print: boolean) {
    setSkipped((current) => {
      const next = new Set(current);
      if (print) next.delete(storageUnitId);
      else next.add(storageUnitId);
      return next;
    });
  }

  let notice: ReactNode = null;
  if (!result || result.key !== loadKey) {
    notice = (
      <p aria-busy="true" className="text-muted-foreground m-0 text-sm">
        Loading labels…
      </p>
    );
  } else if (!result.value.ok) {
    notice = result.value.notFound ? (
      <Notice>
        {scope === 'unit'
          ? `No storage unit found with ID ${id}.`
          : scope === 'receipt'
            ? 'No receipt found.'
            : 'No storage units found.'}
      </Notice>
    ) : (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>{result.value.message}</span>
          <Button type="button" variant="outline" onClick={() => setReloads((n) => n + 1)}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (result.value.data.length === 0) {
    notice = (
      <Notice>
        {scope === 'receipt'
          ? 'This receipt has no storage units to label.'
          : 'No storage units were chosen to label.'}
      </Notice>
    );
  } else if (scope === 'unit' && disposed.length > 0) {
    notice = (
      <p role="status" className="m-0 text-sm">
        {DISPOSED_NOTE}
      </p>
    );
  } else if (disposed.length > 0) {
    notice = (
      <p role="status" className="text-muted-foreground m-0 text-sm">
        {labels!.length === 0
          ? `Every storage unit ${scope === 'receipt' ? 'on this receipt' : 'chosen'} is disposed, so no labels are printed. `
          : ''}
        Disposed units are not printed again: {disposed.map((label) => label.readableId).join(', ')}
        .
      </p>
    );
  }

  const many = scope !== 'unit' && (labels?.length ?? 0) !== 1;
  const pageName = many ? 'Print labels' : 'Print label';
  const printable = labels !== null && labels.length > 0;
  const summary = !printable
    ? null
    : scope === 'unit'
      ? `One label for ${labels[0]!.readableId}.`
      : scope === 'receipt'
        ? labels.length === 1
          ? `The label for the unit on this receipt.`
          : `Labels for the ${labels.length} units on this receipt.`
        : labels.length === 1
          ? 'The label for the unit you chose in Inventory.'
          : `Labels for the ${labels.length} units you chose in Inventory.`;
  const allChosen = labels !== null && chosen.length === labels.length;

  return (
    <main className="label-print">
      <style>{PRINT_CSS}</style>
      <div className="label-print-instructions @container mx-auto flex max-w-[1040px] flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/sample-storage">Inventory</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            {backUnit ? (
              <>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild className="font-mono whitespace-nowrap">
                    <Link to={`/sample-storage/${encodeURIComponent(backUnit.readableId)}`}>
                      {backUnit.readableId}
                    </Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </>
            ) : null}
            <BreadcrumbItem>
              <BreadcrumbPage>{pageName}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <header className="grid gap-1">
          <h1 id="label-print-heading" className="m-0 text-2xl font-semibold tracking-tight">
            {pageName}
          </h1>
          {summary ? <p className="text-muted-foreground m-0 text-sm">{summary}</p> : null}
        </header>

        {notice}

        {printable ? (
          <div className="grid items-start gap-8 @4xl:grid-cols-[minmax(0,1fr)_400px]">
            <div className="flex min-w-0 flex-col gap-6">
              <section aria-labelledby="labels-heading" className="flex flex-col gap-3">
                <div className="flex items-baseline justify-between gap-4">
                  <h2 id="labels-heading" className="m-0 text-base font-semibold">
                    Labels
                  </h2>
                  <span className="text-muted-foreground text-sm">
                    {labels.length === 1
                      ? '1 unit'
                      : `${chosen.length} of ${labels.length} units chosen`}
                  </span>
                </div>
                {labels.length === 1 ? (
                  <Item
                    variant="outline"
                    size="sm"
                    className="bg-card flex-nowrap gap-3 rounded-xl"
                  >
                    <ItemMedia className="text-muted-foreground">
                      <Package aria-hidden="true" />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="font-mono font-semibold whitespace-nowrap">
                        {labels[0]!.readableId}
                      </ItemTitle>
                      {labels[0]!.warnings.length > 0 ? (
                        <ItemDescription className="line-clamp-none">
                          {labels[0]!.warnings.join('. ')}.
                        </ItemDescription>
                      ) : null}
                    </ItemContent>
                  </Item>
                ) : (
                  <Card className="gap-0 overflow-hidden py-0 shadow-none">
                    <Table>
                      <TableCaption className="sr-only">Labels to choose</TableCaption>
                      <TableHeader>
                        <TableRow className="bg-muted hover:bg-muted">
                          <TableHead className="w-10 pl-4">
                            <Checkbox
                              aria-label={`Print all ${labels.length} labels`}
                              checked={
                                allChosen ? true : chosen.length === 0 ? false : 'indeterminate'
                              }
                              onCheckedChange={(checked) =>
                                setSkipped(
                                  checked === true
                                    ? new Set()
                                    : new Set(labels.map((label) => label.storageUnitId)),
                                )
                              }
                            />
                          </TableHead>
                          <TableHead>
                            {scope === 'receipt' ? 'All units on the receipt' : 'All chosen units'}
                          </TableHead>
                          <TableHead className="text-muted-foreground">Fit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {labels.map((label) => (
                          <TableRow key={label.storageUnitId}>
                            <TableCell className="pl-4">
                              <Checkbox
                                aria-label={`Print ${label.readableId}`}
                                checked={!skipped.has(label.storageUnitId)}
                                onCheckedChange={(checked) =>
                                  toggle(label.storageUnitId, checked === true)
                                }
                              />
                            </TableCell>
                            <TableCell className="font-mono font-semibold whitespace-nowrap">
                              {label.readableId}
                            </TableCell>
                            <TableCell className="text-muted-foreground whitespace-normal">
                              {label.warnings.length > 0 ? label.warnings.join('. ') : 'Fits'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                )}
                {scope === 'units' ? (
                  <Button asChild variant="link" className="h-auto self-start p-0">
                    <Link to="/sample-storage">Choose more in Inventory</Link>
                  </Button>
                ) : null}
              </section>

              <LabelPrintForm
                key={chosen.map((label) => label.storageUnitId).join(',')}
                chosen={chosen}
                onSavePdf={() => window.print()}
              />
              <LabelPrintSteps />
            </div>

            {/* True-size preview: 3.5 × 1.5 in. The sticker is the server's SVG, never themed. */}
            <aside aria-labelledby="preview-heading" className="flex min-w-0 flex-col gap-3">
              <div className="flex items-baseline justify-between gap-4">
                <h2 id="preview-heading" className="m-0 text-base font-semibold">
                  Preview
                </h2>
                <span className="text-muted-foreground text-sm">True size, 3.5 × 1.5 in</span>
              </div>
              <div className="bg-muted flex flex-col items-center gap-3 rounded-xl border px-6 py-8">
                {shown ? (
                  <LabelImage
                    svg={shown.svg}
                    readableId={shown.readableId}
                    className="label-true-size"
                  />
                ) : (
                  <p className="text-muted-foreground m-0 text-sm">No labels chosen.</p>
                )}
                {chosen.length > 1 ? (
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Previous label"
                      disabled={shownIndex <= 0}
                      onClick={() => setPreviewIndex(shownIndex - 1)}
                    >
                      <ChevronLeft aria-hidden="true" />
                    </Button>
                    <span
                      className="text-muted-foreground px-1 text-sm tabular-nums"
                      aria-live="polite"
                    >
                      {shownIndex + 1} of {chosen.length}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Next label"
                      disabled={shownIndex >= chosen.length - 1}
                      onClick={() => setPreviewIndex(shownIndex + 1)}
                    >
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </div>
                ) : null}
              </div>
              {shown && shown.warnings.length > 0 ? (
                <ul
                  aria-label="Fit warnings"
                  className="text-stage-due-fg m-0 list-disc pl-5 text-sm"
                >
                  {shown.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-muted-foreground m-0 flex items-start gap-2 text-sm">
                <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                Printing never changes the unit&apos;s ID or record. Printer fonts may differ
                slightly; the ZD621 print is the final check.
              </p>
            </aside>
          </div>
        ) : null}
      </div>

      {printable ? (
        // Exactly the pages that print: one .label-page per chosen label (physical output).
        // Hidden on screen; Save as PDF prints these alone.
        <div className="label-sheet" aria-label="Labels to print">
          {chosen.map((label) => (
            <div className="label-page" key={label.storageUnitId}>
              <LabelImage svg={label.svg} readableId={label.readableId} />
            </div>
          ))}
        </div>
      ) : null}
    </main>
  );
}
