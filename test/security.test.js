import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { config } from "../backend/config.js";
import { connect, transaction } from "../backend/db.js";
import { createApp } from "../backend/app.js";
import { hashPassword, encrypt, decrypt } from "../backend/lib/crypto.js";
import { seedCatalog } from "../backend/modules/catalog-seed.js";
import { makeSnapshot, parseSnapshot } from "../backend/lib/snapshot.js";
import { consume } from "../backend/lib/limiter.js";
import { CHECKS } from "../shared/policy.js";
let repl, client, db, server, origin, owner, admin, ops, viewer;
const mail = new Map(),
  password = "Testing a long passphrase 123!";
const vaultKey = "a".repeat(64),
  backupKey = "b".repeat(64);
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
async function login(email) {
  const start = await request("/auth/login", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(start.status, 200);
  const done = await request("/auth/verify", {
    method: "POST",
    body: { challengeId: start.data.challengeId, code: mail.get(email) },
  });
  assert.equal(done.status, 200);
  return {
    cookie: done.headers.get("set-cookie").split(";")[0],
    csrf: done.data.csrf,
    user: done.data.staff,
  };
}
const customer = (suffix) => ({
  name: `Customer ${suffix}`,
  company: "Test company",
  email: `${suffix}@example.test`,
  phone: "",
  status: "active",
  notes: "",
  storeWorkspaceId: "",
});
async function createCustomer(suffix) {
  const result = await request("/customers", {
    method: "POST",
    body: customer(suffix),
    session: owner,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
before(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const c = config({
    NODE_ENV: "test",
    MONGODB_URI: repl.getUri(),
    MONGODB_DB: "admin_test",
    VAULT_KEY: vaultKey,
    AUTH_SECRET: "c".repeat(64),
  });
  ({ client, db } = await connect(c));
  await seedCatalog(db);
  for (const role of ["owner", "admin", "operations", "viewer"])
    await db.collection("staff").insertOne({
      _id: randomUUID(),
      email: `${role}@example.test`,
      name: role,
      role,
      status: "active",
      authVersion: 1,
      revision: 1,
      passwordHash: await hashPassword(password),
      createdAt: new Date(),
    });
  const app = createApp({
    db,
    client,
    c,
    sendCode: async (email, code) => mail.set(email, code),
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  c.APP_URL = origin;
  owner = await login("owner@example.test");
  admin = await login("admin@example.test");
  ops = await login("operations@example.test");
  viewer = await login("viewer@example.test");
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await client?.close();
  await repl?.stop();
});
describe("authentication and authorization", () => {
  it("keeps optional Ecom disconnected, authenticated and restricted", async () => {
    assert.equal((await request("/ecom/tenants")).status, 401);
    const disconnected = await request("/ecom/tenants", { session: owner });
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.data.connected, false);
    assert.equal(
      (await request("/ecom/tenants?page=0", { session: owner })).status,
      400,
    );
    const body = {
      plan: "starter",
      state: "active",
      expiresAt: "2027-01-01T00:00:00.000Z",
      reason: "Release access check",
      revision: 0,
    };
    const path = `/ecom/tenants/${randomUUID()}/subscription`;
    assert.equal(
      (await request(path, { method: "PUT", body, session: viewer })).status,
      403,
    );
    assert.equal(
      (await request(path, { method: "PUT", body, session: ops })).status,
      403,
    );
    assert.equal(
      (await request(path, { method: "PUT", body, session: owner })).status,
      503,
    );
  });
  it("protects the API without a session", async () =>
    assert.equal((await request("/customers")).status, 401));
  it("rejects another origin and missing CSRF", async () => {
    assert.equal(
      (
        await request("/customers", {
          method: "POST",
          body: customer("origin"),
          session: owner,
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/customers", {
          method: "POST",
          body: customer("csrf"),
          session: owner,
          headers: { "X-CSRF-Token": "" },
        })
      ).status,
      403,
    );
  });
  it("requires the correct password before sending a login code", async () =>
    assert.equal(
      (
        await request("/auth/login", {
          method: "POST",
          body: { email: "owner@example.test", password: "bad" },
        })
      ).status,
      401,
    ));
  it("consumes a valid OTP only once", async () => {
    const start = await request("/auth/login", {
      method: "POST",
      body: { email: "admin@example.test", password },
    });
    const body = {
      challengeId: start.data.challengeId,
      code: mail.get("admin@example.test"),
    };
    const results = await Promise.all([
      request("/auth/verify", { method: "POST", body }),
      request("/auth/verify", { method: "POST", body }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  });
  it("enforces challenge expiry independently of Mongo TTL", async () => {
    const start = await request("/auth/login", {
      method: "POST",
      body: { email: "operations@example.test", password },
    });
    await db
      .collection("challenges")
      .updateOne(
        { _id: start.data.challengeId },
        { $set: { expiresAt: new Date(0) } },
      );
    assert.equal(
      (
        await request("/auth/verify", {
          method: "POST",
          body: {
            challengeId: start.data.challengeId,
            code: mail.get("operations@example.test"),
          },
        })
      ).status,
      400,
    );
  });
  it("locks a challenge after five incorrect attempts", async () => {
    const start = await request("/auth/login", {
      method: "POST",
      body: { email: "viewer@example.test", password },
    });
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await request("/auth/verify", {
            method: "POST",
            body: { challengeId: start.data.challengeId, code: "000000" },
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await request("/auth/verify", {
          method: "POST",
          body: {
            challengeId: start.data.challengeId,
            code: mail.get("viewer@example.test"),
          },
        })
      ).status,
      400,
    );
  });
  it("prevents read-only mutation and operations credential writes", async () => {
    assert.equal(
      (
        await request("/customers", {
          method: "POST",
          body: customer("viewer"),
          session: viewer,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(`/connections/${randomUUID()}/credential`, {
          method: "PUT",
          body: { revision: 1, credential: "testing-token" },
          session: ops,
        })
      ).status,
      403,
    );
  });
  it("allows operations customer work but denies catalog changes", async () => {
    assert.equal(
      (
        await request("/customers", {
          method: "POST",
          body: customer("ops"),
          session: ops,
        })
      ).status,
      201,
    );
    assert.equal(
      (await request("/products", { method: "POST", body: {}, session: ops }))
        .status,
      403,
    );
  });
  it("denies admin team escalation", async () =>
    assert.equal(
      (
        await request("/team", {
          method: "POST",
          body: { name: "Escalate", email: "bad@example.test", role: "admin" },
          session: admin,
        })
      ).status,
      403,
    ));
  it("revokes sessions on role changes and protects the owner", async () => {
    const change = await request(`/team/${viewer.user._id}`, {
      method: "PATCH",
      body: { role: "operations", status: "active", revision: 1 },
      session: owner,
    });
    assert.equal(change.status, 200);
    assert.equal((await request("/overview", { session: viewer })).status, 401);
    assert.equal(
      (
        await request(`/team/${owner.user._id}`, {
          method: "PATCH",
          body: { role: "admin", status: "disabled", revision: 1 },
          session: owner,
        })
      ).status,
      409,
    );
  });
  it("invites staff, verifies email and sets a password without public signup", async () => {
    const invited = await request("/team", {
      method: "POST",
      session: owner,
      body: {
        name: "New Staff",
        email: "invited@example.test",
        role: "viewer",
      },
    });
    assert.equal(invited.status, 201);
    const recover = await request("/auth/recover", {
      method: "POST",
      body: { email: "invited@example.test" },
    });
    const verify = await request("/auth/verify", {
      method: "POST",
      body: {
        challengeId: recover.data.challengeId,
        code: mail.get("invited@example.test"),
        password,
      },
    });
    assert.equal(verify.status, 200);
    assert.equal(verify.data.staff.role, "viewer");
    const unknown = await request("/auth/recover", {
      method: "POST",
      body: { email: "outsider@example.test" },
    });
    assert.equal(unknown.status, 200);
    assert.equal(mail.has("outsider@example.test"), false);
  });
});
describe("records and lifecycle integrity", () => {
  it("rejects mass assignment and Mongo operator values", async () => {
    assert.equal(
      (
        await request("/customers", {
          method: "POST",
          session: owner,
          body: { ...customer("extra"), role: "owner" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/customers", {
          method: "POST",
          session: owner,
          body: { ...customer("operator"), email: { $ne: null } },
        })
      ).status,
      400,
    );
  });
  it("enforces unique normalized identity and stale-write conflicts with audit", async () => {
    const row = await createCustomer("revision");
    const base = { ...customer("revision"), revision: row.revision };
    const results = await Promise.all([
      request(`/customers/${row._id}`, {
        method: "PUT",
        body: { ...base, name: "Change A" },
        session: owner,
      }),
      request(`/customers/${row._id}`, {
        method: "PUT",
        body: { ...base, name: "Change B" },
        session: admin,
      }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      await db
        .collection("audit_events")
        .countDocuments({ resourceId: row._id }),
      2,
    );
    assert.equal(
      (
        await request("/customers", {
          method: "POST",
          body: { ...customer("revision"), email: "REVISION@example.test" },
          session: owner,
        })
      ).status,
      409,
    );
  });
  it("blocks forged live installations and cross-customer provider references", async () => {
    const a = await createCustomer("a"),
      b = await createCustomer("b"),
      product = await db.collection("products").findOne({ slug: "pos" });
    const connection = await request("/connections", {
      method: "POST",
      session: owner,
      body: {
        name: "Customer B Vercel",
        customerId: b._id,
        provider: "vercel",
        ownership: "customer",
        accountId: "",
        resourceId: "",
        expiresAt: "",
        status: "recorded",
        notes: "",
      },
    });
    const body = {
      name: "POS test",
      customerId: a._id,
      productId: product._id,
      environment: "production",
      status: "planned",
      release: "",
      sourceUrl: "",
      endpoint: "",
      connectionIds: [],
      checks: [],
      evidence: "",
      notes: "",
    };
    assert.equal(
      (
        await request("/installations", {
          method: "POST",
          session: owner,
          body: { ...body, status: "live" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/installations", {
          method: "POST",
          session: owner,
          body: { ...body, connectionIds: [connection.data._id] },
        })
      ).status,
      400,
    );
    const created = await request("/installations", {
      method: "POST",
      session: owner,
      body,
    });
    assert.equal(created.status, 201);
    assert.equal(
      (
        await request(`/installations/${created.data._id}`, {
          method: "PUT",
          session: owner,
          body: { ...body, status: "ready", revision: 1 },
        })
      ).status,
      400,
    );
    const ids = [];
    for (const provider of ["vercel", "mongodb", "cloudflare"]) {
      const result = await request("/connections", {
        method: "POST",
        session: owner,
        body: {
          name: `${provider} account`,
          customerId: a._id,
          provider,
          ownership: "customer",
          accountId: "customer-account",
          resourceId: "",
          expiresAt: "",
          status: "recorded",
          notes: "",
        },
      });
      ids.push(result.data._id);
    }
    const ready = {
      ...body,
      status: "ready",
      release: "v1.0",
      sourceUrl: "https://example.com/source",
      connectionIds: ids,
      checks: CHECKS.slice(0, 4).map((c) => c.id),
      revision: 1,
    };
    assert.equal(
      (
        await request(`/installations/${created.data._id}`, {
          method: "PUT",
          session: owner,
          body: ready,
        })
      ).status,
      200,
    );
    const live = {
      ...ready,
      revision: 2,
      status: "live",
      endpoint: "https://customer.example.com",
      checks: CHECKS.map((c) => c.id),
      evidence:
        "Checked login, receipts and custom domain. Customer handover completed.",
    };
    assert.equal(
      (
        await request(`/installations/${created.data._id}`, {
          method: "PUT",
          session: owner,
          body: live,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/installations/${created.data._id}`, {
          method: "PUT",
          session: owner,
          body: { ...live, revision: 3, customerId: b._id },
        })
      ).status,
      400,
    );
  });
  it("does not serialize secret credentials in detail or collection APIs", async () => {
    const row = await db.collection("connections").findOne({});
    const credential = "test-provider-token-never-serialize";
    assert.equal(
      (
        await request(`/connections/${row._id}/credential`, {
          method: "PUT",
          session: owner,
          body: { revision: row.revision, credential },
        })
      ).status,
      200,
    );
    const stored = await db.collection("connections").findOne({ _id: row._id });
    assert.equal(
      decrypt(stored.secret, vaultKey, `connection:${row._id}`),
      credential,
    );
    assert.equal(JSON.stringify(stored).includes(credential), false);
    for (const route of ["/connections", `/connections/${row._id}`]) {
      const result = await request(route, { session: owner });
      assert.equal(JSON.stringify(result.data).includes('"secret"'), false);
      assert.equal(JSON.stringify(result.data).includes(credential), false);
    }
    assert.equal(
      await db
        .collection("audit_events")
        .countDocuments({ detail: new RegExp(credential) }),
      0,
    );
  });
  it("rolls back the record when the transaction fails before auditing", async () => {
    const _id = randomUUID();
    await assert.rejects(
      transaction(client, async (session) => {
        await db.collection("customers").insertOne({ _id }, { session });
        throw new Error("simulated failure");
      }),
    );
    assert.equal(await db.collection("customers").findOne({ _id }), null);
  });
  it("bounds queries and exposes an honest disconnected Store state", async () => {
    assert.equal(
      (await request("/customers?page=999999", { session: owner })).status,
      400,
    );
    assert.equal(
      (await request("/store", { session: owner })).data.connected,
      false,
    );
  });
});
describe("recovery and resilience", () => {
  it("enforces shared rate limits under concurrent requests", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => consume(db, "parallel-test", 5, 60000)),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  });
  it("binds encrypted credentials to their record and rejects tampering", () => {
    const box = encrypt("token-value", vaultKey, "one");
    assert.throws(() => decrypt(box, vaultKey, "two"));
    assert.throws(() => decrypt({ ...box, data: "YmFk" }, vaultKey, "one"));
  });
  it("roundtrips encrypted snapshots, excludes sessions and preserves BSON dates", async () => {
    const encoded = await makeSnapshot(db, vaultKey, backupKey);
    assert.equal(encoded.includes("owner@example.test"), false);
    const snapshot = parseSnapshot(encoded, vaultKey, backupKey);
    assert.equal(snapshot.collections.sessions, undefined);
    assert.ok(snapshot.collections.staff[0].createdAt instanceof Date);
    assert.equal(
      snapshot.collections.customers.length,
      await db.collection("customers").countDocuments(),
    );
    const restored = client.db("admin_restored_test");
    for (const [name, rows] of Object.entries(snapshot.collections))
      if (rows.length) await restored.collection(name).insertMany(rows);
    const connection = await restored
      .collection("connections")
      .findOne({ secret: { $exists: true } });
    assert.ok(
      decrypt(connection.secret, vaultKey, `connection:${connection._id}`)
        .length > 0,
    );
    assert.throws(() => parseSnapshot(encoded, "d".repeat(64), backupKey));
    assert.throws(() => parseSnapshot(encoded, vaultKey, "e".repeat(64)));
  });
});

describe("multiple product delivery models", () => {
  for (const model of [
    "hosted-api",
    "customer-package",
    "prepaid-service",
    "saas",
    "customer-deployment",
  ]) {
    it(`uses ${model} requirements without imposing POS infrastructure`, async () => {
      const customer = await createCustomer(`model-${model}`);
      const created = await request("/products", {
        method: "POST",
        session: owner,
        body: {
          name: `Test ${model}`,
          slug: `test-${model}`,
          description: "A different product in the portfolio.",
          category: "New industry",
          model,
          pricing: "custom",
          status: "active",
          website: "",
          requiredProviders: [],
        },
      });
      assert.equal(created.status, 201);
      const { modelFor } = await import("../shared/product-models.js");
      const policy = modelFor(created.data);
      const base = {
        name: `${model} installation`,
        customerId: customer._id,
        productId: created.data._id,
        environment: "production",
        status: "planned",
        release: policy.releaseRequired ? "v1.0" : "",
        sourceUrl: policy.sourceRequired ? "https://example.test/package" : "",
        endpoint: "",
        connectionIds: [],
        checks: [],
        evidence: "",
        notes: "",
      };
      const install = await request("/installations", {
        method: "POST",
        session: owner,
        body: base,
      });
      assert.equal(install.status, 201);
      const ready = {
        ...base,
        revision: 1,
        status: "ready",
        checks: policy.checks.filter(
          (id) => !["verification", "handover"].includes(id),
        ),
      };
      assert.equal(
        (
          await request(`/installations/${install.data._id}`, {
            method: "PUT",
            session: owner,
            body: ready,
          })
        ).status,
        200,
      );
      const live = {
        ...ready,
        revision: 2,
        status: "live",
        checks: policy.checks,
        evidence: "Customer access, configuration and handover verified.",
        endpoint: policy.endpointRequired
          ? "https://customer.example.test"
          : "",
      };
      assert.equal(
        (
          await request(`/installations/${install.data._id}`, {
            method: "PUT",
            session: owner,
            body: live,
          })
        ).status,
        200,
      );
      const filtered = await request(
        `/installations?productId=${created.data._id}`,
        { session: owner },
      );
      assert.equal(filtered.data.total, 1);
      assert.equal(filtered.data.rows[0].productId, created.data._id);
      const modelList = await request(`/products?model=${model}`, {
        session: owner,
      });
      assert.ok(modelList.data.rows.every((row) => row.model === model));
      const { _id, revision, createdAt, updatedAt, ...body } = created.data;
      assert.equal(
        (
          await request(`/products/${_id}`, {
            method: "PUT",
            session: owner,
            body: {
              ...body,
              revision,
              model: model === "saas" ? "hosted-api" : "saas",
            },
          })
        ).status,
        409,
      );
    });
  }
  it("enforces custom AWS requirements without demanding Vercel", async () => {
    const customer = await createCustomer("aws-product");
    const created = await request("/products", {
      method: "POST",
      session: owner,
      body: {
        name: "Industrial console",
        slug: "industrial-console",
        description: "",
        category: "Industry",
        model: "customer-deployment",
        pricing: "one-time",
        status: "active",
        website: "",
        requiredProviders: ["aws"],
      },
    });
    const base = {
      name: "Customer AWS install",
      customerId: customer._id,
      productId: created.data._id,
      environment: "production",
      status: "planned",
      release: "v2",
      sourceUrl: "https://example.test/source",
      endpoint: "",
      connectionIds: [],
      checks: CHECKS.slice(0, 4).map((check) => check.id),
      evidence: "",
      notes: "",
    };
    const install = await request("/installations", {
      method: "POST",
      session: owner,
      body: base,
    });
    const ready = { ...base, revision: 1, status: "ready" };
    assert.equal(
      (
        await request(`/installations/${install.data._id}`, {
          method: "PUT",
          session: owner,
          body: ready,
        })
      ).status,
      400,
    );
    const connection = await request("/connections", {
      method: "POST",
      session: owner,
      body: {
        name: "Customer AWS",
        customerId: customer._id,
        provider: "aws",
        ownership: "customer",
        accountId: "customer-aws",
        resourceId: "",
        expiresAt: "",
        status: "recorded",
        notes: "",
      },
    });
    assert.equal(
      (
        await request(`/installations/${install.data._id}`, {
          method: "PUT",
          session: owner,
          body: { ...ready, connectionIds: [connection.data._id] },
        })
      ).status,
      200,
    );
  });
});
