/**
 * POST /api/rides/[id]/pings — body is an ARRAY of pings.
 *
 * The browser sends one ping per 5 s tick while online; while offline it
 * buffers them and, on reconnection, flushes the whole buffer in a single
 * call, which becomes one MongoDB insertMany (insertPingsBulk).
 *
 * Accepted only when the ride is ACTIVE and the caller is a joined
 * participant; that check is a SQL query under RLS.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withUser } from "@/lib/db";
import { insertPingsBulk, type PingInput } from "@/lib/mongo/telemetry";
import { activeParticipantId } from "@/app/rides/_lib/queries";
import { apiUser, handle, HttpError, rideIdFrom } from "../../_lib/http";

export const dynamic = "force-dynamic";

const MAX_BATCH = 5000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // buffered pings older than a day are refused
const MAX_SKEW_MS = 2 * 60 * 1000; // tolerate a slightly fast client clock

const Ping = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  speedKmph: z.number().min(0).max(400),
  accuracyM: z.number().min(0).max(100_000),
  recordedAt: z.string().datetime({ offset: true }),
});
const Body = z.array(Ping).min(1).max(MAX_BATCH);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await apiUser();
    const rideId = await rideIdFrom(params);

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(400, `Body must be an array of 1-${MAX_BATCH} pings {lat, lon, speedKmph, accuracyM, recordedAt}.`);
    }

    const participantId = await withUser(user.id, (db) => activeParticipantId(db, rideId, user.id));
    if (participantId === null) {
      throw new HttpError(403, "Pings are accepted only from a joined participant of an ACTIVE ride.");
    }

    const now = Date.now();
    const batch: PingInput[] = [];
    let dropped = 0;
    for (const p of parsed.data) {
      const at = new Date(p.recordedAt);
      if (at.getTime() < now - MAX_AGE_MS || at.getTime() > now + MAX_SKEW_MS) {
        dropped++;
        continue;
      }
      batch.push({
        participantId,
        rideId,
        userId: user.id,
        lat: p.lat,
        lon: p.lon,
        speedKmph: p.speedKmph,
        accuracyM: p.accuracyM,
        recordedAt: at,
      });
    }

    const inserted = await insertPingsBulk(batch);
    return NextResponse.json({ received: parsed.data.length, inserted, dropped });
  });
}
