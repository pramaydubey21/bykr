/**
 * Ride history for a COMPLETED ride (server component).
 *
 *   Postgres (under RLS)  ride, participants, ride_summary, ride_waypoint,
 *                         rider_status timeline, fn_similar_rides($1, 5)
 *   MongoDB               participantTrack()     full-rate route per rider
 *                         aggregateRideStats()   aggregation pipeline panel
 */
import Link from "next/link";
import { RouteMap, type RouteLine } from "@/components/map";
import { withUser } from "@/lib/db";
import { aggregateRideStats, participantTrack } from "@/lib/mongo/telemetry";
import {
  getParticipants,
  getRide,
  getStatusHistory,
  getSummary,
  getWaypoints,
  similarRides,
} from "../_lib/queries";
import { STATUS_STYLE, type StatusOption } from "../_lib/types";
import ActionButton from "../ActionButton";

const LINE_COLORS = ["#2563eb", "#a855f7", "#16a34a", "#d97706", "#db2777", "#0891b2", "#65a30d"];

function fmt(n: number | null | undefined, digits = 1) {
  return n == null ? "—" : Number(n).toFixed(digits);
}

export default async function RideHistory({ rideId, userId }: { rideId: number; userId: number }) {
  const pg = await withUser(userId, async (db) => {
    const ride = await getRide(db, rideId);
    if (!ride) return null;
    const [participants, summary, waypoints, statuses, similar] = [
      await getParticipants(db, rideId),
      await getSummary(db, rideId),
      await getWaypoints(db, rideId),
      await getStatusHistory(db, rideId),
      await similarRides(db, rideId),
    ];
    return { ride, participants, summary, waypoints, statuses, similar };
  });
  if (!pg) return null; // page.tsx already 404s on a hidden ride
  const { ride, participants, summary, waypoints, statuses, similar } = pg;

  const joined = participants.filter((p) => p.joined_at);
  const names = new Map(participants.map((p) => [p.participant_id, p.full_name]));

  // Route: MongoDB tracks (leader first); fall back to the downsampled ride_waypoint.
  const [stats, tracks] = await Promise.all([
    aggregateRideStats(rideId),
    Promise.all(joined.map(async (p) => ({ p, track: await participantTrack(rideId, p.participant_id) }))),
  ]);
  let lines: RouteLine[] = tracks
    .filter((t) => t.track.length > 1)
    .map((t, i) => ({
      name: t.p.full_name + (t.p.is_leader ? " (leader)" : ""),
      color: LINE_COLORS[i % LINE_COLORS.length],
      points: t.track.map((x) => ({ lat: x.lat, lon: x.lon })),
    }));
  let routeSource = "MongoDB location_pings (participantTrack)";
  if (lines.length === 0 && waypoints.length > 1) {
    lines = [
      {
        name: "Route (ride_waypoint)",
        color: LINE_COLORS[0],
        points: waypoints.map((w) => ({ lat: Number(w.latitude), lon: Number(w.longitude) })),
      },
    ];
    routeSource = "PostgreSQL ride_waypoint (pings purged or expired)";
  }

  const totalSegments = stats.reduce((m, s) => Math.max(m, s.segments), 0);
  const totalPings = stats.reduce((n, s) => n + s.pings, 0);
  const isCreator = ride.created_by === userId;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <Link href="/rides" className="text-sm text-gray-500 hover:underline">
        ← Rides
      </Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{ride.ride_title}</h1>
          <p className="text-sm text-gray-500">
            <span className="mr-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">COMPLETED</span>
            by {ride.creator_name} · {ride.started_at && new Date(ride.started_at).toLocaleString()} →{" "}
            {ride.ended_at && new Date(ride.ended_at).toLocaleTimeString()} · {joined.length} riders
          </p>
        </div>
        {isCreator && (
          <ActionButton
            url={`/api/rides/${rideId}`}
            method="DELETE"
            label="Delete ride"
            busyLabel="Deleting…"
            confirm="Delete this ride? Its MongoDB telemetry is purged (deleteMany) and the ride and its history are removed."
            redirectTo="/rides"
            className="rounded border border-red-600 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <section>
          <div className="overflow-hidden rounded border">
            <RouteMap lines={lines} height={440} />
          </div>
          <p className="mt-1 text-xs text-gray-500">Route source: {routeSource}</p>
        </section>

        <section className="rounded border p-3">
          <h2 className="mb-2 font-semibold">Summary</h2>
          {summary ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-gray-500">Distance</dt>
              <dd>{fmt(summary.distance_km, 2)} km</dd>
              <dt className="text-gray-500">Duration</dt>
              <dd>{fmt(summary.duration_min, 0)} min</dd>
              <dt className="text-gray-500">Average speed</dt>
              <dd>{fmt(summary.avg_speed_kmph)} km/h</dd>
              <dt className="text-gray-500">Max speed</dt>
              <dd>{fmt(summary.max_speed_kmph)} km/h</dd>
              <dt className="text-gray-500">Stops</dt>
              <dd>{summary.stop_count}</dd>
              <dt className="text-gray-500">Bounding box</dt>
              <dd>{fmt(summary.bbox_diagonal_km, 2)} km diagonal</dd>
              <dt className="text-gray-500">Straightness</dt>
              <dd>{fmt(summary.straightness_ratio, 3)}</dd>
              <dt className="text-gray-500">Embedding</dt>
              <dd>{summary.has_embedding ? "vector(96) stored" : "not computed"}</dd>
            </dl>
          ) : (
            <p className="text-sm text-gray-500">No ride_summary row.</p>
          )}
          <p className="mt-2 text-xs text-gray-500">From ride_summary, written by sp_end_ride.</p>
        </section>
      </div>

      <section className="mt-6 rounded border p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Telemetry (MongoDB aggregation)</h2>
          {totalPings > 0 && (
            <ActionButton
              url={`/api/rides/${rideId}/segments`}
              label="Re-tag segments (updateMany)"
              busyLabel="Tagging…"
              className="rounded border px-3 py-1 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
            />
          )}
        </div>
        {stats.length === 0 ? (
          <p className="text-sm text-gray-500">
            No pings in MongoDB for this ride (purged, or expired by the 30-day TTL index).
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="py-1 pr-3">Rider</th>
                    <th className="py-1 pr-3 text-right">Pings</th>
                    <th className="py-1 pr-3 text-right">Distance km</th>
                    <th className="py-1 pr-3 text-right">Avg km/h</th>
                    <th className="py-1 pr-3 text-right">Max km/h</th>
                    <th className="py-1 pr-3 text-right">Speed var.</th>
                    <th className="py-1 pr-3 text-right">Stops</th>
                    <th className="py-1 pr-3 text-right">Segments</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {stats.map((s) => (
                    <tr key={s.participantId}>
                      <td className="py-1 pr-3">{names.get(s.participantId) ?? `participant ${s.participantId}`}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{s.pings}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{fmt(s.distanceKm, 2)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{fmt(s.avgSpeedKmph)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{fmt(s.maxSpeedKmph)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{fmt(s.speedVariance)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{s.stopCount}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{s.segments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {totalPings} pings · {totalSegments} segment{totalSegments === 1 ? "" : "s"} tagged by tagRideSegments ·
              computed by aggregateRideStats ($match → $setWindowFields → $addFields → $group).
            </p>
          </>
        )}
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <section className="rounded border p-3">
          <h2 className="mb-2 font-semibold">Rides like this one</h2>
          {similar.length === 0 ? (
            <p className="text-sm text-gray-500">
              {summary?.has_embedding ? "No other rides have an embedding yet." : "This ride has no embedding."}
            </p>
          ) : (
            <ol className="space-y-2 text-sm">
              {similar.map((s) => (
                <li key={s.ride_id} className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{s.ride_title}</div>
                    <div className="text-xs text-gray-500">
                      {fmt(s.distance_km, 1)} km · {fmt(s.duration_min, 0)} min · starts {fmt(s.start_lat, 3)},{" "}
                      {fmt(s.start_lon, 3)}
                    </div>
                  </div>
                  <span className="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs tabular-nums" title="cosine similarity">
                    {(1 - s.cosine_distance).toFixed(3)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-2 text-xs text-gray-500">SELECT * FROM fn_similar_rides($1, 5) — pgvector cosine distance (&lt;=&gt;).</p>
        </section>

        <section className="rounded border p-3">
          <h2 className="mb-2 font-semibold">Status history</h2>
          {statuses.length === 0 ? (
            <p className="text-sm text-gray-500">No statuses were set on this ride.</p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
              {statuses.map((s, i) => {
                const st = STATUS_STYLE[s.status_label as StatusOption];
                return (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span>
                      <span className="mr-2 text-xs tabular-nums text-gray-500">{new Date(s.set_at).toLocaleTimeString()}</span>
                      {s.full_name}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: st.bg, color: st.fg }}>
                        {st.label}
                      </span>
                      <span className="w-14 text-right text-xs tabular-nums text-gray-500">
                        {s.minutes != null ? `${fmt(s.minutes)} min` : "open"}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-gray-500">rider_status: set_at / cleared_at, closed by trg_rider_status_close_previous.</p>
        </section>
      </div>
    </main>
  );
}
