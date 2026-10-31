import {
  createProjectRequestSchema,
  formatPerson,
  messagesByField,
  projectLabel,
  toFieldErrors,
  type ProjectSummary,
  type StaffOption,
} from '@materialmule/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createProject, fetchMyGrants, searchProjects } from '../api/projects';
import { FormField, RequiredMarker } from '../components/ui';
import { prefillFromQuery } from './prefill';
import { useListHighlight } from '../components/useListHighlight';
import { StaffOptionGroups } from '../projects/StaffOptionGroups';

// Project combobox with inline "Add project" (MM-T08). The typed text lives in the receipt draft
// (props), so nothing typed is lost while adding a project or while offline.
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

export function ProjectPicker({
  value,
  query,
  onQueryChange,
  onSelect,
  staff,
  receiverUserId,
  online,
  projectEngineersOnly = false,
  staffReady = true,
  required = false,
  invalid = false,
}: {
  value: ProjectSummary | null;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (project: ProjectSummary | null) => void;
  staff: StaffOption[];
  receiverUserId: string | null;
  online: boolean;
  /**
   * Receive samples → Add project (MM-T66 UI-04): offer only active staff whose position is Project Engineer
   * (`project_engineer`), in one list. Elsewhere the grouped list stays (MM-T61). A UI filter only: it grants
   * no role and changes no project authority; the server still checks the chosen person.
   */
  projectEngineersOnly?: boolean;
  /** False while the staff list is still loading, so "nobody eligible" isn't shown too early. */
  staffReady?: boolean;
  /** Marks the project as required (MTR-133). */
  required?: boolean;
  /** The form reported a problem with the project: the search box says so (MTR-133). */
  invalid?: boolean;
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

  const trimmed = query.trim();
  useEffect(() => {
    if (value || trimmed === '') return;
    let current = true;
    const timer = setTimeout(() => {
      searchProjects(trimmed).then(
        (results) => current && setSearch({ state: 'ready', query: trimmed, results }),
        () => current && setSearch({ state: 'error', query: trimmed }),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmed, value]);

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
      // Enter in the search box chooses the highlighted match; it never submits the whole form
      // (the Correct details form, MM-T61).
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
    return (
      <fieldset className="picker">
        <legend>Project</legend>
        <div className="readonly-grid">
          <FormField label="Project number">
            {(props) => <input {...props} value={value.projectNumber} readOnly />}
          </FormField>
          <FormField label="Project name">
            {(props) => <input {...props} value={value.name} readOnly />}
          </FormField>
          <FormField label="Client">
            {(props) => <input {...props} value={value.client} readOnly />}
          </FormField>
          <FormField label="Lead Project Engineer">
            {(props) => (
              <input
                {...props}
                value={
                  value.leadProjectEngineer?.displayName ?? 'Waiting for a Lead Project Engineer'
                }
                readOnly
              />
            )}
          </FormField>
        </div>
        <button
          type="button"
          id={`${id}-change`}
          onClick={() => {
            focusNext.current = 'search';
            onSelect(null);
          }}
        >
          Change project
        </button>
      </fieldset>
    );
  }

  const field = (key: keyof AddForm) => fieldErrors[key]?.join(' ') ?? null;
  const projectEngineerStaff = projectEngineersOnly
    ? staff.filter((person) => person.position === 'project_engineer')
    : staff;
  const noProjectEngineer = projectEngineersOnly && staffReady && projectEngineerStaff.length === 0;
  const setField = (key: Exclude<keyof AddForm, 'appointSelfAsLead'>) => (text: string) =>
    setForm((current) => (current ? { ...current, [key]: text } : current));

  return (
    <fieldset className="picker">
      <legend>
        Project
        {required ? <RequiredMarker /> : null}
      </legend>
      <div className="form-field combobox">
        <label htmlFor={`${id}-search`}>Find project (number or name)</label>
        <div className="combobox-row">
          <input
            id={`${id}-search`}
            role="combobox"
            aria-required={required || undefined}
            aria-invalid={invalid || undefined}
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listboxId}
            aria-activedescendant={showList && active >= 0 ? `${listboxId}-${active}` : undefined}
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
          {/* Beside the search box, so the open list never covers it. */}
          {!form ? (
            <button type="button" onClick={startAdding} disabled={!online}>
              {online ? 'Add project' : 'Connect to add a project'}
            </button>
          ) : null}
        </div>
        {showList ? (
          <ul id={listboxId} role="listbox" aria-label="Matching projects" className="listbox">
            {results.map((project, index) => (
              <li
                key={project.id}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(project)}
              >
                {projectLabel(project)}
              </li>
            ))}
            {search.state === 'error' && search.query === trimmed ? (
              <li role="option" aria-selected={false} aria-disabled="true" className="muted">
                Search failed. Check the connection.
              </li>
            ) : search.state === 'ready' && search.query === trimmed && results.length === 0 ? (
              <li role="option" aria-selected={false} aria-disabled="true" className="muted">
                No matching project
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>

      {form ? (
        <div className="inline-form" role="group" aria-labelledby={`${id}-add`}>
          <h3 id={`${id}-add`}>Add project</h3>
          <FormField label="Project number" error={field('projectNumber')}>
            {(props) => (
              <input
                {...props}
                value={form.projectNumber}
                onChange={(e) => setField('projectNumber')(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Project name" error={field('name')}>
            {(props) => (
              <input
                {...props}
                value={form.name}
                onChange={(e) => setField('name')(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Client" error={field('client')}>
            {(props) => (
              <input
                {...props}
                value={form.client}
                onChange={(e) => setField('client')(e.target.value)}
              />
            )}
          </FormField>
          {canSelfLead ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.appointSelfAsLead}
                onChange={(e) =>
                  setForm((current) =>
                    current ? { ...current, appointSelfAsLead: e.target.checked } : current,
                  )
                }
              />
              I’ll lead this project (Can create and lead projects)
            </label>
          ) : null}
          {field('appointSelfAsLead') ? (
            <p className="field-error" role="alert">
              {field('appointSelfAsLead')}
            </p>
          ) : null}
          {!form.appointSelfAsLead ? (
            <>
              <FormField
                label="Nominate a Lead Project Engineer (optional)"
                error={field('leadNomineeUserId')}
                hint={
                  noProjectEngineer
                    ? 'Nobody active has the Project Engineer position yet. You can leave this empty: an admin appoints the lead. Positions are set under Settings → Staff & access.'
                    : 'An admin confirms the nomination. Until then the project has no lead, and receiving carries on as normal.'
                }
              >
                {(props) => (
                  <select
                    {...props}
                    value={form.leadNomineeUserId}
                    onChange={(e) => setField('leadNomineeUserId')(e.target.value)}
                  >
                    <option value="">No nomination: leave it to an admin</option>
                    {projectEngineersOnly ? (
                      projectEngineerStaff.map((person) => (
                        <option key={person.id} value={person.id}>
                          {formatPerson(person.initials, person.displayName)}
                        </option>
                      ))
                    ) : (
                      <StaffOptionGroups staff={staff} />
                    )}
                  </select>
                )}
              </FormField>
              {form.leadNomineeUserId ? (
                <FormField label="Note for the admin (optional)" error={field('nominationNote')}>
                  {(props) => (
                    <textarea
                      {...props}
                      rows={2}
                      maxLength={2000}
                      value={form.nominationNote}
                      onChange={(e) => setField('nominationNote')(e.target.value)}
                    />
                  )}
                </FormField>
              ) : null}
            </>
          ) : null}
          {existing ? (
            <div className="error-state" role="alert">
              <p>
                Project {existing.projectNumber} already exists: {existing.name}.
              </p>
              <button type="button" onClick={() => choose(existing)}>
                Use this project
              </button>
            </div>
          ) : null}
          {saveError ? (
            <p className="field-error" role="alert">
              {saveError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={!online || saving}
              onClick={() => void submit()}
            >
              {online ? 'Save project' : 'Connect to add a project'}
            </button>
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}
