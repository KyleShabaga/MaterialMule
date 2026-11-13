import { testTemplateSchema, type TestCatalogue, type TestTemplate } from '@materialmule/shared';
import { Info, Plus } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { DataTable, type DataTableColumn } from '@/components/strata/data-table';
import { PeekToolbar, peekNeighbours } from '@/components/strata/peek';
import { notifySuccess } from '@/components/strata/toast';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { catalogueWrite, type WriteResult } from '../../lab/api';
import { TestPicker } from '../../lab/TestPicker';
import { useMe } from '../../session/context';
import { SettingsPanel } from '../modal/SettingsPanel';
import {
  CATALOGUE_PERMISSION,
  LOAD_FAILED_TEXT,
  REFUSED_TEXT,
  fieldErrors,
  problem,
  useCatalogue,
  useTemplates,
} from './catalogue';
import { CatalogueFilters, CatalogueStatus, LoadFailed, LoadingRows, ProblemAlert } from './parts';

// Settings › Lab › Templates (MM-T23, STRATA-102; R9 board labtests-templates, drawer layout from
// R9TemplatesPanel): named sets of tests the program editor fills a line with. A wide modal
// panel: the main action, search and Include retired, the table, and a right sheet for one
// template (edit its tests, retire or restore). Lab Managers and administrators only.

const DESCRIPTION =
  'Named sets of tests the program editor fills a line with. Lab Managers and administrators change them.';
const NEW = 'new';

const COLUMNS: DataTableColumn<TestTemplate>[] = [
  {
    id: 'name',
    header: 'Template',
    priority: 'identity',
    width: '14rem',
    cell: (t) => <span className="truncate font-medium">{t.name}</span>,
  },
  {
    id: 'tests',
    header: 'Tests',
    priority: 'attribute',
    cell: (t) => (
      <span className="truncate text-muted-foreground">
        {t.items.map((item) => item.displayName).join(', ') || 'No tests yet'}
      </span>
    ),
  },
  {
    id: 'count',
    header: 'Count',
    priority: 'attribute',
    numeric: true,
    width: '4rem',
    hideBelow: '30rem',
    cell: (t) => t.items.length,
  },
  {
    id: 'status',
    header: 'Status',
    priority: 'state',
    width: '6.5rem',
    wrap: true,
    cell: (t) => <CatalogueStatus active={t.active} />,
  },
];

export function TemplatesPanel() {
  const me = useMe();
  if (!me.permissions.includes(CATALOGUE_PERMISSION)) {
    return (
      <SettingsPanel id="templates" title="Templates" wide>
        <Alert>
          <Info />
          <AlertTitle>{REFUSED_TEXT}</AlertTitle>
        </Alert>
      </SettingsPanel>
    );
  }
  return <Templates />;
}

function Templates() {
  const catalogue = useCatalogue();
  const templates = useTemplates();
  const [query, setQuery] = useState('');
  const [includeRetired, setIncludeRetired] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const ready =
    catalogue.load.state === 'ready' && templates.load.state === 'ready'
      ? { catalogue: catalogue.load.data, templates: templates.load.data }
      : null;
  const failed = catalogue.load.state === 'failed' || templates.load.state === 'failed';
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (ready?.templates ?? []).filter((t) => {
    if (!includeRetired && !t.active) return false;
    const haystack = `${t.name}\n${t.items.map((i) => `${i.code} ${i.displayName}`).join('\n')}`;
    return words.every((word) => haystack.toLowerCase().includes(word));
  });
  const open =
    ready && openId && openId !== NEW ? ready.templates.find((t) => t.id === openId) : undefined;
  const neighbours = peekNeighbours(
    shown.map((t) => t.id),
    open?.id ?? null,
  );

  const reloadAll = async () => {
    await Promise.all([catalogue.reload(), templates.reload()]);
  };
  async function run<T>(write: Promise<WriteResult<T>>, done: string) {
    const outcome = await write;
    await reloadAll();
    if (outcome.ok) notifySuccess(done);
    return outcome;
  }

  const retiredCount = (ready?.templates ?? []).filter((t) => !t.active).length;
  const sheetOpen = !!ready && (openId === NEW || open !== undefined);
  const title = openId === NEW ? 'Add a template' : (open?.name ?? 'Template');

  return (
    <SettingsPanel
      id="templates"
      title="Templates"
      description={DESCRIPTION}
      wide
      actions={
        <Button size="sm" disabled={!ready} onClick={() => setOpenId(NEW)}>
          <Plus aria-hidden="true" />
          Add a template
        </Button>
      }
    >
      <div className="grid gap-4">
        <CatalogueFilters
          id="templates"
          searchLabel="Search templates"
          placeholder="Name or test"
          query={query}
          onQueryChange={setQuery}
          includeRetired={includeRetired}
          onIncludeRetiredChange={setIncludeRetired}
          retiredCount={retiredCount}
        />
        {failed ? (
          <LoadFailed
            title={
              catalogue.load.state === 'failed'
                ? LOAD_FAILED_TEXT
                : 'The templates couldn’t be loaded.'
            }
            onRetry={() => {
              catalogue.retry();
              templates.retry();
            }}
          />
        ) : !ready ? (
          <LoadingRows label="Loading templates…" />
        ) : ready.templates.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No templates yet</EmptyTitle>
              <EmptyDescription>Add one to fill a testing line in one step.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : shown.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No template matches</EmptyTitle>
              <EmptyDescription>
                {includeRetired
                  ? 'Try other words.'
                  : 'Try other words, or include retired templates.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <DataTable
            caption="Templates"
            columns={COLUMNS}
            data={shown}
            getRowId={(t) => t.id}
            rowLabel={(t) => t.name}
            onOpenRow={(t) => setOpenId(t.id)}
            openRowId={open?.id ?? null}
          />
        )}
      </div>
      <Sheet open={sheetOpen} onOpenChange={(next) => (next ? undefined : setOpenId(null))}>
        <SheetContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-full gap-0 sm:max-w-lg"
        >
          {sheetOpen ? null : <SheetTitle className="sr-only">{title}</SheetTitle>}
          <PeekToolbar
            onClose={() => setOpenId(null)}
            showNavigation={!!open}
            position={open ? { index: neighbours.index, total: neighbours.total } : undefined}
            onPrevious={neighbours.previousId ? () => setOpenId(neighbours.previousId) : undefined}
            onNext={neighbours.nextId ? () => setOpenId(neighbours.nextId) : undefined}
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {ready && openId === NEW ? (
              <NewTemplate
                catalogue={ready.catalogue}
                onAdd={async (name, testTypeIds) => {
                  const outcome = await run(
                    catalogueWrite('/api/test-templates', 'POST', { name, testTypeIds }, (b) =>
                      testTemplateSchema.parse(b),
                    ),
                    `Added template ${name}.`,
                  );
                  if (outcome.ok) setOpenId(outcome.value.id);
                  return outcome;
                }}
              />
            ) : null}
            {ready && open ? (
              <TemplateDetail
                key={open.id}
                template={open}
                catalogue={ready.catalogue}
                onWrite={run}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </SettingsPanel>
  );
}

type RunWrite = <T>(write: Promise<WriteResult<T>>, done: string) => Promise<WriteResult<T>>;

function NewTemplate({
  catalogue,
  onAdd,
}: {
  catalogue: TestCatalogue;
  onAdd: (name: string, testTypeIds: string[]) => Promise<WriteResult<TestTemplate>>;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [tests, setTests] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setNameError(null);
    setError(null);
    const outcome = await onAdd(name, tests);
    setBusy(false);
    if (!outcome.ok) {
      setNameError(fieldErrors(outcome).name ?? null);
      setError(problem(outcome, ['name']));
    }
  }

  return (
    <article className="flex flex-col gap-5">
      <SheetTitle asChild>
        <h2 className="text-xl font-semibold tracking-tight">Add a template</h2>
      </SheetTitle>
      <form aria-label="Add a template" noValidate onSubmit={(event) => void submit(event)}>
        <FieldGroup className="gap-5">
          <Field data-invalid={nameError ? true : undefined}>
            <FieldLabel htmlFor={`${id}-name`}>Template name</FieldLabel>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={120}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${id}-name-error` : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {nameError ? <FieldError id={`${id}-name-error`}>{nameError}</FieldError> : null}
          </Field>
          <div className="grid gap-2">
            <h3 id={`${id}-tests`} className="text-sm font-semibold">
              Tests
            </h3>
            <TestPicker
              labelId={`${id}-tests`}
              catalogue={catalogue}
              templates={[]}
              selected={tests}
              onChange={setTests}
            />
          </div>
          {error ? <ProblemAlert>{error}</ProblemAlert> : null}
          <div>
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>
              Add template
            </Button>
          </div>
        </FieldGroup>
      </form>
    </article>
  );
}

function TemplateDetail({
  template,
  catalogue,
  onWrite,
}: {
  template: TestTemplate;
  catalogue: TestCatalogue;
  onWrite: RunWrite;
}) {
  const id = useId();
  const saved = template.items.map((item) => item.testTypeId);
  const [tests, setTests] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = tests.join() !== saved.join();

  async function act(write: Promise<WriteResult<TestTemplate>>, done: string) {
    setBusy(true);
    setError(null);
    const outcome = await onWrite(write, done);
    setBusy(false);
    if (!outcome.ok) setError(problem(outcome));
  }

  return (
    <article className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="text-[13px] text-muted-foreground">
            {template.items.length === 1 ? '1 test' : `${template.items.length} tests`}
          </p>
          <SheetTitle asChild>
            <h2 className="text-xl font-semibold tracking-tight break-words">{template.name}</h2>
          </SheetTitle>
        </div>
        <CatalogueStatus active={template.active} />
      </div>
      <div className="grid gap-2">
        <h3 id={`${id}-tests`} className="text-sm font-semibold">
          Tests
        </h3>
        <TestPicker
          labelId={`${id}-tests`}
          catalogue={catalogue}
          templates={[]}
          selected={tests}
          onChange={setTests}
        />
      </div>
      {error ? <ProblemAlert>{error}</ProblemAlert> : null}
      <div>
        <Button
          size="sm"
          disabled={busy || !changed}
          onClick={() =>
            void act(
              catalogueWrite(
                `/api/test-templates/${template.id}`,
                'PATCH',
                { version: template.version, testTypeIds: tests },
                (b) => testTemplateSchema.parse(b),
              ),
              `Saved ${template.name}.`,
            )
          }
        >
          Save tests
        </Button>
      </div>
      <Separator />
      <div className="grid gap-2">
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(
                catalogueWrite(
                  `/api/test-templates/${template.id}/${template.active ? 'retire' : 'restore'}`,
                  'POST',
                  { version: template.version },
                  (b) => testTemplateSchema.parse(b),
                ),
                `${template.active ? 'Retired' : 'Restored'} ${template.name}.`,
              )
            }
          >
            {template.active ? 'Retire' : 'Restore'}
          </Button>
        </div>
        <p className="text-[13px] text-muted-foreground">
          {template.active
            ? 'Retiring hides it from the program editor; programs already filled from it keep their tests.'
            : 'Retired. Restoring offers it in the program editor again.'}
        </p>
      </div>
    </article>
  );
}
