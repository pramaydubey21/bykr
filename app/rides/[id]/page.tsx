/**
 * /rides/[id] — the live map while CREATED/ACTIVE, the ride history once COMPLETED.
 * The ride is read under RLS: a user who is not a participant (or creator)
 * gets no row and therefore a 404.
 */
import { notFound } from "next/navigation";
import { requireUserId } from "@/lib/auth/session";
import { withUser } from "@/lib/db";
import { latestPositions } from "@/lib/mongo/telemetry";
import { getParticipants, getRide } from "../_lib/queries";
import type { LiveResponse, StatusOption } from "../_lib/types";
import LiveRide from "./LiveRide";
import RideHistory from "./RideHistory";

export const dynamic = "force-dynamic";

export default async function RidePage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  const rideId = Number((await params).id);
  if (!Number.isInteger(rideId) || rideId <= 0) notFound();

  const data = await withUser(userId, async (db) => {
    const ride = await getRide(db, rideId);
    if (!ride) return null;
    return { ride, participants: await getParticipants(db, rideId) };
  });
  if (!data) notFound();
  const { ride, participants } = data;

  if (ride.ride_state === "COMPLETED") {
    return <RideHistory rideId={rideId} userId={userId} />;
  }

  const positions = new Map((await latestPositions(rideId)).map((p) => [p.participantId, p]));
  const initial: LiveResponse = {
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
          ? { lat: pos.lat, lon: pos.lon, speedKmph: pos.speedKmph, recordedAt: new Date(pos.recordedAt).toISOString() }
          : null,
      };
    }),
  };

  const mine = participants.find((p) => p.user_id === userId);
  return (
    <LiveRide
      key={ride.ride_state}
      rideId={rideId}
      title={ride.ride_title}
      initial={initial}
      me={{
        userId,
        participantId: mine?.participant_id ?? null,
        joined: !!mine?.joined_at,
        isLeader: !!mine?.is_leader,
      }}
    />
  );
}
