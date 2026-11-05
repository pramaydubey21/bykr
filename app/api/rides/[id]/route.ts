/**
 * DELETE /api/rides/[id]   creator only
 *   1. Postgres: confirm the ride is visible and the caller created it
 *   2. MongoDB:  purgeRidePings()  deleteMany on location_pings + motion_samples
 *   3. Postgres: DELETE FROM ride  (pol_ride_delete re-checks created_by; children cascade)
 */
import { NextResponse } from "next/server";
import { withUser } from "@/lib/db";
import { purgeRidePings } from "@/lib/mongo/telemetry";
import { deleteRide, getRide } from "@/app/rides/_lib/queries";
import { apiUser, handle, HttpError, rideIdFrom } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await apiUser();
    const rideId = await rideIdFrom(params);

    const ride = await withUser(user.id, (db) => getRide(db, rideId));
    if (!ride) throw new HttpError(404, "Ride not found.");
    if (ride.created_by !== user.id) throw new HttpError(403, "Only the ride's creator can delete it.");
    if (ride.ride_state === "ACTIVE") throw new HttpError(409, "End the ride before deleting it.");

    const purged = await purgeRidePings(rideId);
    const deleted = await withUser(user.id, (db) => deleteRide(db, rideId));
    if (deleted !== 1) throw new HttpError(403, "Row level security refused the delete.");

    return NextResponse.json({ deleted: true, purged });
  });
}
