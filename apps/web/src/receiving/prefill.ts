/** What was typed goes into the number when it looks like one ("67997", "DEMO-2701"). */
export function prefillFromQuery(query: string): { projectNumber: string; name: string } {
  const text = query.trim();
  return /\d/.test(text) && !/\s/.test(text)
    ? { projectNumber: text, name: '' }
    : { projectNumber: '', name: text };
}

/** zod issues as messages keyed by field, the same shape the API returns on 400. */
export function errorsByField(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const field = issue.path.map(String).join('.') || '_';
    (errors[field] ??= []).push(issue.message);
  }
  return errors;
}
