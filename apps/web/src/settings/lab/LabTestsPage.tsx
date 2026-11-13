import {
  SAMPLE_TAG_MODE_LABEL,
  searchTests,
  testDisplayName,
  testGroupPath,
  testGroupSchema,
  testSubgroupSchema,
  testTypeSchema,
  type TestCatalogue,
  type TestType,
} from '@materialmule/shared';
import { FolderTree, Info, Plus } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { DataTable, type DataTableColumn } from '@/components/strata/data-table';
import {
  PeekSplit,
  PeekToolbar,
  peekNeighbours,
  usePeekAvailable,
  usePeekKeys,
  usePeekParam,
} from '@/components/strata/peek';
import { notifySuccess } from '@/components/strata/toast';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { catalogueWrite, type WriteResult } from '../../lab/api';
import { useMe } from '../../session/context';
import {
  CATALOGUE_PERMISSION,
  LOAD_FAILED_TEXT,
  REFUSED_TEXT,
  problem,
  useCatalogue,
  type WriteFailure,
} from './catalogue';
import { CatalogueFilters, CatalogueStatus, LoadFailed, LoadingRows, ProblemAlert } from './parts';
import { TestForm, type TestBody } from './TestForm';

// Lab admin › Lab tests (/admin/lab-tests; MM-T23, MM-T69, STRATA-128; R9 board labtests-*).
// AdminLayout draws the tabs, the h1 and the description; this is the page's main action, the
// tools, the catalogue grouped by group and subgroup (unpaged), and the right drawer for one test
// (`?open=<id>`; `new` adds a test, `groups` adds groups and subgroups). Under 1024 px the drawer
// is a sheet. Lab Managers and administrators only (`test_catalog.manage`); the server checks
// every write.

const NEW = 'new';
const GROUPS = 'groups';
const DRAWER_TITLE = 'lab-test-drawer-title';

function tagText(test: TestType): string {
  return test.sampleTagMode === 'shared'
    ? `Shared: ${test.sampleTagGroup ?? ''}`
    : SAMPLE_TAG_MODE_LABEL[test.sampleTagMode];
}

const COLUMNS: DataTableColumn<TestType>[] = [
  {
    id: 'code',
    header: 'Code',
    priority: 'identity',
    mono: true,
    width: '14ch',
    cell: (test) => test.code,
  },
  {
    id: 'test',
    header: 'Test',
    priority: 'identity',
    cell: (test) => (
      <span className="grid min-w-0">
        <span className="truncate font-medium">{testDisplayName(test)}</span>
        {test.name ? (
          <span className="truncate text-[13px] text-muted-foreground">{test.description}</span>
        ) : null}
      </span>
    ),
  },
  {
    id: 'tag',
    header: 'Sample ID tag',
    priority: 'attribute',
    width: '11rem',
    hideOrder: 1,
    cell: tagText,
  },
  {
    id: 'status',
    header: 'Status',
    priority: 'state',
    width: '6.5rem',
    wrap: true,
    cell: (test) => <CatalogueStatus active={test.active} />,
  },
];

interface Section {
  key: string;
  title: string;
  tests: TestType[];
}

/** Catalogue order: each group, then its subgroups; tests in the server's order. */
function sections(catalogue: TestCatalogue, tests: TestType[]): Section[] {
  return catalogue.groups.flatMap((group) =>
    [null, ...group.subgroups].map((subgroup) => ({
      key: subgroup ? `${group.id}:${subgroup.id}` : group.id,
      title: testGroupPath(group.name, subgroup?.name ?? null),
      tests: tests.filter(
        (test) => test.groupId === group.id && test.subgroupId === (subgroup?.id ?? null),
      ),
    })),
  );
}

/** Lab tests page body (the old Settings › Tests). */
export function LabTestsPage() {
  const me = useMe();
  if (!me.permissions.includes(CATALOGUE_PERMISSION)) {
    return (
      <Alert>
        <Info />
        <AlertTitle>{REFUSED_TEXT}</AlertTitle>
      </Alert>
    );
  }
  return <LabTests />;
}

function LabTests() {
  const { load, reload, retry } = useCatalogue();
  const peek = usePeekParam();
  const wide = usePeekAvailable();
  const [query, setQuery] = useState('');
  const [includeRetired, setIncludeRetired] = useState(false);

  const catalogue = load.state === 'ready' ? load.data : null;
  const shown = catalogue
    ? searchTests(
        catalogue.tests.filter((test) => includeRetired || test.active),
        query,
      )
    : [];
  const groups = catalogue ? sections(catalogue, shown).filter((s) => s.tests.length > 0) : [];
  const order = groups.flatMap((s) => s.tests.map((test) => test.id));
  const openTest =
    catalogue && peek.openId ? catalogue.tests.find((test) => test.id === peek.openId) : undefined;
  const drawerOpen =
    !!catalogue && (peek.openId === NEW || peek.openId === GROUPS || openTest !== undefined);
  const neighbours = peekNeighbours(order, openTest ? openTest.id : null);
  const previous = neighbours.previousId;
  const next = neighbours.nextId;

  usePeekKeys({
    enabled: wide && drawerOpen,
    onClose: peek.close,
    onPrevious: previous ? () => peek.open(previous) : undefined,
    onNext: next ? () => peek.open(next) : undefined,
  });

  /** Runs a write, reloads the catalogue, and toasts the success. */
  async function run<T>(write: Promise<WriteResult<T>>, done: (value: T) => string) {
    const outcome = await write;
    await reload();
    if (outcome.ok) notifySuccess(done(outcome.value));
    return outcome;
  }

  let drawer: { title: string; body: ReactNode } | null = null;
  if (catalogue && peek.openId === NEW) {
    drawer = {
      title: 'Add a test',
      body: (
        <TestForm
          catalogue={catalogue}
          test={null}
          onSubmit={async (body) => {
            const outcome = await run(
              catalogueWrite('/api/test-types', 'POST', body, (b) => testTypeSchema.parse(b)),
              () => `Added ${body.code}.`,
            );
            if (!outcome.ok) return outcome;
            peek.open(outcome.value.id, { replace: true });
            return null;
          }}
        />
      ),
    };
  } else if (catalogue && peek.openId === GROUPS) {
    drawer = {
      title: 'Groups and subgroups',
      body: <GroupForms catalogue={catalogue} onWrite={run} />,
    };
  } else if (catalogue && openTest) {
    drawer = {
      title: testDisplayName(openTest),
      body: <TestDetail catalogue={catalogue} test={openTest} onWrite={run} />,
    };
  }

  const toolbar = (
    <PeekToolbar
      onClose={peek.close}
      position={openTest ? { index: neighbours.index, total: neighbours.total } : undefined}
      showNavigation={!!openTest}
      onPrevious={previous ? () => peek.open(previous) : undefined}
      onNext={next ? () => peek.open(next) : undefined}
    />
  );
  const drawerBody = (inSheet: boolean) =>
    drawer ? (
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <article className="flex flex-col gap-5">
          <DrawerHeading
            sheet={inSheet}
            title={drawer.title}
            test={peek.openId === NEW || peek.openId === GROUPS ? undefined : openTest}
          />
          {drawer.body}
        </article>
      </div>
    ) : null;

  let list: ReactNode;
  if (load.state === 'loading') list = <LoadingRows label="Loading the catalogue…" />;
  else if (load.state === 'failed') list = <LoadFailed title={LOAD_FAILED_TEXT} onRetry={retry} />;
  else if (catalogue!.tests.length === 0) {
    list = (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No tests yet</EmptyTitle>
          <EmptyDescription>
            The catalogue is filled from the verified lab workbook.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (groups.length === 0) {
    list = (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No test matches</EmptyTitle>
          <EmptyDescription>
            {includeRetired ? 'Try other words.' : 'Try other words, or include retired tests.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    list = (
      <div className="grid gap-6 pb-6">
        {groups.map((section) => (
          <section
            key={section.key}
            aria-labelledby={`lab-tests-${section.key}`}
            className="grid gap-2"
          >
            <div className="flex items-baseline gap-2">
              <h2 id={`lab-tests-${section.key}`} className="text-sm font-semibold">
                {section.title}
              </h2>
              <span className="text-[13px] text-muted-foreground">
                {section.tests.length === 1 ? '1 test' : `${section.tests.length} tests`}
              </span>
            </div>
            <DataTable
              caption={section.title}
              columns={COLUMNS}
              data={section.tests}
              getRowId={(test) => test.id}
              rowLabel={(test) => test.code}
              onOpenRow={(test) => peek.open(test.id)}
              openRowId={openTest?.id ?? null}
            />
          </section>
        ))}
      </div>
    );
  }

  const retiredCount = catalogue ? catalogue.tests.filter((test) => !test.active).length : 0;

  return (
    <div className="flex h-full min-h-[28rem] flex-col gap-4" data-lab-tests>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CatalogueFilters
          id="lab-tests"
          searchLabel="Search tests"
          placeholder="Code, name or description"
          query={query}
          onQueryChange={setQuery}
          includeRetired={includeRetired}
          onIncludeRetiredChange={setIncludeRetired}
          retiredCount={retiredCount}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!catalogue}
            onClick={() => peek.open(GROUPS)}
          >
            <FolderTree aria-hidden="true" />
            Groups and subgroups
          </Button>
          <Button size="sm" disabled={!catalogue} onClick={() => peek.open(NEW)}>
            <Plus aria-hidden="true" />
            Add test
          </Button>
        </div>
      </div>
      {wide ? (
        <PeekSplit
          className="flex-1"
          list={list}
          open={drawerOpen}
          openId={peek.openId}
          defaultSize="46%"
          minSize="36%"
          maxSize="65%"
          drawerLabelledBy={DRAWER_TITLE}
          listLabel="Lab tests"
          drawer={
            <>
              {toolbar}
              {drawerBody(false)}
            </>
          }
        />
      ) : (
        <>
          <div aria-label="Lab tests" role="group">
            {list}
          </div>
          <Sheet open={drawerOpen} onOpenChange={(open) => (open ? undefined : peek.close())}>
            <SheetContent
              showCloseButton={false}
              aria-describedby={undefined}
              className="w-full gap-0 sm:max-w-md"
            >
              {drawer ? null : <SheetTitle className="sr-only">Lab test</SheetTitle>}
              {toolbar}
              {drawerBody(true)}
            </SheetContent>
          </Sheet>
        </>
      )}
    </div>
  );
}

function DrawerHeading({
  title,
  test,
  sheet,
}: {
  title: string;
  test?: TestType;
  /** In the narrow-screen sheet the heading is also the dialog's title. */
  sheet: boolean;
}) {
  const heading = (
    <h2 id={DRAWER_TITLE} className="text-xl font-semibold tracking-tight break-words">
      {title}
    </h2>
  );
  return (
    <div className="flex items-start gap-3">
      <div className="grid min-w-0 flex-1 gap-1">
        {test ? (
          <p className="text-[13px] text-muted-foreground">
            {testGroupPath(test.groupName, test.subgroupName)} ·{' '}
            <span className="font-mono">{test.code}</span>
          </p>
        ) : null}
        {sheet ? <SheetTitle asChild>{heading}</SheetTitle> : heading}
      </div>
      {test ? <CatalogueStatus active={test.active} /> : null}
    </div>
  );
}

type RunWrite = <T>(
  write: Promise<WriteResult<T>>,
  done: (value: T) => string,
) => Promise<WriteResult<T>>;

function TestDetail({
  catalogue,
  test,
  onWrite,
}: {
  catalogue: TestCatalogue;
  test: TestType;
  onWrite: RunWrite;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retireOrRestore() {
    setBusy(true);
    setError(null);
    const action = test.active ? 'retire' : 'restore';
    const outcome = await onWrite(
      catalogueWrite(
        `/api/test-types/${test.id}/${action}`,
        'POST',
        { version: test.version },
        (b) => testTypeSchema.parse(b),
      ),
      () => `${test.active ? 'Retired' : 'Restored'} ${test.code}.`,
    );
    setBusy(false);
    if (!outcome.ok) setError(problem(outcome));
  }

  return (
    <>
      {/* Keyed by test only: after a conflict the person's input stays and the next save uses
          the refreshed version. */}
      <TestForm
        key={test.id}
        catalogue={catalogue}
        test={test}
        onSubmit={async (body: TestBody): Promise<WriteFailure | null> => {
          const outcome = await onWrite(
            catalogueWrite(
              `/api/test-types/${test.id}`,
              'PATCH',
              { version: test.version, ...body },
              (b) => testTypeSchema.parse(b),
            ),
            () => `Saved ${body.code}.`,
          );
          return outcome.ok ? null : outcome;
        }}
      />
      <Separator />
      <div className="grid gap-2">
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void retireOrRestore()}
          >
            {test.active ? 'Retire' : 'Restore'}
          </Button>
        </div>
        <p className="text-[13px] text-muted-foreground">
          {test.active
            ? 'Retiring hides it from new programs and templates; submitted requests keep it as it was.'
            : 'Retired. Restoring offers it in new programs again.'}
        </p>
        {error ? <ProblemAlert>{error}</ProblemAlert> : null}
      </div>
    </>
  );
}

function GroupForms({ catalogue, onWrite }: { catalogue: TestCatalogue; onWrite: RunWrite }) {
  const id = useId();
  const [groupName, setGroupName] = useState('');
  const [subgroupName, setSubgroupName] = useState('');
  const [parent, setParent] = useState(catalogue.groups[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  async function addGroup(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const name = groupName;
    const outcome = await onWrite(
      catalogueWrite('/api/test-groups', 'POST', { name }, (b) => testGroupSchema.parse(b)),
      () => `Added group ${name}.`,
    );
    if (outcome.ok) setGroupName('');
    else setError(problem(outcome));
  }
  async function addSubgroup(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const name = subgroupName;
    const outcome = await onWrite(
      catalogueWrite('/api/test-subgroups', 'POST', { groupId: parent, name }, (b) =>
        testSubgroupSchema.parse(b),
      ),
      () => `Added subgroup ${name}.`,
    );
    if (outcome.ok) setSubgroupName('');
    else setError(problem(outcome));
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Groups and subgroups sort the catalogue here and in the program editor’s test search.
      </p>
      <form aria-label="Add a subgroup" onSubmit={(event) => void addSubgroup(event)}>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor={`${id}-parent`}>Group</FieldLabel>
            <Select value={parent} onValueChange={setParent}>
              <SelectTrigger id={`${id}-parent`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {catalogue.groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-subgroup`}>New subgroup</FieldLabel>
            <Input
              id={`${id}-subgroup`}
              value={subgroupName}
              onChange={(e) => setSubgroupName(e.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" size="sm" disabled={!subgroupName.trim() || !parent}>
              Add subgroup
            </Button>
          </div>
        </FieldGroup>
      </form>
      <Separator />
      <form aria-label="Add a group" onSubmit={(event) => void addGroup(event)}>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor={`${id}-group`}>New group</FieldLabel>
            <Input
              id={`${id}-group`}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" size="sm" disabled={!groupName.trim()}>
              Add group
            </Button>
          </div>
        </FieldGroup>
      </form>
      {error ? <ProblemAlert>{error}</ProblemAlert> : null}
    </>
  );
}
