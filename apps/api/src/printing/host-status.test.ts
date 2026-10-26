import { describe, expect, it } from 'vitest';
import {
  formatHostStatus,
  HostStatusFormatError,
  hostStatusProblem,
  parseHostStatus,
} from './host-status.js';

// A response captured in the documented ~HS format: printer ready, nothing queued.
const READY =
  '\u0002030,0,0,0450,000,0,0,0,000,0,0,0\u0003\r\n' +
  '\u0002001,0,0,0,0,2,6,0,00000000,1,000\u0003\r\n' +
  '\u00021234,0\u0003\r\n';

describe('parseHostStatus (T2)', () => {
  it('reads a ready printer', () => {
    const status = parseHostStatus(READY);
    expect(status).toEqual({
      paperOut: false,
      paused: false,
      headOpen: false,
      ribbonOut: false,
      bufferFull: false,
      formatsInBuffer: 0,
    });
    expect(hostStatusProblem(status!)).toBeNull();
  });

  it('detects paper out and pause', () => {
    const response =
      '\u0002030,1,1,0450,002,0,0,0,000,0,0,0\u0003\r\n' +
      '\u0002001,0,0,0,0,2,6,0,00000000,1,000\u0003\r\n';
    const status = parseHostStatus(response)!;
    expect(status.paperOut).toBe(true);
    expect(status.paused).toBe(true);
    expect(status.formatsInBuffer).toBe(2);
    // Paper out is the cause; the pause follows from it.
    expect(hostStatusProblem(status)).toBe('Printer out of labels');
  });

  it('detects a paused printer and an open head', () => {
    expect(hostStatusProblem(parseHostStatus(formatHostStatus({ paused: true }))!)).toBe(
      'Printer is paused',
    );
    expect(hostStatusProblem(parseHostStatus(formatHostStatus({ headOpen: true }))!)).toBe(
      'Printer head is open',
    );
  });

  it('only reports ribbon out in thermal transfer mode', () => {
    const directThermal =
      '\u0002030,0,0,0450,000,0,0,0,000,0,0,0\u0003\r\n' +
      '\u0002001,0,0,1,0,2,6,0,00000000,1,000\u0003\r\n';
    expect(parseHostStatus(directThermal)!.ribbonOut).toBe(false);
    expect(parseHostStatus(formatHostStatus({ ribbonOut: true }))!.ribbonOut).toBe(true);
  });

  it('waits for both status strings before deciding', () => {
    expect(parseHostStatus('')).toBeNull();
    expect(parseHostStatus(READY.slice(0, 20))).toBeNull();
    expect(parseHostStatus(READY.split('\r\n')[0]!)).toBeNull();
  });

  it('rejects a response that is not host status', () => {
    expect(() => parseHostStatus('\u0002hello\u0003\u0002world\u0003')).toThrow(
      HostStatusFormatError,
    );
  });

  it('round-trips the fake printer format', () => {
    const status = parseHostStatus(formatHostStatus({ paperOut: true, bufferFull: true }))!;
    expect(status).toMatchObject({ paperOut: true, bufferFull: true, headOpen: false });
  });
});
