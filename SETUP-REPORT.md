# Setup report — phase zero

Date: 2026-11-05. Machine prepared for the bykr build. No project code was written; `docker-compose.yml` was not created; `README-FIRST.md` and `BYKR_ClaudeCode_Prompt.md` were not read.

## Environment

| Item | Value |
|---|---|
| Operating system | macOS 27.0.1 (build 26A434) |
| Architecture | arm64 (Apple Silicon) |
| Windows Subsystem for Linux | No — native macOS |
| Administrator rights | User is in the `admin` group; `sudo` requires a password (never used) |
| Package manager | Homebrew (`/opt/homebrew/bin/brew`) |
| Free disk space | 41 GiB free of 228 GiB (80% used) |
| `node` | v24.9.0 (already present) |
| `npm` | 11.6.0 (already present) |
| `git` | 2.54.0 (Apple Git-157) (already present) |
| `docker` | 29.9.2, build a82e528 — Docker Desktop, installed by the user; server aarch64 |
| `docker compose` | v5.6.1 |
| `psql` | 16.15 (Homebrew) — **installed this phase** via `brew install postgresql@16` |
| `mongosh` | 2.5.9 (already present) |

`psql` is keg-only and not on `PATH`. Call it as `/opt/homebrew/opt/postgresql@16/bin/psql`, or add `/opt/homebrew/opt/postgresql@16/bin` to your shell `PATH` yourself (I did not edit shell profiles).

## Images

| Image | Digest |
|---|---|
| `pgvector/pgvector:pg16` | `sha256:0dd3149a06e4579a0d70d8fef9945636cd514005e7237deb27f9b67886f8dc4f` |
| `mongo:7` | `sha256:8bb4442761a63a8dda452744082cdac9644b429807eb977b42324a63cef59ca4` |

## Smoke tests

Both ran in throwaway containers on non-default host ports (55432, 57017), and both containers were removed with `docker rm -f -v` afterwards. `docker ps -a` shows no leftovers.

| Test | Result |
|---|---|
| PostgreSQL: container starts, host `psql` connects | Pass — `PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2) on aarch64-unknown-linux-gnu` |
| PostgreSQL: `CREATE EXTENSION vector;` | Pass — pgvector `0.8.7` |
| PostgreSQL: `vector(3)` table, insert, `<=>` nearest-neighbour | Pass — output below |
| MongoDB: container starts, host `mongosh` connects | Pass — server `7.0.45` |
| MongoDB: insert GeoJSON `Point` | Pass — `acknowledged: true` |
| MongoDB: `2dsphere` index + `$near` | Pass — index `loc_2dsphere`; output below |
| Node toolchain: `npx create-next-app@latest` (TypeScript, App Router, Tailwind) in a temp dir outside this folder | Pass — scaffolded, `tsc --noEmit` clean, then deleted |

### Vector query output

```
SELECT id, label, v, v <=> '[0.9,0.1,0]' AS cosine_distance
FROM smoke ORDER BY v <=> '[0.9,0.1,0]' LIMIT 2;

 id | label |    v    |   cosine_distance
----+-------+---------+----------------------
  1 | east  | [1,0,0] | 0.006116251198662548
  2 | north | [0,1,0] |   0.8895684677844125
(2 rows)
```

### `$near` query output

Two points inserted (India Gate, Delhi; Gateway of India, Mumbai). Query near `[77.21, 28.61]` with `$maxDistance: 5000` m:

```
$near result: [{"name":"India Gate","loc":{"type":"Point","coordinates":[77.2295,28.6129]}}]
```

Mumbai, about 1,100 km away, is correctly excluded.

## Things that need attention before the build

1. **`create-next-app@latest` now produces Next.js 16** (`next 16.4.5`, `react 19.3.0`). The project stack is fixed at **Next.js 15**. When the build scaffolds, use `npx create-next-app@15` or pin `"next": "^15"` in `package.json`.
2. **A native MongoDB server is already listening on `127.0.0.1:27017`** (`mongod`, Homebrew `mongodb-community@8.0`, not managed by `brew services`). The `mongo:7` container cannot bind host port 27017 while it runs. Either stop it before `docker compose up`, or have the compose file map MongoDB to another host port.
3. Homebrew's `postgresql@16` also created a local cluster at `/opt/homebrew/var/postgresql@16`. It is **not running** and port 5432 is free. Do not start it (`brew services start postgresql@16`), or it will take port 5432 away from the pgvector container.

## Nothing failed to install

All required software is present. Docker Desktop was installed by the user (it is a graphical installer).

## Commands run with administrator rights

None. No `sudo` was used. `brew install postgresql@16` runs as the normal user.
