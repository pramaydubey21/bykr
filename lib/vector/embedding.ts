/**
 * Deterministic 96-dimensional route embedding.
 *
 *   dims  1–64  route shape: 32 equal-distance resampled points, normalised to
 *                the route's bounding box and centred, flattened [x0,y0,x1,y1,…]
 *   dims 65–85  route character: scalars min-max normalised against FIXED
 *                reference ranges (REFERENCE_RANGES), clamped to [0, 1]
 *   dims 86–96  zero padding
 *
 * Pure function of its inputs: no I/O, no network, no model, no randomness.
 * The same pings and stats always produce the same vector.
 * See docs/vector-design.md for the reasoning behind every choice.
 */
import { haversineKm, pathLengthKm, RESAMPLE_POINTS, resamplePath, sortPings, type LatLon } from "./resample";
import {
  STATUS_LABELS,
  type DimensionInfo,
  type Ping,
  type RideStats,
  type RouteMetrics,
  type StatusLabel,
} from "./types";

// Re-exported for callers that import the status labels from this module.
export { STATUS_LABELS, type StatusLabel };

export const EMBEDDING_DIM = 96;
export const SHAPE_DIMS = RESAMPLE_POINTS * 2; // 64

/** Kilometres per degree, used for a local equirectangular projection. */
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

/** Rides are in Maharashtra; hour-of-day and day-of-week are taken in IST (UTC+05:30, no DST). */
export const RIDE_TIMEZONE_OFFSET_MIN = 330;

/** Operating region (Pune / Mumbai / Lonavala) used to normalise the start coordinate. */
export const OPERATING_REGION = { latMin: 17.5, latMax: 20.5, lonMin: 72.5, lonMax: 75.5 } as const;

/** A ping slower than this counts as stationary for countStops(). */
export const STOP_SPEED_KMPH = 3;
/** A stationary spell must last this long to count as a stop. */
export const STOP_MIN_DURATION_S = 60;

/**
 * Fixed reference ranges for min-max normalisation.
 *
 * These are deliberately constants, not the min/max of the current dataset:
 * an embedding stored today must still be comparable with one computed next
 * month, after more (and possibly longer) rides have been recorded. Values
 * outside the range are clamped to 0 or 1.
 */
export const REFERENCE_RANGES = {
  distanceKm: { min: 0, max: 400, unit: "km", note: "a long day ride, e.g. Pune–Kolhapur and back" },
  durationMin: { min: 0, max: 720, unit: "min", note: "12 hours" },
  avgSpeedKmph: { min: 0, max: 100, unit: "km/h", note: "moving + stopped time" },
  maxSpeedKmph: { min: 0, max: 160, unit: "km/h", note: "" },
  speedVariance: { min: 0, max: 1600, unit: "(km/h)²", note: "standard deviation up to 40 km/h" },
  stopCount: { min: 0, max: 30, unit: "stops", note: "" },
  statusChanges: { min: 0, max: 50, unit: "changes", note: "all participants" },
  statusCount: { min: 0, max: 20, unit: "rows", note: "per status label" },
  straightnessRatio: { min: 0, max: 1, unit: "ratio", note: "1 = perfectly straight" },
  bboxDiagonalKm: { min: 0, max: 300, unit: "km", note: "" },
  cyclic: { min: -1, max: 1, unit: "sin/cos", note: "mapped to [0, 1]" },
  startLat: { min: OPERATING_REGION.latMin, max: OPERATING_REGION.latMax, unit: "°N", note: "operating region" },
  startLon: { min: OPERATING_REGION.lonMin, max: OPERATING_REGION.lonMax, unit: "°E", note: "operating region" },
  elevation: { min: 0, max: 1, unit: "—", note: "not available, always 0" },
} as const;

type RangeKey = keyof typeof REFERENCE_RANGES;

/** Min-max normalise against a fixed range and clamp to [0, 1]. Non-finite input becomes 0. */
export function normalise(value: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return 0;
  const span = range.max - range.min;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (value - range.min) / span));
}

// ---------------------------------------------------------------------------
// Route metrics
// ---------------------------------------------------------------------------

/** Distance, duration, speed and geometry metrics from a ride's pings. */
export function computeRouteMetrics(pings: readonly Ping[]): RouteMetrics {
  const sorted = sortPings(pings);
  if (sorted.length === 0) {
    return {
      distanceKm: 0, durationMin: 0, avgSpeedKmph: 0, maxSpeedKmph: 0, speedVariance: 0,
      straightnessRatio: 0, bboxDiagonalKm: 0, startLat: 0, startLon: 0, endLat: 0, endLon: 0,
    };
  }
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const distanceKm = pathLengthKm(sorted);
  const durationMin = (last.recordedAt.getTime() - first.recordedAt.getTime()) / 60000;
  const avgSpeedKmph = durationMin > 0 ? distanceKm / (durationMin / 60) : 0;

  const speeds = sorted.map((p) => (Number.isFinite(p.speedKmph) ? Math.max(0, p.speedKmph) : 0));
  const meanSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const speedVariance = speeds.reduce((a, s) => a + (s - meanSpeed) ** 2, 0) / speeds.length;
  // ride_summary has CHECK (max_speed_kmph >= avg_speed_kmph); GPS speed can under-read,
  // so the maximum is never reported below the path-derived average.
  const maxSpeedKmph = Math.max(avgSpeedKmph, ...speeds);

  const direct = haversineKm(first, last);
  const straightnessRatio = distanceKm > 0 ? Math.min(1, direct / distanceKm) : 0;

  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const p of sorted) {
    latMin = Math.min(latMin, p.lat); latMax = Math.max(latMax, p.lat);
    lonMin = Math.min(lonMin, p.lon); lonMax = Math.max(lonMax, p.lon);
  }
  const bboxDiagonalKm = haversineKm({ lat: latMin, lon: lonMin }, { lat: latMax, lon: lonMax });

  return {
    distanceKm, durationMin, avgSpeedKmph, maxSpeedKmph, speedVariance, straightnessRatio, bboxDiagonalKm,
    startLat: first.lat, startLon: first.lon, endLat: last.lat, endLon: last.lon,
  };
}

/**
 * Counts stops: maximal runs of consecutive pings below STOP_SPEED_KMPH lasting
 * at least STOP_MIN_DURATION_S. Use this when the MongoDB aggregation's stop
 * count is not available.
 */
export function countStops(pings: readonly Ping[]): number {
  const sorted = sortPings(pings);
  let stops = 0;
  let runStart: Date | null = null;
  let counted = false;
  for (const p of sorted) {
    if (p.speedKmph < STOP_SPEED_KMPH) {
      if (runStart === null) { runStart = p.recordedAt; counted = false; }
      if (!counted && (p.recordedAt.getTime() - runStart.getTime()) / 1000 >= STOP_MIN_DURATION_S) {
        stops++;
        counted = true;
      }
    } else {
      runStart = null;
    }
  }
  return stops;
}

// ---------------------------------------------------------------------------
// Shape (dims 1–64)
// ---------------------------------------------------------------------------

/**
 * Projects the resampled points to a local plane in km, then scales both axes
 * by the LONGER side of the bounding box and centres on the box centre.
 *
 * Using one scale for both axes keeps the aspect ratio honest: a route that
 * runs 40 km north and 2 km east stays a thin vertical line instead of being
 * stretched into a square. The long axis spans exactly [-0.5, 0.5]; the short
 * axis spans a proportionally smaller interval centred on 0. A zero-size box
 * (single point / no movement) yields all zeros.
 */
export function shapeFeatures(points: readonly LatLon[]): number[] {
  if (points.length === 0) return new Array<number>(SHAPE_DIMS).fill(0);
  if (points.length !== RESAMPLE_POINTS) throw new RangeError(`shapeFeatures expects ${RESAMPLE_POINTS} points`);

  const lat0 = points.reduce((a, p) => a + p.lat, 0) / points.length;
  const kmPerDegLon = KM_PER_DEG_LON_EQUATOR * Math.cos((lat0 * Math.PI) / 180);
  const xs = points.map((p) => p.lon * kmPerDegLon);
  const ys = points.map((p) => p.lat * KM_PER_DEG_LAT);

  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const scale = Math.max(xMax - xMin, yMax - yMin);
  if (!(scale > 1e-9)) return new Array<number>(SHAPE_DIMS).fill(0);

  const cx = (xMin + xMax) / 2;
  const cy = (yMin + yMax) / 2;
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    out.push((xs[i] - cx) / scale, (ys[i] - cy) / scale);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Character (dims 65–96)
// ---------------------------------------------------------------------------

interface CharacterContext {
  m: RouteMetrics;
  stats: RideStats;
  start: Date;
  hasRoute: boolean;
}

interface CharacterFeature {
  name: string;
  description: string;
  value: (c: CharacterContext) => number;
}

const cyc = (v: number) => normalise(v, REFERENCE_RANGES.cyclic);

/** Fractional hour of day (0–24) and weekday (0 = Sunday) in the ride timezone. */
function localTime(d: Date): { hour: number; weekday: number } {
  const local = new Date(d.getTime() + RIDE_TIMEZONE_OFFSET_MIN * 60000);
  return {
    hour: local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600,
    weekday: local.getUTCDay(),
  };
}

const rangeDesc = (k: RangeKey): string => {
  const r = REFERENCE_RANGES[k];
  return `${r.min}–${r.max} ${r.unit}${r.note ? ` (${r.note})` : ""}`;
};

const statusFeature = (label: StatusLabel): CharacterFeature => ({
  name: `status_count_${label.toLowerCase()}`,
  description: `Number of ${label} statuses set; ${rangeDesc("statusCount")}`,
  value: (c) => normalise(c.stats.statusCounts[label] ?? 0, REFERENCE_RANGES.statusCount),
});

/** The ordered list of character features. DIMENSION_LAYOUT and the vector are both built from it. */
const CHARACTER_FEATURES: readonly CharacterFeature[] = [
  { name: "distance_km", description: `Path length; ${rangeDesc("distanceKm")}`,
    value: (c) => normalise(c.m.distanceKm, REFERENCE_RANGES.distanceKm) },
  { name: "duration_min", description: `First to last ping; ${rangeDesc("durationMin")}`,
    value: (c) => normalise(c.m.durationMin, REFERENCE_RANGES.durationMin) },
  { name: "avg_speed_kmph", description: `Distance / duration; ${rangeDesc("avgSpeedKmph")}`,
    value: (c) => normalise(c.m.avgSpeedKmph, REFERENCE_RANGES.avgSpeedKmph) },
  { name: "max_speed_kmph", description: `Highest ping speed; ${rangeDesc("maxSpeedKmph")}`,
    value: (c) => normalise(c.m.maxSpeedKmph, REFERENCE_RANGES.maxSpeedKmph) },
  { name: "speed_variance", description: `Population variance of ping speeds; ${rangeDesc("speedVariance")}`,
    value: (c) => normalise(c.m.speedVariance, REFERENCE_RANGES.speedVariance) },
  { name: "stop_count", description: `Stops during the ride; ${rangeDesc("stopCount")}`,
    value: (c) => normalise(c.stats.stopCount, REFERENCE_RANGES.stopCount) },
  { name: "status_changes", description: `Status updates during the ride; ${rangeDesc("statusChanges")}`,
    value: (c) => normalise(c.stats.statusChanges, REFERENCE_RANGES.statusChanges) },
  ...STATUS_LABELS.map(statusFeature),
  { name: "straightness_ratio", description: `Direct distance / path distance; ${rangeDesc("straightnessRatio")}`,
    value: (c) => normalise(c.m.straightnessRatio, REFERENCE_RANGES.straightnessRatio) },
  { name: "bbox_diagonal_km", description: `Bounding-box diagonal; ${rangeDesc("bboxDiagonalKm")}`,
    value: (c) => normalise(c.m.bboxDiagonalKm, REFERENCE_RANGES.bboxDiagonalKm) },
  { name: "start_hour_sin", description: "sin(2π·hour/24) of start time in IST, mapped to [0, 1]",
    value: (c) => cyc(Math.sin((2 * Math.PI * localTime(c.start).hour) / 24)) },
  { name: "start_hour_cos", description: "cos(2π·hour/24) of start time in IST, mapped to [0, 1]",
    value: (c) => cyc(Math.cos((2 * Math.PI * localTime(c.start).hour) / 24)) },
  { name: "day_of_week_sin", description: "sin(2π·weekday/7) of start date in IST (Sunday = 0), mapped to [0, 1]",
    value: (c) => cyc(Math.sin((2 * Math.PI * localTime(c.start).weekday) / 7)) },
  { name: "day_of_week_cos", description: "cos(2π·weekday/7) of start date in IST (Sunday = 0), mapped to [0, 1]",
    value: (c) => cyc(Math.cos((2 * Math.PI * localTime(c.start).weekday) / 7)) },
  { name: "start_lat", description: `Start latitude in the operating region; ${rangeDesc("startLat")}`,
    value: (c) => (c.hasRoute ? normalise(c.m.startLat, REFERENCE_RANGES.startLat) : 0) },
  { name: "start_lon", description: `Start longitude in the operating region; ${rangeDesc("startLon")}`,
    value: (c) => (c.hasRoute ? normalise(c.m.startLon, REFERENCE_RANGES.startLon) : 0) },
  { name: "elevation_proxy", description: "Reserved; pings carry no altitude, so always 0",
    value: () => 0 },
];

export const CHARACTER_DIMS = CHARACTER_FEATURES.length; // 21
export const PADDING_DIMS = EMBEDDING_DIM - SHAPE_DIMS - CHARACTER_DIMS; // 11
if (PADDING_DIMS < 0) throw new Error("embedding layout exceeds 96 dimensions");

/** Describes every one of the 96 indices. Source of truth for docs/vector-design.md and the admin page. */
export const DIMENSION_LAYOUT: readonly DimensionInfo[] = (() => {
  const out: DimensionInfo[] = [];
  for (let i = 0; i < RESAMPLE_POINTS; i++) {
    for (const axis of ["x", "y"] as const) {
      const index = out.length;
      out.push({
        index, dim: index + 1, group: "shape", name: `p${i}_${axis}`,
        description: `Resampled point ${i} (of 0–${RESAMPLE_POINTS - 1}), ${axis === "x" ? "east–west" : "north–south"} offset from box centre ÷ longer box side, in [-0.5, 0.5]`,
      });
    }
  }
  for (const f of CHARACTER_FEATURES) {
    const index = out.length;
    out.push({ index, dim: index + 1, group: "character", name: f.name, description: f.description });
  }
  while (out.length < EMBEDDING_DIM) {
    const index = out.length;
    out.push({ index, dim: index + 1, group: "padding", name: `pad_${index - SHAPE_DIMS - CHARACTER_DIMS}`, description: "Zero padding to reach 96" });
  }
  return Object.freeze(out);
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Builds the 96-dimensional route embedding for one completed ride. */
export function buildRouteEmbedding(pings: readonly Ping[], stats: RideStats): number[] {
  const sorted = sortPings(pings);
  const metrics = computeRouteMetrics(sorted);
  const resampled = resamplePath(sorted.map((p) => ({ lat: p.lat, lon: p.lon })), RESAMPLE_POINTS);
  const start = stats.startTime ?? sorted[0]?.recordedAt ?? new Date(0);
  const ctx: CharacterContext = { m: metrics, stats, start, hasRoute: sorted.length > 0 };

  const v = [
    ...shapeFeatures(resampled),
    ...CHARACTER_FEATURES.map((f) => f.value(ctx)),
    ...new Array<number>(PADDING_DIMS).fill(0),
  ];
  if (v.length !== EMBEDDING_DIM) throw new Error(`embedding length ${v.length}, expected ${EMBEDDING_DIM}`);
  return v.map((x) => (Number.isFinite(x) ? x : 0));
}

/**
 * Element-wise mean of several embeddings — the "taste" vector for
 * "Recommended for you". Returns null for an empty list (no ride history).
 */
export function averageEmbeddings(vs: readonly (readonly number[])[]): number[] | null {
  if (vs.length === 0) return null;
  const sum = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const v of vs) {
    if (v.length !== EMBEDDING_DIM) throw new RangeError(`averageEmbeddings: vector length ${v.length}, expected ${EMBEDDING_DIM}`);
    for (let i = 0; i < EMBEDDING_DIM; i++) sum[i] += v[i];
  }
  return sum.map((s) => s / vs.length);
}

/**
 * Serialises an embedding as pgvector text, e.g. "[0.1,-0.25,…]", for use as a
 * query parameter: `... $1::vector` or `INSERT ... VALUES ($1::vector)`.
 */
export function toPgVector(v: readonly number[]): string {
  if (v.length !== EMBEDDING_DIM) throw new RangeError(`toPgVector: length ${v.length}, expected ${EMBEDDING_DIM}`);
  return `[${v
    .map((x) => {
      if (!Number.isFinite(x)) throw new RangeError("toPgVector: non-finite component");
      return Number(x.toFixed(6)).toString();
    })
    .join(",")}]`;
}

/** Parses pgvector text ("[1,2,3]") as returned by node-postgres back into numbers. */
export function fromPgVector(text: string): number[] {
  const body = text.trim().replace(/^\[/, "").replace(/\]$/, "");
  return body === "" ? [] : body.split(",").map(Number);
}

/** Cosine distance (1 − cosine similarity), identical to pgvector's <=>. Zero vectors give NaN, like pgvector. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new RangeError("cosineDistance: length mismatch");
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Renders DIMENSION_LAYOUT as a Markdown table (used by docs/vector-design.md; selfcheck verifies they match). */
export function dimensionLayoutMarkdown(): string {
  const rows = DIMENSION_LAYOUT.map((d) => `| ${d.dim} | ${d.index} | ${d.group} | \`${d.name}\` | ${d.description} |`);
  return ["| Dim | Index | Group | Name | Meaning / reference range |", "|---:|---:|---|---|---|", ...rows].join("\n");
}
