import type { AcceptanceDelegates } from '@materialmule/shared';
import { useId, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ReasonForm } from './ReasonDialog';
import { addDelegate, endDelegate } from './team-api';
import type { RunWrite } from './TeamSections';

// The person drawer's "Acceptance delegate" (MM-T25, owner decision 2026-10-25; board
// R4PersonDrawer). Only the project's Lead Project Engineer adds and revokes delegates: the server
// reports it as `canManage` and checks it again. A delegate may accept reviewed tests on this
// project only, never close a program or change priority. Adding and ending each need a reason
// (D15); ending blocks new acceptances at once and earlier acceptances keep their name.

export function AcceptanceDelegateSection({
  projectId,
  projectNumber,
  person,
  delegates,
  run,
  onChange,
}: {
  projectId: string;
  projectNumber: string;
  person: { userId: string; name: string };
  delegates: AcceptanceDelegates | null;
  run: RunWrite;
  onChange: (next: AcceptanceDelegates) => void;
}) {
  const headingId = useId();
  const switchId = useId();
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  if (!delegates) return null;
  const grant = delegates.active.find((d) => d.delegate.userId === person.userId) ?? null;
  const first = person.name.split(' ')[0] ?? person.name;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          Acceptance delegate
        </h3>
        <span className="text-[13px] text-muted-foreground">Lead only</span>
      </div>
      <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
        <div className="flex flex-col gap-1 text-sm">
          <Label htmlFor={switchId} className="font-normal">
            {grant
              ? `${first} can accept work on the lead’s behalf on this project.`
              : `${first} isn’t an acceptance delegate here.`}
          </Label>
          <p className="text-[13px] text-muted-foreground">
            Only the project’s Lead Project Engineer manages acceptance delegates. A reason is asked
            when you change it.
          </p>
        </div>
        <Switch
          id={switchId}
          checked={grant !== null}
          disabled={!delegates.canManage || busy || changing}
          aria-label={`Acceptance delegate on ${projectNumber}`}
          onCheckedChange={() => setChanging(true)}
        />
      </div>
      {changing && delegates.canManage ? (
        <ReasonForm
          title={
            grant
              ? `End ${person.name}’s acceptance delegate grant?`
              : `Make ${person.name} an acceptance delegate?`
          }
          confirmLabel={grant ? 'End grant' : 'Add delegate'}
          busy={busy}
          onCancel={() => setChanging(false)}
          onConfirm={async (reason) => {
            setBusy(true);
            const ok = grant
              ? await run(
                  endDelegate(projectId, grant.id, reason),
                  `Ended ${person.name}’s acceptance delegate grant.`,
                  onChange,
                )
              : await run(
                  addDelegate(projectId, {
                    delegateUserId: person.userId,
                    reason,
                    idempotencyKey: key,
                  }),
                  `Added ${person.name} as an acceptance delegate.`,
                  onChange,
                );
            setBusy(false);
            setKey(crypto.randomUUID());
            if (ok) setChanging(false);
          }}
        >
          {grant
            ? 'The grant ends now. Earlier work keeps their name.'
            : 'They may accept reviewed tests on this project. They can’t close programs or change priority.'}
        </ReasonForm>
      ) : null}
    </section>
  );
}
