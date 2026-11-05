-- =============================================================================
-- bykr — 05_triggers.sql
-- Triggers. Rubric column O (advanced SQL: trigger).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- trg_generate_sos — the centrepiece.
--
-- WHY A TRIGGER AND NOT APPLICATION CODE
--   If the web process wrote the accident and then, as a second step, wrote the
--   alert, a crash, timeout or deploy between those two steps would leave a
--   rider recorded as crashed with nobody notified. As an AFTER INSERT trigger
--   the alert and every recipient row are created INSIDE the same transaction
--   as the accident: either the accident and its complete fan-out both commit,
--   or neither does. There is no window in which one exists without the other,
--   and no code path (API, psql, a future mobile client) can forget to do it.
--
-- WHAT IT DOES (only when NEW.is_confirmed is true — a cancelled countdown
-- inserts is_confirmed = false and produces no alert):
--   * exactly one sos_alert row (uq_sos_alert_event makes a second impossible);
--   * one alert_recipient per CO_RIDER: every other participant who has joined
--     the ride and not left it;
--   * one per EMERGENCY_CONTACT registered by the affected rider;
--   * one per AUTHORITY whose jurisdiction radius covers the accident point.
--
-- SECURITY DEFINER because the application role has no INSERT policy on
-- sos_alert or alert_recipient: alerts can only ever come from here.
-- Authority rows are DISPLAYED for a human; nothing here contacts anyone.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_trg_generate_sos() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_alert_id  INT;
    v_ride_id   INT;
    v_user_id   INT;
BEGIN
    SELECT ride_id, user_id INTO v_ride_id, v_user_id
    FROM ride_participant WHERE participant_id = NEW.participant_id;

    INSERT INTO sos_alert (event_id, channel, sent_at, delivery_state)
    VALUES (NEW.event_id, 'IN_APP', now(), 'PENDING')
    RETURNING alert_id INTO v_alert_id;

    -- co-riders
    INSERT INTO alert_recipient (alert_id, recipient_kind, user_id)
    SELECT v_alert_id, 'CO_RIDER', rp.user_id
    FROM ride_participant rp
    WHERE rp.ride_id = v_ride_id
      AND rp.user_id <> v_user_id
      AND rp.joined_at IS NOT NULL
      AND rp.left_at IS NULL;

    -- the affected rider's emergency contacts
    INSERT INTO alert_recipient (alert_id, recipient_kind, contact_id)
    SELECT v_alert_id, 'EMERGENCY_CONTACT', ec.contact_id
    FROM emergency_contact ec
    WHERE ec.user_id = v_user_id;

    -- authorities covering the accident location
    INSERT INTO alert_recipient (alert_id, recipient_kind, authority_id)
    SELECT v_alert_id, 'AUTHORITY', a.authority_id
    FROM fn_authorities_for_point(NEW.latitude, NEW.longitude) a;

    RETURN NULL;   -- AFTER trigger: return value ignored
END $$;

DROP TRIGGER IF EXISTS trg_generate_sos ON accident_event;
CREATE TRIGGER trg_generate_sos
    AFTER INSERT ON accident_event
    FOR EACH ROW
    WHEN (NEW.is_confirmed)
    EXECUTE FUNCTION fn_trg_generate_sos();

-- -----------------------------------------------------------------------------
-- trg_accident_requires_active_ride
-- An accident can only be reported on a ride that is ACTIVE, by a participant
-- who has joined and not left.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_trg_accident_requires_active_ride() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM ride_participant rp
        JOIN ride r ON r.ride_id = rp.ride_id
        WHERE rp.participant_id = NEW.participant_id
          AND r.ride_state = 'ACTIVE'
          AND rp.joined_at IS NOT NULL
          AND rp.left_at IS NULL
    ) THEN
        RAISE EXCEPTION 'participant % is not riding an ACTIVE ride', NEW.participant_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_accident_requires_active_ride ON accident_event;
CREATE TRIGGER trg_accident_requires_active_ride
    BEFORE INSERT ON accident_event
    FOR EACH ROW
    EXECUTE FUNCTION fn_trg_accident_requires_active_ride();

-- -----------------------------------------------------------------------------
-- trg_rider_status_close_previous
-- Setting a new status closes the rider's previous open one at the same
-- instant, so status history is a gap-free timeline and
-- ux_rider_status_one_open is never violated.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_trg_rider_status_close_previous() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE rider_status
       SET cleared_at = GREATEST(NEW.set_at, set_at)
     WHERE participant_id = NEW.participant_id
       AND cleared_at IS NULL;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_rider_status_close_previous ON rider_status;
CREATE TRIGGER trg_rider_status_close_previous
    BEFORE INSERT ON rider_status
    FOR EACH ROW
    WHEN (NEW.cleared_at IS NULL)
    EXECUTE FUNCTION fn_trg_rider_status_close_previous();

-- -----------------------------------------------------------------------------
-- trg_alert_audit_append_only
-- The audit trail can be appended to, never rewritten — not even by the
-- superuser through ordinary DML (on top of the REVOKE in 02_rbac.sql).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_trg_alert_audit_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'alert_audit is append-only: % rejected', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS trg_alert_audit_append_only ON alert_audit;
CREATE TRIGGER trg_alert_audit_append_only
    BEFORE UPDATE OR DELETE ON alert_audit
    FOR EACH ROW
    EXECUTE FUNCTION fn_trg_alert_audit_append_only();
