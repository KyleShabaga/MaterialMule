import type { StaffOption } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StaffOptionGroups } from './StaffOptionGroups';

// MM-T61: PM/PE and review engineer lists are grouped, not filtered. Fictional people only.

const PE: StaffOption = { id: 'pe', displayName: 'Pat Example', initials: 'PE', position: 'pm_pe' };
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
    <select aria-label="PM/PE">
      <StaffOptionGroups staff={staff} current={current} />
    </select>,
  );
  const select = screen.getByRole('combobox', { name: 'PM/PE' });
  const group = (label: string) =>
    within(select)
      .getAllByRole('group')
      .find((element) => element.getAttribute('label') === label);
  return { group };
}

describe('StaffOptionGroups (MM-T61)', () => {
  it('lists PM/PEs and engineers first, then everyone else, as "JS · Jordan Smith"', () => {
    const { group } = renderList([NEW, AT, DE, PE]);
    expect(
      within(group('PM/PE and Engineers')!)
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
    const formerPm: StaffOption = { ...AT, id: 'former', displayName: 'Former Pm', initials: 'FP' };
    const { group } = renderList([AT, PE], formerPm);
    expect(
      within(group('PM/PE and Engineers')!)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['FP · Former Pm', 'PE · Pat Example']);
  });
});
