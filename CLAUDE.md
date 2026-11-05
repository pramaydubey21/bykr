# bykr — project constraints

Specification: `BYKR_ClaudeCode_Prompt.md`. Orientation: `README-FIRST.md`.

These constraints hold for the whole build. Re-read them if the conversation has been compacted.

## Stack — fixed, do not substitute

Next.js 15 App Router, TypeScript, Tailwind CSS, PostgreSQL 16 with pgvector, MongoDB 7, Auth.js v5 with Argon2, react-leaflet, Docker Compose.

## Hard rules

1. **No object relational mapper.** No Prisma, Drizzle, TypeORM, Sequelize, Knex or query builder. Use `pg` with hand-written SQL and the official `mongodb` driver. The marks in this project are awarded for visible SQL; an ORM hides exactly what is being graded. This rule has no exceptions.
2. **Ignore the Kotlin stack in `reference/`.** Those documents belong to a different course and were deliberately left on an older stack. Their requirements and behaviour are useful; their technology choices are not. Never write Kotlin, Ktor or Android code.
3. **Role-based access control lives in the database.** PostgreSQL row level security with policies keyed on `current_setting('app.current_user_id')`. Checking roles only in TypeScript does not satisfy the rubric.
4. **Alert generation is a database trigger**, not application code. `trg_generate_sos` fires AFTER INSERT on `accident_event` when `is_confirmed` is true, and creates the alert and every recipient row inside the same transaction.
5. **Never contact a real emergency service.** Authority records are displayed for a human to act on. No outbound call, message or request to any police, ambulance or government endpoint, in code or in configuration.
6. **The route embedding is deterministic**, built from resampled geometry and normalised ride statistics. No external embedding model, no API key, no network call.

## Verification gates

Do not move past a step until it passes.

- Schema applies cleanly to an empty database and re-applies after a drop.
- A confirmed accident with 2 co-riders, 2 emergency contacts and 1 authority record produces exactly 1 `sos_alert` and exactly 5 `alert_recipient` rows. A cancelled accident produces 0 alerts.
- A rider who is not a participant of a ride reads nothing from that ride, enforced by row level security rather than by application code.
- Two riders with different ride histories receive different recommendations. Identical results for every rider means the embedding is broken.
- All five MongoDB operations — bulk insert, geospatial read, aggregation read, update, delete — are reachable from the user interface, not only from a script.

## Git

Commit incrementally with meaningful messages: schema, then access control, then procedures and triggers, then MongoDB, then seeding, then the vector feature, then the application, then documentation. A single "initial commit" loses marks.

## Finish

Write `RUBRIC.md` last. One row per rubric column, naming the exact file, function or line number that satisfies it. Verify every claim by opening the file. Do not write it from memory.
