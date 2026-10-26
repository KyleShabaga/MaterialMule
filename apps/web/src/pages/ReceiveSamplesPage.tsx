import { formatReceiver, type ReceiverOption } from '@trapezoid/shared';
import { useState } from 'react';
import { EmptyState, PageHeader } from '../components/ui';
import { ReceiverSelect } from '../components/ReceiverSelect';

/**
 * Receive samples. The full form arrives with TRP-T10; the receiver selector (TRP-T07) is live
 * so the person who physically received the units can already be picked on the LAB station.
 */
export function ReceiveSamplesPage() {
  const [receiver, setReceiver] = useState<ReceiverOption | null>(null);
  return (
    <>
      <PageHeader title="Receive samples" />
      <section className="card receive-form" aria-label="Receiver">
        <ReceiverSelect value={receiver} onChange={setReceiver} required />
        <p role="status" className="selected-receiver">
          {receiver ? `Receiver: ${formatReceiver(receiver)}` : 'No receiver chosen yet.'}
        </p>
      </section>
      <EmptyState>The rest of the receiving form arrives with TRP-T10.</EmptyState>
    </>
  );
}
