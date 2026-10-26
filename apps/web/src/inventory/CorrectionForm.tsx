import {
  RECEIPT_UNIT_TYPES,
  STORAGE_UNIT_CORRECTION_REASON_MIN_LENGTH,
  storageUnitCorrectionRequestSchema,
  storageUnitTypeLabel,
  toFieldErrors,
  type FieldError,
  type HoleSummaryType,
  type LabRequestLink,
  type ProjectSummary,
  type StaffOption,
  type StorageUnitCorrectionRequestInput,
  type StorageUnitDetail,
  type StorageUnitType,
  type TestHole,
} from '@trapezoid/shared';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { listActiveStaff } from '../api/projects';
import { FormField } from '../components/ui';
import { useOnline } from '../lib/online';
import { newSummary, todayInEdmonton, type SummaryDraft } from '../receiving/draft';
import { ProjectPicker } from '../receiving/ProjectPicker';
import { SummaryEditor } from '../receiving/SummaryEditor';
import { TestHolePicker } from '../receiving/TestHolePicker';
import { correctStorageUnit } from './api';

// Correct a confirmed storage unit (TRP-T13, D45–D47): type, received date, project, test holes
// and summaries, and note. The storage unit ID, saved location and receipt header never change.

export const CONFLICT_MESSAGE =
  'Someone else changed this unit. Review the latest values and try again.';

const SUMMARIES_PATH = 'changes.holeSummaries';

function toSummaryDraft(unit: StorageUnitDetail, index: number): SummaryDraft {
  const hole = unit.holes[index]!;
  return {
    testHole: { id: hole.testHoleId, projectId: unit.project.id, name: hole.testHoleName },
    type: hole.type,
    sampleFrom: hole.sampleFrom ?? '',
    sampleTo: hole.sampleTo ?? '',
    depthFrom: hole.depthFrom === null ? '' : String(hole.depthFrom),
    depthTo: hole.depthTo === null ? '' : String(hole.depthTo),
    depthUnit: hole.depthUnit ?? '',
    customText: hole.customText ?? '',
    note: hole.note ?? '',
  };
}

function depthValue(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/** The request shape of one summary: only the chosen type's fields. */
function summaryPayload(s: SummaryDraft) {
  return {
    testHoleId: s.testHole.id,
    type: s.type as HoleSummaryType,
    note: s.note.trim(),
    ...(s.type === 'sample_range'
      ? { sampleFrom: s.sampleFrom.trim(), sampleTo: s.sampleTo.trim() }
      : {}),
    ...(s.type === 'depth_range'
      ? {
          depthFrom: depthValue(s.depthFrom),
          depthTo: depthValue(s.depthTo),
          depthUnit: s.depthUnit === '' ? null : s.depthUnit,
        }
      : {}),
    ...(s.type === 'custom' ? { customText: s.customText.trim() } : {}),
  };
}

const FIELD_LABEL: Record<string, string> = {
  reason: 'Reason',
  unitType: 'Type',
  receivedDate: 'Received date',
  projectId: 'Project',
  note: 'Note',
  holeSummaries: 'Test holes',
  testHoleId: 'Test hole',
  type: 'Summary type',
  sampleFrom: 'Sample from',
  sampleTo: 'Sample to',
  depthFrom: 'Depth from',
  depthTo: 'Depth to',
  depthUnit: 'Depth unit',
  customText: 'Custom summary',
};

function messageFor(error: FieldError): string {
  const key = error.field.split('.').at(-1) ?? error.field;
  if (key === 'reason') {
    return `Enter a reason (at least ${STORAGE_UNIT_CORRECTION_REASON_MIN_LENGTH} characters).`;
  }
  if (key === 'changes' && error.code === 'no_changes') return 'Change at least one value.';
  if (key === 'receivedDate' && error.code === 'in_future') {
    return "Received date can't be in the future.";
  }
  if (key === 'projectId') {
    return error.code === 'not_found'
      ? 'Project not found. Choose it again.'
      : 'Choose the new project, or keep the current one.';
  }
  if (key === 'holeSummaries') return 'Choose at least one test hole in the project.';
  if (key === 'type') return 'Choose a summary type: ALL, Sample range, Depth range or Custom.';
  if (key === 'depthUnit') return 'Choose ft or m.';
  if (key === 'depthTo' && error.code === 'depth_range_reversed') {
    return 'Depth to must be greater than or equal to depth from.';
  }
  if (error.code === 'test_hole_not_in_project') return 'This test hole isn’t in the project.';
  const label = FIELD_LABEL[key] ?? key;
  if (error.code === 'required') return `${label} is required.`;
  return `${label} ${error.message}.`;
}

function Changed({ when, children }: { when: boolean; children: ReactNode }) {
  return (
    <div className={when ? 'correction-field correction-changed' : 'correction-field'}>
      {children}
      {when ? <span className="badge badge-info correction-badge">Changed</span> : null}
    </div>
  );
}

export function CorrectionForm({
  unit,
  notice,
  onSaved,
  onConflict,
  onCancel,
}: {
  unit: StorageUnitDetail;
  /** Shown at the top, e.g. the conflict message after the latest values were loaded. */
  notice?: string | null;
  onSaved: (unit: StorageUnitDetail) => void;
  onConflict: () => void;
  onCancel: () => void;
}) {
  const online = useOnline();
  const initialSummaries = useMemo(
    () => unit.holes.map((_, index) => toSummaryDraft(unit, index)),
    [unit],
  );
  const [unitType, setUnitType] = useState<StorageUnitType>(unit.unitType);
  const [receivedDate, setReceivedDate] = useState(unit.receivedDate);
  const [note, setNote] = useState(unit.note ?? '');
  const [changingProject, setChangingProject] = useState(false);
  const [newProject, setNewProject] = useState<ProjectSummary | null>(null);
  const [projectQuery, setProjectQuery] = useState('');
  const [summaries, setSummaries] = useState<SummaryDraft[]>(initialSummaries);
  const [holeQuery, setHoleQuery] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [links, setLinks] = useState<LabRequestLink[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [staff, setStaff] = useState<StaffOption[]>([]);

  useEffect(() => {
    if (!changingProject) return;
    let current = true;
    listActiveStaff().then(
      (people) => current && setStaff(people),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [changingProject]);

  const projectId = changingProject ? (newProject?.id ?? null) : unit.project.id;
  const projectChanged = projectId !== null && projectId !== unit.project.id;
  const typeChanged = unitType !== unit.unitType;
  const dateChanged = receivedDate !== unit.receivedDate;
  const noteChanged = note.trim() !== (unit.note ?? '');
  const summariesChanged =
    JSON.stringify(summaries.map(summaryPayload)) !==
    JSON.stringify(initialSummaries.map(summaryPayload));

  const errorByField = new Map<string, string>();
  for (const error of errors) {
    if (!errorByField.has(error.field)) errorByField.set(error.field, messageFor(error));
  }
  const fieldError = (field: string) => errorByField.get(field) ?? null;

  const typeOptions = [...new Set<StorageUnitType>([unit.unitType, ...RECEIPT_UNIT_TYPES])];

  function request(): StorageUnitCorrectionRequestInput {
    const changes: StorageUnitCorrectionRequestInput['changes'] = {};
    if (typeChanged) changes.unitType = unitType as (typeof RECEIPT_UNIT_TYPES)[number];
    if (dateChanged) changes.receivedDate = receivedDate;
    if (noteChanged) changes.note = note;
    if (changingProject && projectId === null) changes.projectId = '';
    if (projectChanged) changes.projectId = projectId;
    if (projectChanged || summariesChanged) changes.holeSummaries = summaries.map(summaryPayload);
    return { version: unit.version, reason, changes };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setLinks([]);
    const body = request();
    const checked = storageUnitCorrectionRequestSchema.safeParse(body);
    if (!checked.success) {
      setErrors(toFieldErrors(checked.error));
      return;
    }
    if (receivedDate > todayInEdmonton()) {
      setErrors([{ field: 'changes.receivedDate', code: 'in_future', message: '' }]);
      return;
    }
    setErrors([]);
    setSaving(true);
    const result = await correctStorageUnit(unit.id, body);
    setSaving(false);
    switch (result.kind) {
      case 'saved':
        onSaved(result.unit);
        break;
      case 'conflict':
        onConflict();
        break;
      case 'lab_links':
        setLinks(result.links);
        break;
      case 'invalid':
        setErrors(result.errors);
        break;
      case 'error':
        setFailure(result.message);
        break;
    }
  }

  function keepProject() {
    setChangingProject(false);
    setNewProject(null);
    setProjectQuery('');
    setSummaries(initialSummaries);
  }

  const general = fieldError('changes');

  return (
    <form
      className="card correction-form"
      aria-labelledby="correction-heading"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <h2 id="correction-heading">Correct details</h2>
      <p className="field-hint">
        The storage unit ID {unit.readableId}, its saved location and the original receipt stay as
        they are.
      </p>
      {notice ? (
        <p className="error-state" role="alert">
          {notice}
        </p>
      ) : null}
      {general ? (
        <p className="field-error" role="alert">
          {general}
        </p>
      ) : null}

      <Changed when={typeChanged}>
        <FormField id="correction-unitType" label="Type" error={fieldError('changes.unitType')}>
          {(props) => (
            <select
              {...props}
              value={unitType}
              onChange={(e) => setUnitType(e.target.value as StorageUnitType)}
            >
              {typeOptions.map((type) => (
                <option key={type} value={type}>
                  {storageUnitTypeLabel(type)}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </Changed>

      <Changed when={dateChanged}>
        <FormField
          id="correction-receivedDate"
          label="Received date"
          hint="The minimum retain-until date (received date + 1 year) follows it."
          error={fieldError('changes.receivedDate')}
        >
          {(props) => (
            <input
              {...props}
              type="date"
              max={todayInEdmonton()}
              value={receivedDate}
              onChange={(e) => setReceivedDate(e.target.value)}
            />
          )}
        </FormField>
      </Changed>

      <Changed when={projectChanged}>
        <div id="correction-projectId">
          {changingProject ? (
            <>
              <ProjectPicker
                value={newProject}
                query={projectQuery}
                onQueryChange={setProjectQuery}
                onSelect={(project) => {
                  setNewProject(project);
                  // Test holes belong to one project: choose them again in the new one.
                  setSummaries(project?.id === unit.project.id ? initialSummaries : []);
                  setHoleQuery('');
                }}
                staff={staff}
                receiverUserId={null}
                online={online}
              />
              <button type="button" onClick={keepProject}>
                Keep {unit.project.projectNumber}
              </button>
            </>
          ) : (
            <p>
              <span className="label">Project</span> {unit.project.projectNumber} —{' '}
              {unit.project.name}{' '}
              <button type="button" onClick={() => setChangingProject(true)}>
                Change project
              </button>
            </p>
          )}
          {fieldError('changes.projectId') ? (
            <p className="field-error">{fieldError('changes.projectId')}</p>
          ) : null}
        </div>
      </Changed>

      <Changed when={projectChanged || summariesChanged}>
        <div id="correction-holeSummaries">
          {projectId ? (
            <TestHolePicker
              key={projectId}
              projectId={projectId}
              selected={summaries.map((summary) => summary.testHole)}
              onChange={(holes: TestHole[]) =>
                setSummaries((current) => {
                  const byHole = new Map(current.map((s) => [s.testHole.id, s]));
                  return holes.map((hole) => byHole.get(hole.id) ?? newSummary(hole));
                })
              }
              query={holeQuery}
              onQueryChange={setHoleQuery}
              receiverUserId={null}
              online={online}
            />
          ) : (
            <p className="field-hint">Choose the new project, then this unit’s test holes.</p>
          )}
          {fieldError(SUMMARIES_PATH) ? (
            <p className="field-error">{fieldError(SUMMARIES_PATH)}</p>
          ) : null}
          {summaries.map((summary, index) => (
            <div key={summary.testHole.id}>
              <SummaryEditor
                summary={summary}
                path={`${SUMMARIES_PATH}.${index}`}
                errors={errorByField}
                onChange={(changes) =>
                  setSummaries((current) =>
                    current.map((s, i) => (i === index ? { ...s, ...changes } : s)),
                  )
                }
              />
              {fieldError(`${SUMMARIES_PATH}.${index}.testHoleId`) ? (
                <p className="field-error">{fieldError(`${SUMMARIES_PATH}.${index}.testHoleId`)}</p>
              ) : null}
            </div>
          ))}
        </div>
      </Changed>

      <Changed when={noteChanged}>
        <FormField
          id="correction-note"
          label="Storage unit note"
          error={fieldError('changes.note')}
        >
          {(props) => (
            <textarea
              {...props}
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </FormField>
      </Changed>

      <FormField
        id="correction-reason"
        label="Reason for the correction"
        hint={`Required, at least ${STORAGE_UNIT_CORRECTION_REASON_MIN_LENGTH} characters. Shown in the history.`}
        error={fieldError('reason')}
      >
        {(props) => (
          <textarea
            {...props}
            rows={2}
            maxLength={2000}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </FormField>

      {links.length > 0 ? (
        <div className="error-state" role="alert">
          <p>
            The project can’t change while these lab requests still use this unit. Resolve them
            first:
          </p>
          <ul aria-label="Unresolved lab requests">
            {links.map((link) => (
              <li key={link.id}>
                {link.label} ({link.status})
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {failure ? (
        <p className="field-error" role="alert">
          {failure}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save correction'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
      <p className="field-hint">
        Printed labels show the values at print time. Reprint if the label is now wrong.
      </p>
    </form>
  );
}
