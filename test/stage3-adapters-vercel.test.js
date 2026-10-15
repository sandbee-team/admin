// P5 Stage 3 W2a (docs/P5-STAGE3-PLAN.md §7, §11): the Vercel go-live writes
// (D42/D43) against the stateful fake, and the POS admin seed (D45) against an
// in-memory MongoDB. Cloudflare's adapters are tested in stage3-adapters-cf.test.js.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";
import { ProviderError } from "../backend/lib/provider-http.js";
import { createVercel } from "../backend/lib/vercel.js";
import { BUILD_SETTINGS } from "../backend/lib/build-inputs.js";
import { buildEnv, envFp, mintSecrets } from "../backend/lib/golive-env.js";
import { openClientDb } from "../backend/lib/client-mongo.js";
import {
  AdminSeedError,
  BCRYPT_COST,
  checkPosAdmin,
  seedPosAdmin,
} from "../backend/lib/pos-admin-seed.js";
import { assertNoSecrets, VAULT_KEY } from "./helpers.js";
import { json } from "./fakes/github.js";
import { RANK1_CNAME, createFakeVercel } from "./fakes/vercel.js";
import { createFakeVercel as createFakeVercelAdapter } from "./fakes/builder.js";

const TOKEN = "vcp_SECRETVERCELTOKEN0123456789abcdef";
const HOST = "cafe1.sandbee.in";
const noSleep = async () => {};
const make = (fake, extra = {}) =>
  createVercel({ token: TOKEN, fetch: fake.fetch, sleep: noSleep, ...extra });
const rejects = (promise, check) => assert.rejects(promise, check);
const code = (expected) => (error) => {
  assert.ok(error instanceof ProviderError, String(error));
  assert.equal(error.code, expected);
  assert.equal(error.message.includes(TOKEN), false);
  assert.equal(error.message.includes("SECRET-TEXT"), false);
  return true;
};
// No `value` key (env values) and no token anywhere in a result.
function clean(result, extra = [], allowValue = false) {
  assertNoSecrets(result, [TOKEN, ...extra]);
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object")
      for (const [k, inner] of Object.entries(v)) {
        if (!allowValue)
          assert.notEqual(k, "value", "result exposes an env value");
        walk(inner);
      }
  })(result);
}
const sampleEnv = () =>
  buildEnv(
    {
      mongodbUri: "mongodb+srv://u:SECRETPW@cl.abc.mongodb.net/cafe1",
      image: null,
    },
    { tenantId: "cafe1", rootDomain: "sandbee.in" },
    mintSecrets({}),
    [],
  );

describe("vercel go-live adapter: projects", () => {
  it("projectByName finds a project, null when absent, refuses odd names", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const p = await vc.projectByName("demo");
    assert.equal(p.id, "prj_test1");
    assert.equal(p.productionDeploymentId, "dpl_live");
    clean(p);
    assert.equal(await vc.projectByName("nobody"), null);
    await rejects(vc.projectByName("../x"), code("invalid"));
    await rejects(vc.projectByName(""), code("invalid"));
  });
  it("createProject sends the fixed settings and region bom1, then patchProject sets node 22 and source files", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    const call = fake.calls.find((c) => c.method === "POST");
    assert.equal(call.path, "/v11/projects");
    assert.deepEqual(call.body, {
      name: "cafe1",
      framework: BUILD_SETTINGS.framework,
      rootDirectory: BUILD_SETTINGS.rootDirectory,
      serverlessFunctionRegion: "bom1",
    });
    assert.equal(made.name, "cafe1");
    assert.equal(made.serverlessFunctionRegion, "bom1");
    assert.equal(made.productionDeploymentId, null);
    assert.equal(made.nodeVersion, "20.x");
    clean(made, ["must-not-leak"]);
    const patched = await vc.patchProject(made.id);
    const patch = fake.calls.find((c) => c.method === "PATCH");
    assert.deepEqual(patch.body, {
      nodeVersion: "22.x",
      sourceFilesOutsideRootDirectory: true,
    });
    assert.equal(patched.nodeVersion, "22.x");
    assert.equal(patched.sourceFilesOutsideRootDirectory, true);
    assert.equal((await vc.projectByName("cafe1")).id, made.id);
  });
  it("createProject: a taken name is project-name-taken (fixed text), and is not retried", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    await rejects(vc.createProject("demo"), (e) => {
      code("project-name-taken")(e);
      assert.equal(e.status, 409);
      return true;
    });
    fake.rule(
      (m, p) => m === "POST" && p === "/v11/projects",
      () => json(503, {}),
      { times: -1 },
    );
    const before = fake.calls.length;
    await rejects(vc.createProject("fresh"), code("unavailable"));
    assert.equal(fake.calls.length - before, 1);
  });
  it("project calls carry the team id and fail without it", async () => {
    const fake = createFakeVercel({ teamId: "team_abc" });
    const vc = make(fake, { teamId: "team_abc" });
    const made = await vc.createProject("cafe1");
    await vc.patchProject(made.id);
    await vc.projectByName("cafe1");
    for (const c of fake.calls) assert.equal(c.query.teamId, "team_abc");
    await rejects(make(fake).createProject("other"), code("forbidden"));
  });
});

describe("vercel go-live adapter: env", () => {
  it("upsertEnv accepts blanks, counts, and returns no values", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    const envs = sampleEnv();
    assert.ok(envs.some((e) => e.value === ""));
    const out = await vc.upsertEnv(made.id, envs);
    assert.deepEqual(out, { created: envs.length, failed: [] });
    clean(
      out,
      envs.map((e) => e.value),
    );
    const sent = fake.calls.find((c) => c.path.endsWith("/env"));
    assert.equal(sent.query.upsert, "true");
    assert.equal(sent.body.length, envs.length);
    assert.deepEqual(Object.keys(sent.body[0]).sort(), [
      "key",
      "target",
      "type",
      "value",
    ]);
  });
  it("an upsert with the same values bumps updatedAt on every row", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    const envs = sampleEnv();
    await vc.upsertEnv(made.id, envs);
    const first = await vc.envMeta(made.id);
    await vc.upsertEnv(made.id, envs);
    const second = await vc.envMeta(made.id);
    assert.equal(second.length, first.length);
    for (const row of second)
      assert.ok(row.updatedAt > first.find((f) => f.key === row.key).updatedAt);
  });
  it("failed rows come back as key + code only", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    fake.state.envFailKeys.add("AUTH_SECRET");
    const envs = sampleEnv();
    const out = await vc.upsertEnv(made.id, envs);
    assert.deepEqual(out.failed, [{ key: "AUTH_SECRET", code: "bad_request" }]);
    assert.equal(out.created, envs.length - 1);
    assert.equal(JSON.stringify(out).includes("TEXT"), false);
  });
  it("upsertEnv input is validated; a refused request is env-upsert-failed", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    const ok = { key: "A_B", value: "", type: "plain", target: ["production"] };
    for (const bad of [
      [],
      [{ ...ok, key: "a-b" }],
      [{ ...ok, value: 5 }],
      [{ ...ok, type: "secret" }],
      [{ ...ok, target: [] }],
      [{ ...ok, target: ["evil"] }],
    ])
      await rejects(vc.upsertEnv(made.id, bad), code("invalid"));
    await rejects(vc.upsertEnv("../x", [ok]), code("invalid"));
    fake.rule(
      (m, p) => m === "POST" && p.endsWith("/env"),
      () =>
        json(400, { error: { code: "bad_request", message: "SECRET-TEXT" } }),
    );
    await rejects(vc.upsertEnv(made.id, [ok]), (e) => {
      code("env-upsert-failed")(e);
      assert.equal(e.status, 400);
      return true;
    });
    fake.rule(
      (m, p) => m === "POST" && p.endsWith("/env"),
      () => json(401, {}),
    );
    await rejects(vc.upsertEnv(made.id, [ok]), code("unauthorized"));
    fake.rule(
      (m, p) => m === "POST" && p.endsWith("/env"),
      () => json(404, {}),
    );
    await rejects(vc.upsertEnv(made.id, [ok]), code("not-found"));
  });
  it("upsertEnv is retried on 5xx (idempotent) with the adapter's backoff", async () => {
    const fake = createFakeVercel();
    const sleeps = [];
    const vc = make(fake, { sleep: async (ms) => void sleeps.push(ms) });
    const made = await vc.createProject("cafe1");
    fake.rule(
      (m, p) => m === "POST" && p.endsWith("/env"),
      () => json(503, {}),
      { times: 2 },
    );
    const out = await vc.upsertEnv(made.id, sampleEnv());
    assert.equal(out.failed.length, 0);
    assert.deepEqual(sleeps, [2000, 5000]);
  });
  it("a timeout is retried for reads, then reported as timeout", async () => {
    const sleeps = [];
    let calls = 0;
    const vc = createVercel({
      token: TOKEN,
      sleep: async (ms) => void sleeps.push(ms),
      fetch: async () => {
        calls++;
        throw Object.assign(new Error("t"), { name: "TimeoutError" });
      },
    });
    await rejects(vc.envMeta("prj_1"), code("timeout"));
    assert.equal(calls, 4);
    assert.deepEqual(sleeps, [2000, 5000, 10000]);
    calls = 0;
    await rejects(vc.createProject("x"), code("timeout"));
    assert.equal(calls, 1); // POST create: not idempotent
  });
  it("envMeta returns key/type/target/updatedAt only", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    const envs = sampleEnv();
    await vc.upsertEnv(made.id, envs);
    const rows = await vc.envMeta(made.id);
    assert.equal(rows.length, envs.length);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), [
        "key",
        "target",
        "type",
        "updatedAt",
      ]);
      assert.ok(Array.isArray(row.target) && row.target.length === 2);
      assert.equal(typeof row.updatedAt, "number");
    }
    clean(
      rows,
      envs.map((e) => e.value),
    );
    // never decrypts (the fake throws on ?decrypt)
    assert.equal(
      fake.calls.some((c) => "decrypt" in c.query),
      false,
    );
  });
  it("envMeta fingerprints plain values in memory only; the callback cannot leak a value", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    const envs = sampleEnv();
    await vc.upsertEnv(made.id, envs);
    const seen = [];
    const rows = await vc.envMeta(made.id, {
      fingerprint: (key, value) => {
        seen.push([key, value]);
        return envFp(VAULT_KEY, key, value);
      },
    });
    const plain = envs.filter((e) => e.type === "plain");
    assert.deepEqual(
      seen.map(([k]) => k).sort(),
      plain.map((e) => e.key).sort(),
    );
    for (const row of rows) {
      const src = envs.find((e) => e.key === row.key);
      if (src.type === "plain")
        assert.equal(row.fp16, envFp(VAULT_KEY, row.key, src.value));
      else assert.equal("fp16" in row, false);
    }
    clean(
      rows,
      envs.filter((e) => e.value.length >= 8).map((e) => e.value),
    );
    // a callback that returns the value (or anything but 16 hex), or throws
    const leaked = plain.find((e) => e.value.length > 3).value;
    for (const fingerprint of [
      () => leaked,
      () => "ABCDEF0123456789",
      () => 12,
      () => {
        throw new Error(`boom ${leaked}`);
      },
    ])
      await rejects(vc.envMeta(made.id, { fingerprint }), (e) => {
        code("invalid")(e);
        assert.equal(
          JSON.stringify([e.message, e.code]).includes(leaked),
          false,
        );
        return true;
      });
    await rejects(vc.envMeta(made.id, { fingerprint: "x" }), code("invalid"));
  });
});

describe("vercel go-live adapter: domains", () => {
  it("addDomain is verified at once; adding again adopts the domain", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    assert.deepEqual(await vc.projectDomains(made.id), []);
    assert.equal(await vc.projectDomain(made.id, HOST), null);
    const d = await vc.addDomain(made.id, HOST);
    assert.equal(d.name, HOST);
    assert.equal(d.projectId, made.id);
    assert.equal(d.verified, true);
    assert.deepEqual(d.verification, []);
    clean(d);
    const again = await vc.addDomain(made.id, HOST);
    assert.equal(again.name, HOST);
    assert.equal((await vc.projectDomains(made.id)).length, 1);
    assert.equal((await vc.projectDomain(made.id, HOST)).verified, true);
  });
  it("a domain on another project is domain-taken (409), not retried", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    fake.domainOnOtherProject(HOST);
    await rejects(vc.addDomain(made.id, HOST), (e) => {
      code("domain-taken")(e);
      assert.equal(e.status, 409);
      return true;
    });
    await rejects(vc.addDomain(made.id, "bad host"), code("invalid"));
    await rejects(vc.addDomain(made.id, "a..b.sandbee.in"), code("invalid"));
    await rejects(vc.addDomain("../x", HOST), code("invalid"));
  });
  it("an unverified domain lists the TXT record; verify answers pending until it passes", async () => {
    const fake = createFakeVercel();
    fake.state.newDomainsVerified = false;
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    const d = await vc.addDomain(made.id, HOST);
    assert.equal(d.verified, false);
    assert.equal(d.verification.length, 1);
    assert.deepEqual(Object.keys(d.verification[0]).sort(), [
      "domain",
      "type",
      "value",
    ]);
    assert.equal(d.verification[0].type, "TXT");
    const pending = await vc.verifyDomain(made.id, HOST);
    assert.equal(pending.verified, false);
    fake.state.verifyPasses = true;
    const done = await vc.verifyDomain(made.id, HOST);
    assert.equal(done.verified, true);
    assert.deepEqual(done.verification, []);
    fake.rule(
      (m, p) => m === "POST" && p.endsWith("/verify"),
      () => json(500, {}),
      { times: -1 },
    );
    await rejects(vc.verifyDomain(made.id, HOST), code("unavailable"));
    await rejects(
      vc.verifyDomain(made.id, "nope.sandbee.in"),
      code("unavailable"),
    );
  });
  it("verifyDomain on a domain that is not on the project is not-found", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    await rejects(vc.verifyDomain(made.id, HOST), code("not-found"));
  });
  it("domainConfig: misconfigured until DNS is right; rank 1 CNAME", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const before = await vc.domainConfig(HOST);
    assert.equal(before.misconfigured, true);
    assert.equal(before.configuredBy, null);
    assert.equal(before.recommendedCname, RANK1_CNAME.replace(/\.$/, ""));
    assert.deepEqual(
      before.recommendedCNAME.map((r) => r.rank),
      [1, 2],
    );
    clean(before, [], true);
    fake.configure(HOST);
    const after = await vc.domainConfig(HOST);
    assert.equal(after.misconfigured, false);
    assert.equal(after.configuredBy, "CNAME");
    // no list at all -> W1's fallback target
    fake.rule(
      (m, p) => p.startsWith("/v6/domains/"),
      () => json(200, { misconfigured: false }),
    );
    assert.equal(
      (await vc.domainConfig(HOST)).recommendedCname,
      "cname.vercel-dns.com",
    );
    // an odd answer counts as misconfigured
    fake.rule(
      (m, p) => p.startsWith("/v6/domains/"),
      () => json(200, {}),
    );
    assert.equal((await vc.domainConfig(HOST)).misconfigured, true);
    await rejects(vc.domainConfig("bad host"), code("invalid"));
  });
  it("setDomainRedirect sets a 308 redirect and clears it", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    const made = await vc.createProject("cafe1");
    await vc.addDomain(made.id, HOST);
    fake.state.domains.push({
      name: "cafe1.vercel.app",
      projectId: made.id,
      verified: true,
      verification: [],
    });
    const names = (await vc.projectDomains(made.id)).map((d) => d.name);
    assert.deepEqual(names.sort(), [HOST, "cafe1.vercel.app"]);
    const set = await vc.setDomainRedirect(made.id, "cafe1.vercel.app", HOST);
    assert.equal(set.redirect, HOST);
    assert.equal(set.redirectStatusCode, 308);
    const patch = fake.calls.find((c) => c.method === "PATCH");
    assert.deepEqual(patch.body, { redirect: HOST, redirectStatusCode: 308 });
    clean(set);
    const cleared = await vc.setDomainRedirect(
      made.id,
      "cafe1.vercel.app",
      null,
    );
    assert.equal(cleared.redirect, null);
    await rejects(
      vc.setDomainRedirect(made.id, "cafe1.vercel.app", "bad host"),
      code("invalid"),
    );
    await rejects(
      vc.setDomainRedirect(made.id, "cafe1.vercel.app", HOST, {
        statusCode: 200,
      }),
      code("invalid"),
    );
    await rejects(
      vc.setDomainRedirect(made.id, "x.vercel.app", HOST),
      code("not-found"),
    );
  });
  it("provider text never reaches an error, whatever the status", async () => {
    for (const status of [401, 403, 404, 409, 422, 429, 500]) {
      const fake = createFakeVercel();
      const vc = make(fake);
      const made = { id: "prj_test1" };
      fake.rule(
        () => true,
        () => json(status, { error: { code: "x_y", message: "SECRET-TEXT" } }),
        { times: -1 },
      );
      for (const fn of [
        () => vc.addDomain(made.id, HOST),
        () => vc.domainConfig(HOST),
        () => vc.projectDomains(made.id),
        () => vc.setDomainRedirect(made.id, HOST, null),
      ])
        await rejects(fn(), (e) => {
          assert.ok(e instanceof ProviderError);
          assert.equal(
            JSON.stringify([
              e.message,
              e.code,
              e.providerCode,
              e.stack,
            ]).includes("SECRET-TEXT"),
            false,
          );
          return true;
        });
    }
  });
});

describe("fake adapter (test/fakes/builder.js) go-live methods", () => {
  it("run the real adapter over the stateful fake", async () => {
    const fake = createFakeVercelAdapter();
    const made = await fake.createProject("cafe1");
    await fake.patchProject(made.id);
    assert.deepEqual(await fake.upsertEnv(made.id, sampleEnv()), {
      created: sampleEnv().length,
      failed: [],
    });
    assert.ok((await fake.envMeta(made.id)).length > 0);
    await fake.addDomain(made.id, HOST);
    assert.equal((await fake.domainConfig(HOST)).misconfigured, true);
    fake.http.configure(HOST);
    assert.equal((await fake.domainConfig(HOST)).misconfigured, false);
    assert.equal((await fake.projectByName("cafe1")).id, made.id);
    // the deploy-side fake keeps working
    assert.equal(
      (await fake.project("prj_1")).productionDeploymentId,
      "dpl_live",
    );
  });
});

// ---- POS admin seed (D45) ---------------------------------------------------------------
describe("pos admin seed", () => {
  let server;
  let seq = 0;
  const PASSWORD = "Vault-Pass-1234!";
  const open = (uri, options) =>
    openClientDb(uri, { ...options, allowHost: () => true });
  const fresh = () => `posdb${++seq}`;
  const uriOf = (db) => server.getUri(db);
  const args = (db, extra = {}) => ({
    uri: uriOf(db),
    username: "Admin",
    password: PASSWORD,
    open,
    ...extra,
  });
  async function staffs(db) {
    const client = await MongoClient.connect(uriOf(db));
    return {
      col: client.db(db).collection("staffs"),
      close: () => client.close(),
    };
  }
  before(async () => {
    server = await MongoMemoryServer.create();
  });
  after(async () => {
    await server?.stop();
  });

  it("seeds exactly the POS Staff fields once", async () => {
    const db = fresh();
    const at = new Date("2026-10-16T10:00:00Z");
    assert.deepEqual(await seedPosAdmin(args(db, { now: () => at })), {
      state: "seeded",
    });
    const { col, close } = await staffs(db);
    try {
      const rows = await col.find({}).toArray();
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.deepEqual(Object.keys(row).sort(), [
        "__v",
        "_id",
        "createdAt",
        "isActive",
        "mobile",
        "name",
        "password",
        "role",
        "updatedAt",
        "username",
      ]);
      assert.equal(row.name, "Admin");
      assert.equal(row.username, "admin"); // lowercased
      assert.equal(row.mobile, "0000000000");
      assert.equal(row.role, "admin");
      assert.equal(row.isActive, true);
      assert.equal(row.__v, 0);
      assert.deepEqual(row.createdAt, at);
      assert.deepEqual(row.updatedAt, at);
      assert.ok(row.password.startsWith(`$2a$${BCRYPT_COST}$`));
      assert.equal(row.password.includes(PASSWORD), false);
      assert.equal(await bcrypt.compare(PASSWORD, row.password), true);
    } finally {
      await close();
    }
    // a second seed changes nothing
    const again = await seedPosAdmin(args(db, { password: "Other-Pass-99!" }));
    assert.deepEqual(again, { state: "exists" });
    const check = await staffs(db);
    try {
      assert.equal(await check.col.countDocuments({}), 1);
      const [row] = await check.col.find({}).toArray();
      assert.equal(await bcrypt.compare(PASSWORD, row.password), true);
    } finally {
      await check.close();
    }
  });
  it("never touches an existing admin or other staff", async () => {
    const db = fresh();
    const { col, close } = await staffs(db);
    const hash = await bcrypt.hash("Their-Own-Pass-1!", 4);
    const mine = {
      name: "Owner",
      username: "boss",
      mobile: "9999999999",
      password: hash,
      role: "admin",
      isActive: false,
      createdAt: new Date(1),
      updatedAt: new Date(2),
      __v: 0,
    };
    await col.insertOne({ ...mine });
    await col.insertOne({ ...mine, username: "cashier", role: "staff" });
    try {
      assert.deepEqual(await seedPosAdmin(args(db)), { state: "exists" });
      const rows = await col.find({}).sort({ username: 1 }).toArray();
      assert.equal(rows.length, 2);
      const boss = rows.find((r) => r.username === "boss");
      const { _id, ...rest } = boss;
      assert.deepEqual(rest, mine);
      assert.equal(
        rows.some((r) => r.username === "admin"),
        false,
      );
    } finally {
      await close();
    }
  });
  it("concurrent seeds create one admin", async () => {
    const db = fresh();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => seedPosAdmin(args(db))),
    );
    assert.equal(results.filter((r) => r.state === "seeded").length, 1);
    assert.equal(results.filter((r) => r.state === "exists").length, 5);
    const { col, close } = await staffs(db);
    try {
      assert.equal(await col.countDocuments({ role: "admin" }), 1);
    } finally {
      await close();
    }
  });
  it("a unique-username race that inserts an admin first reports exists", async () => {
    const db = fresh();
    const { col, close } = await staffs(db);
    await col.createIndex({ username: 1 }, { unique: true });
    try {
      const wrapped = async (uri, options) => {
        const opened = await open(uri, options);
        const real = opened.db.collection.bind(opened.db);
        opened.db.collection = (name) => {
          const c = real(name);
          const find = c.findOne.bind(c);
          let first = true;
          // The pre-checks see nothing; the rival admin lands just before our write.
          c.findOne = async (...a) => {
            if (first && a[0]?.role === "admin") {
              first = false;
              return null;
            }
            return find(...a);
          };
          const update = c.updateOne.bind(c);
          c.updateOne = async (...a) => {
            await col.insertOne({
              name: "Admin",
              username: "admin",
              mobile: "0000000000",
              password: "x",
              role: "admin",
              isActive: true,
            });
            return update(...a);
          };
          return c;
        };
        return opened;
      };
      const out = await seedPosAdmin(args(db, { open: wrapped }));
      assert.deepEqual(out, { state: "exists" });
      assert.equal(await col.countDocuments({ role: "admin" }), 1);
    } finally {
      await close();
    }
  });
  it("refuses a name that a non-admin already uses, and a weak password", async () => {
    const db = fresh();
    const { col, close } = await staffs(db);
    try {
      await col.insertOne({ username: "admin", role: "staff", password: "x" });
      await assert.rejects(seedPosAdmin(args(db)), (e) => {
        assert.ok(e instanceof AdminSeedError);
        assert.equal(e.code, "admin-seed-failed");
        return true;
      });
      assert.equal(await col.countDocuments({ role: "admin" }), 0);
    } finally {
      await close();
    }
    for (const password of [
      "short1!",
      "NoDigits!!!!",
      "NoSpecial1234",
      "",
      null,
    ])
      await assert.rejects(seedPosAdmin(args(fresh(), { password })), (e) => {
        assert.equal(e.code, "admin-seed-failed");
        assert.equal(e.reason, "weak-password");
        return true;
      });
    await assert.rejects(
      seedPosAdmin(args(fresh(), { username: "  " })),
      (e) => {
        assert.equal(e.code, "admin-seed-failed");
        return true;
      },
    );
  });
  it("failures carry a fixed code and no uri, username or password", async () => {
    const secretUri = "mongodb://root:SECRETPW@127.0.0.1:1/posdb";
    const run = (extra = {}) =>
      seedPosAdmin({
        uri: secretUri,
        username: "SecretUser",
        password: "Secret-Pass-77!",
        open: (uri, options) =>
          openClientDb(uri, {
            ...options,
            allowHost: () => true,
            timeoutMs: 300,
          }),
        ...extra,
      });
    for (const attempt of [
      () => run(),
      () => run({ open: undefined }), // the real Atlas-only guard: not-atlas
      () =>
        checkPosAdmin({
          uri: secretUri,
          username: "SecretUser",
          password: "Secret-Pass-77!",
          open: (uri, options) =>
            openClientDb(uri, {
              ...options,
              allowHost: () => true,
              timeoutMs: 300,
            }),
        }),
    ])
      await assert.rejects(attempt(), (e) => {
        assert.ok(e instanceof AdminSeedError);
        assert.equal(e.code, "admin-seed-failed");
        const dump = JSON.stringify([
          e.message,
          e.reason,
          e.code,
          e.stack,
          e.name,
        ]);
        for (const secret of [
          "SECRETPW",
          "secretuser",
          "Secret-Pass-77!",
          "127.0.0.1",
        ])
          assert.equal(
            dump.toLowerCase().includes(secret.toLowerCase()),
            false,
          );
        return true;
      });
    await assert.rejects(run({ open: undefined }), (e) => {
      assert.equal(e.reason, "not-atlas");
      return true;
    });
  });
  it("read-back failure removes our row and fails", async () => {
    const db = fresh();
    const { col, close } = await staffs(db);
    try {
      const wrapped = async (uri, options) => {
        const opened = await open(uri, options);
        const real = opened.db.collection.bind(opened.db);
        opened.db.collection = (name) => {
          const c = real(name);
          const find = c.findOne.bind(c);
          c.findOne = async (filter, ...rest) => {
            const row = await find(filter, ...rest);
            return row && filter?._id ? { ...row, password: "tampered" } : row;
          };
          return c;
        };
        return opened;
      };
      await assert.rejects(seedPosAdmin(args(db, { open: wrapped })), (e) => {
        assert.equal(e.code, "admin-seed-failed");
        return true;
      });
      assert.equal(await col.countDocuments({}), 0);
    } finally {
      await close();
    }
  });
  it("pinned vectors: POS-style bcrypt hashes compare with bcryptjs 2.4.3", async () => {
    // Independent crypt_blowfish/OpenBSD vector (cost 5)
    assert.equal(
      await bcrypt.compare(
        "U*U",
        "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW",
      ),
      true,
    );
    // A cost-12 $2a$ hash as the POS (bcryptjs.hash(password, 12)) stores it.
    const POS_HASH =
      "$2a$12$x6WXn1ZeN4nbfGLJEu52lefXLCfLa/A3Ttsg6mjUQxOly8QwIcvS6";
    assert.equal(await bcrypt.compare("Pinned-Vector-7!", POS_HASH), true);
    assert.equal(await bcrypt.compare("pinned-vector-7!", POS_HASH), false);
    // and a pinned hash planted as the admin's passes checkPosAdmin
    const db = fresh();
    const { col, close } = await staffs(db);
    try {
      await col.insertOne({
        username: "pos",
        role: "admin",
        password: POS_HASH,
      });
      const out = await checkPosAdmin(
        args(db, { username: "POS", password: "Pinned-Vector-7!" }),
      );
      assert.deepEqual(out, {
        adminExists: true,
        userFound: true,
        passwordMatches: true,
      });
    } finally {
      await close();
    }
  });
  it("checkPosAdmin is read-only and reports presence and match", async () => {
    const db = fresh();
    assert.deepEqual(await checkPosAdmin(args(db)), {
      adminExists: false,
      userFound: false,
      passwordMatches: null,
    });
    const { col, close } = await staffs(db);
    try {
      assert.equal(await col.countDocuments({}), 0); // nothing created by the check
      await seedPosAdmin(args(db));
      assert.deepEqual(await checkPosAdmin(args(db)), {
        adminExists: true,
        userFound: true,
        passwordMatches: true,
      });
      assert.deepEqual(
        await checkPosAdmin(args(db, { password: "Different-1234!" })),
        { adminExists: true, userFound: true, passwordMatches: false },
      );
      assert.deepEqual(await checkPosAdmin(args(db, { username: "someone" })), {
        adminExists: true,
        userFound: false,
        passwordMatches: null,
      });
      assert.equal(await col.countDocuments({}), 1);
    } finally {
      await close();
    }
  });
  it("closes every connection", async () => {
    let opened = 0;
    let closed = 0;
    const counting = async (uri, options) => {
      const o = await open(uri, options);
      opened++;
      const close = o.client.close.bind(o.client);
      o.client.close = (...a) => {
        closed++;
        return close(...a);
      };
      return o;
    };
    const db = fresh();
    await seedPosAdmin(args(db, { open: counting }));
    await seedPosAdmin(args(db, { open: counting }));
    await checkPosAdmin(args(db, { open: counting }));
    await assert
      .rejects(
        seedPosAdmin(
          args(db, { open: counting, uri: "mongodb://127.0.0.1:1/x" }),
        ),
      )
      .catch(() => {});
    assert.equal(opened, closed);
    assert.ok(opened >= 3);
  });
});
