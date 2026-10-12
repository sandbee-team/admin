// Spike S1 (P5 Stage 3, docs/P5-STAGE3-PLAN.md §12) — dev PC only, against the
// owner's THROWAWAY Vercel account. Not part of `npm test`.
//
//   node tools/spikes/p5-vercel.mjs create   project + settings + env + domain
//   node tools/spikes/p5-vercel.mjs check    after the GoDaddy record: DNS
//                                            (apex's own nameservers), Vercel
//                                            verify/config, TLS before a deploy
//
// Token: env SPIKE_VERCEL_TOKEN only (never argv, never printed). Output:
// status codes, field names, booleans and setting codes; the only values
// printed are the public DNS records the owner must enter at GoDaddy.
// Writes: one project `p5spike` (env with SYNTHETIC values, never deployed)
// and the domain p5spike.sandbee.in on it. Nothing is deleted.
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { buildEnv, mintSecrets, realtimeOffEnv } from "../../backend/lib/golive-env.js";
import { createDnsCheck } from "../../backend/lib/dns-check.js";
import { createVercel } from "../../backend/lib/vercel.js";
import { inspectProject } from "../../backend/worker/verify.js";
import { PLATFORM_APEX, hostOf, recommendedCnameOf, webAddressRecords } from "../../shared/web-address.js";

const LABEL = "p5spike";
const PROJECT = "p5spike";
const HOST = hostOf(LABEL);
const BASE = "https://api.vercel.com";
const token = process.env.SPIKE_VERCEL_TOKEN;
if (!token) {
  console.log("SPIKE_VERCEL_TOKEN is not set in this process — nothing done.");
  process.exit(2);
}
const mode = process.argv[2];
if (!["create", "check"].includes(mode)) {
  console.log("usage: node tools/spikes/p5-vercel.mjs create|check");
  process.exit(2);
}

const line = (step, facts) =>
  console.log(`${step}: ${Object.entries(facts).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(",")}]` : v}`).join(" ")}`);
const fieldsOf = (o) => (o && typeof o === "object" ? Object.keys(o).sort() : []);
async function api(method, path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (error) {
    return { status: 0, json: null, error: error?.cause?.code ?? error?.name ?? "error" };
  }
}
const errCode = (r) => r.json?.error?.code ?? r.error ?? "-";

async function project() {
  const got = await api("GET", `/v9/projects/${PROJECT}`);
  line("project-get", { status: got.status, code: got.status === 200 ? "-" : errCode(got) });
  return got.status === 200 ? got.json : null;
}
const regionsOf = (p) => ({
  serverlessFunctionRegion: p?.serverlessFunctionRegion ?? "-",
  functionDefaultRegions: p?.resourceConfig?.functionDefaultRegions ?? "-",
  defaultFunctionDefaultRegions: p?.defaultResourceConfig?.functionDefaultRegions ?? "-",
});
const settingsOf = (p) => ({
  framework: p?.framework ?? "-",
  rootDirectory: p?.rootDirectory ?? "-",
  nodeVersion: p?.nodeVersion ?? "-",
  sourceFilesOutsideRootDirectory: p?.sourceFilesOutsideRootDirectory ?? "-",
  production: p?.targets?.production ? "yes" : "no",
  ...regionsOf(p),
});

async function create() {
  const user = await api("GET", "/v2/user");
  line("user", { status: user.status, defaultTeamId: user.json?.user?.defaultTeamId ? "present" : "absent" });
  if (user.status !== 200) return;

  let p = await project();
  if (!p) {
    const made = await api("POST", "/v11/projects", { name: PROJECT, framework: "nextjs", rootDirectory: "apps/cafe", serverlessFunctionRegion: "bom1" });
    line("project-create", { status: made.status, code: made.status < 300 ? "-" : errCode(made), fields: fieldsOf(made.json).length, ...regionsOf(made.json) });
    if (made.status >= 300) return;
    p = made.json;
  }
  const patch = await api("PATCH", `/v9/projects/${p.id}`, { nodeVersion: "22.x", sourceFilesOutsideRootDirectory: true });
  line("project-patch node+sourceFiles", { status: patch.status, code: patch.status < 300 ? "-" : errCode(patch) });
  p = (await project()) ?? p;
  if (!JSON.stringify(regionsOf(p)).includes("bom1")) {
    const r1 = await api("PATCH", `/v9/projects/${p.id}`, { serverlessFunctionRegion: "bom1" });
    line("project-patch serverlessFunctionRegion", { status: r1.status, code: r1.status < 300 ? "-" : errCode(r1) });
    const r2 = await api("PATCH", `/v9/projects/${p.id}`, { resourceConfig: { functionDefaultRegions: ["bom1"] } });
    line("project-patch resourceConfig.functionDefaultRegions", { status: r2.status, code: r2.status < 300 ? "-" : errCode(r2) });
    p = (await project()) ?? p;
  }
  line("project-settings", settingsOf(p));

  // The exact go-live env (D43) with SYNTHETIC values: no image store (all
  // store keys ""), realtime off (the triple ""), minted secrets.
  const generated = mintSecrets({}, randomBytes);
  const envs = buildEnv(
    { mongodbUri: "mongodb+srv://spike:spike@spike.invalid/p5spike?retryWrites=true", image: null },
    { tenantId: LABEL, rootDomain: PLATFORM_APEX },
    generated,
    realtimeOffEnv(),
  );
  const up = await api("POST", `/v10/projects/${p.id}/env?upsert=true`, envs);
  const failed = Array.isArray(up.json?.failed) ? up.json.failed : [];
  line("env-upsert", {
    status: up.status,
    code: up.status < 300 ? "-" : errCode(up),
    sent: envs.length,
    blanks: envs.filter((e) => e.value === "").length,
    fields: fieldsOf(up.json),
    created: Array.isArray(up.json?.created) ? up.json.created.length : up.json?.created ? 1 : 0,
    failed: failed.length,
    failedCodes: [...new Set(failed.map((f) => f?.error?.code ?? "-"))],
    failedKeys: failed.map((f) => f?.error?.key ?? f?.error?.envVarKey ?? "?"),
  });
  const meta1 = await envMeta(p.id, "env-meta");
  const up2 = await api("POST", `/v10/projects/${p.id}/env?upsert=true`, envs);
  line("env-upsert-again (same values)", { status: up2.status, code: up2.status < 300 ? "-" : errCode(up2) });
  const meta2 = await envMeta(p.id, "env-meta-again");
  const bumped = meta2.filter((m) => meta1.find((o) => o.id === m.id && o.updatedAt !== m.updatedAt)).length;
  line("env-updatedAt", { rowsBumpedBySameValueUpsert: bumped, rows: meta2.length });
  const changed = envs.filter((e) => e.key === "HOSTING_TIER").map((e) => ({ ...e, value: "C" }));
  const up3 = await api("POST", `/v10/projects/${p.id}/env?upsert=true`, changed);
  const meta3 = await envMeta(p.id, "env-meta-after-one-change");
  line("env-updatedAt", {
    changedKeyBumped: meta3.filter((m) => m.key === "HOSTING_TIER").every((m) => meta2.find((o) => o.id === m.id)?.updatedAt !== m.updatedAt),
    otherRowsBumped: meta3.filter((m) => m.key !== "HOSTING_TIER" && meta2.find((o) => o.id === m.id)?.updatedAt !== m.updatedAt).length,
    status: up3.status,
  });
  await api("POST", `/v10/projects/${p.id}/env?upsert=true`, envs.filter((e) => e.key === "HOSTING_TIER"));

  // Admin's own Verify inspection on the go-live-created project.
  const vercel = createVercel({ token });
  const ins = await inspectProject(vercel, { projectId: p.id, tenantId: LABEL, pos: { rootDomain: PLATFORM_APEX, image: { store: null }, cloudflare: null } });
  line("admin-inspectProject", { vercel: ins.vercel, project: ins.project, env: ins.env, problems: ins.problems.map((x) => x.name), warnings: ins.warnings.map((x) => x.name), names: ins.names });

  // Domain: attach (or adopt), verify, config.
  let dom = await api("GET", `/v9/projects/${p.id}/domains/${HOST}`);
  line("domain-get", { status: dom.status });
  if (dom.status !== 200) {
    dom = await api("POST", `/v10/projects/${p.id}/domains`, { name: HOST });
    line("domain-add", { status: dom.status, code: dom.status < 300 ? "-" : errCode(dom), fields: fieldsOf(dom.json) });
    if (dom.status >= 300) return;
  }
  await domainState(p.id, dom.json);
  line("next", { owner: "enter the records above at GoDaddy (DNS only), then run: node tools/spikes/p5-vercel.mjs check" });
}

async function envMeta(projectId, step) {
  const r = await api("GET", `/v10/projects/${projectId}/env`);
  const rows = Array.isArray(r.json?.envs) ? r.json.envs : [];
  const types = {};
  for (const e of rows) types[e.type] = (types[e.type] ?? 0) + 1;
  const enc = rows.filter((e) => e.type !== "plain");
  line(step, {
    status: r.status,
    rows: rows.length,
    keys: new Set(rows.map((e) => e.key)).size,
    types: Object.entries(types).map(([t, n]) => `${t}:${n}`),
    rowFields: [...new Set(rows.flatMap(fieldsOf))].sort(),
    targetIsArray: rows.every((e) => Array.isArray(e.target)),
    targetsPerRow: [...new Set(rows.map((e) => (Array.isArray(e.target) ? e.target.length : 1)))],
    updatedAtNumber: rows.every((e) => Number.isFinite(e.updatedAt)),
    encryptedValueReturned: enc.filter((e) => typeof e.value === "string" && e.value.length > 0).length,
    plainValueReturned: rows.filter((e) => e.type === "plain" && typeof e.value === "string").length,
  });
  return rows.map((e) => ({ id: e.id, key: e.key, updatedAt: e.updatedAt }));
}

async function domainState(projectId, domain) {
  line("domain", {
    verified: Boolean(domain?.verified),
    verificationTypes: (domain?.verification ?? []).map((v) => v?.type ?? "?"),
    verificationDomainsRelative: (domain?.verification ?? []).map((v) => (typeof v?.domain === "string" ? v.domain.replace(`.${PLATFORM_APEX}`, "").replace(PLATFORM_APEX, "@") : "?")),
    fields: fieldsOf(domain),
  });
  let verified = Boolean(domain?.verified);
  if (!verified) {
    const v = await api("POST", `/v9/projects/${projectId}/domains/${HOST}/verify`);
    verified = Boolean(v.json?.verified);
    line("domain-verify", { status: v.status, code: v.status < 300 ? "-" : errCode(v), verified });
  }
  const cfg = await api("GET", `/v6/domains/${HOST}/config`);
  line("domain-config", {
    status: cfg.status,
    fields: fieldsOf(cfg.json),
    misconfigured: cfg.json?.misconfigured ?? "-",
    configuredBy: cfg.json?.configuredBy ?? "null",
    recommendedCNAME: Array.isArray(cfg.json?.recommendedCNAME) ? cfg.json.recommendedCNAME.length : "-",
    recommendedIPv4: Array.isArray(cfg.json?.recommendedIPv4) ? cfg.json.recommendedIPv4.length : "-",
  });
  const records = webAddressRecords({ subdomain: LABEL, apex: PLATFORM_APEX, recommendedCname: recommendedCnameOf(cfg.json), verification: verified ? [] : domain?.verification });
  for (const r of records) console.log(`RECORD (public DNS, enter at GoDaddy): type=${r.type} name=${r.name} value=${r.value}`);
  return { records, verified, configured: cfg.status === 200 ? !cfg.json?.misconfigured : null };
}

function tlsProbe(host) {
  return new Promise((resolve) => {
    const req = httpsRequest({ host, path: "/", method: "GET", timeout: 15_000, headers: { "user-agent": "p5-spike" } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, vercelError: res.headers["x-vercel-error"] ?? "-", tls: "ok" });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (e) => resolve({ status: 0, vercelError: "-", tls: e.code ?? e.name }));
    req.end();
  });
}

async function check() {
  const dns = createDnsCheck();
  for (const label of ["posdemo", LABEL, `p5free-${randomBytes(3).toString("hex")}`]) {
    try {
      const r = await dns.lookupLabel({ apex: PLATFORM_APEX, host: hostOf(label) });
      line(`dns-lookupLabel ${label === LABEL || label === "posdemo" ? label : "random-free-label"}`, { inUse: r.inUse, cnameIsVercel: r.cname ? /vercel-dns/.test(r.cname) : "-", a: r.a.length });
    } catch (e) {
      line(`dns-lookupLabel ${label}`, { error: e.code ?? e.name });
    }
  }
  const p = await project();
  if (!p) return;
  const dom = await api("GET", `/v9/projects/${p.id}/domains/${HOST}`);
  line("domain-get", { status: dom.status });
  const state = await domainState(p.id, dom.json);
  const txt = state.records.find((r) => r.type === "TXT") ?? null;
  const rec = await dns.checkRecords({ apex: PLATFORM_APEX, host: HOST, txt });
  line("dns-authoritative", { cnameOk: rec.cname.ok, cnameFound: rec.cname.found ? "yes" : "no", cnameError: rec.cname.error ?? "-", txtOk: rec.txt.ok, txtError: rec.txt.error ?? "-" });
  const tls = await tlsProbe(HOST);
  line("tls-probe (no deployment yet)", tls);
}

await (mode === "create" ? create() : check());
