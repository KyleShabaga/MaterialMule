import type { StaffOption } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StaffOptionGroups } from './StaffOptionGroups';

// MM-T61: Lead Project Engineer and review engineer lists are grouped, not filtered. Since
// MISC-06 the first group is Engineers (the retired Project Engineer position folded into it).
// Fictional people only.

const PE: StaffOption = {
  id: 'pe',
  displayName: 'Pat Example',
  initials: 'PE',
  position: 'engineer',
};
const DE: StaffOption = {
  id: 'de',
  displayName: 'Dana Example',
  initials: 'DE',
  position: 'engineer',
};
const AT: StaffOption = {
  id: 'at',
  displayName: 'Alex Tester',
  initials: 'AT',
  position: 'technician',
};
const NEW: StaffOption = { id: 'rn', displayName: 'Riley New', initials: 'RN', position: null };

function renderList(staff: StaffOption[], current?: StaffOption | null) {
  render(
    <select aria-label="Lead Project Engineer">
      <StaffOptionGroups staff={staff} current={current} />
    </select>,
  );
  const select = screen.getByRole('combobox', { name: 'Lead Project Engineer' });
  const group = (label: string) =>
    within(select)
      .getAllByRole('group')
      .find((element) => element.getAttribute('label') === label);
  return { group };
}

describe('StaffOptionGroups (MM-T61)', () => {
  it('lists Lead Project Engineers and engineers first, then everyone else, as "JS · Jordan Smith"', () => {
    const { group } = renderList([NEW, AT, DE, PE]);
    expect(
      within(group('Lead Project Engineer and Engineers')!)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['DE · Dana Example', 'PE · Pat Example']);
    expect(
      within(group('Other staff')!)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['RN · Riley New', 'AT · Alex Tester']);
  });

  it("always offers the project's current person first, even with another position", () => {
    const formerLead: StaffOption = {
      ...AT,
      id: 'former',
      displayName: 'Former Lead',
      initials: 'FL',
    };
    const { group } = renderList([AT, PE], formerLead);
    expect(
      within(group('Lead Project Engineer and Engineers')!)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['FL · Former Lead', 'PE · Pat Example']);
  });
});
