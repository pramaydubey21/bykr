import { NextResponse } from "next/server";
import { apiUserId, badRequest, constraintOf, unauthorized } from "@/lib/auth/api";
import { addContact, contactErrorMessage, contactSchema, listContacts } from "@/app/profile/queries";

export const runtime = "nodejs";

/** GET /api/contacts — my emergency contacts. */
export async function GET() {
  const me = await apiUserId();
  if (!me) return unauthorized();
  return NextResponse.json(await listContacts(me));
}

/** POST /api/contacts { contactName, contactPhone, relation } */
export async function POST(req: Request) {
  const me = await apiUserId();
  if (!me) return unauthorized();
  const parsed = contactSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid contact");
  try {
    return NextResponse.json(await addContact(me, parsed.data), { status: 201 });
  } catch (err) {
    const msg = contactErrorMessage(constraintOf(err));
    if (msg) return badRequest(msg, 409);
    throw err;
  }
}
