/**
 * The five MongoDB operations required by rubric column P, each a named function,
 * plus the small reads the live map needs.
 *
 *   CREATE  insertPingsBulk        bulk insert of buffered pings (insertMany)
 *   READ    findParticipantsNear   geospatial $near around an accident point
 *   READ    aggregateRideStats     aggregation pipeline: distance, speed, stops per participant
 *   UPDATE  tagRideSegments        updateMany tagging pings with a segment id
 *   DELETE  purgeRidePings         deleteMany for a deleted ride (+ TTL index for expiry)
 *
 * Where each is reachable in the UI:
 *   insertPingsBulk       live ride map (every poll, and the offline buffer flush)
 *   findParticipantsNear  alert page, "Riders near the accident"
 *   aggregateRideStats    ride history page, "Telemetry (MongoDB aggregation)"
 *   tagRideSegments       "End ride" button; re-runnable from ride history
 *   purgeRidePings        "Delete ride" / "Purge telemetry" on ride history
 */
import type { Document } from "mongodb";
import { pings, motionSamples, type LocationPing, type MotionSample } from "./collections";

export type PingInput = {
  participantId: number;
  rideId: number;
  userId: number;
  lat: number;
  lon: number;
  speedKmph: number;
  accuracyM: number;
  recordedAt: Date;
};

// ---------------------------------------------------------------------------
// CREATE — bulk insert
// ---------------------------------------------------------------------------
/**
 * Insert a batch of pings in one round trip. The browser buffers pings while
 * offline and sends them all on reconnection; ordered:false lets the good
 * documents land even if one is rejected by the collection validator.
 */
export async function insertPingsBulk(batch: PingInput[]): Promise<number> {
  if (batch.length === 0) return 0;
  const docs: LocationPing[] = batch.map((p) => ({
    participantId: p.participantId,
    rideId: p.rideId,
    userId: p.userId,
    location: { type: "Point", coordinates: [p.lon, p.lat] },
    speedKmph: p.speedKmph,
    accuracyM: p.accuracyM,
    recordedAt: p.recordedAt,
  }));
  const col = await pings();
  const res = await col.insertMany(docs, { ordered: false });
  return res.insertedCount;
}

// ---------------------------------------------------------------------------
// READ — geospatial
// ---------------------------------------------------------------------------
export type NearbyRider = {
  participantId: number;
  userId: number;
  rideId: number;
  lat: number;
  lon: number;
  recordedAt: Date;
};

/**
 * Who was within radiusM metres of a point during a time window?
 * $near uses the 2dsphere index and returns documents nearest-first, so the
 * first ping seen for each participant is their closest approach.
 * This is the query a relational table does badly: it needs a spatial index
 * over millions of append-only points.
 */
export async function findParticipantsNear(
  lat: number,
  lon: number,
  radiusM: number,
  from: Date,
  to: Date,
): Promise<NearbyRider[]> {
  const col = await pings();
  const cursor = col
    .find(
      {
        location: {
          $near: {
            $geometry: { type: "Point", coordinates: [lon, lat] },
            $maxDistance: radiusM,
          },
        },
        recordedAt: { $gte: from, $lte: to },
      },
      { projection: { participantId: 1, userId: 1, rideId: 1, location: 1, recordedAt: 1 } },
    )
    .limit(2000);

  const seen = new Map<number, NearbyRider>();
  for await (const d of cursor) {
    if (seen.has(d.participantId)) continue;
    seen.set(d.participantId, {
      participantId: d.participantId,
      userId: d.userId,
      rideId: d.rideId,
      lon: d.location.coordinates[0],
      lat: d.location.coordinates[1],
      recordedAt: d.recordedAt,
    });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// READ — aggregation pipeline
// ---------------------------------------------------------------------------
export type ParticipantStats = {
  participantId: number;
  userId: number;
  pings: number;
  distanceKm: number;
  avgSpeedKmph: number;
  maxSpeedKmph: number;
  speedVariance: number;
  stopCount: number;
  firstAt: Date;
  lastAt: Date;
  segments: number;
};

/** Haversine distance between two [lon, lat] arrays, as a MongoDB expression. */
function haversineExpr(prev: string, cur: string): Document {
  const lon1 = { $degreesToRadians: { $arrayElemAt: [prev, 0] } };
  const lat1 = { $degreesToRadians: { $arrayElemAt: [prev, 1] } };
  const lon2 = { $degreesToRadians: { $arrayElemAt: [cur, 0] } };
  const lat2 = { $degreesToRadians: { $arrayElemAt: [cur, 1] } };
  const sinHalf = (a: Document, b: Document) => ({
    $pow: [{ $sin: { $divide: [{ $subtract: [b, a] }, 2] } }, 2],
  });
  return {
    $multiply: [
      2 * 6371.0088,
      {
        $asin: {
          $min: [
            1,
            {
              $sqrt: {
                $add: [
                  sinHalf(lat1, lat2),
                  { $multiply: [{ $cos: lat1 }, { $cos: lat2 }, sinHalf(lon1, lon2)] },
                ],
              },
            },
          ],
        },
      },
    ],
  };
}

/**
 * Per-participant ride statistics computed entirely inside MongoDB:
 *   $match            pings of this ride (uses ix_pings_ride_time)
 *   $setWindowFields  pairs each ping with the previous one of the same participant ($shift)
 *   $addFields        haversine leg length; flag moving->stopped transitions
 *   $group            distance, average/max speed, variance, stop count, time span
 * The leader's figures feed the route embedding (lib/vector).
 */
export async function aggregateRideStats(rideId: number): Promise<ParticipantStats[]> {
  const col = await pings();
  const pipeline: Document[] = [
    { $match: { rideId } },
    {
      $setWindowFields: {
        partitionBy: "$participantId",
        sortBy: { recordedAt: 1 },
        output: {
          prevCoords: { $shift: { output: "$location.coordinates", by: -1, default: null } },
          prevSpeed: { $shift: { output: "$speedKmph", by: -1, default: null } },
        },
      },
    },
    {
      $addFields: {
        legKm: {
          $cond: [{ $eq: ["$prevCoords", null] }, 0, haversineExpr("$prevCoords", "$location.coordinates")],
        },
        stopStart: {
          $cond: [
            { $and: [{ $lt: ["$speedKmph", 5] }, { $gte: ["$prevSpeed", 5] }] },
            1,
            0,
          ],
        },
      },
    },
    {
      $group: {
        _id: "$participantId",
        userId: { $first: "$userId" },
        pings: { $sum: 1 },
        distanceKm: { $sum: "$legKm" },
        avgSpeedKmph: { $avg: "$speedKmph" },
        maxSpeedKmph: { $max: "$speedKmph" },
        speedVariance: { $stdDevPop: "$speedKmph" },
        stopCount: { $sum: "$stopStart" },
        firstAt: { $min: "$recordedAt" },
        lastAt: { $max: "$recordedAt" },
        segmentIds: { $addToSet: "$segmentId" },
      },
    },
    {
      $project: {
        _id: 0,
        participantId: "$_id",
        userId: 1,
        pings: 1,
        distanceKm: { $round: ["$distanceKm", 2] },
        avgSpeedKmph: { $round: ["$avgSpeedKmph", 1] },
        maxSpeedKmph: { $round: ["$maxSpeedKmph", 1] },
        speedVariance: { $round: [{ $pow: ["$speedVariance", 2] }, 1] },
        stopCount: 1,
        firstAt: 1,
        lastAt: 1,
        segments: {
          $size: { $filter: { input: "$segmentIds", cond: { $ne: ["$$this", null] } } },
        },
      },
    },
    { $sort: { distanceKm: -1 } },
  ];
  return col.aggregate<ParticipantStats>(pipeline).toArray();
}

// ---------------------------------------------------------------------------
// UPDATE — updateMany
// ---------------------------------------------------------------------------
/**
 * Once a ride completes, split it into segments at every group stop and tag
 * every ping with its segment id, e.g. "r12-s3". Stops are taken from the
 * leader's track (speed dropping below 5 km/h after moving).
 *
 * One updateMany with an aggregation-pipeline update: $switch picks the
 * segment whose time range contains recordedAt.
 */
export async function tagRideSegments(
  rideId: number,
  leaderParticipantId: number,
): Promise<{ segments: number; modified: number }> {
  const col = await pings();
  const leaderTrack = await col
    .find({ rideId, participantId: leaderParticipantId }, { projection: { speedKmph: 1, recordedAt: 1 } })
    .sort({ recordedAt: 1 })
    .toArray();

  // Boundaries = times at which the leader came to a stop.
  const boundaries: Date[] = [];
  for (let i = 1; i < leaderTrack.length; i++) {
    if (leaderTrack[i].speedKmph < 5 && leaderTrack[i - 1].speedKmph >= 5) {
      boundaries.push(leaderTrack[i].recordedAt);
    }
  }

  const branches = boundaries.map((b, i) => ({
    case: { $lt: ["$recordedAt", b] },
    then: `r${rideId}-s${i + 1}`,
  }));
  const segmentExpr =
    branches.length === 0
      ? `r${rideId}-s1`
      : { $switch: { branches, default: `r${rideId}-s${boundaries.length + 1}` } };

  const res = await col.updateMany({ rideId }, [{ $set: { segmentId: segmentExpr } }]);
  return { segments: boundaries.length + 1, modified: res.modifiedCount };
}

// ---------------------------------------------------------------------------
// DELETE — deleteMany (the TTL index handles routine expiry)
// ---------------------------------------------------------------------------
/**
 * Purge all telemetry for a ride the user deleted. Routine expiry needs no
 * code: ttl_pings_30d removes pings 30 days after recordedAt.
 */
export async function purgeRidePings(rideId: number): Promise<{ pings: number; motion: number }> {
  const [p, m] = await Promise.all([pings(), motionSamples()]);
  const [rp, rm] = await Promise.all([p.deleteMany({ rideId }), m.deleteMany({ rideId })]);
  return { pings: rp.deletedCount, motion: rm.deletedCount };
}

// ---------------------------------------------------------------------------
// Supporting reads used by the live map, ride history and embedding
// ---------------------------------------------------------------------------
export type LatestPosition = {
  participantId: number;
  userId: number;
  lat: number;
  lon: number;
  speedKmph: number;
  recordedAt: Date;
};

/** Latest ping per participant of a ride (live map polling). */
export async function latestPositions(rideId: number): Promise<LatestPosition[]> {
  const col = await pings();
  return col
    .aggregate<LatestPosition>([
      { $match: { rideId } },
      { $sort: { recordedAt: -1 } },
      {
        $group: {
          _id: "$participantId",
          userId: { $first: "$userId" },
          coords: { $first: "$location.coordinates" },
          speedKmph: { $first: "$speedKmph" },
          recordedAt: { $first: "$recordedAt" },
        },
      },
      {
        $project: {
          _id: 0,
          participantId: "$_id",
          userId: 1,
          lon: { $arrayElemAt: ["$coords", 0] },
          lat: { $arrayElemAt: ["$coords", 1] },
          speedKmph: 1,
          recordedAt: 1,
        },
      },
    ])
    .toArray();
}

export type TrackPoint = { lat: number; lon: number; speedKmph: number; recordedAt: Date; segmentId?: string };

/** Full time-ordered track of one participant. */
export async function participantTrack(rideId: number, participantId: number): Promise<TrackPoint[]> {
  const col = await pings();
  const docs = await col
    .find({ rideId, participantId }, { projection: { location: 1, speedKmph: 1, recordedAt: 1, segmentId: 1 } })
    .sort({ recordedAt: 1 })
    .toArray();
  return docs.map((d) => ({
    lon: d.location.coordinates[0],
    lat: d.location.coordinates[1],
    speedKmph: d.speedKmph,
    recordedAt: d.recordedAt,
    segmentId: d.segmentId,
  }));
}

export async function insertMotionSample(doc: MotionSample): Promise<string> {
  const col = await motionSamples();
  const res = await col.insertOne(doc);
  return res.insertedId.toHexString();
}

export async function countRidePings(rideId: number): Promise<number> {
  return (await pings()).countDocuments({ rideId });
}
