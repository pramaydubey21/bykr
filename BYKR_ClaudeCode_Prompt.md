# Implementation prompt for bykr — paste the whole of the section below into Claude Code

---

You are building a complete, working Database Management Systems mini-project from scratch. Read this entire brief before writing any code. The project is graded against a fixed rubric reproduced at the end; every rubric line must be satisfiable by pointing at a specific file.

## 1. What the application is

**bykr** is a web application for groups of people riding motorcycles together. It does three things.

**Live ride tracking.** A rider creates a ride and invites people from their friend circle. While the ride is active, each participant's browser reports its position on a five second interval, and every participant sees every other participant as a marker on one shared map.

**Rider status broadcasting.** A participant publishes a short state chosen from a fixed list — refuelling, eating, delayed, riding, stopped — which appears against their map marker and is retained in the ride history with the time it was set and the time it was cleared.

**Accident detection and alerting.** During an active ride the browser monitors device motion. A sudden impact followed by a period of no movement raises a suspected accident. The rider gets a thirty second countdown to cancel a false alarm. If the countdown expires, the system generates exactly one alert and fans it out to every co-rider, every emergency contact the rider has registered, and every authority record for the ride region, recording a delivery outcome for each recipient individually. The system never contacts a real emergency service; authority records are displayed for a human to act on.

## 2. Technology stack — use exactly this

| Layer | Technology | Notes |
|---|---|---|
| Front end | Next.js 15 (App Router), TypeScript, Tailwind CSS | Required by the rubric. |
| Backend | Next.js route handlers under `app/api/` | No separate server process. |
| Relational database | PostgreSQL 16 with the `pgvector` extension | Primary store. |
| Document database | MongoDB 7 | High-volume telemetry only. |
| Database access | `pg` (node-postgres) and the official `mongodb` driver | See the hard rule below. |
| Authentication | Auth.js v5 (NextAuth) with a credentials provider, Argon2 password hashing | |
| Mapping | `react-leaflet` with OpenStreetMap tiles | Chosen over Google Maps because it needs no API key or billing account. |
| Local services | Docker Compose for PostgreSQL and MongoDB | |

**Hard rule: do not use Prisma, Drizzle, TypeORM, Sequelize or any other object relational mapper.** Every database interaction must be hand-written SQL in a `.sql` file or a tagged query in the data access layer. The marks in this project are awarded for visible SQL. An ORM hides exactly the work being graded. This rule is not negotiable; if you find yourself reaching for an ORM, write the SQL instead.

## 3. Division of data between the two databases

This split must be deliberate and defensible, because the student will be asked in the oral examination why there are two databases.

**PostgreSQL holds everything that needs relational integrity**: users, roles, permissions, friendships, rides, ride participants, status types, rider statuses, accident events, SOS alerts, alert recipients, emergency contacts, authorities, and the route embedding vectors.

**MongoDB holds the high-volume, high-write, schema-flexible telemetry**: individual location pings and raw device motion samples. These arrive at roughly one document per participant every five seconds, carry no foreign key relationships that matter, and expire after thirty days. The justification to write down is: write volume is an order of magnitude higher than any other entity, the records are append-only, they are queried geospatially rather than relationally, and a time-to-live index can expire them automatically — all properties a document store handles better than a relational table.

## 4. PostgreSQL schema

Build these relations. `ride_participant` is the hub of the design: location data, statuses and accident events all reference it rather than referencing a user and a ride separately, which makes it structurally impossible to record data for a rider who never joined the ride.

- `app_user` — user_id PK, full_name, email UNIQUE, phone_no, password_hash, created_at
- `app_role` — role_id PK, role_name UNIQUE (seed with RIDER and ADMIN)
- `user_role` — user_id FK, role_id FK, composite PK
- `permission` — permission_id PK, permission_key UNIQUE
- `role_permission` — role_id FK, permission_id FK, composite PK
- `friendship` — friendship_id PK, requester_id FK, addressee_id FK, link_state, linked_at; CHECK requester ≠ addressee; UNIQUE on the ordered pair
- `ride` — ride_id PK, created_by FK, ride_title, started_at, ended_at, ride_state CHECK IN (CREATED, ACTIVE, COMPLETED)
- `ride_participant` — participant_id PK, ride_id FK, user_id FK, joined_at, left_at, is_leader; UNIQUE (ride_id, user_id)
- `status_type` — type_id PK, status_label UNIQUE, icon_name
- `rider_status` — status_id PK, participant_id FK, type_id FK, set_at, cleared_at
- `accident_event` — event_id PK, participant_id FK, impact_force NUMERIC, latitude, longitude, detected_at, is_confirmed BOOLEAN
- `sos_alert` — alert_id PK, event_id FK UNIQUE, channel, sent_at, delivery_state
- `alert_recipient` — recipient_id PK, alert_id FK, recipient_kind CHECK IN (CO_RIDER, EMERGENCY_CONTACT, AUTHORITY), user_id FK NULL, contact_id FK NULL, authority_id FK NULL, delivery_state, attempted_at; CHECK that exactly one of the three reference columns is non-null and matches recipient_kind
- `emergency_contact` — contact_id PK, user_id FK ON DELETE CASCADE, contact_name, contact_phone, relation
- `authority` — authority_id PK, authority_name, authority_type, contact_no, jurisdiction
- `ride_summary` — ride_id PK FK, distance_km, duration_min, avg_speed_kmph, max_speed_kmph, stop_count, start_lat, start_lon, end_lat, end_lon, bbox_diagonal_km, straightness_ratio, route_embedding vector(96)
- `alert_audit` — audit_id PK, alert_id, recipient_id, attempted_at, outcome; append-only

Every table gets explicit primary keys, foreign keys with a deliberate ON DELETE action, NOT NULL where appropriate, CHECK constraints on every enumerated column, and named constraints. Named constraints matter — `chk_alert_recipient_exactly_one` is defensible in an oral examination, `alert_recipient_check1` is not.

## 5. The vector feature — route and ride recommendation

This is worth eleven marks across two rubric columns and is the single largest scoring block. Build it properly.

**What it does.** When a ride completes, the system computes a 96-dimensional embedding describing that ride's route. A rider can then ask for rides similar to one they enjoyed, and the system returns the nearest routes by cosine distance. A rider with ride history can also ask for a recommendation, in which case the system averages the embeddings of their completed rides and returns the nearest rides they have not been on.

**How to build the embedding.** Do not call an external embedding model. Build the vector deterministically so that every dimension can be explained in the oral examination. Compose it as follows.

- **Dimensions 1 to 64 — route shape.** Take the full sequence of location pings for the ride from MongoDB. Resample it to exactly 32 points at equal distance intervals along the path. Normalise each point relative to the route's bounding box so that coordinates fall in the range 0 to 1. This makes shape comparable between a 10 km ride and a 200 km ride. Flatten to 64 values.
- **Dimensions 65 to 96 — route character.** Min-max normalised scalars: total distance, duration, average speed, maximum speed, speed variance, stop count, number of status changes, count of each status type, straightness ratio (direct distance divided by path distance), bounding box diagonal, start hour encoded as sine and cosine, day of week encoded as sine and cosine, start latitude and longitude normalised to the operating region, elevation proxy if available. Pad with zeros to reach 96.

**Storage and indexing.** Store in the `route_embedding vector(96)` column. Create an HNSW index using `vector_cosine_ops`. Write the similarity query as a plain SQL statement using the `<=>` operator so the vector search is visibly SQL and not hidden in application code.

**Keep a written note** in `docs/vector-design.md` explaining the dimension layout, why normalisation by bounding box makes shape scale-invariant, and why a deterministic feature vector was chosen over a language model embedding. That note is the answer to the obvious oral examination question.

## 6. MongoDB design

Two collections.

`location_pings` — one document per reading: `{ participantId, rideId, userId, location: { type: "Point", coordinates: [lon, lat] }, speedKmph, accuracyM, recordedAt }`. Create a `2dsphere` index on `location`, a compound index on `{ rideId: 1, recordedAt: 1 }`, and a TTL index on `recordedAt` expiring after thirty days.

`motion_samples` — raw device motion windows around a suspected impact: `{ participantId, rideId, samples: [...], peakMagnitudeG, capturedAt }`. Used as evidence behind an accident event.

**The rubric awards seven marks for a NoSQL feature plus read, update and delete operations.** Implement and expose all of the following, each in its own named function in `lib/mongo/`, and demonstrate each one in the application interface, not only in a script:

- **Create** — bulk insert of buffered pings on reconnection.
- **Read, geospatial** — `$near` query finding participants within a radius of an accident location. This is the NoSQL feature to lead with in the oral examination, because it is something the relational store would do badly.
- **Read, aggregation** — an aggregation pipeline computing per-ride distance, average speed and stop count from the raw pings. This is also what feeds the embedding in section 5.
- **Update** — `updateMany` tagging all pings of a ride with a computed segment identifier once the ride completes.
- **Delete** — `deleteMany` purging pings for a ride the user has deleted, plus the TTL index as automatic expiry.

## 7. Required SQL artefacts

Put these in `db/`, one concern per file, and make every one of them reachable from the application rather than existing only as a file.

**`db/01_schema.sql`** — all DDL, with named constraints and indexes.

**`db/02_rbac.sql`** — the role and permission seed data, plus PostgreSQL row level security. Enable RLS on `ride`, `ride_participant`, `accident_event` and `sos_alert`. Write policies keyed on `current_setting('app.current_user_id')`, set per request by the data access layer. The policy must express the rule that a rider may read a ride only if they hold a participant row in it, and that a user holding the ADMIN role may read everything. Row level security is how the rubric phrase "role-based access control in database" is satisfied; enforcing roles only in TypeScript does not satisfy it.

**`db/03_functions.sql`** — at minimum:
- `fn_haversine_km(lat1, lon1, lat2, lon2) RETURNS NUMERIC`
- `fn_ride_distance_km(p_ride_id INT) RETURNS NUMERIC`
- `fn_user_can_view_ride(p_user_id INT, p_ride_id INT) RETURNS BOOLEAN`, used by the row level security policies

**`db/04_procedures.sql`** — at minimum:
- `sp_end_ride(p_ride_id INT, p_user_id INT)` — verifies the caller is the ride leader, sets state to COMPLETED, rejects further pings, and populates `ride_summary`
- `sp_dispatch_alert(p_alert_id INT)` — walks the recipient set, writes an attempt row into `alert_audit` for each, and updates each recipient's delivery state

**`db/05_triggers.sql`** — `trg_generate_sos`, an AFTER INSERT trigger on `accident_event` that fires only when `is_confirmed` is true and, in the same transaction, inserts exactly one `sos_alert` row and one `alert_recipient` row per co-rider, per emergency contact of the affected rider, and per authority record matching the ride region. This trigger is the centrepiece of the project. The reason it is a trigger and not application code: if the application process dies between writing the accident and writing the alert, a rider has been recorded as crashed with nobody notified. Put that reasoning in a comment above the trigger.

**`db/06_queries.sql`** — a showcase file. Every query carries a comment naming the rubric column it satisfies. Include at least:
- A **recursive CTE** walking the friendship graph to find friends-of-friends to a given depth, with the degree of separation returned. The friendship table is a recursive relationship and this is the natural demonstration.
- A **correlated subquery** — participants whose average speed on a ride exceeded the average speed of that same ride's other participants.
- A **nested subquery** — rides with more participants than the overall average participant count.
- A **non-recursive CTE chain** — a ride report assembling participants, statuses and incidents in stages.
- **Multi-table joins** across at least five tables, including a LEFT JOIN where the absence of rows is meaningful, such as rides with no accident events.
- A **window function** — ranking riders by distance covered within each ride.
- An **aggregate with HAVING** — status types used more than a threshold number of times.
- The **vector similarity query** using `<=>`.

**`db/07_dml.sql`** — representative INSERT, UPDATE and DELETE statements covering every table, including a multi-row INSERT, an UPDATE with a subquery in its WHERE clause, and a DELETE demonstrating cascade behaviour.

**`db/08_seed.sql`** — at least 8 users, 20 friendships, 10 rides of which 7 are completed, 3 to 5 participants per ride, status history, 3 accident events of which 2 are confirmed, emergency contacts for every user, and 5 authority records. The completed rides must have enough ping history in MongoDB for the embeddings to be meaningful; write a seeding script that generates plausible routes rather than random points, because random points make the recommendation feature look broken.

## 8. Application scope

Keep the interface small. The marks are in the database; the interface exists to demonstrate it.

- Sign up, sign in, sign out. Argon2 hashing. Session through Auth.js.
- Friend list: send a request, accept a request, list the circle.
- Emergency contacts: add, edit, delete.
- Ride list, ride creation, join a ride, end a ride.
- Live ride map: Leaflet, one marker per participant, status badge against each marker, position refreshed by polling the API every five seconds. Do not build WebSockets; polling is sufficient for a demonstration and is one less thing to break.
- Status control reachable in two clicks from the map.
- Accident path: a `DeviceMotion` listener plus an explicit "simulate impact" button, because device motion is not reliably available on a desktop browser and the examiner will be looking at a laptop. Both routes lead to the same countdown and the same server call.
- Alert view: shows the fan-out, every recipient, and each delivery state.
- Ride history for a completed ride, including the route drawn on a map.
- "Rides like this one" and "Recommended for you", both backed by the vector query.
- Admin area, visible only to the ADMIN role: all rides, all accident events, the alert audit log, and a page that runs each showcase query from `db/06_queries.sql` and displays the result. That last page is worth building — it turns the oral examination into a demonstration.

## 9. Repository layout and documentation

```
bykr/
  docker-compose.yml
  db/01..08_*.sql
  mongo/init.js
  lib/db/          -- node-postgres pool, per-request RLS setting
  lib/mongo/       -- collection accessors, the five RUD functions
  lib/vector/      -- embedding construction
  app/             -- Next.js App Router
  scripts/seed.ts  -- runs the SQL seeds and generates MongoDB routes
  docs/
    ER-diagram.png
    relational-schema.png
    technology-justification.md
    vector-design.md
  RUBRIC.md
  README.md
```

**`RUBRIC.md` is mandatory and must be written last.** It contains one row per rubric column, naming the exact file, function or line that satisfies it. Write it only once everything else is built, and verify each claim by opening the file rather than from memory.

**`README.md`** must let someone clone the repository and reach a running, seeded application with working credentials in under five commands.

**Git.** Commit incrementally with meaningful messages — schema, then RBAC, then procedures, then the application, then the vector feature. A single commit called "initial commit" loses marks under the documentation column.

## 10. Build order

Work in this sequence and confirm each step runs before moving on.

1. Docker Compose with PostgreSQL plus pgvector and MongoDB; confirm both accept connections.
2. `db/01_schema.sql`; confirm it applies cleanly to an empty database and re-applies after a drop.
3. `db/02_rbac.sql` with row level security; confirm a non-participant genuinely cannot select another ride's rows.
4. `db/03`, `04`, `05`; confirm the trigger produces the right recipient count by inserting a confirmed accident by hand.
5. MongoDB collections, indexes and the five RUD functions.
6. Seeding, including generated routes.
7. Embedding construction and the similarity query, tested against seeded data.
8. `db/06_queries.sql` and `db/07_dml.sql`; run every statement and confirm it returns sensible rows.
9. The Next.js application.
10. Documentation, diagrams, `RUBRIC.md`.

## 11. Verification before you declare the work finished

- Every SQL file applies cleanly to a fresh database in order.
- The trigger test: a confirmed accident in a ride with two co-riders, two emergency contacts and one authority record produces exactly one `sos_alert` and exactly five `alert_recipient` rows. A cancelled accident produces zero alerts.
- The row level security test: authenticate as a rider who is not a participant of a ride and confirm every read of that ride's data returns nothing.
- The recursive query returns correct degrees of separation on the seeded friendship graph.
- The recommendation returns different results for two riders with different ride histories. If it returns the same list for everyone, the embedding is broken — fix it rather than shipping it.
- Every one of the five MongoDB operations is reachable from the interface.
- `RUBRIC.md` has been verified line by line against the files.

## 12. The rubric being graded against

| Column | Item | Marks |
|---|---|---|
| H | ER diagram | 2 |
| I | Relational schema with keys, relationships and constraints | 3 |
| J | SQL database implementation, DDL with constraints | 4 |
| K | NoSQL / vector database creation | 4 |
| L | Technology justification | 1 |
| M | DML operations | 4 |
| N | Nested, correlated, recursive and join queries | 4 |
| O | Advanced SQL — procedure, function, trigger, CTE | 6 |
| P | NoSQL / vector feature, read, update, delete | 7 |
| Q | Next.js interface | 3 |
| R | Backend, API and database integration | 2 |
| S | Authentication, minimum two roles, role-based access control in database | 4 |
| T | Documentation, Git and GitHub | 2 |
| U | Originality, individual contribution, modification and oral examination | 4 |
| | **Total** | **50** |

Begin with step 1 of the build order. Ask before deviating from anything in this brief.
