import type { ProjectSummary, StaffOption, TestHole } from '@trapezoid/shared';
import { useEffect, useState } from 'react';
import { listActiveStaff } from '../api/projects';
import { FormField, PageHeader } from '../components/ui';
import { useOnline } from '../lib/online';
import { useSession } from '../session/context';
import { ProjectPicker } from './ProjectPicker';
import { TestHolePicker } from './TestHolePicker';

/** The receipt being entered. Storage units, summaries and confirmation arrive with T09/T10. */
export interface ReceiptDraft {
  receiverUserId: string;
  receivedDate: string;
  description: string;
  projectQuery: string;
  project: ProjectSummary | null;
  holeQuery: string;
  testHoles: TestHole[];
}

/** Today's date in the lab's time zone, as YYYY-MM-DD. */
function todayInEdmonton(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton' }).format(new Date());
}

export function ReceiveSamplesPage() {
  const { session } = useSession();
  const me = session.status === 'active' ? session.me : null;
  const online = useOnline();
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [staffError, setStaffError] = useState(false);
  const [draft, setDraft] = useState<ReceiptDraft>(() => ({
    // A personal account receives as itself; the shared LAB station must choose who is receiving.
    receiverUserId: me && me.accountType !== 'shared_lab' ? me.id : '',
    receivedDate: todayInEdmonton(),
    description: '',
    projectQuery: '',
    project: null,
    holeQuery: '',
    testHoles: [],
  }));

  useEffect(() => {
    let current = true;
    listActiveStaff().then(
      (people) => current && setStaff(people),
      () => current && setStaffError(true),
    );
    return () => {
      current = false;
    };
  }, []);

  // Functional updates only touch the named fields, so creating a project or hole never clears
  // anything else in the draft (AC7).
  const update = (changes: Partial<ReceiptDraft>) =>
    setDraft((current) => ({ ...current, ...changes }));

  return (
    <>
      <PageHeader title="Receive samples" />
      {!online ? (
        <p className="badge badge-warning" role="status">
          Offline: your entries are kept here. Connect to add a project or test hole.
        </p>
      ) : null}
      <div className="card receipt-draft">
        <FormField label="Receiver" error={staffError ? "Staff list couldn't load." : null}>
          {(props) => (
            <select
              {...props}
              value={draft.receiverUserId}
              onChange={(e) => update({ receiverUserId: e.target.value })}
            >
              <option value="">Choose who is receiving</option>
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
        <FormField label="Received date">
          {(props) => (
            <input
              {...props}
              type="date"
              value={draft.receivedDate}
              onChange={(e) => update({ receivedDate: e.target.value })}
            />
          )}
        </FormField>

        <ProjectPicker
          value={draft.project}
          query={draft.projectQuery}
          onQueryChange={(projectQuery) => update({ projectQuery })}
          // Holes belong to one project, so choosing another project starts the hole list afresh.
          onSelect={(project) =>
            update(
              project?.id === draft.project?.id
                ? { project }
                : { project, testHoles: [], holeQuery: '' },
            )
          }
          staff={staff}
          receiverUserId={draft.receiverUserId || null}
          online={online}
        />

        {draft.project ? (
          <TestHolePicker
            key={draft.project.id}
            projectId={draft.project.id}
            selected={draft.testHoles}
            onChange={(testHoles) => update({ testHoles })}
            query={draft.holeQuery}
            onQueryChange={(holeQuery) => update({ holeQuery })}
            receiverUserId={draft.receiverUserId || null}
            online={online}
          />
        ) : null}

        <FormField label="Description" hint="What arrived, e.g. 4 buckets from the drill crew.">
          {(props) => (
            <textarea
              {...props}
              rows={3}
              maxLength={2000}
              value={draft.description}
              onChange={(e) => update({ description: e.target.value })}
            />
          )}
        </FormField>
        <p className="field-hint">
          Storage units, sample summaries and confirmation arrive with TRP-T09 and TRP-T10.
        </p>
      </div>
    </>
  );
}
