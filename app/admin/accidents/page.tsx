import Link from "next/link";
import { withUser } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import DispatchButton from "../_components/DispatchButton";

export const dynamic = "force-dynamic";

type Row = {
  event_id: number;
  detected_at: Date;
  is_confirmed: boolean;
  impact_force: number;
  latitude: number;
  longitude: number;
  motion_sample_id: string | null;
  rider: string;
  ride_id: number;
  ride_title: string;
  alert_id: number | null;
  alert_state: string | null;
  recipients: number;
  pending: number;
};

export default async function AdminAccidents() {
  const adminId = await requireAdmin();
  const rows = await withUser(adminId, async (db) => {
    // LEFT JOIN sos_alert: a NULL alert is meaningful — a cancelled event.
    const { rows } = await db.query<Row>(
      `SELECT e.event_id, e.detected_at, e.is_confirmed, e.impact_force, e.latitude, e.longitude,
              e.motion_sample_id, u.full_name AS rider, r.ride_id, r.ride_title,
              sa.alert_id, sa.delivery_state AS alert_state,
              count(ar.recipient_id)::int                                              AS recipients,
              count(ar.recipient_id) FILTER (WHERE ar.delivery_state = 'PENDING')::int AS pending
         FROM accident_event e
         JOIN ride_participant rp      ON rp.participant_id = e.participant_id
         JOIN app_user u               ON u.user_id = rp.user_id
         JOIN ride r                   ON r.ride_id = rp.ride_id
         LEFT JOIN sos_alert sa        ON sa.event_id = e.event_id
         LEFT JOIN alert_recipient ar  ON ar.alert_id = sa.alert_id
        GROUP BY e.event_id, u.full_name, r.ride_id, sa.alert_id
        ORDER BY e.detected_at DESC`,
    );
    return rows;
  });
  const pendingAlerts = rows.filter((r) => r.alert_id != null && (r.alert_state === "PENDING" || r.pending > 0)).length;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">All accident events ({rows.length})</h2>
        <DispatchButton label={`Re-dispatch all pending (${pendingAlerts})`} disabled={pendingAlerts === 0} />
      </div>
      <p className="mb-4 text-sm text-neutral-500">
        Re-dispatch calls <code>sp_dispatch_alert</code>, which only touches recipients still in PENDING and is
        idempotent. Authority and emergency-contact recipients end in MANUAL_ACTION_REQUIRED: bykr never contacts
        an emergency service.
      </p>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-900">
            <tr>
              {["event", "detected", "rider", "ride", "impact", "position", "confirmed", "evidence", "alert", "recipients", ""].map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-4 text-center text-neutral-500">No accident events.</td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.event_id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-3 py-2 tabular-nums">#{r.event_id}</td>
                <td className="whitespace-nowrap px-3 py-2">{new Date(r.detected_at).toLocaleString()}</td>
                <td className="px-3 py-2">{r.rider}</td>
                <td className="px-3 py-2">{r.ride_title} <span className="text-neutral-500">#{r.ride_id}</span></td>
                <td className="px-3 py-2 tabular-nums">{r.impact_force.toFixed(1)} g</td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-neutral-500">
                  {r.latitude.toFixed(4)}, {r.longitude.toFixed(4)}
                </td>
                <td className="px-3 py-2">{r.is_confirmed ? "yes" : <span className="text-neutral-500">cancelled</span>}</td>
                <td className="px-3 py-2 font-mono text-xs text-neutral-500">{r.motion_sample_id?.slice(-8) ?? "—"}</td>
                <td className="px-3 py-2">
                  {r.alert_id != null ? (
                    <Link href={`/alerts/${r.alert_id}`} className="underline">
                      #{r.alert_id} {r.alert_state}
                    </Link>
                  ) : (
                    <span className="text-neutral-500">none</span>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {r.alert_id != null ? `${r.recipients}${r.pending ? ` (${r.pending} pending)` : ""}` : "—"}
                </td>
                <td className="px-3 py-2">
                  {r.alert_id != null && (r.alert_state === "PENDING" || r.pending > 0) && (
                    <DispatchButton alertId={r.alert_id} label="Re-dispatch" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
