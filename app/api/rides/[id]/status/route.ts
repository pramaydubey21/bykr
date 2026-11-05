/**
 * POST /api/rides/[id]/status { label } — publish a rider status.
 * Inserts into rider_status; trg_rider_status_close_previous closes the
 * previous open status in the same statement.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withUser } from "@/lib/db";
import { setStatus, STATUS_LABELS } from "@/app/rides/_lib/queries";
import { apiUser, handle, HttpError, rideIdFrom } from "../../_lib/http";

export const dynamic = "force-dynamic";

const Body = z.object({ label: z.enum(STATUS_LABELS) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await apiUser();
    const rideId = await rideIdFrom(params);
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, `label must be one of ${STATUS_LABELS.join(", ")}.`);

    const n = await withUser(user.id, (db) => setStatus(db, rideId, user.id, parsed.data.label));
    if (n === 0) throw new HttpError(403, "You can set a status only as a joined participant of an ACTIVE ride.");
    return NextResponse.json({ status: parsed.data.label });
  });
}
