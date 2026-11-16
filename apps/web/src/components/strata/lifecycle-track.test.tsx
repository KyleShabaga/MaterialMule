import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CONCRETE_SET_STEPS, LifecycleTrack, STORAGE_UNIT_STEPS } from './lifecycle-track';

const items = (name = 'Lifecycle') =>
  within(screen.getByRole('list', { name })).getAllByRole('listitem');

describe('LifecycleTrack', () => {
  it('is one ordered list with aria-current on the current step', () => {
    render(<LifecycleTrack steps={STORAGE_UNIT_STEPS} current="short_term" />);
    expect(screen.getByRole('list', { name: 'Lifecycle' }).tagName).toBe('OL');
    const li = items();
    expect(li).toHaveLength(5);
    expect(li.map((item) => item.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'step',
      null,
      null,
    ]);
  });

  it('writes past, current and future states for screen readers', () => {
    render(<LifecycleTrack steps={STORAGE_UNIT_STEPS} current="short_term" />);
    const li = items();
    expect(li[0]?.textContent).toBe('Received, done');
    expect(li[1]?.textContent).toBe('In lab, done');
    expect(li[2]?.textContent).toContain('Short-term storage, current');
    expect(li[4]?.textContent).toBe('Disposed');
    expect(li[0]?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(li[2]?.className).toContain('bg-stage-storage-mark');
    expect(li[4]?.className).toContain('bg-muted');
  });

  it('shows short names with the full name in the title and for screen readers', () => {
    render(<LifecycleTrack steps={STORAGE_UNIT_STEPS} current="received" />);
    const named = screen.getByTitle('Long-term storage');
    expect(within(named).getByText('Long-term').getAttribute('aria-hidden')).toBe('true');
    expect(within(named).getByText('Long-term storage').className).toBe('sr-only');
  });

  it('reads a step passed without doing it as skipped, with no check', () => {
    render(
      <LifecycleTrack steps={STORAGE_UNIT_STEPS} current="long_term" passedWithout={['in_lab']} />,
    );
    const li = items();
    expect(li[1]?.textContent).toBe('In lab, skipped');
    expect(li[1]?.querySelector('svg')).toBeNull();
    expect(li[2]?.textContent).toContain('Short-term storage, done');
  });

  it('keeps the compact form one list with aria-current and the step written beside', () => {
    const { container } = render(
      <LifecycleTrack steps={STORAGE_UNIT_STEPS} current="in_lab" compact label="Unit lifecycle" />,
    );
    expect(container.querySelectorAll('ol')).toHaveLength(1);
    const li = items('Unit lifecycle');
    expect(li.map((item) => item.textContent)).toEqual([
      'Received, done',
      'In lab, current',
      'Short-term storage',
      'Long-term storage',
      'Disposed',
    ]);
    expect(li[1]?.getAttribute('aria-current')).toBe('step');
    const beside = screen.getByText('In lab');
    expect(beside.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders every step as future when current is unknown', () => {
    render(<LifecycleTrack steps={CONCRETE_SET_STEPS} current="nope" />);
    const li = items();
    expect(li).toHaveLength(4);
    expect(li.every((item) => item.getAttribute('aria-current') === null)).toBe(true);
    expect(li.map((item) => item.textContent)).toEqual(['Cast', 'Received', 'Testing', 'Reported']);
  });

  it('renders an unknown current in compact form without a written step', () => {
    const { container } = render(
      <LifecycleTrack steps={CONCRETE_SET_STEPS} current="nope" compact />,
    );
    expect(container.querySelector('[aria-current]')).toBeNull();
    expect(container.querySelector('ol + span')).toBeNull();
  });
});
