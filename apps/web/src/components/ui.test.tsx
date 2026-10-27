import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BandedCard, StatusBadge } from './ui';

describe('BandedCard', () => {
  it('is a region named by its heading, with subtitle, aside and body', () => {
    render(
      <BandedCard
        title="Receiving ZD621"
        subtitle="Printer ID: receiving-zd621"
        aside={<StatusBadge tone="success">In use</StatusBadge>}
      >
        <p>Fields go here</p>
      </BandedCard>,
    );
    const card = screen.getByRole('region', { name: 'Receiving ZD621' });
    expect(within(card).getByRole('heading', { level: 2, name: 'Receiving ZD621' })).toBeTruthy();
    expect(within(card).getByText('Printer ID: receiving-zd621')).toBeTruthy();
    expect(within(card).getByText('In use')).toBeTruthy();
    expect(within(card).getByText('Fields go here')).toBeTruthy();
  });

  it('leaves out the subtitle, aside and body when not given', () => {
    const { container } = render(<BandedCard title="Disk space" />);
    expect(container.querySelector('.banded-card-subtitle')).toBeNull();
    expect(container.querySelector('.banded-card-aside')).toBeNull();
    expect(container.querySelector('.banded-card-body')).toBeNull();
  });

  it('renders as a named group when used as a div', () => {
    render(
      <BandedCard as="div" title="Preview label" id="label-preview">
        <p>Sticker</p>
      </BandedCard>,
    );
    const group = screen.getByRole('group', { name: 'Preview label' });
    expect(group.id).toBe('label-preview');
  });

  it('marks attention cards with a class, not only a colour, and keeps extra classes', () => {
    render(
      <BandedCard title="Waiting for approval (1)" tone="attention" className="pending-staff" />,
    );
    const card = screen.getByRole('region', { name: 'Waiting for approval (1)' });
    expect(card.className).toContain('banded-card-attention');
    expect(card.className).toContain('pending-staff');
  });
});
