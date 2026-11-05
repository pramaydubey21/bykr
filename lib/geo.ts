// Small geometry helpers shared by the seed script, the API and lib/vector.

export type LatLon = { lat: number; lon: number };

const R_KM = 6371.0088;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. Same formula as fn_haversine_km in SQL. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lerp(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/** Move a point by metres north / east (flat-earth approximation, fine at ride scale). */
export function offsetMetres(p: LatLon, north: number, east: number): LatLon {
  return {
    lat: p.lat + north / 111_320,
    lon: p.lon + east / (111_320 * Math.cos(toRad(p.lat))),
  };
}

export function pathLengthKm(points: LatLon[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversineKm(points[i - 1], points[i]);
  return d;
}

/**
 * Resample a polyline to exactly n points spaced at equal distances along the
 * path (by linear interpolation on cumulative haversine distance).
 */
export function resampleByDistance(points: LatLon[], n: number): LatLon[] {
  if (points.length === 0) return [];
  if (points.length === 1) return Array.from({ length: n }, () => points[0]);
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversineKm(points[i - 1], points[i]));
  const total = cum[cum.length - 1];
  if (total === 0) return Array.from({ length: n }, () => points[0]);
  const out: LatLon[] = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < cum.length - 1 && cum[j] < target) j++;
    const seg = cum[j] - cum[j - 1];
    const t = seg === 0 ? 0 : (target - cum[j - 1]) / seg;
    out.push(lerp(points[j - 1], points[j], Math.min(1, Math.max(0, t))));
  }
  return out;
}

/** Keep at most max points, always including first and last. */
export function decimate<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}
