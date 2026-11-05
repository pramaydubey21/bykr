import Link from "next/link";
import { withUser } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Counts = {
  users: number;
  rides: number;
  active_rides: number;
  completed_rides: number;
  accidents: number;
  confirmed_accidents: number;
  alerts: number;
  pending_alerts: number;
  audit_rows: number;
};

export default async function AdminHome() {
  const adminId = await requireAdmin();
  const c = await withUser(adminId, async (db) => {
    const { rows } = await db.query<Counts>(
      `SELECT (SELECT count(*)::int FROM app_user)                                   AS users,
              (SELECT count(*)::int FROM ride)                                       AS rides,
              (SELECT count(*)::int FROM ride WHERE ride_state = 'ACTIVE')           AS active_rides,
              (SELECT count(*)::int FROM ride WHERE ride_state = 'COMPLETED')        AS completed_rides,
              (SELECT count(*)::int FROM accident_event)                             AS accidents,
              (SELECT count(*)::int FROM accident_event WHERE is_confirmed)          AS confirmed_accidents,
              (SELECT count(*)::int FROM sos_alert)                                  AS alerts,
              (SELECT count(*)::int FROM sos_alert WHERE delivery_state = 'PENDING') AS pending_alerts,
              (SELECT count(*)::int FROM alert_audit)                                AS audit_rows`,
    );
    return rows[0];
  });

  const cards = [
    { label: "Users", value: c.users, href: null },
    { label: "Rides", value: `${c.rides} (${c.active_rides} active, ${c.completed_rides} completed)`, href: "/admin/rides" },
    { label: "Accident events", value: `${c.accidents} (${c.confirmed_accidents} confirmed)`, href: "/admin/accidents" },
    { label: "SOS alerts", value: `${c.alerts} (${c.pending_alerts} pending)`, href: "/admin/accidents" },
    { label: "Audit rows", value: c.audit_rows, href: "/admin/audit" },
  ];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((k) => {
          const body = (
            <>
              <div className="text-sm text-neutral-500">{k.label}</div>
              <div className="mt-1 text-xl font-semibold">{k.value}</div>
            </>
          );
          return k.href ? (
            <Link key={k.label} href={k.href} className="rounded-xl border border-neutral-200 p-4 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900">
              {body}
            </Link>
          ) : (
            <div key={k.label} className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
              {body}
            </div>
          );
        })}
      </div>
      <p className="text-sm text-neutral-500">
        These counts come from the same tables a rider queries. An admin sees every row because the row level
        security policies call <code>fn_is_admin(fn_current_user_id())</code>, not because this page skips a filter.
      </p>
      <Link
        href="/admin/queries"
        className="inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
      >
        Run the showcase queries →
      </Link>
    </div>
  );
}
