import { MongoClient, type Db } from "mongodb";

// One MongoClient per process (re-used across hot reloads in development).
const g = globalThis as unknown as { _bykrMongo?: Promise<MongoClient> };

function connect(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
  return new MongoClient(uri, { maxPoolSize: 10 }).connect();
}

export async function getMongoDb(): Promise<Db> {
  if (!g._bykrMongo) g._bykrMongo = connect();
  const client = await g._bykrMongo;
  return client.db(process.env.MONGODB_DB ?? "bykr");
}

export async function closeMongo(): Promise<void> {
  if (g._bykrMongo) {
    const c = await g._bykrMongo;
    await c.close();
    g._bykrMongo = undefined;
  }
}
