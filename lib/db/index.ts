/**
 * node-postgres access layer. No ORM: every statement is hand-written SQL.
 *
 * The pool connects as bykr_app (see .env.example), a role WITHOUT superuser
 * or BYPASSRLS, so PostgreSQL row level security applies to every query.
 *
 * withUser() wraps each request in a transaction and sets
 *     app.current_user_id  (transaction-local: set_config(..., true))
 * which is what every policy in db/02_rbac.sql reads. Because the setting is
 * transaction-local it is discarded at COMMIT/ROLLBACK and can never leak to
 * the next request that borrows the same pooled connection.
 */
import { Pool, types, type PoolClient } from "pg";

// NUMERIC (1700) and BIGINT (20) arrive as strings by default; this app's
// values fit comfortably in a JS number.
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => parseInt(v, 10));

const g = globalThis as unknown as { _bykrPool?: Pool };

export const pool: Pool =
  g._bykrPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://bykr_app:bykr_app@localhost:5432/bykr",
    max: 10,
  });
if (process.env.NODE_ENV !== "production") g._bykrPool = pool;

export type Db = PoolClient;

/** Run fn inside a transaction with app.current_user_id set for RLS. */
export async function withUser<T>(userId: number | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [
      userId == null ? "" : String(userId),
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** For queries that need no user context (sign-in lookup, sign-up). */
export function anonymous<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return withUser(null, fn);
}

/** Convert a JS number[] to pgvector's text input format: '[1,2,3]'. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? Number(x.toFixed(6)) : 0)).join(",")}]`;
}
