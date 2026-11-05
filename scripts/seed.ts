/**
 * bykr seed: one command from empty databases to a demo-ready system.
 *
 *   npm run seed
 *
 *   1. PostgreSQL: applies db/01..05 (schema, RLS, functions, procedures,
 *      triggers) and db/08_seed.sql, as the superuser.
 *   2. MongoDB: clears telemetry, ensures indexes, then generates plausible
 *      ping tracks: each ride follows real road anchor points around Pune,
 *      Lonavala, Mahabaleshwar and the Raigad coast, with a speed profile per
 *      road type (expressway, old highway, ghat, city, coast), and stops
 *      exactly where the leader's status history says the group stopped.
 *      Random points would make the recommendations look broken.
 *   3. Motion-sample evidence documents for each accident event.
 *   4. Ends every historical ride through finalizeRide(): the same
 *      waypoints -> sp_end_ride -> embedding path as the "End ride" button,
 *      then tags segments in MongoDB (updateMany).
 */
// Must stay the first import: creates .env.local on a fresh clone and loads it.
import "./ensure-env";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import "../lib/db"; // registers NUMERIC/BIGINT -> number type parsers
import { ensureIndexes, pings, motionSamples } from "../lib/mongo/collections";
import { insertPingsBulk, insertMotionSample, tagRideSegments, type PingInput } from "../lib/mongo/telemetry";
import { closeMongo } from "../lib/mongo/client";
import { finalizeRide } from "../lib/vector/finalize";
import { haversineKm, offsetMetres, type LatLon } from "../lib/geo";

const SQL_FILES = ["01_schema.sql", "02_rbac.sql", "03_functions.sql", "04_procedures.sql", "05_triggers.sql", "08_seed.sql"];
const PING_INTERVAL_S = 5;

// ---------------------------------------------------------------------------
// Routes: real road anchor points, keyed by ride title.
// ---------------------------------------------------------------------------
type RoadType = "expressway" | "highway" | "ghat" | "city" | "coastal";

const ROAD: Record<RoadType, { speed: number; spread: number; wiggleM: number; wavelengthM: number }> = {
  expressway: { speed: 82, spread: 8, wiggleM: 25, wavelengthM: 3000 },
  highway: { speed: 55, spread: 9, wiggleM: 70, wavelengthM: 1500 },
  ghat: { speed: 32, spread: 7, wiggleM: 170, wavelengthM: 650 },
  city: { speed: 26, spread: 8, wiggleM: 15, wavelengthM: 800 },
  coastal: { speed: 45, spread: 8, wiggleM: 90, wavelengthM: 1200 },
};

const P = (lat: number, lon: number): LatLon => ({ lat, lon });

const ROUTES: Record<string, { road: RoadType; anchors: LatLon[] }> = {
  "Expressway sunrise run": { road: "expressway", anchors: [P(18.6298, 73.7997), P(18.6600, 73.7100), P(18.7350, 73.6750), P(18.7420, 73.5300), P(18.7546, 73.4062)] },
  "Old highway to Khandala": { road: "highway", anchors: [P(18.5793, 73.8143), P(18.6500, 73.7600), P(18.7200, 73.6700), P(18.7700, 73.4900), P(18.7600, 73.3800)] },
  "Panvel to Pune express dash": { road: "expressway", anchors: [P(18.9894, 73.1175), P(18.8800, 73.2700), P(18.7900, 73.3500), P(18.7546, 73.4062), P(18.7000, 73.6600), P(18.6298, 73.7997), P(18.5204, 73.8567)] },
  "Sinhagad ghat loop": { road: "ghat", anchors: [P(18.5074, 73.8077), P(18.4400, 73.7900), P(18.3660, 73.7559), P(18.3900, 73.7000), P(18.4500, 73.7400), P(18.5074, 73.8077)] },
  "Mahabaleshwar twisties": { road: "ghat", anchors: [P(17.9524, 73.8908), P(17.9400, 73.8450), P(17.9250, 73.8000), P(17.9300, 73.7400), P(17.9237, 73.6586)] },
  "Bhimashankar forest climb": { road: "ghat", anchors: [P(18.8600, 73.8900), P(18.9500, 73.8000), P(19.0300, 73.7000), P(19.0721, 73.5352)] },
  "Pune city night loop": { road: "city", anchors: [P(18.5204, 73.8567), P(18.5300, 73.8800), P(18.5150, 73.9000), P(18.4950, 73.8800), P(18.5000, 73.8450), P(18.5204, 73.8567)] },
  "Alibaug coastal ride": { road: "coastal", anchors: [P(18.7378, 73.0960), P(18.6900, 72.9900), P(18.6414, 72.8722), P(18.5500, 72.9100), P(18.4386, 72.9047)] },
  "Lavasa lake ride": { road: "ghat", anchors: [P(18.5074, 73.8077), P(18.4700, 73.7000), P(18.4300, 73.5800), P(18.4100, 73.5050)] },
  "Tamhini ghat monsoon ride": { road: "ghat", anchors: [P(18.5074, 73.8077), P(18.4800, 73.7000), P(18.4500, 73.5500), P(18.4400, 73.4300)] },
  "Weekend breakfast run": { road: "city", anchors: [P(18.5204, 73.8567), P(18.5600, 73.9100), P(18.6000, 73.9800), P(18.6400, 74.0500), P(18.6800, 74.1200)] },
};

// Deterministic PRNG (mulberry32) so every seed run produces the same data.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Densify anchors into a ~25 m polyline with a sinusoidal lateral wiggle (bends). */
function buildPath(anchors: LatLon[], road: RoadType): LatLon[] {
  const { wiggleM, wavelengthM } = ROAD[road];
  const out: LatLon[] = [];
  let s = 0; // metres along the path
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    const legM = haversineKm(a, b) * 1000;
    const steps = Math.max(1, Math.round(legM / 25));
    // unit vector of the leg in (north, east) metres
    const n = (b.lat - a.lat) * 111_320;
    const e = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
    const len = Math.hypot(n, e) || 1;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const base = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
      // taper the wiggle to zero at anchors so legs join cleanly
      const taper = Math.sin(Math.PI * t);
      const lateral = wiggleM * taper * Math.sin((2 * Math.PI * s) / wavelengthM);
      out.push(offsetMetres(base, (-e / len) * lateral, (n / len) * lateral));
      s += legM / steps;
    }
  }
  out.push(anchors[anchors.length - 1]);
  return out;
}

type Sample = { pos: LatLon; speed: number; at: Date };

/** Walk the path in 5-second ticks, stopping inside the given windows. */
function simulate(
  path: LatLon[],
  road: RoadType,
  start: Date,
  stops: { from: Date; to: Date }[],
  until: Date | null,
  seed: number,
): Sample[] {
  const R = ROAD[road];
  const rand = rng(seed);
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversineKm(path[i - 1], path[i]));
  const total = cum[cum.length - 1];
  const at = (km: number): LatLon => {
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < km) lo = mid + 1; else hi = mid; }
    const j = Math.max(1, lo);
    const seg = cum[j] - cum[j - 1] || 1;
    const t = Math.min(1, Math.max(0, (km - cum[j - 1]) / seg));
    return { lat: path[j - 1].lat + (path[j].lat - path[j - 1].lat) * t, lon: path[j - 1].lon + (path[j].lon - path[j - 1].lon) * t };
  };

  const out: Sample[] = [];
  let km = 0;
  let tick = 0;
  let trafficUntil = -1;
  let nextLightKm = 1.2;
  for (;;) {
    const now = new Date(start.getTime() + tick * PING_INTERVAL_S * 1000);
    if (until && now > until) break;
    if (km >= total) break;
    if (tick > 12 * 3600 / PING_INTERVAL_S) break;

    let speed: number;
    const inStop = stops.some((w) => now >= w.from && now < w.to);
    if (inStop || tick < trafficUntil) {
      speed = 0;
    } else if (road === "city" && km >= nextLightKm) {
      trafficUntil = tick + 6 + Math.floor(rand() * 6); // 30–55 s at a signal
      nextLightKm = km + 1.0 + rand() * 0.8;
      speed = 0;
    } else {
      const wave = Math.sin(tick / 37) * 0.6 + Math.sin(tick / 11) * 0.4;
      speed = Math.max(8, R.speed + R.spread * wave + (rand() - 0.5) * R.spread);
    }
    out.push({ pos: at(km), speed: Math.round(speed * 10) / 10, at: now });
    km += (speed * PING_INTERVAL_S) / 3600;
    tick++;
  }
  return out;
}

// ---------------------------------------------------------------------------
async function main() {
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/bykr";
  const pg = new Client({ connectionString: adminUrl });
  await pg.connect();
  await pg.query("SET client_min_messages = warning");

  console.log("PostgreSQL");
  for (const f of SQL_FILES) {
    await pg.query(readFileSync(join(process.cwd(), "db", f), "utf8"));
    console.log(`  applied db/${f}`);
  }

  console.log("MongoDB");
  await ensureIndexes();
  await (await pings()).deleteMany({});
  await (await motionSamples()).deleteMany({});
  console.log("  cleared location_pings and motion_samples; indexes ensured");

  const { rows: rides } = await pg.query<{
    ride_id: number; ride_title: string; ride_state: string; started_at: Date | null; historical: boolean;
  }>(`SELECT ride_id, ride_title, ride_state, started_at,
             started_at < now() - interval '1 day' AS historical
        FROM ride WHERE ride_state = 'ACTIVE' ORDER BY ride_id`);

  let totalPings = 0;
  for (const ride of rides) {
    const route = ROUTES[ride.ride_title];
    if (!route || !ride.started_at) continue;

    const { rows: parts } = await pg.query<{ participant_id: number; user_id: number; is_leader: boolean }>(
      `SELECT participant_id, user_id, is_leader FROM ride_participant
        WHERE ride_id = $1 AND joined_at IS NOT NULL
        ORDER BY is_leader DESC, participant_id`,
      [ride.ride_id],
    );
    // The leader's REFUELLING / EATING / STOPPED windows become real stops.
    const { rows: stopRows } = await pg.query<{ set_at: Date; cleared_at: Date | null }>(
      `SELECT rs.set_at, rs.cleared_at
         FROM rider_status rs
         JOIN status_type t ON t.type_id = rs.type_id
        WHERE rs.participant_id = $1 AND t.status_label IN ('REFUELLING','EATING','STOPPED')`,
      [parts[0].participant_id],
    );
    const stops = stopRows.map((r) => ({ from: r.set_at, to: r.cleared_at ?? new Date(8.64e15) }));

    const path = buildPath(route.anchors, route.road);
    const until = ride.historical ? null : new Date();
    const leader = simulate(path, route.road, ride.started_at, stops, until, ride.ride_id * 7919);

    // Everyone follows the leader's line a few seconds behind, offset a few
    // metres laterally, with GPS noise.
    const batch: PingInput[] = [];
    parts.forEach((p, idx) => {
      const rand = rng(ride.ride_id * 1000 + p.user_id);
      const lagTicks = idx * 3; // 15 s per position in the group
      const sideM = idx === 0 ? 0 : (idx % 2 ? 1 : -1) * (2 + idx * 2);
      for (let i = 0; i < leader.length; i++) {
        const src = leader[Math.max(0, i - lagTicks)];
        const pos = offsetMetres(src.pos, (rand() - 0.5) * 6, sideM + (rand() - 0.5) * 6);
        batch.push({
          participantId: p.participant_id,
          rideId: ride.ride_id,
          userId: p.user_id,
          lat: pos.lat,
          lon: pos.lon,
          speedKmph: src.speed === 0 ? 0 : Math.round((src.speed + (rand() - 0.5) * 4) * 10) / 10,
          accuracyM: Math.round((4 + rand() * 8) * 10) / 10,
          recordedAt: leader[i].at,
        });
      }
    });
    for (let i = 0; i < batch.length; i += 5000) await insertPingsBulk(batch.slice(i, i + 5000));
    totalPings += batch.length;
    console.log(`  ride ${String(ride.ride_id).padStart(2)} ${ride.ride_title.padEnd(30)} ${route.road.padEnd(10)} ${parts.length} riders, ${batch.length} pings${ride.historical ? "" : "  (live)"}`);
  }
  console.log(`  ${totalPings} location pings inserted`);

  // Motion evidence for each accident (50 Hz window around the impact).
  const { rows: accidents } = await pg.query<{ event_id: number; participant_id: number; ride_id: number; impact_force: number; detected_at: Date }>(
    `SELECT e.event_id, e.participant_id, rp.ride_id, e.impact_force, e.detected_at
       FROM accident_event e JOIN ride_participant rp ON rp.participant_id = e.participant_id`,
  );
  for (const a of accidents) {
    const rand = rng(a.event_id * 31);
    const samples = Array.from({ length: 150 }, (_, i) => {
      const t = i * 20;
      const g = i < 50 ? 1 + (rand() - 0.5) * 0.4 : i < 56 ? a.impact_force * (1 - (i - 50) / 8) : 1 + (rand() - 0.5) * 0.02;
      return { t, x: +(g * 9.81 * 0.6).toFixed(2), y: +(g * 9.81 * 0.3).toFixed(2), z: +(g * 9.81 * 0.74).toFixed(2) };
    });
    const id = await insertMotionSample({
      participantId: a.participant_id,
      rideId: a.ride_id,
      samples,
      peakMagnitudeG: a.impact_force,
      capturedAt: a.detected_at,
      eventId: a.event_id,
    });
    await pg.query("UPDATE accident_event SET motion_sample_id = $2 WHERE event_id = $1", [a.event_id, id]);
  }
  console.log(`  ${accidents.length} motion_samples evidence documents`);

  console.log("Ending historical rides (waypoints -> sp_end_ride -> embedding -> segment tags)");
  for (const ride of rides.filter((r) => r.historical)) {
    const { rows } = await pg.query<{ user_id: number }>(
      "SELECT user_id FROM ride_participant WHERE ride_id = $1 AND is_leader",
      [ride.ride_id],
    );
    await pg.query("BEGIN");
    const res = await finalizeRide(pg as never, ride.ride_id, rows[0].user_id);
    await pg.query("COMMIT");
    const seg = await tagRideSegments(ride.ride_id, res.leaderParticipantId);
    console.log(`  ride ${String(ride.ride_id).padStart(2)} completed: ${res.waypoints} waypoints, embedding ${res.embedded ? "stored" : "MISSING"}, ${seg.segments} segments`);
  }

  const { rows: counts } = await pg.query(`
    SELECT (SELECT count(*) FROM app_user) users,
           (SELECT count(*) FROM friendship) friendships,
           (SELECT count(*) FROM ride) rides,
           (SELECT count(*) FROM ride WHERE ride_state = 'COMPLETED') completed,
           (SELECT count(*) FROM accident_event) accidents,
           (SELECT count(*) FROM sos_alert) alerts,
           (SELECT count(*) FROM alert_recipient) recipients,
           (SELECT count(*) FROM ride_summary WHERE route_embedding IS NOT NULL) embeddings`);
  console.log("Done:", counts[0]);
  console.log("Sign in as any of aarav|isha|rohan|meera|kabir|ananya|vikram|sana|admin @bykr.local, password bykr-demo-123");

  await pg.end();
  await closeMongo();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
