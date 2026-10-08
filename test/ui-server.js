import { MongoMemoryReplSet } from "mongodb-memory-server";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "../backend/config.js";
import { connect } from "../backend/db.js";
import { createApp } from "../backend/app.js";
import { hashPassword } from "../backend/lib/crypto.js";
import { seedCatalog } from "../backend/modules/catalog-seed.js";
const repl = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});
const c = config({
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1:8108",
  MONGODB_URI: repl.getUri(),
  MONGODB_DB: "admin_ui_test",
  VAULT_KEY: "a".repeat(64),
  AUTH_SECRET: "b".repeat(64),
});
const { db, client } = await connect(c);
await seedCatalog(db);
for (const role of ["owner", "viewer"])
  await db.collection("staff").insertOne({
    _id: randomUUID(),
    email: `${role}@example.test`,
    name: `${role} tester`,
    role,
    status: "active",
    revision: 1,
    authVersion: 1,
    passwordHash: await hashPassword("Browser test passphrase 2026!"),
    createdAt: new Date(),
  });
mkdirSync("test-results", { recursive: true });
const app = createApp({
  db,
  client,
  c,
  sendCode: async (email, code) =>
    writeFileSync(
      `test-results/otp-${email.split("@")[0]}.json`,
      JSON.stringify({ code }),
    ),
});
const server = app.listen(8108, "127.0.0.1");
async function stop() {
  server.close();
  await client.close();
  await repl.stop();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
