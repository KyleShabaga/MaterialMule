import type { LabelPreview } from '@materialmule/shared';
import { ExternalLink, FileDown, ZoomIn } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { fetchLabelPreview, type PreviewResult } from './api';
import { LabelImage } from './LabelImage';
import { DISPOSED_NOTE, LabelPrintSteps } from './LabelPrintPage';
import './labels.css';
import { receiptPrintPath, unitPrintPath } from './print-paths';

/** A Strata card that is a labelled group (the unit page's Labels section has two). */
function GroupCard({
  id,
  title,
  meta,
  children,
}: {
  id?: string;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <Card id={id} role="group" aria-labelledby={headingId} className="min-w-0 gap-4 shadow-none">
      <CardHeader>
        <CardTitle>
          <h2 id={headingId} className="m-0 text-base font-semibold">
            {title}
          </h2>
        </CardTitle>
        {meta ? (
          <CardAction>
            <CardDescription className="font-mono text-xs">{meta}</CardDescription>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

/**
 * Preview label (MM-T39): the unit's sticker exactly as T14 lays it out, at true size with a zoom
 * toggle, its fit warnings, and a link to the print view for Print / Save as PDF. Read-only: no
 * print job, no label print recorded. The sticker is the server's SVG, never themed.
 *
 * `layout="dual"` (MM-T55, approved 2026-10-26) is the storage unit page's Labels section: a
 * "Preview label" card beside a "Print view" card with the print steps and one page per label.
 * The print view opens in a new tab. On a phone the print view stacks below.
 */
export function LabelPreviewPanel({
  storageUnit,
  receipt,
  openInNewTab = false,
  layout = 'plain',
  id,
}: {
  /** UUID or readable ID. */
  storageUnit: string;
  /** Offer the receipt-level print view when the receipt has more than one unit. */
  receipt?: { id: string; quantity: number };
  /** The receiving wizard opens print views in a new tab so its own state is kept. */
  openInNewTab?: boolean;
  layout?: 'plain' | 'dual';
  /** Anchor id for the dual layout's Preview label card. */
  id?: string;
}) {
  const [result, setResult] = useState<{
    key: string;
    value: PreviewResult<LabelPreview>;
  } | null>(null);
  const [reloads, setReloads] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const key = `${storageUnit}:${reloads}`;
  const dual = layout === 'dual';

  useEffect(() => {
    let cancelled = false;
    void fetchLabelPreview(storageUnit).then((value) => {
      if (!cancelled) setResult({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [storageUnit, key]);

  const newTab = openInNewTab || dual ? { target: '_blank', rel: 'noopener' } : {};
  const preview = result?.key === key && result.value.ok ? result.value.data : null;

  let body: ReactNode;
  if (!result || result.key !== key) {
    body = (
      <p aria-busy="true" className="text-muted-foreground m-0 text-sm">
        Loading label preview…
      </p>
    );
  } else if (!result.value.ok) {
    body = result.value.notFound ? (
      <p className="text-muted-foreground m-0 rounded-xl border border-dashed px-4 py-6 text-sm">
        No storage unit found, so there is no label to preview.
      </p>
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
  } else {
    const label = result.value.data;
    body = (
      <div className="label-preview flex flex-col gap-3">
        <div className="bg-muted flex flex-col items-center gap-2 rounded-xl border p-5">
          {/* MTR-128: zoomed, the label is wider than a phone and the frame scrolls, so it is a
              labelled region keyboard users can focus and scroll. */}
          <div
            className={`label-preview-frame${zoomed ? ' zoomed' : ''}`}
            {...(zoomed
              ? { role: 'region', 'aria-label': 'Label preview, scrolls sideways', tabIndex: 0 }
              : {})}
          >
            <LabelImage svg={label.svg} readableId={label.readableId} className="label-image" />
          </div>
          <p className="label-preview-size text-muted-foreground m-0 text-sm">
            <span className="label-preview-true-size">
              {zoomed ? 'Zoomed to twice the real size.' : 'Shown at the real size, 3.5 × 1.5 in.'}
            </span>
            <span className="label-preview-scaled">
              Scaled down to fit this screen, so not true size here. The PDF is true size.
            </span>
          </p>
        </div>
        {label.warnings.length > 0 ? (
          <div
            className={dual ? 'bg-stage-due-bg text-stage-due-fg rounded-lg px-4 py-3' : undefined}
          >
            {dual ? <h3 className="m-0 mb-1 text-sm font-semibold">Fit warnings</h3> : null}
            <ul aria-label="Fit warnings" className="text-stage-due-fg m-0 list-disc pl-5 text-sm">
              {label.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {label.disposed ? (
          // MTR-48: kept for reference only, watermarked DISPOSED by the server.
          <p className="text-muted-foreground m-0 text-sm">
            Shown for reference only. {DISPOSED_NOTE}
          </p>
        ) : (
          <p className="text-muted-foreground m-0 text-sm">
            Printer fonts may differ slightly; the ZD621 print is the final check.
            {dual ? null : ` Template ${label.templateVersion}.`}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={zoomed}
            onClick={() => setZoomed((z) => !z)}
          >
            <ZoomIn aria-hidden="true" />
            Zoom in
          </Button>
          {label.disposed ? null : (
            <Button asChild variant={dual ? 'default' : 'outline'} size="sm">
              <Link to={unitPrintPath(label.readableId)} {...newTab}>
                <FileDown aria-hidden="true" />
                Print / Save as PDF
                {dual ? <ExternalLink aria-hidden="true" /> : null}
              </Link>
            </Button>
          )}
          {receipt && receipt.quantity > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link to={receiptPrintPath(receipt.id, label.readableId)} {...newTab}>
                Print / Save all {receipt.quantity} labels of this receipt
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!dual) return body;

  return (
    <div className="labels-dual grid items-start gap-5 sm:grid-cols-2">
      <GroupCard
        id={id}
        title="Preview label"
        meta={preview ? `Template ${preview.templateVersion}` : undefined}
      >
        {body}
      </GroupCard>
      {preview?.disposed ? (
        <GroupCard title="Print view">
          <p className="m-0 text-sm">{DISPOSED_NOTE}</p>
        </GroupCard>
      ) : (
        <GroupCard title="Print view · 1 label" meta="Opens in a new tab">
          <LabelPrintSteps />
          <p className="text-muted-foreground m-0 text-sm">
            This doesn&apos;t count as a label print and creates no print job.
          </p>
          {preview ? (
            <div
              className="bg-muted flex flex-col gap-1.5 rounded-xl border p-4"
              aria-label="Pages in the print view"
            >
              <span className="text-muted-foreground font-mono text-xs">Page 1 of 1</span>
              <div className="label-page-thumb">
                <LabelImage
                  svg={preview.svg}
                  readableId={preview.readableId}
                  alt={`Page 1: label for storage unit ${preview.readableId}`}
                />
              </div>
            </div>
          ) : null}
        </GroupCard>
      )}
    </div>
  );
}
