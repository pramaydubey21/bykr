/**
 * Server-side session helpers. Import these from server components, server
 * actions and route handlers — there is no middleware (the edge runtime cannot
 * load pg or argon2), so every protected page calls requireUserId() itself.
 *
 * The roles in the session are a convenience for the UI (e.g. hiding the Admin
 * link). Real access control is enforced by PostgreSQL row level security,
 * keyed on app.current_user_id, which lib/db withUser() sets per transaction.
 */
import { redirect } from "next/navigation";
import { auth } from "@/auth";

export type SessionUser = { id: number; name: string; email: string; roles: string[] };

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const u = session?.user;
  if (!u?.id) return null;
  const id = Number(u.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    name: u.name ?? "",
    email: u.email ?? "",
    roles: Array.isArray(u.roles) ? u.roles : [],
  };
}

/** Returns the signed-in user's id, or redirects to /signin. */
export async function requireUserId(): Promise<number> {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  return user.id;
}

/** Returns the signed-in admin's id; redirects to /signin or, for non-admins, to /?denied=admin. */
export async function requireAdmin(): Promise<number> {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  if (!user.roles.includes("ADMIN")) redirect("/?denied=admin");
  return user.id;
}
