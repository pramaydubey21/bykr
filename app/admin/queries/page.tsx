/**
 * Showcase page: reads db/06_queries.sql or db/07_dml.sql from disk on every
 * request, splits it on "-- @query" headers, runs each block as the admin
 * (withUser → RLS applies) inside a transaction that is always rolled back,
 * and shows name, rubric line, SQL and result. See ../_lib/showcase.ts.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/session";
import DataTable from "../_components/DataTable";
import { SHOWCASE_FILES, loadShowcase, runShowcase, type ShowcaseKey } from "../_lib/showcase";

export const dynamic = "force-dynamic";

export default async function ShowcasePage({
  searchParams,
}: {
  searchParams: Promise<{ file?: string }>;
}) {
  const adminId = await requireAdmin();
  const { file } = await searchParams;
  const key: ShowcaseKey = file === "dml" ? "dml" : "queries";
  const loaded = await loadShowcase(key);
  const results = "blocks" in loaded ? await runShowcase(key, adminId, loaded.blocks) : [];
  const failed = results.filter((r) => !r.ok).length;

  return (
    <section>
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        {(Object.keys(SHOWCASE_FILES) as ShowcaseKey[]).map((k) => (
          <Link
            key={k}
            href={k === "queries" ? "/admin/queries" : "/admin/queries?file=dml"}
            className={`rounded-md border px-3 py-1.5 ${
              k === key
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            }`}
          >
            {SHOWCASE_FILES[k].title} <span className="font-mono text-xs opacity-70">db/{SHOWCASE_FILES[k].file}</span>
          </Link>
        ))}
      </div>

      {"missing" in loaded ? (
        <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <code>{loaded.path}</code> does not exist yet.
        </p>
      ) : results.length === 0 ? (
        <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          No <code>-- @query</code> blocks found in <code>{loaded.path}</code>.
        </p>
      ) : (
        <>
          <p className="mb-6 text-sm text-neutral-500">
            {results.length} blocks read from <code>{loaded.path}</code> at request time and run in one transaction (a
            savepoint per block), then rolled back.
            {key === "queries"
              ? ` Run as user #${adminId} through row level security.`
              : " Run on the schema-owner connection, because these statements write tables the application role may not write (alerts, recipients, audit). Every change is rolled back, so nothing persists."}
            {failed > 0 && <span className="text-red-600"> {failed} failed.</span>}
          </p>
          <nav className="mb-8 columns-1 gap-6 text-sm sm:columns-2">
            {results.map((r) => (
              <a key={r.index} href={`#q${r.index}`} className="block py-0.5 hover:underline">
                <span className={r.ok ? "text-green-600" : "text-red-600"}>{r.ok ? "✓" : "✗"}</span> {r.index}. {r.name}
              </a>
            ))}
          </nav>
          <div className="space-y-10">
            {results.map((r) => (
              <article key={r.index} id={`q${r.index}`} className="scroll-mt-6">
                <h3 className="text-lg font-semibold">
                  {r.index}. {r.name}
                </h3>
                {r.rubric && <p className="text-sm font-medium text-indigo-700 dark:text-indigo-300">{r.rubric}</p>}
                {r.description.length > 0 && (
                  <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{r.description.join(" ")}</p>
                )}
                <p className="mt-1 text-xs text-neutral-500">
                  {loaded.path}:{r.line} · {r.ms.toFixed(1)} ms
                </p>
                <pre className="my-3 overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs leading-relaxed dark:bg-neutral-900">
                  {r.sql}
                </pre>
                {r.notices.length > 0 && (
                  <ul className="mb-3 space-y-1 rounded-lg bg-sky-50 p-3 font-mono text-xs text-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
                    {r.notices.map((n, i) => (
                      <li key={i}>NOTICE: {n}</li>
                    ))}
                  </ul>
                )}
                {!r.ok ? (
                  <p className="rounded-lg bg-red-50 p-3 font-mono text-xs text-red-800 dark:bg-red-950/40 dark:text-red-300">
                    {r.error}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {r.statements.map((s, i) =>
                      s.columns.length > 0 ? (
                        <div key={i}>
                          <p className="mb-1 text-xs text-neutral-500">
                            {s.command} · {s.rowCount ?? 0} row(s){s.truncated && " · first 200 shown"}
                          </p>
                          <DataTable columns={s.columns} rows={s.rows} empty="Query returned no rows." />
                        </div>
                      ) : (
                        <p key={i} className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
                          {s.command || "OK"}
                          {s.rowCount != null && ` — ${s.rowCount} row(s) affected`}
                        </p>
                      ),
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
