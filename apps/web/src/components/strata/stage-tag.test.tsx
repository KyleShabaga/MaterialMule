import { render, screen } from '@testing-library/react';
import { Flag, Hourglass } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { StageSrText, StageTag, stageTagText } from './stage-tag';

describe('StageTag', () => {
  it('writes a work item as "<Stage> · <domain>"', () => {
    render(<StageTag stage="due" domain="retention" />);
    const tag = screen.getByText('Due · Retention');
    expect(tag.getAttribute('data-slot')).toBe('badge');
    expect(tag.getAttribute('data-variant')).toBe('due');
  });

  it('uses the six work stage words', () => {
    expect(stageTagText('storage', { domain: 'receipt' })).toBe('Stored · Receipt');
    expect(stageTagText('danger', { domain: 'concrete' })).toBe('Urgent · Concrete');
    expect(stageTagText('lab', { domain: 'lab' })).toBe('In lab · Lab');
    expect(stageTagText('closed')).toBe('Closed');
  });

  it('writes a record status with its own word', () => {
    render(<StageTag stage="storage" label="Short-term" />);
    const tag = screen.getByText('Short-term');
    expect(tag.textContent).toBe('Short-term');
    expect(tag.getAttribute('data-stage')).toBe('storage');
  });

  it('draws a hidden 6 px stage dot before the word', () => {
    render(<StageTag stage="danger" label="Retention overdue" />);
    const tag = screen.getByText('Retention overdue');
    const dot = tag.querySelector('[data-slot="stage-dot"]');
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
    expect(dot?.className).toContain('size-1.5');
    expect(dot?.className).toContain('bg-stage-danger-mark');
    expect(tag.firstElementChild).toBe(dot);
  });

  it('keeps a CanvasText border for forced colours', () => {
    render(<StageTag stage="lab" label="In lab" />);
    expect(screen.getByText('In lab').className).toContain('forced-colors:border-[CanvasText]');
  });

  it('renders a neutral waiting tag with a hidden icon and no dot', () => {
    render(<StageTag variant="neutral" label="Hold · 12 days left" icon={Hourglass} />);
    const tag = screen.getByText('Hold · 12 days left');
    expect(tag.getAttribute('data-variant')).toBe('secondary');
    expect(tag.querySelector('[data-slot="stage-dot"]')).toBeNull();
    expect(tag.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders the outline priority tag', () => {
    render(<StageTag variant="outline" label="Urgent · Priority" icon={Flag} />);
    const tag = screen.getByText('Urgent · Priority');
    expect(tag.getAttribute('data-variant')).toBe('outline');
    expect(tag.querySelector('svg')).not.toBeNull();
  });
});

describe('StageSrText', () => {
  it('writes the stage for screen readers only', () => {
    render(<StageSrText stage="due" domain="review" />);
    expect(screen.getByText('Due · Review').className).toBe('sr-only');
  });
});

describe('UnitStatusTag', () => {
  it('writes the record status word in its stage colour', async () => {
    const { UnitStatusTag } = await import('./stage-tag');
    render(<UnitStatusTag status="retention_overdue" />);
    const tag = screen.getByText('Retention overdue');
    expect(tag.getAttribute('data-stage')).toBe('danger');
  });

  it('shows a confirmed unit not yet put away as Received in the draft hue', async () => {
    const { UnitStatusTag } = await import('./stage-tag');
    render(<UnitStatusTag status="received" />);
    expect(screen.getByText('Received').getAttribute('data-stage')).toBe('draft');
  });
});
