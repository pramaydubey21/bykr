/**
 * POST /api/accidents — the single server call behind both the DeviceMotion
 * detector and the "Simulate impact" button.
 *
 * Inside ONE withUser() transaction (app.current_user_id set for RLS):
 *   1. find the caller's live participant row on the ride      (RLS-filtered)
 *   2. store the raw motion window in MongoDB (motion_samples)  → ObjectId
 *   3. INSERT accident_event … motion_sample_id = that ObjectId
 *        - pol_accident_event_insert: only on your own participant row
 *        - trg_accident_requires_active_ride: only on an ACTIVE ride
 *        - trg_generate_sos (AFTER INSERT, WHEN is_confirmed): creates the
 *          sos_alert and every alert_recipient row in this same transaction.
 *          This route does NOT create alerts; it could not — bykr_app has no
 *          INSERT policy on sos_alert.
 *   4. CALL sp_dispatch_alert(alert_id) — records an outcome per recipient
 *      and appends alert_audit rows.
 *
 * MongoDB is not part of the PostgreSQL transaction, so if steps 3–4 fail the
 * evidence document is removed again (best effort).
 *
 * Nothing here contacts any emergency service.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { withUser } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { insertMotionSample, latestPositions } from "@/lib/mongo/telemetry";
import { motionSamples } from "@/lib/mongo/collections";

export const dynamic = "force-dynamic";

const sampleSchema = z.object({
  t: z.number().finite(),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

const bodySchema = z.object({
  rideId: z.number().int().positive(),
  isConfirmed: z.boolean(),
  impactForceG: z.number().finite().positive(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lon: z.number().min(-180).max(180).nullable().optional(),
  detectedAt: z.string().datetime().optional(),
  samples: z.array(sampleSchema).max(5000).default([]),
});

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const b = parsed.data;

  // accident_event.detected_at: accept the client's time unless it is implausible.
  let detectedAt = b.detectedAt ? new Date(b.detectedAt) : new Date();
  if (Math.abs(detectedAt.getTime() - Date.now()) > 5 * 60_000) detectedAt = new Date();

  // chk_accident_event_force: 0 < impact_force < 100, NUMERIC(6,2)
  const impactForce = Math.min(99.99, Math.max(0.01, Math.round(b.impactForceG * 100) / 100));

  let motionId: string | null = null;
  try {
    const result = await withUser(user.id, async (db) => {
      // 1. the caller's participant row — RLS hides rides they are not in
      const { rows: pr } = await db.query<{ participant_id: number; ride_state: string }>(
        `SELECT rp.participant_id, r.ride_state
           FROM ride_participant rp
           JOIN ride r ON r.ride_id = rp.ride_id
          WHERE rp.ride_id = $1
            AND rp.user_id = $2
            AND rp.joined_at IS NOT NULL
            AND rp.left_at IS NULL`,
        [b.rideId, user.id],
      );
      if (pr.length === 0) throw new HttpError(403, "You are not riding this ride.");
      const participantId = pr[0].participant_id;

      // position: browser fix, else this rider's latest ping in MongoDB
      let lat = b.lat ?? null;
      let lon = b.lon ?? null;
      if (lat == null || lon == null) {
        const last = (await latestPositions(b.rideId)).find((p) => p.participantId === participantId);
        if (!last) throw new HttpError(422, "No position available: allow location access or ride for a few seconds first.");
        lat = last.lat;
        lon = last.lon;
      }

      // 2. evidence → MongoDB
      motionId = await insertMotionSample({
        participantId,
        rideId: b.rideId,
        samples: b.samples,
        peakMagnitudeG: impactForce,
        capturedAt: detectedAt,
      });

      // 3. the accident row; trg_generate_sos fires here when is_confirmed
      const { rows: ev } = await db.query<{ event_id: number }>(
        `INSERT INTO accident_event
                (participant_id, impact_force, latitude, longitude, detected_at, is_confirmed, motion_sample_id)
         VALUES ($1, $2, round($3::numeric, 6), round($4::numeric, 6), $5, $6, $7)
         RETURNING event_id`,
        [participantId, impactForce, lat, lon, detectedAt, b.isConfirmed, motionId],
      );
      const eventId = ev[0].event_id;

      if (!b.isConfirmed) return { eventId, alertId: null, recipients: 0 };

      // the alert the trigger just created, in this transaction
      const { rows: al } = await db.query<{ alert_id: number }>(
        `SELECT alert_id FROM sos_alert WHERE event_id = $1`,
        [eventId],
      );
      if (al.length === 0) throw new Error(`trg_generate_sos produced no alert for event ${eventId}`);
      const alertId = al[0].alert_id;

      // 4. dispatch: one outcome + one audit row per recipient
      await db.query(`CALL sp_dispatch_alert($1)`, [alertId]);

      const { rows: cnt } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM alert_recipient WHERE alert_id = $1`,
        [alertId],
      );
      return { eventId, alertId, recipients: cnt[0].n };
    });

    // link the evidence back to its event (not required for integrity)
    if (motionId) {
      const id = motionId;
      await motionSamples()
        .then((c) => c.updateOne({ _id: new ObjectId(id) }, { $set: { eventId: result.eventId } }))
        .catch(() => {});
    }

    return NextResponse.json({ ...result, motionSampleId: motionId }, { status: 201 });
  } catch (err) {
    if (motionId) {
      const id = motionId;
      await motionSamples()
        .then((c) => c.deleteOne({ _id: new ObjectId(id) }))
        .catch(() => {});
    }
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "23514") return NextResponse.json({ error: message }, { status: 409 }); // check_violation (ride not ACTIVE)
    if (code === "42501") return NextResponse.json({ error: message }, { status: 403 }); // RLS / insufficient_privilege
    console.error("POST /api/accidents failed", err);
    return NextResponse.json({ error: "Could not record the accident." }, { status: 500 });
  }
}
