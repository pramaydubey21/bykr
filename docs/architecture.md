# bykr — architecture

bykr is a single Next.js 15 application with two databases behind it. It has no separate API server, no message broker and no WebSocket server. Every request goes through a Next.js route handler or server action. PostgreSQL enforces who may see what. MongoDB stores the telemetry.

```
 Browser (React, react-leaflet, DeviceMotion)
    │  fetch every 5 s / form posts
    ▼
 Next.js route handler  (app/api/**/route.ts)  or server action
    │  auth()  → session JWT → user id         (auth.ts, lib/auth/session.ts)
    ├──────────────────────────────┐
    ▼                              ▼
 withUser(userId, fn)          lib/mongo/telemetry.ts
 (lib/db/index.ts)                 │  official mongodb driver
    │ BEGIN                        ▼
    │ set_config('app.current_user_id', id, true)    MongoDB 7
    │ …hand-written SQL…                             location_pings, motion_samples
    │ COMMIT / ROLLBACK                              (2dsphere + 30-day TTL)
    ▼
 PostgreSQL 16 + pgvector, connected as bykr_app (NOSUPERUSER NOBYPASSRLS)
    │ row level security policies   (db/02_rbac.sql)
    │ triggers                      (db/05_triggers.sql)
    │ SECURITY DEFINER procedures   (db/04_procedures.sql)
```

## 1. Request flow: browser → route handler → `withUser` → RLS

1. **Browser.** A page sends a request with `fetch`, such as `GET /api/rides/42/positions` or a status change. The Auth.js session cookie goes with it.
2. **Route handler.** The handler calls `requireUserId()` (or `requireAdmin()`) from `lib/auth/session.ts`. That decodes the Auth.js v5 JWT and returns the numeric `user_id`. There is no middleware because the edge runtime cannot load `pg` or Argon2. Each protected handler makes this call itself.
3. **`withUser(userId, fn)`** in `lib/db/index.ts` takes a pooled connection and runs:
   ```sql
   BEGIN;
   SELECT set_config('app.current_user_id', '<id>', true);  -- true = transaction-local
   -- the handler's hand-written SQL runs here
   COMMIT;   -- or ROLLBACK on any error
   ```
   Because the setting is transaction-local, it ends at `COMMIT`/`ROLLBACK`. It cannot leak to the next request that borrows the same pooled connection.
4. **Row level security.** The pool connects as `bykr_app`, which is `NOSUPERUSER NOBYPASSRLS`, so every policy in `db/02_rbac.sql` applies. The policies read the user through `fn_current_user_id()`. The core rule is `fn_user_can_view_ride(user, ride)`: a rider sees a ride only if they hold a `ride_participant` row in it or created it. A user with the `ADMIN` role sees everything. If the setting is missing it reads as `NULL`, and `NULL` matches no rows. So a handler that forgets `withUser` gets nothing back, not everything.
5. **Writes the app role may not make directly.** These are alerts, alert recipients, ending a ride and dispatching an alert. They go through a trigger (`trg_generate_sos`) or a `SECURITY DEFINER` procedure (`sp_end_ride`, `sp_dispatch_alert`). Each one checks permissions itself before it writes.
6. **MongoDB.** Location pings and motion samples go to MongoDB through `lib/mongo/telemetry.ts`. Mongo has no RLS. The rule for these handlers is to run a cheap SQL query under `withUser` first, confirming the caller is a participant of the ride, and only then touch Mongo. The participant check is therefore still decided by PostgreSQL.

The user-interface roles in the session (for example, hiding the Admin link) are only for display. Removing them from the client changes what is shown, not what can be read.

## 2. Why polling, not WebSockets

The live map refreshes by polling the API every five seconds. That interval is the same as the rate at which each participant reports a position.

- **Matches the data rate.** Positions arrive once every five seconds. A push channel would deliver the same update at the same moment, so it adds nothing here.
- **No extra server process.** Next.js route handlers are request/response. WebSockets would need a long-lived custom server or a third-party service. That is another process to deploy and another thing that can fail during an oral examination.
- **RLS on every read.** Each poll is an ordinary request through `withUser`, so row level security re-checks access on every refresh. A rider removed from a ride stops seeing it on the next poll. A socket would need its own authorisation logic, kept in step with the database.
- **Survives flaky networks.** A rider on a mountain road loses signal often. A missed poll simply returns fresh state on the next one, with no reconnect or resync protocol.
- **Cheap at this scale.** A ride has a handful of participants. Polling costs a few small indexed queries every five seconds per rider.

The trade-off is up to five seconds of latency on the map and some redundant requests. That is acceptable for group riding, and an upgrade to Server-Sent Events would not change the database design.

## 3. Why the alert is a trigger

`trg_generate_sos` (`db/05_triggers.sql`) is an `AFTER INSERT` trigger on `accident_event`, guarded by `WHEN (NEW.is_confirmed)`. It inserts the single `sos_alert` and one `alert_recipient` row for each of these:

- every co-rider who joined the ride and has not left it,
- every emergency contact of the affected rider,
- every authority whose `radius_km` around (`base_latitude`, `base_longitude`) covers the accident point.

Why this is a trigger rather than application code:

- **Atomicity.** The alert and its whole fan-out are created in the same transaction as the accident row. Suppose the app wrote the accident first and the alert second. A crash, timeout or deploy between the two writes would leave a rider recorded as crashed with nobody notified. With the trigger, either both commit or neither does.
- **No path can skip it.** Any client that inserts a confirmed accident gets the alert: the API, `psql`, the seed script or a future mobile client. No caller has to remember to do it.
- **Exactly one alert.** `uq_sos_alert_event` (UNIQUE on `sos_alert.event_id`) makes a second alert for the same accident impossible, even under retries.
- **The app role cannot fake an alert.** `bykr_app` has no `INSERT` policy on `sos_alert` or `alert_recipient`. The trigger function is `SECURITY DEFINER`, so it is the only way an alert can be created.
- **A cancelled countdown is still recorded.** If the rider cancels within thirty seconds, the accident is inserted with `is_confirmed = false`. The `WHEN` clause skips the trigger, and the event remains as evidence with no alert.

Delivery is a separate step. `sp_dispatch_alert` marks each recipient's outcome and writes the append-only `alert_audit`. Co-riders are notified in the app (`DELIVERED`). Emergency contacts and authorities get `MANUAL_ACTION_REQUIRED` and are shown for a human to act on. **bykr never contacts a real emergency service.**

## 4. Two databases

| | PostgreSQL 16 + pgvector | MongoDB 7 |
|---|---|---|
| Holds | users, roles, permissions, friendships, rides, participants, statuses, accidents, alerts, recipients, contacts, authorities, ride summaries + 96-d route embeddings | `location_pings`, `motion_samples` |
| Why | foreign keys, CHECK constraints, RLS, triggers, transactions | ~1 write per rider every 5 s, append-only, queried geospatially (`2dsphere`), expired automatically by a 30-day TTL index |
| Bridge | `ride_participant.participant_id` and `accident_event.motion_sample_id` (a Mongo ObjectId) | each ping carries `rideId` and `participantId` |

When a ride ends, its pings are downsampled into `ride_waypoint`. `sp_end_ride` then computes `ride_summary` in SQL, and `lib/vector` builds the deterministic route embedding. No external model or network call is involved. See `docs/vector-design.md` and `docs/technology-justification.md`.
