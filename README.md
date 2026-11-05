# bykr

**bykr** is a web app for groups who ride motorcycles together. It is a Database Management Systems mini-project, so the interface is small and most of the logic lives in the databases.

- **Live ride tracking.** A rider creates a ride and invites friends. While the ride is active, each participant's browser reports its position every five seconds, and everyone sees everyone else on one shared Leaflet map.
- **Status broadcasting.** A participant sets a status: refuelling, eating, delayed, riding or stopped. It appears against their marker and stays in the ride history with set and cleared times.
- **Accident detection and alerting.** A sudden impact, followed by no movement, starts a 30-second countdown. You can also trigger it with a "simulate impact" button. If the rider does not cancel, a database trigger creates exactly one SOS alert. It fans out to every co-rider, every emergency contact and every authority covering the location, and records a delivery outcome for each recipient. **bykr never contacts a real emergency service.** Authority records are displayed for a human to act on.
- **"Rides like this one" / "Recommended for you".** Each ride gets a deterministic 96-dimensional route embedding. Similar rides are found with pgvector cosine search. No external model or API key is involved.

## Two databases, on purpose

| PostgreSQL 16 + pgvector | MongoDB 7 |
|---|---|
| Everything that needs relational integrity: users, roles, permissions, friendships, rides, `ride_participant` (the hub), statuses, accident events, SOS alerts, alert recipients, emergency contacts, authorities, ride summaries and route embeddings. | High-volume telemetry: location pings and raw motion samples. |
| Foreign keys, named CHECK constraints, row level security, triggers, procedures, transactions. | About one write per rider every five seconds. Append-only, queried geospatially (`2dsphere`), expired automatically by a 30-day TTL index. |

All SQL is hand-written and run through `pg`, with no ORM. Access control is enforced **in PostgreSQL** with row level security keyed on `app.current_user_id`. See [docs/architecture.md](docs/architecture.md) for the request flow and design decisions, and [docs/technology-justification.md](docs/technology-justification.md) for the database split.

## Setup

Prerequisites: Docker and Node.js 20+. Four commands from a fresh clone to a running, seeded app:

```bash
docker compose up -d --wait
```

```bash
npm install
```

```bash
npm run seed
```

```bash
npm run dev
```

Open <http://localhost:3000>.

On a fresh clone, `npm run seed` first creates `.env.local` from `.env.example` with a newly generated random `AUTH_SECRET` (`scripts/ensure-env.ts`). It never overwrites an existing `.env.local`.

`npm run seed` resets both databases. It applies `db/01_schema.sql` → `05_triggers.sql` and `db/08_seed.sql` as the Postgres superuser, then generates route telemetry in MongoDB and ends each historical ride, which produces its summary and embedding.

### Demo logins

Every seeded user has the password **`bykr-demo-123`**.

| User | Email | Role |
|---|---|---|
| 1 | aarav@bykr.local | RIDER |
| 2 | isha@bykr.local | RIDER |
| 3 | rohan@bykr.local | RIDER |
| 4 | meera@bykr.local | RIDER |
| 5 | kabir@bykr.local | RIDER |
| 6 | ananya@bykr.local | RIDER |
| 7 | vikram@bykr.local | RIDER |
| 8 | sana@bykr.local | RIDER |
| 9 | **admin@bykr.local** | RIDER + **ADMIN** |

Sign in as two different riders to see row level security at work: each sees only the rides they take part in. The admin sees all rides, all accident events, the alert audit log and the showcase-query page.

## Database tests

The two gate tests are self-contained. Each builds its own fixture inside a transaction, asserts, and rolls back, so they do not disturb seeded data. Run them as the superuser after `npm run seed`. You do not need `psql` installed locally; the container's copy works:

```bash
docker exec -i bykr-postgres psql -U postgres -d bykr -v ON_ERROR_STOP=1 < db/tests/rls_test.sql
```

```bash
docker exec -i bykr-postgres psql -U postgres -d bykr -v ON_ERROR_STOP=1 < db/tests/trigger_test.sql
```

If you do have `psql`, use `psql "$DATABASE_ADMIN_URL" -f db/tests/rls_test.sql` (and the same for `trigger_test.sql`).

- **`rls_test.sql`**: a rider who is not a participant of a ride reads nothing from it. This is enforced by PostgreSQL policies, run as `bykr_app`. An admin reads everything.
- **`trigger_test.sql`**: a confirmed accident with 2 co-riders, 2 emergency contacts and 1 authority produces exactly 1 `sos_alert` and exactly 5 `alert_recipient` rows. A cancelled accident produces 0 alerts. It also checks `sp_dispatch_alert` and `sp_end_ride`.

Any failed assertion raises an error and stops the script with a non-zero exit code.

## Repository layout

```
docker-compose.yml   PostgreSQL 16 (pgvector) + MongoDB 7
db/                  01_schema … 08_seed, plus tests/
mongo/init.js        collections, validators, 2dsphere + TTL indexes
lib/db/              pg pool and withUser() (sets app.current_user_id per transaction)
lib/mongo/           collection accessors and the telemetry operations
lib/vector/          deterministic route embedding
lib/auth/, auth.ts   Auth.js v5 credentials provider, Argon2
app/                 Next.js App Router pages and app/api route handlers
scripts/seed.ts      applies the SQL and generates MongoDB routes
docs/                ER diagram, relational schema, architecture, design notes
```

## Documentation

- [docs/ER-diagram.png](docs/ER-diagram.png): Chen-notation ER diagram (source `docs/er-diagram.dot`)
- [docs/relational-schema.png](docs/relational-schema.png): every table, key and ON DELETE action (source `docs/relational-schema.dot`)
- [docs/architecture.md](docs/architecture.md): request flow, polling versus WebSockets, why the alert is a trigger
- [docs/technology-justification.md](docs/technology-justification.md)
- [docs/vector-design.md](docs/vector-design.md)
- [RUBRIC.md](RUBRIC.md): where each rubric item is satisfied

To re-render the diagrams (needs Graphviz):

```bash
dot -Tpng -Gdpi=130 docs/er-diagram.dot -o docs/ER-diagram.png && dot -Tpng -Gdpi=130 docs/relational-schema.dot -o docs/relational-schema.png
```
