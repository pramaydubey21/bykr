import type { Collection, ObjectId } from "mongodb";
import { getMongoDb } from "./client";

// Document shapes (spec section 6).

export type LocationPing = {
  _id?: ObjectId;
  participantId: number;
  rideId: number;
  userId: number;
  location: { type: "Point"; coordinates: [number, number] }; // [lon, lat]
  speedKmph: number;
  accuracyM: number;
  recordedAt: Date;
  segmentId?: string; // set by tagRideSegments() once the ride completes
};

export type MotionSample = {
  _id?: ObjectId;
  participantId: number;
  rideId: number;
  samples: { t: number; x: number; y: number; z: number }[]; // ms offset, m/s^2
  peakMagnitudeG: number;
  capturedAt: Date;
  eventId?: number;
};

export async function pings(): Promise<Collection<LocationPing>> {
  return (await getMongoDb()).collection<LocationPing>("location_pings");
}

export async function motionSamples(): Promise<Collection<MotionSample>> {
  return (await getMongoDb()).collection<MotionSample>("motion_samples");
}

/**
 * Same indexes as mongo/init.js. Called by the seed script so a database that
 * was created before init.js ran (or was dropped) ends up identical.
 */
export async function ensureIndexes(): Promise<void> {
  const p = await pings();
  await p.createIndex({ location: "2dsphere" }, { name: "ix_pings_location_2dsphere" });
  await p.createIndex({ rideId: 1, recordedAt: 1 }, { name: "ix_pings_ride_time" });
  await p.createIndex({ recordedAt: 1 }, { name: "ttl_pings_30d", expireAfterSeconds: 60 * 60 * 24 * 30 });
  const m = await motionSamples();
  await m.createIndex({ rideId: 1, capturedAt: 1 }, { name: "ix_motion_ride_time" });
  await m.createIndex({ capturedAt: 1 }, { name: "ttl_motion_30d", expireAfterSeconds: 60 * 60 * 24 * 30 });
}
