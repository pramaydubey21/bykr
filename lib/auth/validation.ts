import { z } from "zod";

// Mirrors the CHECK constraints on app_user / emergency_contact so the user
// gets a readable message before the database rejects the row.
export const PHONE_RE = /^\+?[0-9 \-]{7,20}$/;

export const signUpSchema = z.object({
  fullName: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  phone: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || PHONE_RE.test(v), "Phone: 7–20 digits, spaces or dashes, optional +")
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export type SignUpInput = z.infer<typeof signUpSchema>;

export function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Invalid input";
}
