/**
 * Helpers for route handlers. Unlike requireUserId(), which redirects (right
 * for pages), API routes answer 401 JSON so fetch() callers can react.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "./session";

export async function apiUserId(): Promise<number | null> {
  return (await getSessionUser())?.id ?? null;
}

export function unauthorized() {
  return NextResponse.json({ error: "Sign in first." }, { status: 401 });
}

export function badRequest(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

/** Parses a positive integer route param, or null. */
export function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** pg errors expose the violated constraint name; map it to a message. */
export function constraintOf(err: unknown): string | undefined {
  return (err as { constraint?: string } | null)?.constraint;
}
