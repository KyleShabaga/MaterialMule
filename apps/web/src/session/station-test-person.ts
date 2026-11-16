import type { MeResponse } from '@materialmule/shared';
import { stationSessionKey, storeRecordingPerson } from './recording-person-store';
import type { RecordingPerson } from './station-people';

// Unit-test helper (STRATA-16): a LAB station must have someone picked before the app shell
// renders, or it goes to "Who is working here?". Tests that render routes as LAB call this first.

/** Alex Tester, the fictional technician E2E stations start with (e2e/support/lab-station.ts). */
export const TEST_STATION_PERSON: RecordingPerson = {
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
  roleLine: 'Technician',
};

/** On a LAB session, remembers `person` as picked; personal accounts are left alone. */
export function pickStationPerson(
  me: Pick<MeResponse, 'id' | 'sessionExpiresAt' | 'accountType'>,
  person: RecordingPerson = TEST_STATION_PERSON,
): void {
  if (me.accountType === 'shared_lab') storeRecordingPerson(stationSessionKey(me), person);
}
