-- =============================================================================
-- Gate test: row level security.
-- A rider who is not a participant of a ride reads NOTHING from that ride,
-- enforced by PostgreSQL policies, not by application code.
--
-- Self-contained: builds its own fixture inside a transaction and rolls back.
-- Run as the superuser:  psql "$DATABASE_ADMIN_URL" -f db/tests/rls_test.sql
-- =============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- Fixture, written as superuser (bypasses RLS).
-- Argon2-shaped placeholder hashes satisfy chk_app_user_hash_argon2.
INSERT INTO app_user (user_id, full_name, email, password_hash) OVERRIDING SYSTEM VALUE VALUES
    (900001, 'RLS Insider',  'rls.insider@test.local',  '$argon2id$fixture'),
    (900002, 'RLS Outsider', 'rls.outsider@test.local', '$argon2id$fixture'),
    (900003, 'RLS Admin',    'rls.admin@test.local',    '$argon2id$fixture');
INSERT INTO user_role (user_id, role_id)
SELECT 900003, role_id FROM app_role WHERE role_name = 'ADMIN';

INSERT INTO ride (ride_id, created_by, ride_title, started_at, ride_state) OVERRIDING SYSTEM VALUE
VALUES (900001, 900001, 'RLS fixture ride', now(), 'ACTIVE');
INSERT INTO ride_participant (participant_id, ride_id, user_id, joined_at, is_leader) OVERRIDING SYSTEM VALUE
VALUES (900001, 900001, 900001, now(), true);
INSERT INTO accident_event (participant_id, impact_force, latitude, longitude, is_confirmed)
VALUES (900001, 6.5, 18.52, 73.85, false);

-- From here on we are the application: no superuser, no BYPASSRLS.
SET LOCAL ROLE bykr_app;

-- 1. Outsider sees nothing.
SELECT set_config('app.current_user_id', '900002', true);
DO $$
DECLARE n_ride INT; n_part INT; n_acc INT;
BEGIN
    SELECT count(*) INTO n_ride FROM ride             WHERE ride_id = 900001;
    SELECT count(*) INTO n_part FROM ride_participant WHERE ride_id = 900001;
    SELECT count(*) INTO n_acc  FROM accident_event   WHERE participant_id = 900001;
    RAISE NOTICE 'outsider  -> ride=% participants=% accidents=%', n_ride, n_part, n_acc;
    IF n_ride + n_part + n_acc <> 0 THEN
        RAISE EXCEPTION 'RLS FAILED: outsider can read ride data';
    END IF;
END $$;

-- 1b. Outsider cannot write into the ride either.
DO $$
BEGIN
    INSERT INTO ride_participant (ride_id, user_id, joined_at) VALUES (900001, 900002, now());
    RAISE EXCEPTION 'RLS FAILED: outsider joined a ride uninvited';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'outsider  -> self-invite rejected by policy (%)', SQLERRM;
END $$;

-- 2. Participant sees their ride.
SELECT set_config('app.current_user_id', '900001', true);
DO $$
DECLARE n_ride INT; n_acc INT;
BEGIN
    SELECT count(*) INTO n_ride FROM ride           WHERE ride_id = 900001;
    SELECT count(*) INTO n_acc  FROM accident_event WHERE participant_id = 900001;
    RAISE NOTICE 'insider   -> ride=% accidents=%', n_ride, n_acc;
    IF n_ride <> 1 OR n_acc <> 1 THEN RAISE EXCEPTION 'RLS FAILED: participant cannot read own ride'; END IF;
END $$;

-- 3. Admin sees everything.
SELECT set_config('app.current_user_id', '900003', true);
DO $$
DECLARE n_ride INT;
BEGIN
    SELECT count(*) INTO n_ride FROM ride WHERE ride_id = 900001;
    RAISE NOTICE 'admin     -> ride=%', n_ride;
    IF n_ride <> 1 THEN RAISE EXCEPTION 'RLS FAILED: admin cannot read ride'; END IF;
END $$;

-- 4. No user id set at all: nothing.
SELECT set_config('app.current_user_id', '', true);
DO $$
DECLARE n_ride INT;
BEGIN
    SELECT count(*) INTO n_ride FROM ride;
    RAISE NOTICE 'anonymous -> rides=%', n_ride;
    IF n_ride <> 0 THEN RAISE EXCEPTION 'RLS FAILED: anonymous session sees rides'; END IF;
END $$;

\echo 'RLS TEST PASSED'
ROLLBACK;
