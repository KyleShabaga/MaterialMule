import type { ReceiverOption } from '@trapezoid/shared';
import { ReceiverSelect } from '../../components/ReceiverSelect';

/**
 * Shown when a LAB draft is resumed at the shared station (TRP-T11): the receiver stays as it
 * was until someone explicitly picks another person, and that choice is recorded in the draft's
 * history. Picking nobody changes nothing.
 */
export function ReceiverHandover({
  receiver,
  onChange,
  onKeep,
}: {
  receiver: ReceiverOption;
  onChange: (receiver: ReceiverOption) => void;
  onKeep: () => void;
}) {
  return (
    <section className="notice handover" aria-labelledby="handover-heading">
      <p id="handover-heading">
        <strong>This draft was started for {receiver.initials}. Change receiver?</strong>
      </p>
      <ReceiverSelect
        label="Change receiver to"
        value={null}
        onChange={(next) => {
          if (next) onChange(next);
        }}
      />
      <button type="button" onClick={onKeep}>
        Keep {receiver.initials}
      </button>
    </section>
  );
}
