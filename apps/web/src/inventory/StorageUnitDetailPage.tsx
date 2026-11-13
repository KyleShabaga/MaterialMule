import {
  SAMPLING_SOURCE_TYPE_LABEL,
  STORAGE_UNIT_RECORD_STATUS_STAGE,
  formatCoreRuns,
  formatDepth,
  formatPerson,
  samplingSourceName,
  type StorageUnitDetail,
} from '@materialmule/shared';
import { ArrowLeft, Lock, SearchX } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { LifecycleTrack, STORAGE_UNIT_STEPS } from '../components/strata/lifecycle-track';
import { PersonAvatar } from '../components/strata/person-avatar';
import { FEATURES } from '../features';
import { usePageTitle } from '../layout/page-title';
import { useRecordRecent } from '../layout/record-recent';
import { LocationConflictSection } from '../moves/LocationConflictSection';
import { LabelPreviewPanel } from '../printing/LabelPreviewPanel';
import { StorageUnitLabelsSection } from '../printing/StorageUnitLabelsSection';
import { UnitRetentionCard } from '../retention/RetentionSections';
import { useSession } from '../session/context';
import { fetchStorageUnit } from './api';
import { BulkSampleSection } from './BulkSampleSection';
import { CONFLICT_MESSAGE, CorrectionForm } from './CorrectionForm';
import './inventory.css';
import { TestedRemovalSection } from './TestedRemovalSection';
import { UnitMoreMenu, UnitPrimaryButton, UnitStatusTags } from './UnitActions';
import { UnitHistory } from './UnitHistory';
import { UnitLabelBlock } from './UnitLabelBlock';
import { UnitLabPrograms } from './UnitLabPrograms';
import {
  RecordBreadcrumb,
  RecordNotFound,
  UnitFact,
  UnitFacts,
  UnitSection,
} from './UnitRecordParts';
import { UnitWhere } from './UnitWhere';
import {
  holeSummaryCells,
  passedWithout,
  unitLifecycleStep,
  unitPrimaryAction,
  unitRecordStatus,
  unitTag,
  type UnitLinkState,
} from './unit-record';

type Loaded<T> =
  | { key: string; ok: true; data: T }
  | { key: string; ok: false; notFound: boolean; message: string };

/** Where the breadcrumb goes back to: the page the unit was opened from, else Inventory. */
function backTarget(state: unknown): { to: string; label: string } {
  const link = (state ?? {}) as UnitLinkState;
  if (link.backTo && link.backLabel) return { to: link.backTo, label: link.backLabel };
  return { to: `/sample-storage${link.from ?? ''}`, label: 'Inventory' };
}

/**
 * Storage unit page (STRATA-72, DESIGN.md › Storage unit record): the record pattern. The label
 * block, the record tag and lifecycle track, and one main action chosen by the stage lead; the
 * facts sit 2 : 1 beside a sticky History from a 56rem container (History drops under the facts
 * below that). A disposed unit is read-only: it keeps its ID and history, has no main action, and
 * can't be relabelled. Corrections stay enforced on the server.
 */
export function StorageUnitDetailPage() {
  return (
    <div className="unit-page @container min-w-0">
      <StorageUnitDetail />
    </div>
  );
}

function PageFrame({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6">{children}</div>;
}

function LoadingSkeleton({ readableId }: { readableId: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-6">
      <div className="grid gap-6 @min-[52rem]:grid-cols-[minmax(0,24rem)_1fr]">
        <Card className="gap-3 p-5 shadow-none">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-60" />
        </Card>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-36 rounded-full" />
          <Skeleton className="h-7 w-full rounded-full" />
          <div className="flex gap-2">
            <Skeleton className="h-11 w-28" />
            <Skeleton className="size-11" />
          </div>
        </div>
      </div>
      <div className="grid items-start gap-6 @min-[56rem]:grid-cols-3">
        <div className="flex flex-col gap-6 @min-[56rem]:col-span-2">
          {[0, 1, 2].map((n) => (
            <Card key={n} className="gap-3 p-5 shadow-none">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </Card>
          ))}
        </div>
        <Card className="gap-4 p-5 shadow-none">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </Card>
      </div>
      <p className="sr-only" role="status">
        Loading storage unit {readableId}
      </p>
    </div>
  );
}

function Notice({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <Alert role="status">
      {title ? <AlertTitle className="line-clamp-none">{title}</AlertTitle> : null}
      {children ? <AlertDescription>{children}</AlertDescription> : null}
    </Alert>
  );
}

function StorageUnitDetail() {
  const { readableId = '' } = useParams();
  usePageTitle(readableId);
  const location = useLocation();
  const back = backTarget(location.state);
  const [result, setResult] = useState<Loaded<StorageUnitDetail> | null>(null);
  const [reloads, setReloads] = useState(0);
  const { session } = useSession();
  const permissions = session.status === 'active' ? session.me.permissions : [];
  const canCorrect = permissions.includes('storage_unit.correct');
  // Confirming a conflicted unit's actual location: personal accounts only (MM-T28, D29).
  const canResolve = permissions.includes('location_conflict.resolve');
  // Removal after testing: personal accounts only, never LAB (MM-T36).
  const canRemoveTested = permissions.includes('storage_unit.tested_removal');
  const [removalNotice, setRemovalNotice] = useState<string | null>(null);
  const [resolvedNotice, setResolvedNotice] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correctionNotice, setCorrectionNotice] = useState<string | null>(null);
  const [corrected, setCorrected] = useState(false);
  /** Message after a bulk sample correction (MM-T36). */
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  // Correct replaces the page (canvas): focus its heading on open, the More button on close.
  const correctionHeading = useRef<HTMLHeadingElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [focusAfter, setFocusAfter] = useState<'form' | 'page' | null>(null);
  useEffect(() => {
    if (focusAfter === 'form') correctionHeading.current?.focus();
    if (focusAfter === 'page') moreButton.current?.focus();
  }, [focusAfter, correcting]);

  useEffect(() => {
    let cancelled = false;
    void fetchStorageUnit(readableId).then((response) => {
      if (cancelled) return;
      setResult(
        response.ok
          ? { key: readableId, ok: true, data: response.data }
          : { key: readableId, ...response },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [readableId, reloads]);
  useRecordRecent('storage_unit', result?.key === readableId && result.ok ? result.data.id : null);

  if (!result || result.key !== readableId) {
    return (
      <PageFrame>
        <RecordBreadcrumb back={back} current={readableId} />
        <LoadingSkeleton readableId={readableId} />
      </PageFrame>
    );
  }
  if (!result.ok) {
    return (
      <PageFrame>
        <RecordBreadcrumb back={back} current={readableId} />
        {result.notFound ? (
          <RecordNotFound
            icon={SearchX}
            title="No storage unit has this ID."
            code={readableId}
            description="Check the ID on the label, or scan it again."
            secondary={{ to: '/sample-storage', label: 'Go to Inventory' }}
          />
        ) : (
          <Alert variant="destructive">
            <AlertTitle className="line-clamp-none">{result.message}</AlertTitle>
            <AlertDescription>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 text-foreground"
                onClick={() => setReloads((count) => count + 1)}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </PageFrame>
    );
  }

  const unit = result.data;
  const disposed = unit.status === 'disposed';
  const status = unitRecordStatus(unit);
  const step = unitLifecycleStep(unit.lifecycleStep, status, unit.storageTerm);
  const tag = unitTag(status, step, Boolean(unit.testing?.removal));
  const action = unitPrimaryAction(status);
  const stage = unit.stage ?? STORAGE_UNIT_RECORD_STATUS_STAGE[status];

  function closeCorrection() {
    setCorrecting(false);
    setCorrectionNotice(null);
    setFocusAfter('page');
  }

  if (canCorrect && correcting) {
    return (
      <PageFrame>
        <div>
          <Button variant="ghost" size="sm" className="-ml-3" onClick={closeCorrection}>
            <ArrowLeft aria-hidden="true" />
            Back to {unit.readableId}
          </Button>
        </div>
        <div className="correction-page">
          <div>
            <h1
              id="correction-heading"
              ref={correctionHeading}
              tabIndex={-1}
              className="text-2xl font-semibold outline-none"
            >
              Correct details
            </h1>
            <p className="font-mono text-sm text-muted-foreground">{unit.readableId}</p>
          </div>
          <CorrectionForm
            // A newer version (e.g. after a conflict) starts the form again from the latest values.
            key={unit.version}
            unit={unit}
            notice={correctionNotice}
            onSaved={(saved) => {
              setResult({ key: readableId, ok: true, data: saved });
              setCorrected(true);
              setHistoryVersion((count) => count + 1);
              closeCorrection();
            }}
            onConflict={() => {
              setCorrectionNotice(CONFLICT_MESSAGE);
              setReloads((count) => count + 1);
              setHistoryVersion((count) => count + 1);
            }}
            onCancel={closeCorrection}
          />
        </div>
      </PageFrame>
    );
  }

  const receiverDiffers =
    unit.receipt.account.name !== unit.receipt.receiver.name ||
    unit.receipt.account.initials !== unit.receipt.receiver.initials;

  return (
    <PageFrame>
      <RecordBreadcrumb back={back} current={unit.readableId} />

      {/* Header: the label block left; tag, track and actions right (two columns from 52rem). */}
      <header className="grid items-stretch gap-6 @min-[52rem]:grid-cols-[minmax(0,24rem)_1fr]">
        <UnitLabelBlock unit={unit} stage={stage} />
        <div className="flex min-w-0 flex-col justify-center gap-4">
          <UnitStatusTags tag={tag} conflict={Boolean(unit.locationConflict)} />
          <LifecycleTrack
            steps={STORAGE_UNIT_STEPS}
            current={step}
            passedWithout={passedWithout(step, unit.neverTested)}
            label={`Lifecycle of ${unit.readableId}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <UnitPrimaryButton unit={unit} action={action} />
            {disposed ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Lock aria-hidden="true" className="size-4" />
                Read-only. Disposed units keep their ID and history.
              </p>
            ) : null}
            <UnitMoreMenu
              unit={unit}
              canCorrect={canCorrect}
              triggerRef={moreButton}
              onCorrect={() => {
                setCorrectionNotice(null);
                setCorrected(false);
                setCorrecting(true);
                setFocusAfter('form');
              }}
            />
          </div>
        </div>
      </header>

      {corrected ? (
        <Notice title="Details corrected.">
          Printed labels show the values at print time. Reprint if the label is now wrong.
        </Notice>
      ) : null}
      {resolvedNotice ? (
        <Notice title="Location confirmed.">
          Both moves and your confirmation are in the history.
        </Notice>
      ) : null}
      {removalNotice ? <Notice title={removalNotice} /> : null}
      {bulkNotice ? <Notice title={bulkNotice} /> : null}

      {/* Body 2 : 1 from a 56rem container; History drops under the facts below that. */}
      <div className="grid items-start gap-6 @min-[56rem]:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 @min-[56rem]:col-span-2">
          <UnitWhere unit={unit} />

          {unit.locationConflict ? (
            <LocationConflictSection
              key={`${unit.locationConflict.id}-${unit.locationConflict.version}`}
              conflictId={unit.locationConflict.id}
              canResolve={canResolve}
              onResolved={() => {
                setResolvedNotice(true);
                setHistoryVersion((count) => count + 1);
                setReloads((count) => count + 1);
              }}
            />
          ) : null}

          <ContentsSection unit={unit} />

          <UnitSection id="receipt" title="Receipt">
            <UnitFacts>
              <UnitFact term="Receipt">
                <Button asChild variant="link" className="h-auto p-0">
                  <Link to={`/receiving-log/${encodeURIComponent(unit.receipt.id)}`}>
                    Receipt <span className="font-mono">{unit.receipt.receivedDate}</span> ·{' '}
                    {unit.receipt.quantity} {unit.receipt.quantity === 1 ? 'unit' : 'units'}
                  </Link>
                </Button>
              </UnitFact>
              <UnitFact term="Received">
                <span className="font-mono whitespace-nowrap">{unit.receivedDate}</span>
                {unit.receivedDate !== unit.receipt.receivedDate ? (
                  <span className="text-muted-foreground"> (corrected)</span>
                ) : null}
              </UnitFact>
              <UnitFact term="Received by">
                <span className="flex min-w-0 items-center gap-2">
                  <PersonAvatar name={unit.receipt.receiver.name} size="compact" />
                  <span className="truncate">
                    {formatPerson(unit.receipt.receiver.initials, unit.receipt.receiver.name)}
                  </span>
                </span>
              </UnitFact>
              {receiverDiffers ? (
                <UnitFact term="Entered">
                  Entered by {unit.receipt.account.name}, for {unit.receipt.receiver.name}
                </UnitFact>
              ) : null}
              {unit.receipt.description ? (
                <UnitFact term="Description">{unit.receipt.description}</UnitFact>
              ) : null}
            </UnitFacts>
            <p className="text-[13px] text-muted-foreground">
              As recorded at confirmation; corrections never change it.
            </p>
          </UnitSection>

          <UnitRetentionCard
            key={`retention-${unit.version}`}
            unitId={unit.id}
            unitType={unit.unitType}
            disposed={disposed}
          />

          {FEATURES.labTesting ? <UnitLabPrograms unitId={unit.id} /> : null}

          {unit.bulkGroup ? (
            <BulkSampleSection
              // A correction elsewhere (or a conflict reload) starts the section afresh.
              key={`${unit.version}-${unit.bulkGroup.version}`}
              unit={unit}
              canCorrect={canCorrect}
              onChanged={(changed, message) => {
                setResult({ key: readableId, ok: true, data: changed });
                setBulkNotice(message);
                setHistoryVersion((count) => count + 1);
              }}
            />
          ) : null}

          {unit.testing ? (
            <TestedRemovalSection
              key={unit.version}
              unit={unit}
              testing={unit.testing}
              canRemove={canRemoveTested}
              onRemoved={(message) => {
                setRemovalNotice(message);
                setHistoryVersion((count) => count + 1);
                setReloads((count) => count + 1);
              }}
              onStale={() => setReloads((count) => count + 1)}
            />
          ) : null}

          {/* The label preview and print history stay on the page until the label print view
              takes them over; printing never changes the unit. */}
          <div className="unit-below">
            <LabelPreviewPanel
              // A correction (T13) bumps the version; the label shows the corrected details.
              key={`label-preview-${unit.version}`}
              layout="dual"
              id="label-preview"
              storageUnit={unit.readableId}
              receipt={{ id: unit.receipt.id, quantity: unit.receipt.quantity }}
            />
            <StorageUnitLabelsSection readableId={unit.readableId} disposed={disposed} />
          </div>
        </div>

        <UnitHistory
          storageUnitId={unit.id}
          refresh={historyVersion}
          disposed={disposed}
          className="@min-[56rem]:sticky @min-[56rem]:top-6"
        />
      </div>
    </PageFrame>
  );
}

/**
 * What the unit holds: per test hole one SAMPLE#/DEPTH summary (never individual samples), or a
 * Shelby tube's own sampling source; plus core runs and the unit note.
 */
function ContentsSection({ unit }: { unit: StorageUnitDetail }) {
  if (unit.sample) {
    const sample = unit.sample;
    return (
      <UnitSection id="summaries" title="Sample">
        <UnitFacts wide>
          {/* MM-T36: where the material came from (never its storage location). */}
          <UnitFact term="Sampling source">
            {samplingSourceName(sample.source)}{' '}
            <span className="text-muted-foreground">
              ({SAMPLING_SOURCE_TYPE_LABEL[sample.source.type]})
            </span>
          </UnitFact>
          <UnitFact term="Sample reference">
            <span className="font-mono">{sample.sampleReference ?? 'None'}</span>
          </UnitFact>
          <UnitFact term="Depth">
            <span className="font-mono">
              {formatDepth(sample.depthFrom, sample.depthTo, sample.depthUnit) || 'None'}
            </span>
          </UnitFact>
          <UnitFact term="Storage unit note">{unit.note ?? 'None'}</UnitFact>
        </UnitFacts>
      </UnitSection>
    );
  }
  const count = unit.holes.length;
  const anyNote = unit.holes.some((hole) => hole.note);
  return (
    <UnitSection
      id="summaries"
      title="Test hole summaries"
      meta={`${count} ${count === 1 ? 'test hole' : 'test holes'}`}
      className="gap-3 overflow-hidden pt-5 pb-0 shadow-none"
    >
      <Table className="text-sm">
        <TableCaption className="sr-only">Test hole summaries</TableCaption>
        <TableHeader className="bg-muted">
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-5 text-[13px] font-semibold text-muted-foreground">
              Test hole
            </TableHead>
            <TableHead className="text-[13px] font-semibold text-muted-foreground">
              Samples
            </TableHead>
            <TableHead className="text-[13px] font-semibold text-muted-foreground">Depth</TableHead>
            {anyNote ? (
              <TableHead className="pr-5 text-[13px] font-semibold text-muted-foreground">
                Note
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {unit.holes.map((hole) => {
            const cells = holeSummaryCells(hole);
            return (
              <TableRow key={hole.testHoleId} className="hover:bg-transparent">
                <TableCell className="pl-5 font-mono font-semibold">{hole.testHoleName}</TableCell>
                <TableCell className="font-mono">{cells.samples || '—'}</TableCell>
                <TableCell className="font-mono whitespace-nowrap">{cells.depth || '—'}</TableCell>
                {anyNote ? (
                  <TableCell className="pr-5 whitespace-normal">{hole.note ?? ''}</TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <div className="flex flex-col gap-1 px-5 pb-4 text-sm">
        {unit.coreRunCount ? <p>Core runs: {formatCoreRuns(unit.coreRunCount)}</p> : null}
        <p>
          <span className="text-muted-foreground">Storage unit note: </span>
          {unit.note ?? 'None'}
        </p>
      </div>
    </UnitSection>
  );
}
