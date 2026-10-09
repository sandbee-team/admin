import { MongoClient } from "mongodb";
export async function connect(c) {
  const client = new MongoClient(c.MONGODB_URI, {
    maxPoolSize: 20,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
    waitQueueTimeoutMS: 5000,
  });
  try {
    await client.connect();
    const db = client.db(c.MONGODB_DB),
      hello = await db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid")
      throw new Error(
        "MongoDB replica set required for atomic audits. Use the provided Compose setup or Atlas.",
      );
    await indexes(db);
    return { db, client };
  } catch (error) {
    await client.close();
    throw error;
  }
}
export async function indexes(db) {
  for (const name of [
    "staff",
    "sessions",
    "challenges",
    "rate_limits",
    "products",
    "customers",
    "installations",
    "connections",
    "tasks",
    "audit_events",
    "recovery_checks",
    "system_state",
  ]) {
    if (!(await db.listCollections({ name }).hasNext())) {
      try {
        await db.createCollection(name);
      } catch (error) {
        if (error.code !== 48) throw error;
      }
    }
  }
  await Promise.all([
    db.collection("staff").createIndex({ email: 1 }, { unique: true }),
    db.collection("products").createIndex({ slug: 1 }, { unique: true }),
    db.collection("customers").createIndex({ email: 1 }, { unique: true }),
    ...["sessions", "challenges", "rate_limits"].map((name) =>
      db
        .collection(name)
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ),
    db.collection("sessions").createIndex({ staffId: 1 }),
    db
      .collection("installations")
      .createIndex(
        { customerId: 1, productId: 1, environment: 1 },
        { unique: true },
      ),
    ...["products", "customers", "installations", "connections", "tasks"].map(
      (name) => db.collection(name).createIndex({ updatedAt: -1, _id: -1 }),
    ),
    db.collection("installations").createIndex({ status: 1, updatedAt: -1 }),
    db
      .collection("installations")
      .createIndex({ productId: 1, updatedAt: -1, _id: -1 }),
    db.collection("connections").createIndex({ customerId: 1, provider: 1 }),
    db.collection("tasks").createIndex({ status: 1, dueAt: 1 }),
    db.collection("audit_events").createIndex({ createdAt: -1, _id: -1 }),
    db.collection("audit_events").createIndex({ resourceId: 1, createdAt: -1 }),
    db.collection("installations").createIndex(
      { "pos.slug": 1 },
      {
        unique: true,
        partialFilterExpression: { "pos.slug": { $exists: true } },
      },
    ),
    db.collection("recovery_checks").createIndex({ createdAt: -1 }),
  ]);
}
export async function transaction(client, operation) {
  const session = client.startSession();
  try {
    return await session.withTransaction(() => operation(session));
  } finally {
    await session.endSession();
  }
}
