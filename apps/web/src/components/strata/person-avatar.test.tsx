import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PersonAvatar, PersonCell, initialsFor } from './person-avatar';

describe('initialsFor', () => {
  it('takes the first letters of the first and last words', () => {
    expect(initialsFor('Alex Tester')).toBe('AT');
    expect(initialsFor('Sam Q. Sample')).toBe('SS');
    expect(initialsFor('jordan lab')).toBe('JL');
  });

  it('ignores extra spaces and parenthesised notes', () => {
    expect(initialsFor('  Pat   Example  ')).toBe('PE');
    expect(initialsFor('Pat Example (LAB)')).toBe('PE');
  });

  it('uses one letter for one word and "?" for nothing', () => {
    expect(initialsFor('Jordan')).toBe('J');
    expect(initialsFor('')).toBe('?');
    expect(initialsFor('   ')).toBe('?');
    expect(initialsFor(null)).toBe('?');
    expect(initialsFor('(LAB)')).toBe('?');
  });
});

describe('PersonAvatar', () => {
  it('is decorative, with muted initials', () => {
    const { container } = render(<PersonAvatar name="Alex Tester" />);
    const avatar = container.querySelector('[data-slot="avatar"]');
    expect(avatar?.getAttribute('aria-hidden')).toBe('true');
    const fallback = screen.getByText('AT');
    expect(fallback.className).toContain('bg-muted');
    expect(fallback.className).toContain('text-[11px]');
  });

  it('sizes 20 px compact, 24 px default and 32 px large', () => {
    const { container, rerender } = render(<PersonAvatar name="Sam Sample" size="compact" />);
    const avatar = () => container.querySelector('[data-slot="avatar"]')!;
    expect(avatar().className).toContain('size-5');
    expect(avatar().className).not.toMatch(/(^| )size-8( |$)/);
    rerender(<PersonAvatar name="Sam Sample" />);
    expect(avatar().className).toContain('size-6');
    rerender(<PersonAvatar name="Sam Sample" size="lg" />);
    expect(avatar().className).toContain('size-8');
  });

  it('shows the initials fallback while a photo has not loaded', () => {
    render(<PersonAvatar name="Pat Example" photoUrl="/api/people/1/photo" />);
    // jsdom never loads images, so Radix keeps the fallback.
    expect(screen.getByText('PE')).toBeTruthy();
  });

  it('gives Material Mule a primary "MM" avatar', () => {
    render(<PersonAvatar system name="Alex Tester" />);
    const fallback = screen.getByText('MM');
    expect(fallback.className).toContain('bg-primary');
    expect(fallback.className).toContain('text-primary-foreground');
  });
});

describe('PersonCell', () => {
  it('writes the name beside the avatar, truncating with a title', () => {
    render(<PersonCell name="Jordan Lab" size="compact" />);
    const name = screen.getByText('Jordan Lab');
    expect(name.getAttribute('title')).toBe('Jordan Lab');
    expect(name.className).toContain('truncate');
    expect(name.className).toContain('min-w-0');
  });

  it('reads "Unknown person" when the name is missing', () => {
    render(<PersonCell name={null} />);
    expect(screen.getByText('Unknown person').className).toContain('text-muted-foreground');
    expect(screen.getByText('?')).toBeTruthy();
  });

  it('names the system Material Mule', () => {
    render(<PersonCell system />);
    expect(screen.getByText('Material Mule')).toBeTruthy();
    expect(screen.getByText('MM')).toBeTruthy();
  });
});
