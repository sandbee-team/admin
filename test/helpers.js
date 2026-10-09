import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { config } from "../backend/config.js";
import { connect } from "../backend/db.js";
import { createApp } from "../backend/app.js";
import { hashPassword } from "../backend/lib/crypto.js";
import { seedCatalog } from "../backend/modules/catalog-seed.js";
export const PASSWORD = "Testing a long passphrase 123!";
export const VAULT_KEY = "a".repeat(64);
export const AUTH_SECRET = "c".repeat(64);
export const BACKUP_KEY = "b".repeat(64);
// Starts an in-memory replica set, the real app and one staff member per role
// (plus any extra emails given as [email, role]). Returns request/login helpers.
export async function startApp({ dbName = "admin_test", extra = [] } = {}) {
  const repl = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const c = config({
    NODE_ENV: "test",
    MONGODB_URI: repl.getUri(),
    MONGODB_DB: dbName,
    VAULT_KEY,
    AUTH_SECRET,
  });
  const { client, db } = await connect(c);
  await seedCatalog(db);
  const passwordHash = await hashPassword(PASSWORD);
  const people = [
    ...["owner", "admin", "operations", "viewer"].map((r) => [
      `${r}@example.test`,
      r,
    ]),
    ...extra,
  ];
  for (const [email, role] of people)
    await db.collection("staff").insertOne({
      _id: randomUUID(),
      email,
      name: email.split("@")[0],
      role,
      status: "active",
      authVersion: 1,
      revision: 1,
      passwordHash,
      createdAt: new Date(),
    });
  const mail = new Map();
  // Security notices are recorded; set `ctx.failNotify = true` to make the
  // notifier throw (it must never change an HTTP result).
  const notices = [];
  const flags = { failNotify: false };
  const app = createApp({
    db,
    client,
    c,
    sendCode: async (email, code) => mail.set(email, code),
    notify: async (email, message) => {
      if (flags.failNotify) throw new Error("smtp down");
      notices.push({ email, ...message });
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  c.APP_URL = origin;
  async function request(
    path,
    { method = "GET", body, session, headers = {} } = {},
  ) {
    const res = await fetch(`${origin}/api${path}`, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(session
          ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
          : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json();
    return { status: res.status, data, headers: res.headers };
  }
  const sessionOf = (done) => ({
    cookie: done.headers.get("set-cookie").split(";")[0],
    csrf: done.data.csrf,
    user: done.data.staff,
  });
  // Password + email code. For TOTP-enabled staff pass `totp` (a function that
  // returns the body for /auth/verify-totp) to finish; otherwise the raw
  // verify response is returned so tests can inspect the intermediate state.
  async function loginStart(email, { headers } = {}) {
    const start = await request("/auth/login", {
      method: "POST",
      body: { email, password: PASSWORD },
      headers,
    });
    assert.equal(start.status, 200);
    return request("/auth/verify", {
      method: "POST",
      body: { challengeId: start.data.challengeId, code: mail.get(email) },
      headers,
    });
  }
  async function login(email, opts) {
    const done = await loginStart(email, opts);
    assert.equal(done.status, 200, JSON.stringify(done.data));
    return sessionOf(done);
  }
  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    await client.close();
    await repl.stop();
  }
  return {
    repl,
    client,
    db,
    c,
    server,
    origin,
    mail,
    notices,
    flags,
    request,
    login,
    loginStart,
    sessionOf,
    stop,
  };
}
// Fails if any plaintext appears, any encrypted-box signature leaks, or a
// secret-bearing key holds an object. `plaintexts` are deliberately excluded
// values the caller does not expect to see (keys, codes, passwords).
const BOX_SIGNATURES = ['"iv":', '"tag":', '"data":'];
const OBJECT_KEYS = new Set([
  "password",
  "totp",
  "totpKey",
  "dataKey",
  "token",
  "uri",
]);
const ANY_KEYS = new Set([
  "passwordHash",
  "totpBackupCodes",
  "totpPending",
  "codeHash",
]);
export function assertNoSecrets(json, plaintexts = [], label = "response") {
  const text = JSON.stringify(json);
  for (const value of plaintexts)
    if (typeof value === "string" && value.length >= 4)
      assert.equal(text.includes(value), false, `${label} contains a secret`);
  for (const signature of BOX_SIGNATURES)
    assert.equal(text.includes(signature), false, `${label} contains a box`);
  (function walk(value) {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === "object")
      for (const [key, inner] of Object.entries(value)) {
        assert.equal(ANY_KEYS.has(key), false, `${label} exposes ${key}`);
        if (OBJECT_KEYS.has(key))
          assert.notEqual(
            typeof inner === "object" && inner !== null,
            true,
            `${label} exposes ${key}`,
          );
        walk(inner);
      }
  })(json);
}
