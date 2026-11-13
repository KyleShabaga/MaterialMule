import {
  POSITION_LABELS,
  receiverListResponseSchema,
  type Position,
  type ReceiverOption,
  type StaffOption,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';
import { listActiveStaff } from '../api/projects';

// Who a shared LAB station can record work as (STRATA-16/19/36). Attribution only: picking a
// person never grants their roles or permissions, and the server validates every performer it is
// sent (receiverSnapshot / findActiveStaff), so a stale browser can never credit a disabled person.

/** The person a shared LAB station is recording work for. Attribution only: grants nothing. */
export interface RecordingPerson {
  id: string;
  displayName: string;
  initials: string;
  /** Role line shown in the person menu, e.g. "Technician". */
  roleLine: string;
}

/**
 * Positions listed on "Who is working here?" without searching. The board proposed "receiving-lab
 * staff" (STRATA-36); no endpoint exposes roles to LAB, so the station lists active staff whose
 * position is a lab one. Everyone else is one "Someone else…" search away.
 */
export const STATION_POSITIONS: readonly Position[] = ['technician', 'technologist', 'lab_manager'];

/** The role line under a name: the job title when known, else the position, else "Staff". */
export function roleLineOf(option: Pick<StaffOption, 'jobTitle' | 'position'>): string {
  if (option.jobTitle) return option.jobTitle;
  if (option.position) return POSITION_LABELS[option.position];
  return 'Staff';
}

/** Only people with official initials can be credited (the receiver selector's rule). */
export function toRecordingPerson(option: StaffOption): RecordingPerson | null {
  if (!option.initials) return null;
  return {
    id: option.id,
    displayName: option.displayName,
    initials: option.initials,
    roleLine: roleLineOf(option),
  };
}

export function fromReceiver(
  option: ReceiverOption,
  staff: readonly StaffOption[] = [],
): RecordingPerson {
  const known = staff.find((member) => member.id === option.id);
  return {
    id: option.id,
    displayName: option.displayName,
    initials: option.initials,
    roleLine: known ? roleLineOf(known) : 'Staff',
  };
}

export function toReceiver(person: RecordingPerson): ReceiverOption {
  return { id: person.id, initials: person.initials, displayName: person.displayName };
}

/** Everyone who may be credited (GET /api/staff/active, which LAB may read), by name. */
export function loadActiveStaff(): Promise<StaffOption[]> {
  return listActiveStaff();
}

/** The station's own list: active lab staff with initials, by name. */
export function stationPeopleOf(staff: readonly StaffOption[]): RecordingPerson[] {
  return staff
    .filter((member) => member.position && STATION_POSITIONS.includes(member.position))
    .map(toRecordingPerson)
    .filter((person): person is RecordingPerson => person !== null);
}

/** "Someone else…": all active staff by initials or name (GET /api/staff/receivers). */
export async function searchAllStaff(query: string): Promise<ReceiverOption[]> {
  const response = await apiFetch(`/api/staff/receivers?search=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return receiverListResponseSchema.parse(await response.json());
}
