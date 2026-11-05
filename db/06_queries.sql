-- =============================================================================
-- bykr — 06_queries.sql
-- Showcase queries. Rubric columns N (nested, correlated, recursive and join
-- queries) and O (advanced SQL: CTE), plus K/P for the vector query.
--
-- Format: every block starts with
--     -- @query <short_snake_name>
--     -- Rubric: <column letter and name>
--     -- <one-line description>
-- and contains exactly ONE statement ending in ";". The admin page splits this
-- file on "-- @query" and runs each block as-is, so every parameter is a
-- literal (seed ids: users 1–8 riders, 9 admin; rides 1–9 COMPLETED,
-- 10–11 ACTIVE, 12 CREATED).
--
-- Every statement is read-only. Run as the application role with an ADMIN
-- app.current_user_id, row level security lets every row through; run as a
-- rider, the same statements return only that rider's rides.
--
-- "Distance a rider covered" is computed in SQL from data PostgreSQL holds:
-- the ride's downsampled route (ride_waypoint) counted only during the
-- intervals in which that rider's status was RIDING (rider_status). Raw
-- per-rider pings live in MongoDB.
-- =============================================================================


-- @query friends_of_friends_recursive
-- Rubric: N — recursive query (also O — CTE)
-- Everyone within 3 friendship hops of user 1 (Aarav), with degree of separation and one shortest path.
WITH RECURSIVE edges AS (                  -- accepted friendships, walked in both directions
    SELECT requester_id AS from_user, addressee_id AS to_user FROM friendship WHERE link_state = 'ACCEPTED'
    UNION ALL
    SELECT addressee_id, requester_id          FROM friendship WHERE link_state = 'ACCEPTED'
),
walk (user_id, degree, path) AS (
    SELECT 1, 0, ARRAY[1]                      -- anchor: the starting rider
    UNION ALL
    SELECT e.to_user, w.degree + 1, w.path || e.to_user
    FROM walk w
    JOIN edges e ON e.from_user = w.user_id
    WHERE w.degree < 3                         -- depth limit
      AND NOT e.to_user = ANY (w.path)         -- never revisit a node: no cycles
)
SELECT DISTINCT ON (w.user_id)
       w.user_id,
       u.full_name,
       w.degree                                         AS degree_of_separation,
       (SELECT string_agg(pu.full_name, ' → ' ORDER BY p.ord)
          FROM unnest(w.path) WITH ORDINALITY AS p(uid, ord)
          JOIN app_user pu ON pu.user_id = p.uid)       AS shortest_path
FROM walk w
JOIN app_user u ON u.user_id = w.user_id
WHERE w.user_id <> 1
ORDER BY w.user_id, w.degree;


-- @query faster_than_ride_mates_correlated
-- Rubric: N — correlated subquery
-- Riders whose average speed while RIDING beat the average of the OTHER riders on the same ride.
WITH legs AS (
    SELECT w.ride_id, w.recorded_at,
           fn_haversine_km(LAG(w.latitude) OVER win, LAG(w.longitude) OVER win, w.latitude, w.longitude) AS leg_km,
           EXTRACT(EPOCH FROM w.recorded_at - LAG(w.recorded_at) OVER win) / 3600.0                       AS leg_h
    FROM ride_waypoint w
    WINDOW win AS (PARTITION BY w.ride_id ORDER BY w.seq)
),
rider_speed AS (
    SELECT rp.ride_id, rp.participant_id, rp.user_id,
           sum(l.leg_km) / NULLIF(sum(l.leg_h), 0) AS riding_kmph
    FROM ride_participant rp
    JOIN rider_status rs ON rs.participant_id = rp.participant_id
    JOIN status_type st  ON st.type_id = rs.type_id AND st.status_label = 'RIDING'
    JOIN legs l          ON l.ride_id = rp.ride_id
                        AND l.recorded_at >  rs.set_at
                        AND l.recorded_at <= COALESCE(rs.cleared_at, 'infinity')
    GROUP BY rp.ride_id, rp.participant_id, rp.user_id
)
SELECT r.ride_id, r.ride_title, u.full_name,
       round(me.riding_kmph::NUMERIC, 2) AS my_riding_kmph,
       round((SELECT avg(other.riding_kmph)                 -- correlated: re-evaluated per outer row,
                FROM rider_speed other                      -- referencing me.ride_id and me.participant_id
               WHERE other.ride_id = me.ride_id
                 AND other.participant_id <> me.participant_id)::NUMERIC, 2) AS ride_mates_avg_kmph
FROM rider_speed me
JOIN ride r     ON r.ride_id = me.ride_id
JOIN app_user u ON u.user_id = me.user_id
WHERE me.riding_kmph > (SELECT avg(other.riding_kmph)
                          FROM rider_speed other
                         WHERE other.ride_id = me.ride_id
                           AND other.participant_id <> me.participant_id)
ORDER BY r.ride_id, me.riding_kmph DESC;


-- @query rides_above_average_size_nested
-- Rubric: N — nested subquery
-- Rides with more participants than the average ride (three levels of nesting).
SELECT r.ride_id, r.ride_title, r.ride_state,
       (SELECT count(*) FROM ride_participant rp WHERE rp.ride_id = r.ride_id) AS participants
FROM ride r
WHERE r.ride_id IN (
        SELECT rp.ride_id
        FROM ride_participant rp
        GROUP BY rp.ride_id
        HAVING count(*) > (                         -- level 2: the overall average
                SELECT avg(per_ride.n)
                FROM (SELECT count(*) AS n          -- level 3: participants per ride
                      FROM ride_participant
                      GROUP BY ride_id) AS per_ride
        )
)
ORDER BY participants DESC, r.ride_id;


-- @query ride_report_cte_chain
-- Rubric: O — CTE (non-recursive chain)
-- Report for ride 5, built in stages: ride → participants → status timeline → incidents and alerts → one row per rider.
WITH the_ride AS (
    SELECT r.ride_id, r.ride_title, r.ride_state, r.started_at, r.ended_at,
           s.distance_km, s.duration_min, s.avg_speed_kmph
    FROM ride r
    LEFT JOIN ride_summary s ON s.ride_id = r.ride_id
    WHERE r.ride_id = 5
),
riders AS (
    SELECT rp.participant_id, rp.user_id, u.full_name, rp.is_leader, rp.joined_at, rp.left_at
    FROM ride_participant rp
    JOIN the_ride tr ON tr.ride_id = rp.ride_id
    JOIN app_user u  ON u.user_id = rp.user_id
),
status_time AS (                                   -- minutes spent in each status
    SELECT rs.participant_id, st.status_label,
           sum(EXTRACT(EPOCH FROM COALESCE(rs.cleared_at, tr.ended_at, now()) - rs.set_at) / 60.0) AS minutes,
           count(*) AS times_set
    FROM rider_status rs
    JOIN riders ri       ON ri.participant_id = rs.participant_id
    JOIN status_type st  ON st.type_id = rs.type_id
    CROSS JOIN the_ride tr
    GROUP BY rs.participant_id, st.status_label
),
status_summary AS (                                -- one line per rider
    SELECT participant_id,
           sum(times_set) AS status_changes,
           string_agg(status_label || ' ' || round(minutes::NUMERIC, 0) || ' min', ', '
                      ORDER BY minutes DESC) AS time_by_status
    FROM status_time
    GROUP BY participant_id
),
incidents AS (                                     -- accidents, their alert and fan-out size
    SELECT e.participant_id,
           -- DISTINCT: the recipient join repeats each event once per recipient
           count(DISTINCT e.event_id)                                AS accidents,
           count(DISTINCT e.event_id) FILTER (WHERE e.is_confirmed)  AS confirmed,
           max(e.impact_force)                                       AS peak_g,
           count(DISTINCT a.alert_id)                                AS alerts,
           count(DISTINCT ar.recipient_id)                           AS alert_recipients
    FROM accident_event e
    JOIN riders ri               ON ri.participant_id = e.participant_id
    LEFT JOIN sos_alert a        ON a.event_id = e.event_id
    LEFT JOIN alert_recipient ar ON ar.alert_id = a.alert_id
    GROUP BY e.participant_id
)
SELECT tr.ride_id, tr.ride_title, tr.ride_state, tr.distance_km, tr.duration_min,
       ri.full_name, ri.is_leader,
       COALESCE(ss.status_changes, 0)  AS status_changes,
       ss.time_by_status,
       COALESCE(i.accidents, 0)        AS accidents,
       COALESCE(i.confirmed, 0)        AS confirmed_accidents,
       i.peak_g,
       COALESCE(i.alert_recipients, 0) AS alert_recipients
FROM the_ride tr
CROSS JOIN riders ri
LEFT JOIN status_summary ss ON ss.participant_id = ri.participant_id
LEFT JOIN incidents i       ON i.participant_id  = ri.participant_id
ORDER BY ri.is_leader DESC, ri.full_name;


-- @query rides_without_accidents_left_join
-- Rubric: N — join query (7 tables, LEFT JOIN anti-join)
-- Rides with NO accident event at all, with leader, size, statuses used and distance; the LEFT JOIN's missing rows are the answer.
SELECT r.ride_id,
       r.ride_title,
       r.ride_state,
       leader.full_name                               AS leader,
       count(DISTINCT rp.participant_id)              AS riders,
       count(DISTINCT rs.status_id)                   AS status_updates,
       string_agg(DISTINCT st.status_label, ', ')     AS statuses_used,
       s.distance_km
FROM ride r
JOIN ride_participant lp      ON lp.ride_id = r.ride_id AND lp.is_leader
JOIN app_user leader          ON leader.user_id = lp.user_id
JOIN ride_participant rp      ON rp.ride_id = r.ride_id
LEFT JOIN rider_status rs     ON rs.participant_id = rp.participant_id
LEFT JOIN status_type st      ON st.type_id = rs.type_id
LEFT JOIN ride_summary s      ON s.ride_id = r.ride_id
LEFT JOIN (accident_event ae                       -- any accident by any participant of this ride
           JOIN ride_participant ap ON ap.participant_id = ae.participant_id)
       ON ap.ride_id = r.ride_id
WHERE ae.event_id IS NULL                          -- absence of a match = accident-free ride
GROUP BY r.ride_id, r.ride_title, r.ride_state, leader.full_name, s.distance_km
ORDER BY r.ride_id;


-- @query rider_distance_rank_window
-- Rubric: N/O — window functions
-- Riders ranked by distance covered while RIDING within each completed ride, with gap to the leader of the ranking and share of the route.
WITH legs AS (
    SELECT w.ride_id, w.recorded_at,
           fn_haversine_km(LAG(w.latitude) OVER win, LAG(w.longitude) OVER win, w.latitude, w.longitude) AS leg_km
    FROM ride_waypoint w
    WINDOW win AS (PARTITION BY w.ride_id ORDER BY w.seq)
),
rider_km AS (
    SELECT rp.ride_id, rp.user_id, COALESCE(sum(l.leg_km), 0) AS riding_km
    FROM ride_participant rp
    JOIN ride r ON r.ride_id = rp.ride_id AND r.ride_state = 'COMPLETED'
    LEFT JOIN (rider_status rs
               JOIN status_type st ON st.type_id = rs.type_id AND st.status_label = 'RIDING')
           ON rs.participant_id = rp.participant_id
    LEFT JOIN legs l ON l.ride_id = rp.ride_id
                    AND l.recorded_at >  rs.set_at
                    AND l.recorded_at <= COALESCE(rs.cleared_at, 'infinity')
    GROUP BY rp.ride_id, rp.user_id
)
SELECT k.ride_id,
       u.full_name,
       round(k.riding_km::NUMERIC, 2)                                                   AS riding_km,
       RANK()       OVER ride_w                                                         AS rank_in_ride,
       DENSE_RANK() OVER ride_w                                                         AS dense_rank_in_ride,
       round((first_value(k.riding_km) OVER ride_w - k.riding_km)::NUMERIC, 2)          AS km_behind_top,
       round((100 * k.riding_km / NULLIF(s.distance_km, 0))::NUMERIC, 1)                AS pct_of_route,
       round(avg(k.riding_km) OVER (PARTITION BY k.ride_id)::NUMERIC, 2)                AS ride_avg_km
FROM rider_km k
JOIN app_user u          ON u.user_id = k.user_id
LEFT JOIN ride_summary s ON s.ride_id = k.ride_id
WINDOW ride_w AS (PARTITION BY k.ride_id ORDER BY k.riding_km DESC)
ORDER BY k.ride_id, rank_in_ride, u.full_name;


-- @query popular_status_types_having
-- Rubric: N — aggregate with GROUP BY / HAVING
-- Status types set more than 10 times across all rides, with how many riders used them and their average duration.
SELECT st.status_label,
       st.icon_name,
       count(*)                                                        AS times_set,
       count(DISTINCT rp.user_id)                                      AS distinct_riders,
       count(DISTINCT rp.ride_id)                                      AS rides,
       round(avg(EXTRACT(EPOCH FROM rs.cleared_at - rs.set_at) / 60.0)::NUMERIC, 1) AS avg_minutes
FROM rider_status rs
JOIN status_type st      ON st.type_id = rs.type_id
JOIN ride_participant rp ON rp.participant_id = rs.participant_id
GROUP BY st.status_label, st.icon_name
HAVING count(*) > 10
ORDER BY times_set DESC;


-- @query similar_rides_vector
-- Rubric: K/P — vector similarity (pgvector <=>, HNSW cosine index)
-- The 5 completed rides whose 96-dimensional route embedding is nearest to ride 1's, by cosine distance.
SELECT s.ride_id,
       r.ride_title,
       s.distance_km,
       s.duration_min,
       round((s.route_embedding <=> src.route_embedding)::NUMERIC, 4) AS cosine_distance
FROM ride_summary s
JOIN ride r ON r.ride_id = s.ride_id
CROSS JOIN (SELECT route_embedding FROM ride_summary WHERE ride_id = 1) AS src
WHERE s.ride_id <> 1
  AND s.route_embedding IS NOT NULL
ORDER BY s.route_embedding <=> src.route_embedding
LIMIT 5;


-- @query recommended_for_user_vector
-- Rubric: K/P — vector similarity (taste centroid with AVG(vector), then <=>)
-- "Recommended for you" for user 2: the mean embedding of rides they joined, nearest rides they have NOT been on.
WITH taste AS (
    SELECT AVG(s.route_embedding) AS centroid
    FROM ride_summary s
    JOIN ride_participant rp ON rp.ride_id = s.ride_id
    WHERE rp.user_id = 2 AND rp.joined_at IS NOT NULL
      AND s.route_embedding IS NOT NULL
)
SELECT s.ride_id,
       r.ride_title,
       s.distance_km,
       round((s.route_embedding <=> t.centroid)::NUMERIC, 4) AS cosine_distance
FROM ride_summary s
JOIN ride r ON r.ride_id = s.ride_id
CROSS JOIN taste t
WHERE t.centroid IS NOT NULL
  AND s.route_embedding IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ride_participant rp
                  WHERE rp.ride_id = s.ride_id AND rp.user_id = 2)
ORDER BY s.route_embedding <=> t.centroid
LIMIT 5;


-- @query recommendations_differ_by_rider
-- Rubric: K/P — vector similarity (verification)
-- Top recommendation for every rider side by side; different histories must give different lists.
SELECT u.user_id,
       u.full_name,
       (SELECT count(*) FROM ride_participant rp
          JOIN ride_summary s ON s.ride_id = rp.ride_id
         WHERE rp.user_id = u.user_id AND s.route_embedding IS NOT NULL) AS rides_in_history,
       rec.top_3_recommendations
FROM app_user u
CROSS JOIN LATERAL (
    SELECT string_agg(x.ride_id::TEXT, ', ' ORDER BY x.dist) AS top_3_recommendations
    FROM (
        SELECT s.ride_id, s.route_embedding <=> c.centroid AS dist
        FROM ride_summary s
        CROSS JOIN (SELECT AVG(s2.route_embedding) AS centroid
                      FROM ride_summary s2
                      JOIN ride_participant rp2 ON rp2.ride_id = s2.ride_id
                     WHERE rp2.user_id = u.user_id AND s2.route_embedding IS NOT NULL) c
        WHERE c.centroid IS NOT NULL
          AND s.route_embedding IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ride_participant rp3
                          WHERE rp3.ride_id = s.ride_id AND rp3.user_id = u.user_id)
        ORDER BY dist
        LIMIT 3
    ) x
) rec
WHERE u.user_id BETWEEN 1 AND 8
ORDER BY u.user_id;


-- @query alert_fan_out_join
-- Rubric: N — join query (alert fan-out across 8 tables)
-- Every recipient of every SOS alert: who crashed, on which ride, who was told, and each delivery state.
SELECT a.alert_id,
       r.ride_id,
       r.ride_title,
       victim.full_name                                          AS rider_in_accident,
       e.impact_force                                            AS impact_g,
       ar.recipient_kind,
       COALESCE(co.full_name, ec.contact_name, au.authority_name) AS recipient,
       COALESCE(co.phone_no, ec.contact_phone, au.contact_no)     AS contact_number,
       ar.delivery_state,
       ar.attempted_at
FROM sos_alert a
JOIN accident_event e        ON e.event_id = a.event_id
JOIN ride_participant vp     ON vp.participant_id = e.participant_id
JOIN app_user victim         ON victim.user_id = vp.user_id
JOIN ride r                  ON r.ride_id = vp.ride_id
JOIN alert_recipient ar      ON ar.alert_id = a.alert_id
LEFT JOIN app_user co        ON co.user_id = ar.user_id
LEFT JOIN emergency_contact ec ON ec.contact_id = ar.contact_id
LEFT JOIN authority au       ON au.authority_id = ar.authority_id
ORDER BY a.alert_id, ar.recipient_kind, recipient;
