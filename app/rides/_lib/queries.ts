/**
 * Every SQL statement behind the ride screens, hand-written (no ORM).
 *
 * Each function takes the transaction client handed out by withUser(), so
 * app.current_user_id is already set and PostgreSQL row level security
 * (db/02_rbac.sql) filters every row. A rider who is not a participant of a
 * ride simply gets zero rows back from these queries; the route handlers turn
 * that into a 404.
 *
 * Note on INSERT INTO ride: there is deliberately no RETURNING clause.
 * RETURNING re-checks the SELECT policy against the new row, and the policy's
 * STABLE helper fn_user_can_view_ride() runs on the statement's snapshot, in
 * which the row does not exist yet. The id is read with currval() instead.
 */
import type { Db } from "@/lib/db";
import { STATUS_LABELS, type StatusLabel } from "@/lib/vector";

export { STATUS_LABELS, type StatusLabel };
export type RideState = "CREATED" | "ACTIVE" | "COMPLETED";

// ---------------------------------------------------------------------------
// Ride list / detail
// ---------------------------------------------------------------------------
export type RideListRow = {
  ride_id: number;
  ride_title: string;
  ride_state: RideState;
  created_by: number;
  creator_name: string;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  my_participant_id: number | null;
  my_joined_at: Date | null;
  i_am_leader: boolean;
  joined_count: number;
  invited_count: number;
};

/** Rides the user is in (joined or invited) or created. RLS already hides the rest. */
export async function listMyRides(db: Db, userId: number): Promise<RideListRow[]> {
  const { rows } = await db.query<RideListRow>(
    `SELECT r.ride_id, r.ride_title, r.ride_state, r.created_by,
            u.full_name                         AS creator_name,
            r.created_at, r.started_at, r.ended_at,
            me.participant_id                   AS my_participant_id,
            me.joined_at                        AS my_joined_at,
            COALESCE(me.is_leader, false)       AS i_am_leader,
            (SELECT count(*)::int FROM ride_participant x
              WHERE x.ride_id = r.ride_id AND x.joined_at IS NOT NULL) AS joined_count,
            (SELECT count(*)::int FROM ride_participant x
              WHERE x.ride_id = r.ride_id AND x.joined_at IS NULL)     AS invited_count
       FROM ride r
       JOIN app_user u              ON u.user_id = r.created_by
       LEFT JOIN ride_participant me ON me.ride_id = r.ride_id AND me.user_id = $1
      WHERE me.participant_id IS NOT NULL OR r.created_by = $1
      ORDER BY CASE r.ride_state WHEN 'ACTIVE' THEN 0 WHEN 'CREATED' THEN 1 ELSE 2 END,
               COALESCE(r.ended_at, r.started_at, r.created_at) DESC`,
    [userId],
  );
  return rows;
}

export type RideRow = {
  ride_id: number;
  ride_title: string;
  ride_state: RideState;
  created_by: number;
  creator_name: string;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
};

/** One ride, or null when it does not exist OR row level security hides it. */
export async function getRide(db: Db, rideId: number): Promise<RideRow | null> {
  const { rows } = await db.query<RideRow>(
    `SELECT r.ride_id, r.ride_title, r.ride_state, r.created_by, u.full_name AS creator_name,
            r.created_at, r.started_at, r.ended_at
       FROM ride r
       JOIN app_user u ON u.user_id = r.created_by
      WHERE r.ride_id = $1`,
    [rideId],
  );
  return rows[0] ?? null;
}

export type ParticipantRow = {
  participant_id: number;
  user_id: number;
  full_name: string;
  is_leader: boolean;
  invited_at: Date;
  joined_at: Date | null;
  left_at: Date | null;
  status_label: StatusLabel | null;
  status_set_at: Date | null;
};

/** Participants of a ride with each one's current (open) status. */
export async function getParticipants(db: Db, rideId: number): Promise<ParticipantRow[]> {
  const { rows } = await db.query<ParticipantRow>(
    `SELECT rp.participant_id, rp.user_id, u.full_name, rp.is_leader,
            rp.invited_at, rp.joined_at, rp.left_at,
            st.status_label, rs.set_at AS status_set_at
       FROM ride_participant rp
       JOIN app_user u           ON u.user_id = rp.user_id
       LEFT JOIN rider_status rs ON rs.participant_id = rp.participant_id
                                AND rs.cleared_at IS NULL
       LEFT JOIN status_type st  ON st.type_id = rs.type_id
      WHERE rp.ride_id = $1
      ORDER BY rp.is_leader DESC, rp.joined_at IS NULL, u.full_name`,
    [rideId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Create / invite / join / start
// ---------------------------------------------------------------------------
export type FriendRow = { user_id: number; full_name: string };

/** The user's accepted friends: the only people they may invite. */
export async function listFriends(db: Db, userId: number): Promise<FriendRow[]> {
  const { rows } = await db.query<FriendRow>(
    `SELECT u.user_id, u.full_name
       FROM friendship f
       JOIN app_user u
         ON u.user_id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
      WHERE f.link_state = 'ACCEPTED'
        AND $1 IN (f.requester_id, f.addressee_id)
      ORDER BY u.full_name`,
    [userId],
  );
  return rows;
}

/**
 * Create a ride, add the creator as the joined leader, and invite friends as
 * participant rows with joined_at NULL. Ids that are not accepted friends are
 * dropped by the join against friendship. All inside the caller's transaction.
 */
export async function createRide(
  db: Db,
  userId: number,
  title: string,
  inviteUserIds: number[],
): Promise<{ rideId: number; invited: number }> {
  await db.query(`INSERT INTO ride (created_by, ride_title) VALUES ($1, $2)`, [userId, title]);
  const { rows } = await db.query<{ ride_id: number }>(
    `SELECT currval(pg_get_serial_sequence('ride', 'ride_id'))::int AS ride_id`,
  );
  const rideId = rows[0].ride_id;

  await db.query(
    `INSERT INTO ride_participant (ride_id, user_id, joined_at, is_leader)
     VALUES ($1, $2, now(), true)`,
    [rideId, userId],
  );

  const inv = await db.query(
    `INSERT INTO ride_participant (ride_id, user_id)
     SELECT $1, fr.friend_id
       FROM (SELECT CASE WHEN f.requester_id = $2 THEN f.addressee_id ELSE f.requester_id END AS friend_id
               FROM friendship f
              WHERE f.link_state = 'ACCEPTED'
                AND $2 IN (f.requester_id, f.addressee_id)) fr
      WHERE fr.friend_id = ANY($3::int[])
     ON CONFLICT ON CONSTRAINT uq_ride_participant_ride_user DO NOTHING`,
    [rideId, userId, inviteUserIds],
  );
  return { rideId, invited: inv.rowCount ?? 0 };
}

/** Accept an invitation. Only the invitee's own row matches (and RLS allows only that). */
export async function joinRide(db: Db, rideId: number, userId: number): Promise<number> {
  const res = await db.query(
    `UPDATE ride_participant rp
        SET joined_at = now()
       FROM ride r
      WHERE r.ride_id = rp.ride_id
        AND rp.ride_id = $1
        AND rp.user_id = $2
        AND rp.joined_at IS NULL
        AND r.ride_state <> 'COMPLETED'`,
    [rideId, userId],
  );
  return res.rowCount ?? 0;
}

/**
 * CREATED -> ACTIVE. The pol_ride_update policy already limits UPDATE to the
 * leader (or an admin); fn_is_ride_leader() here makes it leader-only. The
 * leader's status opens as RIDING so the map has a badge from the first poll.
 */
export async function startRide(db: Db, rideId: number, userId: number): Promise<number> {
  const res = await db.query(
    `UPDATE ride
        SET ride_state = 'ACTIVE', started_at = now()
      WHERE ride_id = $1
        AND ride_state = 'CREATED'
        AND fn_is_ride_leader($2, ride_id)`,
    [rideId, userId],
  );
  if ((res.rowCount ?? 0) > 0) await setStatus(db, rideId, userId, "RIDING");
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Live ride
// ---------------------------------------------------------------------------
/** The caller's participant id if they may send pings now: joined, not left, ride ACTIVE. */
export async function activeParticipantId(db: Db, rideId: number, userId: number): Promise<number | null> {
  const { rows } = await db.query<{ participant_id: number }>(
    `SELECT rp.participant_id
       FROM ride_participant rp
       JOIN ride r ON r.ride_id = rp.ride_id
      WHERE rp.ride_id = $1
        AND rp.user_id = $2
        AND rp.joined_at IS NOT NULL
        AND rp.left_at IS NULL
        AND r.ride_state = 'ACTIVE'`,
    [rideId, userId],
  );
  return rows[0]?.participant_id ?? null;
}

/**
 * Publish a status. trg_rider_status_close_previous (BEFORE INSERT) stamps
 * cleared_at on the previous open status in the same statement.
 */
export async function setStatus(db: Db, rideId: number, userId: number, label: StatusLabel): Promise<number> {
  const res = await db.query(
    `INSERT INTO rider_status (participant_id, type_id)
     SELECT rp.participant_id, st.type_id
       FROM ride_participant rp
       JOIN ride r        ON r.ride_id = rp.ride_id
       JOIN status_type st ON st.status_label = $3
      WHERE rp.ride_id = $1
        AND rp.user_id = $2
        AND rp.joined_at IS NOT NULL
        AND r.ride_state = 'ACTIVE'`,
    [rideId, userId, label],
  );
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Ride history
// ---------------------------------------------------------------------------
export type SummaryRow = {
  distance_km: number;
  duration_min: number;
  avg_speed_kmph: number;
  max_speed_kmph: number;
  stop_count: number;
  start_lat: number;
  start_lon: number;
  end_lat: number;
  end_lon: number;
  bbox_diagonal_km: number;
  straightness_ratio: number;
  has_embedding: boolean;
  computed_at: Date;
};

export async function getSummary(db: Db, rideId: number): Promise<SummaryRow | null> {
  const { rows } = await db.query<SummaryRow>(
    `SELECT distance_km, duration_min, avg_speed_kmph, max_speed_kmph, stop_count,
            start_lat, start_lon, end_lat, end_lon, bbox_diagonal_km, straightness_ratio,
            route_embedding IS NOT NULL AS has_embedding, computed_at
       FROM ride_summary
      WHERE ride_id = $1`,
    [rideId],
  );
  return rows[0] ?? null;
}

export type WaypointRow = { latitude: number; longitude: number; speed_kmph: number | null; recorded_at: Date };

export async function getWaypoints(db: Db, rideId: number): Promise<WaypointRow[]> {
  const { rows } = await db.query<WaypointRow>(
    `SELECT latitude, longitude, speed_kmph, recorded_at
       FROM ride_waypoint
      WHERE ride_id = $1
      ORDER BY seq`,
    [rideId],
  );
  return rows;
}

export type StatusHistoryRow = {
  full_name: string;
  status_label: StatusLabel;
  set_at: Date;
  cleared_at: Date | null;
  minutes: number | null;
};

/** Status timeline: when each state was set and when it was cleared. */
export async function getStatusHistory(db: Db, rideId: number): Promise<StatusHistoryRow[]> {
  const { rows } = await db.query<StatusHistoryRow>(
    `SELECT u.full_name, st.status_label, rs.set_at, rs.cleared_at,
            round((EXTRACT(EPOCH FROM (rs.cleared_at - rs.set_at)) / 60)::numeric, 1) AS minutes
       FROM rider_status rs
       JOIN ride_participant rp ON rp.participant_id = rs.participant_id
       JOIN app_user u          ON u.user_id = rp.user_id
       JOIN status_type st      ON st.type_id = rs.type_id
      WHERE rp.ride_id = $1
      ORDER BY rs.set_at, u.full_name`,
    [rideId],
  );
  return rows;
}

export type SimilarRideRow = {
  ride_id: number;
  ride_title: string;
  distance_km: number;
  duration_min: number;
  start_lat: number;
  start_lon: number;
  cosine_distance: number;
};

/** "Rides like this one": pgvector cosine nearest neighbours (db/03_functions.sql). */
export async function similarRides(db: Db, rideId: number): Promise<SimilarRideRow[]> {
  const { rows } = await db.query<SimilarRideRow>(`SELECT * FROM fn_similar_rides($1, 5)`, [rideId]);
  return rows;
}

/** Delete a ride the caller created. pol_ride_delete allows only the creator (or an admin). */
export async function deleteRide(db: Db, rideId: number): Promise<number> {
  const res = await db.query(`DELETE FROM ride WHERE ride_id = $1`, [rideId]);
  return res.rowCount ?? 0;
}
