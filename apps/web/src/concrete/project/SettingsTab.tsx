import {
  formatPerson,
  type ConcreteProjectSettings,
  type ProjectDetail,
} from '@materialmule/shared';
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { BandedCard, ErrorState, StatusBadge } from '../../components/ui';
import { useMe } from '../../session/context';
import { fetchReviewers } from '../../projects/team-api';
import { ConcreteApiError, concreteProblem, fetchSettings, saveSettings } from './api';
import { commaAges, parseAges } from './mix-format';
import { TabHead } from './TabHead';
import { useLoad } from './useLoad';

// MM-V2-C30 Settings tab: the project's concrete settings (C02: default ages, HOLD days, whether
// issued reports include machine information), editable with `project.edit` (the Lead or an
// admin); the Lead and concrete reviewers, read from Team & Permissions (MISC-08).

const machineText = (value: boolean | null) =>
  value === null ? 'Not chosen yet' : value ? 'Yes' : 'No';

export function SettingsTab({ project }: { project: ProjectDetail }) {
  const { load, reload, replace } = useLoad(`settings|${project.id}`, () =>
    fetchSettings(project.id),
  );
  return (
    <div className="concrete-tab concrete-settings concrete-narrow">
      {load.state === 'loading' ? <p role="status">Loading…</p> : null}
      {load.state === 'error' ? (
        <ErrorState message={concreteProblem(load.error)} onRetry={reload} />
      ) : null}
      {load.state === 'ready' ? (
        <SettingsForm
          key={load.data.version}
          projectId={project.id}
          settings={load.data}
          onSaved={replace}
        />
      ) : null}
      <ReviewSection project={project} />
    </div>
  );
}

function SettingsForm({
  projectId,
  settings,
  onSaved,
}: {
  projectId: string;
  settings: ConcreteProjectSettings;
  onSaved: (next: ConcreteProjectSettings) => void;
}) {
  const id = useId();
  const [ages, setAges] = useState(commaAges(settings.defaultSpecimenAges));
  const [hold, setHold] = useState(String(settings.holdDurationDays));
  const [machine, setMachine] = useState(
    settings.includeMachineInfo === null ? '' : String(settings.includeMachineInfo),
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(null);
    const parsed = parseAges(ages);
    if (!parsed) {
      setError('Enter each age as a whole number of days or HOLD, separated by commas.');
      return;
    }
    const holdDays = Number(hold);
    if (!Number.isInteger(holdDays) || holdDays < 1 || holdDays > 999) {
      setError('HOLD duration must be a whole number of days from 1 to 999.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await saveSettings(projectId, {
        version: settings.version,
        defaultSpecimenAges: parsed,
        holdDurationDays: holdDays,
        includeMachineInfo: machine === '' ? null : machine === 'true',
        reason: reason.trim() || null,
      });
      onSaved(next);
      setSaved('Concrete settings saved. Existing sets and schedules keep their dates.');
    } catch (caught) {
      if (caught instanceof ConcreteApiError && caught.code === 'version_conflict') {
        const current = (caught.body as { current?: ConcreteProjectSettings } | null)?.current;
        if (current) onSaved(current);
      }
      setError(concreteProblem(caught));
    } finally {
      setBusy(false);
    }
  }

  const head = (
    <TabHead
      id={`${id}-heading`}
      title="Concrete settings"
      hint="Starting values for sets created from now on; existing sets and schedules don’t change."
    />
  );
  const machineTag =
    settings.includeMachineInfo === null ? (
      <StatusBadge tone="waiting">Not chosen yet</StatusBadge>
    ) : null;

  if (!settings.canEdit) {
    return (
      <section className="concrete-settings-form" aria-labelledby={`${id}-heading`}>
        {head}
        <BandedCard title="Default test ages" headingLevel={3}>
          <dl className="concrete-facts">
            <div>
              <dt>Default specimen ages</dt>
              <dd className="mono">{commaAges(settings.defaultSpecimenAges)}</dd>
            </div>
          </dl>
        </BandedCard>
        <BandedCard title="Holds and reports" headingLevel={3}>
          <dl className="concrete-facts">
            <div>
              <dt>HOLD duration</dt>
              <dd>
                <span className="mono">{settings.holdDurationDays}</span> days from casting
              </dd>
            </div>
            <div>
              <dt>Machine information on issued reports</dt>
              <dd>{machineTag ?? machineText(settings.includeMachineInfo)}</dd>
            </div>
          </dl>
        </BandedCard>
        <p className="field-hint">
          Only the project’s Lead Project Engineer or an administrator can change these settings.
        </p>
      </section>
    );
  }

  return (
    <section className="concrete-settings-form" aria-labelledby={`${id}-heading`}>
      {head}
      <form
        className="concrete-form"
        aria-label="Concrete settings"
        onSubmit={(e) => void submit(e)}
      >
        <BandedCard title="Default test ages" headingLevel={3} as="div">
          <div className="concrete-field">
            <label htmlFor={`${id}-ages`}>Default specimen ages</label>
            <input
              id={`${id}-ages`}
              className="mono"
              type="text"
              value={ages}
              autoComplete="off"
              aria-describedby={`${id}-ages-hint`}
              onChange={(event) => setAges(event.target.value)}
            />
            <p id={`${id}-ages-hint`} className="field-hint">
              Days from casting or HOLD, one per specimen, e.g. 7, 28, 28, HOLD. A mix’s own ages
              win.
            </p>
          </div>
        </BandedCard>
        <BandedCard title="Holds and reports" headingLevel={3} as="div">
          <div className="concrete-fields">
            <div className="concrete-field">
              <label htmlFor={`${id}-hold`}>HOLD duration (days from casting)</label>
              <input
                id={`${id}-hold`}
                className="mono concrete-input-short"
                type="number"
                inputMode="numeric"
                min={1}
                max={999}
                value={hold}
                onChange={(event) => setHold(event.target.value)}
              />
            </div>
            <div className="concrete-field concrete-field-wide">
              <label htmlFor={`${id}-machine`}>
                Include testing machine information on issued reports
              </label>
              <select
                id={`${id}-machine`}
                value={machine}
                onChange={(event) => setMachine(event.target.value)}
              >
                <option value="">Not chosen yet (the issuer chooses)</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
              {machineTag ? <span className="concrete-field-tag">{machineTag}</span> : null}
            </div>
          </div>
        </BandedCard>
        <div className="concrete-field">
          <label htmlFor={`${id}-reason`}>Reason (optional)</label>
          <input
            id={`${id}-reason`}
            type="text"
            value={reason}
            maxLength={2000}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="notice notice-success" role="status">
          {saved}
        </p>
        <div className="page-actions concrete-actions">
          <button type="submit" className="primary" disabled={busy}>
            Save settings
          </button>
        </div>
      </form>
    </section>
  );
}

function ReviewSection({ project }: { project: ProjectDetail }) {
  const me = useMe();
  const canSeeTeam = me.permissions.includes('project_access.read');
  const { load } = useLoad(`reviewers|${project.id}|${canSeeTeam}`, async () =>
    canSeeTeam ? fetchReviewers(project.id) : null,
  );
  const lead = project.leadProjectEngineer;
  const reviewers =
    load.state === 'ready' && load.data?.ok
      ? load.data.data.active.filter((a) => a.scope.code.startsWith('concrete_'))
      : null;
  return (
    <BandedCard
      title="Lead and reviewers"
      aside={
        canSeeTeam ? (
          <Link to={`/projects/${encodeURIComponent(project.id)}/team`}>
            Team &amp; Permissions →
          </Link>
        ) : null
      }
    >
      <dl className="concrete-facts">
        <div>
          <dt>Lead Project Engineer</dt>
          <dd>{lead ? formatPerson(lead.initials, lead.displayName) : 'Waiting for a lead'}</dd>
        </div>
        <div>
          <dt>Concrete reviewers</dt>
          <dd>
            {reviewers === null ? (
              canSeeTeam ? (
                load.state === 'loading' ? (
                  'Loading…'
                ) : (
                  'Couldn’t load the reviewers.'
                )
              ) : (
                'See Team & Permissions on a personal account.'
              )
            ) : reviewers.length === 0 ? (
              'None assigned: reports go to the Lead.'
            ) : (
              <ul className="concrete-people">
                {reviewers.map((a) => (
                  <li key={a.id}>
                    {formatPerson(a.reviewer.initials, a.reviewer.name)} · {a.scope.label}
                    {a.effective ? '' : ' (not active yet)'}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      <p className="field-hint">
        The Lead assigns and approves reviewers in Team &amp; Permissions.
      </p>
    </BandedCard>
  );
}
