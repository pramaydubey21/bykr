// Quick check that all five MongoDB operations work. Uses ride id 999999 and cleans up.
import { insertPingsBulk, findParticipantsNear, aggregateRideStats, tagRideSegments, purgeRidePings } from "../lib/mongo/telemetry";
import { ensureIndexes } from "../lib/mongo/collections";
import { closeMongo } from "../lib/mongo/client";

async function main() {
  await ensureIndexes();
  const t0 = Date.now();
  const batch = [];
  for (let i = 0; i < 60; i++) {
    const speed = i >= 20 && i < 30 ? 0 : 40;           // one stop in the middle
    batch.push({ participantId: 1, rideId: 999999, userId: 1, lat: 18.5 + i * 0.0005, lon: 73.8, speedKmph: speed, accuracyM: 5, recordedAt: new Date(t0 + i * 5000) });
    batch.push({ participantId: 2, rideId: 999999, userId: 2, lat: 18.5 + i * 0.0005, lon: 73.8005, speedKmph: speed, accuracyM: 5, recordedAt: new Date(t0 + i * 5000) });
  }
  console.log("CREATE insertPingsBulk ->", await insertPingsBulk(batch));
  console.log("READ   findParticipantsNear ->", (await findParticipantsNear(18.51, 73.8, 500, new Date(t0), new Date(t0 + 600000))).map(r => r.participantId));
  console.log("UPDATE tagRideSegments ->", await tagRideSegments(999999, 1));
  console.log("READ   aggregateRideStats ->", JSON.stringify(await aggregateRideStats(999999)));
  console.log("DELETE purgeRidePings ->", await purgeRidePings(999999));
  await closeMongo();
}
main().catch((e) => { console.error(e); process.exit(1); });
