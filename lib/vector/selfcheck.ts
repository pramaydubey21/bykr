/**
 * Self-check for the route embedding. Run with:
 *
 *   npx tsx lib/vector/selfcheck.ts
 *
 * Builds embeddings for three synthetic Maharashtra rides (a loop, a straight
 * highway, a zigzag ghat road), checks the invariants the feature depends on,
 * and prints pairwise cosine distances. Exits non-zero on any failure.
 * The only I/O is reading docs/vector-design.md to confirm its layout table
 * matches DIMENSION_LAYOUT.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  averageEmbeddings,
  buildRouteEmbedding,
  computeRouteMetrics,
  cosineDistance,
  countStops,
  dimensionLayoutMarkdown,
  DIMENSION_LAYOUT,
  EMBEDDING_DIM,
  fromPgVector,
  haversineKm,
  resamplePath,
  SHAPE_DIMS,
  toPgVector,
  type Ping,
  type RideStats,
} from "./index";

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}

/** Turns a list of [lat, lon] waypoints into pings every 5 s at a given speed profile. */
function makeRide(
  waypoints: [number, number][],
  start: Date,
  speedAt: (i: number, n: number) => number,
): Ping[] {
  const pings: Ping[] = [];
  let t = start.getTime();
  for (let i = 0; i < waypoints.length; i++) {
    const speed = speedAt(i, waypoints.length);
    if (i > 0) {
      const d = haversineKm(
        { lat: waypoints[i - 1][0], lon: waypoints[i - 1][1] },
        { lat: waypoints[i][0], lon: waypoints[i][1] },
      );
      t += speed > 1 ? (d / speed) * 3600 * 1000 : 5000;
    }
    pings.push({ lat: waypoints[i][0], lon: waypoints[i][1], speedKmph: speed, recordedAt: new Date(t) });
  }
  return pings;
}

// 1. Loop around Pune: ~12 km radius circle, Sunday 06:30 IST, gentle steady speed.
const loopPts: [number, number][] = Array.from({ length: 400 }, (_, i) => {
  const a = (2 * Math.PI * i) / 399;
  return [18.52 + 0.108 * Math.sin(a), 73.85 + 0.114 * Math.cos(a)];
});
const loop = makeRide(loopPts, new Date("2026-11-01T01:00:00Z"), () => 35);
const loopStats: RideStats = { statusChanges: 4, statusCounts: { RIDING: 2, EATING: 1, STOPPED: 1 }, stopCount: 1 };

// 2. Straight highway Pune → Mumbai (~120 km), Wednesday 14:00 IST, fast.
const hwyPts: [number, number][] = Array.from({ length: 600 }, (_, i) => {
  const t = i / 599;
  return [18.52 + t * (19.07 - 18.52), 73.85 + t * (72.88 - 73.85)];
});
const highway = makeRide(hwyPts, new Date("2026-11-04T08:30:00Z"), (i) => 85 + 15 * Math.sin(i / 20));
const hwyStats: RideStats = { statusChanges: 3, statusCounts: { RIDING: 2, REFUELLING: 1 }, stopCount: 1 };

// 3. Zigzag ghat road near Lonavala: switchbacks descending ~15 km, Saturday 17:00 IST, slow and variable.
const ghatPts: [number, number][] = [];
for (let leg = 0; leg < 12; leg++) {
  for (let k = 0; k < 30; k++) {
    const t = k / 30;
    const east = leg % 2 === 0 ? t : 1 - t;
    ghatPts.push([18.75 - (leg + t) * 0.01, 73.40 + east * 0.03]);
  }
}
const ghat = makeRide(ghatPts, new Date("2026-10-31T11:30:00Z"), (i) => (i % 30 < 3 ? 2 : 20 + (i % 7) * 4));
const ghatStats: RideStats = {
  statusChanges: 9,
  statusCounts: { RIDING: 3, DELAYED: 2, STOPPED: 3, EATING: 1 },
  stopCount: countStops(ghat),
};

const rides = { loop, highway, ghat } as const;
const embeddings = {
  loop: buildRouteEmbedding(loop, loopStats),
  highway: buildRouteEmbedding(highway, hwyStats),
  ghat: buildRouteEmbedding(ghat, ghatStats),
};

console.log("== Lengths and ranges");
for (const [name, v] of Object.entries(embeddings)) {
  check(v.length === EMBEDDING_DIM, `${name}: length ${v.length} === 96`);
  check(v.slice(0, SHAPE_DIMS).every((x) => x >= -0.5 - 1e-12 && x <= 0.5 + 1e-12), `${name}: shape dims in [-0.5, 0.5]`);
  check(v.slice(SHAPE_DIMS).every((x) => x >= 0 && x <= 1), `${name}: character dims in [0, 1]`);
  check(v.slice(85).every((x) => x === 0), `${name}: padding dims 86–96 are zero`);
}
check(DIMENSION_LAYOUT.length === EMBEDDING_DIM, "DIMENSION_LAYOUT describes 96 indices");

console.log("\n== Route metrics");
for (const [name, p] of Object.entries(rides)) {
  const m = computeRouteMetrics(p);
  console.log(
    `${name.padEnd(8)} ${m.distanceKm.toFixed(1).padStart(6)} km  ${m.durationMin.toFixed(0).padStart(4)} min  ` +
      `avg ${m.avgSpeedKmph.toFixed(1).padStart(5)}  max ${m.maxSpeedKmph.toFixed(1).padStart(5)}  ` +
      `straight ${m.straightnessRatio.toFixed(3)}  diag ${m.bboxDiagonalKm.toFixed(1)} km`,
  );
}

console.log("\n== Pairwise cosine distances (full vector)");
const pairs: [keyof typeof embeddings, keyof typeof embeddings][] = [
  ["loop", "highway"],
  ["loop", "ghat"],
  ["highway", "ghat"],
];
const dists = pairs.map(([a, b]) => {
  const d = cosineDistance(embeddings[a], embeddings[b]);
  console.log(`  ${a.padEnd(8)} vs ${b.padEnd(8)} ${d.toFixed(4)}`);
  return d;
});
check(dists.every((d) => d > 0.1), "every pair is clearly apart (distance > 0.1)");
const sorted = [...dists].sort((x, y) => x - y);
check(sorted[1] - sorted[0] > 0.02 && sorted[2] - sorted[1] > 0.02, "the three distances differ from one another");
for (const k of Object.keys(embeddings) as (keyof typeof embeddings)[]) {
  check(cosineDistance(embeddings[k], embeddings[k]) < 1e-12, `${k} vs itself is 0`);
}

console.log("\n== Scale invariance of the shape block");
// The same loop shape at 1/10 the size (and elsewhere in the region) must have the same shape dims.
const smallLoop = makeRide(
  loopPts.map(([la, lo]) => [19.0 + (la - 18.52) / 10, 73.0 + (lo - 73.85) / 10]),
  new Date("2026-11-01T01:00:00Z"),
  () => 25,
);
const smallV = buildRouteEmbedding(smallLoop, loopStats);
const shapeDist = cosineDistance(embeddings.loop.slice(0, SHAPE_DIMS), smallV.slice(0, SHAPE_DIMS));
console.log(`  shape-only distance, 12 km loop vs 1.2 km loop: ${shapeDist.toExponential(2)}`);
check(shapeDist < 1e-3, "10x smaller loop has (near) identical shape dims");
check(cosineDistance(embeddings.loop, smallV) > 1e-3, "…but the character dims still tell them apart");

console.log("\n== Degenerate inputs");
const p0 = new Date("2026-11-01T00:00:00Z");
const empty = buildRouteEmbedding([], { statusChanges: 0, statusCounts: {}, stopCount: 0 });
check(empty.length === 96 && empty.every(Number.isFinite), "0 pings -> 96 finite values");
const one = buildRouteEmbedding([{ lat: 18.5, lon: 73.8, speedKmph: 0, recordedAt: p0 }], loopStats);
check(one.length === 96 && one.slice(0, 64).every((x) => x === 0), "1 ping -> zero shape block");
const dup = Array.from({ length: 10 }, (_, i) => ({ lat: 18.5, lon: 73.8, speedKmph: 0, recordedAt: new Date(p0.getTime() + i * 5000) }));
check(buildRouteEmbedding(dup, loopStats).every(Number.isFinite), "all-duplicate pings -> finite");
const withDups = resamplePath([{ lat: 18, lon: 73 }, { lat: 18, lon: 73 }, { lat: 18.1, lon: 73 }, { lat: 18.1, lon: 73 }]);
check(withDups.length === 32 && Math.abs(withDups[16].lat - 18.0516) < 1e-3, "duplicates skipped; 32 points evenly spaced");
const shuffled = [...highway].reverse();
check(cosineDistance(buildRouteEmbedding(shuffled, hwyStats), embeddings.highway) < 1e-12, "ping order is normalised by recordedAt");
check(JSON.stringify(buildRouteEmbedding(loop, loopStats)) === JSON.stringify(embeddings.loop), "deterministic: same input, same vector");

console.log("\n== pgvector serialisation and averaging");
const text = toPgVector(embeddings.ghat);
check(text.startsWith("[") && text.endsWith("]") && fromPgVector(text).length === 96, "toPgVector -> \"[...]\" with 96 components");
check(cosineDistance(fromPgVector(text), embeddings.ghat) < 1e-9, "round-trip through text preserves direction");
const riderA = averageEmbeddings([embeddings.loop, embeddings.ghat])!;
const riderB = averageEmbeddings([embeddings.highway])!;
check(averageEmbeddings([]) === null, "averageEmbeddings([]) is null");
check(cosineDistance(riderA, riderB) > 0.1, "two riders with different histories get different taste vectors");
const nearestFor = (taste: number[]) =>
  (Object.keys(embeddings) as (keyof typeof embeddings)[]).sort(
    (x, y) => cosineDistance(taste, embeddings[x]) - cosineDistance(taste, embeddings[y]),
  )[0];
console.log(`  rider A vs rider B taste distance: ${cosineDistance(riderA, riderB).toFixed(4)}`);
console.log(`  rider A (loop+ghat) nearest: ${nearestFor(riderA)}; rider B (highway) nearest: ${nearestFor(riderB)}`);

console.log("\n== Documentation in sync");
const docPath = join(process.cwd(), "docs", "vector-design.md");
if (existsSync(docPath)) {
  check(readFileSync(docPath, "utf8").includes(dimensionLayoutMarkdown()), "docs/vector-design.md contains the current DIMENSION_LAYOUT table");
} else {
  console.log("SKIP  docs/vector-design.md not found (run from the repo root)");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
