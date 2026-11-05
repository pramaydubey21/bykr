import { withUser } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import DataTable from "../_components/DataTable";

export const dynamic = "force-dynamic";

type Row = {
  ride_id: number;
  ride_title: string;
  ride_state: string;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  participants: number;
  joined: number;
  distance_km: number | null;
  has_embedding: boolean;
  accidents: number;
};

export default async function AdminRides() {
  const adminId = await requireAdmin();
  const rows = await withUser(adminId, async (db) => {
    const { rows } = await db.query<Row>(
      `SELECT r.ride_id, r.ride_title, r.ride_state, u.full_name AS created_by,
              r.created_at, r.started_at, r.ended_at,
              count(DISTINCT rp.participant_id)::int                                       AS participants,
              count(DISTINCT rp.participant_id) FILTER (WHERE rp.joined_at IS NOT NULL)::int AS joined,
              s.distance_km,
              (s.route_embedding IS NOT NULL)                                              AS has_embedding,
              count(DISTINCT e.event_id)::int                                              AS accidents
         FROM ride r
         JOIN app_user u               ON u.user_id = r.created_by
         LEFT JOIN ride_participant rp ON rp.ride_id = r.ride_id
         LEFT JOIN ride_summary s      ON s.ride_id = r.ride_id
         LEFT JOIN accident_event e    ON e.participant_id = rp.participant_id
        GROUP BY r.ride_id, u.full_name, s.distance_km, s.route_embedding
        ORDER BY r.created_at DESC`,
    );
    return rows;
  });

  const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString() : null);
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">All rides ({rows.length})</h2>
      <DataTable
        columns={["id", "title", "state", "created by", "created", "started", "ended", "participants", "joined", "distance km", "embedding", "accidents"]}
        rows={rows.map((r) => [
          r.ride_id,
          r.ride_title,
          r.ride_state,
          r.created_by,
          fmt(r.created_at),
          fmt(r.started_at),
          fmt(r.ended_at),
          r.participants,
          r.joined,
          r.distance_km,
          r.has_embedding ? "yes" : "no",
          r.accidents,
        ])}
      />
    </section>
  );
}
