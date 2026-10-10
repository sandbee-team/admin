// Phase 2 review fix: the health stats token is bound to the web address it was
// saved for (`pos.statsHost`). Only the secrets writes (secret PUT/DELETE and
// the import) set it; a host change through the config form does not move it,
// so an admin who edits the host cannot have the worker send the token
// elsewhere. Legacy blocks are bound once to their current host.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { startApp, VAULT_KEY } from "./helpers.js";
import { bindLegacyStatsHosts } from "../backend/db.js";
import { digest, encrypt } from "../backend/lib/crypto.js";

const TOKEN = "health-token-plain-0123456789abc";
const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/pos-client.json", import.meta.url), "utf8"),
);
const PROFILES = JSON.parse(
  readFileSync(
    new URL("./fixtures/pos-profiles.json", import.meta.url),
    "utf8",
  ),
);
const config = (slug, host) => ({
  slug,
  subdomain: "cafe",
  host,
  tenantId: "tenant_1",
  rootDomain: "pos.example.com",
  vercel: {
    projectId: "prj_abc123",
    orgId: "team_abc123",
    teamId: "team_abc123",
    projectName: slug,
  },
  cloudflare: null,
  image: {
    store: "r2",
    publicBaseUrl: "https://img.example.com",
    cloudName: "",
    r2AccountId: "r2acc123",
    bucket: "images",
  },
  posAdmin: { username: "owner1" },
});

let ctx,
  owner,
  admin,
  counter = 0;
const installation = (id) =>
  ctx.db.collection("installations").findOne({ _id: id });
const stepUp = (session) =>
  ctx.db
    .collection("sessions")
    .updateOne(
      { _id: digest(session.cookie.split("=")[1]) },
      { $set: { stepUpUntil: new Date(Date.now() + 600000) } },
    );
async function posInstallation() {
  const n = ++counter;
  const customer = await ctx.request("/customers", {
    method: "POST",
    session: admin,
    body: {
      name: `Bind Client ${n}`,
      email: `bind${n}@example.test`,
      company: "Bind Co",
      phone: "",
      status: "active",
      notes: "",
    },
  });
  assert.equal(customer.status, 201, JSON.stringify(customer.data));
  const product = await ctx.db.collection("products").findOne({ slug: "pos" });
  const created = await ctx.request("/installations", {
    method: "POST",
    session: admin,
    body: {
      name: `pos install ${n}`,
      customerId: customer.data._id,
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
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data._id;
  const pos = await ctx.request(`/installations/${id}/pos`, {
    method: "PUT",
    session: admin,
    body: { rev: 0, config: config(`bind-cafe-${n}`, `cafe${n}.example.com`) },
  });
  assert.equal(pos.status, 200, JSON.stringify(pos.data));
  return { id, rev: pos.data.pos.rev, host: `cafe${n}.example.com`, n };
}

describe("health stats token host binding", () => {
  before(async () => {
    ctx = await startApp({ dbName: "phase2_bind" });
    owner = await ctx.login("owner@example.test");
    admin = await ctx.login("admin@example.test");
  });
  after(async () => ctx?.stop());

  it("saving the token binds it to the current host; a host change does not move it", async () => {
    const { id, rev, host, n } = await posInstallation();
    const saved = await ctx.request(`/installations/${id}/pos/secret`, {
      method: "PUT",
      session: admin,
      body: { rev, field: "generated.healthStatsToken", value: TOKEN },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal((await installation(id)).pos.statsHost, host);
    assert.equal(JSON.stringify(saved.data).includes("statsHost"), false);
    // another secret does not touch the binding
    const other = await ctx.request(`/installations/${id}/pos/secret`, {
      method: "PUT",
      session: admin,
      body: {
        rev: saved.data.pos.rev,
        field: "generated.authSecret",
        value: "auth-secret-plain-0123456789abcdef",
      },
    });
    assert.equal(other.status, 200, JSON.stringify(other.data));
    assert.equal((await installation(id)).pos.statsHost, host);
    // the config form changes the host, never the binding
    const moved = await ctx.request(`/installations/${id}/pos`, {
      method: "PUT",
      session: admin,
      body: {
        rev: other.data.pos.rev,
        config: config(`bind-cafe-${n}`, "attacker.example.net"),
      },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    const row = await installation(id);
    assert.equal(row.pos.host, "attacker.example.net");
    assert.equal(row.pos.statsHost, host);
    // removing the token (owner, step-up) clears the binding
    await stepUp(owner);
    const removed = await ctx.request(`/installations/${id}/pos/secret`, {
      method: "DELETE",
      session: owner,
      body: { rev: moved.data.pos.rev, field: "generated.healthStatsToken" },
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal((await installation(id)).pos.statsHost, null);
  });

  it("an import binds the imported token to the imported host", async () => {
    const slug = `bind-import-${++counter}`;
    const client = { ...structuredClone(FIXTURE), slug, subdomain: slug };
    const profile = { name: "fixture-cafe", entry: PROFILES["fixture-cafe"] };
    const preview = await ctx.request("/pos/import/preview", {
      method: "POST",
      session: owner,
      body: { client, profile },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    const done = await ctx.request("/pos/import/confirm", {
      method: "POST",
      session: owner,
      body: {
        client,
        profile,
        digest: preview.data.digest,
        customer: {
          mode: "new",
          name: "Bind Import",
          email: `${slug}@example.test`,
          company: "Bind Import Co",
          phone: "",
        },
      },
    });
    assert.equal(done.status, 201, JSON.stringify(done.data));
    const row = await installation(done.data.installationId);
    assert.ok(row.pos.generated.healthStatsToken);
    assert.equal(typeof row.pos.host, "string");
    assert.equal(row.pos.statsHost, row.pos.host);
  });

  it("legacy blocks are bound once to their current host; nothing else changes", async () => {
    const coll = ctx.db.collection("installations");
    const legacy = randomUUID(),
      bound = randomUUID(),
      noToken = randomUUID();
    const box = (id) =>
      encrypt(TOKEN, VAULT_KEY, `pos:${id}:generated.healthStatsToken`);
    await coll.insertMany([
      {
        _id: legacy,
        customerId: randomUUID(),
        productId: "p",
        environment: `e-${legacy}`,
        pos: {
          rev: 3,
          host: "legacy.example.com",
          generated: { healthStatsToken: box(legacy) },
        },
      },
      {
        _id: bound,
        customerId: randomUUID(),
        productId: "p",
        environment: `e-${bound}`,
        pos: {
          rev: 3,
          host: "new.example.com",
          statsHost: "old.example.com",
          generated: { healthStatsToken: box(bound) },
        },
      },
      {
        _id: noToken,
        customerId: randomUUID(),
        productId: "p",
        environment: `e-${noToken}`,
        pos: { rev: 3, host: "none.example.com", generated: {} },
      },
    ]);
    assert.ok((await bindLegacyStatsHosts(ctx.db)) >= 1);
    assert.equal(
      (await installation(legacy)).pos.statsHost,
      "legacy.example.com",
    );
    assert.equal((await installation(legacy)).pos.rev, 3);
    assert.equal((await installation(bound)).pos.statsHost, "old.example.com");
    assert.equal((await installation(noToken)).pos.statsHost, undefined);
    assert.equal(await bindLegacyStatsHosts(ctx.db), 0, "idempotent");
    const event = await ctx.db
      .collection("audit_events")
      .findOne({ action: "pos.stats-bound" });
    assert.ok(event);
  });
});
