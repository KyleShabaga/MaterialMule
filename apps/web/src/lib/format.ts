const DATE_TIME = new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' });

/** A date and time for people, e.g. the fixed end of a LAB session (TRP-T06). */
export function formatExpiry(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}
