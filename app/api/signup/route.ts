import { NextResponse } from "next/server";
import { hashPassword } from "@/lib/auth/password";
import { createRider, EmailTakenError } from "@/lib/auth/users";
import { firstIssue, signUpSchema } from "@/lib/auth/validation";

export const runtime = "nodejs";

/** POST /api/signup — creates app_user + RIDER role in one transaction. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = signUpSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { fullName, email, phone, password } = parsed.data;

  try {
    const passwordHash = await hashPassword(password);
    const userId = await createRider({ fullName, email, phone, passwordHash });
    return NextResponse.json({ userId }, { status: 201 });
  } catch (err) {
    if (err instanceof EmailTakenError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("signup failed", err);
    return NextResponse.json({ error: "Could not create the account." }, { status: 500 });
  }
}
