/** Only same-app paths are allowed as a post-sign-in destination (no open redirects). */
export function safeReturnTo(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}
