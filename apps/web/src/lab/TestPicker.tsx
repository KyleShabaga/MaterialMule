import {
  applyTemplate,
  searchTests,
  testDisplayName,
  testGroupPath,
  type TestCatalogue,
  type TestTemplate,
  type TestTemplateItem,
} from '@materialmule/shared';
import { useId, useState } from 'react';

const MAX_RESULTS = 12;

/**
 * Test chips plus a catalogue search (code, name or description) with group/subgroup browsing,
 * and "Apply template". Retired tests are never offered; a template's retired tests are listed
 * for the person to replace instead of being added or dropped silently (MM-T23).
 */
export function TestPicker({
  catalogue,
  templates,
  selected,
  onChange,
  labelId,
}: {
  catalogue: TestCatalogue;
  templates: TestTemplate[];
  selected: string[];
  onChange: (ids: string[]) => void;
  labelId: string;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [retiredFromTemplate, setRetiredFromTemplate] = useState<TestTemplateItem[]>([]);
  const byId = new Map(catalogue.tests.map((test) => [test.id, test]));
  const active = catalogue.tests.filter((test) => test.active && !selected.includes(test.id));
  const inGroup = group
    ? active.filter(
        (test) =>
          test.groupId === group.split(':')[0] &&
          (!group.includes(':') || test.subgroupId === group.split(':')[1]),
      )
    : active;
  const results = query.trim() || group ? searchTests(inGroup, query).slice(0, MAX_RESULTS) : [];
  const activeTemplates = templates.filter((template) => template.active);

  function apply() {
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    const { add, retired } = applyTemplate(template);
    onChange([...selected, ...add.filter((testId) => !selected.includes(testId))]);
    setRetiredFromTemplate(retired);
  }

  return (
    <div className="test-picker" role="group" aria-labelledby={labelId}>
      {selected.length > 0 ? (
        <ul className="chips" aria-label="Requested tests">
          {selected.map((testId) => {
            const test = byId.get(testId);
            const name = test ? `${test.code} · ${testDisplayName(test)}` : 'Unknown test';
            return (
              <li
                key={testId}
                className={test && !test.active ? 'chip-retired' : undefined}
                title={test?.description}
              >
                <span className="chip-text">
                  {name}
                  {test && !test.active ? ' (retired)' : ''}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${test?.code ?? 'test'}`}
                  onClick={() => onChange(selected.filter((other) => other !== testId))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="field-hint">No tests picked yet.</p>
      )}
      <div className="test-picker-search">
        <label htmlFor={`${id}-q`}>Find a test</label>
        <input
          id={`${id}-q`}
          type="search"
          value={query}
          placeholder="Code, name or description"
          onChange={(event) => setQuery(event.target.value)}
        />
        <label htmlFor={`${id}-g`}>Group</label>
        <select id={`${id}-g`} value={group} onChange={(event) => setGroup(event.target.value)}>
          <option value="">All groups</option>
          {catalogue.groups.map((g) => [
            <option key={g.id} value={g.id}>
              {g.name}
            </option>,
            ...g.subgroups.map((s) => (
              <option key={s.id} value={`${g.id}:${s.id}`}>
                {testGroupPath(g.name, s.name)}
              </option>
            )),
          ])}
        </select>
      </div>
      {results.length > 0 ? (
        <ul className="test-results" aria-label="Matching tests">
          {results.map((test) => (
            <li key={test.id}>
              <button type="button" onClick={() => onChange([...selected, test.id])}>
                <span className="mono">{test.code}</span> {testDisplayName(test)}
              </button>
              <span className="field-hint">
                {testGroupPath(test.groupName, test.subgroupName)}
                {test.name ? ` — ${test.description}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : query.trim() || group ? (
        <p className="field-hint">No available test matches.</p>
      ) : null}
      {activeTemplates.length > 0 ? (
        <div className="test-picker-template">
          <label htmlFor={`${id}-t`}>Template</label>
          <select
            id={`${id}-t`}
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
          >
            <option value="">Choose a template</option>
            {activeTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} ({template.items.length} tests)
              </option>
            ))}
          </select>
          <button type="button" onClick={apply} disabled={!templateId}>
            Apply template
          </button>
        </div>
      ) : null}
      {retiredFromTemplate.length > 0 ? (
        <p className="notice notice-warning" role="status">
          Not added because they are retired:{' '}
          {retiredFromTemplate.map((item) => `${item.code} · ${item.displayName}`).join(', ')}. Pick
          a replacement if one is needed.
        </p>
      ) : null}
    </div>
  );
}
