/**
 * Small helpers shared by the /api/rides route handlers.
 *
 * Authorisation is NOT decided here. Every handler runs its SQL inside
 * withUser(), which sets app.current_user_id, and PostgreSQL row level
 * security decides what that user can read or change. These helpers only
 * turn the outcome (rows / no rows / a raised SQLSTATE) into HTTP.
 */
import { NextResponse } from "next/server";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Signed-in user, or a 401 HttpError (route handlers must not redirect). */
export async function apiUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Sign in first.");
  return user;
}

/** Parse the [id] segment of /api/rides/[id]/... */
export async function rideIdFrom(params: Promise<{ id: string }>): Promise<number> {
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Invalid ride id.");
  return n;
}

// SQLSTATE -> HTTP. These are the codes our procedures and constraints raise.
const SQLSTATE_HTTP: Record<string, number> = {
  "42501": 403, // insufficient_privilege (RLS WITH CHECK, sp_end_ride leader check)
  P0002: 404, // no_data_found (sp_end_ride: ride not visible / not found)
  "23514": 409, // check_violation (wrong ride_state, timestamp rules)
  "23505": 409, // unique_violation
  "23503": 409, // foreign_key_violation (e.g. accident rows still reference the ride)
  "22P02": 400, // invalid_text_representation
};

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const e = err as { code?: string; message?: string };
  const status = (e?.code && SQLSTATE_HTTP[e.code]) || 500;
  if (status === 500) console.error("[api/rides]", err);
  return NextResponse.json(
    { error: e?.message ?? "Unexpected error", sqlstate: e?.code ?? null },
    { status },
  );
}

/** Wrap a handler body so thrown HttpErrors and pg errors become JSON responses. */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    return errorResponse(err);
  }
}
