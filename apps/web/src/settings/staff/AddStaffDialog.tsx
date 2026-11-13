import {
  POSITIONS,
  POSITION_LABELS,
  type StaffMember,
  type StaffPosition,
} from '@materialmule/shared';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { isStaffForbidden, staffApi, staffErrorMessage } from './api';
import { ErrorAlert, LabelledSelect, TOUCH } from './staff-ui';

const NOT_SET = 'none';

/** Add someone before their first Microsoft sign-in (pre-provisioning). */
export function AddStaffDialog({
  open,
  canPosition,
  onClose,
  onAdded,
  onForbidden,
}: {
  open: boolean;
  canPosition: boolean;
  onClose: () => void;
  onAdded: (member: StaffMember) => void;
  onForbidden: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      {open ? (
        <AddStaffForm
          canPosition={canPosition}
          onAdded={onAdded}
          onForbidden={onForbidden}
          onClose={onClose}
        />
      ) : null}
    </Dialog>
  );
}

function AddStaffForm({
  canPosition,
  onAdded,
  onForbidden,
  onClose,
}: {
  canPosition: boolean;
  onAdded: (member: StaffMember) => void;
  onForbidden: () => void;
  onClose: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [initials, setInitials] = useState('');
  const [upn, setUpn] = useState('');
  const [position, setPosition] = useState<StaffPosition | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const initialsId = useId();
  const upnId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAdded(
        await staffApi.preprovision({
          displayName,
          officialInitials: initials,
          expectedUpn: upn,
          position: position || null,
        }),
      );
    } catch (caught) {
      if (isStaffForbidden(caught)) onForbidden();
      else setError(staffErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Add staff</DialogTitle>
        <DialogDescription>
          Add someone before their first Microsoft sign-in. Their account links only when they sign
          in with exactly this work email; never by initials or name.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => void submit(event)} className="grid gap-4">
        {error ? <ErrorAlert title={error} /> : null}
        <Field>
          <FieldLabel htmlFor={nameId}>Full name</FieldLabel>
          <Input
            id={nameId}
            required
            className={TOUCH}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={initialsId}>Official initials</FieldLabel>
          <Input
            id={initialsId}
            required
            maxLength={5}
            className={cn('font-mono', TOUCH)}
            value={initials}
            onChange={(e) => setInitials(e.target.value.toUpperCase())}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={upnId}>Work email (sign-in name)</FieldLabel>
          <Input
            id={upnId}
            required
            type="email"
            className={TOUCH}
            value={upn}
            onChange={(e) => setUpn(e.target.value)}
          />
        </Field>
        {canPosition ? (
          <LabelledSelect
            label="Position"
            value={position || NOT_SET}
            onValueChange={(value) =>
              setPosition(value === NOT_SET ? '' : (value as StaffPosition))
            }
            options={[
              { value: NOT_SET, label: 'Not set' },
              ...POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] })),
            ]}
          />
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" className={TOUCH} disabled={busy}>
            Add staff
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
