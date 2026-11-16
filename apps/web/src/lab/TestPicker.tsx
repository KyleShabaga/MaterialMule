import {
  applyTemplate,
  searchTests,
  testDisplayName,
  testGroupPath,
  type TestCatalogue,
  type TestTemplate,
  type TestTemplateItem,
  type TestType,
} from '@materialmule/shared';
import { Check, LayoutTemplate, Plus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { testLabel } from './editor/labels';

// Tests on a line (STRATA-86): removable chips and + Add test, a search of the lab's catalogue
// grouped by group and subgroup (shadcn Command in a Popover). Retired tests are never offered;
// a template's retired tests are listed for the person to replace instead of being added or
// dropped silently (MM-T23). Used by the program editor, amendments and Settings › Templates.

export function TestChip({
  label,
  description,
  retired = false,
  marker,
  onRemove,
  removeLabel,
}: {
  label: string;
  description?: string;
  retired?: boolean;
  /** Shown before the name, e.g. "Added by amendment". */
  marker?: string;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <li className="flex">
      <Badge
        variant="outline"
        title={description}
        className={cn(
          'h-7 gap-1 rounded-full pr-0.5 pl-2.5 text-[13px] font-normal whitespace-normal',
          !onRemove && 'pr-2.5',
          retired && 'border-dashed text-muted-foreground',
        )}
      >
        {marker ? <span className="text-muted-foreground">{marker}:</span> : null}
        <span className="text-left">
          {label}
          {retired ? ' (retired)' : ''}
        </span>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-full pointer-coarse:size-8"
            aria-label={removeLabel}
            onClick={onRemove}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </Badge>
    </li>
  );
}

/**
 * + Add test: the catalogue's active tests by group, searched by code, name or description.
 * Tests already on the line are listed as "On this line" and can't be added twice. Templates,
 * when given, fill the line's tests.
 */
export function AddTestButton({
  catalogue,
  templates = [],
  selected,
  onAdd,
  onTemplate,
  label = 'Add test',
  accessibleLabel,
  disabled,
}: {
  catalogue: TestCatalogue;
  templates?: TestTemplate[];
  selected: string[];
  onAdd: (testTypeId: string) => void;
  onTemplate?: (template: TestTemplate) => void;
  label?: string;
  /** e.g. "Add test to line 2"; starts with the visible words. */
  accessibleLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const active = catalogue.tests.filter((test) => test.active);
  const found = searchTests(active, query);
  const groups = new Map<string, TestType[]>();
  for (const test of found) {
    const path = testGroupPath(test.groupName, test.subgroupName);
    groups.set(path, [...(groups.get(path) ?? []), test]);
  }
  const activeTemplates = onTemplate
    ? templates.filter(
        (template) =>
          template.active &&
          (query.trim() === '' || template.name.toLowerCase().includes(query.trim().toLowerCase())),
      )
    : [];
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn('h-7 px-2 text-[13px]', 'pointer-coarse:h-11')}
          aria-label={accessibleLabel}
          disabled={disabled}
        >
          <Plus aria-hidden="true" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter={false} label="Tests in the catalogue">
          <CommandInput
            placeholder="Find a test"
            aria-label="Find a test"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-72">
            <CommandEmpty>No available test matches.</CommandEmpty>
            {activeTemplates.length > 0 ? (
              <>
                <CommandGroup heading="Templates">
                  {activeTemplates.map((template) => (
                    <CommandItem
                      key={template.id}
                      value={`template:${template.id}`}
                      onSelect={() => {
                        onTemplate?.(template);
                        setOpen(false);
                        setQuery('');
                      }}
                    >
                      <LayoutTemplate aria-hidden="true" />
                      <span>
                        {template.name} ({template.items.length} test
                        {template.items.length === 1 ? '' : 's'})
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            ) : null}
            {[...groups].map(([path, tests]) => (
              <CommandGroup key={path} heading={path}>
                {tests.map((test) => {
                  const onLine = selected.includes(test.id);
                  return (
                    <CommandItem
                      key={test.id}
                      value={test.id}
                      disabled={onLine}
                      onSelect={() => onAdd(test.id)}
                      title={test.description}
                    >
                      <span className="font-mono text-xs">{test.code}</span>
                      <span className="min-w-0 flex-1 truncate">{testDisplayName(test)}</span>
                      {onLine ? (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          On this line
                          <Check aria-hidden="true" />
                        </span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            Tests come from the lab’s catalogue. Ask the Lab Manager to add one.
          </p>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The note shown after a template whose retired tests were not added. */
export function RetiredFromTemplate({ items }: { items: TestTemplateItem[] }) {
  if (items.length === 0) return null;
  return (
    <p role="status" className="text-[13px] text-stage-due-fg">
      Not added because they are retired:{' '}
      {items.map((item) => `${item.code} · ${item.displayName}`).join(', ')}. Pick a replacement if
      one is needed.
    </p>
  );
}

/**
 * Chips plus + Add test for one list of tests (a line, a template). `extra` is drawn after the
 * chips, before + Add test (amendments add their own chips there).
 */
export function TestPicker({
  catalogue,
  templates,
  selected,
  onChange,
  labelId,
  addLabel,
  extra,
  readOnly = false,
}: {
  catalogue: TestCatalogue;
  templates: TestTemplate[];
  selected: string[];
  onChange: (ids: string[]) => void;
  labelId: string;
  /** Accessible name of + Add test, e.g. "Add test to line 2". */
  addLabel?: string;
  extra?: ReactNode;
  readOnly?: boolean;
}) {
  const [retiredFromTemplate, setRetiredFromTemplate] = useState<TestTemplateItem[]>([]);
  const byId = new Map(catalogue.tests.map((test) => [test.id, test]));
  return (
    <div className="grid gap-1.5" role="group" aria-labelledby={labelId}>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Requested tests">
            {selected.map((testId) => {
              const test = byId.get(testId);
              return (
                <TestChip
                  key={testId}
                  label={test ? testLabel(test) : 'Unknown test'}
                  description={test?.description}
                  retired={test ? !test.active : false}
                  removeLabel={`Remove ${test?.code ?? 'test'}`}
                  onRemove={
                    readOnly ? undefined : () => onChange(selected.filter((id) => id !== testId))
                  }
                />
              );
            })}
          </ul>
        ) : extra ? null : (
          <span className="text-[13px] text-muted-foreground">No tests picked yet.</span>
        )}
        {extra}
        {readOnly ? null : (
          <AddTestButton
            catalogue={catalogue}
            templates={templates}
            selected={selected}
            accessibleLabel={addLabel}
            onAdd={(id) => onChange(selected.includes(id) ? selected : [...selected, id])}
            onTemplate={
              templates.length > 0
                ? (template) => {
                    const { add, retired } = applyTemplate(template);
                    onChange([...selected, ...add.filter((id) => !selected.includes(id))]);
                    setRetiredFromTemplate(retired);
                  }
                : undefined
            }
          />
        )}
      </div>
      <RetiredFromTemplate items={retiredFromTemplate} />
    </div>
  );
}
