/**
 * Alert view: the fan-out created by trg_generate_sos, every recipient and
 * each recipient's delivery state as recorded by sp_dispatch_alert, plus the
 * MongoDB geospatial read "Riders near the accident" (findParticipantsNear).
 *
 * Every SQL read runs through withUser(), so row level security decides what
 * this viewer may see: a rider outside the ride gets a 404, and a co-rider
 * sees the emergency-contact rows but not the contacts' names or numbers
 * (pol_emergency_contact_select allows only the owner and admins).
 *
 * Authority records are DISPLAYED for a person to act on. Nothing on this page
 * or behind it contacts an emergency service.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { withUser } from "@/lib/db";
import { requireUserId } from "@/lib/auth/session";
import { findParticipantsNear, type NearbyRider } from "@/lib/mongo/telemetry";
import { haversineKm } from "@/lib/geo";

export const dynamic = "force-dynamic";

type AlertRow = {
  alert_id: number;
  channel: string;
  sent_at: Date;
  alert_state: string;
  event_id: number;
  impact_force: number;
  latitude: number;
  longitude: number;
  detected_at: Date;
  motion_sample_id: string | null;
  ride_id: number;
  ride_title: string;
  rider_id: number;
  rider_name: string;
};

type RecipientRow = {
  recipient_id: number;
  recipient_kind: "CO_RIDER" | "EMERGENCY_CONTACT" | "AUTHORITY";
  delivery_state: string;
  attempted_at: Date | null;
  name: string | null;
  phone: string | null;
  detail: string | null;
};

const KIND_LABEL: Record<RecipientRow["recipient_kind"], string> = {
  CO_RIDER: "Co-rider",
  EMERGENCY_CONTACT: "Emergency contact",
  AUTHORITY: "Authority",
};

const STATE_STYLE: Record<string, string> = {
  PENDING: "bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100",
  DELIVERED: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200",
  DISPATCHED: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200",
  MANUAL_ACTION_REQUIRED: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200",
  PARTIAL: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
};

function Badge({ state }: { state: string }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATE_STYLE[state] ?? STATE_STYLE.PENDING}`}>
      {state}
    </span>
  );
}

const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString() : "—");

export default async function AlertPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const alertId = Number(id);
  if (!Number.isInteger(alertId) || alertId <= 0) notFound();
  const userId = await requireUserId();

  const data = await withUser(userId, async (db) => {
    const { rows: a } = await db.query<AlertRow>(
      `SELECT sa.alert_id, sa.channel, sa.sent_at, sa.delivery_state AS alert_state,
              e.event_id, e.impact_force, e.latitude, e.longitude, e.detected_at, e.motion_sample_id,
              r.ride_id, r.ride_title,
              u.user_id AS rider_id, u.full_name AS rider_name
         FROM sos_alert sa
         JOIN accident_event   e  ON e.event_id        = sa.event_id
         JOIN ride_participant rp ON rp.participant_id = e.participant_id
         JOIN ride             r  ON r.ride_id         = rp.ride_id
         JOIN app_user         u  ON u.user_id         = rp.user_id
        WHERE sa.alert_id = $1`,
      [alertId],
    );
    if (a.length === 0) return null;

    // One row per recipient. Exactly one of user_id / contact_id / authority_id
    // is set (chk_alert_recipient_exactly_one), so COALESCE picks the right one.
    const { rows: recipients } = await db.query<RecipientRow>(
      `SELECT ar.recipient_id, ar.recipient_kind, ar.delivery_state, ar.attempted_at,
              COALESCE(u.full_name, ec.contact_name, au.authority_name) AS name,
              COALESCE(u.phone_no,  ec.contact_phone, au.contact_no)    AS phone,
              CASE ar.recipient_kind
                   WHEN 'EMERGENCY_CONTACT' THEN ec.relation
                   WHEN 'AUTHORITY'         THEN au.authority_type || ' · ' || au.jurisdiction
              END AS detail
         FROM alert_recipient ar
         LEFT JOIN app_user          u  ON u.user_id       = ar.user_id
         LEFT JOIN emergency_contact ec ON ec.contact_id   = ar.contact_id
         LEFT JOIN authority         au ON au.authority_id = ar.authority_id
        WHERE ar.alert_id = $1
        ORDER BY CASE ar.recipient_kind WHEN 'CO_RIDER' THEN 1 WHEN 'EMERGENCY_CONTACT' THEN 2 ELSE 3 END,
                 ar.recipient_id`,
      [alertId],
    );
    return { alert: a[0], recipients };
  });
  if (!data) notFound();
  const { alert, recipients } = data;

  // ---- MongoDB geospatial read: who was within 2 km, ±10 minutes ----------
  const at = new Date(alert.detected_at).getTime();
  let nearby: (NearbyRider & { name: string; distanceM: number })[] = [];
  let nearbyError: string | null = null;
  try {
    const found = await findParticipantsNear(
      alert.latitude,
      alert.longitude,
      2000,
      new Date(at - 10 * 60_000),
      new Date(at + 10 * 60_000),
    );
    const names = found.length
      ? await withUser(userId, async (db) => {
          const { rows } = await db.query<{ user_id: number; full_name: string }>(
            `SELECT user_id, full_name FROM app_user WHERE user_id = ANY($1::int[])`,
            [found.map((f) => f.userId)],
          );
          return new Map(rows.map((r) => [r.user_id, r.full_name]));
        })
      : new Map<number, string>();
    nearby = found.map((f) => ({
      ...f,
      name: names.get(f.userId) ?? `User ${f.userId}`,
      distanceM: Math.round(
        haversineKm({ lat: alert.latitude, lon: alert.longitude }, { lat: f.lat, lon: f.lon }) * 1000,
      ),
    }));
  } catch (err) {
    nearbyError = err instanceof Error ? err.message : String(err);
  }

  const counts = recipients.reduce<Record<string, number>>((acc, r) => {
    acc[r.recipient_kind] = (acc[r.recipient_kind] ?? 0) + 1;
    return acc;
  }, {});
  const hasAuthority = recipients.some((r) => r.recipient_kind === "AUTHORITY");

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/alerts" className="text-sm text-neutral-500 hover:underline">
        ← All alerts
      </Link>
      <div className="mb-6 mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">SOS alert #{alert.alert_id}</h1>
        <Badge state={alert.alert_state} />
      </div>

      <dl className="mb-8 grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl border border-neutral-200 p-5 text-sm sm:grid-cols-2 dark:border-neutral-800">
        <div>
          <dt className="text-neutral-500">Rider</dt>
          <dd className="font-medium">{alert.rider_name}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Ride</dt>
          <dd className="font-medium">
            <Link href={`/rides/${alert.ride_id}`} className="hover:underline">
              {alert.ride_title}
            </Link>
          </dd>
        </div>
        <div>
          <dt className="text-neutral-500">Detected</dt>
          <dd>{fmt(alert.detected_at)}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Location</dt>
          <dd className="tabular-nums">
            {alert.latitude.toFixed(5)}, {alert.longitude.toFixed(5)}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-500">Peak impact</dt>
          <dd>{alert.impact_force.toFixed(2)} g</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Accident event · evidence</dt>
          <dd>
            #{alert.event_id} ·{" "}
            <code className="text-xs">{alert.motion_sample_id ?? "no motion sample"}</code>
          </dd>
        </div>
        <div>
          <dt className="text-neutral-500">Channel · sent</dt>
          <dd>
            {alert.channel} · {fmt(alert.sent_at)}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-500">Fan-out</dt>
          <dd>
            {recipients.length} recipients — {counts.CO_RIDER ?? 0} co-riders, {counts.EMERGENCY_CONTACT ?? 0}{" "}
            emergency contacts, {counts.AUTHORITY ?? 0} authorities
          </dd>
        </div>
      </dl>

      {hasAuthority && (
        <p className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          bykr does not contact emergency services. Authority records below are shown so that a person can
          decide whether to call them. Their state is MANUAL_ACTION_REQUIRED for that reason.
        </p>
      )}

      <h2 className="mb-3 text-lg font-semibold">Recipients</h2>
      <div className="mb-10 overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">Kind</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Phone</th>
              <th className="px-4 py-2 font-medium">Detail</th>
              <th className="px-4 py-2 font-medium">Delivery state</th>
              <th className="px-4 py-2 font-medium">Attempted</th>
            </tr>
          </thead>
          <tbody>
            {recipients.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-neutral-500">
                  No recipients.
                </td>
              </tr>
            )}
            {recipients.map((r) => (
              <tr key={r.recipient_id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-4 py-2 tabular-nums text-neutral-500">{r.recipient_id}</td>
                <td className="px-4 py-2">{KIND_LABEL[r.recipient_kind]}</td>
                {r.name == null ? (
                  <td colSpan={3} className="px-4 py-2 italic text-neutral-500">
                    Hidden by row level security — only the rider and administrators see contact details
                  </td>
                ) : (
                  <>
                    <td className="px-4 py-2 font-medium">{r.name}</td>
                    <td className="px-4 py-2 tabular-nums">{r.phone ?? "—"}</td>
                    <td className="px-4 py-2 text-neutral-600 dark:text-neutral-400">{r.detail ?? ""}</td>
                  </>
                )}
                <td className="px-4 py-2">
                  <Badge state={r.delivery_state} />
                </td>
                <td className="px-4 py-2 text-neutral-500">{fmt(r.attempted_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mb-1 text-lg font-semibold">Riders near the accident</h2>
      <p className="mb-3 text-sm text-neutral-500">
        MongoDB <code>$near</code> on the 2dsphere index: location pings within 2 km of the accident between
        10 minutes before and 10 minutes after it, closest approach per participant.
      </p>
      {nearbyError ? (
        <p className="rounded-lg bg-red-50 p-4 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">
          MongoDB query failed: {nearbyError}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-neutral-500 dark:bg-neutral-900">
              <tr>
                <th className="px-4 py-2 font-medium">Rider</th>
                <th className="px-4 py-2 font-medium">Ride</th>
                <th className="px-4 py-2 font-medium">Closest approach</th>
                <th className="px-4 py-2 font-medium">Position</th>
                <th className="px-4 py-2 font-medium">At</th>
              </tr>
            </thead>
            <tbody>
              {nearby.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-neutral-500">
                    No pings within 2 km in that window.
                  </td>
                </tr>
              )}
              {nearby.map((n) => (
                <tr key={n.participantId} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-4 py-2 font-medium">
                    {n.name}
                    {n.userId === alert.rider_id && <span className="ml-2 text-xs text-red-600">(affected rider)</span>}
                  </td>
                  <td className="px-4 py-2">
                    {n.rideId === alert.ride_id ? "this ride" : `ride #${n.rideId}`}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{n.distanceM} m</td>
                  <td className="px-4 py-2 tabular-nums text-neutral-500">
                    {n.lat.toFixed(5)}, {n.lon.toFixed(5)}
                  </td>
                  <td className="px-4 py-2 text-neutral-500">{fmt(n.recordedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
