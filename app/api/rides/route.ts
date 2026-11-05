/**
 * GET  /api/rides   the caller's rides (RLS-filtered)
 * POST /api/rides   create a ride { title, inviteUserIds[] }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withUser } from "@/lib/db";
import { createRide, listMyRides } from "@/app/rides/_lib/queries";
import { apiUser, handle, HttpError } from "./_lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const user = await apiUser();
    const rides = await withUser(user.id, (db) => listMyRides(db, user.id));
    return NextResponse.json({ rides });
  });
}

const CreateBody = z.object({
  title: z.string().trim().min(1).max(120),
  inviteUserIds: z.array(z.number().int().positive()).max(50).default([]),
});

export async function POST(req: Request) {
  return handle(async () => {
    const user = await apiUser();
    const parsed = CreateBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Give the ride a title (1-120 characters).");
    const { title, inviteUserIds } = parsed.data;
    const result = await withUser(user.id, (db) => createRide(db, user.id, title, inviteUserIds));
    return NextResponse.json(result, { status: 201 });
  });
}
