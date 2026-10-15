// P5 Stage 3 W2b (docs/P5-STAGE3-PLAN.md §7, §11, D46): the Cloudflare REST
// adapter for the realtime Worker, provider-http's multipart `form`, safe-https
// `postText` and the TLS probe, and the reusable fake DNS driving createDnsCheck.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MAX_FORM_BYTES,
  ProviderError,
  request,
} from "../backend/lib/provider-http.js";
import {
  MAX_UPLOAD_BYTES,
  accounts,
  enableWorkersDev,
  registerWorkersSubdomain,
  scriptSettings,
  tokenAccess,
  tokenStatus,
  uploadWorker,
  workerMigrationTag,
  workersSubdomain,
} from "../backend/lib/cloudflare.js";
import {
  JOIN_PROBE_STATUS,
  parseRealtimeDescriptor,
  publishVerdict,
  signedPublishRequest,
  uploadMetadataOf,
  workerNameOf,
} from "../backend/lib/realtime.js";
import {
  MAX_POST_BYTES,
  SafeHttpsError,
  getText,
  postText,
  probeTls,
} from "../backend/lib/safe-https.js";
import { createDnsCheck } from "../backend/lib/dns-check.js";
import { assertNoSecrets } from "./helpers.js";
import { json } from "./fakes/github.js";
import {
  ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
  createFakeCloudflare,
} from "./fakes/cloudflare.js";
import { createFakeDns } from "./fakes/dns.js";

const TOKEN = "cfut_SECRETCLOUDFLARETOKEN0123456789abcdef";
const PUBLISH_SECRET = "f".repeat(32) + "0123456789abcdef0123456789abcdef";
const SECRETS = [TOKEN, PUBLISH_SECRET, "SECRET-PROVIDER-TEXT-do-not-leak"];
const noSleep = async () => {};
const NAME = workerNameOf("p5spike");
const BUNDLE = Buffer.from(
  "export default { fetch() { return new Response('x'); } };\n",
);
const descriptor = parseRealtimeDescriptor({
  v: 1,
  main: "index.js",
  compatibilityDate: "2026-01-01",
  compatibilityFlags: [],
  durableObjects: [{ name: "CAFE_ROOM", className: "CafeRoom" }],
  migrations: [{ tag: "v1", newSqliteClasses: ["CafeRoom"] }],
  bundleSha256: createHash("sha256").update(BUNDLE).digest("hex"),
  bundleBytes: BUNDLE.length,
});
const metaFor = (migrationTag, tenantId = "p5spike") =>
  uploadMetadataOf(descriptor, {
    tenantId,
    publishSecret: PUBLISH_SECRET,
    migrationTag,
  });
const rejects = async (promise, check) => {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected a rejection");
  check?.(caught);
  return caught;
};
const opts = (fake) => ({ fetch: fake.fetch, sleep: noSleep });
const upload = (fake, extra = {}, tag = null) =>
  uploadWorker(
    TOKEN,
    {
      accountId: ACCOUNT_ID,
      name: NAME,
      bundle: BUNDLE,
      metadata: metaFor(tag),
      ...extra,
    },
    opts(fake),
  );
// No property or stack of an error carries a secret.
const clean = (error) =>
  assertNoSecrets(
    { m: error.message, s: error.stack, e: { ...error } },
    SECRETS,
    "error",
  );

describe("provider-http multipart form", () => {
  const formOf = (bytes = 10) => {
    const form = new FormData();
    form.set(
      "a",
      new Blob(["x".repeat(bytes)], { type: "text/plain" }),
      "a.txt",
    );
    return form;
  };
  const record = (response = () => json(200, { ok: true })) => {
    const seen = [];
    return {
      seen,
      fetch: async (url, init) => (seen.push({ url, init }), response()),
    };
  };
  it("sends a multipart body with the boundary content type", async () => {
    const f = record();
    await request({
      provider: "cloudflare",
      path: "/accounts",
      method: "PUT",
      token: TOKEN,
      form: formOf(),
      fetch: f.fetch,
    });
    const { init } = f.seen[0];
    assert.match(
      init.headers["content-type"],
      /^multipart\/form-data; boundary=/,
    );
    assert.ok(Buffer.isBuffer(init.body));
    assert.match(init.body.toString(), /name="a"; filename="a.txt"/);
    assert.equal(init.redirect, "manual");
  });
  it("refuses a request over 2 MB before sending anything", async () => {
    const f = record();
    const big = formOf(MAX_FORM_BYTES + 1);
    const e = await rejects(
      request({
        provider: "cloudflare",
        path: "/x",
        method: "PUT",
        token: TOKEN,
        form: big,
        fetch: f.fetch,
      }),
    );
    assert.equal(e.code, "invalid");
    assert.equal(f.seen.length, 0);
    await request({
      provider: "cloudflare",
      path: "/x",
      method: "PUT",
      token: TOKEN,
      form: formOf(MAX_FORM_BYTES - 1024),
      fetch: f.fetch,
    });
    assert.equal(f.seen.length, 1);
  });
  it("refuses body + form together and a non-FormData form", async () => {
    const f = record();
    for (const extra of [
      { form: formOf(), body: { a: 1 } },
      { form: { a: 1 } },
      { form: "text" },
    ])
      await rejects(
        request({
          provider: "cloudflare",
          path: "/x",
          method: "PUT",
          token: TOKEN,
          fetch: f.fetch,
          ...extra,
        }),
        (e) => assert.equal(e.code, "invalid"),
      );
    assert.equal(f.seen.length, 0);
  });
  it("does not retry a non-idempotent multipart upload; an idempotent one retries with the same bytes", async () => {
    let n = 0;
    const bodies = [];
    const fetch = async (url, init) => {
      n++;
      bodies.push(init.body);
      return n < 3 ? json(503, { success: false }) : json(200, { ok: true });
    };
    const once = await rejects(
      request({
        provider: "cloudflare",
        path: "/x",
        method: "PUT",
        token: TOKEN,
        form: formOf(),
        fetch,
        sleep: noSleep,
      }),
    );
    assert.equal(once.code, "unavailable");
    assert.equal(n, 1);
    n = 0;
    bodies.length = 0;
    await request({
      provider: "cloudflare",
      path: "/x",
      method: "PUT",
      token: TOKEN,
      form: formOf(),
      idempotent: true,
      fetch,
      sleep: noSleep,
    });
    assert.equal(n, 3);
    assert.ok(bodies.every((b) => b.equals(bodies[0])));
  });
  it("times out a hung upload with a fixed code", async () => {
    // AbortSignal.timeout's timer is unref'd; a real socket keeps the loop alive.
    const fetch = (url, init) =>
      new Promise((resolve, reject) => {
        const keep = setTimeout(resolve, 5000);
        init.signal.addEventListener("abort", () => {
          clearTimeout(keep);
          reject(init.signal.reason);
        });
      });
    const e = await rejects(
      request({
        provider: "cloudflare",
        path: "/x",
        method: "PUT",
        token: TOKEN,
        form: formOf(),
        timeoutMs: 20,
        fetch,
        sleep: noSleep,
      }),
    );
    assert.equal(e.code, "timeout");
    clean(e);
  });
  it("JSON callers are unchanged and numeric Cloudflare codes are kept (no text)", async () => {
    const f = record(() => json(200, { ok: true }));
    await request({
      provider: "cloudflare",
      path: "/x",
      method: "POST",
      token: TOKEN,
      body: { a: 1 },
      fetch: f.fetch,
    });
    assert.equal(f.seen[0].init.headers["content-type"], "application/json");
    assert.equal(f.seen[0].init.body, '{"a":1}');
    const e = await rejects(
      request({
        provider: "cloudflare",
        path: "/x",
        token: TOKEN,
        fetch: async () =>
          json(403, {
            errors: [
              { code: 9109, message: "SECRET-PROVIDER-TEXT-do-not-leak" },
              { code: "x" },
            ],
          }),
      }),
    );
    assert.deepEqual(e.providerCodes, [9109]);
    assert.equal(e.providerCode, "");
    clean(e);
    const plain = await rejects(
      request({
        provider: "cloudflare",
        path: "/x",
        token: TOKEN,
        fetch: async () => json(404, {}),
      }),
    );
    assert.deepEqual(plain.providerCodes, []);
  });
});

describe("cloudflare accounts, workers.dev subdomain, token access", () => {
  it("accounts returns ids only", async () => {
    const fake = createFakeCloudflare({
      accountList: [
        {
          id: ACCOUNT_ID,
          name: "Secret Name",
          type: "standard",
          settings: { a: 1 },
        },
        { id: "not-an-id", name: "bad" },
        { id: OTHER_ACCOUNT_ID },
      ],
    });
    const list = await accounts(TOKEN, opts(fake));
    assert.deepEqual(list, [{ id: ACCOUNT_ID }, { id: OTHER_ACCOUNT_ID }]);
    assertNoSecrets(list, ["Secret Name"]);
    assert.equal(fake.calls[0].path, "/client/v4/accounts");
  });
  it("accounts: 403/9109 is a token-permission code (cloudflare-denied); 401 stays unauthorized", async () => {
    const e = await rejects(
      accounts(TOKEN, opts(createFakeCloudflare({ accountsGrant: false }))),
    );
    assert.equal(e.code, "denied");
    assert.equal(e.status, 403);
    clean(e);
    const e2 = await rejects(
      accounts(TOKEN, opts(createFakeCloudflare({ access: "future-401" }))),
    );
    assert.equal(e2.code, "unauthorized");
    // A 403 without 9109 keeps its plain code.
    const e3 = await rejects(
      accounts(TOKEN, {
        fetch: async () => json(403, { errors: [{ code: 1 }] }),
      }),
    );
    assert.equal(e3.code, "forbidden");
  });
  it("workersSubdomain: present, none yet (404), and a hostile value is refused", async () => {
    assert.deepEqual(
      await workersSubdomain(TOKEN, ACCOUNT_ID, opts(createFakeCloudflare())),
      { subdomain: "fake-sub" },
    );
    assert.deepEqual(
      await workersSubdomain(
        TOKEN,
        ACCOUNT_ID,
        opts(createFakeCloudflare({ subdomain: null })),
      ),
      { subdomain: null },
    );
    const evil = {
      fetch: async () => json(200, { result: { subdomain: "a.evil.com/x" } }),
    };
    await rejects(workersSubdomain(TOKEN, ACCOUNT_ID, evil), (e) =>
      assert.equal(e.code, "bad-response"),
    );
    await rejects(
      workersSubdomain(TOKEN, "short", opts(createFakeCloudflare())),
      (e) => assert.equal(e.code, "invalid"),
    );
  });
  it("registerWorkersSubdomain registers, reports a taken name as conflict, never retries a PUT", async () => {
    const fake = createFakeCloudflare({
      subdomain: null,
      takenSubdomains: ["pos-taken"],
    });
    const e = await rejects(
      registerWorkersSubdomain(TOKEN, ACCOUNT_ID, "pos-taken", opts(fake)),
    );
    assert.equal(e.code, "conflict");
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(
      await registerWorkersSubdomain(
        TOKEN,
        ACCOUNT_ID,
        "pos-free-1a2b",
        opts(fake),
      ),
      { subdomain: "pos-free-1a2b" },
    );
    assert.equal(fake.state.subdomain, "pos-free-1a2b");
    for (const bad of ["", "Upper", "a.b", "-x", "x".repeat(64), 5, null])
      await rejects(
        registerWorkersSubdomain(TOKEN, ACCOUNT_ID, bad, opts(fake)),
        (er) => assert.equal(er.code, "invalid"),
      );
  });
  it("tokenAccess proves access with an account call: a future-dated token verifies active but fails here", async () => {
    for (const access of ["future-403", "future-401"]) {
      const fake = createFakeCloudflare({ access });
      const verify = await tokenStatus(TOKEN, "", {
        fetch: fake.fetch,
        sleep: noSleep,
      });
      assert.equal(verify.ok, true, "the verify call alone says active");
      assert.equal(verify.status, "active");
      for (const id of ["", ACCOUNT_ID]) {
        const r = await tokenAccess(TOKEN, id, opts(fake));
        assert.equal(r.ok, false);
        assert.equal(
          r.code,
          access === "future-403" ? "denied" : "unauthorized",
        );
        assertNoSecrets(r, SECRETS);
      }
    }
  });
  it("tokenAccess: ok with or without a stored account; missing permission and bad ids are reported", async () => {
    const fake = createFakeCloudflare();
    assert.deepEqual(await tokenAccess(TOKEN, "", opts(fake)), {
      ok: true,
      accountIds: [ACCOUNT_ID],
      subdomain: null,
    });
    assert.deepEqual(await tokenAccess(TOKEN, ACCOUNT_ID, opts(fake)), {
      ok: true,
      accountIds: [ACCOUNT_ID],
      subdomain: "fake-sub",
    });
    const none = createFakeCloudflare({ subdomain: null });
    assert.equal(
      (await tokenAccess(TOKEN, ACCOUNT_ID, opts(none))).subdomain,
      null,
    );
    const two = createFakeCloudflare({
      accountList: [{ id: ACCOUNT_ID }, { id: OTHER_ACCOUNT_ID }],
    });
    assert.deepEqual((await tokenAccess(TOKEN, "", opts(two))).accountIds, [
      ACCOUNT_ID,
      OTHER_ACCOUNT_ID,
    ]);
    // A stored id the token cannot see.
    const r = await tokenAccess(TOKEN, OTHER_ACCOUNT_ID, opts(fake));
    assert.deepEqual(r, { ok: false, code: "denied" });
    // No Account Settings: Read.
    assert.deepEqual(
      await tokenAccess(
        TOKEN,
        "",
        opts(createFakeCloudflare({ accountsGrant: false })),
      ),
      {
        ok: false,
        code: "denied",
      },
    );
    await rejects(tokenAccess(TOKEN, "nope", opts(fake)), (e) =>
      assert.equal(e.code, "invalid"),
    );
    // An outage is not an answer about the token.
    await rejects(
      tokenAccess(TOKEN, "", {
        fetch: async () => json(500, {}),
        sleep: noSleep,
      }),
      (e) => assert.equal(e.code, "unavailable"),
    );
  });
});

describe("cloudflare realtime Worker upload", () => {
  it("workerMigrationTag: null for a new script, the tag once uploaded", async () => {
    const fake = createFakeCloudflare();
    assert.equal(
      await workerMigrationTag(TOKEN, ACCOUNT_ID, NAME, opts(fake)),
      null,
    );
    await upload(fake, {}, null);
    assert.equal(
      await workerMigrationTag(TOKEN, ACCOUNT_ID, NAME, opts(fake)),
      "v1",
    );
    assert.ok(
      fake.calls.some((c) => c.path.includes(`/workers/services/${NAME}`)),
    );
  });
  it("workerMigrationTag falls back to the scripts list row when the service shows no tag", async () => {
    const fake = createFakeCloudflare({
      scripts: { [NAME]: { tag: "v7", bindings: [], compatibilityDate: null } },
      servicesShowTag: false,
    });
    assert.equal(
      await workerMigrationTag(TOKEN, ACCOUNT_ID, NAME, opts(fake)),
      "v7",
    );
    // The list has no row for another name, and a 404 services route + empty list = null.
    assert.equal(
      await workerMigrationTag(
        TOKEN,
        ACCOUNT_ID,
        "pos-realtime-other",
        opts(fake),
      ),
      null,
    );
    const e404 = { fetch: async () => json(404, { success: false }) };
    assert.equal(await workerMigrationTag(TOKEN, ACCOUNT_ID, NAME, e404), null);
    // A tag that is not a plain token is refused, not trusted.
    const hostile = {
      fetch: async () =>
        json(200, {
          result: {
            default_environment: { script: { migration_tag: "v1; drop" } },
          },
        }),
    };
    await rejects(workerMigrationTag(TOKEN, ACCOUNT_ID, NAME, hostile), (e) =>
      assert.equal(e.code, "bad-response"),
    );
    await rejects(
      workerMigrationTag(TOKEN, ACCOUNT_ID, "Bad Name", opts(fake)),
      (e) => assert.equal(e.code, "invalid"),
    );
  });
  it("uploads exactly the multipart shape of spike S2", async () => {
    const fake = createFakeCloudflare();
    const result = await upload(fake);
    assert.deepEqual(result, { name: NAME });
    const call = fake.calls.at(-1);
    assert.equal(call.method, "PUT");
    assert.equal(
      call.path,
      `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${NAME}`,
    );
    const [u] = fake.uploads;
    assert.deepEqual(u.fields, ["metadata", "index.js"]);
    assert.equal(u.metadataType, "application/json");
    assert.equal(u.moduleType, "application/javascript+module");
    assert.equal(u.moduleName, "index.js");
    assert.ok(u.bundle.equals(BUNDLE));
    assert.deepEqual(u.metadata, metaFor(null));
    assert.deepEqual(u.metadata.migrations.steps, [
      { new_sqlite_classes: ["CafeRoom"] },
    ]);
    assert.match(u.contentType, /^multipart\/form-data; boundary=/);
    assertNoSecrets(result, SECRETS);
  });
  it("second upload without migrations works; re-sending them at the current tag is refused (412/10079)", async () => {
    const fake = createFakeCloudflare();
    await upload(fake, {}, null);
    const tag = await workerMigrationTag(TOKEN, ACCOUNT_ID, NAME, opts(fake));
    assert.equal("migrations" in metaFor(tag), false);
    await upload(fake, { metadata: metaFor(tag) });
    assert.equal(fake.uploads.length, 2);
    const e = await rejects(upload(fake, { metadata: metaFor(null) }));
    assert.equal(e.code, "realtime-upload-failed");
    assert.equal(fake.uploads.length, 2, "nothing stored");
    clean(e);
  });
  it("maps every other failure to an existing code, with one attempt only", async () => {
    const cases = [
      [{ status: 422, code: 10021 }, "realtime-upload-failed"],
      [{ status: 400, code: 10021 }, "realtime-upload-failed"],
      [{ status: 401, code: 10000 }, "unauthorized"],
      [{ status: 403, code: 10000 }, "forbidden"],
      [{ status: 403, code: 9109 }, "denied"],
      [{ status: 429, code: 971 }, "rate-limited"],
      [{ status: 503, code: 1 }, "unavailable"],
    ];
    for (const [fail, code] of cases) {
      const fake = createFakeCloudflare();
      fake.state.uploadFail = fail;
      const e = await rejects(upload(fake));
      assert.equal(e.code, code, JSON.stringify(fail));
      assert.equal(fake.calls.length, 1, "no retry of a non-idempotent upload");
      clean(e);
    }
    const net = await rejects(
      uploadWorker(
        TOKEN,
        {
          accountId: ACCOUNT_ID,
          name: NAME,
          bundle: BUNDLE,
          metadata: metaFor(null),
        },
        {
          fetch: async () => {
            throw new TypeError("fetch failed");
          },
          sleep: noSleep,
        },
      ),
    );
    assert.equal(net.code, "network");
  });
  it("validates inputs before sending: size, name, account, metadata", async () => {
    const fake = createFakeCloudflare();
    const bad = [
      { bundle: Buffer.alloc(MAX_UPLOAD_BYTES + 1) },
      { bundle: Buffer.alloc(0) },
      { bundle: "text" },
      { name: "../x" },
      { name: "UPPER" },
      { accountId: "abc" },
      { metadata: null },
      { metadata: { main_module: "evil.js" } },
    ];
    for (const extra of bad)
      await rejects(upload(fake, extra), (e) =>
        assert.equal(e.code, "invalid"),
      );
    assert.equal(fake.calls.length, 0);
    await upload(fake, { bundle: Buffer.alloc(MAX_UPLOAD_BYTES, 1) });
    assert.equal(fake.calls.length, 1);
  });
  it("enableWorkersDev posts the enabled flag and returns only a boolean", async () => {
    const fake = createFakeCloudflare();
    await upload(fake);
    const r = await enableWorkersDev(TOKEN, ACCOUNT_ID, NAME, opts(fake));
    assert.deepEqual(r, { enabled: true });
    const call = fake.calls.at(-1);
    assert.equal(call.method, "POST");
    assert.ok(call.path.endsWith(`/workers/scripts/${NAME}/subdomain`));
    assert.deepEqual(call.body, { enabled: true, previews_enabled: false });
    assert.equal(fake.state.scripts[NAME].workersDev, true);
    await rejects(
      enableWorkersDev(TOKEN, ACCOUNT_ID, "pos-realtime-none", opts(fake)),
      (e) => assert.equal(e.code, "not-found"),
    );
  });
  it("scriptSettings returns binding names/types and the date only (no tenant text, no secret)", async () => {
    const fake = createFakeCloudflare();
    await upload(fake);
    const s = await scriptSettings(TOKEN, ACCOUNT_ID, NAME, opts(fake));
    assert.deepEqual(s, {
      bindings: [
        { name: "CAFE_ROOM", type: "durable_object_namespace" },
        { name: "TENANT_ID", type: "plain_text" },
        { name: "REALTIME_PUBLISH_SECRET", type: "secret_text" },
      ],
      compatibilityDate: "2026-01-01",
    });
    assertNoSecrets(s, [...SECRETS, "p5spike"]);
    assert.equal(JSON.stringify(s).includes("p5spike"), false);
    // The fake's raw settings DO carry the tenant text: the whitelist drops it.
    const raw = await (
      await fake.fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${NAME}/settings`,
        { redirect: "manual", headers: { authorization: `Bearer ${TOKEN}` } },
      )
    ).text();
    assert.ok(raw.includes("p5spike"));
    await rejects(
      scriptSettings(TOKEN, ACCOUNT_ID, "pos-realtime-none", opts(fake)),
      (e) => assert.equal(e.code, "not-found"),
    );
  });
});

describe("workers.dev probes through safe-https", () => {
  const HOST = `${NAME}.fake-sub.workers.dev`;
  const deployed = async (extra = {}) => {
    const fake = createFakeCloudflare(extra);
    await upload(fake);
    await enableWorkersDev(TOKEN, ACCOUNT_ID, NAME, opts(fake));
    return fake;
  };
  it("/join answers 426 only after the fake's propagation delay", async () => {
    const fake = await deployed({ joinAfter: 3 });
    const seen = [];
    for (let i = 0; i < 4; i++)
      seen.push((await getText(HOST, "/join", { send: fake.send })).status);
    assert.deepEqual(seen, [404, 404, 404, JOIN_PROBE_STATUS]);
  });
  it("signed publish: 200 for the right tenant + secret, 404 for another tenant, 401 for a wrong secret", async () => {
    const fake = await deployed();
    const publish = async (secret, tenant) => {
      const { body, headers } = signedPublishRequest(
        secret,
        tenant,
        Date.now(),
      );
      return (
        await postText(HOST, "/publish", body, { headers, send: fake.send })
      ).status;
    };
    const good = await publish(PUBLISH_SECRET, "p5spike");
    assert.equal(good, 200);
    assert.equal(publishVerdict(good), "ok");
    const other = await publish(PUBLISH_SECRET, "someone-else");
    assert.equal(other, 404);
    assert.equal(publishVerdict(other), "realtime-probe-failed");
    assert.equal(
      publishVerdict(await publish("wrong-secret-0123456789", "p5spike")),
      "realtime-secret-mismatch",
    );
  });
  it("a host that is not served on workers.dev is a connect failure", async () => {
    const fake = createFakeCloudflare();
    await rejects(getText(HOST, "/join", { send: fake.send }), (e) =>
      assert.equal(e.code, "network"),
    );
  });
  it("postText: fixed header allowlist, body <= 4 KB, same host/path guards, POST with the body", async () => {
    let seen;
    const send = async (o) => (
      (seen = o),
      { status: 200, headers: {}, text: "" }
    );
    const { body, headers } = signedPublishRequest(
      PUBLISH_SECRET,
      "t1",
      Date.now(),
    );
    await postText("pos-realtime-t1.sub.workers.dev", "/publish", body, {
      headers,
      send,
    });
    assert.equal(seen.method, "POST");
    assert.equal(seen.port, 443);
    assert.equal(seen.body, body);
    assert.equal(seen.path, "/publish");
    assert.equal(
      seen.headers["content-length"],
      String(Buffer.byteLength(body)),
    );
    assert.equal(seen.headers["content-type"], "application/json");
    assert.ok(typeof seen.lookup === "function");
    const code = (p) =>
      rejects(p, (e) => assert.ok(e instanceof SafeHttpsError));
    for (const h of [
      { authorization: "Bearer x" },
      { cookie: "a=b" },
      { host: "evil.test" },
      { "x-realtime-ts": "1\r\nX: y" },
      { "x-realtime-ts": 5 },
    ])
      assert.equal(
        (
          await code(
            postText("a.example.com", "/publish", "{}", { headers: h, send }),
          )
        ).code,
        "bad-header",
      );
    assert.equal(
      (
        await code(
          postText(
            "a.example.com",
            "/publish",
            "x".repeat(MAX_POST_BYTES + 1),
            { send },
          ),
        )
      ).code,
      "bad-body",
    );
    await postText("a.example.com", "/publish", "x".repeat(MAX_POST_BYTES), {
      send,
    });
    assert.equal(
      (await code(postText("a.example.com", "/publish", 5, { send }))).code,
      "bad-body",
    );
    assert.equal(
      (await code(postText("127.0.0.1", "/publish", "{}", { send }))).code,
      "bad-host",
    );
    assert.equal(
      (await code(postText("localhost", "/publish", "{}", { send }))).code,
      "bad-host",
    );
    for (const path of ["publish", "/a?x=1", "//evil.test", "/a/../b"])
      assert.equal(
        (await code(postText("a.example.com", path, "{}", { send }))).code,
        "bad-path",
      );
  });
});

describe("TLS probe", () => {
  it("any HTTP status is ok (the page is not judged)", async () => {
    for (const status of [200, 308, 404, 500]) {
      let seen;
      const send = async (o) => ((seen = o), { status, headers: {}, text: "" });
      assert.deepEqual(await probeTls("pos.example.com", { send }), {
        ok: true,
        status,
        code: null,
      });
      assert.equal(seen.method, "GET");
      assert.equal(seen.path, "/");
      assert.equal(seen.truncate, true, "a large page is cut off, not refused");
    }
  });
  it("a reset connection before the first deployment is cert-pending, not a throw", async () => {
    const send = async () => {
      throw new SafeHttpsError("network");
    };
    assert.deepEqual(await probeTls("pos.example.com", { send }), {
      ok: false,
      status: 0,
      code: "cert-pending",
    });
    const slow = async () => {
      throw new SafeHttpsError("timeout");
    };
    assert.equal(
      (await probeTls("pos.example.com", { send: slow })).code,
      "cert-pending",
    );
  });
  it("refused hosts and addresses keep their own code; other errors still throw", async () => {
    assert.deepEqual(await probeTls("127.0.0.1", { send: async () => ({}) }), {
      ok: false,
      status: 0,
      code: "bad-host",
    });
    const blocked = async () => {
      throw new SafeHttpsError("blocked");
    };
    assert.equal(
      (await probeTls("pos.example.com", { send: blocked })).code,
      "blocked",
    );
    await rejects(
      probeTls("pos.example.com", {
        send: async () => {
          throw new TypeError("boom");
        },
      }),
      (e) => assert.ok(e instanceof TypeError),
    );
  });
});

describe("fake dns driving createDnsCheck", () => {
  const HOST = "posdemo.sandbee.in";
  const TARGET = "abcd1234abcd1234.vercel-dns-017.com";
  const make = () => {
    const fake = createFakeDns();
    return {
      fake,
      check: createDnsCheck({ dns: fake.dns, Resolver: fake.Resolver }),
    };
  };
  it("authoritative: NS -> IPs -> a Resolver pointed at them", async () => {
    const { fake, check } = make();
    await check.authoritative("sandbee.in");
    assert.deepEqual(fake.resolvers[0].servers, [
      "198.51.100.1",
      "198.51.100.2",
    ]);
    assert.equal(fake.resolvers[0].options.timeout, 4000);
  });
  it("is stateful: a record added later is seen, a removed one is gone", async () => {
    const { fake, check } = make();
    const query = () => check.checkRecords({ apex: "sandbee.in", host: HOST });
    assert.deepEqual((await query()).cname, { found: null, ok: false });
    fake.add(HOST, "CNAME", `${TARGET}.`);
    assert.deepEqual((await query()).cname, { found: TARGET, ok: true });
    fake.remove(HOST, "CNAME");
    assert.equal((await query()).cname.found, null);
  });
  it("a foreign record is found but not ours; TXT rows are joined and matched", async () => {
    const { fake, check } = make();
    fake.add(HOST, "CNAME", "other.example.net");
    const r = await check.checkRecords({
      apex: "sandbee.in",
      host: HOST,
      txt: { name: "_vercel.posdemo", value: "vc-domain-verify=a,b" },
    });
    assert.deepEqual(r.cname, { found: "other.example.net", ok: false });
    assert.deepEqual(r.txt, { found: [], ok: false });
    fake.add("_vercel.posdemo.sandbee.in", "TXT", ["vc-domain-", "verify=a,b"]);
    const r2 = await check.checkRecords({
      apex: "sandbee.in",
      host: HOST,
      txt: { name: "_vercel.posdemo", value: "vc-domain-verify=a,b" },
    });
    assert.deepEqual(r2.txt, { found: ["vc-domain-verify=a,b"], ok: true });
    const label = await check.lookupLabel({ apex: "sandbee.in", host: HOST });
    assert.deepEqual(label, { cname: "other.example.net", a: [], inUse: true });
  });
  it("lookupLabel: free label, A-only label, NXDOMAIN reads as free", async () => {
    const { fake, check } = make();
    assert.equal(
      (await check.lookupLabel({ apex: "sandbee.in", host: HOST })).inUse,
      false,
    );
    fake.add(HOST, "A", "203.0.113.5");
    assert.deepEqual(
      await check.lookupLabel({ apex: "sandbee.in", host: HOST }),
      {
        cname: null,
        a: ["203.0.113.5"],
        inUse: true,
      },
    );
    fake.nxdomain(HOST);
    fake.remove(HOST, "A");
    assert.equal(
      (await check.lookupLabel({ apex: "sandbee.in", host: HOST })).inUse,
      false,
    );
  });
  it("timeouts, SERVFAIL and a dead NS lookup are dns-unreachable, never 'free'", async () => {
    const { fake, check } = make();
    fake.timeouts(true);
    const t = await check.checkRecords({ apex: "sandbee.in", host: HOST });
    assert.deepEqual(t.cname, {
      found: null,
      ok: false,
      error: "dns-unreachable",
    });
    await rejects(check.lookupLabel({ apex: "sandbee.in", host: HOST }), (e) =>
      assert.equal(e.code, "dns-unreachable"),
    );
    fake.timeouts(false).servfail(HOST);
    await rejects(check.lookupLabel({ apex: "sandbee.in", host: HOST }), (e) =>
      assert.equal(e.code, "dns-unreachable"),
    );
    fake.servfail(HOST, false).failNs();
    const n = await check.checkRecords({
      apex: "sandbee.in",
      host: HOST,
      txt: { name: "x", value: "y" },
    });
    assert.equal(n.cname.error, "dns-unreachable");
    assert.equal(n.txt.error, "dns-unreachable");
    fake.failNs(false);
    await check.authoritative("sandbee.in");
  });
  it("one failing nameserver host is not fatal; all failing is; a Resolver aimed elsewhere times out", async () => {
    const { fake, check } = make();
    fake.failNsHost("ns01.fake-dns.test");
    await check.authoritative("sandbee.in");
    assert.deepEqual(fake.resolvers.at(-1).servers, ["198.51.100.2"]);
    fake.failNsHost("ns02.fake-dns.test");
    await rejects(check.authoritative("sandbee.in"), (e) =>
      assert.equal(e.code, "dns-unreachable"),
    );
    const stray = new fake.Resolver();
    stray.setServers(["8.8.8.8"]);
    await rejects(stray.resolveCname(HOST), (e) =>
      assert.equal(e.code, "ETIMEOUT"),
    );
  });
});
