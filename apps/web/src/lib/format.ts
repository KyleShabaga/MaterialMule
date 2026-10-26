const DATE_TIME = new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' });

/** A date and time for people, e.g. the fixed end of a LAB session (MM-T06). */
export function formatExpiry(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

/** Printable size, e.g. 12.3 GB (decimal units, as used for disk space). */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

/** Plain age, e.g. "4 min" or "2 h 5 min". */
export function formatAge(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
