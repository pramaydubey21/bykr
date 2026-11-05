import { NextResponse } from "next/server";
import { apiUserId, badRequest, parseId, unauthorized } from "@/lib/auth/api";
import { removeFriendship } from "@/app/friends/queries";

export const runtime = "nodejs";

/** DELETE /api/friends/:id — decline, cancel, or unfriend. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await apiUserId();
  if (!me) return unauthorized();
  const id = parseId((await params).id);
  if (!id) return badRequest("Bad friendship id.");
  if (!(await removeFriendship(me, id))) return badRequest("Nothing to remove.", 404);
  return NextResponse.json({ ok: true });
}
