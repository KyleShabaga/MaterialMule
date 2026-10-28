import {
  DISPOSED_AFTER_TESTING_LABEL,
  storageUnitStatusLabel,
  type StorageUnitStatus,
  type TestedRemovalReason,
} from '@materialmule/shared';
import { StatusBadge, type BadgeTone } from '../components/ui';

const TONES: Record<StorageUnitStatus, BadgeTone> = {
  in_stock: 'success',
  approved_for_disposal: 'warning',
  disposed: 'neutral',
};

/** A unit disposed through the post-testing route reads "Disposed after testing" (MM-T36). */
export function StorageUnitStatusBadge({
  status,
  testedRemovalReason = null,
}: {
  status: StorageUnitStatus;
  testedRemovalReason?: TestedRemovalReason | null;
}) {
  return (
    <StatusBadge tone={TONES[status]}>
      {status === 'disposed' && testedRemovalReason
        ? DISPOSED_AFTER_TESTING_LABEL
        : storageUnitStatusLabel(status)}
    </StatusBadge>
  );
}
