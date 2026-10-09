// Getting a verified plaintext output.tgz onto the work volume: from the S3
// cache (integrity-checked on every reuse, REV2 section 2.7) or, when the cache
// is off, from the GitHub artifact the build lane kept. Paths, the free-space
// check and the local one-hour reuse live here too.
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { JobFail } from "./lease.js";
import { acceptBuild, sha256File } from "./artifact.js";

export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
export const LOCAL_REUSE_MS = 60 * 60 * 1000;
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const dirs = (workDir) => ({
  home: path.join(workDir, "home"),
  tmp: path.join(workDir, "tmp"),
  cache: path.join(workDir, "cache"),
  jobs: path.join(workDir, "jobs"),
  builds: path.join(workDir, "builds"),
});
export async function ensureLayout(workDir) {
  for (const dir of Object.values(dirs(workDir)))
    await mkdir(dir, { recursive: true });
}
export const jobDir = (ctx, requestId) => {
  if (!UUID_RE.test(requestId)) throw new JobFail("bad-id", "Invalid job id.");
  return path.join(dirs(ctx.workDir).jobs, requestId);
};
export const buildDir = (ctx, sha, buildKey) =>
  path.join(
    dirs(ctx.workDir).builds,
    `${sha.slice(0, 12)}-${buildKey.slice(0, 16)}`,
  );
export async function freeBytes(dir) {
  const fs = await statfs(dir);
  return Number(fs.bavail) * Number(fs.bsize);
}
// Refuses to start a download or build with less than 2 GB free.
export async function ensureSpace(ctx) {
  let free;
  try {
    free = await (ctx.freeBytes ?? freeBytes)(ctx.workDir);
  } catch {
    free = Infinity; // an unreadable statfs must not block work
  }
  if (free < MIN_FREE_BYTES)
    throw new JobFail("no-space", "The work volume is almost full.");
}
export async function rmDir(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
// A verified local tgz younger than an hour, else null.
async function localTgz(dir, expect) {
  const file = path.join(dir, "output.tgz");
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > LOCAL_REUSE_MS) return null;
    if (expect.bytes !== undefined && info.size !== expect.bytes) return null;
    const sha =
      expect.sha256 ??
      JSON.parse(await readFile(path.join(dir, "output.json"), "utf8")).sha256;
    return (await sha256File(file)) === sha ? file : null;
  } catch {
    return null;
  }
}
export async function writeSidecar(dir, { sha256, bytes }) {
  await writeFile(
    path.join(dir, "output.json"),
    JSON.stringify({ sha256, bytes, at: new Date().toISOString() }),
  );
}
// -> {state:"ok", path, manifest|null}
//  | {state:"invalid", reason}   cache object failed an integrity check
//  | {state:"gone"}              nothing to fetch (cache entry or artifact vanished)
export async function fetchBuild(ctx, { sha, buildKey, row, signal }) {
  await ensureSpace(ctx);
  const dir = buildDir(ctx, sha, buildKey);
  await mkdir(dir, { recursive: true });
  if (ctx.cache) {
    let found;
    try {
      found = await ctx.cache.lookup({ sha, buildKey });
    } catch {
      return { state: "gone" };
    }
    if (found.state === "invalid")
      return { state: "invalid", reason: found.reason };
    if (found.state !== "hit") return { state: "gone" };
    const { manifest } = found;
    const reuse = await localTgz(dir, {
      bytes: manifest.output.bytes,
      sha256: manifest.output.sha256,
    });
    if (reuse) return { state: "ok", path: reuse, manifest, reused: true };
    const got = await ctx.cache.fetch({
      sha,
      buildKey,
      destPath: path.join(dir, "output.tgz"),
    });
    if (got.state === "hit")
      return { state: "ok", path: got.path, manifest: got.manifest };
    if (got.state === "invalid")
      return { state: "invalid", reason: got.reason };
    return { state: "gone" };
  }
  // Cache off: the build lane kept the verified tgz (and the GitHub artifact).
  const reuse = await localTgz(dir, {});
  if (reuse) return { state: "ok", path: reuse, manifest: null, reused: true };
  if (!row?.artifactId || !row.runId || !row.buildId) return { state: "gone" };
  try {
    const accepted = await acceptBuild(ctx, {
      runId: row.runId,
      buildId: row.buildId,
      sha,
      env: row.inputs.env,
      builderSha: row.inputs.builder.sha,
      dir,
      signal,
    });
    await writeSidecar(dir, accepted.info.output);
    return { state: "ok", path: accepted.tgzPath, manifest: null };
  } catch (error) {
    if (error?.name === "AcceptError" && error.code.startsWith("artifact-"))
      return { state: "gone" };
    throw error;
  }
}
// Removes build directories older than an hour (the sweep and boot).
export async function pruneBuilds(ctx, maxAgeMs = LOCAL_REUSE_MS) {
  const base = dirs(ctx.workDir).builds;
  let names = [];
  try {
    names = await readdir(base);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const dir = path.join(base, name);
    try {
      const info = await stat(dir);
      if (Date.now() - info.mtimeMs > maxAgeMs) {
        await rmDir(dir);
        removed++;
      }
    } catch {
      // Gone already.
    }
  }
  return removed;
}
