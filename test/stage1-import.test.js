import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startApp, assertNoSecrets, VAULT_KEY } from "./helpers.js";
import { decrypt } from "../backend/lib/crypto.js";
import { mongoTarget } from "../backend/lib/pos-import.js";
import { POS_SECRET_FIELDS } from "../shared/schemas.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/pos-client.json", import.meta.url), "utf8"),
);
const PROFILES = JSON.parse(
  readFileSync(
    new URL("./fixtures/pos-profiles.json", import.meta.url),
    "utf8",
  ),
);
const profile = (name) => ({ name, entry: PROFILES[name] });
const PLAINTEXTS = [
  FIXTURE.vercel.token,
  FIXTURE.cloudflare.token,
  FIXTURE.cloudflare.publishSecret,
  FIXTURE.mongodbUri,
  "test-mongo-pw-GGGG4444",
  "fixtureuser",
  FIXTURE.admin.password,
  FIXTURE.image.accessKeyId,
  FIXTURE.image.secretAccessKey,
  FIXTURE.accounts.vercel.password,
  FIXTURE.accounts.atlas.password,
  FIXTURE.accounts.images.password,
  FIXTURE.accounts.other,
  "test-other-login-TTTT1212",
  FIXTURE.generated.authSecret,
  FIXTURE.generated.healthStatsToken,
  FIXTURE.notes,
  "test-notes-password-UUUU1313",
  PROFILES["other-cafe"].token,
  VAULT_KEY,
];
const MISSING = "00000000-0000-4000-8000-000000000000";

let ctx,
  owner,
  admin,
  operations,
  viewer,
  counter = 0;
const clientOf = (slug, patch = {}) => ({
  ...structuredClone(FIXTURE),
  slug,
  subdomain: slug,
  ...patch,
});
const uniqueSlug = () => `import-cafe-${++counter}`;
const preview = (body, session = owner) =>
  ctx.request("/pos/import/preview", { method: "POST", body, session });
const confirm = (body, session = owner) =>
  ctx.request("/pos/import/confirm", { method: "POST", body, session });
const newCustomer = (email) => ({
  mode: "new",
  name: "Fiona Fixture",
  email,
  company: "Fixture Cafe",
  phone: "+91 90000 11111",
});
// preview -> confirm with the digest the server issued.
async function doImport(client, customer, prof = profile("fixture-cafe")) {
  const first = await preview({ client, profile: prof });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  return confirm({
    client,
    profile: prof,
    digest: first.data.digest,
    customer,
  });
}
const rawPost = (path, text, session = owner) =>
  fetch(`${ctx.origin}/api${path}`, {
    method: "POST",
    headers: {
      Origin: ctx.origin,
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrf,
    },
    body: text,
  });
const countSlug = (slug) =>
  ctx.db.collection("installations").countDocuments({ "pos.slug": slug });
const at = (o, path) => path.split(".").reduce((v, p) => v?.[p], o);

describe("POS import (preview + confirm)", () => {
  before(async () => {
    ctx = await startApp({ dbName: "import_test" });
    owner = await ctx.login("owner@example.test");
    admin = await ctx.login("admin@example.test");
    operations = await ctx.login("operations@example.test");
    viewer = await ctx.login("viewer@example.test");
  });
  after(() => ctx.stop());

  it("checks authentication before role on both routes", async () => {
    const body = { client: clientOf("x-auth"), profile: null };
    for (const path of ["/pos/import/preview", "/pos/import/confirm"]) {
      assert.equal(
        (await ctx.request(path, { method: "POST", body })).status,
        401,
      );
      for (const who of [admin, operations, viewer])
        assert.equal(
          (await ctx.request(path, { method: "POST", body, session: who }))
            .status,
          403,
        );
    }
  });

  it("previews masked values, secret flags, dropped fields and warnings", async () => {
    const res = await preview({
      client: clientOf(uniqueSlug()),
      profile: profile("fixture-cafe"),
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assertNoSecrets(res.data, PLAINTEXTS, "preview");
    assert.match(res.data.digest, /^[0-9a-f]{64}$/);
    const m = res.data.mapping;
    assert.deepEqual(m.mongo, {
      host: "cluster0.fixture.example.test",
      database: "fixture_pos",
    });
    assert.equal(m.deployLock, true);
    assert.equal(m.fileDeployLock, false);
    assert.equal(m.endpoint, "https://fixture-cafe.fixture.example.test");
    assert.equal(m.vercel.projectId, "prj_fixture0001");
    assert.equal(m.vercel.teamId, "team_fixture01");
    assert.equal(m.posAdmin.username, "fixtureadmin");
    assert.deepEqual(
      res.data.secrets.map((s) => s.target),
      POS_SECRET_FIELDS,
    );
    assert.ok(res.data.secrets.every((s) => s.present));
    assert.deepEqual(
      res.data.accounts.map((a) => [a.service, a.label, a.hasPassword]),
      [
        ["vercel", "Vercel account", true],
        ["atlas", "MongoDB Atlas account", true],
        ["r2", "Image storage account", true],
        ["other", "Other logins (imported)", true],
      ],
    );
    for (const path of [
      "notes",
      "tables",
      "cafe.tagline",
      "contact.whatsapp",
      "lastRun",
      "_readme",
      "generated.seededAt",
      "generated.realtime.sourceHash",
      "profile.app",
    ])
      assert.ok(res.data.dropped.includes(path), `${path} not dropped`);
    assert.equal(res.data.dropped.includes("cafe.name"), false);
    assert.ok(res.data.warnings.some((w) => /deployLock/.test(w)));
    assert.equal(res.data.existing, null);
    assert.equal(res.data.defaults.company, "Fixture Cafe");
    assert.equal(res.data.defaults.name, "Fiona Fixture");
  });

  it("warns when the profile token lives in an environment variable", async () => {
    const res = await preview({
      client: clientOf(uniqueSlug()),
      profile: profile("fixture-cafe-env"),
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.warnings.some((w) => /environment variable/.test(w)));
    assert.ok(res.data.dropped.includes("profile.tokenEnv"));
    assertNoSecrets(res.data, PLAINTEXTS, "preview");
    // Without a Vercel token anywhere the owner is told to enter it by hand.
    const client = clientOf(uniqueSlug());
    delete client.vercel.token;
    const bare = await preview({
      client,
      profile: profile("fixture-cafe-env"),
    });
    assert.ok(bare.data.warnings.some((w) => /by hand/.test(w)));
    assert.equal(
      bare.data.secrets.find((s) => s.target === "vercel.token").present,
      false,
    );
  });

  it("works without a profile entry", async () => {
    const res = await preview({
      client: clientOf(uniqueSlug()),
      profile: null,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.mapping.vercel.projectId, "prj_fixture0001");
  });

  it("rejects bad files with value-free messages", async () => {
    const rejects = async (body, pattern) => {
      const res = await preview(body);
      assert.equal(res.status, 400, JSON.stringify(res.data));
      assert.match(res.data.error, pattern);
      assertNoSecrets(res.data, PLAINTEXTS, "error");
    };
    // The selected profile points at another project than the file.
    await rejects(
      { client: clientOf(uniqueSlug()), profile: profile("other-cafe") },
      /different Vercel project/,
    );
    // Unknown top-level key.
    await rejects(
      { client: { ...clientOf(uniqueSlug()), mysteryKey: 1 }, profile: null },
      /mysteryKey/,
    );
    // Placeholders left over from the example file.
    const placeholder = clientOf(uniqueSlug());
    placeholder.vercel.token = "<vercel-token>";
    await rejects({ client: placeholder, profile: null }, /placeholder/);
    const uri = clientOf(uniqueSlug(), {
      mongodbUri: "mongodb+srv://<user>:<password>@<cluster>.mongodb.net/pos",
    });
    await rejects({ client: uri, profile: null }, /mongodbUri.*placeholder/);
    // Weak admin password, bad slug, not an object, bad profile name.
    const weak = clientOf(uniqueSlug());
    weak.admin.password = "weakpassword";
    await rejects({ client: weak, profile: null }, /posAdmin\.password/);
    await rejects({ client: clientOf("Bad Slug!"), profile: null }, /slug/);
    await rejects({ client: "nope", profile: null }, /client: /);
    await rejects(
      {
        client: clientOf(uniqueSlug()),
        profile: { name: "bad name!", entry: {} },
      },
      /profile.name/,
    );
    const keys = clientOf(uniqueSlug());
    delete keys.image.secretAccessKey;
    await rejects({ client: keys, profile: null }, /image\.keys/);
  });

  it("rejects malformed JSON", async () => {
    const res = await rawPost("/pos/import/preview", '{"client": {');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Malformed JSON/);
  });

  it("allows 128 kb for import but keeps 32 kb elsewhere", async () => {
    const big = clientOf(uniqueSlug(), { notes: "n".repeat(60000) });
    assert.equal((await preview({ client: big, profile: null })).status, 200);
    const huge = clientOf(uniqueSlug(), { notes: "n".repeat(140000) });
    assert.equal((await preview({ client: huge, profile: null })).status, 413);
    const other = await ctx.request("/customers", {
      method: "POST",
      session: owner,
      body: { name: "Big", notes: "n".repeat(60000) },
    });
    assert.equal(other.status, 413);
  });

  it("creates a new customer, installation, pos block and accounts", async () => {
    const slug = uniqueSlug(),
      client = clientOf(slug);
    const res = await doImport(
      client,
      newCustomer("new-owner@fixture.example.test"),
    );
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.deepEqual(Object.keys(res.data).sort(), [
      "customerId",
      "installationId",
    ]);
    assertNoSecrets(res.data, PLAINTEXTS, "confirm");
    const { customerId, installationId } = res.data;

    const customer = await ctx.db
      .collection("customers")
      .findOne({ _id: customerId });
    assert.equal(customer.email, "new-owner@fixture.example.test");
    assert.equal(customer.company, "Fixture Cafe");
    assert.equal(customer.accounts.length, 4);
    const other = customer.accounts.find(
      (a) => a.label === "Other logins (imported)",
    );
    assert.equal(
      decrypt(
        other.password,
        VAULT_KEY,
        `account:${customerId}:${other.id}:password`,
      ),
      FIXTURE.accounts.other,
    );
    const vercel = customer.accounts.find((a) => a.service === "vercel");
    assert.equal(vercel.login, FIXTURE.accounts.vercel.email);
    assert.equal(
      decrypt(
        vercel.password,
        VAULT_KEY,
        `account:${customerId}:${vercel.id}:password`,
      ),
      FIXTURE.accounts.vercel.password,
    );
    // The stored account entries never hold a plaintext.
    const stored = JSON.stringify(customer);
    for (const value of PLAINTEXTS.filter((v) => v !== VAULT_KEY))
      assert.equal(stored.includes(value), false);

    const installation = await ctx.db
      .collection("installations")
      .findOne({ _id: installationId });
    assert.equal(installation.status, "planned");
    assert.equal(installation.environment, "production");
    assert.equal(
      installation.endpoint,
      "https://fixture-cafe.fixture.example.test",
    );
    assert.equal(installation.pos.slug, slug);
    assert.equal(installation.pos.deployLock, true);
    const expected = {
      "vercel.token": FIXTURE.vercel.token,
      "mongo.uri": FIXTURE.mongodbUri,
      "cloudflare.token": FIXTURE.cloudflare.token,
      "image.keys": JSON.stringify({
        accessKeyId: FIXTURE.image.accessKeyId,
        secretAccessKey: FIXTURE.image.secretAccessKey,
      }),
      "generated.authSecret": FIXTURE.generated.authSecret,
      "generated.healthStatsToken": FIXTURE.generated.healthStatsToken,
      "generated.realtimePublishSecret": FIXTURE.cloudflare.publishSecret,
      "posAdmin.password": FIXTURE.admin.password,
    };
    for (const field of POS_SECRET_FIELDS)
      assert.equal(
        decrypt(
          at(installation.pos, field),
          VAULT_KEY,
          `pos:${installationId}:${field}`,
        ),
        expected[field],
        field,
      );

    // The audit trail records the import without any secret or file name.
    const events = await ctx.db
      .collection("audit_events")
      .find({ resourceId: { $in: [customerId, installationId] } })
      .toArray();
    assert.ok(events.some((e) => e.action === "pos.imported"));
    assert.equal(events.filter((e) => e.action === "record.created").length, 2);
    const text = JSON.stringify(events);
    for (const value of PLAINTEXTS)
      assert.equal(text.includes(value), false, "audit holds a secret");
    assert.equal(/\.json/.test(text), false);

    // The workspace views show flags only.
    const view = await ctx.request(`/installations/${installationId}/pos`, {
      session: owner,
    });
    assertNoSecrets(view.data, PLAINTEXTS, "pos view");
    assert.equal(view.data.pos.secrets["mongo.uri"].set, true);
    const list = await ctx.request(`/customers/${customerId}/accounts`, {
      session: owner,
    });
    assertNoSecrets(list.data, PLAINTEXTS, "accounts");
    assert.equal(list.data.rows.length, 4);

    // Preview now reports it as already imported.
    const again = await preview({ client, profile: null });
    assert.equal(again.data.existing.customerId, customerId);
    assert.equal(again.data.existing.installationId, installationId);
  });

  it("rejects a confirm whose digest does not match the file", async () => {
    const client = clientOf(uniqueSlug());
    const first = await preview({ client, profile: null });
    const customer = newCustomer("digest@fixture.example.test");
    const changed = await confirm({
      client: clientOf(client.slug, { notes: "different" }),
      profile: null,
      digest: first.data.digest,
      customer,
    });
    assert.equal(changed.status, 400);
    assert.match(changed.data.error, /Preview it again/);
    const wrongProfile = await confirm({
      client,
      profile: profile("fixture-cafe"),
      digest: first.data.digest,
      customer,
    });
    assert.equal(wrongProfile.status, 400);
    const garbage = await confirm({
      client,
      profile: null,
      digest: "f".repeat(64),
      customer,
    });
    assert.equal(garbage.status, 400);
    assert.equal(await countSlug(client.slug), 0);
  });

  it("refuses to import the same client twice", async () => {
    const client = clientOf(uniqueSlug());
    assert.equal(
      (await doImport(client, newCustomer("twice-a@fixture.example.test")))
        .status,
      201,
    );
    const second = await doImport(
      client,
      newCustomer("twice-b@fixture.example.test"),
    );
    assert.equal(second.status, 409);
    assert.match(second.data.error, /already imported/);
    assert.equal(second.data.code, undefined);
    assert.equal(
      await ctx.db
        .collection("customers")
        .countDocuments({ email: "twice-b@fixture.example.test" }),
      0,
    );
  });

  it("answers 409 for a taken customer email and creates nothing", async () => {
    const taken = await ctx.request("/customers", {
      method: "POST",
      session: owner,
      body: {
        name: "Taken Person",
        email: "taken@fixture.example.test",
        company: "",
        phone: "",
        status: "active",
        notes: "",
        storeWorkspaceId: "",
      },
    });
    assert.equal(taken.status, 201);
    const client = clientOf(uniqueSlug());
    const res = await doImport(
      client,
      newCustomer("TAKEN@fixture.example.test"),
    );
    assert.equal(res.status, 409);
    assert.match(res.data.error, /already exists/);
    assert.equal(await countSlug(client.slug), 0);
  });

  it("attaches to an existing customer and reuses its installation", async () => {
    const created = await ctx.request("/customers", {
      method: "POST",
      session: owner,
      body: {
        name: "Fiona Fixture",
        email: "attach@fixture.example.test",
        company: "Fixture Cafe",
        phone: "",
        status: "active",
        notes: "",
        storeWorkspaceId: "",
      },
    });
    const customerId = created.data._id;
    const product = await ctx.db
      .collection("products")
      .findOne({ slug: "pos" });
    const inst = await ctx.request("/installations", {
      method: "POST",
      session: owner,
      body: {
        name: "Existing POS",
        customerId,
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
    assert.equal(inst.status, 201, JSON.stringify(inst.data));
    const client = clientOf(uniqueSlug());
    // The preview offers the customer as a match by name and company.
    const pre = await preview({ client, profile: null });
    assert.ok(pre.data.customerMatches.some((m) => m.id === customerId));
    assertNoSecrets(pre.data, PLAINTEXTS, "preview");
    const res = await doImport(client, { mode: "existing", customerId });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.customerId, customerId);
    assert.equal(res.data.installationId, inst.data._id);
    assert.equal(
      await ctx.db
        .collection("installations")
        .countDocuments({ customerId, productId: product._id }),
      1,
    );
    // Another slug cannot take the same installation: it already has a block.
    const clash = await doImport(clientOf(uniqueSlug()), {
      mode: "existing",
      customerId,
    });
    assert.equal(clash.status, 409);
    const missing = await doImport(clientOf(uniqueSlug()), {
      mode: "existing",
      customerId: MISSING,
    });
    assert.equal(missing.status, 404);
  });

  it("never duplicates accounts when a client is imported again", async () => {
    const client = clientOf(uniqueSlug());
    const first = await doImport(
      client,
      newCustomer("dedupe@fixture.example.test"),
    );
    assert.equal(first.status, 201);
    const { customerId, installationId } = first.data;
    // The owner removed the POS block (a stepped-up action) and imports again.
    await ctx.db
      .collection("installations")
      .updateOne({ _id: installationId }, { $unset: { pos: "" } });
    const second = await doImport(client, { mode: "existing", customerId });
    assert.equal(second.status, 201, JSON.stringify(second.data));
    assert.equal(second.data.installationId, installationId);
    const row = await ctx.db
      .collection("customers")
      .findOne({ _id: customerId });
    assert.equal(row.accounts.length, 4);
    assert.equal(new Set(row.accounts.map((a) => a.importKey)).size, 4);
  });

  it("lets only one of two parallel confirms win", async () => {
    const client = clientOf(uniqueSlug());
    const pre = await preview({ client, profile: null });
    const same = {
      client,
      profile: null,
      digest: pre.data.digest,
      customer: newCustomer("parallel@fixture.example.test"),
    };
    const results = await Promise.all([confirm(same), confirm(same)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await countSlug(client.slug), 1);
    assert.equal(
      await ctx.db
        .collection("customers")
        .countDocuments({ email: "parallel@fixture.example.test" }),
      1,
    );
    // The same race against one existing customer.
    const made = await doImport(
      clientOf(uniqueSlug()),
      newCustomer("parallel2@fixture.example.test"),
    );
    await ctx.db
      .collection("installations")
      .updateOne({ _id: made.data.installationId }, { $unset: { pos: "" } });
    const c2 = clientOf(uniqueSlug());
    const p2 = await preview({ client: c2, profile: null });
    const body = {
      client: c2,
      profile: null,
      digest: p2.data.digest,
      customer: { mode: "existing", customerId: made.data.customerId },
    };
    const again = await Promise.all([confirm(body), confirm(body)]);
    assert.deepEqual(again.map((r) => r.status).sort(), [201, 409]);
  });

  it("refuses when the POS product is retired", async () => {
    const product = await ctx.db
      .collection("products")
      .findOne({ slug: "pos" });
    await ctx.db
      .collection("products")
      .updateOne({ _id: product._id }, { $set: { status: "retired" } });
    try {
      const res = await doImport(
        clientOf(uniqueSlug()),
        newCustomer("retired@fixture.example.test"),
      );
      assert.equal(res.status, 409);
      assert.match(res.data.error, /retired/);
    } finally {
      await ctx.db
        .collection("products")
        .updateOne({ _id: product._id }, { $set: { status: product.status } });
    }
  });

  it("imports a file with no cloudflare, image or accounts", async () => {
    const client = clientOf(uniqueSlug(), {
      cloudflare: null,
      image: null,
      accounts: { vercel: { email: "", password: "" }, other: "" },
      deployLock: true,
    });
    delete client.generated.realtime;
    const res = await doImport(
      client,
      newCustomer("lean@fixture.example.test"),
    );
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const row = await ctx.db
      .collection("installations")
      .findOne({ _id: res.data.installationId });
    assert.equal(row.pos.cloudflare, null);
    assert.equal(row.pos.image.keys, null);
    const customer = await ctx.db
      .collection("customers")
      .findOne({ _id: res.data.customerId });
    assert.equal((customer.accounts ?? []).length, 0);
  });

  it("lists every unknown nested value as not imported", async () => {
    const client = clientOf(uniqueSlug());
    client.accounts.vercel.totpKey = "test-totp-key-VVVV1414";
    client.accounts.vercel.backupCodes = ["test-backup-WWWW1515"];
    client.image.extraSecret = "test-extra-secret-XXXX1616";
    client.demo = true;
    client.generated.previousHosting = [{ host: "old.example.test" }];
    client.generated.realtime.accountId = "acct";
    client.generated.realtime.deployedAt = "2026-01-01";
    client.generated.realtime.tenantId = "t";
    client.generated.realtime.verifiedAt = "2026-01-02";
    const res = await preview({ client, profile: profile("fixture-cafe") });
    assert.equal(res.status, 200);
    assertNoSecrets(
      res.data,
      [...PLAINTEXTS, "test-totp-key-VVVV1414", "test-backup-WWWW1515"],
      "preview",
    );
    assert.deepEqual(res.data.dropped, [
      "_readme",
      "accounts.vercel.backupCodes",
      "accounts.vercel.totpKey",
      "cafe.address",
      "cafe.gst",
      "cafe.mobile",
      "cafe.receiptFooter",
      "cafe.tagline",
      "contact.whatsapp",
      "demo",
      "generated.previousHosting",
      "generated.realtime.accountId",
      "generated.realtime.deployedAt",
      "generated.realtime.sourceHash",
      "generated.realtime.tenantId",
      "generated.realtime.verifiedAt",
      "generated.seededAt",
      "generated.webAddress",
      "image.extraSecret",
      "lastRun",
      "notes",
      "profile.app",
      "tables",
    ]);
  });

  it("shows only host and database of a Mongo URI", () => {
    const cases = [
      ["mongodb+srv://u:p@h.example.test/db?x=1", "h.example.test", "db"],
      ["mongodb://h.example.test:27017/db", "h.example.test:27017", "db"],
      ["mongodb://u:p@a:1,b:2/db?replicaSet=r", "a:1,b:2", "db"],
      [
        "mongodb+srv://user:p@ss@host.example.test/db",
        "host.example.test",
        "db",
      ],
      [
        "mongodb://u:p@h.example.test/db?authSource=a@b",
        "h.example.test",
        "db",
      ],
    ];
    for (const [uri, host, database] of cases)
      assert.deepEqual(mongoTarget(uri), { host, database }, uri);
    for (const uri of [
      "mongodb://user:pa/ss@host.example.test/db",
      "mongodb://user:pa/ss@host.example.test",
      "mongodb+srv://u:p@host.example.test",
      "nonsense",
    ]) {
      const out = mongoTarget(uri);
      assert.deepEqual(out, { host: "(unparsed)", database: "" }, uri);
    }
  });

  it("matches the import routes case-insensitively for the body limit", async () => {
    const big = clientOf(uniqueSlug(), { notes: "n".repeat(60000) });
    const odd = await ctx.request("/POS/Import/PREVIEW/", {
      method: "POST",
      session: owner,
      body: { client: big, profile: null },
    });
    assert.equal(odd.status, 200);
    const other = await ctx.request("/CUSTOMERS", {
      method: "POST",
      session: owner,
      body: { name: "Big", notes: "n".repeat(60000) },
    });
    assert.equal(other.status, 413);
    const sibling = await ctx.request("/pos/import/preview/extra", {
      method: "POST",
      session: owner,
      body: { notes: "n".repeat(60000) },
    });
    assert.equal(sibling.status, 413);
  });

  it("explains a half image key pair without echoing it", async () => {
    const r2 = clientOf(uniqueSlug());
    delete r2.image.secretAccessKey;
    const a = await preview({ client: r2, profile: null });
    assert.equal(a.status, 400);
    assert.match(a.data.error, /Image keys are incomplete.*R2/);
    assertNoSecrets(a.data, PLAINTEXTS, "error");
    const cl = clientOf(uniqueSlug(), {
      image: {
        store: "cloudinary",
        cloudName: "fixturecloud",
        apiKey: "test-cl-key-YYYY1717",
      },
    });
    const b = await preview({ client: cl, profile: null });
    assert.equal(b.status, 400);
    assert.match(b.data.error, /incomplete.*Cloudinary/);
    assert.equal(b.data.error.includes("test-cl-key"), false);
  });
});
