-- =============================================================================
-- bykr — 03_functions.sql
-- Stored functions. Rubric column O (advanced SQL: function, CTE).
--
-- fn_user_can_view_ride(p_user_id, p_ride_id), the function the row level
-- security policies use, is defined in 02_rbac.sql next to those policies:
-- a policy binds to its functions at creation time and 02 runs before 03.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Great-circle distance between two points, in kilometres (haversine formula).
-- IMMUTABLE so the planner may fold constant calls and use it in indexes.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_haversine_km(
    lat1 NUMERIC, lon1 NUMERIC, lat2 NUMERIC, lon2 NUMERIC
) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT (2 * 6371.0088 * asin(sqrt(
              power(sin(radians((lat2 - lat1)::float8) / 2), 2)
            + cos(radians(lat1::float8)) * cos(radians(lat2::float8))
            * power(sin(radians((lon2 - lon1)::float8) / 2), 2)
           )))::NUMERIC
$$;

-- -----------------------------------------------------------------------------
-- Path length of a ride: sum of haversine legs between consecutive waypoints.
-- LAG() pairs each waypoint with the one before it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_ride_distance_km(p_ride_id INT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(round(sum(leg_km), 3), 0)
    FROM (
        SELECT fn_haversine_km(
                   LAG(latitude)  OVER w, LAG(longitude) OVER w,
                   latitude, longitude) AS leg_km
        FROM ride_waypoint
        WHERE ride_id = p_ride_id
        WINDOW w AS (ORDER BY seq)
    ) legs
$$;

-- -----------------------------------------------------------------------------
-- Number of stops in a ride: transitions from moving (>= 5 km/h) to
-- stationary (< 5 km/h) along the waypoint sequence.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_ride_stop_count(p_ride_id INT) RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT COUNT(*)::INT
    FROM (
        SELECT speed_kmph,
               LAG(speed_kmph) OVER (ORDER BY seq) AS prev_speed
        FROM ride_waypoint
        WHERE ride_id = p_ride_id
    ) s
    WHERE s.speed_kmph < 5 AND s.prev_speed >= 5
$$;

-- -----------------------------------------------------------------------------
-- Authorities whose jurisdiction covers a point. Used by trg_generate_sos.
-- Display-only: bykr never contacts these numbers itself.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_authorities_for_point(p_lat NUMERIC, p_lon NUMERIC)
RETURNS SETOF authority
LANGUAGE sql STABLE AS $$
    SELECT a.*
    FROM authority a
    WHERE fn_haversine_km(p_lat, p_lon, a.base_latitude, a.base_longitude) <= a.radius_km
$$;

-- -----------------------------------------------------------------------------
-- Friends-of-friends to a given depth, with degree of separation.
-- RECURSIVE CTE over the friendship graph (a recursive relationship on app_user).
-- Powers "People you may know" in the app; also in 06_queries.sql.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_friends_within(p_user_id INT, p_max_depth INT)
RETURNS TABLE (user_id INT, full_name TEXT, degree INT)
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE edges AS (            -- accepted friendships, both directions
        SELECT requester_id AS a, addressee_id AS b FROM friendship WHERE link_state = 'ACCEPTED'
        UNION ALL
        SELECT addressee_id, requester_id           FROM friendship WHERE link_state = 'ACCEPTED'
    ),
    walk (user_id, degree, path) AS (
        SELECT p_user_id, 0, ARRAY[p_user_id]
        UNION ALL
        SELECT e.b, w.degree + 1, w.path || e.b
        FROM walk w
        JOIN edges e ON e.a = w.user_id
        WHERE w.degree < p_max_depth
          AND NOT e.b = ANY (w.path)       -- never revisit: stops cycles
    )
    SELECT w.user_id, u.full_name, MIN(w.degree)::INT AS degree
    FROM walk w
    JOIN app_user u ON u.user_id = w.user_id
    WHERE w.user_id <> p_user_id
    GROUP BY w.user_id, u.full_name
    ORDER BY degree, u.full_name
$$;

-- -----------------------------------------------------------------------------
-- VECTOR FEATURE: route discovery.
-- Row level security hides other people's rides, which is right for the ride
-- itself (participants, live positions, accidents). Discovery deliberately
-- exposes a whitelisted public route card — title, distance, duration, start —
-- for any completed ride. These SECURITY DEFINER functions are that single,
-- narrow window; nothing else about the ride leaks.
-- The similarity itself is the plain pgvector cosine-distance operator <=>,
-- served by the HNSW index ix_ride_summary_embedding_hnsw.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_similar_rides(p_ride_id INT, p_limit INT DEFAULT 5)
RETURNS TABLE (ride_id INT, ride_title TEXT, distance_km NUMERIC, duration_min NUMERIC,
               start_lat NUMERIC, start_lon NUMERIC, cosine_distance FLOAT8)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT r.ride_id, r.ride_title, s.distance_km, s.duration_min, s.start_lat, s.start_lon,
           s.route_embedding <=> src.route_embedding AS cosine_distance
    FROM ride_summary s
    JOIN ride r ON r.ride_id = s.ride_id
    CROSS JOIN (SELECT route_embedding FROM ride_summary WHERE ride_id = p_ride_id) src
    WHERE s.ride_id <> p_ride_id
      AND s.route_embedding IS NOT NULL
      AND fn_user_can_view_ride(fn_current_user_id(), p_ride_id)   -- you must be allowed to see the source ride
    ORDER BY s.route_embedding <=> src.route_embedding
    LIMIT p_limit
$$;

-- Recommendation: average the embeddings of the rider's completed rides
-- (pgvector's AVG over vector), then return the nearest rides they have NOT
-- been on.
CREATE OR REPLACE FUNCTION fn_recommend_rides(p_user_id INT, p_limit INT DEFAULT 5)
RETURNS TABLE (ride_id INT, ride_title TEXT, distance_km NUMERIC, duration_min NUMERIC,
               start_lat NUMERIC, start_lon NUMERIC, cosine_distance FLOAT8)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
    -- You may ask for your own recommendations; an admin may ask for anyone's.
    IF fn_current_user_id() IS DISTINCT FROM p_user_id AND NOT fn_is_admin(fn_current_user_id()) THEN
        RAISE EXCEPTION 'not allowed to read recommendations for user %', p_user_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN QUERY
    WITH taste AS (
        SELECT AVG(s.route_embedding) AS centroid
        FROM ride_summary s
        JOIN ride_participant rp ON rp.ride_id = s.ride_id
        WHERE rp.user_id = p_user_id AND rp.joined_at IS NOT NULL
          AND s.route_embedding IS NOT NULL
    )
    SELECT r.ride_id, r.ride_title, s.distance_km, s.duration_min, s.start_lat, s.start_lon,
           s.route_embedding <=> t.centroid AS cosine_distance
    FROM ride_summary s
    JOIN ride r ON r.ride_id = s.ride_id
    CROSS JOIN taste t
    WHERE t.centroid IS NOT NULL
      AND s.route_embedding IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ride_participant rp
                      WHERE rp.ride_id = s.ride_id AND rp.user_id = p_user_id)
    ORDER BY s.route_embedding <=> t.centroid
    LIMIT p_limit;
END $$;
