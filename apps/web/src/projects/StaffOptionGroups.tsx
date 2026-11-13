import { formatPerson, type StaffOption } from '@materialmule/shared';
import { SelectGroup, SelectItem, SelectLabel } from '@/components/ui/select';

/**
 * Positions listed first wherever a Lead Project Engineer or review engineer is chosen (MM-T61).
 * Engineer only since MISC-06 folded Project Engineer into it; the position itself is never shown.
 * The position taxonomy only orders the list: it is never the person's job title, and grants
 * nothing.
 */
const PROJECT_POSITIONS = new Set(['engineer']);

export const FIRST_GROUP_LABEL = 'Lead Project Engineer and Engineers';
export const OTHER_GROUP_LABEL = 'Other staff';

/**
 * "Lead Project Engineer and Engineers" first, then "Other staff". Grouped, not filtered (decided
 * 2026-10-27): people added ahead of time may have no position yet. `current` (the project's
 * person now) is always offered, in the first group, even if they are no longer active or their
 * position changed.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure grouping beside its lists
export function groupStaff(
  staff: StaffOption[],
  current: StaffOption | null = null,
): { first: StaffOption[]; rest: StaffOption[] } {
  const others = staff.filter((person) => person.id !== current?.id);
  return {
    first: [
      ...(current ? [current] : []),
      ...others.filter((person) => person.position && PROJECT_POSITIONS.has(person.position)),
    ],
    rest: others.filter((person) => !person.position || !PROJECT_POSITIONS.has(person.position)),
  };
}

/** Native `<option>`s in two `<optgroup>`s (forms not yet rebuilt in Strata). */
export function StaffOptionGroups({
  staff,
  current = null,
}: {
  staff: StaffOption[];
  current?: StaffOption | null;
}) {
  const { first, rest } = groupStaff(staff, current);
  const option = (person: StaffOption) => (
    <option key={person.id} value={person.id}>
      {formatPerson(person.initials, person.displayName)}
    </option>
  );
  return (
    <>
      {first.length > 0 ? <optgroup label={FIRST_GROUP_LABEL}>{first.map(option)}</optgroup> : null}
      {rest.length > 0 ? <optgroup label={OTHER_GROUP_LABEL}>{rest.map(option)}</optgroup> : null}
    </>
  );
}

/** The same groups as shadcn `SelectGroup`s, for a `Select`'s content (STRATA-85). */
export function StaffSelectGroups({
  staff,
  current = null,
}: {
  staff: StaffOption[];
  current?: StaffOption | null;
}) {
  const { first, rest } = groupStaff(staff, current);
  const item = (person: StaffOption) => (
    <SelectItem key={person.id} value={person.id}>
      {formatPerson(person.initials, person.displayName)}
    </SelectItem>
  );
  return (
    <>
      {first.length > 0 ? (
        <SelectGroup>
          <SelectLabel>{FIRST_GROUP_LABEL}</SelectLabel>
          {first.map(item)}
        </SelectGroup>
      ) : null}
      {rest.length > 0 ? (
        <SelectGroup>
          <SelectLabel>{OTHER_GROUP_LABEL}</SelectLabel>
          {rest.map(item)}
        </SelectGroup>
      ) : null}
    </>
  );
}
