import { NextResponse } from "next/server";
import { apiUserId, badRequest, parseId, unauthorized } from "@/lib/auth/api";
import { acceptFriendRequest } from "@/app/friends/queries";

export const runtime = "nodejs";

/** POST /api/friends/:id/accept — accept an incoming request addressed to me. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await apiUserId();
  if (!me) return unauthorized();
  const id = parseId((await params).id);
  if (!id) return badRequest("Bad request id.");
  if (!(await acceptFriendRequest(me, id))) return badRequest("No pending request to accept.", 404);
  return NextResponse.json({ ok: true });
}
