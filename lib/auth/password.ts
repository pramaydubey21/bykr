/**
 * Argon2id password hashing (OWASP parameters: m=19 MiB, t=2, p=1).
 * @node-rs/argon2 defaults to Argon2id; the parameters are stated explicitly so
 * they match the seeded hashes in db/08_seed.sql. The encoded hash carries its
 * own salt and parameters, which is what chk_app_user_hash_argon2 checks for.
 */
import { hash, verify } from "@node-rs/argon2";

const PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  try {
    return await verify(encoded, password);
  } catch {
    return false; // malformed hash: treat as a failed sign-in, never throw
  }
}

// A real hash of a throwaway password, used to spend the same time verifying
// when the email does not exist, so response time does not reveal accounts.
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword("bykr-timing-equaliser");
  return dummy;
}
