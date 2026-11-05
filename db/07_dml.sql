-- =============================================================================
-- bykr — 07_dml.sql
-- Representative INSERT, UPDATE and DELETE statements over every table.
-- Rubric column M (DML operations).
--
-- The whole file is one transaction that ends in ROLLBACK, so running it
-- never changes the seeded data:
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/07_dml.sql
-- The first block is BEGIN and the last is ROLLBACK. A runner that executes
-- the blocks one by one must run all of them, in order, on ONE connection.
--
-- It tells one story: two new riders sign up, become friends, plan a ride,
-- ride it, one crashes (the trigger fans the alert out), the alert is
-- dispatched, the ride is ended and summarised, then the ride and the riders
-- are deleted, and the cascades are shown.
--
-- Run as the database owner (psql as postgres). The application role is
-- deliberately unable to write sos_alert, alert_recipient or alert_audit
-- directly (02_rbac.sql).
--
-- Coverage (I = INSERT, U = UPDATE, D = DELETE; "cascade" = removed by an
-- ON DELETE CASCADE from a statement in this file; "trigger" = written by
-- trg_generate_sos; "refused" = the schema forbids it, shown in a DO block):
--   app_user          I (multi-row)  U   D (cascade source)
--   app_role          I (ON CONFLICT, closed list)       D refused (RESTRICT)
--   user_role         I (INSERT…SELECT)                  D   + cascade
--   permission        I   U   D (cascade source)
--   role_permission   I (INSERT…SELECT)                  D   + cascade
--   friendship        I (multi-row)  U (subquery WHERE)  D   + cascade
--   ride              I   U (subquery WHERE)             D (cascade source)
--   ride_participant  I (multi-row)  U (subquery WHERE)  cascade
--   ride_waypoint     I (generate_series)                D   + cascade
--   ride_summary      I (INSERT…SELECT)  U (subquery WHERE)  cascade
--   status_type       I (upsert)  U                      D refused (RESTRICT)
--   rider_status      I (multi-row; trigger closes the previous status)  D  + cascade
--   emergency_contact I (multi-row)  U (subquery WHERE)  D   + cascade
--   authority         I   U (subquery WHERE)             D
--   accident_event    I (confirmed + cancelled)          D   + cascade
--   sos_alert         I trigger   U (subquery WHERE)     cascade
--   alert_recipient   I trigger   U (subquery WHERE)     cascade
--   alert_audit       I (INSERT…SELECT)   U/D refused (append-only trigger)
-- =============================================================================


-- @query begin_transaction
-- Rubric: M — DML (transaction control)
-- Open the transaction that the final block rolls back.
BEGIN;


-- ---------------------------------------------------------------- identity --

-- @query insert_users_multi_row
-- Rubric: M — DML INSERT (multi-row)
-- Two new riders sign up in one statement (hashes are placeholders; the app writes real Argon2id hashes).
INSERT INTO app_user (full_name, email, phone_no, password_hash) VALUES
    ('Priya Menon', 'dml.priya@bykr.local', '+91 98220 19001', '$argon2id$v=19$m=19456,t=2,p=1$ZG1sZGVtb3NhbHQ$ZG1sZGVtb2hhc2hwcml5YQ'),
    ('Tanvi Gokhale', 'dml.tanvi@bykr.local', '+91 98220 19002', '$argon2id$v=19$m=19456,t=2,p=1$ZG1sZGVtb3NhbHQ$ZG1sZGVtb2hhc2h0YW52aQ')
RETURNING user_id, full_name, email, created_at;


-- @query insert_user_roles_select
-- Rubric: M — DML INSERT … SELECT
-- Grant RIDER to both new users, and ADMIN to Tanvi, by joining users to roles.
INSERT INTO user_role (user_id, role_id)
SELECT u.user_id, r.role_id
FROM app_user u
JOIN app_role r ON r.role_name = 'RIDER'
                OR (r.role_name = 'ADMIN' AND u.email = 'dml.tanvi@bykr.local')
WHERE u.email IN ('dml.priya@bykr.local', 'dml.tanvi@bykr.local')
RETURNING user_id, role_id;


-- @query delete_user_role_revoke
-- Rubric: M — DML DELETE (subquery in WHERE)
-- Revoke Tanvi's ADMIN grant again.
DELETE FROM user_role
WHERE user_id = (SELECT user_id FROM app_user WHERE email = 'dml.tanvi@bykr.local')
  AND role_id = (SELECT role_id FROM app_role WHERE role_name = 'ADMIN')
RETURNING user_id, role_id;


-- @query update_user_phone
-- Rubric: M — DML UPDATE
-- Priya changes her phone number.
UPDATE app_user
   SET phone_no = '+91 98220 19011'
 WHERE email = 'dml.priya@bykr.local'
RETURNING user_id, full_name, phone_no;


-- @query insert_role_idempotent
-- Rubric: M — DML INSERT … ON CONFLICT
-- Re-seeding roles is idempotent; the CHECK limits roles to RIDER and ADMIN, so this inserts 0 rows.
INSERT INTO app_role (role_name) VALUES ('RIDER'), ('ADMIN')
ON CONFLICT ON CONSTRAINT uq_app_role_name DO NOTHING
RETURNING role_id, role_name;


-- @query insert_permission
-- Rubric: M — DML INSERT
-- A new permission for exporting a ride as GPX.
INSERT INTO permission (permission_key) VALUES ('ride:export')
RETURNING permission_id, permission_key;


-- @query insert_role_permission_select
-- Rubric: M — DML INSERT … SELECT (multi-row)
-- Give the new permission to both roles.
INSERT INTO role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM app_role r
CROSS JOIN permission p
WHERE p.permission_key = 'ride:export'
RETURNING role_id, permission_id;


-- @query update_permission_key
-- Rubric: M — DML UPDATE
-- Rename the permission; role_permission rows follow because they reference the id, not the key.
UPDATE permission
   SET permission_key = 'ride:export_gpx'
 WHERE permission_key = 'ride:export'
RETURNING permission_id, permission_key;


-- @query delete_role_permission
-- Rubric: M — DML DELETE (subqueries in WHERE)
-- Take the export permission away from RIDER (ADMIN keeps it).
DELETE FROM role_permission
WHERE role_id       = (SELECT role_id       FROM app_role   WHERE role_name = 'RIDER')
  AND permission_id = (SELECT permission_id FROM permission WHERE permission_key = 'ride:export_gpx')
RETURNING role_id, permission_id;


-- @query delete_permission_cascade
-- Rubric: M — DML DELETE (cascade)
-- Delete the permission; fk_role_permission_permission ON DELETE CASCADE removes ADMIN's grant. Inside this statement the snapshot still shows 1 grant; the next block shows 0.
WITH gone AS (
    DELETE FROM permission
    WHERE permission_key = 'ride:export_gpx'
    RETURNING permission_id, permission_key
)
SELECT g.permission_id,
       g.permission_key,
       (SELECT count(*) FROM role_permission rp WHERE rp.permission_id = g.permission_id) AS grants_visible_in_this_statement
FROM gone g;


-- @query check_permission_cascade
-- Rubric: M — DML DELETE (cascade, verification)
-- After the statement, no role_permission row points at a missing permission.
SELECT count(*) AS orphaned_role_permissions
FROM role_permission rp
WHERE NOT EXISTS (SELECT 1 FROM permission p WHERE p.permission_id = rp.permission_id);


-- @query restrict_refusals
-- Rubric: M — DML DELETE (ON DELETE RESTRICT refused)
-- Deleting a role or a status type that is in use is refused by RESTRICT foreign keys; caught so the file continues.
DO $$
BEGIN
    BEGIN
        DELETE FROM app_role WHERE role_name = 'RIDER';
        RAISE EXCEPTION 'unexpected: RIDER role was deleted';
    EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE 'app_role RIDER delete refused by fk_user_role_role (RESTRICT): %', SQLERRM;
    END;
    BEGIN
        DELETE FROM status_type WHERE status_label = 'RIDING';
        RAISE EXCEPTION 'unexpected: RIDING status type was deleted';
    EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE 'status_type RIDING delete refused by fk_rider_status_type (RESTRICT): %', SQLERRM;
    END;
END $$;


-- ------------------------------------------------------- social and safety --

-- @query insert_friendships_multi_row
-- Rubric: M — DML INSERT (multi-row, from subqueries)
-- Priya sends Tanvi a request (PENDING) and is already friends with Aarav (user 1).
INSERT INTO friendship (requester_id, addressee_id, link_state, linked_at) VALUES
    ((SELECT user_id FROM app_user WHERE email = 'dml.priya@bykr.local'),
     (SELECT user_id FROM app_user WHERE email = 'dml.tanvi@bykr.local'), 'PENDING', NULL),
    ((SELECT user_id FROM app_user WHERE email = 'dml.priya@bykr.local'),
     1, 'ACCEPTED', now())
RETURNING friendship_id, requester_id, addressee_id, link_state;


-- @query update_friendship_accept
-- Rubric: M — DML UPDATE (subquery in WHERE)
-- Tanvi accepts every pending request addressed to her.
UPDATE friendship
   SET link_state = 'ACCEPTED', linked_at = now()
 WHERE link_state = 'PENDING'
   AND addressee_id = (SELECT user_id FROM app_user WHERE email = 'dml.tanvi@bykr.local')
RETURNING friendship_id, requester_id, addressee_id, link_state, linked_at;


-- @query delete_friendship
-- Rubric: M — DML DELETE (subquery in WHERE)
-- Priya unfriends Aarav (either direction of the pair).
DELETE FROM friendship
WHERE 1 IN (requester_id, addressee_id)
  AND (SELECT user_id FROM app_user WHERE email = 'dml.priya@bykr.local') IN (requester_id, addressee_id)
RETURNING friendship_id, requester_id, addressee_id;


-- @query insert_emergency_contacts_multi_row
-- Rubric: M — DML INSERT (multi-row)
-- Priya registers two emergency contacts; Tanvi registers one.
INSERT INTO emergency_contact (user_id, contact_name, contact_phone, relation)
SELECT u.user_id, c.contact_name, c.contact_phone, c.relation
FROM (VALUES
        ('dml.priya@bykr.local', 'Ravi Menon',    '+91 99700 29001', 'PARENT'),
        ('dml.priya@bykr.local', 'Arjun Menon',   '+91 99700 29002', 'SIBLING'),
        ('dml.tanvi@bykr.local', 'Neha Gokhale',  '+91 99700 29003', 'SPOUSE')
     ) AS c(email, contact_name, contact_phone, relation)
JOIN app_user u ON u.email = c.email
RETURNING contact_id, user_id, contact_name, relation;


-- @query update_emergency_contact_subquery
-- Rubric: M — DML UPDATE (subquery in WHERE)
-- Priya's sibling contact changes number.
UPDATE emergency_contact
   SET contact_phone = '+91 99700 29012'
 WHERE user_id = (SELECT user_id FROM app_user WHERE email = 'dml.priya@bykr.local')
   AND relation = 'SIBLING'
RETURNING contact_id, contact_name, contact_phone;


-- @query delete_emergency_contact
-- Rubric: M — DML DELETE (subquery in WHERE)
-- Tanvi removes her only contact.
DELETE FROM emergency_contact
WHERE user_id = (SELECT user_id FROM app_user WHERE email = 'dml.tanvi@bykr.local')
RETURNING contact_id, contact_name;


-- @query insert_authority
-- Rubric: M — DML INSERT
-- A demo authority record (display-only: bykr never contacts it).
INSERT INTO authority (authority_name, authority_type, contact_no, jurisdiction,
                       base_latitude, base_longitude, radius_km)
VALUES ('Tamhini Ghat Highway Patrol (demo record)', 'HIGHWAY_PATROL', '112',
        'Tamhini ghat, Mulshi taluka', 18.455000, 73.420000, 15.00)
RETURNING authority_id, authority_name, radius_km;


-- @query update_authority_radius_subquery
-- Rubric: M — DML UPDATE (subquery in WHERE)
-- Widen the radius of every authority that has never been sent an alert.
UPDATE authority
   SET radius_km = radius_km + 5
 WHERE authority_id NOT IN (SELECT ar.authority_id
                              FROM alert_recipient ar
                             WHERE ar.authority_id IS NOT NULL)
RETURNING authority_id, authority_name, radius_km;


-- @query delete_authority
-- Rubric: M — DML DELETE
-- Remove the demo authority (allowed: no alert_recipient references it).
DELETE FROM authority
WHERE authority_name = 'Tamhini Ghat Highway Patrol (demo record)'
RETURNING authority_id, authority_name;


-- @query upsert_status_type
-- Rubric: M — DML INSERT … ON CONFLICT DO UPDATE
-- Status labels are a closed list; re-seeding updates the icon of an existing label instead of failing.
INSERT INTO status_type (status_label, icon_name) VALUES ('REFUELLING', 'fuel-pump')
ON CONFLICT ON CONSTRAINT uq_status_type_label DO UPDATE SET icon_name = EXCLUDED.icon_name
RETURNING type_id, status_label, icon_name;


-- @query update_status_type_icon
-- Rubric: M — DML UPDATE
-- Change the icon shown for DELAYED.
UPDATE status_type
   SET icon_name = 'clock'
 WHERE status_label = 'DELAYED'
RETURNING type_id, status_label, icon_name;


-- ------------------------------------------------------------------- ride --

-- @query insert_ride
-- Rubric: M — DML INSERT
-- Priya plans a ride (state CREATED, no start time yet).
INSERT INTO ride (created_by, ride_title, ride_state)
SELECT user_id, 'DML demo: Lonavala to Rajmachi', 'CREATED'
FROM app_user WHERE email = 'dml.priya@bykr.local'
RETURNING ride_id, ride_title, ride_state, created_at;


-- @query insert_participants_multi_row
-- Rubric: M — DML INSERT (multi-row)
-- Priya joins as leader; Tanvi and Aarav (user 1) are invited (joined_at NULL).
INSERT INTO ride_participant (ride_id, user_id, joined_at, is_leader)
SELECT r.ride_id, u.user_id,
       CASE WHEN u.email = 'dml.priya@bykr.local' THEN now() - interval '40 minutes' END,
       u.email = 'dml.priya@bykr.local'
FROM ride r
JOIN app_user u ON u.email IN ('dml.priya@bykr.local', 'dml.tanvi@bykr.local', 'aarav@bykr.local')
WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi'
RETURNING participant_id, ride_id, user_id, joined_at, is_leader;


-- @query update_participant_join_subquery
-- Rubric: M — DML UPDATE (subqueries in WHERE)
-- Tanvi accepts the invitation; Aarav does not.
UPDATE ride_participant
   SET joined_at = now() - interval '35 minutes'
 WHERE ride_id = (SELECT ride_id FROM ride WHERE ride_title = 'DML demo: Lonavala to Rajmachi')
   AND user_id = (SELECT user_id FROM app_user WHERE email = 'dml.tanvi@bykr.local')
   AND joined_at IS NULL
RETURNING participant_id, user_id, joined_at;


-- @query update_ride_start
-- Rubric: M — DML UPDATE (subquery in WHERE)
-- The leader starts the ride: CREATED → ACTIVE (chk_ride_state_timestamps requires started_at).
UPDATE ride
   SET ride_state = 'ACTIVE', started_at = now() - interval '30 minutes'
 WHERE ride_id = (SELECT ride_id FROM ride WHERE ride_title = 'DML demo: Lonavala to Rajmachi')
   AND ride_state = 'CREATED'
RETURNING ride_id, ride_state, started_at;


-- @query insert_waypoints_generated
-- Rubric: M — DML INSERT … SELECT (generate_series, 61 rows)
-- A 30-minute downsampled route heading north-west out of Lonavala towards Rajmachi, one waypoint every 30 s, with a 90 s stop.
INSERT INTO ride_waypoint (ride_id, seq, latitude, longitude, speed_kmph, recorded_at)
SELECT r.ride_id,
       g.i,
       round((18.7520 + g.i * 0.0016 + 0.0004 * sin(g.i / 4.0))::NUMERIC, 6),   -- ~220 m per 30 s ≈ 26 km/h
       round((73.4060 - g.i * 0.0012)::NUMERIC, 6),
       CASE WHEN g.i BETWEEN 20 AND 22 THEN 0 ELSE round((28 + 8 * sin(g.i / 6.0))::NUMERIC, 2) END,
       r.started_at + g.i * interval '30 seconds'
FROM ride r
CROSS JOIN generate_series(0, 60) AS g(i)
WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi'
RETURNING ride_id, seq, latitude, longitude, speed_kmph;


-- @query delete_waypoint_tail
-- Rubric: M — DML DELETE (subquery in WHERE)
-- Trim the last five waypoints (GPS jitter while parking).
DELETE FROM ride_waypoint
WHERE ride_id = (SELECT ride_id FROM ride WHERE ride_title = 'DML demo: Lonavala to Rajmachi')
  AND seq > 55
RETURNING ride_id, seq;


-- @query insert_statuses_multi_row
-- Rubric: M — DML INSERT (multi-row; trg_rider_status_close_previous closes each previous status)
-- Both riders set RIDING; Priya mis-taps DELAYED, then 20 s later sets REFUELLING.
INSERT INTO rider_status (participant_id, type_id, set_at)
SELECT rp.participant_id, st.type_id, r.started_at + s.offset_s * interval '1 second'
FROM (VALUES ('dml.priya@bykr.local', 'RIDING',      60),
             ('dml.tanvi@bykr.local', 'RIDING',      60)) AS s(email, label, offset_s)
JOIN app_user u          ON u.email = s.email
JOIN ride r              ON r.ride_title = 'DML demo: Lonavala to Rajmachi'
JOIN ride_participant rp ON rp.ride_id = r.ride_id AND rp.user_id = u.user_id
JOIN status_type st      ON st.status_label = s.label
RETURNING status_id, participant_id, type_id, set_at, cleared_at;


-- @query insert_status_delayed
-- Rubric: M — DML INSERT (trigger closes the open RIDING status)
-- Priya's accidental DELAYED.
INSERT INTO rider_status (participant_id, type_id, set_at)
SELECT rp.participant_id, (SELECT type_id FROM status_type WHERE status_label = 'DELAYED'),
       r.started_at + interval '10 minutes'
FROM ride r
JOIN ride_participant rp ON rp.ride_id = r.ride_id AND rp.is_leader
WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi'
RETURNING status_id, participant_id, set_at;


-- @query insert_status_refuelling
-- Rubric: M — DML INSERT (trigger closes the open DELAYED status)
-- Priya's intended REFUELLING, 20 seconds later.
INSERT INTO rider_status (participant_id, type_id, set_at)
SELECT rp.participant_id, (SELECT type_id FROM status_type WHERE status_label = 'REFUELLING'),
       r.started_at + interval '10 minutes 20 seconds'
FROM ride r
JOIN ride_participant rp ON rp.ride_id = r.ride_id AND rp.is_leader
WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi'
RETURNING status_id, participant_id, set_at;


-- @query delete_mistap_status
-- Rubric: M — DML DELETE (subquery in WHERE)
-- Remove statuses that lasted under a minute on this ride (the mis-tap).
DELETE FROM rider_status
WHERE participant_id IN (SELECT rp.participant_id
                           FROM ride_participant rp
                           JOIN ride r ON r.ride_id = rp.ride_id
                          WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi')
  AND cleared_at IS NOT NULL
  AND cleared_at - set_at < interval '1 minute'
RETURNING status_id, participant_id, set_at, cleared_at;


-- -------------------------------------------------------------- accident --

-- @query insert_cancelled_accident
-- Rubric: M — DML INSERT (trigger does NOT fire: is_confirmed = false)
-- Tanvi's phone falls off the mount; she cancels the countdown, so no alert is created.
INSERT INTO accident_event (participant_id, impact_force, latitude, longitude, is_confirmed)
SELECT rp.participant_id, 3.10, 18.776000, 73.388000, false
FROM ride r
JOIN ride_participant rp ON rp.ride_id = r.ride_id
JOIN app_user u          ON u.user_id = rp.user_id AND u.email = 'dml.tanvi@bykr.local'
WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi'
RETURNING event_id, participant_id, impact_force, is_confirmed;


-- @query insert_confirmed_accident
-- Rubric: M — DML INSERT (fires trg_generate_sos: inserts sos_alert and alert_recipient in the same transaction)
-- Priya crashes and the countdown expires.
INSERT INTO accident_event (participant_id, impact_force, latitude, longitude, is_confirmed)
SELECT rp.participant_id, 8.40, 18.792000, 73.376000, true
FROM ride r
JOIN ride_participant rp ON rp.ride_id = r.ride_id AND rp.is_leader
WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi'
RETURNING event_id, participant_id, impact_force, is_confirmed;


-- @query check_trigger_fan_out
-- Rubric: M — DML verification (rows the trigger inserted)
-- Expected: the cancelled event has 0 alerts; the confirmed one has 1 alert and 4 recipients (Tanvi, 2 contacts, Lonavala Highway Patrol). Aarav never joined.
SELECT e.event_id,
       e.is_confirmed,
       count(DISTINCT a.alert_id)                                              AS alerts,
       count(ar.recipient_id)                                                  AS recipients,
       count(ar.recipient_id) FILTER (WHERE ar.recipient_kind = 'CO_RIDER')          AS co_riders,
       count(ar.recipient_id) FILTER (WHERE ar.recipient_kind = 'EMERGENCY_CONTACT') AS contacts,
       count(ar.recipient_id) FILTER (WHERE ar.recipient_kind = 'AUTHORITY')         AS authorities
FROM accident_event e
JOIN ride_participant rp     ON rp.participant_id = e.participant_id
JOIN ride r                  ON r.ride_id = rp.ride_id
LEFT JOIN sos_alert a        ON a.event_id = e.event_id
LEFT JOIN alert_recipient ar ON ar.alert_id = a.alert_id
WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi'
GROUP BY e.event_id, e.is_confirmed
ORDER BY e.event_id;


-- @query insert_alert_audit_select
-- Rubric: M — DML INSERT … SELECT
-- Record one dispatch attempt per recipient in the append-only audit trail (what sp_dispatch_alert does).
INSERT INTO alert_audit (alert_id, recipient_id, outcome)
SELECT ar.alert_id, ar.recipient_id,
       CASE ar.recipient_kind WHEN 'CO_RIDER' THEN 'DELIVERED' ELSE 'MANUAL_ACTION_REQUIRED' END
FROM alert_recipient ar
JOIN sos_alert a         ON a.alert_id = ar.alert_id
JOIN accident_event e    ON e.event_id = a.event_id
JOIN ride_participant rp ON rp.participant_id = e.participant_id
JOIN ride r              ON r.ride_id = rp.ride_id
WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi'
  AND ar.delivery_state = 'PENDING'
RETURNING audit_id, alert_id, recipient_id, outcome;


-- @query update_alert_recipients_subquery
-- Rubric: M — DML UPDATE (subquery in WHERE)
-- Mark each recipient with the outcome just audited. Authorities and contacts need a human, because bykr contacts no real service.
UPDATE alert_recipient ar
   SET delivery_state = CASE ar.recipient_kind WHEN 'CO_RIDER' THEN 'DELIVERED' ELSE 'MANUAL_ACTION_REQUIRED' END,
       attempted_at   = now()
 WHERE ar.delivery_state = 'PENDING'
   AND ar.alert_id IN (SELECT a.alert_id
                         FROM sos_alert a
                         JOIN accident_event e    ON e.event_id = a.event_id
                         JOIN ride_participant rp ON rp.participant_id = e.participant_id
                         JOIN ride r              ON r.ride_id = rp.ride_id
                        WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi')
RETURNING ar.recipient_id, ar.recipient_kind, ar.delivery_state, ar.attempted_at;


-- @query update_sos_alert_subquery
-- Rubric: M — DML UPDATE (correlated NOT EXISTS in WHERE)
-- An alert with no PENDING recipient left is DISPATCHED.
UPDATE sos_alert a
   SET delivery_state = 'DISPATCHED'
 WHERE a.delivery_state = 'PENDING'
   AND NOT EXISTS (SELECT 1 FROM alert_recipient ar
                    WHERE ar.alert_id = a.alert_id AND ar.delivery_state = 'PENDING')
RETURNING a.alert_id, a.event_id, a.delivery_state;


-- @query alert_audit_append_only_refusals
-- Rubric: M — DML UPDATE/DELETE refused (trg_alert_audit_append_only)
-- The audit trail cannot be rewritten, not even by the owner; both attempts are caught so the file continues.
DO $$
BEGIN
    BEGIN
        UPDATE alert_audit SET outcome = 'FAILED';
        RAISE EXCEPTION 'unexpected: alert_audit was updated';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'alert_audit UPDATE refused: %', SQLERRM;
    END;
    BEGIN
        DELETE FROM alert_audit;
        RAISE EXCEPTION 'unexpected: alert_audit was deleted';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'alert_audit DELETE refused: %', SQLERRM;
    END;
END $$;


-- @query delete_cancelled_accident
-- Rubric: M — DML DELETE (subquery in WHERE)
-- Clear the false alarm. It has no alert, so nothing cascades.
DELETE FROM accident_event
WHERE NOT is_confirmed
  AND participant_id IN (SELECT rp.participant_id
                           FROM ride_participant rp
                           JOIN ride r ON r.ride_id = rp.ride_id
                          WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi')
RETURNING event_id, is_confirmed;


-- ------------------------------------------------------------- end ride --

-- @query update_ride_end
-- Rubric: M — DML UPDATE (subqueries in SET and WHERE)
-- End the ride at its last waypoint.
UPDATE ride r
   SET ride_state = 'COMPLETED',
       ended_at   = (SELECT max(w.recorded_at) FROM ride_waypoint w WHERE w.ride_id = r.ride_id)
 WHERE r.ride_id = (SELECT ride_id FROM ride WHERE ride_title = 'DML demo: Lonavala to Rajmachi')
RETURNING r.ride_id, r.ride_state, r.started_at, r.ended_at;


-- @query update_participants_leave
-- Rubric: M — DML UPDATE (subquery in WHERE)
-- Everyone who joined leaves when the ride ends.
UPDATE ride_participant rp
   SET left_at = (SELECT r.ended_at FROM ride r WHERE r.ride_id = rp.ride_id)
 WHERE rp.ride_id = (SELECT ride_id FROM ride WHERE ride_title = 'DML demo: Lonavala to Rajmachi')
   AND rp.joined_at IS NOT NULL
   AND rp.left_at IS NULL
RETURNING rp.participant_id, rp.user_id, rp.joined_at, rp.left_at;


-- @query insert_ride_summary_select
-- Rubric: M — DML INSERT … SELECT (stored functions in the select list)
-- Summarise the ride from its waypoints with fn_ride_distance_km, fn_ride_stop_count and fn_haversine_km.
INSERT INTO ride_summary (ride_id, distance_km, duration_min, avg_speed_kmph, max_speed_kmph, stop_count,
                          start_lat, start_lon, end_lat, end_lon, bbox_diagonal_km, straightness_ratio)
SELECT r.ride_id,
       round(d.km, 2),
       round(d.minutes, 2),
       round(d.km / NULLIF(d.minutes / 60, 0), 2),
       round(GREATEST(max(w.speed_kmph), d.km / NULLIF(d.minutes / 60, 0)), 2),
       fn_ride_stop_count(r.ride_id),
       (array_agg(w.latitude  ORDER BY w.seq))[1],
       (array_agg(w.longitude ORDER BY w.seq))[1],
       (array_agg(w.latitude  ORDER BY w.seq DESC))[1],
       (array_agg(w.longitude ORDER BY w.seq DESC))[1],
       round(fn_haversine_km(min(w.latitude), min(w.longitude), max(w.latitude), max(w.longitude)), 2),
       round(LEAST(1, fn_haversine_km((array_agg(w.latitude  ORDER BY w.seq))[1],
                                      (array_agg(w.longitude ORDER BY w.seq))[1],
                                      (array_agg(w.latitude  ORDER BY w.seq DESC))[1],
                                      (array_agg(w.longitude ORDER BY w.seq DESC))[1]) / NULLIF(d.km, 0)), 4)
FROM ride r
JOIN ride_waypoint w ON w.ride_id = r.ride_id
CROSS JOIN LATERAL (SELECT fn_ride_distance_km(r.ride_id) AS km,
                           (EXTRACT(EPOCH FROM r.ended_at - r.started_at) / 60)::NUMERIC AS minutes) d
WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi'
GROUP BY r.ride_id, d.km, d.minutes
RETURNING ride_id, distance_km, duration_min, avg_speed_kmph, max_speed_kmph, stop_count, straightness_ratio;


-- @query update_ride_summary_subquery
-- Rubric: M — DML UPDATE (subquery in WHERE)
-- Recompute stop_count for every ride completed in the last 30 days.
UPDATE ride_summary s
   SET stop_count  = fn_ride_stop_count(s.ride_id),
       computed_at = now()
 WHERE s.ride_id IN (SELECT r.ride_id FROM ride r
                      WHERE r.ride_state = 'COMPLETED'
                        AND r.ended_at > now() - interval '30 days')
RETURNING s.ride_id, s.stop_count, s.computed_at;


-- ---------------------------------------------------------------- cascade --

-- @query cascade_before_delete_ride
-- Rubric: M — DML DELETE (cascade, before)
-- Rows that hang off the demo ride before it is deleted.
SELECT r.ride_id,
       (SELECT count(*) FROM ride_participant rp WHERE rp.ride_id = r.ride_id)                    AS participants,
       (SELECT count(*) FROM ride_waypoint w     WHERE w.ride_id  = r.ride_id)                    AS waypoints,
       (SELECT count(*) FROM ride_summary s      WHERE s.ride_id  = r.ride_id)                    AS summaries,
       (SELECT count(*) FROM rider_status rs JOIN ride_participant rp USING (participant_id)
         WHERE rp.ride_id = r.ride_id)                                                            AS statuses,
       (SELECT count(*) FROM accident_event e JOIN ride_participant rp USING (participant_id)
         WHERE rp.ride_id = r.ride_id)                                                            AS accidents,
       (SELECT count(*) FROM sos_alert a JOIN accident_event e USING (event_id)
         JOIN ride_participant rp USING (participant_id) WHERE rp.ride_id = r.ride_id)            AS alerts,
       (SELECT count(*) FROM alert_recipient ar JOIN sos_alert a USING (alert_id)
         JOIN accident_event e USING (event_id) JOIN ride_participant rp ON rp.participant_id = e.participant_id
         WHERE rp.ride_id = r.ride_id)                                                            AS recipients,
       (SELECT count(*) FROM alert_audit au JOIN sos_alert a USING (alert_id)
         JOIN accident_event e USING (event_id) JOIN ride_participant rp USING (participant_id)
         WHERE rp.ride_id = r.ride_id)                                                            AS audit_rows
FROM ride r
WHERE r.ride_title = 'DML demo: Lonavala to Rajmachi';


-- @query delete_ride_cascade
-- Rubric: M — DML DELETE (cascade source)
-- Delete the ride. ON DELETE CASCADE removes participants, waypoints and summary, then statuses and accidents (via participant), then the alert and its recipients (via accident).
DELETE FROM ride
WHERE ride_title = 'DML demo: Lonavala to Rajmachi'
RETURNING ride_id, ride_title, ride_state;


-- @query cascade_after_delete_ride
-- Rubric: M — DML DELETE (cascade, after)
-- No orphan rows remain in any cascading table; alert_audit has no foreign keys by design, so the record of who was notified survives.
SELECT
    (SELECT count(*) FROM ride_participant rp WHERE NOT EXISTS (SELECT 1 FROM ride r WHERE r.ride_id = rp.ride_id))           AS orphan_participants,
    (SELECT count(*) FROM ride_waypoint w     WHERE NOT EXISTS (SELECT 1 FROM ride r WHERE r.ride_id = w.ride_id))            AS orphan_waypoints,
    (SELECT count(*) FROM ride_summary s      WHERE NOT EXISTS (SELECT 1 FROM ride r WHERE r.ride_id = s.ride_id))            AS orphan_summaries,
    (SELECT count(*) FROM rider_status rs     WHERE NOT EXISTS (SELECT 1 FROM ride_participant rp WHERE rp.participant_id = rs.participant_id)) AS orphan_statuses,
    (SELECT count(*) FROM accident_event e    WHERE NOT EXISTS (SELECT 1 FROM ride_participant rp WHERE rp.participant_id = e.participant_id))  AS orphan_accidents,
    (SELECT count(*) FROM sos_alert a         WHERE NOT EXISTS (SELECT 1 FROM accident_event e WHERE e.event_id = a.event_id)) AS orphan_alerts,
    (SELECT count(*) FROM alert_recipient ar  WHERE NOT EXISTS (SELECT 1 FROM sos_alert a WHERE a.alert_id = ar.alert_id))    AS orphan_recipients,
    (SELECT count(*) FROM alert_audit au      WHERE NOT EXISTS (SELECT 1 FROM sos_alert a WHERE a.alert_id = au.alert_id))    AS surviving_audit_rows;


-- @query delete_users_cascade
-- Rubric: M — DML DELETE (cascade source)
-- Delete both demo users. Their ride history is gone, so RESTRICT no longer applies; user_role, friendship and emergency_contact rows cascade.
WITH gone AS (
    DELETE FROM app_user
    WHERE email IN ('dml.priya@bykr.local', 'dml.tanvi@bykr.local')
    RETURNING user_id, full_name
)
SELECT g.user_id, g.full_name FROM gone g ORDER BY g.user_id;


-- @query cascade_after_delete_users
-- Rubric: M — DML DELETE (cascade, after)
-- No role grant, friendship or emergency contact points at a missing user.
SELECT
    (SELECT count(*) FROM user_role ur         WHERE NOT EXISTS (SELECT 1 FROM app_user u WHERE u.user_id = ur.user_id))       AS orphan_user_roles,
    (SELECT count(*) FROM friendship f         WHERE NOT EXISTS (SELECT 1 FROM app_user u WHERE u.user_id = f.requester_id)
                                                  OR NOT EXISTS (SELECT 1 FROM app_user u WHERE u.user_id = f.addressee_id))   AS orphan_friendships,
    (SELECT count(*) FROM emergency_contact ec WHERE NOT EXISTS (SELECT 1 FROM app_user u WHERE u.user_id = ec.user_id))       AS orphan_contacts,
    (SELECT count(*) FROM app_user WHERE email LIKE 'dml.%')                                                                   AS demo_users_left;


-- @query rollback_transaction
-- Rubric: M — DML (transaction control)
-- Undo everything above; the seeded data is untouched.
ROLLBACK;
