// P5 Stage 3 W1 (docs/P5-STAGE3-PLAN.md §7, §11): the pure functions ported
// from the local go-live tool (F:\lucifer\scripts\go-live lib.mjs,
// web-address.mjs, dns-check.mjs, realtime.mjs, cloudflare-api.mjs,
// cloudflare-validate.mjs, ui/pure.mjs). The go-live tests are ported 1:1
// where the function is the same and re-expressed where admin's shapes differ
// (codes instead of owner sentences, admin's pos + vault fields instead of a
// client file). tools/p5-parity.mjs compares both sides on the dev PC.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  PLATFORM_APEX,
  PLATFORM_LABELS,
  SUBDOMAIN_RE,
  VERCEL_CNAME_RE,
  VERCEL_CNAME_TARGET,
  ADDRESS_STATES,
  addressStateOf,
  hostOf,
  labelFromInput,
  labelProblem,
  recommendedCnameOf,
  webAddressRecords,
} from "../shared/web-address.js";
import {
  ENV_TARGETS,
  GOLIVE_ENV_KEYS,
  REALTIME_ENV_KEYS,
  buildEnv,
  envClientOf,
  envDrift,
  envFingerprints,
  envFp,
  mintPosAdminPassword,
  mintSecrets,
  missingEnvKeys,
  realtimeEnvOf,
  realtimeOffEnv,
} from "../backend/lib/golive-env.js";
import {
  ACCOUNT_ID_RE,
  JOIN_PROBE_STATUS,
  PUBLISH_PROBE_ATTEMPTS,
  PUBLISH_PROBE_INTERVAL_MS,
  PUBLISH_SECRET_BYTES,
  REALTIME_SIG_HEADER,
  REALTIME_TS_HEADER,
  SUBDOMAIN_CANDIDATE_ATTEMPTS,
  WORKER_NAME_MAX_LEN,
  parseRealtimeDescriptor,
  parseWorkerUrl,
  publishVerdict,
  realtimeNeedsDeploy,
  signedPublishRequest,
  subdomainCandidate,
  uploadMetadataOf,
  validateCloudflare,
  workerNameOf,
} from "../backend/lib/realtime.js";
import { createDnsCheck } from "../backend/lib/dns-check.js";
import { isStrongPassword } from "../shared/schemas.js";

const VAULT_KEY = "ab".repeat(32);
const URI = "mongodb+srv://u:p@cluster0.abc.mongodb.net/pos?retryWrites=true";
const TENANT = { tenantId: "sunrise", rootDomain: "sandbee.in" };
const GEN = { authSecret: "AUTH", healthStatsToken: "HS" };
const client = (image = null) => ({ mongodbUri: URI, image });

describe("shared/web-address.js — labels, host, records, state", () => {
  it("the platform apex and the refused labels (D44: P4 §7 platform names + names reserved by code/docs)", () => {
    assert.equal(PLATFORM_APEX, "sandbee.in");
    for (const name of [
      "@",
      "www",
      "admin",
      "store",
      "gstapi",
      "ocrapi",
      "_dmarc",
      "_domainconnect",
      "app",
      "api",
      "hub",
      "ecom",
      "ocr",
      "pos",
      "notify",
      "whatsapp",
      "wa",
      "waadmin",
    ])
      assert.ok(PLATFORM_LABELS.includes(name), name);
    // The go-live tool's own list (apps/cafe/lib/platform.ts) is a subset.
    for (const name of ["www", "app", "api", "admin", "hub"])
      assert.equal(labelProblem(name), "label-reserved", name);
  });

  it("labelProblem: one lowercase DNS label, not reserved", () => {
    assert.equal(labelProblem("lucifer"), null);
    assert.equal(labelProblem("a"), null);
    assert.equal(labelProblem("a".repeat(63)), null);
    assert.equal(labelProblem("posdemo"), null, "only exact names are refused");
    for (const bad of [
      "",
      "Lucifer",
      "a_b",
      "-a",
      "a-",
      "a.b",
      "a".repeat(64),
      null,
      undefined,
      7,
    ])
      assert.equal(labelProblem(bad), "label-invalid", String(bad));
    assert.equal(labelProblem("store"), "label-reserved");
    assert.equal(labelProblem("_dmarc"), "label-invalid", "shape first");
    assert.ok(SUBDOMAIN_RE.test("lucifer"));
  });

  it("labelFromInput (ui-pure subdomainFromInput): a bare label, a full host or a pasted URL; empty -> null; codes instead of thrown sentences", () => {
    assert.deepEqual(labelFromInput("lucifer"), {
      label: "lucifer",
      problem: null,
    });
    assert.equal(labelFromInput("  Lucifer  ").label, "lucifer");
    assert.equal(labelFromInput("lucifer.sandbee.in").label, "lucifer");
    assert.equal(
      labelFromInput("https://lucifer.sandbee.in/").label,
      "lucifer",
    );
    assert.equal(labelFromInput("http://LUCIFER.SANDBEE.IN").label, "lucifer");
    assert.deepEqual(labelFromInput(""), { label: null, problem: null });
    assert.deepEqual(labelFromInput(null), { label: null, problem: null });
    assert.deepEqual(labelFromInput("lucifer.other.in"), {
      label: null,
      problem: "label-not-single",
    });
    assert.deepEqual(labelFromInput("Lucifer_1"), {
      label: null,
      problem: "label-invalid",
    });
    assert.deepEqual(labelFromInput("www"), {
      label: null,
      problem: "label-reserved",
    });
  });

  it("hostOf: <label>.<apex>", () => {
    assert.equal(hostOf("lucifer"), "lucifer.sandbee.in");
    assert.equal(hostOf("x", "example.com"), "x.example.com");
  });

  it("webAddressRecords: CNAME always; one TXT row per verification[] TXT entry, name RELATIVE to the apex; @ for the apex itself; non-TXT ignored", () => {
    const rows = webAddressRecords({
      subdomain: "lucifer",
      apex: "sandbee.in",
      recommendedCname: "abc.vercel-dns-017.com",
      verification: [
        {
          type: "TXT",
          domain: "_vercel.lucifer.sandbee.in",
          value: "vc-domain-verify=abc",
        },
      ],
    });
    assert.deepEqual(rows, [
      { type: "CNAME", name: "lucifer", value: "abc.vercel-dns-017.com" },
      { type: "TXT", name: "_vercel.lucifer", value: "vc-domain-verify=abc" },
    ]);
    const noTxt = webAddressRecords({
      subdomain: "lucifer",
      apex: "sandbee.in",
      recommendedCname: "cname.vercel-dns.com",
      verification: undefined,
    });
    assert.equal(noTxt.length, 1);
    const atApex = webAddressRecords({
      subdomain: "lucifer",
      apex: "sandbee.in",
      recommendedCname: "cname.vercel-dns.com",
      verification: [{ type: "TXT", domain: "sandbee.in", value: "v" }],
    });
    assert.equal(atApex[1].name, "@");
    const apexTxt = webAddressRecords({
      subdomain: "lucifer",
      apex: "sandbee.in",
      recommendedCname: "cname.vercel-dns.com",
      verification: [{ type: "TXT", domain: "_vercel.sandbee.in", value: "v" }],
    });
    assert.equal(apexTxt[1].name, "_vercel");
    const nonTxt = webAddressRecords({
      subdomain: "lucifer",
      apex: "sandbee.in",
      recommendedCname: "cname.vercel-dns.com",
      verification: [{ type: "OTHER", domain: "x", value: "y" }, null],
    });
    assert.equal(nonTxt.length, 1);
  });

  it("webAddressRecords: at most 4 rows (view limit, plan §4)", () => {
    const verification = Array.from({ length: 6 }, (_, i) => ({
      type: "TXT",
      domain: `_vercel.sandbee.in`,
      value: `v${i}`,
    }));
    const rows = webAddressRecords({
      subdomain: "x",
      apex: "sandbee.in",
      recommendedCname: "cname.vercel-dns.com",
      verification,
    });
    assert.equal(rows.length, 4);
    assert.equal(rows[0].type, "CNAME");
  });

  it("recommendedCnameOf: the lowest rank wins, trailing dots stripped, fallback cname.vercel-dns.com", () => {
    assert.equal(VERCEL_CNAME_TARGET, "cname.vercel-dns.com");
    assert.equal(recommendedCnameOf(null), "cname.vercel-dns.com");
    assert.equal(recommendedCnameOf({}), "cname.vercel-dns.com");
    assert.equal(
      recommendedCnameOf({ recommendedCNAME: [] }),
      "cname.vercel-dns.com",
    );
    assert.equal(
      recommendedCnameOf({
        recommendedCNAME: [
          { rank: 2, value: "two.vercel-dns-017.com" },
          { rank: 1, value: "one.vercel-dns-017.com." },
        ],
      }),
      "one.vercel-dns-017.com",
    );
    assert.equal(
      recommendedCnameOf({ recommendedCNAME: [{ value: "x.vercel-dns.com" }] }),
      "x.vercel-dns.com",
    );
  });

  it("recommendedCnameOf: a target that is not a Vercel DNS name falls back (the owner never copies a foreign host)", () => {
    assert.equal(
      recommendedCnameOf({
        recommendedCNAME: [{ rank: 1, value: "evil.example.com" }],
      }),
      "cname.vercel-dns.com",
    );
    assert.equal(
      recommendedCnameOf({ recommendedCNAME: [{ rank: 1, value: 42 }] }),
      "cname.vercel-dns.com",
    );
  });

  it("VERCEL_CNAME_RE matches Vercel's CNAME targets, both the shared and the project-specific forms", () => {
    assert.ok(VERCEL_CNAME_RE.test("cname.vercel-dns.com"));
    assert.ok(VERCEL_CNAME_RE.test("abc.vercel-dns-017.com"));
    assert.ok(!VERCEL_CNAME_RE.test("evil-vercel-dns.com.attacker.net"));
    assert.ok(!VERCEL_CNAME_RE.test("notvercel-dns.com"));
  });

  it("addressStateOf (web-address.mjs stateOf): ready / check-failed / pending-verify / pending-dns / tenant-mismatch / pending-cert", () => {
    const s = (o) =>
      addressStateOf({
        verified: true,
        configured: true,
        reachable: true,
        hasTxtRow: false,
        answeredAs: null,
        ...o,
      });
    assert.equal(s({}), "ready");
    assert.equal(s({ configured: null }), "check-failed");
    assert.equal(
      s({ configured: null, verified: false, hasTxtRow: true }),
      "check-failed",
      "no DNS verdict at all wins over everything but ready",
    );
    assert.equal(s({ verified: false, hasTxtRow: true }), "pending-verify");
    assert.equal(s({ verified: false, hasTxtRow: false }), "pending-cert");
    assert.equal(s({ configured: false }), "pending-dns");
    assert.equal(
      s({ reachable: false, answeredAs: "stranger" }),
      "tenant-mismatch",
    );
    assert.equal(s({ reachable: false }), "pending-cert");
    for (const state of [
      "ready",
      "check-failed",
      "pending-verify",
      "pending-dns",
      "tenant-mismatch",
      "pending-cert",
    ])
      assert.ok(ADDRESS_STATES.includes(state), state);
  });
});

describe("backend/lib/golive-env.js — buildEnv exact port (D43)", () => {
  it("the DEPLOY.md required set, both auth names, every store key blank without a store, 18 keys, no NEXTAUTH_URL/AUTH_URL", () => {
    const envs = buildEnv(client(), TENANT, GEN);
    const byKey = Object.fromEntries(envs.map((e) => [e.key, e]));
    for (const k of [
      "AUTH_SECRET",
      "CORE_MONGODB_URI",
      "HEALTH_STATS_TOKEN",
      "HOSTING_TIER",
      "MONGODB_URI",
      "NEXTAUTH_SECRET",
      "ROOT_DOMAIN",
      "TENANT_ID",
    ])
      assert.ok(k in byKey, k);
    assert.equal(byKey.IMAGE_STORE.value, "r2");
    for (const k of [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "NEXT_PUBLIC_R2_PUBLIC_BASE_URL",
      "CLOUDINARY_CLOUD_NAME",
      "CLOUDINARY_API_KEY",
      "CLOUDINARY_API_SECRET",
      "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME",
    ])
      assert.equal(byKey[k].value, "", k);
    assert.equal(envs.length, 18);
    assert.equal(byKey.TENANT_ID.value, "sunrise");
    assert.equal(byKey.TENANT_ID.type, "plain");
    assert.equal(byKey.ROOT_DOMAIN.value, "sandbee.in");
    assert.equal(byKey.HOSTING_TIER.value, "B");
    assert.equal(byKey.MONGODB_URI.type, "encrypted");
    assert.equal(byKey.MONGODB_URI.value, URI);
    assert.equal(byKey.CORE_MONGODB_URI.value, URI);
    assert.equal(byKey.AUTH_SECRET.value, byKey.NEXTAUTH_SECRET.value);
    assert.ok(!("NEXTAUTH_URL" in byKey) && !("AUTH_URL" in byKey));
    for (const e of envs) assert.deepEqual(e.target, ["production", "preview"]);
    assert.deepEqual(ENV_TARGETS, ["production", "preview"]);
  });

  it("the exact key order and types (go-live lib.mjs:346-383)", () => {
    const envs = buildEnv(client(), TENANT, GEN, realtimeOffEnv());
    assert.deepEqual(
      envs.map((e) => `${e.key}:${e.type}`),
      [
        "MONGODB_URI:encrypted",
        "CORE_MONGODB_URI:encrypted",
        "NEXTAUTH_SECRET:encrypted",
        "AUTH_SECRET:encrypted",
        "HEALTH_STATS_TOKEN:encrypted",
        "HOSTING_TIER:plain",
        "ROOT_DOMAIN:plain",
        "TENANT_ID:plain",
        "IMAGE_STORE:plain",
        "R2_ACCOUNT_ID:encrypted",
        "R2_ACCESS_KEY_ID:encrypted",
        "R2_SECRET_ACCESS_KEY:encrypted",
        "R2_BUCKET:plain",
        "NEXT_PUBLIC_R2_PUBLIC_BASE_URL:plain",
        "CLOUDINARY_CLOUD_NAME:plain",
        "CLOUDINARY_API_KEY:encrypted",
        "CLOUDINARY_API_SECRET:encrypted",
        "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME:plain",
        "REALTIME_PUBLISH_URL:encrypted",
        "REALTIME_PUBLISH_SECRET:encrypted",
        "NEXT_PUBLIC_REALTIME_URL:plain",
      ],
    );
    assert.deepEqual(
      GOLIVE_ENV_KEYS,
      envs.map((e) => e.key),
    );
  });

  it("TENANT_ID is omitted while unknown", () => {
    const envs = buildEnv(
      client(),
      { tenantId: null, rootDomain: "vercel.app" },
      GEN,
    );
    assert.ok(!envs.some((e) => e.key === "TENANT_ID"));
    assert.ok(
      envs.some((e) => e.key === "ROOT_DOMAIN" && e.value === "vercel.app"),
    );
  });

  it("the selected store's keys carry values, the other store's keys are blanked", () => {
    const r2 = Object.fromEntries(
      buildEnv(
        client({
          store: "r2",
          accountId: "acc",
          accessKeyId: "k",
          secretAccessKey: "s",
          bucket: "b",
          publicBaseUrl: "https://pub.r2.dev",
        }),
        TENANT,
        GEN,
      ).map((e) => [e.key, e.value]),
    );
    assert.equal(r2.IMAGE_STORE, "r2");
    assert.equal(r2.R2_ACCOUNT_ID, "acc");
    assert.equal(r2.R2_ACCESS_KEY_ID, "k");
    assert.equal(r2.R2_SECRET_ACCESS_KEY, "s");
    assert.equal(r2.R2_BUCKET, "b");
    assert.equal(r2.NEXT_PUBLIC_R2_PUBLIC_BASE_URL, "https://pub.r2.dev");
    assert.equal(r2.CLOUDINARY_CLOUD_NAME, "");
    assert.equal(r2.CLOUDINARY_API_SECRET, "");
    assert.equal(r2.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, "");
    const cl = Object.fromEntries(
      buildEnv(
        client({
          store: "cloudinary",
          cloudName: "c",
          apiKey: "k",
          apiSecret: "s",
        }),
        TENANT,
        GEN,
      ).map((e) => [e.key, e.value]),
    );
    assert.equal(cl.IMAGE_STORE, "cloudinary");
    assert.equal(cl.CLOUDINARY_CLOUD_NAME, "c");
    assert.equal(cl.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, "c");
    assert.equal(cl.CLOUDINARY_API_KEY, "k");
    assert.equal(cl.CLOUDINARY_API_SECRET, "s");
    for (const k of [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "NEXT_PUBLIC_R2_PUBLIC_BASE_URL",
    ])
      assert.equal(cl[k], "", k);
  });

  it("realtimeEnv (4th param) is appended verbatim; [] = leave untouched; the off triple blanks", () => {
    const none = buildEnv(client(), TENANT, GEN);
    assert.equal(none.length, 18);
    assert.ok(!none.some((e) => REALTIME_ENV_KEYS.includes(e.key)));
    const on = realtimeEnvOf({
      url: "https://pos-realtime-sunrise.acme.workers.dev",
      secret: "sekrit",
    });
    const withOn = buildEnv(client(), TENANT, GEN, on);
    assert.equal(withOn.length, 21);
    assert.deepEqual(withOn.slice(-3), on);
    const withOff = buildEnv(client(), TENANT, GEN, realtimeOffEnv());
    assert.ok(withOff.slice(-3).every((e) => e.value === ""));
  });

  it("realtimeEnvOf/realtimeOffEnv: key order = REALTIME_ENV_KEYS, types and computed values", () => {
    assert.deepEqual(REALTIME_ENV_KEYS, [
      "REALTIME_PUBLISH_URL",
      "REALTIME_PUBLISH_SECRET",
      "NEXT_PUBLIC_REALTIME_URL",
    ]);
    const on = realtimeEnvOf({
      url: "https://pos-realtime-sunrise.sandbee.workers.dev",
      secret: "sekrit-hex",
    });
    assert.deepEqual(
      on.map((e) => e.key),
      REALTIME_ENV_KEYS,
    );
    assert.equal(
      on[0].value,
      "https://pos-realtime-sunrise.sandbee.workers.dev/publish",
    );
    assert.equal(on[0].type, "encrypted");
    assert.equal(on[1].value, "sekrit-hex");
    assert.equal(on[1].type, "encrypted");
    assert.equal(
      on[2].value,
      "wss://pos-realtime-sunrise.sandbee.workers.dev/join",
    );
    assert.equal(on[2].type, "plain");
    for (const e of on) assert.deepEqual(e.target, ["production", "preview"]);
    const off = realtimeOffEnv();
    assert.deepEqual(
      off.map((e) => e.key),
      REALTIME_ENV_KEYS,
    );
    for (const e of off) assert.equal(e.value, "");
    assert.deepEqual(
      off.map((e) => e.type),
      ["encrypted", "encrypted", "plain"],
    );
  });

  it("buildEnv never shares arrays between entries (a caller mutating one target list cannot change another)", () => {
    const envs = buildEnv(client(), TENANT, GEN, realtimeOffEnv());
    envs[0].target.push("development");
    assert.deepEqual(envs[1].target, ["production", "preview"]);
    assert.deepEqual(buildEnv(client(), TENANT, GEN)[0].target, [
      "production",
      "preview",
    ]);
  });
});

describe("backend/lib/golive-env.js — admin's pos + vault -> the go-live client shape", () => {
  const pos = (image) => ({
    image: {
      store: null,
      publicBaseUrl: "",
      cloudName: "",
      r2AccountId: "",
      bucket: "",
      ...image,
    },
  });

  it("no store -> image null (every store key blank)", () => {
    assert.deepEqual(envClientOf(pos({}), { mongoUri: URI }), {
      mongodbUri: URI,
      image: null,
    });
  });

  it("r2: account id, bucket and public URL from the setup, the two keys from the vault box", () => {
    const c = envClientOf(
      pos({
        store: "r2",
        publicBaseUrl: "https://pub.r2.dev",
        r2AccountId: "acc",
        bucket: "b",
      }),
      {
        mongoUri: URI,
        imageKeys: JSON.stringify({ accessKeyId: "k", secretAccessKey: "s" }),
      },
    );
    assert.deepEqual(c, {
      mongodbUri: URI,
      image: {
        store: "r2",
        accountId: "acc",
        accessKeyId: "k",
        secretAccessKey: "s",
        bucket: "b",
        publicBaseUrl: "https://pub.r2.dev",
      },
    });
  });

  it("cloudinary: cloud name from the setup, key + secret from the vault box (an object works too)", () => {
    const c = envClientOf(pos({ store: "cloudinary", cloudName: "c" }), {
      mongoUri: URI,
      imageKeys: { apiKey: "k", apiSecret: "s" },
    });
    assert.deepEqual(c.image, {
      store: "cloudinary",
      cloudName: "c",
      apiKey: "k",
      apiSecret: "s",
    });
  });

  it("a selected store without its keys, or with the other store's keys, is refused by code (never written as blanks)", () => {
    const r2 = pos({
      store: "r2",
      publicBaseUrl: "https://p.dev",
      r2AccountId: "a",
      bucket: "b",
    });
    for (const imageKeys of [
      undefined,
      "",
      "not json",
      JSON.stringify({ apiKey: "k", apiSecret: "s" }),
      JSON.stringify({ accessKeyId: "k" }),
    ])
      assert.throws(
        () => envClientOf(r2, { mongoUri: URI, imageKeys }),
        (e) => e.code === "inputs-missing" && !String(e.message).includes("k"),
      );
    assert.throws(
      () =>
        envClientOf(
          pos({ store: "r2", publicBaseUrl: "https://p.dev", bucket: "b" }),
          {
            mongoUri: URI,
            imageKeys: JSON.stringify({
              accessKeyId: "k",
              secretAccessKey: "s",
            }),
          },
        ),
      (e) => e.code === "inputs-missing",
      "r2 needs the account id",
    );
    assert.throws(
      () => envClientOf(pos({}), { mongoUri: "" }),
      (e) => e.code === "inputs-missing",
    );
  });
});

describe("backend/lib/golive-env.js — secrets", () => {
  it("mintSecrets keeps what exists and mints only what is missing (lib.test.mjs)", () => {
    let n = 0;
    const randomBytes = (len) => Buffer.alloc(len, ++n);
    const first = mintSecrets(undefined, randomBytes);
    assert.equal(first.authSecret, Buffer.alloc(32, 1).toString("base64"));
    assert.equal(first.healthStatsToken, Buffer.alloc(32, 2).toString("hex"));
    assert.equal(
      first.realtimePublishSecret,
      Buffer.alloc(32, 3).toString("hex"),
    );
    const again = mintSecrets({ ...first, other: "x" }, randomBytes);
    assert.equal(again.authSecret, first.authSecret);
    assert.equal(again.healthStatsToken, first.healthStatsToken);
    assert.equal(again.realtimePublishSecret, first.realtimePublishSecret);
    assert.equal(again.other, "x");
    assert.equal(n, 3, "no extra randomness consumed on the re-run");
    const blank = mintSecrets(
      { authSecret: "  ", healthStatsToken: "" },
      randomBytes,
    );
    assert.notEqual(blank.authSecret.trim(), "");
    assert.equal(PUBLISH_SECRET_BYTES, 32);
  });

  it("mintPosAdminPassword: passes the POS seeder's rule, 20+ chars, different every call", () => {
    const { randomBytes } = {
      randomBytes: (n) =>
        Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256)),
    };
    const fixed = mintPosAdminPassword(randomBytes);
    assert.ok(isStrongPassword(fixed));
    assert.ok(fixed.length >= 20);
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      const p = mintPosAdminPassword();
      assert.ok(isStrongPassword(p), p.length);
      seen.add(p);
    }
    assert.equal(seen.size, 50);
  });
});

describe("backend/lib/golive-env.js — fingerprints and drift (D43)", () => {
  const envs = buildEnv(client(), TENANT, GEN, realtimeOffEnv());

  it("envFp: keyed 16 hex, bound to the key name; never the value or an unkeyed hash of it", () => {
    const fp = envFp(VAULT_KEY, "MONGODB_URI", URI);
    assert.match(fp, /^[0-9a-f]{16}$/);
    assert.equal(fp, envFp(VAULT_KEY, "MONGODB_URI", URI));
    assert.notEqual(fp, envFp(VAULT_KEY, "CORE_MONGODB_URI", URI));
    assert.notEqual(fp, envFp("cd".repeat(32), "MONGODB_URI", URI));
    const kEnv = createHmac("sha256", Buffer.from(VAULT_KEY, "hex"))
      .update("sandbee-env-fp-v1")
      .digest();
    assert.equal(
      fp,
      createHmac("sha256", kEnv)
        .update(JSON.stringify(["MONGODB_URI", URI]))
        .digest("hex")
        .slice(0, 16),
      "HMAC under HMAC(VAULT_KEY, sandbee-env-fp-v1) over [key, value]",
    );
    assert.throws(() => envFp("short", "K", "v"), /vault key/i);
  });

  it("envFingerprints: name, type, targets, set, fp16 per key; at write time updatedAt comes from Vercel's metadata", () => {
    const meta = envs.map((e, i) => ({
      key: e.key,
      type: e.type,
      target: [...e.target],
      updatedAt: 1000 + i,
    }));
    const keys = envFingerprints(VAULT_KEY, envs, meta);
    assert.equal(keys.length, 21);
    assert.deepEqual(keys[0], {
      name: "MONGODB_URI",
      type: "encrypted",
      targets: ["production", "preview"],
      set: true,
      fp16: envFp(VAULT_KEY, "MONGODB_URI", URI),
      updatedAt: 1000,
    });
    const blank = keys.find((k) => k.name === "R2_BUCKET");
    assert.equal(blank.set, false);
    const stored = JSON.stringify(keys);
    for (const e of envs)
      if (e.value) assert.ok(!stored.includes(JSON.stringify(e.value)), e.key);
    const noMeta = envFingerprints(VAULT_KEY, envs, []);
    assert.equal(noMeta[0].updatedAt, null);
  });

  it("envDrift: none when Vercel matches; missing / type / targets / value (plain only) / edited by hand", () => {
    const meta = envs.map((e) => ({
      key: e.key,
      type: e.type,
      target: [...e.target],
      updatedAt: 1000,
      ...(e.type === "plain" ? { fp16: envFp(VAULT_KEY, e.key, e.value) } : {}),
    }));
    const stored = envFingerprints(VAULT_KEY, envs, meta);
    assert.deepEqual(envDrift(stored, meta), []);
    assert.deepEqual(
      envDrift(stored, [...meta].reverse()),
      [],
      "order does not matter",
    );
    const without = meta.filter((m) => m.key !== "TENANT_ID");
    assert.deepEqual(envDrift(stored, without), [
      { name: "TENANT_ID", reason: "missing" },
    ]);
    const typed = meta.map((m) =>
      m.key === "MONGODB_URI" ? { ...m, type: "sensitive" } : m,
    );
    assert.deepEqual(envDrift(stored, typed), [
      { name: "MONGODB_URI", reason: "type" },
    ]);
    const targeted = meta.map((m) =>
      m.key === "AUTH_SECRET" ? { ...m, target: ["production"] } : m,
    );
    assert.deepEqual(envDrift(stored, targeted), [
      { name: "AUTH_SECRET", reason: "targets" },
    ]);
    const reordered = meta.map((m) =>
      m.key === "AUTH_SECRET" ? { ...m, target: ["preview", "production"] } : m,
    );
    assert.deepEqual(
      envDrift(stored, reordered),
      [],
      "target order is not drift",
    );
    const plainChanged = meta.map((m) =>
      m.key === "ROOT_DOMAIN"
        ? { ...m, fp16: envFp(VAULT_KEY, "ROOT_DOMAIN", "x.in") }
        : m,
    );
    assert.deepEqual(envDrift(stored, plainChanged), [
      { name: "ROOT_DOMAIN", reason: "value" },
    ]);
    const edited = meta.map((m) =>
      m.key === "HEALTH_STATS_TOKEN" ? { ...m, updatedAt: 2000 } : m,
    );
    assert.deepEqual(envDrift(stored, edited), [
      { name: "HEALTH_STATS_TOKEN", reason: "edited" },
    ]);
    assert.ok(
      envDrift(
        stored,
        meta.map((m) => ({ ...m, updatedAt: 999 })),
      ).length === 0,
      "an older updatedAt is not an edit",
    );
  });

  it("envDrift: Vercel's duplicate rows per target (one per environment) are read together; at most 30 results", () => {
    const meta = envs.flatMap((e) =>
      e.target.map((t) => ({
        key: e.key,
        type: e.type,
        target: [t],
        updatedAt: 1000,
      })),
    );
    const stored = envFingerprints(VAULT_KEY, envs, meta);
    assert.deepEqual(envDrift(stored, meta), []);
    assert.equal(envDrift(stored, []).length, 21);
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `K${i}`,
      type: "plain",
      targets: ["production"],
      set: true,
      fp16: "0".repeat(16),
      updatedAt: 1,
    }));
    assert.equal(envDrift(many, []).length, 30);
  });

  it("missingEnvKeys: names-only parity for imported clients (env-keys-missing); realtime keys only when realtime is on", () => {
    const names = buildEnv(client(), TENANT, GEN).map((e) => e.key);
    assert.deepEqual(missingEnvKeys(names, { realtime: false }), []);
    assert.deepEqual(
      missingEnvKeys(names, { realtime: true }),
      REALTIME_ENV_KEYS,
    );
    assert.deepEqual(
      missingEnvKeys(
        names.filter((n) => n !== "AUTH_SECRET"),
        { realtime: false },
      ),
      ["AUTH_SECRET"],
    );
    assert.deepEqual(missingEnvKeys(["X"], { realtime: false }).length, 18);
  });
});

describe("backend/lib/realtime.js — names, URL, signature, verdicts", () => {
  it("workerNameOf: pos-realtime-<slug>; a name breaking the Worker rule is refused with code realtime-name", () => {
    assert.equal(workerNameOf("sunrise"), "pos-realtime-sunrise");
    assert.equal(WORKER_NAME_MAX_LEN, 63);
    assert.equal(workerNameOf("a".repeat(50)).length, 63);
    for (const bad of ["a".repeat(51), "Bad_Slug", "trailing-hyphen-", ""])
      assert.throws(
        () => workerNameOf(bad),
        (e) => e.code === "realtime-name",
        bad,
      );
  });

  it("parseWorkerUrl: wrangler-style output, trailing punctuation stripped, none found -> null", () => {
    assert.equal(
      parseWorkerUrl(
        "Deployed pos-realtime-sunrise (1.2s)\n  https://pos-realtime-sunrise.sandbee.workers.dev\nCurrent Version ID: abc",
      ),
      "https://pos-realtime-sunrise.sandbee.workers.dev",
    );
    assert.equal(
      parseWorkerUrl("see https://pos-realtime-sunrise.sandbee.workers.dev."),
      "https://pos-realtime-sunrise.sandbee.workers.dev",
    );
    assert.equal(
      parseWorkerUrl("see (https://pos-realtime-sunrise.sandbee.workers.dev)"),
      "https://pos-realtime-sunrise.sandbee.workers.dev",
    );
    assert.equal(parseWorkerUrl("no url here"), null);
    assert.equal(parseWorkerUrl(""), null);
    assert.equal(parseWorkerUrl(undefined), null);
  });

  it("signedPublishRequest mirrors the cafe's buildRealtimeRequest field-for-field (HMAC computed independently here)", () => {
    assert.equal(REALTIME_SIG_HEADER, "x-realtime-signature");
    assert.equal(REALTIME_TS_HEADER, "x-realtime-ts");
    const secret = "adopt-secret-0123456789abcdef";
    const nowMs = 1_758_000_000_000;
    const { body, headers } = signedPublishRequest(
      secret,
      "sunrise-demo",
      nowMs,
    );
    const expectedBody = JSON.stringify({
      tenant: "sunrise-demo",
      kind: "print-job",
      at: new Date(nowMs).toISOString(),
    });
    assert.equal(body, expectedBody);
    const ts = String(Math.floor(nowMs / 1000));
    assert.equal(headers[REALTIME_TS_HEADER], ts);
    assert.equal(
      headers[REALTIME_SIG_HEADER],
      createHmac("sha256", secret)
        .update(`${ts}.${expectedBody}`)
        .digest("hex"),
    );
    assert.equal(headers["content-type"], "application/json");
    assert.deepEqual(
      Object.keys(headers).sort(),
      ["content-type", REALTIME_SIG_HEADER, REALTIME_TS_HEADER].sort(),
    );
  });

  it("the publish probe's whole retry budget fits well inside the Worker's ±300 s timestamp window", () => {
    assert.ok(PUBLISH_PROBE_ATTEMPTS * PUBLISH_PROBE_INTERVAL_MS < 300_000 / 4);
    assert.equal(JOIN_PROBE_STATUS, 426);
  });

  it("publishVerdict: 200 ok; 403 tenant; 401 secret; 400 envelope drift; anything else (incl. no answer) failed", () => {
    assert.equal(publishVerdict(200), "ok");
    assert.equal(publishVerdict(403), "realtime-tenant-refused");
    assert.equal(publishVerdict(401), "realtime-secret-mismatch");
    assert.equal(publishVerdict(400), "realtime-envelope");
    for (const s of [null, 0, 404, 500, 503])
      assert.equal(publishVerdict(s), "realtime-probe-failed", String(s));
  });

  it("realtimeNeedsDeploy: first time, or name / tenant / bundle / URL changed; the same record needs nothing", () => {
    const next = {
      workerName: "pos-realtime-x",
      tenantId: "x",
      bundleSha256: "a".repeat(64),
      url: "https://pos-realtime-x.s.workers.dev",
    };
    assert.equal(realtimeNeedsDeploy(null, next), true);
    assert.equal(realtimeNeedsDeploy({ ...next }, next), false);
    for (const k of Object.keys(next))
      assert.equal(
        realtimeNeedsDeploy({ ...next, [k]: "other" }, next),
        true,
        k,
      );
  });

  it("subdomainCandidate: pos-<slug>, then pos-<slug>-<4 hex>, at most 3 tries", () => {
    assert.equal(SUBDOMAIN_CANDIDATE_ATTEMPTS, 3);
    const randomBytes = (n) => Buffer.alloc(n, 0xab);
    assert.equal(subdomainCandidate("sunrise", 1, randomBytes), "pos-sunrise");
    assert.equal(
      subdomainCandidate("sunrise", 2, randomBytes),
      "pos-sunrise-abab",
    );
    assert.equal(
      subdomainCandidate("sunrise", 3, randomBytes),
      "pos-sunrise-abab",
    );
    assert.equal(subdomainCandidate("sunrise", 4, randomBytes), null);
  });

  it("validateCloudflare (codes): token required; account id 32 hex or empty; publish secret ≥ 16 or empty", () => {
    assert.ok(ACCOUNT_ID_RE.test("a".repeat(32)));
    assert.deepEqual(validateCloudflare({ token: "t" }), []);
    assert.deepEqual(
      validateCloudflare({
        token: "t",
        accountId: "a".repeat(32),
        publishSecret: "b".repeat(16),
      }),
      [],
    );
    assert.deepEqual(
      validateCloudflare({ token: "t", accountId: "", publishSecret: null }),
      [],
    );
    assert.deepEqual(validateCloudflare({}), ["cloudflare.token"]);
    assert.deepEqual(validateCloudflare({ token: "<cf-token>" }), [
      "cloudflare.token",
    ]);
    assert.deepEqual(validateCloudflare({ token: "t", accountId: "not-hex" }), [
      "cloudflare.accountId",
    ]);
    assert.deepEqual(
      validateCloudflare({ token: "t", publishSecret: "short" }),
      ["cloudflare.publishSecret"],
    );
    assert.deepEqual(validateCloudflare(null), [], "no block = realtime off");
    assert.deepEqual(validateCloudflare(undefined), []);
    assert.deepEqual(validateCloudflare("nope"), ["cloudflare"]);
    assert.deepEqual(validateCloudflare([]), ["cloudflare"]);
  });
});

describe("backend/lib/realtime.js — bundle descriptor allowlist and upload metadata (D46)", () => {
  const descriptor = (o = {}) => ({
    v: 1,
    main: "index.js",
    compatibilityDate: "2026-01-01",
    compatibilityFlags: [],
    durableObjects: [{ name: "CAFE_ROOM", className: "CafeRoom" }],
    migrations: [{ tag: "v1", newSqliteClasses: ["CafeRoom"] }],
    bundleSha256: "a".repeat(64),
    bundleBytes: 15_000,
    ...o,
  });

  it("accepts the realtime Worker's own shape and returns a clean copy", () => {
    const d = parseRealtimeDescriptor({ ...descriptor(), extra: "ignored" });
    assert.deepEqual(d, descriptor());
  });

  it("refuses anything else with code realtime-descriptor", () => {
    const bad = [
      null,
      "x",
      descriptor({ v: 2 }),
      descriptor({ main: "../index.js" }),
      descriptor({ main: "index.mjs" }),
      descriptor({ compatibilityDate: "2026-1-1" }),
      descriptor({ compatibilityFlags: ["nodejs_compat"] }),
      descriptor({ durableObjects: [] }),
      descriptor({
        durableObjects: [
          { name: "CAFE_ROOM", className: "CafeRoom" },
          { name: "B", className: "B" },
        ],
      }),
      descriptor({
        durableObjects: [{ name: "cafe room", className: "CafeRoom" }],
      }),
      descriptor({ migrations: [] }),
      descriptor({ migrations: [{ tag: "v1", newClasses: ["CafeRoom"] }] }),
      descriptor({
        migrations: [
          { tag: "v1", newSqliteClasses: ["CafeRoom"], deletedClasses: ["X"] },
        ],
      }),
      descriptor({ migrations: [{ tag: "v1", newSqliteClasses: ["Other"] }] }),
      descriptor({
        migrations: [
          { tag: "v1", newSqliteClasses: ["CafeRoom"] },
          { tag: "v1", newSqliteClasses: [] },
        ],
      }),
      descriptor({ bundleSha256: "xyz" }),
      descriptor({ bundleBytes: 1024 * 1024 + 1 }),
      descriptor({ bundleBytes: 0 }),
    ];
    for (const raw of bad)
      assert.throws(
        () => parseRealtimeDescriptor(raw),
        (e) => e.code === "realtime-descriptor",
        JSON.stringify(raw)?.slice(0, 80),
      );
  });

  it("uploadMetadataOf: main module, date, DO + TENANT_ID + secret bindings; every migration on a new script", () => {
    const meta = uploadMetadataOf(descriptor(), {
      tenantId: "sunrise",
      publishSecret: "s".repeat(64),
      migrationTag: null,
    });
    assert.deepEqual(meta, {
      main_module: "index.js",
      compatibility_date: "2026-01-01",
      bindings: [
        {
          type: "durable_object_namespace",
          name: "CAFE_ROOM",
          class_name: "CafeRoom",
        },
        { type: "plain_text", name: "TENANT_ID", text: "sunrise" },
        {
          type: "secret_text",
          name: "REALTIME_PUBLISH_SECRET",
          text: "s".repeat(64),
        },
      ],
      migrations: {
        new_tag: "v1",
        steps: [{ new_sqlite_classes: ["CafeRoom"] }],
      },
    });
  });

  it("uploadMetadataOf: no migrations once the script is at the last tag; only the later steps after an older tag; an unknown tag is refused", () => {
    const two = descriptor({
      migrations: [
        { tag: "v1", newSqliteClasses: ["CafeRoom"] },
        { tag: "v2", newSqliteClasses: [] },
      ],
    });
    const opts = { tenantId: "t", publishSecret: "s".repeat(16) };
    assert.equal(
      "migrations" in uploadMetadataOf(two, { ...opts, migrationTag: "v2" }),
      false,
    );
    assert.deepEqual(
      uploadMetadataOf(two, { ...opts, migrationTag: "v1" }).migrations,
      {
        old_tag: "v1",
        new_tag: "v2",
        steps: [{ new_sqlite_classes: [] }],
      },
    );
    assert.throws(
      () => uploadMetadataOf(two, { ...opts, migrationTag: "v9" }),
      (e) => e.code === "realtime-descriptor",
    );
    for (const bad of [
      { tenantId: "", publishSecret: "s".repeat(16) },
      { tenantId: "Bad Tenant", publishSecret: "s".repeat(16) },
      { tenantId: "t", publishSecret: "short" },
      { tenantId: "t", publishSecret: null },
    ])
      assert.throws(
        () => uploadMetadataOf(descriptor(), { ...bad, migrationTag: null }),
        (e) => e.code === "inputs-missing" && !e.message.includes("short"),
      );
  });
});

// ── dns-check.js against fake dns / Resolver (dns-check.test.mjs) ──────────
function fakeDns({
  ns = { "sandbee.in": ["ns1.godaddy.com", "ns2.godaddy.com"] },
  a = { "ns1.godaddy.com": ["1.2.3.4"], "ns2.godaddy.com": ["1.2.3.5"] },
  cname = {},
  txt = {},
  fail = {},
} = {}) {
  const calls = [];
  const miss = (host) =>
    Object.assign(new Error(`ENODATA ${host}`), { code: "ENODATA" });
  return {
    calls,
    resolveNs: async (host) => {
      calls.push(["resolveNs", host]);
      if (fail.resolveNs)
        throw Object.assign(new Error("query failed"), {
          code: fail.resolveNs,
        });
      if (!ns[host])
        throw Object.assign(new Error(`ENOTFOUND ${host}`), {
          code: "ENOTFOUND",
        });
      return ns[host];
    },
    resolve4: async (host) => {
      calls.push(["resolve4", host]);
      if (fail.resolve4)
        throw Object.assign(new Error("query failed"), { code: fail.resolve4 });
      if (!a[host])
        throw Object.assign(new Error(`ENOTFOUND ${host}`), {
          code: "ENOTFOUND",
        });
      return a[host];
    },
    resolveCname: async (host) => {
      calls.push(["resolveCname", host]);
      if (fail.resolveCname)
        throw Object.assign(new Error("server 1.2.3.4 failed"), {
          code: fail.resolveCname,
        });
      if (!cname[host]) throw miss(host);
      return Array.isArray(cname[host]) ? cname[host] : [cname[host]];
    },
    resolveTxt: async (host) => {
      calls.push(["resolveTxt", host]);
      if (fail.resolveTxt)
        throw Object.assign(new Error("server 1.2.3.4 failed"), {
          code: fail.resolveTxt,
        });
      if (!txt[host]) throw miss(host);
      return txt[host].map((v) => (Array.isArray(v) ? v : [v]));
    },
  };
}
function fakeResolverCtor(base) {
  const instances = [];
  function Resolver(options) {
    const servers = [];
    const self = {
      options,
      setServers: (list) => servers.push(...list),
      getServers: () => servers,
      resolveCname: (...x) => base.resolveCname(...x),
      resolveTxt: (...x) => base.resolveTxt(...x),
      resolve4: (...x) => base.resolve4(...x),
    };
    instances.push(self);
    return self;
  }
  Resolver.instances = instances;
  return Resolver;
}

describe("backend/lib/dns-check.js — the apex's own nameservers (D44)", () => {
  it("authoritative(apex): NS -> A of each NS -> a Resolver pointed at those IPs, with a timeout", async () => {
    const dns = fakeDns();
    const Resolver = fakeResolverCtor(dns);
    const { authoritative } = createDnsCheck({ dns, Resolver });
    const r = await authoritative("sandbee.in");
    assert.deepEqual(
      dns.calls.filter((c) => c[0] === "resolveNs"),
      [["resolveNs", "sandbee.in"]],
    );
    assert.ok(
      dns.calls.some((c) => c[0] === "resolve4" && c[1] === "ns1.godaddy.com"),
    );
    assert.deepEqual(Resolver.instances[0].getServers().sort(), [
      "1.2.3.4",
      "1.2.3.5",
    ]);
    assert.ok(Resolver.instances[0].options.timeout > 0);
    assert.equal(r, Resolver.instances[0]);
  });

  it("authoritative: one NS host failing is not fatal; none answering -> code dns-unreachable, no raw resolver text", async () => {
    const partial = fakeDns({ a: { "ns2.godaddy.com": ["1.2.3.5"] } });
    const P = fakeResolverCtor(partial);
    await createDnsCheck({ dns: partial, Resolver: P }).authoritative(
      "sandbee.in",
    );
    assert.deepEqual(P.instances[0].getServers(), ["1.2.3.5"]);
    for (const dns of [
      fakeDns({ fail: { resolveNs: "ENOTFOUND" } }),
      fakeDns({ a: {} }),
    ])
      await assert.rejects(
        createDnsCheck({ dns, Resolver: fakeResolverCtor(dns) }).authoritative(
          "sandbee.in",
        ),
        (e) =>
          e.code === "dns-unreachable" &&
          !/ENOTFOUND|query failed/.test(e.message),
      );
  });

  it("authoritative: at most 8 nameserver IPs are used", async () => {
    const hosts = Array.from({ length: 6 }, (_, i) => `ns${i}.x.com`);
    const dns = fakeDns({
      ns: { "sandbee.in": hosts },
      a: Object.fromEntries(
        hosts.map((h, i) => [h, [`10.0.${i}.1`, `10.0.${i}.2`]]),
      ),
    });
    const R = fakeResolverCtor(dns);
    await createDnsCheck({ dns, Resolver: R }).authoritative("sandbee.in");
    assert.equal(R.instances[0].getServers().length, 8);
  });

  it("checkRecords: CNAME found + ok and TXT found; trailing dot tolerated", async () => {
    const dns = fakeDns({
      cname: { "lucifer.sandbee.in": "abc.vercel-dns-017.com." },
      txt: { "_vercel.sandbee.in": ["vc-domain-verify=abc", "other"] },
    });
    const { checkRecords } = createDnsCheck({
      dns,
      Resolver: fakeResolverCtor(dns),
    });
    const r = await checkRecords({
      apex: "sandbee.in",
      host: "lucifer.sandbee.in",
      txt: { name: "_vercel", value: "vc-domain-verify=abc" },
    });
    assert.deepEqual(r.cname, { found: "abc.vercel-dns-017.com", ok: true });
    assert.deepEqual(r.txt, {
      found: ["vc-domain-verify=abc", "other"],
      ok: true,
    });
  });

  it("checkRecords: a foreign CNAME is found but not ok; no TXT asked -> ok null; misses read as null/[]", async () => {
    const wrong = fakeDns({
      cname: { "lucifer.sandbee.in": "some-other-host.example.com" },
    });
    const r2 = await createDnsCheck({
      dns: wrong,
      Resolver: fakeResolverCtor(wrong),
    }).checkRecords({
      apex: "sandbee.in",
      host: "lucifer.sandbee.in",
      txt: null,
    });
    assert.deepEqual(r2.cname, {
      found: "some-other-host.example.com",
      ok: false,
    });
    assert.deepEqual(r2.txt, { found: [], ok: null });
    const missing = fakeDns();
    const r3 = await createDnsCheck({
      dns: missing,
      Resolver: fakeResolverCtor(missing),
    }).checkRecords({
      apex: "sandbee.in",
      host: "lucifer.sandbee.in",
      txt: { name: "_vercel", value: "x" },
    });
    assert.deepEqual(r3.cname, { found: null, ok: false });
    assert.deepEqual(r3.txt, { found: [], ok: false });
  });

  it("checkRecords: a resolver failure is reported as a code, never thrown and never the raw text", async () => {
    const broken = fakeDns({
      fail: { resolveCname: "ESERVFAIL", resolveTxt: "ETIMEOUT" },
    });
    const r = await createDnsCheck({
      dns: broken,
      Resolver: fakeResolverCtor(broken),
    }).checkRecords({
      apex: "sandbee.in",
      host: "lucifer.sandbee.in",
      txt: { name: "@", value: "v" },
    });
    assert.deepEqual(r.cname, {
      found: null,
      ok: false,
      error: "dns-unreachable",
    });
    assert.deepEqual(r.txt, { found: [], ok: false, error: "dns-unreachable" });
    assert.ok(!JSON.stringify(r).includes("1.2.3.4"));
    assert.ok(
      broken.calls.some((c) => c[0] === "resolveTxt" && c[1] === "sandbee.in"),
      "@ = the apex itself",
    );
  });

  it("checkRecords: answers are bounded (≤ 8 TXT rows, ≤ 1024 chars each, CNAME ≤ 253 chars)", async () => {
    const dns = fakeDns({
      cname: { "x.sandbee.in": `${"a".repeat(300)}.vercel-dns.com` },
      txt: {
        "_vercel.sandbee.in": Array.from({ length: 12 }, (_, i) =>
          `${i}`.repeat(2000),
        ),
      },
    });
    const r = await createDnsCheck({
      dns,
      Resolver: fakeResolverCtor(dns),
    }).checkRecords({
      apex: "sandbee.in",
      host: "x.sandbee.in",
      txt: { name: "_vercel", value: "v" },
    });
    assert.equal(r.cname.found.length, 253);
    assert.equal(r.cname.ok, false, "a cut answer never counts as a match");
    assert.equal(r.txt.found.length, 8);
    assert.ok(r.txt.found.every((v) => v.length <= 1024));
  });

  it("checkRecords: TXT chunks of one record are joined (long verification values arrive split)", async () => {
    const dns = fakeDns({
      txt: { "_vercel.sandbee.in": [["vc-domain-", "verify=abc"]] },
    });
    const r = await createDnsCheck({
      dns,
      Resolver: fakeResolverCtor(dns),
    }).checkRecords({
      apex: "sandbee.in",
      host: "x.sandbee.in",
      txt: { name: "_vercel", value: "vc-domain-verify=abc" },
    });
    assert.deepEqual(r.txt, { found: ["vc-domain-verify=abc"], ok: true });
  });

  it("checkRecords: the nameservers not answering -> both rows carry dns-unreachable (never thrown)", async () => {
    const dns = fakeDns({ fail: { resolveNs: "ECONNREFUSED" } });
    const r = await createDnsCheck({
      dns,
      Resolver: fakeResolverCtor(dns),
    }).checkRecords({
      apex: "sandbee.in",
      host: "x.sandbee.in",
      txt: null,
    });
    assert.deepEqual(r, {
      cname: { found: null, ok: false, error: "dns-unreachable" },
      txt: { found: [], ok: null },
    });
  });

  it("lookupLabel: what the apex's own nameservers already answer for a label (D44 'foreign record' check)", async () => {
    const dns = fakeDns({
      cname: { "posdemo.sandbee.in": "x.vercel-dns-017.com" },
    });
    dns.resolve4 = async (host) => {
      dns.calls.push(["resolve4", host]);
      if (host === "ns1.godaddy.com") return ["1.2.3.4"];
      if (host === "ns2.godaddy.com") return ["1.2.3.5"];
      if (host === "admin.sandbee.in") return ["13.206.131.1"];
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    };
    const { lookupLabel } = createDnsCheck({
      dns,
      Resolver: fakeResolverCtor(dns),
    });
    assert.deepEqual(
      await lookupLabel({ apex: "sandbee.in", host: "posdemo.sandbee.in" }),
      {
        cname: "x.vercel-dns-017.com",
        a: [],
        inUse: true,
      },
    );
    assert.deepEqual(
      await lookupLabel({ apex: "sandbee.in", host: "admin.sandbee.in" }),
      {
        cname: null,
        a: ["13.206.131.1"],
        inUse: true,
      },
    );
    assert.deepEqual(
      await lookupLabel({ apex: "sandbee.in", host: "new.sandbee.in" }),
      {
        cname: null,
        a: [],
        inUse: false,
      },
    );
    const down = fakeDns({ fail: { resolveCname: "ETIMEOUT" } });
    await assert.rejects(
      createDnsCheck({
        dns: down,
        Resolver: fakeResolverCtor(down),
      }).lookupLabel({
        apex: "sandbee.in",
        host: "x.sandbee.in",
      }),
      (e) => e.code === "dns-unreachable",
      "an unknown answer is never read as 'free'",
    );
  });
});
