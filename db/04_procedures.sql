-- =============================================================================
-- bykr — 04_procedures.sql
-- Stored procedures. Rubric column O (advanced SQL: procedure).
--
-- Both are SECURITY DEFINER: they write rows the application role is not
-- permitted to write directly (ride_summary inserts, alert_audit, recipient
-- delivery states). Each therefore performs its own authorisation check first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sp_end_ride
--   1. verifies the caller is the ride leader,
--   2. sets the ride COMPLETED (ended_at = last waypoint, or now),
--   3. closes every open participant row and open status,
--   4. populates ride_summary from ride_waypoint.
-- Once ride_state is COMPLETED, POST /api/rides/[id]/pings rejects further
-- pings (it checks the state in the same request; see lib/db/rides.ts).
-- The route_embedding column is filled afterwards by lib/vector, which needs
-- the full-rate MongoDB pings.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_end_ride(p_ride_id INT, p_user_id INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_state      TEXT;
    v_started    TIMESTAMPTZ;
    v_ended      TIMESTAMPTZ;
    v_points     INT;
    v_session    INT := fn_current_user_id();
BEGIN
    -- The caller may not end a ride "as" somebody else. (A NULL session means
    -- an administrative connection such as the seed script.)
    IF v_session IS NOT NULL AND v_session <> p_user_id THEN
        RAISE EXCEPTION 'session user % cannot end a ride as user %', v_session, p_user_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT ride_state, started_at INTO v_state, v_started
    FROM ride WHERE ride_id = p_ride_id
    FOR UPDATE;                                   -- serialise concurrent "end" clicks

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ride % does not exist', p_ride_id USING ERRCODE = 'no_data_found';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM ride_participant
                   WHERE ride_id = p_ride_id AND user_id = p_user_id AND is_leader) THEN
        RAISE EXCEPTION 'only the ride leader can end ride %', p_ride_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_state <> 'ACTIVE' THEN
        RAISE EXCEPTION 'ride % is %, only an ACTIVE ride can be ended', p_ride_id, v_state
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*), max(recorded_at) INTO v_points, v_ended
    FROM ride_waypoint WHERE ride_id = p_ride_id;
    v_ended := GREATEST(COALESCE(v_ended, now()), v_started);

    UPDATE ride
       SET ride_state = 'COMPLETED', ended_at = v_ended
     WHERE ride_id = p_ride_id;

    UPDATE ride_participant
       SET left_at = GREATEST(v_ended, joined_at)
     WHERE ride_id = p_ride_id AND joined_at IS NOT NULL AND left_at IS NULL;

    UPDATE rider_status rs
       SET cleared_at = GREATEST(v_ended, rs.set_at)
      FROM ride_participant rp
     WHERE rp.participant_id = rs.participant_id
       AND rp.ride_id = p_ride_id
       AND rs.cleared_at IS NULL;

    -- A ride with fewer than two waypoints has no route to summarise.
    IF v_points < 2 THEN
        RETURN;
    END IF;

    INSERT INTO ride_summary (ride_id, distance_km, duration_min, avg_speed_kmph, max_speed_kmph,
                              stop_count, start_lat, start_lon, end_lat, end_lon,
                              bbox_diagonal_km, straightness_ratio)
    WITH pts AS (
        SELECT * FROM ride_waypoint WHERE ride_id = p_ride_id
    ),
    ends AS (
        SELECT (SELECT latitude  FROM pts ORDER BY seq ASC  LIMIT 1) AS s_lat,
               (SELECT longitude FROM pts ORDER BY seq ASC  LIMIT 1) AS s_lon,
               (SELECT latitude  FROM pts ORDER BY seq DESC LIMIT 1) AS e_lat,
               (SELECT longitude FROM pts ORDER BY seq DESC LIMIT 1) AS e_lon
    ),
    stats AS (
        SELECT fn_ride_distance_km(p_ride_id)                         AS dist_km,
               EXTRACT(EPOCH FROM (v_ended - v_started)) / 60.0       AS dur_min,
               COALESCE(max(speed_kmph), 0)                           AS vmax,
               fn_haversine_km(min(latitude), min(longitude),
                               max(latitude), max(longitude))          AS bbox_km
        FROM pts
    )
    SELECT p_ride_id,
           round(st.dist_km, 2),
           round(st.dur_min::NUMERIC, 2),
           round(avg_v, 2),
           round(GREATEST(st.vmax, avg_v), 2),
           fn_ride_stop_count(p_ride_id),
           e.s_lat, e.s_lon, e.e_lat, e.e_lon,
           round(st.bbox_km, 2),
           round(LEAST(1, CASE WHEN st.dist_km > 0
                               THEN fn_haversine_km(e.s_lat, e.s_lon, e.e_lat, e.e_lon) / st.dist_km
                               ELSE 0 END), 4)
    FROM stats st
    CROSS JOIN ends e
    CROSS JOIN LATERAL (
        SELECT CASE WHEN st.dur_min > 0 THEN st.dist_km / (st.dur_min / 60.0) ELSE 0 END::NUMERIC AS avg_v
    ) a
    ON CONFLICT ON CONSTRAINT pk_ride_summary DO UPDATE
       SET distance_km = EXCLUDED.distance_km, duration_min = EXCLUDED.duration_min,
           avg_speed_kmph = EXCLUDED.avg_speed_kmph, max_speed_kmph = EXCLUDED.max_speed_kmph,
           stop_count = EXCLUDED.stop_count, start_lat = EXCLUDED.start_lat,
           start_lon = EXCLUDED.start_lon, end_lat = EXCLUDED.end_lat, end_lon = EXCLUDED.end_lon,
           bbox_diagonal_km = EXCLUDED.bbox_diagonal_km,
           straightness_ratio = EXCLUDED.straightness_ratio, computed_at = now();
END $$;

-- -----------------------------------------------------------------------------
-- sp_dispatch_alert
--   Walks every PENDING recipient of an alert, appends one alert_audit row per
--   attempt, and records that recipient's delivery outcome.
--
--   bykr NEVER contacts a real emergency service. Outcomes are:
--     CO_RIDER          -> DELIVERED               (in-app notification)
--     EMERGENCY_CONTACT -> MANUAL_ACTION_REQUIRED  (number shown for a human to call)
--     AUTHORITY         -> MANUAL_ACTION_REQUIRED  (record shown for a human to act on)
--   Idempotent: a second call finds no PENDING recipients and changes nothing.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_dispatch_alert(p_alert_id INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    rec        RECORD;
    v_outcome  TEXT;
    v_session  INT := fn_current_user_id();
    v_failed   INT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sos_alert WHERE alert_id = p_alert_id) THEN
        RAISE EXCEPTION 'alert % does not exist', p_alert_id USING ERRCODE = 'no_data_found';
    END IF;

    IF v_session IS NOT NULL
       AND NOT fn_user_can_view_ride(v_session, fn_alert_ride(p_alert_id)) THEN
        RAISE EXCEPTION 'user % may not dispatch alert %', v_session, p_alert_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    FOR rec IN
        SELECT recipient_id, recipient_kind
        FROM alert_recipient
        WHERE alert_id = p_alert_id AND delivery_state = 'PENDING'
        ORDER BY recipient_id
        FOR UPDATE
    LOOP
        v_outcome := CASE rec.recipient_kind
                         WHEN 'CO_RIDER' THEN 'DELIVERED'
                         ELSE 'MANUAL_ACTION_REQUIRED'
                     END;

        INSERT INTO alert_audit (alert_id, recipient_id, outcome)
        VALUES (p_alert_id, rec.recipient_id, v_outcome);

        UPDATE alert_recipient
           SET delivery_state = v_outcome, attempted_at = now()
         WHERE recipient_id = rec.recipient_id;
    END LOOP;

    SELECT count(*) INTO v_failed
    FROM alert_recipient WHERE alert_id = p_alert_id AND delivery_state = 'FAILED';

    UPDATE sos_alert
       SET delivery_state = CASE WHEN v_failed = 0 THEN 'DISPATCHED' ELSE 'PARTIAL' END
     WHERE alert_id = p_alert_id;
END $$;
