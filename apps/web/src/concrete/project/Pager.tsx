/** "Showing 1–25 of 60" with Previous / Next, for the Concrete tab tables. */
export function Pager({
  page,
  pageSize,
  total,
  noun,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  noun: string;
  onPage: (page: number) => void;
}) {
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const pages = Math.ceil(total / pageSize);
  return (
    <div className="concrete-pager">
      <p className="field-hint" role="status">
        Showing {first}–{last} of {total} {noun}
      </p>
      {pages > 1 ? (
        <div className="page-actions">
          <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            Previous
          </button>
          <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
