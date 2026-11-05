import { NextResponse } from "next/server";
import { z } from "zod";
import { apiUserId, badRequest, unauthorized } from "@/lib/auth/api";
import { FriendError, getFriendsOverview, sendFriendRequest } from "@/app/friends/queries";

export const runtime = "nodejs";

/** GET /api/friends — circle, pending requests, and people you may know. */
export async function GET() {
  const me = await apiUserId();
  if (!me) return unauthorized();
  return NextResponse.json(await getFriendsOverview(me));
}

const sendSchema = z.union([
  z.object({ email: z.string().trim().toLowerCase().email("Enter a valid email") }),
  z.object({ userId: z.number().int().positive() }),
]);

/** POST /api/friends { email } | { userId } — send a friend request. */
export async function POST(req: Request) {
  const me = await apiUserId();
  if (!me) return unauthorized();
  const parsed = sendSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Enter a valid email.");
  try {
    const result = await sendFriendRequest(me, parsed.data);
    return NextResponse.json({ result }, { status: result === "sent" ? 201 : 200 });
  } catch (err) {
    if (err instanceof FriendError) return badRequest(err.message, err.status);
    throw err;
  }
}
