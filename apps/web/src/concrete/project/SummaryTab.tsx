import {
  concreteReportFileUrl,
  type ConcreteSummaryFilters,
  type ConcreteSummaryReport,
  type ProjectDetail,
} from '@materialmule/shared';
import { Download, Eye, FileText } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DataTable, type DataTableColumn } from '../../components/strata/data-table';
import { PersonCell } from '../../components/strata/person-avatar';
import { LoadErrorAlert } from '../../projects/project-ui';
import {
  concreteProblem,
  fetchMixes,
  fetchSummaryReports,
  issueSummaryReport,
  summaryPreviewUrl,
} from './api';
import { ConcreteSection } from './ui';
import { useLoad } from './useLoad';

// MM-V2-C30 Summary sub-tab, completed by MM-V2-C32 (canvas R8ProjectSummary): cast-date range
// (default All dates) and filters; Preview opens the server's unnumbered PDF (never stored);
// Generate summary report issues it with the next CSR number, allocated by the server inside the
// issue transaction (`report.issue` on the project, checked by the server). Generated summaries
// open the stored file, exactly as issued; nothing here changes an issued file.

const WHO =
  'Only the project’s Lead Project Engineer or an Authorized report issuer can issue a summary report.';
const ALL_MIXES = 'all';

function datesText(filters: ConcreteSummaryReport['filters']): string {
  return filters.from || filters.to ? `${filters.from ?? '…'} – ${filters.to ?? '…'}` : 'All dates';
}

function filtersText(filters: ConcreteSummaryReport['filters']): string {
  return `${filters.element ?? 'All elements'} · ${filters.mixNumber ? `mix ${filters.mixNumber}` : 'all mixes'}`;
}

export function SummaryTab({ project }: { project: ProjectDetail }) {
  const id = useId();
  const [range, setRange] = useState<'all' | 'between'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [element, setElement] = useState('');
  const [mixId, setMixId] = useState(ALL_MIXES);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const { load, reload } = useLoad(`summaries|${project.id}`, () =>
    fetchSummaryReports(project.id),
  );
  const mixes = useLoad(`summary-mixes|${project.id}`, () => fetchMixes(project.id));

  const filters: ConcreteSummaryFilters = {
    from: range === 'between' && from ? from : null,
    to: range === 'between' && to ? to : null,
    element: element.trim() || null,
    mixId: mixId === ALL_MIXES ? null : mixId,
  };
  const rangeInvalid = filters.from !== null && filters.to !== null && filters.from > filters.to;
  const canIssue = load.state === 'ready' && load.data.canIssue;
  const chosenMix =
    mixes.load.state === 'ready'
      ? (mixes.load.data.items.find((m) => m.id === filters.mixId)?.mixNumber ?? null)
      : null;

  const columns = useMemo<DataTableColumn<ConcreteSummaryReport>[]>(
    () => [
      {
        id: 'number',
        header: 'Number',
        priority: 'identity',
        mono: true,
        width: '15ch',
        cell: (r) => (
          <Button
            variant="link"
            asChild
            className="h-auto p-0 font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid [&:hover]:underline"
          >
            <a
              href={concreteReportFileUrl(r.file.id)}
              target="_blank"
              rel="noopener"
              aria-label={`Open ${r.reportNumber} (PDF)`}
            >
              {r.reportNumber}
            </a>
          </Button>
        ),
      },
      {
        id: 'dates',
        header: 'Cast dates',
        priority: 'attribute',
        mono: true,
        hideOrder: 2,
        cell: (r) => datesText(r.filters),
      },
      {
        id: 'filters',
        header: 'Filters',
        priority: 'identity',
        wrap: true,
        cell: (r) => (
          <span className="flex flex-col">
            <span>{filtersText(r.filters)}</span>
            <span className="text-xs text-muted-foreground">
              {r.totals.sets} sets ({r.totals.pending} pending) · template {r.file.template.name}{' '}
              {r.file.template.revision}
              {r.file.template.provisional ? ' (provisional)' : ''}
            </span>
          </span>
        ),
      },
      {
        id: 'by',
        header: 'Generated by',
        priority: 'attribute',
        hideOrder: 3,
        cell: (r) => <PersonCell name={r.issuedBy.name} userId={r.issuedBy.userId} />,
      },
      {
        id: 'generated',
        header: 'Generated',
        priority: 'attribute',
        mono: true,
        width: '11ch',
        hideOrder: 1,
        cell: (r) => r.issuedAt.slice(0, 10),
      },
      {
        id: 'actions',
        header: <span className="sr-only">Actions</span>,
        priority: 'state',
        control: true,
        width: '8rem',
        cell: (r) => (
          <Button variant="ghost" size="sm" asChild>
            <a
              href={concreteReportFileUrl(r.file.id)}
              download
              aria-label={`Download ${r.reportNumber}`}
            >
              <Download aria-hidden="true" />
              Download
            </a>
          </Button>
        ),
      },
    ],
    [],
  );

  let issued: ReactNode;
  if (load.state === 'error') {
    issued = (
      <LoadErrorAlert
        title="Summary reports couldn't load"
        message={concreteProblem(load.error)}
        onRetry={reload}
      />
    );
  } else if (load.state === 'ready' && load.data.items.length === 0) {
    issued = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileText aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No summary report has been issued for this project.</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  } else {
    issued = (
      <DataTable
        columns={columns}
        data={load.state === 'ready' ? load.data.items : []}
        getRowId={(r) => r.id}
        rowLabel={(r) => r.reportNumber}
        caption={`Summary reports, ${project.projectNumber}`}
        loading={load.state === 'loading'}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <ConcreteSection id={`${id}-heading`} title="Summary report">
        <div className="flex max-w-3xl flex-col gap-4">
          <FieldSet>
            <FieldLegend variant="label">Cast dates</FieldLegend>
            <RadioGroup
              value={range}
              onValueChange={(next) => setRange(next === 'between' ? 'between' : 'all')}
              className="flex flex-wrap gap-6"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-all`} value="all" />
                <Label htmlFor={`${id}-all`} className="font-normal">
                  All dates
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-between`} value="between" />
                <Label htmlFor={`${id}-between`} className="font-normal">
                  Between dates
                </Label>
              </div>
            </RadioGroup>
            {range === 'between' ? (
              <div className="flex flex-wrap gap-4">
                <Field className="w-44">
                  <FieldLabel htmlFor={`${id}-from`}>From</FieldLabel>
                  <Input
                    id={`${id}-from`}
                    type="date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </Field>
                <Field className="w-44" data-invalid={rangeInvalid ? true : undefined}>
                  <FieldLabel htmlFor={`${id}-to`}>To</FieldLabel>
                  <Input
                    id={`${id}-to`}
                    type="date"
                    value={to}
                    min={from || undefined}
                    aria-invalid={rangeInvalid ? true : undefined}
                    onChange={(event) => setTo(event.target.value)}
                  />
                </Field>
              </div>
            ) : null}
            {rangeInvalid ? (
              <FieldError role="alert">The end date is before the start date.</FieldError>
            ) : null}
          </FieldSet>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${id}-element`}>Structure / element</FieldLabel>
              <Input
                id={`${id}-element`}
                value={element}
                maxLength={100}
                placeholder="All elements"
                onChange={(event) => setElement(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-mix`}>Mix</FieldLabel>
              <Select value={mixId} onValueChange={setMixId}>
                <SelectTrigger id={`${id}-mix`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_MIXES}>All mixes</SelectItem>
                  {mixes.load.state === 'ready'
                    ? mixes.load.data.items.map((mix) => (
                        <SelectItem key={mix.id} value={mix.id}>
                          {mix.supplierName} {mix.mixNumber}
                        </SelectItem>
                      ))
                    : null}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <FieldDescription>
            Field values come from each report’s latest issued version. Only issued strength results
            print; a tested age that isn’t issued yet reads “Pending review”; untested ages “—”.
            Summary template P1 is provisional (report templates are an open item).
          </FieldDescription>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 p-4">
            <p className="text-sm text-muted-foreground">
              Preview isn’t numbered or stored. Generating gives it the next CSR number and keeps
              the file.
            </p>
            <div className="flex flex-wrap gap-2">
              {rangeInvalid ? (
                <Button variant="outline" disabled aria-label="Preview summary report">
                  <Eye aria-hidden="true" />
                  Preview
                </Button>
              ) : (
                <Button variant="outline" asChild>
                  <a
                    href={summaryPreviewUrl(project.id, filters)}
                    target="_blank"
                    rel="noopener"
                    aria-label="Preview summary report"
                  >
                    <Eye aria-hidden="true" />
                    Preview
                  </a>
                </Button>
              )}
              <Button
                disabled={!canIssue || busy || rangeInvalid}
                aria-describedby={canIssue ? undefined : `${id}-who`}
                onClick={() => setConfirming(true)}
              >
                <FileText aria-hidden="true" />
                Generate summary report
              </Button>
            </div>
          </div>
          {load.state === 'ready' && !canIssue ? (
            <p id={`${id}-who`} className="text-[13px] text-muted-foreground">
              {WHO}
            </p>
          ) : null}
          {message ? (
            <p
              className={message.tone === 'ok' ? 'text-sm font-medium' : 'text-sm text-destructive'}
              role={message.tone === 'ok' ? 'status' : 'alert'}
            >
              {message.text}
            </p>
          ) : null}
        </div>
      </ConcreteSection>

      <section aria-labelledby={`${id}-issued`} className="flex min-w-0 flex-col gap-3">
        <h3 id={`${id}-issued`} className="text-base font-semibold">
          Generated for this project
        </h3>
        <div aria-busy={load.state === 'loading'} className="min-w-0">
          {issued}
        </div>
      </section>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Issue this summary report?</AlertDialogTitle>
            <AlertDialogDescription>
              It gets the next summary report number and the PDF is stored exactly as issued. It
              lists {datesText({ ...filters, mixNumber: chosenMix }).toLowerCase()},{' '}
              {filtersText({ ...filters, mixNumber: chosenMix })} for {project.projectNumber}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              onClick={() => {
                setConfirming(false);
                setBusy(true);
                setMessage(null);
                issueSummaryReport(project.id, filters)
                  .then((report) => {
                    setMessage({ tone: 'ok', text: `${report.reportNumber} issued.` });
                    reload();
                  })
                  .catch((caught: unknown) =>
                    setMessage({ tone: 'error', text: concreteProblem(caught) }),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Issue summary report
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
