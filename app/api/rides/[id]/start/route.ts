/** POST /api/rides/[id]/start — CREATED -> ACTIVE, leader only. */
import { NextResponse } from "next/server";
import { withUser } from "@/lib/db";
import { getRide, startRide } from "@/app/rides/_lib/queries";
import { apiUser, handle, HttpError, rideIdFrom } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await apiUser();
    const rideId = await rideIdFrom(params);
    await withUser(user.id, async (db) => {
      const n = await startRide(db, rideId, user.id);
      if (n === 1) return;
      const ride = await getRide(db, rideId);
      if (!ride) throw new HttpError(404, "Ride not found.");
      if (ride.ride_state !== "CREATED") throw new HttpError(409, `Ride is already ${ride.ride_state}.`);
      throw new HttpError(403, "Only the ride leader can start the ride.");
    });
    return NextResponse.json({ started: true });
  });
}
