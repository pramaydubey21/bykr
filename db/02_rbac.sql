-- =============================================================================
-- bykr — 02_rbac.sql
-- Roles, permissions and PostgreSQL ROW LEVEL SECURITY.
-- Rubric column S: "role-based access control in database".
--
-- How it works
--   * The web application connects as bykr_app, a role that is NOT a superuser
--     and does NOT have BYPASSRLS, so every policy below applies to it.
--   * For every request, lib/db/index.ts opens a transaction and runs
--         SELECT set_config('app.current_user_id', '<id>', true)
--     The third argument makes the setting transaction-local, so it cannot leak
--     to the next request that borrows the same pooled connection.
--   * Policies read that setting through fn_current_user_id(). No setting means
--     NULL, and NULL matches nothing: an unauthenticated query sees no rows.
--   * A rider may read a ride only if they hold a participant row in it (or
--     created it). A user holding the ADMIN role may read everything.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Application roles and permissions (seed data)
-- -----------------------------------------------------------------------------
INSERT INTO app_role (role_name) VALUES ('RIDER'), ('ADMIN')
ON CONFLICT ON CONSTRAINT uq_app_role_name DO NOTHING;

INSERT INTO permission (permission_key) VALUES
    ('ride:create'), ('ride:join'), ('ride:end'), ('ride:delete'),
    ('status:set'), ('accident:report'), ('alert:view_own'),
    ('contact:manage'), ('friend:manage'), ('recommend:view'),
    ('admin:view_all_rides'), ('admin:view_accidents'), ('admin:view_audit'),
    ('admin:run_queries'), ('admin:dispatch_alert')
ON CONFLICT ON CONSTRAINT uq_permission_key DO NOTHING;

-- RIDER gets every non-admin permission; ADMIN gets everything.
INSERT INTO role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM app_role r
JOIN permission p
  ON r.role_name = 'ADMIN'
  OR (r.role_name = 'RIDER' AND p.permission_key NOT LIKE 'admin:%')
ON CONFLICT ON CONSTRAINT pk_role_permission DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. The database login the application uses
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bykr_app') THEN
        -- Development credentials; see .env.example.
        CREATE ROLE bykr_app LOGIN PASSWORD 'bykr_app'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO bykr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bykr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bykr_app;
-- alert_audit is append-only, and alerts/recipients are written only by the
-- trigger and procedures (SECURITY DEFINER), never directly by the app.
REVOKE UPDATE, DELETE ON alert_audit FROM bykr_app;

-- -----------------------------------------------------------------------------
-- 3. Helper functions the policies call
--    They live here rather than in 03_functions.sql because a policy binds to
--    its functions when it is created, and this file runs before 03.
--    SECURITY DEFINER: they run with the owner's rights, so a policy on
--    ride_participant can consult ride_participant without recursing into
--    its own policy.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_current_user_id() RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::INT
$$;

CREATE OR REPLACE FUNCTION fn_is_admin(p_user_id INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1
        FROM user_role ur
        JOIN app_role r ON r.role_id = ur.role_id
        WHERE ur.user_id = p_user_id AND r.role_name = 'ADMIN'
    )
$$;

-- The core rule: a rider sees a ride only if they are in it (or created it);
-- an ADMIN sees everything.
CREATE OR REPLACE FUNCTION fn_user_can_view_ride(p_user_id INT, p_ride_id INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT p_user_id IS NOT NULL AND (
           fn_is_admin(p_user_id)
        OR EXISTS (SELECT 1 FROM ride_participant rp
                   WHERE rp.ride_id = p_ride_id AND rp.user_id = p_user_id)
        OR EXISTS (SELECT 1 FROM ride r
                   WHERE r.ride_id = p_ride_id AND r.created_by = p_user_id)
    )
$$;

CREATE OR REPLACE FUNCTION fn_is_ride_leader(p_user_id INT, p_ride_id INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT p_user_id IS NOT NULL AND (
           EXISTS (SELECT 1 FROM ride r
                   WHERE r.ride_id = p_ride_id AND r.created_by = p_user_id)
        OR EXISTS (SELECT 1 FROM ride_participant rp
                   WHERE rp.ride_id = p_ride_id AND rp.user_id = p_user_id AND rp.is_leader)
    )
$$;

-- Which ride does a participant row belong to, and whose is it?
CREATE OR REPLACE FUNCTION fn_participant_ride(p_participant_id INT) RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT ride_id FROM ride_participant WHERE participant_id = p_participant_id
$$;

CREATE OR REPLACE FUNCTION fn_participant_owner(p_participant_id INT) RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT user_id FROM ride_participant WHERE participant_id = p_participant_id
$$;

CREATE OR REPLACE FUNCTION fn_event_ride(p_event_id INT) RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT rp.ride_id
    FROM accident_event e
    JOIN ride_participant rp ON rp.participant_id = e.participant_id
    WHERE e.event_id = p_event_id
$$;

CREATE OR REPLACE FUNCTION fn_alert_ride(p_alert_id INT) RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT fn_event_ride(a.event_id) FROM sos_alert a WHERE a.alert_id = p_alert_id
$$;

-- -----------------------------------------------------------------------------
-- 4. Row level security
-- -----------------------------------------------------------------------------
ALTER TABLE ride              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_participant  ENABLE ROW LEVEL SECURITY;
ALTER TABLE accident_event    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sos_alert         ENABLE ROW LEVEL SECURITY;
-- Beyond the four the brief requires: everything else that belongs to a ride,
-- so a non-participant cannot reach a ride's data through a side table.
ALTER TABLE alert_recipient   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rider_status      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_summary      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_waypoint     ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_audit       ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_contact ENABLE ROW LEVEL SECURITY;

-- ride ------------------------------------------------------------------------
-- created_by is checked on the row itself as well as through the function:
-- INSERT ... RETURNING re-checks this policy against the new row, and the
-- STABLE function's snapshot cannot see a row inserted by the same statement.
CREATE POLICY pol_ride_select ON ride FOR SELECT
    USING (created_by = fn_current_user_id()
           OR fn_user_can_view_ride(fn_current_user_id(), ride_id));
CREATE POLICY pol_ride_insert ON ride FOR INSERT
    WITH CHECK (created_by = fn_current_user_id());
CREATE POLICY pol_ride_update ON ride FOR UPDATE
    USING (fn_is_ride_leader(fn_current_user_id(), ride_id) OR fn_is_admin(fn_current_user_id()));
CREATE POLICY pol_ride_delete ON ride FOR DELETE
    USING (created_by = fn_current_user_id() OR fn_is_admin(fn_current_user_id()));

-- ride_participant ------------------------------------------------------------
CREATE POLICY pol_ride_participant_select ON ride_participant FOR SELECT
    USING (fn_user_can_view_ride(fn_current_user_id(), ride_id));
-- Only the leader (or creator) adds rows: themselves at creation, friends as invites.
CREATE POLICY pol_ride_participant_insert ON ride_participant FOR INSERT
    WITH CHECK (fn_is_ride_leader(fn_current_user_id(), ride_id));
-- A rider updates their own row (join / leave); the leader may update any.
CREATE POLICY pol_ride_participant_update ON ride_participant FOR UPDATE
    USING (user_id = fn_current_user_id() OR fn_is_ride_leader(fn_current_user_id(), ride_id));
CREATE POLICY pol_ride_participant_delete ON ride_participant FOR DELETE
    USING (fn_is_ride_leader(fn_current_user_id(), ride_id) OR fn_is_admin(fn_current_user_id()));

-- accident_event --------------------------------------------------------------
CREATE POLICY pol_accident_event_select ON accident_event FOR SELECT
    USING (fn_user_can_view_ride(fn_current_user_id(), fn_participant_ride(participant_id)));
-- You can only report an accident on your own participant row.
CREATE POLICY pol_accident_event_insert ON accident_event FOR INSERT
    WITH CHECK (fn_participant_owner(participant_id) = fn_current_user_id());

-- sos_alert -------------------------------------------------------------------
-- No INSERT/UPDATE policy: the application role cannot create or alter an
-- alert directly. Only trg_generate_sos and sp_dispatch_alert can.
CREATE POLICY pol_sos_alert_select ON sos_alert FOR SELECT
    USING (fn_user_can_view_ride(fn_current_user_id(), fn_event_ride(event_id)));

-- alert_recipient -------------------------------------------------------------
CREATE POLICY pol_alert_recipient_select ON alert_recipient FOR SELECT
    USING (user_id = fn_current_user_id()
           OR fn_user_can_view_ride(fn_current_user_id(), fn_alert_ride(alert_id)));

-- rider_status ----------------------------------------------------------------
CREATE POLICY pol_rider_status_select ON rider_status FOR SELECT
    USING (fn_user_can_view_ride(fn_current_user_id(), fn_participant_ride(participant_id)));
CREATE POLICY pol_rider_status_insert ON rider_status FOR INSERT
    WITH CHECK (fn_participant_owner(participant_id) = fn_current_user_id());
CREATE POLICY pol_rider_status_update ON rider_status FOR UPDATE
    USING (fn_participant_owner(participant_id) = fn_current_user_id());

-- ride_summary / ride_waypoint ------------------------------------------------
CREATE POLICY pol_ride_summary_select ON ride_summary FOR SELECT
    USING (fn_user_can_view_ride(fn_current_user_id(), ride_id));
CREATE POLICY pol_ride_summary_update ON ride_summary FOR UPDATE
    USING (fn_is_ride_leader(fn_current_user_id(), ride_id) OR fn_is_admin(fn_current_user_id()));
CREATE POLICY pol_ride_waypoint_select ON ride_waypoint FOR SELECT
    USING (fn_user_can_view_ride(fn_current_user_id(), ride_id));
CREATE POLICY pol_ride_waypoint_insert ON ride_waypoint FOR INSERT
    WITH CHECK (fn_is_ride_leader(fn_current_user_id(), ride_id));

-- alert_audit: administrators only --------------------------------------------
CREATE POLICY pol_alert_audit_select ON alert_audit FOR SELECT
    USING (fn_is_admin(fn_current_user_id()));

-- emergency_contact: your own contacts only (admins may read) ------------------
CREATE POLICY pol_emergency_contact_select ON emergency_contact FOR SELECT
    USING (user_id = fn_current_user_id() OR fn_is_admin(fn_current_user_id()));
CREATE POLICY pol_emergency_contact_write ON emergency_contact FOR ALL
    USING (user_id = fn_current_user_id())
    WITH CHECK (user_id = fn_current_user_id());
