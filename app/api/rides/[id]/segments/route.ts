/**
 * POST /api/rides/[id]/segments — re-run the MongoDB updateMany that tags
 * every ping of a completed ride with its segment id (tagRideSegments).
 * Visibility of the ride is checked through RLS first.
 */
import { NextResponse } from "next/server";
import { withUser } from "@/lib/db";
import { tagRideSegments } from "@/lib/mongo/telemetry";
import { getParticipants, getRide } from "@/app/rides/_lib/queries";
import { apiUser, handle, HttpError, rideIdFrom } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await apiUser();
    const rideId = await rideIdFrom(params);

    const leaderPid = await withUser(user.id, async (db) => {
      const ride = await getRide(db, rideId);
      if (!ride) throw new HttpError(404, "Ride not found.");
      if (ride.ride_state !== "COMPLETED") throw new HttpError(409, "Only a completed ride is segmented.");
      const ps = await getParticipants(db, rideId);
      const leader = ps.find((p) => p.is_leader) ?? ps.find((p) => p.joined_at);
      if (!leader) throw new HttpError(409, "Ride has no joined participants.");
      return leader.participant_id;
    });

    const result = await tagRideSegments(rideId, leaderPid);
    return NextResponse.json(result);
  });
}
