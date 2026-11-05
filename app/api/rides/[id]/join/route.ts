/** POST /api/rides/[id]/join — accept an invitation (sets joined_at on the caller's own row). */
import { NextResponse } from "next/server";
import { withUser } from "@/lib/db";
import { joinRide } from "@/app/rides/_lib/queries";
import { apiUser, handle, HttpError, rideIdFrom } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await apiUser();
    const rideId = await rideIdFrom(params);
    const n = await withUser(user.id, (db) => joinRide(db, rideId, user.id));
    if (n === 0) throw new HttpError(409, "No open invitation for you on this ride.");
    return NextResponse.json({ joined: true });
  });
}
