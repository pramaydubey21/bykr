-- =============================================================================
-- bykr — 08_seed.sql
-- Relational seed data. Applied by scripts/seed.ts after 01–05, which then:
--   * generates realistic MongoDB ping tracks along each ride's route,
--   * ends every historical ride through the real sp_end_ride path,
--   * builds each route embedding.
--
-- Contents: 9 users (8 riders + 1 admin), 22 friendships, 12 rides
-- (9 to be completed, 2 live, 1 planned), 3–4 participants per ride, status
-- history, 3 accident events (2 confirmed), emergency contacts for every
-- user, 5 authority records.
--
-- Every user's password is:  bykr-demo-123   (Argon2id hash below)
--
-- Ride lifecycle convention read by scripts/seed.ts:
--   ACTIVE and started more than a day ago -> historical; seed.ts completes it
--   ACTIVE and started minutes ago         -> live ride for the demo
--   CREATED                                -> planned, not started
-- Authority records are display-only demo data; bykr never contacts them.
-- =============================================================================

-- A local morning/evening in India, N days ago, as timestamptz.
CREATE OR REPLACE FUNCTION pg_temp.ist(p_days_ago INT, p_hhmm TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql AS $$
    SELECT ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
             - make_interval(days => p_days_ago)
             + p_hhmm::time) AT TIME ZONE 'Asia/Kolkata')
$$;

-- -----------------------------------------------------------------------------
-- Users and roles
-- -----------------------------------------------------------------------------
INSERT INTO app_user (full_name, email, phone_no, password_hash) VALUES
    ('Aarav Kulkarni', 'aarav@bykr.local',  '+91 98220 10001', '$argon2id$v=19$m=19456,t=2,p=1$Ks4WcVix7Xp+hlhF7Kae0A$74Rvdwde6LMKaQpftFSIWSVXQVYcFuwbGRx16iIz2YQ'),
    ('Isha Deshpande', 'isha@bykr.local',   '+91 98220 10002', '$argon2id$v=19$m=19456,t=2,p=1$Ks4WcVix7Xp+hlhF7Kae0A$74Rvdwde6LMKaQpftFSIWSVXQVYcFuwbGRx16iIz2YQ'),
    ('Rohan Patil',    'rohan@bykr.local',  '+91 98220 10003', '$argon2id$v=19$m=19456,t=2,p=1$Ks4WcVix7Xp+hlhF7Kae0A$74Rvdwde6LMKaQpftFSIWSVXQVYcFuwbGRx16iIz2YQ'),
    ('Meera Joshi',    'meera@bykr.local',  '+91 98220 10004', '$argon2id$v=19$m=19456,t=2,p=1$Ks4WcVix7Xp+hlhF7Kae0A$74Rvdwde6LMKaQpftFSIWSVXQVYcFuwbGRx16iIz2YQ'),
    ('Kabir Shah',     'kabir@bykr.local',  '+91 98220 10005', '$argon2id$v=19$m=19456,t=2,p=1$Ks4WcVix7Xp+hlhF7Kae0A$74Rvdwde6LMKaQpftFSIWSVXQVYcFuwbGRx16iIz2YQ'),
    ('Ananya Rao',     'ananya@bykr.local', '+91 98220 10006', '$argon2id$v=19$m=19456,t=2,p=1$Ks4WcVix7Xp+hlhF7Kae0A$74Rvdwde6LMKaQpftFSIWSVXQVYcFuwbGRx16iIz2YQ'),
    ('Vikram Nair',    'vikram@bykr.local', '+91 98220 10007', '$argon2id$v=19$m=19456,t=2,p=1$Ks4WcVix7Xp+hlhF7Kae0A$74Rvdwde6LMKaQpftFSIWSVXQVYcFuwbGRx16iIz2YQ'),
    ('Sana Sheikh',    'sana@bykr.local',   '+91 98220 10008', '$argon2id$v=19$m=19456,t=2,p=1$Ks4WcVix7Xp+hlhF7Kae0A$74Rvdwde6LMKaQpftFSIWSVXQVYcFuwbGRx16iIz2YQ'),
    ('Bykr Admin',     'admin@bykr.local',  '+91 98220 10009', '$argon2id$v=19$m=19456,t=2,p=1$Ks4WcVix7Xp+hlhF7Kae0A$74Rvdwde6LMKaQpftFSIWSVXQVYcFuwbGRx16iIz2YQ');

-- Everyone is a RIDER; the admin is also ADMIN.
INSERT INTO user_role (user_id, role_id)
SELECT u.user_id, r.role_id
FROM app_user u
JOIN app_role r ON r.role_name = 'RIDER'
   OR (r.role_name = 'ADMIN' AND u.email = 'admin@bykr.local');

-- -----------------------------------------------------------------------------
-- Friendships (22): a graph with real friends-of-friends structure.
-- Two loose clusters — highway riders {1,2,3,7,8} and ghat riders {4,5,6} —
-- joined by a few bridges, plus pending requests.
-- -----------------------------------------------------------------------------
INSERT INTO friendship (requester_id, addressee_id, link_state, requested_at, linked_at)
SELECT f.req, f.addr, f.state, now() - interval '60 days',
       CASE WHEN f.state = 'ACCEPTED' THEN now() - interval '59 days' END
FROM (VALUES
    (1,2,'ACCEPTED'), (1,3,'ACCEPTED'), (2,3,'ACCEPTED'), (1,7,'ACCEPTED'),
    (2,7,'ACCEPTED'), (3,8,'ACCEPTED'), (7,8,'ACCEPTED'), (4,5,'ACCEPTED'),
    (4,6,'ACCEPTED'), (5,6,'ACCEPTED'), (5,1,'ACCEPTED'), (6,8,'ACCEPTED'),
    (2,4,'ACCEPTED'), (1,6,'ACCEPTED'), (3,6,'ACCEPTED'), (7,5,'ACCEPTED'),
    (9,1,'ACCEPTED'), (9,4,'ACCEPTED'),
    (3,5,'PENDING'),  (6,7,'PENDING'),  (8,4,'PENDING'),  (2,8,'PENDING')
) AS f(req, addr, state);

-- -----------------------------------------------------------------------------
-- Reference data
-- -----------------------------------------------------------------------------
INSERT INTO status_type (status_label, icon_name) VALUES
    ('RIDING', 'bike'), ('REFUELLING', 'fuel'), ('EATING', 'utensils'),
    ('DELAYED', 'clock'), ('STOPPED', 'pause');

INSERT INTO authority (authority_name, authority_type, contact_no, jurisdiction,
                       base_latitude, base_longitude, radius_km) VALUES
    ('Pune City Police Control Room (demo record)', 'POLICE',         '112', 'Pune city',            18.520400, 73.856700, 30),
    ('Pune Ambulance Service (demo record)',        'AMBULANCE',      '108', 'Pune district',        18.520400, 73.856700, 45),
    ('Lonavala Highway Patrol (demo record)',       'HIGHWAY_PATROL', '112', 'Mumbai-Pune corridor', 18.750000, 73.407000, 30),
    ('Mahabaleshwar Police Station (demo record)',  'POLICE',         '112', 'Satara hill region',   17.924000, 73.700000, 35),
    ('Alibaug Police Station (demo record)',        'POLICE',         '112', 'Raigad coast',         18.641400, 72.872200, 35);

INSERT INTO emergency_contact (user_id, contact_name, contact_phone, relation) VALUES
    (1, 'Sunita Kulkarni',  '+91 99700 20001', 'PARENT'),
    (1, 'Neha Kulkarni',    '+91 99700 20002', 'SIBLING'),
    (2, 'Prakash Deshpande','+91 99700 20003', 'PARENT'),
    (3, 'Kavita Patil',     '+91 99700 20004', 'PARENT'),
    (3, 'Omkar Patil',      '+91 99700 20005', 'SIBLING'),
    (4, 'Arjun Joshi',      '+91 99700 20006', 'SPOUSE'),
    (5, 'Farah Shah',       '+91 99700 20007', 'PARENT'),
    (6, 'Lakshmi Rao',      '+91 99700 20008', 'PARENT'),
    (6, 'Karthik Rao',      '+91 99700 20009', 'SIBLING'),
    (7, 'Deepa Nair',       '+91 99700 20010', 'SPOUSE'),
    (8, 'Imran Sheikh',     '+91 99700 20011', 'SIBLING'),
    (9, 'Ops Duty Officer', '+91 99700 20012', 'OTHER');

-- -----------------------------------------------------------------------------
-- Rides (ride_id follows insertion order: 1..12)
-- -----------------------------------------------------------------------------
INSERT INTO ride (created_by, ride_title, created_at, started_at, ride_state) VALUES
    (1, 'Expressway sunrise run',        pg_temp.ist(25,'20:00'), pg_temp.ist(24,'06:00'), 'ACTIVE'),
    (2, 'Old highway to Khandala',       pg_temp.ist(22,'20:00'), pg_temp.ist(21,'07:00'), 'ACTIVE'),
    (3, 'Panvel to Pune express dash',   pg_temp.ist(19,'20:00'), pg_temp.ist(18,'05:30'), 'ACTIVE'),
    (4, 'Sinhagad ghat loop',            pg_temp.ist(17,'20:00'), pg_temp.ist(16,'06:30'), 'ACTIVE'),
    (5, 'Mahabaleshwar twisties',        pg_temp.ist(14,'20:00'), pg_temp.ist(13,'07:30'), 'ACTIVE'),
    (6, 'Bhimashankar forest climb',     pg_temp.ist(12,'20:00'), pg_temp.ist(11,'06:00'), 'ACTIVE'),
    (7, 'Pune city night loop',          pg_temp.ist(10,'18:00'), pg_temp.ist(9, '21:30'), 'ACTIVE'),
    (8, 'Alibaug coastal ride',          pg_temp.ist(7, '20:00'), pg_temp.ist(6, '08:00'), 'ACTIVE'),
    (4, 'Lavasa lake ride',              pg_temp.ist(4, '20:00'), pg_temp.ist(3, '16:00'), 'ACTIVE'),
    (1, 'Tamhini ghat monsoon ride',     now() - interval '2 hours',  now() - interval '25 minutes', 'ACTIVE'),
    (7, 'Weekend breakfast run',         now() - interval '3 hours',  now() - interval '40 minutes', 'ACTIVE');
INSERT INTO ride (created_by, ride_title, created_at, ride_state) VALUES
    (3, 'Kolhapur weekend plan',         now() - interval '1 day', 'CREATED');

-- Participants: the creator leads; everyone joined 10 minutes before the start.
INSERT INTO ride_participant (ride_id, user_id, invited_at, joined_at, is_leader)
SELECT p.ride_id, p.user_id,
       COALESCE(r.started_at, r.created_at) - interval '1 day',
       CASE WHEN p.joined THEN COALESCE(r.started_at - interval '10 minutes', r.created_at) END,
       p.user_id = r.created_by
FROM (VALUES
    (1,1,true),(1,2,true),(1,3,true),(1,7,true),
    (2,2,true),(2,3,true),(2,1,true),
    (3,3,true),(3,1,true),(3,2,true),(3,8,true),
    (4,4,true),(4,5,true),(4,6,true),
    (5,5,true),(5,4,true),(5,6,true),(5,1,true),
    (6,6,true),(6,4,true),(6,5,true),
    (7,7,true),(7,8,true),(7,2,true),
    (8,8,true),(8,7,true),(8,3,true),
    (9,4,true),(9,6,true),(9,8,true),
    (10,1,true),(10,4,true),(10,5,true),
    (11,7,true),(11,8,true),(11,2,true),(11,6,true),
    (12,3,true),(12,5,false),(12,6,false)          -- 5 and 6 invited, not yet joined
) AS p(ride_id, user_id, joined)
JOIN ride r ON r.ride_id = p.ride_id;

-- -----------------------------------------------------------------------------
-- Status history. Offsets are minutes after the ride started. user_id NULL
-- means "every joined participant" (a group stop). Inserted in time order;
-- trg_rider_status_close_previous stamps cleared_at on the previous status.
-- scripts/seed.ts reads the leader's REFUELLING / EATING / STOPPED windows
-- and makes the generated route actually stop there.
-- -----------------------------------------------------------------------------
INSERT INTO rider_status (participant_id, type_id, set_at)
SELECT rp.participant_id, st.type_id, r.started_at + make_interval(mins => s.offset_min)
FROM (VALUES
    (1, NULL, 'RIDING', 0),   (1, 7, 'DELAYED', 5),   (1, 7, 'RIDING', 10),
    (1, NULL, 'REFUELLING', 25), (1, NULL, 'RIDING', 35),
    (2, NULL, 'RIDING', 0),   (2, NULL, 'EATING', 30),  (2, NULL, 'RIDING', 55),
    (3, NULL, 'RIDING', 0),   (3, NULL, 'REFUELLING', 40), (3, NULL, 'RIDING', 50),
    (3, 8, 'DELAYED', 60),    (3, 8, 'RIDING', 70),
    (4, NULL, 'RIDING', 0),   (4, NULL, 'STOPPED', 40), (4, NULL, 'EATING', 45), (4, NULL, 'RIDING', 70),
    (5, NULL, 'RIDING', 0),   (5, NULL, 'STOPPED', 20), (5, NULL, 'RIDING', 25),
    (5, NULL, 'EATING', 45),  (5, NULL, 'RIDING', 60),
    (6, NULL, 'RIDING', 0),   (6, NULL, 'STOPPED', 30), (6, NULL, 'RIDING', 40),
    (6, NULL, 'REFUELLING', 70), (6, NULL, 'RIDING', 78),
    (7, NULL, 'RIDING', 0),   (7, NULL, 'EATING', 25),  (7, NULL, 'RIDING', 45),
    (7, NULL, 'STOPPED', 55), (7, NULL, 'RIDING', 60),
    (8, NULL, 'RIDING', 0),   (8, NULL, 'EATING', 40),  (8, NULL, 'RIDING', 60),
    (9, NULL, 'RIDING', 0),   (9, NULL, 'STOPPED', 45), (9, NULL, 'RIDING', 55),
    (10, NULL, 'RIDING', 0),  (10, 4, 'REFUELLING', 15),
    (11, NULL, 'RIDING', 0),  (11, 6, 'DELAYED', 5),    (11, 8, 'EATING', 30)
) AS s(ride_id, user_id, label, offset_min)
JOIN ride r              ON r.ride_id = s.ride_id
JOIN ride_participant rp ON rp.ride_id = s.ride_id
                        AND rp.joined_at IS NOT NULL
                        AND (s.user_id IS NULL OR rp.user_id = s.user_id)
JOIN status_type st      ON st.status_label = s.label
ORDER BY r.started_at + make_interval(mins => s.offset_min), rp.participant_id;

-- -----------------------------------------------------------------------------
-- Accident events. Rides are still ACTIVE here, as trg_accident_requires_active_ride
-- demands. The two confirmed ones fire trg_generate_sos.
-- -----------------------------------------------------------------------------
INSERT INTO accident_event (participant_id, impact_force, latitude, longitude, detected_at, is_confirmed)
SELECT rp.participant_id, a.force, a.lat, a.lon, r.started_at + make_interval(mins => a.offset_min), a.confirmed
FROM (VALUES
    -- Ananya slides out on a hairpin near Panchgani: confirmed.
    (5, 6, 7.80, 17.925000, 73.800000, 35, true),
    -- Rohan hits a pothole on the coast road near Alibaug: confirmed.
    (8, 3, 6.40, 18.645000, 72.900000, 25, true),
    -- Isha's phone falls off the mount on the expressway: cancelled in the countdown.
    (1, 2, 4.10, 18.640000, 73.640000, 12, false)
) AS a(ride_id, user_id, force, lat, lon, offset_min, confirmed)
JOIN ride r              ON r.ride_id = a.ride_id
JOIN ride_participant rp ON rp.ride_id = a.ride_id AND rp.user_id = a.user_id
ORDER BY 6;

-- Dispatch every generated alert (writes alert_audit, sets delivery states).
DO $$
DECLARE v_alert INT;
BEGIN
    FOR v_alert IN SELECT alert_id FROM sos_alert ORDER BY alert_id LOOP
        CALL sp_dispatch_alert(v_alert);
    END LOOP;
END $$;
