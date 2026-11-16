import {
  applyTemplate,
  formatReceiver,
  type LabProgram,
  type LabSource,
  type ReceiverOption,
  type TestCatalogue,
  type TestTemplate,
  type TestTemplateItem,
} from '@materialmule/shared';
import {
  CloudAlert,
  CloudCheck,
  EllipsisVertical,
  LayoutGrid,
  LayoutTemplate,
  List,
  LoaderCircle,
  RotateCw,
  ShieldX,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { PersonAvatar } from '@/components/strata/person-avatar';
import { StageTag } from '@/components/strata/stage-tag';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ReceiverSelect } from '../components/ReceiverSelect';
import { useMe } from '../session/context';
import {
  createProgram,
  discardProgram,
  fetchCatalogue,
  fetchSources,
  fetchSourceUnits,
  fetchTemplates,
  submitProgram,
  type WriteResult,
} from './api';
import { useDraftSaver, type SaveStatus } from './editor/draft-saver';
import { GridView } from './editor/GridView';
import { LinesView } from './editor/LinesView';
import { ProjectChooser, type ChosenProject } from './editor/ProjectChooser';
import {
  countsText,
  editReducer,
  initialEditState,
  programProblems,
  type EditorProblem,
} from './editor/program-state';
import { SubmitBar } from './editor/SubmitBar';
import { emptyLine, linesFromProgram, toInput, type LineDraft } from './line-draft';
import { RetiredFromTemplate } from './TestPicker';

// Lab program editor (STRATA-86; MM-T23 program entry): project, requested by, priority, then
// sample lines in a Lines view (default) or a Grid view of the same state, with one validator
// and a sticky bar to submit. The draft is created once a project is chosen and then saves as
// you go. Drafts have no LP number; it is issued on submit. A shared LAB station names who the
// program is requested by (attribution only) and follows its recording-person chip until
// someone picks another person. Progress only: nothing here records a result.

const newKey = () => crypto.randomUUID();

/** Units chosen on Inventory ("Add to lab request"): one project, its units' record IDs. */
interface ChosenUnits {
  projectId: string;
  projectLabel: string;
  storageUnitIds: string[];
}

function chosenUnits(state: unknown): ChosenUnits | null {
  if (!state || typeof state !== 'object') return null;
  const { projectId, projectLabel, storageUnitIds } = state as Record<string, unknown>;
  if (typeof projectId !== 'string' || !Array.isArray(storageUnitIds)) return null;
  const ids = storageUnitIds.filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) return null;
  return {
    projectId,
    projectLabel: typeof projectLabel === 'string' ? projectLabel : 'Chosen project',
    storageUnitIds: ids,
  };
}

/**
 * One Specific-sample line per sampling source that holds a chosen unit, with those units ticked
 * as the physical units holding the sample. The person still names the sample and its tests.
 */
async function linesForChosenUnits(
  projectId: string,
  sources: LabSource[],
  unitIds: string[],
): Promise<{ lines: LineDraft[]; placed: number }> {
  const wanted = new Set(unitIds);
  const lines: LineDraft[] = [];
  for (const source of sources) {
    if (wanted.size === 0) break;
    const ref = { kind: source.kind, id: source.id };
    const units = await fetchSourceUnits(projectId, ref);
    const here = units.map((u) => u.storageUnitId).filter((id) => wanted.has(id));
    if (here.length === 0) continue;
    here.forEach((id) => wanted.delete(id));
    lines.push({ ...emptyLine(), source: ref, scope: 'specific', unitIds: here });
  }
  return { lines, placed: unitIds.length - wanted.size };
}

function chosenNotice(total: number, placed: number, lineCount: number): string {
  const unit = (n: number) => `${n} unit${n === 1 ? '' : 's'}`;
  return placed === total
    ? `${unit(total)} from Inventory ${total === 1 ? 'is' : 'are'} ticked on ${lineCount} line${lineCount === 1 ? '' : 's'}. Name each sample and choose its tests.`
    : `${unit(placed)} of the ${unit(total)} chosen on Inventory could be ticked; the others aren’t in storage for this project now.`;
}

function personOption(program: LabProgram): ReceiverOption {
  return {
    id: program.requestedBy.userId,
    initials: program.requestedBy.initials ?? '',
    displayName: program.requestedBy.name,
  };
}

function failureMessage(result: Exclude<WriteResult<unknown>, { ok: true }>): string {
  switch (result.kind) {
    case 'conflict':
      if (result.code === 'coverage_changed') {
        return 'The material for a line changed (for example a new receipt). Check the units each line covers and submit again.';
      }
      if (result.code === 'not_draft') return 'This program has already been submitted.';
      if (result.code === 'program_numbers_exhausted') {
        return 'No program numbers are left for this year, so the draft was not submitted. It is saved as it is. Tell an administrator.';
      }
      return 'This program changed. Reload it to continue.';
    case 'invalid':
      return result.errors.length > 0
        ? result.errors.map((error) => error.message).join(' ')
        : 'Some lines need attention before submitting.';
    case 'forbidden':
      return 'You don’t have permission to do this.';
    case 'unauthenticated':
      return 'Your session ended. Sign in again; this page keeps what you typed until you leave it.';
    case 'network':
      return 'Couldn’t reach Material Mule. Check the connection and try again.';
    default:
      return 'Something went wrong. Try again.';
  }
}

const CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Edmonton',
  hour: 'numeric',
  minute: '2-digit',
});
/** "10:02 AM" in the lab's time zone. */
const timeOf = (date: Date) => CLOCK.format(date);

function SaveState({ status, created }: { status: SaveStatus; created: boolean }) {
  if (!created) return null;
  const base = 'flex items-center gap-1.5 text-[13px] text-muted-foreground';
  if (status.state === 'saving') {
    return (
      <span className={base} role="status">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        Saving…
      </span>
    );
  }
  if (status.state === 'failed') {
    return (
      <span className={`${base} text-stage-danger-fg`} role="status">
        <CloudAlert aria-hidden="true" className="size-4" />
        Not saved
      </span>
    );
  }
  return (
    <span className={base} role="status">
      <CloudCheck aria-hidden="true" className="size-4" />
      {status.state === 'saved' ? `Draft · saved ${timeOf(status.at)}` : 'Draft · saved'}
    </span>
  );
}

const FIELD_LABEL = 'text-[13px] font-medium text-muted-foreground';

export function ProgramEditor({
  draft,
  onReload,
}: {
  draft: LabProgram | null;
  onReload?: () => void;
}) {
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const headingId = useId();
  const shared = me.accountType === 'shared_lab';
  const allowed = me.permissions.includes('lab_program.manage');
  const arrival = location.state as { notice?: string } | null;
  // Inventory's "Add to lab request" opens a new program on that project with the units waiting.
  const [chosen] = useState(() => (draft ? null : chosenUnits(location.state)));
  const programId = draft?.id ?? null;
  const [project, setProject] = useState<ChosenProject | null>(
    draft
      ? { id: draft.project.id, label: `${draft.project.projectNumber} · ${draft.project.name}` }
      : chosen
        ? { id: chosen.projectId, label: chosen.projectLabel }
        : null,
  );
  const [requestedBy, setRequestedBy] = useState<ReceiverOption | null>(
    draft && shared ? personOption(draft) : null,
  );
  const [edit, dispatch] = useReducer(editReducer, null, () =>
    initialEditState(draft?.notes ?? '', draft ? linesFromProgram(draft) : [emptyLine()]),
  );
  const [view, setView] = useState<'lines' | 'grid'>('lines');
  const [filter, setFilter] = useState('all');
  const [catalogue, setCatalogue] = useState<TestCatalogue | null>(null);
  const [templates, setTemplates] = useState<TestTemplate[]>([]);
  const [sources, setSources] = useState<LabSource[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [retiredFromTemplate, setRetiredFromTemplate] = useState<TestTemplateItem[]>([]);
  const [message, setMessage] = useState<{ tone: 'warning' | 'success'; text: string } | null>(
    arrival?.notice ? { tone: 'success', text: arrival.notice } : null,
  );
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [submitKey, setSubmitKey] = useState(newKey);
  const [createKey] = useState(newKey);
  const createStarted = useRef(false);
  const pendingChosen = useRef<{ lines: LineDraft[]; notice: string } | null>(null);
  const requestedByRef = useRef<ReceiverOption | null>(requestedBy);
  useEffect(() => {
    requestedByRef.current = requestedBy;
  }, [requestedBy]);

  const saver = useDraftSaver({
    programId,
    initialVersion: draft?.version ?? 0,
    state: edit,
    personId: shared ? (requestedBy?.id ?? null) : null,
    sendPerson: shared,
    dispatch,
  });
  const initialSaved = useMemo<SaveStatus>(
    () => (draft ? { state: 'saved', at: new Date(draft.updatedAt) } : { state: 'idle' }),
    [draft],
  );
  const saveStatus = saver.status.state === 'idle' ? initialSaved : saver.status;

  useEffect(() => {
    let current = true;
    Promise.all([fetchCatalogue(), fetchTemplates()]).then(
      ([c, t]) => {
        if (!current) return;
        setCatalogue(c);
        setTemplates(t);
        setLoadFailed(false);
      },
      () => current && setLoadFailed(true),
    );
    return () => {
      current = false;
    };
  }, [loadAttempt]);
  useEffect(() => {
    if (!project) return;
    let current = true;
    fetchSources(project.id).then(
      (found) => current && setSources(found),
      () => current && setLoadFailed(true),
    );
    return () => {
      current = false;
    };
  }, [project, loadAttempt]);

  const personMissing = shared && requestedBy === null;

  /** Creates the draft (once) and opens it at its own address, where it saves as you go. */
  async function startDraft(
    chosenProject: ChosenProject,
    person: ReceiverOption | null,
    lines: LineDraft[],
    notice?: string,
  ) {
    if (createStarted.current || (shared && !person)) return;
    createStarted.current = true;
    setStarting(true);
    const result = await createProgram({
      projectId: chosenProject.id,
      idempotencyKey: createKey,
      notes: edit.notes.trim() || null,
      lines: lines.map(toInput),
      ...(shared && person ? { requestedByUserId: person.id } : {}),
    });
    if (!result.ok) {
      createStarted.current = false;
      setStarting(false);
      setMessage({ tone: 'warning', text: failureMessage(result) });
      return;
    }
    navigate(`/lab-testing/programs/${result.value.id}`, {
      replace: true,
      state: notice ? { notice } : null,
    });
  }

  // Units from Inventory: lay out their lines, then create the draft with them.
  useEffect(() => {
    if (!chosen) return;
    let current = true;
    void fetchSources(chosen.projectId)
      .then((found) => linesForChosenUnits(chosen.projectId, found, chosen.storageUnitIds))
      .then(
        ({ lines, placed }) => {
          if (!current) return;
          if (lines.length > 0) dispatch({ type: 'replace', notes: '', lines });
          const notice = chosenNotice(chosen.storageUnitIds.length, placed, lines.length);
          setMessage({
            tone: placed === chosen.storageUnitIds.length ? 'success' : 'warning',
            text: notice,
          });
          pendingChosen.current = { lines: lines.length > 0 ? lines : [emptyLine()], notice };
          void startDraft(
            { id: chosen.projectId, label: chosen.projectLabel },
            requestedByRef.current,
            pendingChosen.current.lines,
            notice,
          );
        },
        () => {
          if (!current) return;
          setMessage({
            tone: 'warning',
            text: 'The units chosen on Inventory couldn’t be loaded.',
          });
        },
      );
    return () => {
      current = false;
    };
    // Runs once for the units the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen]);

  function choosePerson(option: ReceiverOption | null) {
    setRequestedBy(option);
    if (!programId && project && option) {
      void startDraft(
        project,
        option,
        pendingChosen.current?.lines ?? edit.lines,
        pendingChosen.current?.notice,
      );
    }
  }

  function chooseProject(next: ChosenProject) {
    setProject(next);
    void startDraft(next, requestedBy, [emptyLine()]);
  }

  const reviewNow = saver.reviewCurrent ? saver.review : null;
  const problems = programProblems(edit, {
    hasProject: project !== null,
    personMissing,
    review: reviewNow,
  });
  const problemLines = new Set(problems.flatMap((p) => (p.lineKey ? [p.lineKey] : [])));
  const testNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const line of draft?.lines ?? []) {
      for (const test of line.tests)
        names.set(test.testTypeId, `${test.code} · ${test.displayName}`);
    }
    return names;
  }, [draft]);

  function showLine(lineNumber: number) {
    const line = edit.lines[lineNumber - 1];
    if (!line) return;
    setView('lines');
    setFilter('all');
    window.requestAnimationFrame(() => {
      const element = document.getElementById(`line-${line.key}`);
      if (!element) return;
      element.scrollIntoView({ block: 'center' });
      element.setAttribute('data-highlight', 'true');
      element.setAttribute('tabindex', '-1');
      element.focus({ preventScroll: true });
      window.setTimeout(() => element.removeAttribute('data-highlight'), 1600);
    });
  }

  function jumpTo(problem: EditorProblem) {
    if (problem.lineNumber) showLine(problem.lineNumber);
    else {
      const target = document.getElementById(`${headingId}-${problem.field}`);
      target?.scrollIntoView({ block: 'center' });
      target?.querySelector<HTMLElement>('input, button')?.focus();
    }
  }

  async function submit() {
    if (!programId || problems.length > 0) return;
    setBusy(true);
    setMessage(null);
    const saved = await saver.flush();
    if (!saved) {
      setBusy(false);
      return;
    }
    const review = await saver.loadReview();
    if (!review) {
      setBusy(false);
      setMessage({ tone: 'warning', text: 'The program couldn’t be checked. Try again.' });
      return;
    }
    if (!review.ready) {
      setBusy(false);
      setMessage({
        tone: 'warning',
        text: 'Some lines need attention before submitting. They are marked below.',
      });
      return;
    }
    const result = await submitProgram(programId, {
      version: review.version,
      idempotencyKey: submitKey,
      ...(shared ? { requestedByUserId: requestedBy?.id } : {}),
      coverage: review.lines.map((line) => ({
        lineId: line.lineId,
        unitIds: line.coverage.map((unit) => unit.storageUnitId),
      })),
    });
    setBusy(false);
    if (result.ok) {
      navigate(`/lab-testing/programs/${result.value.id}`, {
        replace: true,
        state: { submitted: true },
      });
      onReload?.();
      return;
    }
    if (result.kind === 'network') {
      // Same key on retry: a submission that did commit is returned, never duplicated.
      setMessage({ tone: 'warning', text: failureMessage(result) });
      return;
    }
    setSubmitKey(newKey());
    if ((result.kind === 'conflict' || result.kind === 'invalid') && result.review) {
      saver.setReview(result.review);
    }
    if (result.kind === 'conflict' && result.code === 'not_draft') {
      onReload?.();
      return;
    }
    if (result.kind === 'conflict' && result.code === 'version_conflict') {
      saver.markConflict(result.current ?? null);
      return;
    }
    setMessage({ tone: 'warning', text: failureMessage(result) });
  }

  async function deleteDraft() {
    setConfirmDelete(false);
    if (!programId) {
      navigate('/lab-testing/programs');
      return;
    }
    const result = await discardProgram(programId, {
      version: saver.version,
      ...(shared && requestedBy ? { requestedByUserId: requestedBy.id } : {}),
    });
    if (result.ok) navigate('/lab-testing/programs');
    else setMessage({ tone: 'warning', text: failureMessage(result) });
  }

  function chooseTemplate(template: TestTemplate) {
    const { add, retired } = applyTemplate(template);
    dispatch({ type: 'add-tests-everywhere', testTypeIds: add });
    setRetiredFromTemplate(retired);
  }

  if (!allowed) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldX aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>You can’t request lab tests</EmptyTitle>
          <EmptyDescription>
            Your access doesn’t include lab programs. Ask an administrator if you need it.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const created = programId !== null;
  const conflict = saver.conflict;
  const blockedReason = conflict
    ? 'Reload first.'
    : !catalogue && loadFailed
      ? 'Submitting waits until the catalogue loads.'
      : null;
  const title = created ? 'Draft lab program' : 'New lab program';
  const activeTemplates = templates.filter((template) => template.active);

  return (
    <div className="mx-auto grid w-full max-w-[1280px] gap-6" aria-labelledby={headingId}>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/lab-testing/programs">Lab programs</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{title}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StageTag stage="draft" label="Draft · Lab program" />
            <SaveState status={saveStatus} created={created} />
          </div>
          <h1 id={headingId} className="text-2xl font-semibold tracking-tight">
            {title}
          </h1>
        </div>
        {created ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="pointer-coarse:size-11"
                aria-label="More actions"
              >
                <EllipsisVertical aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden="true" />
                Delete draft
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>

      {conflict?.kind === 'changed' ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>This program changed. Reload it to continue.</AlertTitle>
          <AlertDescription className="grid gap-2">
            <p>
              Someone saved this draft on another computer or tab. Reload to see the latest version;
              what you changed here since your last save is replaced.
            </p>
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => void saver.reload()}>
                <RotateCw aria-hidden="true" />
                Reload
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : conflict?.kind === 'gone' ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>This draft was submitted or deleted elsewhere.</AlertTitle>
          <AlertDescription className="grid gap-2">
            <p>Nothing more is saved here.</p>
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => onReload?.()}>
                <RotateCw aria-hidden="true" />
                Reload
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {loadFailed ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>The test catalogue or sampling sources couldn’t be loaded.</AlertTitle>
          <AlertDescription className="grid gap-2">
            <p>
              Your lines are saved as they are. Adding tests and templates comes back once the
              catalogue loads.
            </p>
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setLoadFailed(false);
                  setLoadAttempt((n) => n + 1);
                }}
              >
                <RotateCw aria-hidden="true" />
                Try again
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {saver.status.state === 'failed' && !conflict ? (
        <Alert variant="destructive">
          <CloudAlert aria-hidden="true" />
          <AlertTitle>{saver.status.message}</AlertTitle>
          <AlertDescription>
            <Button type="button" size="sm" variant="outline" onClick={saver.retry}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {message ? (
        <Alert
          role={message.tone === 'success' ? 'status' : 'alert'}
          variant={message.tone === 'warning' ? 'destructive' : 'default'}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="Program details" className="flex flex-wrap items-start gap-x-10 gap-y-4">
        <div id={`${headingId}-project`} className="grid gap-1.5">
          {project ? (
            <>
              <span className={FIELD_LABEL}>Project</span>
              <span className="flex h-9 items-center text-sm">
                <span className="font-mono">{project.label.split(' · ')[0]}</span>
                <span>&nbsp;{project.label.split(' · ').slice(1).join(' · ')}</span>
              </span>
            </>
          ) : (
            <ProjectChooser onChoose={chooseProject} />
          )}
        </div>
        <div id={`${headingId}-requestedBy`} className="grid min-w-64 gap-1.5">
          {shared ? (
            <>
              <ReceiverSelect
                label="Requested by"
                required
                stationPerson="prefill"
                value={requestedBy}
                onChange={choosePerson}
                hint="LAB station: the person asking for these tests. Attribution only; LAB gets none of their permissions."
              />
              <p className="text-[13px] text-muted-foreground" aria-live="polite">
                {requestedBy
                  ? `Recorded as LAB for ${formatReceiver(requestedBy)}`
                  : 'Nobody chosen yet'}
              </p>
            </>
          ) : (
            <>
              <span className={FIELD_LABEL}>Requested by</span>
              <span className="flex h-9 items-center gap-2 text-sm">
                <PersonAvatar userId={me.id} name={me.displayName} />
                {me.displayName}
              </span>
            </>
          )}
        </div>
        <div className="grid gap-1.5">
          <span className={FIELD_LABEL}>Priority</span>
          <span className="flex h-9 items-center text-sm">
            {draft?.priority === 'urgent' ? 'Urgent' : 'Normal'}
          </span>
          <span className="max-w-56 text-[12px] text-muted-foreground">
            The project lead or the Lab Manager can mark it urgent once it is submitted.
          </span>
        </div>
      </section>

      <section aria-labelledby={`${headingId}-lines`} className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h2 id={`${headingId}-lines`} className="text-lg font-semibold">
              Sample lines
            </h2>
            <span className="text-[13px] text-muted-foreground">{countsText(edit.lines)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {created && catalogue && activeTemplates.length > 0 ? (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="pointer-coarse:h-11">
                    <LayoutTemplate aria-hidden="true" />
                    Choose a template
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Adds its tests to every line</DropdownMenuLabel>
                  {activeTemplates.map((template) => (
                    <DropdownMenuItem key={template.id} onSelect={() => chooseTemplate(template)}>
                      {template.name} ({template.items.length} test
                      {template.items.length === 1 ? '' : 's'})
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {created ? (
              <Tabs value={view} onValueChange={(value) => setView(value as 'lines' | 'grid')}>
                <TabsList aria-label="View">
                  <TabsTrigger value="lines" className="pointer-coarse:h-11">
                    <List aria-hidden="true" />
                    Lines
                  </TabsTrigger>
                  <TabsTrigger value="grid" className="pointer-coarse:h-11">
                    <LayoutGrid aria-hidden="true" />
                    Grid
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}
          </div>
        </div>
        <RetiredFromTemplate items={retiredFromTemplate} />

        {!created ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
            {starting
              ? 'Starting the draft…'
              : !project
                ? 'Choose a project first. The draft starts then and saves as you go.'
                : personMissing
                  ? 'Choose who this program is requested by. The draft starts then.'
                  : 'Starting the draft…'}
          </p>
        ) : view === 'lines' ? (
          <LinesView
            lines={edit.lines}
            projectId={project!.id}
            sources={sources}
            catalogue={catalogue}
            templates={templates}
            review={saver.review}
            problems={problems}
            testNames={testNames}
            filter={filter}
            onFilter={setFilter}
            onGoTo={showLine}
            dispatch={dispatch}
            readOnly={conflict !== null}
          />
        ) : (
          <GridView
            lines={edit.lines}
            sources={sources}
            catalogue={catalogue}
            testNames={testNames}
            problemLines={problemLines}
            dispatch={dispatch}
            readOnly={conflict !== null}
          />
        )}
      </section>

      {created ? (
        <div className="grid max-w-2xl gap-1.5">
          <Label htmlFor={`${headingId}-notes`} className={FIELD_LABEL}>
            Notes for the lab
          </Label>
          <Textarea
            id={`${headingId}-notes`}
            value={edit.notes}
            maxLength={2000}
            readOnly={conflict !== null}
            onChange={(event) => dispatch({ type: 'notes', notes: event.target.value })}
          />
          <p className="text-[12px] text-muted-foreground">
            Individual samples are named only here, in lab requests. Receiving records one summary
            per test hole.
          </p>
        </div>
      ) : null}

      <SubmitBar
        counts={countsText(edit.lines)}
        problems={created ? problems : problems.filter((problem) => !problem.lineKey)}
        onProblem={jumpTo}
        blockedReason={
          blockedReason ?? (created ? null : 'The draft starts once a project is chosen.')
        }
        busy={busy}
        onSubmit={() => void submit()}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              The draft and its lines are deleted. Submitted programs are never affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void deleteDraft()}>
              Delete draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
