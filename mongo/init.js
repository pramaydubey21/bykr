// bykr MongoDB initialisation.
// Mounted into /docker-entrypoint-initdb.d, so it runs once when the container
// first starts with an empty volume. scripts/seed.ts calls the same index
// definitions through lib/mongo/collections.ts, so re-seeding is idempotent.
//
// Why these two collections live in MongoDB and not PostgreSQL:
//   * write volume is an order of magnitude above any relational entity
//     (one ping per participant every five seconds);
//   * records are append-only and carry no foreign keys that matter;
//   * they are queried geospatially ($near), not relationally;
//   * a TTL index expires them automatically after thirty days.

db = db.getSiblingDB("bykr");

if (!db.getCollectionNames().includes("location_pings")) {
  db.createCollection("location_pings", {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["participantId", "rideId", "userId", "location", "recordedAt"],
        properties: {
          participantId: { bsonType: "int" },
          rideId: { bsonType: "int" },
          userId: { bsonType: "int" },
          location: {
            bsonType: "object",
            required: ["type", "coordinates"],
            properties: {
              type: { enum: ["Point"] },
              coordinates: { bsonType: "array", minItems: 2, maxItems: 2 },
            },
          },
          speedKmph: { bsonType: ["double", "int"] },
          accuracyM: { bsonType: ["double", "int"] },
          recordedAt: { bsonType: "date" },
          segmentId: { bsonType: "string" },
        },
      },
    },
  });
}

if (!db.getCollectionNames().includes("motion_samples")) {
  db.createCollection("motion_samples", {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["participantId", "rideId", "samples", "peakMagnitudeG", "capturedAt"],
        properties: {
          participantId: { bsonType: "int" },
          rideId: { bsonType: "int" },
          samples: { bsonType: "array" },
          peakMagnitudeG: { bsonType: ["double", "int"] },
          capturedAt: { bsonType: "date" },
          eventId: { bsonType: "int" },
        },
      },
    },
  });
}

// Geospatial index: powers the $near "who is close to the accident" query.
db.location_pings.createIndex({ location: "2dsphere" }, { name: "ix_pings_location_2dsphere" });
// Compound index: every per-ride read is "pings of ride X in time order".
db.location_pings.createIndex({ rideId: 1, recordedAt: 1 }, { name: "ix_pings_ride_time" });
// TTL index: MongoDB deletes pings 30 days after recordedAt, automatically.
db.location_pings.createIndex(
  { recordedAt: 1 },
  { name: "ttl_pings_30d", expireAfterSeconds: 60 * 60 * 24 * 30 },
);

db.motion_samples.createIndex({ rideId: 1, capturedAt: 1 }, { name: "ix_motion_ride_time" });
db.motion_samples.createIndex(
  { capturedAt: 1 },
  { name: "ttl_motion_30d", expireAfterSeconds: 60 * 60 * 24 * 30 },
);
