import type { ReceiverOption } from '@materialmule/shared';
import type { SaveState } from '../useReceiptDraft';
import { formatSavedTime, receiverText } from './format';

// Saved-state indicator in the wizard header (MM-T11): "Draft saved 10:42 · Receiver: AT", or
// a warning when storage failed. It only ever says "saved" for a write storage confirmed.

export function DraftStatusLine({
  saveState,
  receiver,
}: {
  saveState: SaveState;
  receiver: Pick<ReceiverOption, 'initials'> | null;
}) {
  if (saveState.kind === 'error') {
    return (
      <div className="draft-status draft-status-error" role="alert">
        <strong>Couldn't save draft on this device</strong> · {receiverText(receiver)}
        <span className="field-hint"> {saveState.message}</span>
      </div>
    );
  }
  return (
    <div className="draft-status">
      {saveState.kind === 'saved' ? (
        <>
          Draft saved <time dateTime={saveState.at}>{formatSavedTime(saveState.at)}</time>
        </>
      ) : (
        'Draft not saved yet'
      )}{' '}
      · {receiverText(receiver)}
    </div>
  );
}
