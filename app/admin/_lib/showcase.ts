/**
 * Runs the showcase SQL files (db/06_queries.sql, db/07_dml.sql) exactly as
 * they are on disk, so the page and the file can never drift apart.
 *
 * File format: each query starts at a line beginning "-- @query", e.g.
 *
 *     -- @query Friends of friends (recursive CTE)
 *     -- Rubric: column N — recursive CTE over a recursive relationship
 *     -- any further comment lines are shown as a description
 *     WITH RECURSIVE ... ;
 *
 * Execution:
 *   - every block of a file runs in ONE transaction, in file order;
 *   - 06 (read-only) runs through withUser(adminId), so row level security
 *     applies exactly as it does for the admin in the app;
 *   - 07 (DML on every table) runs through withOwnerRolledBack(): it writes
 *     sos_alert, alert_recipient, alert_audit and other users' rows, which the
 *     bykr_app role is deliberately NOT allowed to write. That connection is
 *     the schema owner (RLS does not apply) and ALWAYS rolls back. It is only
 *     reachable from the admin-only showcase page;
 *   - each block gets its own SAVEPOINT, so one failing block does not hide
 *     the results of the others;
 *   - the transaction is ALWAYS rolled back at the end. 06 is read-only
 *     anyway; 07's INSERT/UPDATE/DELETE are demonstrated, then undone. The
 *     file's own BEGIN/ROLLBACK lines are stripped so they cannot end the
 *     surrounding transaction early.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { QueryResult } from "pg";
import { withOwnerRolledBack, withUser, type Db } from "@/lib/db";

export const SHOWCASE_FILES = {
  queries: { file: "06_queries.sql", title: "Showcase queries" },
  dml: { file: "07_dml.sql", title: "DML statements" },
} as const;
export type ShowcaseKey = keyof typeof SHOWCASE_FILES;

export type QueryBlock = {
  index: number;
  name: string;
  rubric: string | null;
  description: string[];
  sql: string; // as written in the file (header comments removed)
  line: number; // 1-based line of the "-- @query" header
};

export type StatementResult = {
  command: string;
  rowCount: number | null;
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
};

export type BlockResult = QueryBlock & {
  ok: boolean;
  error: string | null;
  ms: number;
  statements: StatementResult[];
  notices: string[];
};

const MAX_ROWS = 200;
const HEADER = /^--\s*@query\b[:\s]*/i;
const RUBRIC = /^--\s*@?rubric\b[:\s]*/i;
// Top-level transaction control only. PL/pgSQL's "BEGIN" (no semicolon) and
// "END;" inside DO blocks must survive, so END/ABORT are deliberately absent.
const TX_CONTROL = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)(\s+(WORK|TRANSACTION))?\s*;\s*(--.*)?$/i;

export function parseShowcase(text: string): QueryBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: QueryBlock[] = [];
  let cur: { name: string; line: number; body: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const body = [...cur.body];
    let rubric: string | null = null;
    const description: string[] = [];
    // leading comment lines (before the first SQL line) are metadata
    while (body.length && (body[0].trim() === "" || body[0].trim().startsWith("--"))) {
      const l = body.shift()!.trim();
      if (l === "" || /^--\s*[-=]*\s*$/.test(l)) continue;
      if (RUBRIC.test(l)) rubric = l.replace(RUBRIC, "").trim();
      else if (rubric == null && /rubric/i.test(l)) rubric = l.replace(/^--\s*/, "").trim();
      else description.push(l.replace(/^--\s?/, ""));
    }
    const sql = body.join("\n").trim();
    if (sql) {
      blocks.push({ index: blocks.length + 1, name: cur.name, rubric, description, sql, line: cur.line });
    }
    cur = null;
  };

  lines.forEach((raw, i) => {
    if (HEADER.test(raw.trimStart())) {
      flush();
      const name = raw.trimStart().replace(HEADER, "").trim() || `Query ${blocks.length + 1}`;
      cur = { name, line: i + 1, body: [] };
    } else if (cur) {
      cur.body.push(raw);
    }
  });
  flush();
  return blocks;
}

/** SQL actually sent: no transaction control, no psql meta-commands. */
function executableSql(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((l) => !TX_CONTROL.test(l) && !/^\s*\\/.test(l))
    .join("\n")
    .trim();
}

function cell(v: unknown): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "string" && v.length > 160) return `${v.slice(0, 157)}…`;
  return v;
}

function toStatement(r: QueryResult): StatementResult {
  const columns = (r.fields ?? []).map((f) => f.name);
  const rows = (r.rows ?? []).slice(0, MAX_ROWS).map((row) => columns.map((c) => cell((row as Record<string, unknown>)[c])));
  return {
    command: r.command ?? "",
    rowCount: r.rowCount ?? null,
    columns,
    rows,
    truncated: (r.rows?.length ?? 0) > MAX_ROWS,
  };
}

class Rollback extends Error {
  constructor(public results: BlockResult[]) {
    super("showcase rollback");
  }
}

export async function loadShowcase(key: ShowcaseKey): Promise<{ path: string; blocks: QueryBlock[] } | { path: string; missing: true }> {
  const rel = path.join("db", SHOWCASE_FILES[key].file);
  try {
    const text = await readFile(path.join(process.cwd(), rel), "utf8");
    return { path: rel, blocks: parseShowcase(text) };
  } catch {
    return { path: rel, missing: true };
  }
}

/** Run every block in order on one client, a SAVEPOINT per block. */
async function runBlocks(db: Db, blocks: QueryBlock[]): Promise<BlockResult[]> {
  await db.query(`SET LOCAL statement_timeout = '10s'`);
  const results: BlockResult[] = [];
  for (const b of blocks) {
    const sql = executableSql(b.sql);
    const started = performance.now();
    if (sql === "") {
      // e.g. a block that is only "BEGIN;" or "ROLLBACK;"
      results.push({
        ...b,
        ok: true,
        error: null,
        ms: 0,
        statements: [{ command: "Transaction control: handled by the runner (one transaction, always rolled back)", rowCount: null, columns: [], rows: [], truncated: false }],
        notices: [],
      });
      continue;
    }
    const notices: string[] = [];
    const onNotice = (n: { message?: string }) => notices.push(n.message ?? "");
    db.on("notice", onNotice);
    await db.query("SAVEPOINT showcase_block");
    try {
      // No parameters → simple query protocol, so a block may hold several statements.
      const res = (await db.query(sql)) as unknown as QueryResult | QueryResult[];
      const list = Array.isArray(res) ? res : [res];
      await db.query("RELEASE SAVEPOINT showcase_block");
      results.push({ ...b, ok: true, error: null, ms: performance.now() - started, statements: list.map(toStatement), notices });
    } catch (err) {
      await db.query("ROLLBACK TO SAVEPOINT showcase_block");
      const e = err as { message?: string; code?: string };
      results.push({
        ...b,
        ok: false,
        error: `${e.code ? `[${e.code}] ` : ""}${e.message ?? String(err)}`,
        ms: performance.now() - started,
        statements: [],
        notices,
      });
    } finally {
      db.off("notice", onNotice);
    }
  }
  return results;
}

export async function runShowcase(key: ShowcaseKey, adminId: number, blocks: QueryBlock[]): Promise<BlockResult[]> {
  if (key === "dml") {
    // Owner connection, always rolled back (see header). app.current_user_id is
    // still set so any fn_current_user_id() in the file sees the admin.
    return withOwnerRolledBack(async (db) => {
      await db.query("SELECT set_config('app.current_user_id', $1, true)", [String(adminId)]);
      return runBlocks(db, blocks);
    });
  }
  try {
    await withUser(adminId, async (db) => {
      // Always undo: withUser() rolls back when the callback throws.
      throw new Rollback(await runBlocks(db, blocks));
    });
  } catch (err) {
    if (err instanceof Rollback) return err.results;
    throw err;
  }
  return [];
}
