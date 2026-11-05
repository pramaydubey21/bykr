/**
 * "Recommended for you" — the vector feature (spec section 5).
 *
 * fn_recommend_rides (db/03_functions.sql) averages the route_embedding of
 * this rider's completed rides into a centroid and returns the nearest rides
 * they have not been on, ordered by pgvector's cosine distance operator <=>
 * (HNSW index, vector_cosine_ops). Two riders with different histories get
 * different centroids and therefore different lists.
 */
import { withUser } from "@/lib/db";
import { requireUserId } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Row = {
  ride_id: number;
  ride_title: string;
  distance_km: number | null;
  duration_min: number | null;
  start_lat: number | null;
  start_lon: number | null;
  cosine_distance: number;
};

export default async function RecommendationsPage() {
  const userId = await requireUserId();
  const rows = await withUser(userId, async (db) => {
    const { rows } = await db.query<Row>(`SELECT * FROM fn_recommend_rides($1, 5)`, [userId]);
    return rows;
  });

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-1 text-2xl font-bold">Recommended for you</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Rides you have not been on whose 96-dimensional route embedding is closest (cosine distance) to the
        average of your completed rides.
      </p>
      <pre className="mb-6 overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs dark:bg-neutral-900">
        SELECT * FROM fn_recommend_rides({userId}, 5);
      </pre>

      {rows.length === 0 ? (
        <p className="rounded-lg bg-neutral-50 p-4 text-sm text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
          No recommendations yet. Complete a ride so there is a route history to compare against.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-900">
              <tr>
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">Ride</th>
                <th className="px-4 py-2 text-right font-medium">Distance</th>
                <th className="px-4 py-2 text-right font-medium">Duration</th>
                <th className="px-4 py-2 font-medium">Start</th>
                <th className="px-4 py-2 text-right font-medium">Cosine distance</th>
                <th className="px-4 py-2 text-right font-medium">Similarity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.ride_id} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-4 py-2 text-neutral-500">{i + 1}</td>
                  <td className="px-4 py-2 font-medium">
                    {r.ride_title} <span className="text-xs text-neutral-500">#{r.ride_id}</span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {r.distance_km != null ? `${r.distance_km.toFixed(1)} km` : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {r.duration_min != null ? `${Math.round(r.duration_min)} min` : "—"}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-neutral-500">
                    {r.start_lat != null && r.start_lon != null
                      ? `${r.start_lat.toFixed(3)}, ${r.start_lon.toFixed(3)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.cosine_distance.toFixed(4)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Math.round((1 - r.cosine_distance) * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
