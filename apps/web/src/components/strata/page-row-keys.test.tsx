import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RowKeyGate, usePageRowKeys } from './page-row-keys';

function Page({ now }: { now: () => number }) {
  usePageRowKeys({ now });
  return (
    <main id="main">
      <div data-slot="data-table">
        <table>
          <tbody>
            <tr data-row-id="a" tabIndex={0}>
              <td>BKT-2026-000001</td>
            </tr>
            <tr data-row-id="b" tabIndex={-1}>
              <td>BKT-2026-000002</td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  );
}

describe('page row keys (STRATA-134)', () => {
  let clock = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function key(name: string) {
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
  }

  /** Types `text` the way a wedge scanner does: one key every 5 ms, then Enter. */
  function scan(text: string) {
    for (const name of [...text, 'Enter']) {
      clock += 5;
      key(name);
    }
  }

  /** A person's key: well after the last one. */
  function press(name: string) {
    clock += 500;
    key(name);
  }

  it('a lone J, typed by a person, focuses the list row once the scanner gap has passed', () => {
    const { container } = render(<Page now={() => clock} />);
    press('j');
    expect(document.activeElement).toBe(document.body);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(document.activeElement).toBe(container.querySelector('[data-row-id="a"]'));
  });

  it('a K inside a scan burst is not navigation: focus stays put for scan-anywhere', () => {
    render(<Page now={() => clock} />);
    scan('BKT-2026-000001');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('a scan that starts with J or K is not navigation either', () => {
    render(<Page now={() => clock} />);
    press('x');
    scan('K-2026-01');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('the gate reports burst keys and cancels a waiting J/K when another key comes', () => {
    const gate = new RowKeyGate(50);
    const acted = vi.fn();
    expect(gate.key(0)).toBe(false);
    gate.later(acted);
    expect(gate.key(20)).toBe(true);
    vi.advanceTimersByTime(200);
    expect(acted).not.toHaveBeenCalled();
    expect(gate.key(1000)).toBe(false);
  });
});
