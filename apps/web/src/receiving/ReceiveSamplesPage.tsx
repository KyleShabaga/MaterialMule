import type { ProjectSummary, ReceiverOption, StaffOption, TestHole } from '@trapezoid/shared';
import { useEffect, useState } from 'react';
import { listActiveStaff } from '../api/projects';
import { ReceiverSelect } from '../components/ReceiverSelect';
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
  // A personal account receives as itself; the shared LAB station must choose who is receiving
  // (TRP-T07 ReceiverSelect: active staff only, searched by initials or name).
  const [receiver, setReceiver] = useState<ReceiverOption | null>(() =>
    me && me.accountType !== 'shared_lab' && me.initials
      ? { id: me.id, initials: me.initials, displayName: me.displayName, position: null }
      : null,
  );
  const [draft, setDraft] = useState<ReceiptDraft>(() => ({
    receiverUserId: receiver?.id ?? '',
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
        <ReceiverSelect
          label="Receiver"
          value={receiver}
          onChange={(next) => {
            setReceiver(next);
            update({ receiverUserId: next?.id ?? '' });
          }}
        />
        {staffError ? <p className="field-error">The staff list couldn't load.</p> : null}
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
