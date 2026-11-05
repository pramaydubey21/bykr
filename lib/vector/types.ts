/**
 * Input types for the deterministic route embedding.
 *
 * Everything in lib/vector is pure TypeScript: no I/O, no network, no
 * external model and no API key. Callers load pings from MongoDB
 * (location_pings) and status history from PostgreSQL (rider_status),
 * convert them to these shapes, and pass them in.
 */

/** The five status labels seeded into status_type.status_label. Order is fixed: it defines embedding dims 72–76. */
export const STATUS_LABELS = ["REFUELLING", "EATING", "DELAYED", "RIDING", "STOPPED"] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];

/**
 * One location reading. Built from a location_pings document:
 *   lat = location.coordinates[1], lon = location.coordinates[0]
 */
export interface Ping {
  lat: number;
  lon: number;
  speedKmph: number;
  recordedAt: Date;
}

/** Ride-level facts that do not come from the ping geometry. */
export interface RideStats {
  /** Number of rider_status rows set during the ride (all participants). */
  statusChanges: number;
  /** Count of rider_status rows per label. Missing labels count as 0. */
  statusCounts: Partial<Record<StatusLabel, number>>;
  /** Number of stops (e.g. from the MongoDB aggregation, or countStops()). */
  stopCount: number;
  /** ride.started_at. Falls back to the first ping's time when omitted. */
  startTime?: Date;
}

/** Geometry and speed metrics derived from the pings; also suitable for filling ride_summary. */
export interface RouteMetrics {
  distanceKm: number;
  durationMin: number;
  avgSpeedKmph: number;
  maxSpeedKmph: number;
  speedVariance: number;
  straightnessRatio: number;
  bboxDiagonalKm: number;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
}

export type DimensionGroup = "shape" | "character" | "padding";

export interface DimensionInfo {
  /** 0-based index into the number[] / pgvector. */
  index: number;
  /** 1-based dimension number, as used in the specification and docs. */
  dim: number;
  group: DimensionGroup;
  name: string;
  description: string;
}
