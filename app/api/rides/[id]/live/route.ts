/**
 * GET /api/rides/[id]/live — polled every 5 s by the live map.
 *
 * Postgres first: the ride and its participants (with each one's open
 * rider_status) are read under RLS, so a non-participant gets a 404 and the
 * MongoDB read below is never reached. Then MongoDB latestPositions() gives
 * the newest ping per participant.
 */
import { NextResponse } from "next/server";
import { withUser } from "@/lib/db";
import { latestPositions } from "@/lib/mongo/telemetry";
import { getParticipants, getRide } from "@/app/rides/_lib/queries";
import type { LiveResponse, StatusOption } from "@/app/rides/_lib/types";
import { apiUser, handle, HttpError, rideIdFrom } from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await apiUser();
    const rideId = await rideIdFrom(params);

    const { ride, participants } = await withUser(user.id, async (db) => {
      const ride = await getRide(db, rideId);
      if (!ride) throw new HttpError(404, "Ride not found.");
      return { ride, participants: await getParticipants(db, rideId) };
    });

    const positions = new Map((await latestPositions(rideId)).map((p) => [p.participantId, p]));

    const body: LiveResponse = {
      rideId,
      rideState: ride.ride_state,
      serverTime: new Date().toISOString(),
      participants: participants.map((p) => {
        const pos = positions.get(p.participant_id);
        return {
          participantId: p.participant_id,
          userId: p.user_id,
          name: p.full_name,
          isLeader: p.is_leader,
          joined: p.joined_at !== null,
          status: (p.status_label as StatusOption | null) ?? null,
          statusSetAt: p.status_set_at ? new Date(p.status_set_at).toISOString() : null,
          position: pos
            ? {
                lat: pos.lat,
                lon: pos.lon,
                speedKmph: pos.speedKmph,
                recordedAt: new Date(pos.recordedAt).toISOString(),
              }
            : null,
        };
      }),
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  });
}
