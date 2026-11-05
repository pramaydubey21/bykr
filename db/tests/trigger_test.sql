-- =============================================================================
-- Gate test: trg_generate_sos, sp_dispatch_alert, sp_end_ride.
--   * confirmed accident, 2 co-riders + 2 emergency contacts + 1 authority
--       -> exactly 1 sos_alert and exactly 5 alert_recipient rows
--   * cancelled accident -> 0 alerts
--   * sp_dispatch_alert -> 5 audit rows, recipients no longer PENDING
--   * sp_end_ride rejects a non-leader, then completes and summarises the ride
--
-- Self-contained; rolls back. The fixture sits at (10.0, 10.0), far from any
-- seeded authority, so exactly one authority (the fixture's own) covers it.
-- Run: psql "$DATABASE_ADMIN_URL" -f db/tests/trigger_test.sql
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
BEGIN;

INSERT INTO app_user (user_id, full_name, email, password_hash) OVERRIDING SYSTEM VALUE VALUES
    (910001, 'Crashed Rider', 'crash.rider@test.local', '$argon2id$fixture'),
    (910002, 'Co Rider One',  'co.one@test.local',      '$argon2id$fixture'),
    (910003, 'Co Rider Two',  'co.two@test.local',      '$argon2id$fixture'),
    (910004, 'Invited Only',  'invited@test.local',     '$argon2id$fixture');

INSERT INTO emergency_contact (user_id, contact_name, contact_phone, relation) VALUES
    (910001, 'Parent of Rider', '+91 90000 00001', 'PARENT'),
    (910001, 'Sibling of Rider', '+91 90000 00002', 'SIBLING'),
    (910002, 'Not the crashed rider''s contact', '+91 90000 00003', 'SPOUSE');  -- must NOT be alerted

INSERT INTO authority (authority_name, authority_type, contact_no, jurisdiction,
                       base_latitude, base_longitude, radius_km)
VALUES ('Fixture Police Station', 'POLICE', '100', 'Fixture district', 10.0, 10.0, 25);

INSERT INTO ride (ride_id, created_by, ride_title, started_at, ride_state) OVERRIDING SYSTEM VALUE
VALUES (910001, 910001, 'Trigger fixture ride', now() - interval '1 hour', 'ACTIVE');

INSERT INTO ride_participant (participant_id, ride_id, user_id, joined_at, is_leader) OVERRIDING SYSTEM VALUE VALUES
    (910001, 910001, 910001, now() - interval '1 hour', true),
    (910002, 910001, 910002, now() - interval '1 hour', false),
    (910003, 910001, 910003, now() - interval '1 hour', false);
-- invited but never joined: must NOT be alerted
INSERT INTO ride_participant (participant_id, ride_id, user_id, joined_at) OVERRIDING SYSTEM VALUE
VALUES (910004, 910001, 910004, NULL);

-- Act as the application, as the crashed rider.
SET LOCAL ROLE bykr_app;
SELECT set_config('app.current_user_id', '910001', true) \gset

-- 1. Cancelled accident -> no alert
INSERT INTO accident_event (participant_id, impact_force, latitude, longitude, is_confirmed)
VALUES (910001, 5.2, 10.001, 10.001, false);

-- 2. Confirmed accident -> exactly one alert, five recipients
INSERT INTO accident_event (participant_id, impact_force, latitude, longitude, is_confirmed)
VALUES (910001, 8.7, 10.002, 10.002, true);

RESET ROLE;   -- inspect as superuser so RLS does not hide anything from the counts

DO $$
DECLARE
    n_alerts INT; n_recip INT; n_co INT; n_ec INT; n_auth INT; n_cancel_alerts INT;
BEGIN
    SELECT count(*) INTO n_alerts
    FROM sos_alert a JOIN accident_event e ON e.event_id = a.event_id
    WHERE e.participant_id = 910001;

    SELECT count(*) INTO n_cancel_alerts
    FROM sos_alert a JOIN accident_event e ON e.event_id = a.event_id
    WHERE e.participant_id = 910001 AND NOT e.is_confirmed;

    SELECT count(*),
           count(*) FILTER (WHERE recipient_kind = 'CO_RIDER'),
           count(*) FILTER (WHERE recipient_kind = 'EMERGENCY_CONTACT'),
           count(*) FILTER (WHERE recipient_kind = 'AUTHORITY')
      INTO n_recip, n_co, n_ec, n_auth
    FROM alert_recipient r
    JOIN sos_alert a ON a.alert_id = r.alert_id
    JOIN accident_event e ON e.event_id = a.event_id
    WHERE e.participant_id = 910001;

    RAISE NOTICE 'alerts=% (from cancelled=%) recipients=% [co_rider=% emergency_contact=% authority=%]',
                 n_alerts, n_cancel_alerts, n_recip, n_co, n_ec, n_auth;

    IF n_alerts <> 1 OR n_cancel_alerts <> 0 THEN RAISE EXCEPTION 'TRIGGER FAILED: expected 1 alert, 0 from the cancelled event'; END IF;
    IF n_recip <> 5 OR n_co <> 2 OR n_ec <> 2 OR n_auth <> 1 THEN
        RAISE EXCEPTION 'TRIGGER FAILED: expected 5 recipients (2/2/1)';
    END IF;
END $$;

-- 3. A second alert for the same event is impossible (uq_sos_alert_event).
DO $$
BEGIN
    INSERT INTO sos_alert (event_id)
    SELECT event_id FROM accident_event WHERE participant_id = 910001 AND is_confirmed;
    RAISE EXCEPTION 'TRIGGER FAILED: duplicate alert accepted';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'duplicate alert rejected by uq_sos_alert_event';
END $$;

-- 4. Dispatch, as the application.
SET LOCAL ROLE bykr_app;
SELECT set_config('app.current_user_id', '910001', true) \gset
SELECT a.alert_id AS fixture_alert
FROM sos_alert a JOIN accident_event e ON e.event_id = a.event_id
WHERE e.participant_id = 910001 \gset
CALL sp_dispatch_alert(:fixture_alert);
CALL sp_dispatch_alert(:fixture_alert);   -- idempotent: second call changes nothing
RESET ROLE;

SELECT set_config('x.alert', :'fixture_alert', true) \gset
DO $$
DECLARE n_audit INT; n_pending INT; v_state TEXT;
BEGIN
    SELECT count(*) INTO n_audit FROM alert_audit WHERE alert_id = current_setting('x.alert')::INT;
    SELECT count(*) INTO n_pending FROM alert_recipient
     WHERE alert_id = current_setting('x.alert')::INT AND delivery_state = 'PENDING';
    SELECT delivery_state INTO v_state FROM sos_alert WHERE alert_id = current_setting('x.alert')::INT;
    RAISE NOTICE 'dispatch -> audit rows=% still pending=% alert state=%', n_audit, n_pending, v_state;
    IF n_audit <> 5 OR n_pending <> 0 OR v_state <> 'DISPATCHED' THEN
        RAISE EXCEPTION 'DISPATCH FAILED';
    END IF;
END $$;

-- 5. alert_audit is append-only.
DO $$
BEGIN
    DELETE FROM alert_audit WHERE alert_id = current_setting('x.alert')::INT;
    RAISE EXCEPTION 'AUDIT FAILED: delete accepted';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'audit delete rejected: %', SQLERRM;
END $$;

-- 6. sp_end_ride: non-leader rejected; leader completes and summarises.
INSERT INTO ride_waypoint (ride_id, seq, latitude, longitude, speed_kmph, recorded_at) VALUES
    (910001, 0, 10.000, 10.000, 40, now() - interval '50 minutes'),
    (910001, 1, 10.050, 10.020, 55, now() - interval '35 minutes'),
    (910001, 2, 10.100, 10.050,  0, now() - interval '20 minutes'),
    (910001, 3, 10.150, 10.090, 60, now() - interval '5 minutes');

SET LOCAL ROLE bykr_app;
SELECT set_config('app.current_user_id', '910002', true) \gset
DO $$
BEGIN
    CALL sp_end_ride(910001, 910002);
    RAISE EXCEPTION 'END RIDE FAILED: non-leader ended the ride';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'non-leader rejected: %', SQLERRM;
END $$;
SELECT set_config('app.current_user_id', '910001', true) \gset
CALL sp_end_ride(910001, 910001);
RESET ROLE;

\unset QUIET
SELECT r.ride_state, s.distance_km, s.duration_min, s.avg_speed_kmph, s.stop_count,
       s.straightness_ratio, fn_ride_distance_km(910001) AS fn_distance
FROM ride r JOIN ride_summary s USING (ride_id) WHERE ride_id = 910001;

\echo 'TRIGGER TEST PASSED'
ROLLBACK;
