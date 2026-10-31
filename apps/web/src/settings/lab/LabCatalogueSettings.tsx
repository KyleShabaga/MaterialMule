import {
  SAMPLE_TAG_MODES,
  SAMPLE_TAG_MODE_LABEL,
  searchTests,
  testDisplayName,
  testGroupPath,
  testGroupSchema,
  testSubgroupSchema,
  testTemplateSchema,
  testTypeSchema,
  type SampleTagMode,
  type TestCatalogue,
  type TestTemplate,
  type TestType,
} from '@materialmule/shared';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { DataTable, EmptyState, ErrorState, FormField, StatusBadge } from '../../components/ui';
import { catalogueWrite, fetchCatalogue, fetchTemplates, type WriteResult } from '../../lab/api';
import { TestPicker } from '../../lab/TestPicker';
import { useMe } from '../../session/context';

// Settings → Tests and Settings → Templates (MM-T23). Only Lab Managers and administrators
// (`test_catalog.manage`) see them (MISC-04); they add, edit, retire and restore. Nothing is deleted:
// retired tests leave new selection while submitted requests keep their snapshots.

export const NOT_ALLOWED_TEXT = 'Only Lab Managers and administrators can change the catalogue.';

function problem(result: Exclude<WriteResult<unknown>, { ok: true }>): string {
  if (result.kind === 'conflict') {
    if (result.code === 'test_code_exists') return 'A test with this code already exists.';
    if (result.code === 'test_template_exists') return 'A template with this name already exists.';
    if (result.code === 'test_group_exists' || result.code === 'test_subgroup_exists') {
      return 'That name is already used here.';
    }
    return 'Someone else changed this first. The list has been refreshed; try again.';
  }
  if (result.kind === 'invalid') {
    return result.errors.map((e) => `${e.field}: ${e.message}`).join(' ') || 'Check the details.';
  }
  if (result.kind === 'forbidden') return NOT_ALLOWED_TEXT;
  return 'Couldn’t save. Try again.';
}

function useCatalogue() {
  const [catalogue, setCatalogue] = useState<TestCatalogue | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    fetchCatalogue().then(setCatalogue, () => setFailed(true));
  }, []);
  useEffect(reload, [reload]);
  return { catalogue, failed, reload };
}

function TestsSettings() {
  const me = useMe();
  const allowed = me.permissions.includes('test_catalog.manage');
  const { catalogue, failed, reload } = useCatalogue();
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<TestType | null>(null);

  if (failed) return <ErrorState message="The catalogue couldn’t be loaded." onRetry={reload} />;
  if (!catalogue) return <p aria-busy="true">Loading the catalogue…</p>;

  async function act(result: Promise<WriteResult<unknown>>, done: string) {
    const outcome = await result;
    setMessage(outcome.ok ? done : problem(outcome));
    if (outcome.ok) setEditing(null);
    reload();
    return outcome.ok;
  }

  const tests = searchTests(catalogue.tests, query);
  return (
    <section aria-labelledby="tests-heading">
      <h2 id="tests-heading">Tests</h2>
      <p className="field-hint">
        Each test keeps its exact code and full description. Soils and Advanced Soils only; no costs
        are stored.{allowed ? '' : ` ${NOT_ALLOWED_TEXT}`}
      </p>
      {message ? (
        <p className="notice" role="status">
          {message}
        </p>
      ) : null}
      {allowed ? (
        <>
          <TestForm
            key={editing?.id ?? 'new'}
            catalogue={catalogue}
            test={editing}
            onCancel={editing ? () => setEditing(null) : undefined}
            onSubmit={(body) =>
              act(
                editing
                  ? catalogueWrite(
                      `/api/test-types/${editing.id}`,
                      'PATCH',
                      { version: editing.version, ...body },
                      (b) => testTypeSchema.parse(b),
                    )
                  : catalogueWrite('/api/test-types', 'POST', body, (b) => testTypeSchema.parse(b)),
                editing ? `Saved ${body.code}.` : `Added ${body.code}.`,
              )
            }
          />
          <GroupForms
            catalogue={catalogue}
            onDone={(text) => {
              setMessage(text);
              reload();
            }}
          />
        </>
      ) : null}
      <div className="form-field">
        <label htmlFor="tests-search">Search tests</label>
        <input
          id="tests-search"
          type="search"
          value={query}
          placeholder="Code, name or description"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <DataTable
        caption="Lab tests"
        rows={tests}
        rowKey={(test) => test.id}
        empty={
          catalogue.tests.length === 0
            ? 'No tests yet. The catalogue is filled from the verified lab workbook.'
            : 'No test matches.'
        }
        columns={[
          { header: 'Code', cell: (test) => <span className="mono">{test.code}</span> },
          {
            header: 'Test',
            cell: (test) => (
              <>
                {testDisplayName(test)}
                {test.name ? <p className="field-hint">{test.description}</p> : null}
              </>
            ),
          },
          { header: 'Group', cell: (test) => testGroupPath(test.groupName, test.subgroupName) },
          {
            header: 'Sample ID tag',
            cell: (test) =>
              test.sampleTagMode === 'shared'
                ? `Shared: ${test.sampleTagGroup ?? ''}`
                : SAMPLE_TAG_MODE_LABEL[test.sampleTagMode],
          },
          {
            header: 'Status',
            cell: (test) =>
              test.active ? (
                <StatusBadge tone="success">Available</StatusBadge>
              ) : (
                <StatusBadge>Retired</StatusBadge>
              ),
          },
          ...(allowed
            ? [
                {
                  header: 'Actions',
                  cell: (test: TestType) => (
                    <div className="row-actions">
                      <button type="button" onClick={() => setEditing(test)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void act(
                            catalogueWrite(
                              `/api/test-types/${test.id}/${test.active ? 'retire' : 'restore'}`,
                              'POST',
                              { version: test.version },
                              (b) => testTypeSchema.parse(b),
                            ),
                            `${test.active ? 'Retired' : 'Restored'} ${test.code}.`,
                          )
                        }
                      >
                        {test.active ? 'Retire' : 'Restore'}
                      </button>
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}

function TestForm({
  catalogue,
  test,
  onSubmit,
  onCancel,
}: {
  catalogue: TestCatalogue;
  test: TestType | null;
  onSubmit: (body: {
    groupId: string;
    subgroupId: string | null;
    code: string;
    name: string | null;
    description: string;
    sampleTagMode: SampleTagMode;
    sampleTagGroup: string | null;
  }) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const initialPlace = test
    ? test.subgroupId
      ? `${test.groupId}:${test.subgroupId}`
      : test.groupId
    : (catalogue.groups[0]?.id ?? '');
  const [place, setPlace] = useState(initialPlace);
  const [code, setCode] = useState(test?.code ?? '');
  const [name, setName] = useState(test?.name ?? '');
  const [description, setDescription] = useState(test?.description ?? '');
  const [tagMode, setTagMode] = useState<SampleTagMode>(test?.sampleTagMode ?? 'own');
  const [tagGroup, setTagGroup] = useState(test?.sampleTagGroup ?? '');
  const [busy, setBusy] = useState(false);
  const missing =
    !place || !code.trim() || !description.trim() || (tagMode === 'shared' && !tagGroup.trim());
  // Existing shared groups, offered so the same group is typed the same way.
  const tagGroups = [
    ...new Set(catalogue.tests.flatMap((t) => (t.sampleTagGroup ? [t.sampleTagGroup] : []))),
  ].sort((a, b) => a.localeCompare(b));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (missing) return;
    setBusy(true);
    const [groupId, subgroupId] = place.split(':');
    const ok = await onSubmit({
      groupId: groupId!,
      subgroupId: subgroupId ?? null,
      code,
      name: name.trim() || null,
      description,
      sampleTagMode: tagMode,
      sampleTagGroup: tagMode === 'shared' ? tagGroup.trim() : null,
    });
    setBusy(false);
    if (ok && !test) {
      setCode('');
      setName('');
      setDescription('');
      setTagMode('own');
      setTagGroup('');
    }
  }

  return (
    <form
      className="inline-form catalogue-form"
      onSubmit={submit}
      aria-label={test ? `Edit ${test.code}` : 'Add a test'}
    >
      <h3>{test ? `Edit ${test.code}` : 'Add a test'}</h3>
      <FormField label="Group">
        {(props) => (
          <select {...props} value={place} onChange={(event) => setPlace(event.target.value)}>
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
        )}
      </FormField>
      <FormField label="Code" hint="Exactly as in the source, e.g. LAB_MAT-01">
        {(props) => (
          <input {...props} value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />
        )}
      </FormField>
      <FormField
        label="Short name (optional)"
        hint="Shown in pickers; the full description is kept too."
      >
        {(props) => (
          <input
            {...props}
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Full description">
        {(props) => (
          <textarea
            {...props}
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Sample ID tag"
        hint="No tag: e.g. moisture content. Shared: one tag for every test of the group on the same sample and depth."
      >
        {(props) => (
          <select
            {...props}
            value={tagMode}
            onChange={(e) => setTagMode(e.target.value as SampleTagMode)}
          >
            {SAMPLE_TAG_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {SAMPLE_TAG_MODE_LABEL[mode]}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {tagMode === 'shared' ? (
        <FormField label="Tag group" hint="e.g. Grain size. Same name, same tag.">
          {(props) => (
            <>
              <input
                {...props}
                value={tagGroup}
                maxLength={60}
                list="sample-tag-groups"
                onChange={(e) => setTagGroup(e.target.value)}
              />
              <datalist id="sample-tag-groups">
                {tagGroups.map((group) => (
                  <option key={group} value={group} />
                ))}
              </datalist>
            </>
          )}
        </FormField>
      ) : null}
      <div className="form-actions">
        {onCancel ? (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="primary" disabled={busy || missing}>
          {test ? 'Save test' : 'Add test'}
        </button>
      </div>
    </form>
  );
}

function GroupForms({
  catalogue,
  onDone,
}: {
  catalogue: TestCatalogue;
  onDone: (message: string) => void;
}) {
  const [groupName, setGroupName] = useState('');
  const [subgroupName, setSubgroupName] = useState('');
  const [parent, setParent] = useState(catalogue.groups[0]?.id ?? '');

  async function addGroup(event: FormEvent) {
    event.preventDefault();
    const result = await catalogueWrite('/api/test-groups', 'POST', { name: groupName }, (b) =>
      testGroupSchema.parse(b),
    );
    onDone(result.ok ? `Added group ${groupName}.` : problem(result));
    if (result.ok) setGroupName('');
  }
  async function addSubgroup(event: FormEvent) {
    event.preventDefault();
    const result = await catalogueWrite(
      '/api/test-subgroups',
      'POST',
      { groupId: parent, name: subgroupName },
      (b) => testSubgroupSchema.parse(b),
    );
    onDone(result.ok ? `Added subgroup ${subgroupName}.` : problem(result));
    if (result.ok) setSubgroupName('');
  }

  return (
    <details className="group-forms">
      <summary>Groups and subgroups</summary>
      <form onSubmit={addSubgroup} className="inline-form" aria-label="Add a subgroup">
        <FormField label="Group">
          {(props) => (
            <select {...props} value={parent} onChange={(e) => setParent(e.target.value)}>
              {catalogue.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="New subgroup">
          {(props) => (
            <input
              {...props}
              value={subgroupName}
              onChange={(e) => setSubgroupName(e.target.value)}
            />
          )}
        </FormField>
        <button type="submit" disabled={!subgroupName.trim() || !parent}>
          Add subgroup
        </button>
      </form>
      <form onSubmit={addGroup} className="inline-form" aria-label="Add a group">
        <FormField label="New group">
          {(props) => (
            <input {...props} value={groupName} onChange={(e) => setGroupName(e.target.value)} />
          )}
        </FormField>
        <button type="submit" disabled={!groupName.trim()}>
          Add group
        </button>
      </form>
    </details>
  );
}

function TemplatesSettings() {
  const me = useMe();
  const allowed = me.permissions.includes('test_catalog.manage');
  const { catalogue, failed, reload: reloadCatalogue } = useCatalogue();
  const [templates, setTemplates] = useState<TestTemplate[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [tests, setTests] = useState<string[]>([]);
  const reload = useCallback(() => {
    fetchTemplates().then(setTemplates, () => setTemplates([]));
    reloadCatalogue();
  }, [reloadCatalogue]);
  useEffect(reload, [reload]);

  if (failed) return <ErrorState message="The catalogue couldn’t be loaded." onRetry={reload} />;
  if (!catalogue || !templates) return <p aria-busy="true">Loading templates…</p>;

  async function act(result: Promise<WriteResult<unknown>>, done: string) {
    const outcome = await result;
    setMessage(outcome.ok ? done : problem(outcome));
    reload();
    return outcome.ok;
  }

  return (
    <section aria-labelledby="templates-heading">
      <h2 id="templates-heading">Templates</h2>
      <p className="field-hint">
        Named sets of tests that fill a testing line in one step.
        {allowed ? '' : ` ${NOT_ALLOWED_TEXT}`}
      </p>
      {message ? (
        <p className="notice" role="status">
          {message}
        </p>
      ) : null}
      {allowed ? (
        <form
          className="inline-form"
          aria-label="Add a template"
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              catalogueWrite('/api/test-templates', 'POST', { name, testTypeIds: tests }, (b) =>
                testTemplateSchema.parse(b),
              ),
              `Added template ${name}.`,
            ).then((ok) => {
              if (ok) {
                setName('');
                setTests([]);
              }
            });
          }}
        >
          <h3 id="new-template-tests">Add a template</h3>
          <FormField label="Template name">
            {(props) => (
              <input
                {...props}
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
          <TestPicker
            labelId="new-template-tests"
            catalogue={catalogue}
            templates={[]}
            selected={tests}
            onChange={setTests}
          />
          <button type="submit" className="primary" disabled={!name.trim()}>
            Add template
          </button>
        </form>
      ) : null}
      {templates.map((template) => (
        <TemplateCard
          key={`${template.id}:${template.version}`}
          template={template}
          catalogue={catalogue}
          allowed={allowed}
          onAct={act}
        />
      ))}
    </section>
  );
}

function TemplateCard({
  template,
  catalogue,
  allowed,
  onAct,
}: {
  template: TestTemplate;
  catalogue: TestCatalogue;
  allowed: boolean;
  onAct: (result: Promise<WriteResult<unknown>>, done: string) => Promise<boolean>;
}) {
  const [tests, setTests] = useState(template.items.map((item) => item.testTypeId));
  const labelId = `template-${template.id}`;
  const changed = tests.join() !== template.items.map((item) => item.testTypeId).join();
  return (
    <div className="banded-card template-card">
      <div className="banded-card-head">
        <h3 id={labelId} className="banded-card-title">
          {template.name}
        </h3>
        {template.active ? (
          <StatusBadge tone="success">Available</StatusBadge>
        ) : (
          <StatusBadge>Retired</StatusBadge>
        )}
      </div>
      <div className="banded-card-body">
        {allowed ? (
          <>
            <TestPicker
              labelId={labelId}
              catalogue={catalogue}
              templates={[]}
              selected={tests}
              onChange={setTests}
            />
            <div className="form-actions">
              <button
                type="button"
                onClick={() =>
                  void onAct(
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
              </button>
              <button
                type="button"
                className="primary"
                disabled={!changed}
                onClick={() =>
                  void onAct(
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
              </button>
            </div>
          </>
        ) : template.items.length === 0 ? (
          <p className="field-hint">No tests yet.</p>
        ) : (
          <ul>
            {template.items.map((item) => (
              <li key={item.testTypeId}>
                <span className="mono">{item.code}</span> {item.displayName}
                {item.active ? '' : ' (retired)'}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * MISC-04: Settings → Tests and → Templates are for Lab Managers and administrators only. Others
 * get a plain refusal; lab programs still read the catalogue and templates through their own
 * pickers, and the server refuses every catalogue write to anyone else.
 */
function CatalogueGate({ title, children }: { title: string; children: ReactNode }) {
  const me = useMe();
  if (me.permissions.includes('test_catalog.manage')) return children;
  const id = `${title.toLowerCase()}-heading`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <EmptyState>{REFUSED_TEXT}</EmptyState>
    </section>
  );
}

export const REFUSED_TEXT = 'Only Lab Managers and administrators can open this page.';

export function TestsSettingsPage() {
  return (
    <CatalogueGate title="Tests">
      <TestsSettings />
    </CatalogueGate>
  );
}

export function TemplatesSettingsPage() {
  return (
    <CatalogueGate title="Templates">
      <TemplatesSettings />
    </CatalogueGate>
  );
}
