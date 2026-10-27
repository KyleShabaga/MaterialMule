import { storageUnitStatusLabel, type StorageUnitStatus } from '@materialmule/shared';
import { StatusBadge, type BadgeTone } from '../components/ui';

const TONES: Record<StorageUnitStatus, BadgeTone> = {
  in_stock: 'success',
  approved_for_disposal: 'warning',
  disposed: 'neutral',
};

export function StorageUnitStatusBadge({ status }: { status: StorageUnitStatus }) {
  return <StatusBadge tone={TONES[status]}>{storageUnitStatusLabel(status)}</StatusBadge>;
}
