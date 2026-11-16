import {
  POSITION_LABELS,
  receiverListResponseSchema,
  stationPeopleResponseSchema,
  type ReceiverOption,
  type StaffOption,
  type StationPickerPerson,
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

/** The role line under a name: the job title when known, else the position, else "Staff". */
export function roleLineOf(option: Pick<StaffOption, 'jobTitle' | 'position'>): string {
  if (option.jobTitle) return option.jobTitle;
  if (option.position) return POSITION_LABELS[option.position];
  return 'Staff';
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

/**
 * The station's own list (STRATA-131, Kyle's STRATA-36 rule): receiving-lab staff, i.e. active
 * people with the Lab Technician or Lab Manager role whatever their position, from
 * GET /api/station/people. Only people with initials can be credited, so the rest are left out.
 */
export async function loadStationPeople(): Promise<RecordingPerson[]> {
  const response = await apiFetch('/api/station/people');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return stationPeopleOf(stationPeopleResponseSchema.parse(await response.json()));
}

/** Station people with initials, as the picker lists them (the server sorts them by name). */
export function stationPeopleOf(people: readonly StationPickerPerson[]): RecordingPerson[] {
  return people.flatMap((person) =>
    person.initials
      ? [
          {
            id: person.id,
            displayName: person.displayName,
            initials: person.initials,
            roleLine: person.jobTitle ?? 'Staff',
          },
        ]
      : [],
  );
}

/** "Someone else…": all active staff by initials or name (GET /api/staff/receivers). */
export async function searchAllStaff(query: string): Promise<ReceiverOption[]> {
  const response = await apiFetch(`/api/staff/receivers?search=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return receiverListResponseSchema.parse(await response.json());
}
