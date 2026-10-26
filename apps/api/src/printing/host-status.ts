// Zebra host status (~HS) parsing (TRP-T15). The printer answers ~HS with three framed strings,
// each <STX>…<ETX><CR><LF>:
//
//   1: aaa,b,c,dddd,eee,f,g,h,iii,j,k,l
//      b paper out, c pause, dddd label length, eee formats in buffer, f buffer full, …
//   2: mmm,n,o,p,q,r,s,t,uuuuuuuu,v,www
//      o head up (open), p ribbon out, q thermal transfer mode, …, t label waiting, …
//   3: xxxx,y  (password, static RAM) — not needed
//
// Only the first two strings are needed to decide whether labels can be sent.

export const HOST_STATUS_REQUEST = '~HS';

const STX = '\u0002';
const ETX = '\u0003';

export interface HostStatus {
  paperOut: boolean;
  paused: boolean;
  headOpen: boolean;
  ribbonOut: boolean;
  bufferFull: boolean;
  formatsInBuffer: number;
}

/**
 * Parses a (possibly partial) ~HS response. Returns null until both status strings have arrived,
 * and throws when they arrived but aren't a host status response.
 */
export function parseHostStatus(response: string): HostStatus | null {
  const frames: string[] = [];
  let rest = response;
  while (frames.length < 2) {
    const start = rest.indexOf(STX);
    if (start === -1) return null;
    const end = rest.indexOf(ETX, start + 1);
    if (end === -1) return null;
    frames.push(rest.slice(start + 1, end));
    rest = rest.slice(end + 1);
  }
  const first = frames[0]!.split(',');
  const second = frames[1]!.split(',');
  if (first.length < 12 || second.length < 11) {
    throw new HostStatusFormatError('Unexpected printer status response');
  }
  const flag = (value: string | undefined) => value?.trim() === '1';
  const thermalTransfer = flag(second[4]);
  return {
    paperOut: flag(first[1]),
    paused: flag(first[2]),
    formatsInBuffer: Number.parseInt(first[4] ?? '0', 10) || 0,
    bufferFull: flag(first[5]),
    headOpen: flag(second[2]),
    // The ribbon flag only means something when the printer is set to thermal transfer.
    ribbonOut: thermalTransfer && flag(second[3]),
  };
}

export class HostStatusFormatError extends Error {
  override name = 'HostStatusFormatError';
}

/** Plain-language reason labels can't be sent now, or null when the printer is ready. */
export function hostStatusProblem(status: HostStatus): string | null {
  if (status.paperOut) return 'Printer out of labels';
  if (status.headOpen) return 'Printer head is open';
  if (status.ribbonOut) return 'Printer out of ribbon';
  if (status.paused) return 'Printer is paused';
  if (status.bufferFull) return 'Printer memory is full';
  return null;
}

/** Builds a ~HS response; used by the fake printer in tests. */
export function formatHostStatus(status: Partial<HostStatus> = {}): string {
  const b = (value: boolean | undefined) => (value ? '1' : '0');
  const first = [
    '030',
    b(status.paperOut),
    b(status.paused),
    '0450',
    String(status.formatsInBuffer ?? 0).padStart(3, '0'),
    b(status.bufferFull),
    '0',
    '0',
    '000',
    '0',
    '0',
    '0',
  ].join(',');
  const second = [
    '000',
    '0',
    b(status.headOpen),
    b(status.ribbonOut),
    status.ribbonOut ? '1' : '0',
    '2',
    '6',
    '0',
    '00000000',
    '1',
    '000',
  ].join(',');
  const third = '1234,0';
  return [first, second, third].map((s) => `${STX}${s}${ETX}\r\n`).join('');
}
