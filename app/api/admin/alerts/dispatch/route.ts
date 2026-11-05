/**
 * POST /api/admin/alerts/dispatch   body: { alertId?: number }
 *
 * Re-runs sp_dispatch_alert for one alert, or for every alert that still has
 * PENDING recipients. The procedure is idempotent (it only walks PENDING
 * recipients) and records an outcome + alert_audit row per recipient.
 * It never contacts any emergency service.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withUser } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ alertId: z.number().int().positive().optional() });

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!user.roles.includes("ADMIN")) return NextResponse.json({ error: "Administrators only" }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { alertId } = parsed.data;

  try {
    const dispatched = await withUser(user.id, async (db) => {
      // The database re-checks: alert_recipient/sos_alert rows are only visible
      // here because fn_is_admin(app.current_user_id) is true.
      const { rows } = await db.query<{ alert_id: number }>(
        `SELECT DISTINCT sa.alert_id
           FROM sos_alert sa
           LEFT JOIN alert_recipient ar ON ar.alert_id = sa.alert_id AND ar.delivery_state = 'PENDING'
          WHERE ($1::int IS NULL OR sa.alert_id = $1)
            AND (sa.delivery_state = 'PENDING' OR ar.recipient_id IS NOT NULL)
          ORDER BY sa.alert_id`,
        [alertId ?? null],
      );
      const out: { alertId: number; deliveryState: string }[] = [];
      for (const r of rows) {
        await db.query(`CALL sp_dispatch_alert($1)`, [r.alert_id]);
        const { rows: s } = await db.query<{ delivery_state: string }>(
          `SELECT delivery_state FROM sos_alert WHERE alert_id = $1`,
          [r.alert_id],
        );
        out.push({ alertId: r.alert_id, deliveryState: s[0]?.delivery_state ?? "UNKNOWN" });
      }
      return out;
    });
    return NextResponse.json({ dispatched });
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: code === "42501" ? 403 : 500 });
  }
}
