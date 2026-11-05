import { NextResponse } from "next/server";
import { apiUserId, badRequest, constraintOf, parseId, unauthorized } from "@/lib/auth/api";
import { contactErrorMessage, contactSchema, deleteContact, updateContact } from "@/app/profile/queries";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/contacts/:id — edit. RLS makes another rider's id match nothing (404). */
export async function PATCH(req: Request, { params }: Ctx) {
  const me = await apiUserId();
  if (!me) return unauthorized();
  const id = parseId((await params).id);
  if (!id) return badRequest("Bad contact id.");
  const parsed = contactSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid contact");
  try {
    const updated = await updateContact(me, id, parsed.data);
    if (!updated) return badRequest("Contact not found.", 404);
    return NextResponse.json(updated);
  } catch (err) {
    const msg = contactErrorMessage(constraintOf(err));
    if (msg) return badRequest(msg, 409);
    throw err;
  }
}

/** DELETE /api/contacts/:id */
export async function DELETE(_req: Request, { params }: Ctx) {
  const me = await apiUserId();
  if (!me) return unauthorized();
  const id = parseId((await params).id);
  if (!id) return badRequest("Bad contact id.");
  if (!(await deleteContact(me, id))) return badRequest("Contact not found.", 404);
  return NextResponse.json({ ok: true });
}
