/**
 * Emergency-contact SQL. Ownership is enforced by row level security
 * (pol_emergency_contact_select / pol_emergency_contact_write in
 * db/02_rbac.sql): withUser(me, …) sets app.current_user_id and the policies
 * hide and protect every row whose user_id is not mine. The UPDATE and DELETE
 * below therefore filter on contact_id alone — a foreign id simply matches
 * zero rows. Note SELECT also filters on user_id = me, because the policy lets
 * an ADMIN read every contact and this page should show only the caller's own.
 */
import { z } from "zod";
import { withUser } from "@/lib/db";
import { PHONE_RE } from "@/lib/auth/validation";

export const RELATIONS = ["PARENT", "SPOUSE", "SIBLING", "FRIEND", "RELATIVE", "OTHER"] as const;

export const contactSchema = z.object({
  contactName: z.string().trim().min(1, "Name is required").max(120),
  contactPhone: z.string().trim().regex(PHONE_RE, "Phone: 7–20 digits, spaces or dashes, optional +"),
  relation: z.enum(RELATIONS, { message: "Pick a relation" }),
});
export type ContactInput = z.infer<typeof contactSchema>;

export type Contact = { contact_id: number; contact_name: string; contact_phone: string; relation: string };

export type Profile = { full_name: string; email: string; phone_no: string | null; created_at: string; roles: string[] };

export function getProfile(me: number): Promise<Profile | null> {
  return withUser(me, async (db) => {
    const { rows } = await db.query<Profile>(
      `SELECT u.full_name, u.email, u.phone_no, u.created_at,
              COALESCE(array_agg(r.role_name ORDER BY r.role_name)
                       FILTER (WHERE r.role_name IS NOT NULL), '{}') AS roles
         FROM app_user u
         LEFT JOIN user_role ur ON ur.user_id = u.user_id
         LEFT JOIN app_role  r  ON r.role_id  = ur.role_id
        WHERE u.user_id = $1
        GROUP BY u.user_id`,
      [me],
    );
    return rows[0] ?? null;
  });
}

export function listContacts(me: number): Promise<Contact[]> {
  return withUser(me, async (db) => {
    const { rows } = await db.query<Contact>(
      `SELECT contact_id, contact_name, contact_phone, relation
         FROM emergency_contact
        WHERE user_id = $1
        ORDER BY contact_name`,
      [me],
    );
    return rows;
  });
}

export function addContact(me: number, c: ContactInput): Promise<Contact> {
  return withUser(me, async (db) => {
    // WITH CHECK (user_id = fn_current_user_id()) rejects any other user_id.
    const { rows } = await db.query<Contact>(
      `INSERT INTO emergency_contact (user_id, contact_name, contact_phone, relation)
       VALUES ($1, $2, $3, $4)
       RETURNING contact_id, contact_name, contact_phone, relation`,
      [me, c.contactName, c.contactPhone, c.relation],
    );
    return rows[0];
  });
}

export function updateContact(me: number, contactId: number, c: ContactInput): Promise<Contact | null> {
  return withUser(me, async (db) => {
    const { rows } = await db.query<Contact>(
      `UPDATE emergency_contact
          SET contact_name = $2, contact_phone = $3, relation = $4
        WHERE contact_id = $1
        RETURNING contact_id, contact_name, contact_phone, relation`,
      [contactId, c.contactName, c.contactPhone, c.relation],
    );
    return rows[0] ?? null;
  });
}

export function deleteContact(me: number, contactId: number): Promise<boolean> {
  return withUser(me, async (db) => {
    const res = await db.query(`DELETE FROM emergency_contact WHERE contact_id = $1`, [contactId]);
    return (res.rowCount ?? 0) > 0;
  });
}

/** Turn a pg constraint violation into a message for the form. */
export function contactErrorMessage(constraint: string | undefined): string | null {
  switch (constraint) {
    case "uq_emergency_contact_user_phone":
      return "You already have a contact with that phone number.";
    case "chk_emergency_contact_phone":
      return "Phone: 7–20 digits, spaces or dashes, optional +.";
    case "chk_emergency_contact_relation":
      return "Pick a relation from the list.";
    default:
      return null;
  }
}
