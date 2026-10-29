import {
  SERVER_FOLDER_PATH_MAX,
  type ProjectDetail,
  type StaffOption,
  type UpdateProjectRequest,
} from '@materialmule/shared';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { listActiveStaff } from '../api/projects';
import { FormField } from '../components/ui';
import { StaffOptionGroups } from './StaffOptionGroups';
import { updateProject } from './api';

type FieldErrors = Record<string, string[]>;

interface Draft {
  projectNumber: string;
  name: string;
  client: string;
  leadProjectEngineerId: string;
  reviewEngineerId: string;
  serverFolderPath: string;
  reason: string;
}

function draftFrom(project: ProjectDetail): Draft {
  return {
    projectNumber: project.projectNumber,
    name: project.name,
    client: project.client,
    leadProjectEngineerId: project.leadProjectEngineer.id,
    reviewEngineerId: project.reviewEngineer?.id ?? '',
    serverFolderPath: project.serverFolderPath ?? '',
    reason: '',
  };
}

/** `typed` moved onto `latest`: fields still equal to `original` take the latest value. */
function rebase(typed: Draft, original: Draft, latest: Draft): Draft {
  const next = { ...typed };
  for (const key of Object.keys(next) as (keyof Draft)[]) {
    if (typed[key] === original[key]) next[key] = latest[key];
  }
  return next;
}

/** Only the fields that differ from `project`, plus its version. */
function changedFields(project: ProjectDetail, draft: Draft): UpdateProjectRequest {
  const body: UpdateProjectRequest = { version: project.version };
  if (draft.projectNumber.trim() !== project.projectNumber) {
    body.projectNumber = draft.projectNumber;
  }
  if (draft.name.trim() !== project.name) body.name = draft.name;
  if (draft.client.trim() !== project.client) body.client = draft.client;
  if (draft.leadProjectEngineerId !== project.leadProjectEngineer.id) {
    body.leadProjectEngineerId = draft.leadProjectEngineerId;
    body.reason = draft.reason;
  }
  if (draft.reviewEngineerId !== (project.reviewEngineer?.id ?? '')) {
    body.reviewEngineerId = draft.reviewEngineerId || null;
  }
  if (draft.serverFolderPath.trim() !== (project.serverFolderPath ?? '')) {
    body.serverFolderPath = draft.serverFolderPath;
  }
  return body;
}

/**
 * Edit project (MM-T35): admins and the project's Lead Project Engineer change the number (until the first
 * receipt), name, client, review engineer and server folder path; only admins change the Lead Project Engineer,
 * with a reason. Field errors show beside each input.
 */
export function EditProjectDialog({
  project,
  onClose,
  onSaved,
  onStale,
}: {
  project: ProjectDetail;
  onClose: () => void;
  onSaved: (project: ProjectDetail) => void;
  onStale: (current: ProjectDetail) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [base, setBase] = useState(project);
  const [draft, setDraft] = useState(() => draftFrom(project));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [staff, setStaff] = useState<StaffOption[]>([]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal?.();
  }, []);

  useEffect(() => {
    let cancelled = false;
    listActiveStaff().then(
      (list) => !cancelled && setStaff(list),
      () => !cancelled && setMessage("Couldn't load staff. You can still edit other fields."),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (field: keyof Draft) => (value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  };
  const error = (field: string) => errors[field]?.join(' ') ?? null;
  const leadProjectEngineerChanging = draft.leadProjectEngineerId !== base.leadProjectEngineer.id;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (leadProjectEngineerChanging && draft.reason.trim() === '') {
      setErrors({ reason: ['Give a reason for changing the Lead Project Engineer'] });
      return;
    }
    const body = changedFields(base, draft);
    if (Object.keys(body).length === 1) {
      onClose();
      return;
    }
    setBusy(true);
    const result = await updateProject(base.id, body);
    setBusy(false);
    switch (result.kind) {
      case 'saved':
        onSaved(result.project);
        return;
      case 'invalid':
        setErrors(result.fieldErrors);
        return;
      case 'number_taken':
        setErrors({
          projectNumber: [`${result.existing.projectNumber} is already another project.`],
        });
        return;
      case 'stale':
        // Keep what was typed; fields left alone take the other person's values.
        setDraft((typed) => rebase(typed, draftFrom(base), draftFrom(result.current)));
        setBase(result.current);
        onStale(result.current);
        setErrors({});
        setMessage(
          'Someone else changed this project while you were editing. The page now shows their ' +
            'changes; check your edits and save again.',
        );
        return;
      case 'failed':
        setMessage(result.message);
        return;
    }
  }

  return (
    <dialog
      ref={ref}
      className="confirm-dialog edit-project"
      aria-labelledby={titleId}
      onCancel={onClose}
    >
      <div className="edit-project-head">
        <h2 id={titleId}>Edit project</h2>
        <span className="project-number">{base.projectNumber}</span>
      </div>
      <form noValidate onSubmit={(event) => void submit(event)}>
        {message ? (
          <p className="notice notice-warning" role="alert">
            {message}
          </p>
        ) : null}
        {error('version') || error('_') ? (
          <p className="field-error" role="alert">
            {error('version') ?? error('_')}
          </p>
        ) : null}

        <FormField
          label="Project number"
          error={error('projectNumber')}
          hint={
            base.numberLocked
              ? "Printed on existing labels, so it can't be changed."
              : 'Locks once anything is received for the project.'
          }
        >
          {(props) => (
            <input
              {...props}
              type="text"
              value={draft.projectNumber}
              maxLength={40}
              // Read-only, not disabled, so it can still be read and copied (design guide).
              readOnly={base.numberLocked}
              onChange={(event) => set('projectNumber')(event.target.value)}
            />
          )}
        </FormField>
        <div className="field-pair">
          <FormField label="Name" error={error('name')}>
            {(props) => (
              <input
                {...props}
                type="text"
                value={draft.name}
                maxLength={200}
                onChange={(event) => set('name')(event.target.value)}
              />
            )}
          </FormField>
          <FormField label="Client" error={error('client')}>
            {(props) => (
              <input
                {...props}
                type="text"
                value={draft.client}
                maxLength={200}
                onChange={(event) => set('client')(event.target.value)}
              />
            )}
          </FormField>
        </div>
        <FormField
          label="Lead Project Engineer"
          error={error('leadProjectEngineerId')}
          hint={
            base.canChangeLeadProjectEngineer
              ? undefined
              : 'Only an admin can change the Lead Project Engineer.'
          }
        >
          {(props) => (
            <select
              {...props}
              value={draft.leadProjectEngineerId}
              disabled={!base.canChangeLeadProjectEngineer}
              onChange={(event) => set('leadProjectEngineerId')(event.target.value)}
            >
              <StaffOptionGroups staff={staff} current={base.leadProjectEngineer} />
            </select>
          )}
        </FormField>
        {leadProjectEngineerChanging ? (
          <FormField label="Reason for changing the Lead Project Engineer" error={error('reason')}>
            {(props) => (
              <textarea
                {...props}
                value={draft.reason}
                maxLength={2000}
                rows={2}
                required
                onChange={(event) => set('reason')(event.target.value)}
              />
            )}
          </FormField>
        ) : null}
        <FormField label="Review engineer" error={error('reviewEngineerId')}>
          {(props) => (
            <select
              {...props}
              value={draft.reviewEngineerId}
              onChange={(event) => set('reviewEngineerId')(event.target.value)}
            >
              <option value="">None</option>
              <StaffOptionGroups staff={staff} current={base.reviewEngineer} />
            </select>
          )}
        </FormField>
        <FormField
          label="Server folder path"
          error={error('serverFolderPath')}
          hint="e.g. P:\Projects\DEMO-2601. Leave blank for none."
        >
          {(props) => (
            <input
              {...props}
              type="text"
              value={draft.serverFolderPath}
              maxLength={SERVER_FOLDER_PATH_MAX}
              spellCheck={false}
              onChange={(event) => set('serverFolderPath')(event.target.value)}
            />
          )}
        </FormField>

        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
