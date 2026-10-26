import {
  createProjectRequestSchema,
  projectLabel,
  type ProjectSummary,
  type StaffOption,
} from '@trapezoid/shared';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { createProject, searchProjects } from '../api/projects';
import { FormField } from '../components/ui';
import { errorsByField, prefillFromQuery } from './prefill';

// Project combobox with inline "Add project" (TRP-T08). The typed text lives in the receipt draft
// (props), so nothing typed is lost while adding a project or while offline.

const SEARCH_DELAY_MS = 200;

type Search =
  | { state: 'idle' }
  | { state: 'ready'; query: string; results: ProjectSummary[] }
  | { state: 'error'; query: string };

interface AddForm {
  projectNumber: string;
  name: string;
  client: string;
  pmPeUserId: string;
}

export function ProjectPicker({
  value,
  query,
  onQueryChange,
  onSelect,
  staff,
  receiverUserId,
  online,
}: {
  value: ProjectSummary | null;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (project: ProjectSummary | null) => void;
  staff: StaffOption[];
  receiverUserId: string | null;
  online: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState<Search>({ state: 'idle' });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [form, setForm] = useState<AddForm | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [existing, setExisting] = useState<ProjectSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  function choose(project: ProjectSummary) {
    onSelect(project);
    setOpen(false);
    setActive(-1);
    setForm(null);
    setExisting(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && showList && results[active]) {
      event.preventDefault();
      choose(results[active]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  function startAdding() {
    setForm({ ...prefillFromQuery(query), client: '', pmPeUserId: '' });
    setFieldErrors({});
    setExisting(null);
    setSaveError(null);
    setOpen(false);
  }

  async function submit() {
    if (!form) return;
    setExisting(null);
    setSaveError(null);
    const input = { ...form, receiverUserId };
    const checked = createProjectRequestSchema.safeParse(input);
    if (!checked.success) {
      setFieldErrors(errorsByField(checked.error.issues));
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
          <FormField label="PM/PE">
            {(props) => <input {...props} value={value.pmPe.displayName} readOnly />}
          </FormField>
        </div>
        <button type="button" onClick={() => onSelect(null)}>
          Change project
        </button>
      </fieldset>
    );
  }

  const field = (key: keyof AddForm) => fieldErrors[key]?.join(' ') ?? null;
  const setField = (key: keyof AddForm) => (text: string) =>
    setForm((current) => (current ? { ...current, [key]: text } : current));

  return (
    <fieldset className="picker">
      <legend>Project</legend>
      <div className="form-field combobox">
        <label htmlFor={`${id}-search`}>Find project (number or name)</label>
        <div className="combobox-row">
          <input
            id={`${id}-search`}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listboxId}
            aria-activedescendant={showList && active >= 0 ? `${listboxId}-${active}` : undefined}
            autoComplete="off"
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value);
              setOpen(true);
              setActive(-1);
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
          <FormField label="PM/PE" error={field('pmPeUserId')}>
            {(props) => (
              <select
                {...props}
                value={form.pmPeUserId}
                onChange={(e) => setField('pmPeUserId')(e.target.value)}
              >
                <option value="">Choose a staff member</option>
                {staff.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.initials
                      ? `${person.displayName} (${person.initials})`
                      : person.displayName}
                  </option>
                ))}
              </select>
            )}
          </FormField>
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
