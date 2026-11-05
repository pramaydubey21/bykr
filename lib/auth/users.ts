/**
 * Account queries for sign-in and sign-up. Hand-written SQL through lib/db.
 * These run before anyone is signed in, so they use anonymous() — app_user,
 * user_role and app_role are not under row level security.
 */
import { anonymous } from "@/lib/db";

export type AuthRow = {
  user_id: number;
  full_name: string;
  email: string;
  password_hash: string;
  roles: string[];
};

export function findUserForSignIn(email: string): Promise<AuthRow | null> {
  return anonymous(async (db) => {
    const { rows } = await db.query<AuthRow>(
      `SELECT u.user_id, u.full_name, u.email, u.password_hash,
              COALESCE(array_agg(r.role_name ORDER BY r.role_name)
                       FILTER (WHERE r.role_name IS NOT NULL), '{}') AS roles
         FROM app_user u
         LEFT JOIN user_role ur ON ur.user_id = u.user_id
         LEFT JOIN app_role  r  ON r.role_id  = ur.role_id
        WHERE u.email = $1
        GROUP BY u.user_id`,
      [email],
    );
    return rows[0] ?? null;
  });
}

export class EmailTakenError extends Error {}

/**
 * Creates the account and grants RIDER in ONE transaction (anonymous() wraps
 * fn in BEGIN/COMMIT): if the role grant fails, the user row is rolled back.
 */
export function createRider(input: {
  fullName: string;
  email: string;
  phone: string | null;
  passwordHash: string;
}): Promise<number> {
  return anonymous(async (db) => {
    try {
      const { rows } = await db.query<{ user_id: number }>(
        `INSERT INTO app_user (full_name, email, phone_no, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING user_id`,
        [input.fullName, input.email, input.phone, input.passwordHash],
      );
      const userId = rows[0].user_id;
      await db.query(
        `INSERT INTO user_role (user_id, role_id)
         SELECT $1, role_id FROM app_role WHERE role_name = 'RIDER'`,
        [userId],
      );
      return userId;
    } catch (err) {
      if ((err as { constraint?: string }).constraint === "uq_app_user_email") {
        throw new EmailTakenError("An account with this email already exists.");
      }
      throw err;
    }
  });
}
