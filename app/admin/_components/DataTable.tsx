/** Plain result table used by every admin page and the showcase runner. */
export default function DataTable({
  columns,
  rows,
  empty = "No rows.",
}: {
  columns: string[];
  rows: unknown[][];
  empty?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-900">
          <tr>
            {columns.map((c) => (
              <th key={c} className="whitespace-nowrap px-3 py-2 font-mono text-xs font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={Math.max(columns.length, 1)} className="px-3 py-4 text-center text-neutral-500">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-neutral-200 dark:border-neutral-800">
              {r.map((v, j) => (
                <td key={j} className="whitespace-nowrap px-3 py-1.5 tabular-nums">
                  {render(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function render(v: unknown): React.ReactNode {
  if (v == null) return <span className="text-neutral-400">NULL</span>;
  if (v instanceof Date) return v.toLocaleString();
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
