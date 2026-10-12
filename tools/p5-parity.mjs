// One-off dev check (P5 Stage 3, docs/P5-STAGE3-PLAN.md §7): the admin port of
// the go-live pure functions against the local go-live tool itself, on
// synthetic fixtures. Not part of `npm test` (it needs the POS checkout).
//
//   node tools/p5-parity.mjs [path-to-lucifer]      (default F:\lucifer)
//
// Imports F:\lucifer\scripts\go-live\{lib,realtime,dns-check}.mjs and
// ui\pure.mjs READ ONLY (D11; nothing in clients/ or deploy.profiles.json is
// touched). Prints PASS/FAIL per check with key names only — never a value.
// Exit code 0 = every check passed.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildEnv, envClientOf, mintSecrets, realtimeEnvOf, realtimeOffEnv } from "../backend/lib/golive-env.js";
import { parseWorkerUrl, signedPublishRequest, workerNameOf } from "../backend/lib/realtime.js";
import { SUBDOMAIN_RE, VERCEL_CNAME_RE, labelFromInput, webAddressRecords } from "../shared/web-address.js";
import { isStrongPassword } from "../shared/schemas.js";

const root = path.resolve(process.argv[2] ?? "F:\\lucifer");
const goLive = (file) => import(pathToFileURL(path.join(root, "scripts", "go-live", file)).href);
const gl = await goLive("lib.mjs");
const glRt = await goLive("realtime.mjs");
const glDns = await goLive("dns-check.mjs");
const glUi = await goLive(path.join("ui", "pure.mjs"));

let failed = 0;
const report = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Key names whose entries differ (never the values).
const diffKeys = (a, b) => {
  const names = new Set([...a.map((e) => e.key), ...b.map((e) => e.key)]);
  return [...names].filter((k) => !same(a.find((e) => e.key === k), b.find((e) => e.key === k)));
};

// ── fixtures (synthetic values only) ──────────────────────────────────────
const URI = "mongodb+srv://fixture-user:fixture-pass@cluster0.fixture.mongodb.net/pos?retryWrites=true&w=majority";
const GEN = { authSecret: "fixture-auth-secret-base64==", healthStatsToken: "ab".repeat(32) };
const STORES = {
  none: {
    go: null,
    admin: { pos: { image: { store: null, publicBaseUrl: "", cloudName: "", r2AccountId: "", bucket: "" } }, imageKeys: undefined },
  },
  r2: {
    go: { store: "r2", accountId: "fixture-r2-account", accessKeyId: "fixture-r2-key-id", secretAccessKey: "fixture-r2-secret", bucket: "fixture-bucket", publicBaseUrl: "https://pub-fixture.r2.dev" },
    admin: {
      pos: { image: { store: "r2", publicBaseUrl: "https://pub-fixture.r2.dev", cloudName: "", r2AccountId: "fixture-r2-account", bucket: "fixture-bucket" } },
      imageKeys: JSON.stringify({ accessKeyId: "fixture-r2-key-id", secretAccessKey: "fixture-r2-secret" }),
    },
  },
  cloudinary: {
    go: { store: "cloudinary", cloudName: "fixture-cloud", apiKey: "fixture-api-key", apiSecret: "fixture-api-secret" },
    admin: {
      pos: { image: { store: "cloudinary", publicBaseUrl: "", cloudName: "fixture-cloud", r2AccountId: "", bucket: "" } },
      imageKeys: JSON.stringify({ apiKey: "fixture-api-key", apiSecret: "fixture-api-secret" }),
    },
  },
};
const WORKER = { url: "https://pos-realtime-fixture.fixture-sub.workers.dev", secret: "cd".repeat(32) };
const REALTIME = {
  untouched: [() => [], () => []],
  off: [() => glRt.realtimeOffEnv(), () => realtimeOffEnv()],
  on: [() => glRt.realtimeEnvOf(WORKER), () => realtimeEnvOf(WORKER)],
};
const TENANTS = {
  platform: { tenantId: "fixture", rootDomain: "sandbee.in" },
  "no-tenant-yet": { tenantId: null, rootDomain: "vercel.app" },
};

// ── buildEnv: 3 stores x 3 realtime modes x 2 tenants ─────────────────────
for (const [storeName, store] of Object.entries(STORES))
  for (const [rtName, [goRt, adminRt]] of Object.entries(REALTIME))
    for (const [tenantName, tenant] of Object.entries(TENANTS)) {
      const expected = gl.buildEnv({ mongodbUri: URI, image: store.go }, tenant, GEN, goRt());
      const actual = buildEnv(envClientOf(store.admin.pos, { mongoUri: URI, imageKeys: store.admin.imageKeys }), tenant, GEN, adminRt());
      const diff = diffKeys(expected, actual);
      const orderOk = same(expected.map((e) => e.key), actual.map((e) => e.key));
      report(`buildEnv store=${storeName} realtime=${rtName} tenant=${tenantName}`, diff.length === 0 && orderOk, diff.length ? `keys differ: ${diff.join(",")}` : `${actual.length} keys`);
    }

// ── secrets, realtime helpers, records, labels ────────────────────────────
{
  const bytes = () => {
    let n = 0;
    return (len) => Buffer.alloc(len, ++n);
  };
  const a = gl.mintSecrets(undefined, bytes());
  const b = mintSecrets(undefined, bytes());
  report("mintSecrets authSecret+healthStatsToken (same randomness)", a.authSecret === b.authSecret && a.healthStatsToken === b.healthStatsToken);
  const again = gl.mintSecrets({ ...a }, () => {
    throw new Error("must not mint");
  });
  report("mintSecrets keeps existing values (go-live side)", again.authSecret === a.authSecret);
}
report("realtimeEnvOf", same(glRt.realtimeEnvOf(WORKER), realtimeEnvOf(WORKER)));
report("realtimeOffEnv", same(glRt.realtimeOffEnv(), realtimeOffEnv()));
report("signedPublishRequest", same(glRt.signedPublishRequest(WORKER.secret, "fixture", 1_758_000_000_000), signedPublishRequest(WORKER.secret, "fixture", 1_758_000_000_000)));
{
  let ok = true;
  for (const slug of ["fixture", "a", "a".repeat(50), "a".repeat(51), "Bad_Slug", "trailing-"]) {
    const g = (() => { try { return glRt.workerNameOf(slug); } catch { return "throws"; } })();
    const m = (() => { try { return workerNameOf(slug); } catch { return "throws"; } })();
    ok &&= g === m;
  }
  report("workerNameOf (valid and refused slugs)", ok);
}
{
  const samples = ["Deployed x\n  https://pos-realtime-x.sub.workers.dev\nok", "see (https://a.b.workers.dev).", "none", "", undefined];
  report("parseWorkerUrl", samples.every((s) => glRt.parseWorkerUrl(s) === parseWorkerUrl(s)));
}
{
  const cases = [
    { subdomain: "fixture", apex: "sandbee.in", recommendedCname: "abc.vercel-dns-017.com", verification: [{ type: "TXT", domain: "_vercel.sandbee.in", value: "vc-domain-verify=fixture" }] },
    { subdomain: "fixture", apex: "sandbee.in", recommendedCname: "cname.vercel-dns.com", verification: undefined },
    { subdomain: "fixture", apex: "sandbee.in", recommendedCname: "cname.vercel-dns.com", verification: [{ type: "TXT", domain: "sandbee.in", value: "v" }, { type: "OTHER", domain: "x", value: "y" }] },
  ];
  report("webAddressRecords", cases.every((c) => same(gl.webAddressRecords(c), webAddressRecords(c))));
}
{
  const names = ["cname.vercel-dns.com", "abc.vercel-dns-017.com", "evil-vercel-dns.com.attacker.net", "notvercel-dns.com", "x.vercel-dns.com.evil"];
  report("VERCEL_CNAME_RE", names.every((n) => glDns.VERCEL_CNAME_RE.test(n) === VERCEL_CNAME_RE.test(n)));
  report("SUBDOMAIN_RE", gl.SUBDOMAIN_RE.source === SUBDOMAIN_RE.source);
}
{
  // Admin refuses MORE labels than the go-live tool (D44); everything the
  // go-live tool accepts that admin does not must be one of those.
  const inputs = ["fixture", "  Fixture ", "fixture.sandbee.in", "https://fixture.sandbee.in/", "", "a.b.in", "Bad_1", "www", "api", "store", "pos", "wa"];
  const stricter = [];
  let ok = true;
  for (const raw of inputs) {
    const g = (() => { try { return glUi.subdomainFromInput(raw, "sandbee.in"); } catch { return "refused"; } })();
    const m = labelFromInput(raw);
    const mine = m.problem ? "refused" : m.label;
    if (g === mine) continue;
    if (g !== "refused" && m.problem === "label-reserved") stricter.push(g);
    else ok = false;
  }
  report("labelFromInput vs subdomainFromInput", ok, `admin also refuses: ${stricter.length ? stricter.join(",") : "-"}`);
}
{
  const pw = ["Strong-Pass-1!", "abcdefg1", "abcdefg!", "Ab1!", "", "12345678-"];
  report("isStrongPassword", pw.every((p) => gl.isStrongPassword(p) === isStrongPassword(p)));
}

console.log(failed === 0 ? "parity: all checks passed" : `parity: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
