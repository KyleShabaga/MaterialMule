/** What was typed goes into the number when it looks like one ("67997", "DEMO-2701"). */
export function prefillFromQuery(query: string): { projectNumber: string; name: string } {
  const text = query.trim();
  return /\d/.test(text) && !/\s/.test(text)
    ? { projectNumber: text, name: '' }
    : { projectNumber: '', name: text };
}
