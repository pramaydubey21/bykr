# Technology justification

This note explains why bykr uses each technology it does. For each choice it names
the requirement that drove it and the alternative that was considered.

| Layer | Choice |
|---|---|
| Web framework | Next.js 15 (App Router) with route handlers, TypeScript, Tailwind CSS |
| Relational store | PostgreSQL 16 + pgvector |
| Telemetry store | MongoDB 7 |
| Database access | `pg` (node-postgres) and the official `mongodb` driver, with hand-written queries and no ORM |
| Access control | PostgreSQL row level security |
| Alert fan-out | `trg_generate_sos` database trigger |
| Maps | Leaflet via `react-leaflet`, OpenStreetMap tiles |
| Authentication | Auth.js v5 credentials provider, Argon2id (`@node-rs/argon2`) |
| Live updates | HTTP polling every 5 s |
| Local services | Docker Compose (`pgvector/pgvector:pg16`, `mongo:7`) |

---

## Next.js 15 App Router with route handlers

* **One process, one language.** Pages (React Server and Client Components) and the API
  (`app/api/**/route.ts`) live in one TypeScript project and deploy as one process.
  There is no separate Express server to run, configure or keep in step with the
  frontend. Types such as `Ping` from `lib/vector` are shared directly between the
  server and the client.
* **Server components fit a database project.** Pages such as ride history, the alert
  view and the admin query runner can query PostgreSQL on the server and send plain
  HTML. No query code and no connection string reaches the browser.
* **Route handlers are thin.** Each handler authenticates the request, opens a pooled
  connection, sets `app.current_user_id`, runs SQL and returns JSON. The logic stays
  in the database, which is where the marks are.
* **Required by the rubric**, and the App Router is the current, supported model for
  Next.js 15.

## PostgreSQL 16 + pgvector

* **Integrity where it matters.** Users, friendships, rides, participants, statuses,
  accidents, alerts and recipients form a connected graph of facts. These need
  foreign keys, named CHECK constraints (such as `chk_alert_recipient_exactly_one`),
  unique constraints and transactions. That is the relational model's home ground.
* **The features we grade are PostgreSQL features.** These include recursive CTEs
  (degrees of separation in the friend graph), PL/pgSQL functions and procedures,
  triggers, and row level security.
* **pgvector keeps the vectors next to the data they describe.** The route embedding
  lives in `ride_summary.route_embedding vector(96)` with an HNSW `vector_cosine_ops`
  index. "Rides like this one" is therefore one SQL statement that joins ride titles,
  applies access rules and orders by `<=>`, all in one transaction. A separate vector
  database (Pinecone, Qdrant) would need a second copy of ride IDs and a second access
  control model, and the similarity search would become invisible as SQL. Details are
  in `docs/vector-design.md`.

## MongoDB 7 for location pings and motion samples

* **Write volume.** Each participant sends a ping every 5 seconds. A six-rider,
  four-hour ride produces about 17,000 ping documents, compared with a few dozen
  relational rows for the ride, its participants and statuses. Telemetry outnumbers
  every other entity by orders of magnitude. MongoDB's document inserts and
  `insertMany` (used for the bulk upload of pings buffered while offline) are built for
  this append-heavy pattern.
* **Append-only, no meaningful foreign keys.** A ping is never edited by a user and is
  never the target of a join that needs referential integrity. Enforcing foreign keys
  on every ping would be cost without benefit. Integrity is anchored where it matters:
  every ping carries `participantId`, which exists in PostgreSQL.
* **Geospatial queries.** `location.coordinates` is a GeoJSON Point with a `2dsphere`
  index (`ix_pings_location_2dsphere`). "Which riders were within 2 km of this accident?"
  is a single `$near` query with `$maxDistance`, sorted by distance on a spherical
  earth. Doing the same in plain PostgreSQL means hand-written haversine maths over a
  full scan, or adding PostGIS.
* **Automatic expiry.** A TTL index (`ttl_pings_30d`, `expireAfterSeconds` = 30 days)
  makes MongoDB delete old pings itself. No cron job and no `DELETE … WHERE recorded_at
  < now() - interval '30 days'` sweeping a large table are needed. The durable
  per-ride facts (distance, duration, embedding) are aggregated into `ride_summary`
  before the pings expire.
* **Flexible shape.** `motion_samples` holds raw accelerometer windows whose length and
  fields vary by device. A JSON-schema validator (`mongo/init.js`) enforces the
  required fields without forcing every sample into fixed columns.

## Why both databases

Each store does the job it is good at, and the boundary between them is clean:

| | PostgreSQL | MongoDB |
|---|---|---|
| Data | Users, rides, statuses, accidents, alerts, embeddings | Pings, motion samples |
| Volume | Low (rows per ride: tens) | High (documents per ride: thousands) |
| Lifetime | Permanent | 30 days (TTL) |
| Integrity | Foreign keys, CHECKs, RLS, triggers | Validator on required fields |
| Main query | Joins, recursion, `<=>` similarity | `$near`, aggregation pipelines |

The only link between them is the integer `participantId` / `rideId`, which MongoDB
documents copy from PostgreSQL. The MongoDB aggregation that computes per-ride
distance, speed and stops feeds the embedding, which is then stored back in
PostgreSQL. So each database consumes what the other produces, and neither
duplicates the other's job.

## No ORM

* **The SQL is what is being assessed.** The rubric awards marks for visible, hand-written
  SQL: schema, constraints, joins, recursive queries, procedures and triggers. An ORM
  (Prisma, Drizzle, TypeORM, Sequelize) or a query builder (Knex) generates that SQL
  out of sight, which hides exactly the work being graded.
* **The features we use are outside what ORMs model well.** Row level security that
  depends on a per-transaction `set_config('app.current_user_id', …)`, `SECURITY DEFINER`
  functions, `CALL` to procedures, pgvector's `<=>`, and `WITH RECURSIVE` all end up as
  raw SQL inside an ORM anyway. At that point the ORM adds a layer and removes nothing.
* **`pg` with parameterised queries** (`$1`, `$2`) gives the same protection against SQL
  injection that an ORM would, and each query can be copied straight into `psql` for
  the oral examination.

## Row level security in the database

* **One rule, every path.** Policies such as `pol_ride_select` on `ride`,
  `ride_participant`, `accident_event`, `sos_alert` and `alert_recipient` are keyed on
  `fn_current_user_id()`, which reads `current_setting('app.current_user_id')`. They
  apply to every query from the application role, whichever route handler, admin page
  or ad-hoc SQL runs it. A forgotten `WHERE user_id = …` in TypeScript cannot leak
  another group's ride, because the database never returns the rows.
* **Defence in depth.** TypeScript checks still decide what the user interface shows.
  The database is the backstop that makes "a rider who is not a participant reads
  nothing from that ride" true by construction. The verification gate tests it with
  SQL, not through the user interface.
* **The rubric asks for it explicitly**: role checks only in application code do not
  satisfy the access-control column.
* **Narrow, named exceptions.** Where data must cross the boundary on purpose (route
  discovery cards in `fn_similar_rides`, alert creation in the trigger), it does so
  through a `SECURITY DEFINER` function that returns a fixed set of columns. Each
  exception can be read in one place and explained.

## SOS fan-out as a trigger

* **Atomicity.** `trg_generate_sos` fires `AFTER INSERT` on `accident_event` when
  `is_confirmed` is true. It creates the `sos_alert` and every `alert_recipient` row
  (co-riders, emergency contacts, authorities) inside the same transaction as the
  accident. If the application did this as a second step, a crash or timeout between
  the two writes would leave a recorded accident with nobody notified. With the
  trigger, either both commit or neither does.
* **No path can skip it.** Accidents from the API, from `psql`, from the seed script or
  from a future mobile client all produce the alert, because the database produces it.
* **Exactly once.** `uq_sos_alert_event` (UNIQUE on `event_id`) makes a duplicate alert
  impossible even if a client retries. A cancelled countdown inserts
  `is_confirmed = false`, and the trigger produces nothing.
* **Testable by hand.** Inserting one confirmed accident in `psql` and counting rows
  (1 alert, 5 recipients for 2 co-riders + 2 contacts + 1 authority) is the
  verification gate.
* **Safety.** The trigger only writes rows. Authority records are displayed for a human
  to act on. Nothing in the database or the application contacts a real emergency
  service.

## Leaflet + OpenStreetMap

* **No API key and no billing account.** Google Maps requires a key tied to a billing
  account. A marker could not render without one, which is a poor dependency for a
  project an examiner should be able to clone and run.
* **Enough for the job.** The live map needs tiles, one marker per participant with a
  status badge, and a polyline for ride history. Leaflet does all three in a few
  kilobytes. `react-leaflet` wraps it in React components. (It needs the DOM, so the
  map is a client component loaded without server-side rendering.)
* **Open data.** OpenStreetMap coverage of Pune, Mumbai and the Lonavala ghats is good,
  and its tile usage policy suits a low-traffic demonstration.

## Auth.js v5 with Argon2

* **Auth.js v5** is the authentication library built for the Next.js App Router. One
  `auth()` call works in server components, route handlers and middleware. The
  credentials provider lets bykr own its `app_user` table, so the user ID that RLS
  relies on is our own primary key and not a third party's.
* **Argon2id** is the winner of the Password Hashing Competition and the current OWASP
  recommendation. It is memory-hard, which makes GPU and ASIC guessing expensive in a
  way that SHA-256, and to a lesser degree bcrypt, are not. The schema enforces it:
  `chk_app_user_hash_argon2` rejects any `password_hash` that does not start with
  `$argon2`. `@node-rs/argon2` ships prebuilt native binaries, so `npm install` needs
  no compiler toolchain.
* **The bridge to RLS.** The session's user ID is what each route handler writes into
  `app.current_user_id` (with `set_config(…, true)`, which scopes it to the transaction)
  before running SQL. Authentication and database authorisation therefore share one
  identity.

## Polling instead of WebSockets

* **The data changes every 5 seconds anyway.** Pings are sent every 5 s, so a map that
  polls the ride's live-positions route handler (`GET /api/rides/[id]/live`) every 5 s is never more than one interval behind.
  WebSockets would not make positions meaningfully fresher.
* **Fits the platform.** Next.js route handlers are request/response. WebSockets would
  need a custom server or a third-party broker, which is a second process and a second
  failure mode, against the "no separate server process" requirement.
* **Each poll is ordinary HTTP.** The same Auth.js session, RLS context and SQL apply to
  each poll. That is easy to debug in the browser's network tab and easy to
  demonstrate. A dropped connection simply means the next poll succeeds. There is no
  reconnect protocol to get wrong.
* **Load is trivial at this scale.** A six-rider ride makes about 1.2 requests per
  second, each one indexed query.
* **Room to grow.** If bykr outgrew polling, Server-Sent Events would be the next step
  (one-way, plain HTTP), well before WebSockets.

## Docker Compose

Two containers (`pgvector/pgvector:pg16` with the extension preinstalled, and
`mongo:7` with `mongo/init.js` creating validators and indexes) bring up the whole
data layer with one `docker compose up -d`. Every examiner and team member gets the
same database versions, with nothing installed on the host.
