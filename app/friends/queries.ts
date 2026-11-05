/**
 * Friend-circle SQL. Every call goes through withUser(me, …) so the request
 * runs with app.current_user_id set, and every statement additionally filters
 * on the caller's id — a rider can only see or change links they are part of.
 */
import { withUser } from "@/lib/db";

export type Friend = { friendship_id: number; user_id: number; full_name: string; email: string; linked_at: string };
export type PendingRequest = { friendship_id: number; user_id: number; full_name: string; email: string; requested_at: string };
export type Suggestion = { user_id: number; full_name: string; mutual_count: number; requested: boolean };

export type FriendsOverview = {
  circle: Friend[];
  incoming: PendingRequest[];
  outgoing: PendingRequest[];
  suggestions: Suggestion[];
};

export function getFriendsOverview(me: number): Promise<FriendsOverview> {
  return withUser(me, async (db) => {
    // Accepted links, whichever side of the pair I am on.
    const circle = await db.query<Friend>(
      `SELECT f.friendship_id, u.user_id, u.full_name, u.email, f.linked_at
         FROM friendship f
         JOIN app_user u
           ON u.user_id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
        WHERE $1 IN (f.requester_id, f.addressee_id)
          AND f.link_state = 'ACCEPTED'
        ORDER BY u.full_name`,
      [me],
    );

    const incoming = await db.query<PendingRequest>(
      `SELECT f.friendship_id, u.user_id, u.full_name, u.email, f.requested_at
         FROM friendship f
         JOIN app_user u ON u.user_id = f.requester_id
        WHERE f.addressee_id = $1 AND f.link_state = 'PENDING'
        ORDER BY f.requested_at DESC`,
      [me],
    );

    const outgoing = await db.query<PendingRequest>(
      `SELECT f.friendship_id, u.user_id, u.full_name, u.email, f.requested_at
         FROM friendship f
         JOIN app_user u ON u.user_id = f.addressee_id
        WHERE f.requester_id = $1 AND f.link_state = 'PENDING'
        ORDER BY f.requested_at DESC`,
      [me],
    );

    // "People you may know": riders exactly two hops away in the accepted
    // friendship graph, from the recursive CTE in fn_friends_within. The
    // mutual count is how many of my direct friends link to them.
    const suggestions = await db.query<Suggestion>(
      `WITH reach AS (SELECT user_id, full_name, degree FROM fn_friends_within($1, 2)),
            mine  AS (SELECT user_id FROM reach WHERE degree = 1)
       SELECT r.user_id, r.full_name,
              (SELECT COUNT(*)::INT
                 FROM friendship x
                WHERE x.link_state = 'ACCEPTED'
                  AND (   (x.requester_id = r.user_id AND x.addressee_id IN (SELECT user_id FROM mine))
                       OR (x.addressee_id = r.user_id AND x.requester_id IN (SELECT user_id FROM mine)))
              ) AS mutual_count,
              EXISTS (SELECT 1 FROM friendship p
                       WHERE LEAST(p.requester_id, p.addressee_id)    = LEAST($1, r.user_id)
                         AND GREATEST(p.requester_id, p.addressee_id) = GREATEST($1, r.user_id)
              ) AS requested
         FROM reach r
        WHERE r.degree = 2
        ORDER BY mutual_count DESC, r.full_name
        LIMIT 12`,
      [me],
    );

    return {
      circle: circle.rows,
      incoming: incoming.rows,
      outgoing: outgoing.rows,
      suggestions: suggestions.rows,
    };
  });
}

export class FriendError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * Sends a request to a rider identified by email or id. If that rider already
 * sent me a pending request, accepting it is the natural meaning, so we do that.
 */
export function sendFriendRequest(me: number, target: { email?: string; userId?: number }): Promise<"sent" | "accepted"> {
  return withUser(me, async (db) => {
    const found = await db.query<{ user_id: number }>(
      target.userId != null
        ? `SELECT user_id FROM app_user WHERE user_id = $1`
        : `SELECT user_id FROM app_user WHERE email = lower($1)`,
      [target.userId ?? target.email],
    );
    const other = found.rows[0]?.user_id;
    if (!other) throw new FriendError("No rider with that email.", 404);
    if (other === me) throw new FriendError("You cannot add yourself.");

    const reverse = await db.query(
      `UPDATE friendship
          SET link_state = 'ACCEPTED', linked_at = now()
        WHERE requester_id = $1 AND addressee_id = $2 AND link_state = 'PENDING'`,
      [other, me],
    );
    if (reverse.rowCount) return "accepted";

    const inserted = await db.query(
      `INSERT INTO friendship (requester_id, addressee_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [me, other],
    );
    if (!inserted.rowCount) throw new FriendError("You are already connected or a request is pending.", 409);
    return "sent";
  });
}

/** Only the addressee may accept, and only a PENDING request. */
export function acceptFriendRequest(me: number, friendshipId: number): Promise<boolean> {
  return withUser(me, async (db) => {
    const res = await db.query(
      `UPDATE friendship
          SET link_state = 'ACCEPTED', linked_at = now()
        WHERE friendship_id = $1 AND addressee_id = $2 AND link_state = 'PENDING'`,
      [friendshipId, me],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

/** Decline an incoming request, cancel an outgoing one, or unfriend. */
export function removeFriendship(me: number, friendshipId: number): Promise<boolean> {
  return withUser(me, async (db) => {
    const res = await db.query(
      `DELETE FROM friendship
        WHERE friendship_id = $1
          AND $2 IN (requester_id, addressee_id)
          AND link_state IN ('PENDING', 'ACCEPTED')`,
      [friendshipId, me],
    );
    return (res.rowCount ?? 0) > 0;
  });
}
