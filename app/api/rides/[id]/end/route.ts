/**
 * POST /api/rides/[id]/end — leader only (sp_end_ride enforces it).
 *
 * Inside one Postgres transaction, finalizeRide() writes ride_waypoint from
 * the MongoDB track, CALLs sp_end_ride (COMPLETED + ride_summary) and stores
 * the route embedding. Only after that commits does tagRideSegments() run the
 * MongoDB updateMany, so a rolled-back end never leaves tagged pings behind.
 */
import { NextResponse } from "next/server";
import { withUser } from "@/lib/db";
import { tagRideSegments } from "@/lib/mongo/telemetry";
import { finalizeRide } from "@/lib/vector/finalize";
import { apiUser, handle, rideIdFrom } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await apiUser();
    const rideId = await rideIdFrom(params);

    const fin = await withUser(user.id, (db) => finalizeRide(db, rideId, user.id));

    // After COMMIT. A failure here is reported but does not undo the ended ride;
    // the ride history page can re-run the tagging.
    let segments: { segments: number; modified: number } | null = null;
    let segmentError: string | null = null;
    try {
      segments = await tagRideSegments(rideId, fin.leaderParticipantId);
    } catch (err) {
      segmentError = (err as Error).message;
    }

    return NextResponse.json({ ended: true, ...fin, segments, segmentError });
  });
}
