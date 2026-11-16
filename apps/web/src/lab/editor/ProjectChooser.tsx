import type { ProjectSummary } from '@materialmule/shared';
import { useEffect, useId, useState } from 'react';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { searchProjects } from '../../api/projects';

// The project of a new lab program: search by project number or name. The draft is created as
// soon as one is chosen, so its lines can save as they are typed.

export interface ChosenProject {
  id: string;
  label: string;
}

export function ProjectChooser({ onChoose }: { onChoose: (project: ChosenProject) => void }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; projects: ProjectSummary[] } | null>(null);
  useEffect(() => {
    const text = query.trim();
    if (text === '') return;
    let current = true;
    const timer = window.setTimeout(() => {
      searchProjects(text).then(
        (projects) => current && setFound({ query: text, projects }),
        () => current && setFound({ query: text, projects: [] }),
      );
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query]);
  const results = query.trim() && found ? found.projects : [];
  return (
    <div className="grid max-w-md gap-1.5">
      <Label htmlFor={id} className="text-[13px] font-medium text-muted-foreground">
        Project
      </Label>
      <Command shouldFilter={false} className="rounded-md border bg-background">
        <CommandInput
          id={id}
          aria-label="Project"
          placeholder="Project number or name"
          value={query}
          onValueChange={setQuery}
        />
        {query.trim() ? (
          <CommandList>
            {results.length > 0 ? (
              <CommandGroup heading="Matching projects">
                {results.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={project.id}
                    onSelect={() =>
                      onChoose({
                        id: project.id,
                        label: `${project.projectNumber} · ${project.name}`,
                      })
                    }
                  >
                    <span className="font-mono">{project.projectNumber}</span> {project.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : found?.query === query.trim() ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No project matches.</p>
            ) : null}
          </CommandList>
        ) : null}
      </Command>
    </div>
  );
}
