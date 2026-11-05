import type { Ping } from "./types";

export const EARTH_RADIUS_KM = 6371.0088;
export const RESAMPLE_POINTS = 32;

export interface LatLon {
  lat: number;
  lon: number;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres between two coordinates. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Returns a copy of the pings ordered by recordedAt (stable for equal timestamps). */
export function sortPings(pings: readonly Ping[]): Ping[] {
  return pings
    .map((p, i) => ({ p, i }))
    .sort((x, y) => x.p.recordedAt.getTime() - y.p.recordedAt.getTime() || x.i - y.i)
    .map(({ p }) => p);
}

/** Total path length in km along the points in order. */
export function pathLengthKm(points: readonly LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineKm(points[i - 1], points[i]);
  return total;
}

/**
 * Resamples a path to exactly `n` points spaced at equal distance along it.
 *
 * - 0 points:           returns [] (the caller decides what an empty route means).
 * - 1 point, or a path whose points are all identical (zero length):
 *                       returns `n` copies of the first point.
 * - Consecutive duplicate points contribute zero-length segments and are skipped.
 *
 * Interpolation is linear in lat/lon within each segment, which is accurate
 * for the ~5 s (~100 m) spacing between pings.
 */
export function resamplePath(points: readonly LatLon[], n: number = RESAMPLE_POINTS): LatLon[] {
  if (n < 1) throw new RangeError("resamplePath: n must be >= 1");
  if (points.length === 0) return [];

  // Drop consecutive duplicates so every remaining segment has positive length.
  const pts: LatLon[] = [points[0]];
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const d = haversineKm(pts[pts.length - 1], points[i]);
    if (d > 0) {
      pts.push(points[i]);
      cum.push(cum[cum.length - 1] + d);
    }
  }

  const total = cum[cum.length - 1];
  if (pts.length === 1 || total === 0) {
    return Array.from({ length: n }, () => ({ lat: pts[0].lat, lon: pts[0].lon }));
  }
  if (n === 1) return [{ lat: pts[0].lat, lon: pts[0].lon }];

  const out: LatLon[] = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (seg < pts.length - 2 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const t = Math.min(1, Math.max(0, (target - cum[seg]) / segLen));
    out.push({
      lat: pts[seg].lat + t * (pts[seg + 1].lat - pts[seg].lat),
      lon: pts[seg].lon + t * (pts[seg + 1].lon - pts[seg].lon),
    });
  }
  // Pin the last point exactly to the path end (avoids floating-point drift).
  out[n - 1] = { lat: pts[pts.length - 1].lat, lon: pts[pts.length - 1].lon };
  return out;
}

/** Convenience wrapper: sorts pings by time and resamples their positions. */
export function resamplePings(pings: readonly Ping[], n: number = RESAMPLE_POINTS): LatLon[] {
  return resamplePath(
    sortPings(pings).map((p) => ({ lat: p.lat, lon: p.lon })),
    n,
  );
}
