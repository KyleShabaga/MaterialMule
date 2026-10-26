import { projectLabel, type ProjectSummary } from '@trapezoid/shared';
import { useEffect, useId, useState } from 'react';
import { searchProjects } from '../api/projects';

const SEARCH_DELAY_MS = 200;

type Results =
  | { state: 'idle' }
  | { state: 'ready'; query: string; projects: ProjectSummary[] }
  | { state: 'error'; query: string };

/**
 * Project filter for the inventory (TRP-T12): type a project number or name, pick a match. The
 * selected project shows as text with a Clear button.
 */
export function ProjectFilter({
  selected,
  selectedId,
  onSelect,
}: {
  selected: ProjectSummary | null;
  selectedId: string | undefined;
  onSelect: (project: ProjectSummary | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [results, setResults] = useState<Results>({ state: 'idle' });
  const query = text.trim();

  useEffect(() => {
    if (query === '' || selectedId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchProjects(query).then(
        (projects) => !cancelled && setResults({ state: 'ready', query, projects }),
        () => !cancelled && setResults({ state: 'error', query }),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, selectedId]);

  if (selectedId) {
    return (
      <div className="form-field">
        <span className="field-label" id={`${id}-label`}>
          Project
        </span>
        <div className="selected-filter" aria-labelledby={`${id}-label`}>
          <span>{selected ? projectLabel(selected) : 'Loading…'}</span>
          <button
            type="button"
            onClick={() => {
              setText('');
              setResults({ state: 'idle' });
              onSelect(null);
            }}
          >
            Change project
          </button>
        </div>
      </div>
    );
  }

  const current = results.state !== 'idle' && results.query === query ? results : null;
  return (
    <div className="form-field project-filter">
      <label htmlFor={id}>Project</label>
      <input
        id={id}
        type="search"
        value={text}
        placeholder="Number or name"
        autoComplete="off"
        onChange={(event) => setText(event.target.value)}
      />
      {query !== '' && current?.state === 'ready' ? (
        current.projects.length > 0 ? (
          <ul className="filter-options" aria-label="Matching projects">
            {current.projects.map((project) => (
              <li key={project.id}>
                <button type="button" onClick={() => onSelect(project)}>
                  {projectLabel(project)}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="field-hint">No matching projects.</p>
        )
      ) : null}
      {query !== '' && current?.state === 'error' ? (
        <p className="field-error">Couldn’t search projects. Try again.</p>
      ) : null}
    </div>
  );
}
