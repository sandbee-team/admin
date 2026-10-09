import { MongoMemoryReplSet } from "mongodb-memory-server";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "../backend/config.js";
import { connect } from "../backend/db.js";
import { createApp } from "../backend/app.js";
import { hashPassword } from "../backend/lib/crypto.js";
import { seedCatalog } from "../backend/modules/catalog-seed.js";
import { createFakeS3 } from "./fake-s3.js";
import { createServer } from "node:http";
import { verifyVaultKey } from "../backend/lib/vault.js";
import { verifyKey } from "../backend/lib/recovery-tasks.js";
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
// Dedicated owner for security.spec.js: it enrols an authenticator, which must
// not change how the other specs sign in.
await db.collection("staff").insertOne({
  _id: randomUUID(),
  email: "security-owner@example.test",
  name: "security owner",
  role: "owner",
  status: "active",
  revision: 1,
  authVersion: 1,
  passwordHash: await hashPassword("Browser test passphrase 2026!"),
  createdAt: new Date(),
});
// Admin for the queued step-up case in security.spec.js.
await db.collection("staff").insertOne({
  _id: randomUUID(),
  email: "stepup-admin@example.test",
  name: "stepup admin",
  role: "admin",
  status: "active",
  revision: 1,
  authVersion: 1,
  passwordHash: await hashPassword("Browser test passphrase 2026!"),
  createdAt: new Date(),
});
// client-record.spec.js: an owner who enrols an authenticator, an admin (vault
// access without secrets), and one customer with a POS installation.
for (const [email, role] of [
  ["client-owner@example.test", "owner"],
  ["client-admin@example.test", "admin"],
  // import.spec.js: owner without an authenticator (import needs no step-up).
  ["import-owner@example.test", "owner"],
])
  await db.collection("staff").insertOne({
    _id: randomUUID(),
    email,
    name: email.split("@")[0],
    role,
    status: "active",
    revision: 1,
    authVersion: 1,
    passwordHash: await hashPassword("Browser test passphrase 2026!"),
    createdAt: new Date(),
  });
const posProduct = await db.collection("products").findOne({ slug: "pos" });
const stamp = { revision: 1, createdAt: new Date(), updatedAt: new Date() };
await db.collection("customers").insertOne({
  _id: "00000000-0000-4000-8000-0000000000c1",
  name: "Record Customer",
  company: "Record Cafe",
  email: "record-customer@example.test",
  phone: "",
  status: "active",
  notes: "",
  storeWorkspaceId: "",
  ...stamp,
});
await db.collection("installations").insertOne({
  _id: "00000000-0000-4000-8000-0000000000a1",
  name: "Record POS production",
  customerId: "00000000-0000-4000-8000-0000000000c1",
  productId: posProduct._id,
  environment: "production",
  status: "planned",
  release: "",
  sourceUrl: "",
  endpoint: "",
  connectionIds: [],
  checks: ["ownership"],
  evidence: "",
  notes: "",
  ...stamp,
});
mkdirSync("test-results", { recursive: true });
const app = createApp({
  db,
  client,
  c,
  s3: createFakeS3().client(),
  sendCode: async (email, code) =>
    writeFileSync(
      `test-results/otp-${email.split("@")[0]}.json`,
      JSON.stringify({ code }),
    ),
});
const server = app.listen(8108, "127.0.0.1");
// recovery.spec.js: stands in for the verify-key CLI (same task) on a loopback
// control port, since the specs cannot reach the in-memory database.
await verifyVaultKey(db, c.VAULT_KEY);
const control = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/verify-key")
    return res.writeHead(404).end();
  const result = await verifyKey(
    { db, client },
    { kind: "vault", copy: "password-manager", key: c.VAULT_KEY },
  );
  res.writeHead(200).end(JSON.stringify({ match: result.match }));
}).listen(8109, "127.0.0.1");
async function stop() {
  server.close();
  control.close();
  await client.close();
  await repl.stop();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
