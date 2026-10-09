// Adapter-level fakes for the worker tests: the private GitHub builder (runs,
// artifacts built from a real tgz + zip), Vercel (deployments, production
// pointer, promote/rollback) and the health probe. Also a ustar writer and a
// zip writer so tests can craft hostile archives.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import zlib from "node:zlib";
import { ProviderError } from "../../backend/lib/provider-http.js";
import { buildEnvHash } from "../../backend/worker/artifact.js";

export const sha256 = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");
// ---- ustar -------------------------------------------------------------------------
const octal = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
function header({
  name,
  type = "file",
  size = 0,
  mode = 0o644,
  linkname = "",
}) {
  const block = Buffer.alloc(512);
  const put = (text, off, len) => block.write(text.slice(0, len), off, "utf8");
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  block.fill(0x20, 148, 156);
  const flag = {
    file: "0",
    dir: "5",
    symlink: "2",
    hardlink: "1",
    device: "3",
    fifo: "6",
    pax: "x",
  }[type];
  block.write(flag, 156);
  put(linkname, 157, 100);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7) + " ", 148);
  return block;
}
// entries: [{name, type, data, linkname, mode}] -> gzipped tar. Names are
// taken verbatim (hostile ones included).
export function makeTgz(entries, { end = true } = {}) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const isFile = (entry.type ?? "file") === "file";
    parts.push(header({ ...entry, size: isFile ? data.length : 0 }));
    if (isFile && data.length) {
      parts.push(data);
      parts.push(Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  if (end) parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}
// A valid builder output; `extra` adds entries, `sha` makes the bytes unique.
export function validOutput(sha = "0".repeat(40), extra = []) {
  const entries = [
    { name: ".vercel/output", type: "dir" },
    {
      name: ".vercel/output/config.json",
      data: JSON.stringify({ version: 3 }),
    },
    { name: ".vercel/output/static", type: "dir" },
    { name: ".vercel/output/static/index.html", data: `<html>${sha}</html>` },
    { name: ".vercel/output/functions", type: "dir" },
    ...extra,
  ];
  const files = entries.filter((e) => (e.type ?? "file") === "file").length;
  const dirs = entries.filter((e) => e.type === "dir").length - 1; // not the root
  const symlinks = entries.filter((e) => e.type === "symlink").length;
  return { tgz: makeTgz(entries), counts: { files, dirs, symlinks } };
}
// ---- zip -----------------------------------------------------------------------------
export function makeZip(files, { method = 8, tamperCrc = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.from(file.data);
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = (zlib.crc32(data) ^ (tamperCrc ? 1 : 0)) >>> 0;
    const name = Buffer.from(file.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}
// ---- GitHub ----------------------------------------------------------------------------
export const BUILDER_SHA = "c".repeat(40);
export function createFakeGitHub({
  cliVersion = "63.1.0",
  nodeVersion = "22.23.3",
} = {}) {
  const state = {
    builderSha: BUILDER_SHA,
    descriptors: {},
    dispatches: [],
    cancels: [],
    deleted: [],
    runs: new Map(),
    artifacts: new Map(),
    nextRun: 7001,
    nextArtifact: 9001,
    autoComplete: true,
    completeAfter: 2, // polls before the run completes
    tweak: {}, // {run(r), manifest(m, run), zip(files), artifact(meta), tgz(buf), failedStep}
    onPoll: null, // async (run, n) hook
    configured: { source: false, builder: true },
  };
  const descriptor = (sha) =>
    state.descriptors[sha] ?? { protocol: 1, nodeVersion, cliVersion };
  const runView = (run) => ({
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    displayTitle: run.displayTitle,
    runAttempt: run.runAttempt,
    headSha: run.headSha,
    path: run.path,
    headBranch: run.headBranch,
    event: run.event,
    htmlUrl: `https://github.com/owner/builder/actions/runs/${run.id}`,
    createdAt: null,
    updatedAt: new Date().toISOString(),
  });
  function complete(run) {
    const { sha, build_env: envText, build_id: buildId } = run.inputs;
    const env = JSON.parse(envText);
    const { tgz: made, counts } = validOutput(sha);
    const tgz = state.tweak.tgz ? state.tweak.tgz(made, run) : made;
    const desc = descriptor(state.builderSha);
    let manifest = {
      format: "sandbee-build-output/1",
      protocol: desc.protocol,
      sha,
      buildId,
      builderSha: state.builderSha,
      workflowRef: "owner/builder/.github/workflows/build.yml@refs/heads/main",
      runId: String(run.id),
      runAttempt: String(run.runAttempt),
      nodeVersion: desc.nodeVersion,
      cliVersion: desc.cliVersion,
      settings: {},
      extendedSettingsUsed: false,
      buildEnvKeys: Object.keys(env).sort(),
      buildEnvSha256: buildEnvHash(env),
      outputPath: ".vercel/output",
      builtUnder: ".vercel/output",
      output: { bytes: tgz.length, sha256: sha256(tgz), ...counts },
      scan: {
        before: { maps: 2, envExampleFiles: 1 },
        after: { maps: 0, envFiles: 0, envExampleFiles: 0 },
        findings: 0,
        allowlistedHits: [
          { package: "mongoose", rule: "mongodb-credentials-uri" },
        ],
      },
    };
    if (state.tweak.manifest)
      manifest = state.tweak.manifest(manifest, run) ?? manifest;
    let files = [
      { name: "output.tgz", data: tgz },
      { name: "manifest.json", data: JSON.stringify(manifest) },
    ];
    if (state.tweak.zip) files = state.tweak.zip(files, run) ?? files;
    const zip = makeZip(files);
    const name = `pos-build-${buildId}`;
    const make = (n) => ({
      id: state.nextArtifact++,
      name: n,
      size: zip.length,
      expired: false,
      digest: `sha256:${sha256(zip)}`,
      createdAt: null,
      expiresAt: null,
    });
    let metas = [make(name)];
    if (state.tweak.artifact)
      metas = state.tweak.artifact(metas, make) ?? metas;
    for (const meta of metas)
      state.artifacts.set(meta.id, { meta, runId: run.id, zip });
    run.status = "completed";
    run.conclusion = "success";
    state.tweak.run?.(run);
  }
  const api = {
    state,
    configured: () => state.configured,
    runUrl: (id) => `https://github.com/owner/builder/actions/runs/${id}`,
    async builderHead() {
      return { ref: "main", sha: state.builderSha };
    },
    async builderFile(sha) {
      return descriptor(sha);
    },
    async dispatch({ buildId, inputs }) {
      state.dispatches.push({ buildId, inputs: { ...inputs } });
      const run = {
        id: state.nextRun++,
        status: "queued",
        conclusion: null,
        displayTitle: `pos-build ${buildId}`,
        runAttempt: 1,
        headSha: state.builderSha,
        path: ".github/workflows/build.yml",
        headBranch: "main",
        event: "workflow_dispatch",
        inputs,
        polls: 0,
        failedStep: null,
      };
      state.runs.set(run.id, run);
      return { runId: run.id, htmlUrl: api.runUrl(run.id), via: "response" };
    },
    async findRun(buildId) {
      const run = [...state.runs.values()].find(
        (r) => r.displayTitle === `pos-build ${buildId}`,
      );
      return run ? { runId: run.id, htmlUrl: api.runUrl(run.id) } : null;
    },
    async run(id) {
      const run = state.runs.get(id);
      if (!run) throw new ProviderError("github", "not-found", { status: 404 });
      run.polls++;
      await state.onPoll?.(run, run.polls);
      if (run.status !== "completed" && state.autoComplete) {
        if (run.polls === 1) run.status = "in_progress";
        else if (run.polls >= state.completeAfter) {
          if (state.tweak.fail) {
            run.status = "completed";
            run.conclusion = "failure";
            run.failedStep = state.tweak.fail;
          } else complete(run);
        }
      }
      return runView(run);
    },
    async failedStepName(id) {
      return state.runs.get(id)?.failedStep ?? state.tweak.failedStep ?? null;
    },
    async cancelRun(id) {
      state.cancels.push(id);
      const run = state.runs.get(id);
      if (run && run.status !== "completed") {
        run.status = "completed";
        run.conclusion = "cancelled";
      }
      return true;
    },
    async listArtifacts(runId) {
      return [...state.artifacts.values()]
        .filter((a) => a.runId === runId)
        .map((a) => ({ ...a.meta }));
    },
    async downloadArtifact(id, file, { maxBytes } = {}) {
      const a = state.artifacts.get(id);
      if (!a) throw new ProviderError("github", "not-found", { status: 404 });
      if (a.zip.length > maxBytes)
        throw new ProviderError("github", "too-large");
      if (a.meta.digest !== `sha256:${sha256(a.zip)}`)
        throw new ProviderError("github", "digest-mismatch");
      await writeFile(file, a.zip);
      return { bytes: a.zip.length, sha256: sha256(a.zip) };
    },
    async deleteArtifact(id) {
      state.deleted.push(id);
      state.artifacts.delete(id);
      return true;
    },
  };
  return api;
}
// ---- Vercel -----------------------------------------------------------------------------
export function createFakeVercel({ projectId = "prj_1" } = {}) {
  const state = {
    projectId,
    deployments: new Map(),
    production: "dpl_live",
    lastAlias: {
      toDeploymentId: "dpl_live",
      jobStatus: "succeeded",
      type: "promote",
    },
    project: {
      framework: "nextjs",
      rootDirectory: "apps/cafe",
      nodeVersion: "22.x",
    },
    envs: [],
    seq: 0,
    readyAfter: 1,
    rollbackError: null,
    promoteError: null,
    userError: null,
    calls: [],
  };
  const add = (d) => {
    state.deployments.set(d.id, {
      url: `${d.id}.vercel.app`,
      readyState: "READY",
      target: "production",
      prebuilt: false,
      createdAt: Date.now() - 30 * 86400000,
      meta: {},
      polls: 0,
      ...d,
    });
    return state.deployments.get(d.id);
  };
  add({ id: "dpl_live" });
  const note = (name, ...args) => state.calls.push({ name, args });
  const view = (d) => ({
    id: d.id,
    url: d.url,
    projectId,
    readyState: d.readyState,
    readySubstate: "",
    target: d.target,
    source: "cli",
    prebuilt: d.prebuilt,
    isRollbackCandidate: null,
    createdAt: d.createdAt,
    meta: { ...d.meta },
    aliasAssigned: false,
  });
  const api = {
    state,
    add,
    // Called by the fake CLI: a new, still building deployment.
    createFromCli(meta) {
      const id = `dpl_${++state.seq}`;
      return add({
        id,
        readyState: "BUILDING",
        prebuilt: true,
        createdAt: Date.now(),
        meta,
        target: "production",
      });
    },
    async user() {
      note("user");
      if (state.userError) throw state.userError;
      return { id: "u1", username: "owner", defaultTeamId: null };
    },
    async project(id) {
      note("project", id);
      if (id !== state.projectId)
        throw new ProviderError("vercel", "not-found", { status: 404 });
      return {
        id: projectId,
        name: "demo",
        accountId: "team_1",
        ...state.project,
        sourceFilesOutsideRootDirectory: true,
        installCommand: null,
        buildCommand: null,
        outputDirectory: null,
        productionDeploymentId: state.production,
        lastAliasRequest: state.lastAlias,
      };
    },
    async projectEnv() {
      note("projectEnv");
      return state.envs;
    },
    async deployment(id) {
      note("deployment", id);
      const d = state.deployments.get(id);
      if (!d) throw new ProviderError("vercel", "not-found", { status: 404 });
      d.polls++;
      if (d.readyState === "BUILDING" && d.polls > state.readyAfter)
        d.readyState = "READY";
      return view(d);
    },
    async findDeploymentByMeta(pid, key, value) {
      note("findByMeta", value);
      const d = [...state.deployments.values()].find(
        (x) => x.meta[key] === value,
      );
      return d ? view(d) : null;
    },
    async promote(pid, id) {
      note("promote", id);
      if (state.promoteError) throw state.promoteError;
      const d = state.deployments.get(id);
      if (!d || d.readyState !== "READY")
        throw new ProviderError("vercel", "invalid", { status: 422 });
      state.production = id;
      state.lastAlias = {
        toDeploymentId: id,
        jobStatus: "succeeded",
        type: "promote",
      };
      return { status: 201 };
    },
    async rollback(pid, id) {
      note("rollback", id);
      if (state.rollbackError) throw state.rollbackError;
      if (!state.deployments.has(id))
        throw new ProviderError("vercel", "not-found", { status: 404 });
      state.production = id;
      state.lastAlias = {
        toDeploymentId: id,
        jobStatus: "succeeded",
        type: "rollback",
      };
      return { status: 201 };
    },
    async listDeployments() {
      note("list");
      return [...state.deployments.values()].map(view);
    },
    async deleteDeployment(id) {
      note("delete", id);
      state.deployments.delete(id);
      return true;
    },
    calledWith: (name) => state.calls.filter((c) => c.name === name),
  };
  return api;
}
// ---- health -------------------------------------------------------------------------------
// Healthy iff the CURRENT production deployment is not in `bad`.
export function createHealthGet(vercel, { tenant = "demo" } = {}) {
  const bad = new Set();
  const calls = [];
  async function get(host, path) {
    calls.push({ host, path, production: vercel.state.production });
    const healthy = !bad.has(vercel.state.production);
    if (path === "/api/health")
      return {
        status: healthy ? 200 : 503,
        headers: { "content-type": "application/json" },
        text: JSON.stringify(
          healthy ? { ok: true, db: "up", tenant } : { ok: false },
        ),
      };
    return {
      status: healthy ? 200 : 500,
      headers: { "content-type": "text/html; charset=utf-8" },
      text: "<!DOCTYPE html><html><body>login</body></html>",
    };
  }
  return { get, bad, calls };
}
