import { formatPerson, type StaffOption } from '@materialmule/shared';

/** Positions listed first wherever a Lead Project Engineer or review engineer is chosen (MM-T61). */
const PROJECT_POSITIONS = new Set(['project_engineer', 'engineer']);

/**
 * `<option>`s for choosing a Lead Project Engineer or review engineer: "Lead Project Engineer and Engineers" first, then
 * "Other staff". Grouped, not filtered (decided 2026-10-27): real project engineers added ahead of time have no
 * position until their first sign-in. `current` (the project's person now) is always offered, in
 * the first group, even if they are no longer active or their position changed.
 */
export function StaffOptionGroups({
  staff,
  current = null,
}: {
  staff: StaffOption[];
  current?: StaffOption | null;
}) {
  const others = staff.filter((person) => person.id !== current?.id);
  const first = [
    ...(current ? [current] : []),
    ...others.filter((person) => person.position && PROJECT_POSITIONS.has(person.position)),
  ];
  const rest = others.filter(
    (person) => !person.position || !PROJECT_POSITIONS.has(person.position),
  );
  const option = (person: StaffOption) => (
    <option key={person.id} value={person.id}>
      {formatPerson(person.initials, person.displayName)}
    </option>
  );
  return (
    <>
      {first.length > 0 ? (
        <optgroup label="Lead Project Engineer and Engineers">{first.map(option)}</optgroup>
      ) : null}
      {rest.length > 0 ? <optgroup label="Other staff">{rest.map(option)}</optgroup> : null}
    </>
  );
}
