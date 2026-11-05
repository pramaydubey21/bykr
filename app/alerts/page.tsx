/**
 * Alerts this user may see. No WHERE clause on the user: row level security
 * (pol_sos_alert_select → fn_user_can_view_ride) returns exactly the alerts
 * from rides the viewer is part of, or all of them for an administrator.
 */
import Link from "next/link";
import { withUser } from "@/lib/db";
import { requireUserId } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Row = {
  alert_id: number;
  delivery_state: string;
  sent_at: Date;
  ride_id: number;
  ride_title: string;
  rider_name: string;
  recipients: number;
};

export default async function AlertsPage() {
  const userId = await requireUserId();
  const rows = await withUser(userId, async (db) => {
    const { rows } = await db.query<Row>(
      `SELECT sa.alert_id, sa.delivery_state, sa.sent_at,
              r.ride_id, r.ride_title, u.full_name AS rider_name,
              (SELECT count(*)::int FROM alert_recipient ar WHERE ar.alert_id = sa.alert_id) AS recipients
         FROM sos_alert sa
         JOIN accident_event   e  ON e.event_id        = sa.event_id
         JOIN ride_participant rp ON rp.participant_id = e.participant_id
         JOIN ride             r  ON r.ride_id         = rp.ride_id
         JOIN app_user         u  ON u.user_id         = rp.user_id
        ORDER BY sa.sent_at DESC`,
    );
    return rows;
  });

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold">Alerts</h1>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500">No alerts on any ride you are part of.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {rows.map((r) => (
            <li key={r.alert_id}>
              <Link
                href={`/alerts/${r.alert_id}`}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                <span>
                  <span className="font-medium">#{r.alert_id} · {r.rider_name}</span>
                  <span className="text-neutral-500"> on {r.ride_title}</span>
                </span>
                <span className="text-sm text-neutral-500">
                  {r.recipients} recipients · {r.delivery_state} · {new Date(r.sent_at).toLocaleString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
