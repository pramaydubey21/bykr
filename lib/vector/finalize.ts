/**
 * Ending a ride touches both databases. Used by POST /api/rides/[id]/end and
 * by scripts/seed.ts, so seeded rides go through exactly the same path.
 *
 *   1. MongoDB  participantTrack()         leader's full-rate track
 *   2. Postgres INSERT ride_waypoint        downsampled route (<= 300 points)
 *   3. Postgres CALL sp_end_ride()          leader check, COMPLETED, ride_summary
 *   4. MongoDB  aggregateRideStats()        speed variance etc. for the embedding
 *   5. Postgres UPDATE ride_summary SET route_embedding = $vector
 * then, after the Postgres transaction commits, the caller runs
 *   6. MongoDB  tagRideSegments()           updateMany segment ids
 */
import type { Db } from "../db";

import { decimate } from "../geo";
import { aggregateRideStats, participantTrack, type TrackPoint } from "../mongo/telemetry";
import { buildRouteEmbedding, toPgVector, STATUS_LABELS, type StatusLabel } from "./index";

const MAX_WAYPOINTS = 300;

async function routeTrack(db: Db, rideId: number): Promise<{ leaderPid: number; track: TrackPoint[] }> {
  const { rows } = await db.query<{ participant_id: number; is_leader: boolean }>(
    `SELECT participant_id, is_leader
       FROM ride_participant
      WHERE ride_id = $1 AND joined_at IS NOT NULL
      ORDER BY is_leader DESC, participant_id`,
    [rideId],
  );
  if (rows.length === 0) throw new Error(`ride ${rideId} has no joined participants`);
  const leaderPid = rows[0].participant_id;
  let track = await participantTrack(rideId, leaderPid);
  // If the leader never sent a ping (e.g. sat at a desk), use whoever sent most.
  if (track.length < 2) {
    for (const r of rows.slice(1)) {
      const t = await participantTrack(rideId, r.participant_id);
      if (t.length > track.length) track = t;
    }
  }
  return { leaderPid, track };
}

export async function finalizeRide(
  db: Db,
  rideId: number,
  leaderUserId: number,
): Promise<{ leaderParticipantId: number; waypoints: number; embedded: boolean }> {
  const { leaderPid, track } = await routeTrack(db, rideId);

  const wps = decimate(track, MAX_WAYPOINTS);
  if (wps.length > 0) {
    // One multi-row INSERT from parallel arrays.
    await db.query(
      `INSERT INTO ride_waypoint (ride_id, seq, latitude, longitude, speed_kmph, recorded_at)
       SELECT $1, w.seq - 1, w.lat, w.lon, w.speed, w.at
         FROM unnest($2::numeric[], $3::numeric[], $4::numeric[], $5::timestamptz[])
              WITH ORDINALITY AS w(lat, lon, speed, at, seq)
       ON CONFLICT ON CONSTRAINT pk_ride_waypoint DO NOTHING`,
      [
        rideId,
        wps.map((p) => p.lat.toFixed(6)),
        wps.map((p) => p.lon.toFixed(6)),
        wps.map((p) => Math.min(400, Math.max(0, p.speedKmph)).toFixed(2)),
        wps.map((p) => p.recordedAt.toISOString()),
      ],
    );
  }

  await db.query("CALL sp_end_ride($1, $2)", [rideId, leaderUserId]);

  const embedded = await computeEmbedding(db, rideId, leaderPid, track);
  return { leaderParticipantId: leaderPid, waypoints: wps.length, embedded };
}

/** Build the 96-d vector for a completed ride and store it. */
export async function computeEmbedding(
  db: Db,
  rideId: number,
  leaderPid: number,
  track?: TrackPoint[],
): Promise<boolean> {
  const t = track ?? (await participantTrack(rideId, leaderPid));
  const { rows: sum } = await db.query<{
    distance_km: number; duration_min: number; avg_speed_kmph: number;
    max_speed_kmph: number; stop_count: number; started_at: Date;
  }>(
    `SELECT s.distance_km, s.duration_min, s.avg_speed_kmph, s.max_speed_kmph, s.stop_count, r.started_at
       FROM ride_summary s JOIN ride r ON r.ride_id = s.ride_id
      WHERE s.ride_id = $1`,
    [rideId],
  );
  if (sum.length === 0 || t.length < 2) return false;
  const s = sum[0];

  const { rows: st } = await db.query<{ status_label: StatusLabel; n: number }>(
    `SELECT t.status_label, count(*)::int AS n
       FROM rider_status rs
       JOIN ride_participant rp ON rp.participant_id = rs.participant_id
       JOIN status_type t       ON t.type_id = rs.type_id
      WHERE rp.ride_id = $1
      GROUP BY t.status_label`,
    [rideId],
  );
  const statusCounts = Object.fromEntries(STATUS_LABELS.map((l) => [l, 0])) as Record<StatusLabel, number>;
  let statusChanges = 0;
  for (const r of st) {
    statusCounts[r.status_label] = r.n;
    statusChanges += r.n;
  }

  // The MongoDB aggregation pipeline supplies the stop count (from the
  // full-rate pings); lib/vector derives distance, speeds, variance,
  // straightness and bounding box from the pings itself.
  const stats = (await aggregateRideStats(rideId)).find((p) => p.participantId === leaderPid);

  const vector = buildRouteEmbedding(t, {
    statusChanges,
    statusCounts,
    stopCount: stats?.stopCount ?? s.stop_count,
    startTime: new Date(s.started_at),
  });

  await db.query(`UPDATE ride_summary SET route_embedding = $2::vector WHERE ride_id = $1`, [
    rideId,
    toPgVector(vector),
  ]);
  return true;
}
