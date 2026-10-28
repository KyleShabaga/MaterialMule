import {
  BULK_GROUP_DESCRIPTION_MAX_LENGTH,
  BULK_GROUP_REASON_MIN_LENGTH,
  bulkGroupOptionLabel,
  formatSampleIdentity,
  storageUnitStatusLabel,
  type BulkGroupSummary,
  type FieldError,
  type SampleIdentity,
  type StorageUnitDetail,
} from '@materialmule/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { listBulkGroups } from '../api/projects';
import { BandedCard, FormField } from '../components/ui';
import { useOnline } from '../lib/online';
import { sampleFields, type BulkIdentityDraft } from '../receiving/draft';
import { SampleFields } from '../receiving/SampleFields';
import { changeBulkGroup, correctBulkGroup, fetchStorageUnit } from './api';
import { BulkBadge } from './UnitContents';

// A bulk soil bucket's bulk sample on its detail page (MM-T36): the shared identity, this
// bucket's "n of N" place and every bucket of the sample (each with its own ID, status and
// saved location). Personal accounts can move this bucket to another bulk sample, or correct the
// sample's identity for all its buckets, each with a reason kept in the history (D45).

type Mode = 'view' | 'move' | 'correct';

function toDraft(identity: SampleIdentity, projectId: string, description: string | null) {
  return {
    sourceType: identity.source.type,
    testHole:
      identity.source.type === 'test_hole'
        ? { id: identity.source.testHoleId, projectId, name: identity.source.testHoleName }
        : null,
    holeQuery: '',
    locationReference:
      identity.source.type === 'standalone_location' ? identity.source.locationReference : '',
    sampleReference: identity.sampleReference ?? '',
    depthFrom: identity.depthFrom === null ? '' : String(identity.depthFrom),
    depthTo: identity.depthTo === null ? '' : String(identity.depthTo),
    depthUnit: identity.depthUnit ?? '',
    description: description ?? '',
  } satisfies BulkIdentityDraft;
}

function identityInput(draft: BulkIdentityDraft) {
  return { ...sampleFields(draft), description: draft.description };
}

const LABELS: Record<string, string> = {
  reason: 'Reason',
  groupId: 'Bulk sample',
  sourceType: 'Sampling source',
  testHoleId: 'Test hole',
  sourceLocationReference: 'Standalone sampling location',
  sampleReference: 'Sample reference',
  depthFrom: 'Depth',
  depthTo: 'Depth to',
  depthUnit: 'Depth unit',
  description: 'Description',
};

function errorMap(errors: FieldError[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const error of errors) {
    const key = error.field.split('.').at(-1) ?? '';
    const label = LABELS[key] ?? 'This';
    if (!map.has(error.field)) map.set(error.field, `${label} ${error.message}.`);
  }
  return map;
}

export function BulkSampleSection({
  unit,
  canCorrect,
  onChanged,
}: {
  unit: StorageUnitDetail;
  canCorrect: boolean;
  /** The unit as it is after a correction (history and members change too). */
  onChanged: (unit: StorageUnitDetail, message: string) => void;
}) {
  const group = unit.bulkGroup!;
  const sample = unit.sample!;
  const [mode, setMode] = useState<Mode>('view');

  return (
    <BandedCard
      id="bulk-sample"
      title="Bulk sample"
      aside={<BulkBadge sample={sample} membership={group} />}
    >
      <dl className="details">
        <dt>Bulk sample</dt>
        <dd>{formatSampleIdentity(sample)}</dd>
        <dt>Description</dt>
        <dd>{group.description ?? 'None'}</dd>
        <dt>Buckets</dt>
        <dd>
          {/* Each bucket is its own storage unit: own ID, receipt, location and history. */}
          <ol className="bulk-members" aria-label="Buckets of this bulk sample">
            {group.members.map((member) => (
              <li key={member.id}>
                {member.id === unit.id ? (
                  <strong aria-current="true">{member.readableId} (this bucket)</strong>
                ) : (
                  <Link to={`/sample-storage/${encodeURIComponent(member.readableId)}`}>
                    {member.readableId}
                  </Link>
                )}{' '}
                <span className="muted">
                  · {storageUnitStatusLabel(member.status)} · {member.location.name} · received{' '}
                  {member.receivedDate}
                </span>
              </li>
            ))}
          </ol>
        </dd>
      </dl>
      <p className="field-hint">
        The sample reference is the field label, not a storage unit ID. Bucket numbers follow the
        received date, then the storage unit ID.
      </p>

      {canCorrect && mode === 'view' ? (
        <div className="row-actions">
          <button type="button" onClick={() => setMode('move')}>
            Change bulk sample
          </button>
          <button type="button" onClick={() => setMode('correct')}>
            Correct bulk sample
          </button>
        </div>
      ) : null}
      {canCorrect && mode === 'move' ? (
        <MoveForm unit={unit} onCancel={() => setMode('view')} onSaved={onChanged} />
      ) : null}
      {canCorrect && mode === 'correct' ? (
        <IdentityForm unit={unit} onCancel={() => setMode('view')} onSaved={onChanged} />
      ) : null}
    </BandedCard>
  );
}

function ReasonField({
  id,
  value,
  onChange,
  error,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
}) {
  return (
    <FormField
      id={id}
      label="Reason"
      hint={`At least ${BULK_GROUP_REASON_MIN_LENGTH} characters. Kept in the history.`}
      error={error}
    >
      {(props) => (
        <textarea
          {...props}
          rows={2}
          maxLength={2000}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FormField>
  );
}

const CONFLICT =
  'Someone else changed this storage unit or bulk sample. Reload the page to see the latest values.';

/** Move this bucket into another bulk sample of the project, or a new one of its own. */
function MoveForm({
  unit,
  onCancel,
  onSaved,
}: {
  unit: StorageUnitDetail;
  onCancel: () => void;
  onSaved: (unit: StorageUnitDetail, message: string) => void;
}) {
  const online = useOnline();
  const [groups, setGroups] = useState<BulkGroupSummary[] | 'loading' | 'error'>('loading');
  const [target, setTarget] = useState('');
  const [identity, setIdentity] = useState<BulkIdentityDraft>(() => ({
    ...toDraft(unit.sample!, unit.project.id, null),
    sampleReference: '',
    depthFrom: '',
    depthTo: '',
  }));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    listBulkGroups(unit.project.id).then(
      (list) => current && setGroups(list),
      () => current && setGroups('error'),
    );
    return () => {
      current = false;
    };
  }, [unit.project.id]);

  const others = Array.isArray(groups)
    ? groups.filter((group) => group.id !== unit.bulkGroup!.groupId)
    : [];
  const map = errorMap(errors);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setSaving(true);
    const base = { version: unit.version, reason };
    const result = await changeBulkGroup(
      unit.id,
      target === 'new'
        ? { ...base, newGroup: identityInput(identity) }
        : { ...base, groupId: target || undefined },
    );
    setSaving(false);
    if (result.kind === 'saved') onSaved(result.value, 'Bulk sample changed.');
    else if (result.kind === 'invalid') setErrors(result.errors);
    else setFailure(result.kind === 'conflict' ? CONFLICT : result.message);
  }

  return (
    <form className="correction-form" onSubmit={(event) => void submit(event)} noValidate>
      <h3>Change bulk sample</h3>
      <p className="field-hint">
        {unit.readableId} keeps its ID, receipt, location and history. Only the bulk sample it
        belongs to changes.
      </p>
      {failure ? (
        <p className="field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <FormField id="bulk-move-groupId" label="Move to" error={map.get('groupId') ?? null}>
        {(props) => (
          <select {...props} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            <option value="new">New bulk sample</option>
            {others.map((group) => (
              <option key={group.id} value={group.id}>
                {bulkGroupOptionLabel(group)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {groups === 'error' ? (
        <p className="field-error" role="alert">
          This project’s bulk samples couldn’t load.
        </p>
      ) : null}
      {target === 'new' ? (
        <SampleFields
          sample={identity}
          path="newGroup"
          errors={map}
          onChange={(changes) => setIdentity((current) => ({ ...current, ...changes }))}
          projectId={unit.project.id}
          projectNumber={unit.project.projectNumber}
          receiverUserId={null}
          online={online}
          required
          referencePlaceholder="B1"
        />
      ) : null}
      <ReasonField
        id="bulk-move-reason"
        value={reason}
        onChange={setReason}
        error={map.get('reason') ?? null}
      />
      <div className="row-actions">
        <button type="submit" className="primary" disabled={saving}>
          Save change
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Correct the bulk sample's identity: every bucket in it shows the corrected values. */
function IdentityForm({
  unit,
  onCancel,
  onSaved,
}: {
  unit: StorageUnitDetail;
  onCancel: () => void;
  onSaved: (unit: StorageUnitDetail, message: string) => void;
}) {
  const online = useOnline();
  const group = unit.bulkGroup!;
  const [identity, setIdentity] = useState<BulkIdentityDraft>(() =>
    toDraft(unit.sample!, unit.project.id, group.description),
  );
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const map = errorMap(errors);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setSaving(true);
    const result = await correctBulkGroup(group.groupId, {
      version: group.version,
      reason,
      identity: identityInput(identity),
    });
    if (result.kind === 'saved') {
      const reloaded = await fetchStorageUnit(unit.id);
      setSaving(false);
      if (reloaded.ok) {
        onSaved(
          reloaded.data,
          `Bulk sample corrected for all ${group.memberCount} bucket${group.memberCount === 1 ? '' : 's'}. Printed labels don’t show the bulk sample, so none need reprinting.`,
        );
      } else {
        setFailure('Saved. Reload the page to see the corrected bulk sample.');
      }
      return;
    }
    setSaving(false);
    if (result.kind === 'invalid') setErrors(result.errors);
    else setFailure(result.kind === 'conflict' ? CONFLICT : result.message);
  }

  return (
    <form className="correction-form" onSubmit={(event) => void submit(event)} noValidate>
      <h3>Correct bulk sample</h3>
      <p className="field-hint">
        Applies to all {group.memberCount} bucket{group.memberCount === 1 ? '' : 's'} of this bulk
        sample. The old values stay in the history.
      </p>
      {failure ? (
        <p className="field-error" role="alert">
          {failure}
        </p>
      ) : null}
      {map.get('identity') ? (
        <p className="field-error" role="alert">
          {map.get('identity')}
        </p>
      ) : null}
      <SampleFields
        sample={identity}
        path="identity"
        errors={map}
        onChange={(changes) => setIdentity((current) => ({ ...current, ...changes }))}
        projectId={unit.project.id}
        projectNumber={unit.project.projectNumber}
        receiverUserId={null}
        online={online}
        required
        referencePlaceholder="B1"
      >
        <FormField
          id="bulk-identity-description"
          label="Bulk sample description (optional)"
          error={map.get('identity.description') ?? null}
        >
          {(props) => (
            <input
              {...props}
              type="text"
              maxLength={BULK_GROUP_DESCRIPTION_MAX_LENGTH}
              value={identity.description}
              onChange={(e) =>
                setIdentity((current) => ({ ...current, description: e.target.value }))
              }
            />
          )}
        </FormField>
      </SampleFields>
      <ReasonField
        id="bulk-identity-reason"
        value={reason}
        onChange={setReason}
        error={map.get('reason') ?? null}
      />
      <div className="row-actions">
        <button type="submit" className="primary" disabled={saving}>
          Save correction
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
