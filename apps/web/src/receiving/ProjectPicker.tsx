import {
  createProjectRequestSchema,
  formatPerson,
  messagesByField,
  projectLabel,
  toFieldErrors,
  type ProjectSummary,
  type StaffOption,
} from '@materialmule/shared';
import { Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createProject, fetchMyGrants, searchProjects } from '../api/projects';
import { RequiredMarker } from '../components/app-ui';
import { useListHighlight } from '../components/useListHighlight';
import { StaffOptionGroups } from '../projects/StaffOptionGroups';
import { FieldErrorText, LabeledField, NATIVE_SELECT_CLASS } from './LabeledField';
import { prefillFromQuery } from './prefill';

// Project combobox with "Add project" in a Dialog (MM-T08, STRATA-76). The typed text lives in
// the receipt draft (props), so nothing typed is lost while adding a project or while offline.
//
// Lead (MM-AO04, D01/D02): adding a project makes nobody its lead. The person adding it may
// nominate a Lead Project Engineer for an admin to confirm, or leave it to the admins; only a
// holder of "Can create and lead projects" may lead it themselves. Receiving works either way.

const SEARCH_DELAY_MS = 200;

type Search =
  | { state: 'idle' }
  | { state: 'ready'; query: string; results: ProjectSummary[] }
  | { state: 'error'; query: string };

interface AddForm {
  projectNumber: string;
  name: string;
  client: string;
  leadNomineeUserId: string;
  nominationNote: string;
  appointSelfAsLead: boolean;
}

const LIST_CLASS =
  'bg-popover text-popover-foreground absolute top-full right-0 left-0 z-30 m-0 mt-1 max-h-72 list-none overflow-y-auto rounded-md border p-1 shadow-md';
const OPTION_CLASS =
  'aria-selected:bg-accent aria-selected:text-accent-foreground flex min-h-9 cursor-pointer items-center rounded-sm px-2 text-sm';
const NOTE_OPTION_CLASS = 'text-muted-foreground flex min-h-9 items-center px-2 text-sm';

export function ProjectPicker({
  value,
  query,
  onQueryChange,
  onSelect,
  staff,
  receiverUserId,
  online,
  engineersOnly = false,
  staffReady = true,
  required = false,
  invalid = false,
  addOnOpen = false,
  retryKey = 0,
  onLoadError,
}: {
  value: ProjectSummary | null;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (project: ProjectSummary | null) => void;
  staff: StaffOption[];
  receiverUserId: string | null;
  online: boolean;
  /**
   * Receive samples → Add project (MM-T66 UI-04, MISC-06): offer only active staff whose position is
   * Engineer, in one list, by name, initials and effective job title (never the position). Elsewhere
   * the grouped list stays (MM-T61). A UI filter only: choosing someone nominates them; it grants no
   * role and changes no project authority, and the server still checks the chosen person.
   */
  engineersOnly?: boolean;
  /** False while the staff list is still loading, so "nobody eligible" isn't shown too early. */
  staffReady?: boolean;
  /** Marks the project as required (MTR-133). */
  required?: boolean;
  /** The form reported a problem with the project: the search box says so (MTR-133). */
  invalid?: boolean;
  /** Opens Add project at once (Quick actions › New project: `?project=new`). */
  addOnOpen?: boolean;
  /** Changing it runs the search again (a page-level Try again). */
  retryKey?: number;
  /** Told when a search fails (true) or answers (false). */
  onLoadError?: (failed: boolean) => void;
}) {
  const id = useId();
  const [search, setSearch] = useState<Search>({ state: 'idle' });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AddForm | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [existing, setExisting] = useState<ProjectSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Whether the signed-in person holds "Can create and lead projects" (null: unknown). */
  const [canSelfLead, setCanSelfLead] = useState<boolean | null>(null);
  // MTR-136: picking (or changing) the project replaces the focused control, so say where focus
  // goes next instead of letting it fall to the page body.
  const focusNext = useRef<'change' | 'search' | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    document.getElementById(`${id}-${target}`)?.focus();
  }, [value, id]);

  const reportLoad = useRef(onLoadError);
  useEffect(() => {
    reportLoad.current = onLoadError;
  });

  const trimmed = query.trim();
  useEffect(() => {
    if (value || trimmed === '') return;
    let current = true;
    const timer = setTimeout(() => {
      searchProjects(trimmed).then(
        (results) => {
          if (!current) return;
          setSearch({ state: 'ready', query: trimmed, results });
          reportLoad.current?.(false);
        },
        () => {
          if (!current) return;
          setSearch({ state: 'error', query: trimmed });
          reportLoad.current?.(true);
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmed, value, retryKey]);

  const results = search.state === 'ready' && search.query === trimmed ? search.results : [];
  const listboxId = `${id}-projects`;
  const showList = open && trimmed !== '' && !form;
  // MM-T62: the first match is highlighted, so Enter picks it (same in every picker).
  const highlight = useListHighlight(
    results.length,
    `${trimmed}|${results.map((project) => project.id).join(',')}`,
  );
  const active = highlight.active;

  function choose(project: ProjectSummary) {
    focusNext.current = 'change';
    onSelect(project);
    setOpen(false);
    setForm(null);
    setExisting(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      highlight.next();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlight.previous();
    } else if (event.key === 'Enter') {
      // Enter in the search box chooses the highlighted match (a scanned project number ends with
      // Enter too); it never submits the whole form (the Correct details form, MM-T61).
      event.preventDefault();
      if (showList && results[active]) choose(results[active]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  function startAdding() {
    setForm({
      ...prefillFromQuery(query),
      client: '',
      leadNomineeUserId: '',
      nominationNote: '',
      appointSelfAsLead: false,
    });
    fetchMyGrants().then(
      (grants) =>
        setCanSelfLead(
          grants.capabilities.active.some((g) => g.capability === 'project.create_and_lead'),
        ),
      () => setCanSelfLead(false),
    );
    setFieldErrors({});
    setExisting(null);
    setSaveError(null);
    setOpen(false);
  }

  const addedOnOpen = useRef(false);
  useEffect(() => {
    if (!addOnOpen || addedOnOpen.current || value || !online) return;
    addedOnOpen.current = true;
    startAdding();
    // Once, when the page opens with ?project=new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addOnOpen]);

  async function submit() {
    if (!form) return;
    setExisting(null);
    setSaveError(null);
    const input = {
      projectNumber: form.projectNumber,
      name: form.name,
      client: form.client,
      leadNomineeUserId: form.appointSelfAsLead ? null : form.leadNomineeUserId || null,
      nominationNote: form.appointSelfAsLead ? null : form.nominationNote || null,
      appointSelfAsLead: form.appointSelfAsLead,
      receiverUserId,
    };
    const checked = createProjectRequestSchema.safeParse(input);
    if (!checked.success) {
      setFieldErrors(messagesByField(toFieldErrors(checked.error)));
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      const result = await createProject(input);
      if (result.kind === 'created') {
        choose(result.record);
      } else if (result.kind === 'exists') {
        setExisting(result.existing);
      } else {
        setFieldErrors(result.fieldErrors);
      }
    } catch {
      setSaveError("The project couldn't be saved. Check the connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  if (value) {
    const lead = value.leadProjectEngineer?.displayName ?? 'Waiting for a Lead Project Engineer';
    return (
      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="sr-only">Project</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <ReadOnlyField label="Project number" value={value.projectNumber} mono />
          <ReadOnlyField label="Project name" value={value.name} />
          <ReadOnlyField label="Client" value={value.client} />
          <ReadOnlyField label="Lead Project Engineer" value={lead} />
        </div>
        <div>
          <Button
            type="button"
            variant="outline"
            id={`${id}-change`}
            onClick={() => {
              focusNext.current = 'search';
              onSelect(null);
            }}
          >
            Change project
          </Button>
        </div>
      </fieldset>
    );
  }

  const field = (key: keyof AddForm) => fieldErrors[key]?.join(' ') ?? null;
  const engineerStaff = engineersOnly
    ? staff.filter((person) => person.position === 'engineer')
    : staff;
  const noEngineer = engineersOnly && staffReady && engineerStaff.length === 0;
  const setField = (key: Exclude<keyof AddForm, 'appointSelfAsLead'>) => (text: string) =>
    setForm((current) => (current ? { ...current, [key]: text } : current));

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
      <legend className="sr-only">
        Project
        {required ? <RequiredMarker /> : null}
      </legend>
      <Label htmlFor={`${id}-search`} className="text-[13px] font-semibold">
        Find project (number or name)
      </Label>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <div className="relative min-w-0 flex-1 basis-72">
          <Input
            id={`${id}-search`}
            role="combobox"
            placeholder="Find a project by number or name"
            aria-required={required || undefined}
            aria-invalid={invalid || undefined}
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listboxId}
            aria-activedescendant={showList && active >= 0 ? `${listboxId}-${active}` : undefined}
            aria-describedby={`${id}-hint`}
            autoComplete="off"
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
          />
          {showList ? (
            <ul id={listboxId} role="listbox" aria-label="Matching projects" className={LIST_CLASS}>
              {results.map((project, index) => (
                <li
                  key={project.id}
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={OPTION_CLASS}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(project)}
                >
                  {projectLabel(project)}
                </li>
              ))}
              {search.state === 'error' && search.query === trimmed ? (
                <li
                  role="option"
                  aria-selected={false}
                  aria-disabled="true"
                  className={NOTE_OPTION_CLASS}
                >
                  Search failed. Check the connection.
                </li>
              ) : search.state === 'ready' && search.query === trimmed && results.length === 0 ? (
                <li
                  role="option"
                  aria-selected={false}
                  aria-disabled="true"
                  className={NOTE_OPTION_CLASS}
                >
                  No matching project
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
        {/* Beside the search box, so the open list never covers it. */}
        <Button type="button" variant="outline" onClick={startAdding} disabled={!online}>
          <Plus aria-hidden="true" />
          {online ? 'Add project' : 'Connect to add a project'}
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-muted-foreground m-0 text-[13px]">
        Find by number or name, or scan a project label while the field has focus.
      </p>

      <Dialog open={form !== null} onOpenChange={(next) => (next ? undefined : setForm(null))}>
        {form ? (
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle>Add project</DialogTitle>
              <DialogDescription>
                For a project that isn’t in Material Mule yet. It is added now, and this receipt
                uses it.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <LabeledField label="Project number" error={field('projectNumber')}>
                {(props) => (
                  <Input
                    {...props}
                    className="font-mono"
                    value={form.projectNumber}
                    onChange={(e) => setField('projectNumber')(e.target.value)}
                  />
                )}
              </LabeledField>
              <LabeledField label="Project name" error={field('name')}>
                {(props) => (
                  <Input
                    {...props}
                    value={form.name}
                    onChange={(e) => setField('name')(e.target.value)}
                  />
                )}
              </LabeledField>
              <LabeledField label="Client" error={field('client')}>
                {(props) => (
                  <Input
                    {...props}
                    value={form.client}
                    onChange={(e) => setField('client')(e.target.value)}
                  />
                )}
              </LabeledField>
              {canSelfLead ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-self-lead`}
                    checked={form.appointSelfAsLead}
                    onCheckedChange={(checked) =>
                      setForm((current) =>
                        current ? { ...current, appointSelfAsLead: checked === true } : current,
                      )
                    }
                  />
                  <Label htmlFor={`${id}-self-lead`} className="font-normal">
                    I’ll lead this project (Can create and lead projects)
                  </Label>
                </div>
              ) : null}
              {field('appointSelfAsLead') ? (
                <div role="alert">
                  <FieldErrorText>{field('appointSelfAsLead')}</FieldErrorText>
                </div>
              ) : null}
              {!form.appointSelfAsLead ? (
                <>
                  <LabeledField
                    label="Nominate a Lead Project Engineer (optional)"
                    error={field('leadNomineeUserId')}
                    hint={
                      noEngineer
                        ? 'Nobody active has the Engineer position yet. You can leave this empty: an admin appoints the lead. Positions are set under Settings → Staff & access.'
                        : 'An admin confirms the nomination. Until then the project has no lead, and receiving carries on as normal.'
                    }
                  >
                    {(props) => (
                      <select
                        {...props}
                        data-slot="native-select"
                        className={NATIVE_SELECT_CLASS}
                        value={form.leadNomineeUserId}
                        onChange={(e) => setField('leadNomineeUserId')(e.target.value)}
                      >
                        <option value="">No nomination: leave it to an admin</option>
                        {engineersOnly ? (
                          engineerStaff.map((person) => (
                            <option key={person.id} value={person.id}>
                              {formatPerson(person.initials, person.displayName)}
                              {person.jobTitle ? ` — ${person.jobTitle}` : ''}
                            </option>
                          ))
                        ) : (
                          <StaffOptionGroups staff={staff} />
                        )}
                      </select>
                    )}
                  </LabeledField>
                  {form.leadNomineeUserId ? (
                    <LabeledField
                      label="Note for the admin (optional)"
                      error={field('nominationNote')}
                    >
                      {(props) => (
                        <Textarea
                          {...props}
                          rows={2}
                          maxLength={2000}
                          value={form.nominationNote}
                          onChange={(e) => setField('nominationNote')(e.target.value)}
                        />
                      )}
                    </LabeledField>
                  ) : null}
                </>
              ) : null}
              {existing ? (
                <Alert variant="destructive">
                  <AlertTitle className="line-clamp-none">
                    Project {existing.projectNumber} already exists: {existing.name}.
                  </AlertTitle>
                  <AlertDescription>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-foreground"
                      onClick={() => choose(existing)}
                    >
                      Use this project
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}
              {saveError ? (
                <div role="alert">
                  <FieldErrorText>{saveError}</FieldErrorText>
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button type="button" disabled={!online || saving} onClick={() => void submit()}>
                {online ? 'Add project' : 'Connect to add a project'}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </fieldset>
  );
}

function ReadOnlyField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <LabeledField label={label}>
      {(props) => (
        <Input
          {...props}
          readOnly
          value={value}
          className={mono ? 'bg-muted font-mono' : 'bg-muted'}
        />
      )}
    </LabeledField>
  );
}
