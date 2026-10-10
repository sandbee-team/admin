// Everything the worker does with an UNTRUSTED builder artifact: the zip reader,
// the tar validator and extractor (pure JS: exact names, no output parsing, no
// dependency on a tar binary), the name-based scan rules, and the acceptance
// checks the builder security review requires. Nothing here prints or returns
// file contents; results are counts and codes.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { createWriteStream } from "node:fs";
import { ProviderError } from "../lib/provider-http.js";
import { knownCode } from "../../shared/deploy-errors.js";
import { parseBuilderJson } from "../lib/build-inputs.js";

export class AcceptError extends Error {
  constructor(code) {
    super(`Build not accepted (${code})`);
    knownCode(code);
    this.name = "AcceptError";
    this.code = code;
  }
}
export const MAX_TAR_ENTRIES = 300000;
export const MAX_TAR_BYTES = 1.5 * 1024 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 400 * 1024 * 1024;
const MAX_META = 64 * 1024;
const MAX_MANIFEST = 1024 * 1024;
const OUT = ".vercel/output";

// ---- zip (central directory; stored or deflate; no zip64) ---------------------
// Returns [{name, method, crc, csize, usize, lho}]. Throws AcceptError("zip-invalid").
export async function readZipEntries(zipPath, { maxEntries = 8 } = {}) {
  const bad = () => new AcceptError("zip-invalid");
  const handle = await open(zipPath, "r");
  try {
    const { size } = await handle.stat();
    const tailLen = Math.min(size, 66000);
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        e = i;
        break;
      }
    if (e < 0) throw bad();
    const count = tail.readUInt16LE(e + 10),
      cdSize = tail.readUInt32LE(e + 12),
      cdOff = tail.readUInt32LE(e + 16);
    if (
      cdOff === 0xffffffff ||
      count === 0xffff ||
      count > maxEntries ||
      cdSize > 1024 * 1024 ||
      cdOff + cdSize > size
    )
      throw bad();
    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOff);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw bad();
      const flags = cd.readUInt16LE(p + 8),
        method = cd.readUInt16LE(p + 10),
        crc = cd.readUInt32LE(p + 16),
        csize = cd.readUInt32LE(p + 20),
        usize = cd.readUInt32LE(p + 24),
        nl = cd.readUInt16LE(p + 28),
        el = cd.readUInt16LE(p + 30),
        cl = cd.readUInt16LE(p + 32),
        lho = cd.readUInt32LE(p + 42);
      if (p + 46 + nl + el + cl > cd.length) throw bad();
      if (flags & 1) throw bad(); // encrypted
      entries.push({
        name: cd.toString("utf8", p + 46, p + 46 + nl),
        method,
        crc,
        csize,
        usize,
        lho,
      });
      p += 46 + nl + el + cl;
    }
    return { entries, size };
  } finally {
    await handle.close();
  }
}
// Streams one entry to `dest`, checking CRC, declared size and a hard cap.
export async function extractZipEntry(
  zipPath,
  entry,
  dest,
  { maxBytes, zipSize },
) {
  const bad = () => new AcceptError("zip-invalid");
  if (entry.method !== 0 && entry.method !== 8) throw bad();
  if (entry.usize > maxBytes) throw new AcceptError("too-large");
  const handle = await open(zipPath, "r");
  let start;
  try {
    const head = Buffer.alloc(30);
    const { bytesRead } = await handle.read(head, 0, 30, entry.lho);
    if (bytesRead !== 30 || head.readUInt32LE(0) !== 0x04034b50) throw bad();
    start = entry.lho + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  if (start + entry.csize > zipSize) throw bad();
  let crc = 0,
    bytes = 0;
  const check = new Transform({
    transform(chunk, _e, cb) {
      bytes += chunk.length;
      if (bytes > entry.usize || bytes > maxBytes) return cb(new Error("size"));
      crc = zlib.crc32(chunk, crc);
      cb(null, chunk);
    },
  });
  const source =
    entry.csize === 0
      ? null
      : createReadStream(zipPath, { start, end: start + entry.csize - 1 });
  const stages = [
    ...(source ? [source] : []),
    ...(entry.method === 8 ? [zlib.createInflateRaw()] : []),
    check,
    createWriteStream(dest),
  ];
  try {
    if (!source) {
      await pipeline((async function* () {})(), check, createWriteStream(dest));
    } else await pipeline(...stages);
  } catch {
    throw bad();
  }
  if (bytes !== entry.usize || crc >>> 0 !== entry.crc) throw bad();
}

// ---- tar: validate and extract --------------------------------------------------
const NAME_BAD = /[\u0000-\u001f\u007f\\]/;
const hasSeg = (rel, seg) => `/${rel}/`.includes(`/${seg}/`);
const inNodeModules = (rel) => rel.split("/").includes("node_modules");
const FORBIDDEN_DIRS = [
  "apps/hub",
  "apps/desktop",
  "apps/mobile",
  "scripts",
  "workers",
  "clients",
  ".git",
];
const cstr = (buf, off, len) => {
  const end = buf.indexOf(0, off);
  return buf.toString(
    "utf8",
    off,
    end >= 0 && end < off + len ? end : off + len,
  );
};
function numeric(buf, off, len) {
  if (buf[off] & 0x80) {
    let value = buf[off] & 0x7f;
    for (let i = 1; i < len; i++) {
      value = value * 256 + buf[off + i];
      if (!Number.isSafeInteger(value)) return null;
    }
    return value;
  }
  const text = cstr(buf, off, len).trim();
  return /^[0-7]*$/.test(text) ? (text ? parseInt(text, 8) : 0) : null;
}
function parsePax(buf) {
  const out = {};
  let p = 0;
  while (p < buf.length) {
    const space = buf.indexOf(0x20, p);
    if (space < 0) return null;
    const len = Number(buf.toString("ascii", p, space));
    if (!Number.isInteger(len) || len < 4 || p + len > buf.length) return null;
    const record = buf.toString("utf8", space + 1, p + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    p += len;
  }
  return out;
}
const emptyCounts = () => ({
  entries: 0,
  files: 0,
  dirs: 0,
  symlinks: 0,
  hardlinks: 0,
  devices: 0,
  fifosAndOther: 0,
  absolute: 0,
  traversal: 0,
  badNames: 0,
  symlinkEscapes: 0,
  outsideOutput: 0,
  totalBytes: 0,
  limitExceeded: 0,
  malformed: 0,
  // name-based scan rules (REV2 section 2.7)
  maps: 0,
  tsOutsideNodeModules: 0,
  forbiddenPaths: 0,
  envFiles: 0,
  claudeMd: 0,
  // .vc-config.json: a filePathMap can make the CLI upload files that are not
  // part of the output (H1), and an unreadable config is refused outright.
  filePathMap: 0,
  badConfig: 0,
});
const BAD_KEYS = [
  "hardlinks",
  "devices",
  "fifosAndOther",
  "absolute",
  "traversal",
  "badNames",
  "symlinkEscapes",
  "outsideOutput",
  "limitExceeded",
  "malformed",
  "filePathMap",
  "badConfig",
];
const FINDING_KEYS = [
  "maps",
  "tsOutsideNodeModules",
  "forbiddenPaths",
  "envFiles",
  "claudeMd",
];
const sum = (counts, keys) => keys.reduce((n, key) => n + counts[key], 0);
// Classifies one entry and updates the counts.
function judge(v, { name, type, linkname }) {
  v.entries++;
  if (type === "file") v.files++;
  else if (type === "dir") v.dirs++;
  else if (type === "symlink") v.symlinks++;
  else if (type === "hardlink") v.hardlinks++;
  else if (type === "device") v.devices++;
  else v.fifosAndOther++;
  if (NAME_BAD.test(name) || name.length > 1000 || name === "") {
    v.badNames++;
    return;
  }
  if (name.startsWith("/")) v.absolute++;
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) v.traversal++;
  const inside =
    name === OUT || name === `${OUT}/` || name.startsWith(`${OUT}/`);
  if (!inside) {
    v.outsideOutput++;
    return;
  }
  if (type === "symlink") {
    if (!linkname || NAME_BAD.test(linkname)) v.symlinkEscapes++;
    else {
      const resolved = linkname.startsWith("/")
        ? linkname
        : path.posix.normalize(
            path.posix.join(
              path.posix.dirname(name.replace(/\/$/, "")),
              linkname,
            ),
          );
      if (!(resolved === OUT || resolved.startsWith(`${OUT}/`)))
        v.symlinkEscapes++;
    }
  }
  const rel = name.slice(OUT.length + 1).replace(/\/$/, "");
  if (!rel) return;
  const base = rel.split("/").pop();
  if (/\.map(\.gz|\.br)?$/i.test(base)) v.maps++;
  if (/\.(ts|tsx|mts|cts)(\.gz|\.br)?$/.test(base)) {
    if (!inNodeModules(rel)) v.tsOutsideNodeModules++;
  }
  for (const dir of FORBIDDEN_DIRS)
    if (hasSeg(rel, dir) && !inNodeModules(rel)) v.forbiddenPaths++;
  if (/^\.env/i.test(base)) v.envFiles++;
  if (/^claude\.md$/i.test(base)) v.claudeMd++;
}
const TYPES = {
  0: "file",
  "\0": "file",
  5: "dir",
  2: "symlink",
  1: "hardlink",
  3: "device",
  4: "device",
  6: "fifo",
};
// Streams a .tgz and calls `onEntry({name, type, size, linkname})` for every
// entry; it may return a sink {write(buf), end()} to receive the file data.
// Returns the counts. Never buffers an entry's data.
async function walkTgz(file, onEntry, { signal, finalize } = {}) {
  const v = emptyCounts();
  const input = createReadStream(file, { highWaterMark: 65536 });
  const gunzip = zlib.createGunzip();
  input.on("error", (error) => gunzip.destroy(error));
  input.pipe(gunzip);
  let hdr = Buffer.alloc(0);
  let remaining = 0,
    pad = 0,
    sink = null,
    meta = null,
    over = {},
    ended = false;
  let rawBytes = 0;
  const finishData = async () => {
    if (meta) {
      const data = Buffer.concat(meta.chunks);
      if (meta.kind === "L") over.path = cstr(data, 0, data.length);
      else if (meta.kind === "K") over.linkpath = cstr(data, 0, data.length);
      else {
        const pax = parsePax(data);
        if (!pax) v.malformed++;
        else {
          if (pax.path !== undefined) over.path = pax.path;
          if (pax.linkpath !== undefined) over.linkpath = pax.linkpath;
          if (pax.size !== undefined) over.size = Number(pax.size);
        }
      }
      meta = null;
    } else if (sink) {
      await sink.end();
      sink = null;
    }
  };
  try {
    for await (let chunk of gunzip) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      rawBytes += chunk.length;
      if (rawBytes > MAX_TAR_BYTES + 512 * MAX_TAR_ENTRIES) {
        v.limitExceeded++;
        break;
      }
      while (chunk.length && !ended) {
        if (remaining > 0) {
          const n = Math.min(remaining, chunk.length);
          const part = chunk.subarray(0, n);
          if (meta) meta.chunks.push(part);
          else if (sink) await sink.write(part);
          remaining -= n;
          chunk = chunk.subarray(n);
          if (remaining === 0) await finishData();
          continue;
        }
        if (pad > 0) {
          const n = Math.min(pad, chunk.length);
          pad -= n;
          chunk = chunk.subarray(n);
          continue;
        }
        const take = chunk.subarray(0, 512 - hdr.length);
        hdr = Buffer.concat([hdr, take]);
        chunk = chunk.subarray(take.length);
        if (hdr.length < 512) continue;
        const block = hdr;
        hdr = Buffer.alloc(0);
        if (block.every((byte) => byte === 0)) {
          ended = true;
          break;
        }
        let checksum = 0;
        for (let i = 0; i < 512; i++)
          checksum += i >= 148 && i < 156 ? 32 : block[i];
        if (checksum !== numeric(block, 148, 8)) {
          v.malformed++;
          ended = true;
          break;
        }
        const flag = String.fromCharCode(block[156]);
        let size = numeric(block, 124, 12);
        if (size === null) {
          v.malformed++;
          ended = true;
          break;
        }
        if (["x", "L", "K"].includes(flag)) {
          if (size > MAX_META) {
            v.malformed++;
            ended = true;
            break;
          }
          meta = { kind: flag === "x" ? "x" : flag, chunks: [] };
          remaining = size;
          pad = (512 - (size % 512)) % 512;
          if (size === 0) await finishData();
          continue;
        }
        let name = cstr(block, 0, 100);
        if (cstr(block, 257, 6) === "ustar") {
          const prefix = cstr(block, 345, 155);
          if (prefix) name = `${prefix}/${name}`;
        }
        let linkname = cstr(block, 157, 100);
        if (over.path !== undefined) name = over.path;
        if (over.linkpath !== undefined) linkname = over.linkpath;
        if (over.size !== undefined && Number.isSafeInteger(over.size))
          size = over.size;
        over = {};
        const type = TYPES[flag] ?? "other";
        if (type === "file" || type === "other") v.totalBytes += size;
        if (v.totalBytes > MAX_TAR_BYTES || v.entries >= MAX_TAR_ENTRIES) {
          v.limitExceeded++;
          ended = true;
          break;
        }
        const entry = {
          name,
          type,
          size,
          linkname,
          mode: numeric(block, 100, 8) ?? 0,
        };
        judge(v, entry);
        sink = (await onEntry(entry, v)) ?? null;
        if (type === "file") {
          remaining = size;
          pad = (512 - (size % 512)) % 512;
          if (size === 0) {
            await finishData();
            pad = 0;
          }
        } else {
          // Anything else carries no data we use; skip it if it has any.
          remaining = type === "dir" || type === "symlink" ? 0 : size;
          pad = remaining ? (512 - (size % 512)) % 512 : 0;
          sink = null;
          if (remaining === 0) pad = 0;
        }
      }
      if (ended) break;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    v.malformed++;
    await sink?.abort?.();
  } finally {
    input.destroy();
    gunzip.destroy();
  }
  if (!ended && (hdr.length || remaining || meta)) v.malformed++;
  if (v.entries < 1) v.malformed++;
  if (finalize && !v.malformed) await finalize(v);
  v.bad = sum(v, BAD_KEYS);
  v.findings = sum(v, FINDING_KEYS);
  return v;
}
// Validation only: counts, no extraction. `bad` > 0 or `findings` > 0 = reject.
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIGS = 5000;
const inOut = (p) => p === OUT || p.startsWith(`${OUT}/`);
// Follows symlinks (chains, and links in a parent directory) using only the
// archive's own entry set. -> final posix path, or null when it cannot be
// resolved or leaves the output root.
function resolveInArchive(entries, start) {
  let current = start;
  for (let round = 0; round < 40; round++) {
    const parts = current.split("/");
    let changed = false;
    for (let k = 1; k <= parts.length; k++) {
      const prefix = parts.slice(0, k).join("/");
      const e = entries.get(prefix);
      if (e?.type !== "symlink") continue;
      if (!e.linkname || e.linkname.startsWith("/")) return null;
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(prefix), e.linkname),
      );
      current = path.posix.normalize([target, ...parts.slice(k)].join("/"));
      changed = true;
      break;
    }
    if (!changed) return inOut(current) ? current : null;
    if (!inOut(current)) return null;
  }
  return null;
}
// Whole-archive checks that need every entry: symlink chains, writes through a
// link, and the filePathMap of every .vc-config.json (the pinned CLI reads
// files named there from the deploy root; in prebuilt mode it only checks that
// they stay under that root, so anything outside the output is refused here).
// A file reference the CLI would read (filePathMap value, prerender fallback):
// a relative path without .., inside the output, naming a regular file of the
// archive that is reached without passing through any link. `base` is the
// directory the reference is relative to ("" = the deploy root).
function refOk(entries, value, base = "") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1000 ||
    NAME_BAD.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").includes("..")
  )
    return false;
  const target = path.posix.normalize(
    base ? path.posix.join(base, value) : value,
  );
  return (
    inOut(target) &&
    entries.get(target)?.type === "file" &&
    resolveInArchive(entries, target) === target
  );
}
function archiveChecks(v, entries, configs, overflow = 0) {
  // More configs than we inspect: the rest is unchecked, so refuse.
  v.badConfig += overflow;
  for (const [name, e] of entries) {
    if (e.type === "symlink" && !resolveInArchive(entries, name))
      v.symlinkEscapes++;
    const parts = name.split("/");
    for (let k = 1; k < parts.length; k++)
      if (entries.get(parts.slice(0, k).join("/"))?.type === "symlink") {
        v.symlinkEscapes++;
        break;
      }
  }
  for (const config of configs) {
    if (config.tooBig) {
      v.badConfig++;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(config.text);
    } catch {
      v.badConfig++;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      v.badConfig++;
      continue;
    }
    if (config.kind === "prerender") {
      const fb = parsed.fallback;
      if (fb === undefined || fb === null) continue;
      const ref = typeof fb === "string" ? fb : fb?.fsPath;
      if (!refOk(entries, ref, path.posix.dirname(config.name)))
        v.filePathMap++;
      continue;
    }
    const map = parsed.filePathMap;
    if (map === undefined || map === null) continue;
    if (typeof map !== "object" || Array.isArray(map)) {
      v.filePathMap++;
      continue;
    }
    for (const [key, value] of Object.entries(map)) {
      const keyOk =
        key.length > 0 &&
        key.length <= 1000 &&
        !NAME_BAD.test(key) &&
        !key.startsWith("/") &&
        !key.split("/").some((p) => p === ".." || p === "");
      const ok = keyOk && refOk(entries, value, "");
      if (!ok) v.filePathMap++;
    }
  }
}
// Validation only: counts, no extraction. `bad` > 0 or `findings` > 0 = reject.
export function inspectTgz(file, options = {}) {
  const entries = new Map();
  const configs = [];
  let overflow = 0;
  return walkTgz(
    file,
    (entry) => {
      const name = entry.name.endsWith("/")
        ? entry.name.slice(0, -1)
        : entry.name;
      entries.set(name, { type: entry.type, linkname: entry.linkname });
      if (
        entry.type === "file" &&
        inOut(name) &&
        (name.split("/").pop() === ".vc-config.json" ||
          name.endsWith(".prerender-config.json"))
      ) {
        if (configs.length >= (options.maxConfigs ?? MAX_CONFIGS)) {
          overflow++;
          return null;
        }
        const record = {
          name,
          kind: name.endsWith(".prerender-config.json") ? "prerender" : "vc",
          text: "",
          tooBig: entry.size > MAX_CONFIG_BYTES,
        };
        configs.push(record);
        const chunks = [];
        return {
          write: (buf) => {
            if (!record.tooBig) chunks.push(Buffer.from(buf));
          },
          end: () => {
            record.text = Buffer.concat(chunks).toString("utf8");
          },
          abort: () => {},
        };
      }
      return null;
    },
    {
      ...options,
      finalize: (v) => archiveChecks(v, entries, configs, overflow),
    },
  );
}
// The specific code for a rejected archive.
export const tarProblemCode = (v) =>
  v.filePathMap ? "artifact-filepathmap" : "tar-invalid";

// Extracts into `dest` (an existing directory), refusing anything that would
// land outside it or write through a symlink. Validate with inspectTgz first.
export async function extractTgz(file, dest, options = {}) {
  // Whole-archive validation first (chains, links in parents, filePathMap).
  const pre = await inspectTgz(file, options);
  if (pre.bad || pre.findings) throw new AcceptError(tarProblemCode(pre));
  const root = await realpath(dest);
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  const verified = new Set([root]);
  const links = [];
  // Creates every directory component by hand: each existing component is
  // lstat'ed and must be a real directory (never a symlink); nothing is ever
  // created through mkdir -p, so a link cannot redirect a later entry.
  async function ensureDir(target) {
    if (verified.has(target)) return;
    if (!inside(target)) throw new AcceptError("tar-invalid");
    const parts = path.relative(root, target).split(path.sep);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      if (verified.has(current)) continue;
      let info = null;
      try {
        info = await lstat(current);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (info === null) {
        await mkdir(current);
        await chmod(current, 0o755);
      } else if (info.isSymbolicLink() || !info.isDirectory())
        throw new AcceptError("tar-invalid");
      verified.add(current);
    }
  }
  await walkTgz(
    file,
    async (entry) => {
      if (
        entry.type === "hardlink" ||
        entry.type === "device" ||
        entry.type === "fifo" ||
        entry.type === "other"
      )
        return null;
      const target = path.resolve(root, entry.name);
      if (!inside(target) || target === root) return null;
      if (entry.type === "dir") {
        await ensureDir(target);
        return null;
      }
      await ensureDir(path.dirname(target));
      if (entry.type === "symlink") {
        await symlink(entry.linkname, target);
        links.push(target);
        return null;
      }
      const handle = await open(target, "wx", 0o644);
      return {
        write: (buf) => handle.write(buf),
        end: async () => {
          await handle.close();
          await chmod(target, entry.mode & 0o111 ? 0o755 : 0o644).catch(
            () => {},
          );
        },
        abort: () => handle.close().catch(() => {}),
      };
    },
    options,
  );
  // Afterwards every link must really resolve inside the extracted root.
  for (const link of links) {
    let real;
    try {
      real = await realpath(link);
    } catch (error) {
      if (error?.code === "ENOENT") continue; // dangling: nothing to read
      throw error;
    }
    if (!inside(real)) throw new AcceptError("tar-invalid");
  }
  return pre;
}
export async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(file, { highWaterMark: 65536 }),
    new Transform({
      transform(chunk, _e, cb) {
        hash.update(chunk);
        cb();
      },
    }),
  );
  return hash.digest("hex");
}

// ---- acceptance (builder security review) --------------------------------------
const sha256Text = (text) => createHash("sha256").update(text).digest("hex");
// The builder hashes the dispatched build_env with sorted keys.
export const buildEnvHash = (env) =>
  sha256Text(
    JSON.stringify(
      Object.fromEntries(
        Object.keys(env)
          .sort()
          .map((k) => [k, env[k]]),
      ),
    ),
  );
const providerCode = (error) =>
  new AcceptError(
    error instanceof ProviderError
      ? `github-${error.code}`.slice(0, 40)
      : "github-failed",
  );
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
// Checks the run, the artifact and the builder's manifest, downloads and
// re-validates the output. On success the verified plaintext tgz is at `tgzPath`.
//   ctx: {github, c{POS_BUILDER_REF, POS_BUILDER_WORKFLOW}, cliVersion, vaultKey}
//   build: {runId, buildId, sha, env (dispatched build_env), builderSha}
// -> {tgzPath, artifactId, run, builder (descriptor), builderSha, manifest, output, scan, tar}
// The downloaded zip and the builder manifest never outlive the call; a
// rejected build also leaves no tgz behind.
export async function acceptBuild(ctx, args) {
  try {
    return await acceptBuildInner(ctx, args);
  } catch (error) {
    await unlink(path.join(args.dir, "output.tgz")).catch(() => {});
    throw error;
  } finally {
    for (const junk of ["artifact.zip", "builder-manifest.json"])
      await unlink(path.join(args.dir, junk)).catch(() => {});
  }
}
async function acceptBuildInner(
  ctx,
  { runId, buildId, sha, env, dir, signal },
) {
  const { github } = ctx;
  let run;
  try {
    run = await github.run(runId, { signal });
  } catch (error) {
    throw providerCode(error);
  }
  const workflow = ctx.c?.POS_BUILDER_WORKFLOW ?? "build.yml";
  if (run.status !== "completed" || run.conclusion !== "success")
    throw new AcceptError("run-not-success");
  if (
    run.path !== `.github/workflows/${workflow}` ||
    run.headBranch !== (ctx.c?.POS_BUILDER_REF ?? "main") ||
    run.event !== "workflow_dispatch" ||
    run.displayTitle !== `pos-build ${buildId}`
  )
    throw new AcceptError("run-provenance");
  let artifacts;
  try {
    artifacts = await github.listArtifacts(runId, { signal });
  } catch (error) {
    throw providerCode(error);
  }
  const name = `pos-build-${buildId}`;
  if (artifacts.length !== 1 || artifacts[0].name !== name)
    throw new AcceptError("artifact-count");
  const artifact = artifacts[0];
  if (artifact.expired) throw new AcceptError("artifact-expired");
  if (!artifact.digest) throw new AcceptError("artifact-digest");
  const zipPath = path.join(dir, "artifact.zip");
  try {
    await github.downloadArtifact(artifact.id, zipPath, {
      maxBytes: MAX_ARTIFACT_BYTES,
      signal,
    });
  } catch (error) {
    throw error instanceof ProviderError &&
      ["digest-mismatch", "too-large", "redirect-host"].includes(error.code)
      ? new AcceptError(`artifact-${error.code}`.slice(0, 40))
      : providerCode(error);
  }
  const tgzPath = path.join(dir, "output.tgz");
  const manifestPath = path.join(dir, "builder-manifest.json");
  const { entries, size } = await readZipEntries(zipPath);
  const names = entries.map((e) => e.name).sort();
  if (
    names.length !== 2 ||
    names[0] !== "manifest.json" ||
    names[1] !== "output.tgz"
  )
    throw new AcceptError("zip-invalid");
  for (const entry of entries)
    await extractZipEntry(
      zipPath,
      entry,
      entry.name === "output.tgz" ? tgzPath : manifestPath,
      {
        maxBytes:
          entry.name === "output.tgz" ? MAX_ARTIFACT_BYTES : MAX_MANIFEST,
        zipSize: size,
      },
    );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new AcceptError("manifest-invalid");
  }
  const bad = (code) => {
    throw new AcceptError(code);
  };
  if (
    manifest?.format !== "sandbee-build-output/1" ||
    manifest.buildId !== buildId ||
    manifest.sha !== sha ||
    manifest.runId !== String(runId) ||
    manifest.runAttempt !== String(run.runAttempt) ||
    manifest.outputPath !== OUT ||
    manifest.extendedSettingsUsed !== false
  )
    bad(
      manifest?.runAttempt !== String(run.runAttempt)
        ? "run-not-latest"
        : "manifest-mismatch",
    );
  const keys = Object.keys(env).sort();
  if (
    JSON.stringify(manifest.buildEnvKeys) !== JSON.stringify(keys) ||
    manifest.buildEnvSha256 !== buildEnvHash(env)
  )
    bad("manifest-mismatch");
  if (!/^[0-9a-f]{40}$/.test(manifest.builderSha ?? ""))
    bad("manifest-mismatch");
  if (!run.headSha || run.headSha !== manifest.builderSha)
    bad("manifest-mismatch");
  if (
    !manifest.scan ||
    manifest.scan.findings !== 0 ||
    !manifest.scan.after ||
    count(manifest.scan.after.maps) !== 0 ||
    count(manifest.scan.after.envFiles) !== 0
  )
    bad("scan-unclean");
  // The builder that produced this output must be the pinned CLI generation.
  let descriptor;
  try {
    descriptor = parseBuilderJson(
      await github.builderFile(manifest.builderSha),
    );
  } catch {
    throw new AcceptError("builder-unreadable");
  }
  if (
    manifest.cliVersion !== descriptor.cliVersion ||
    descriptor.cliVersion !== ctx.cliVersion ||
    manifest.nodeVersion !== descriptor.nodeVersion ||
    manifest.protocol !== descriptor.protocol
  )
    bad("cli-mismatch");
  // The admin's own checks on the tgz: size, hash, structure, name scan.
  const info = await stat(tgzPath);
  const out = manifest.output;
  if (
    !out ||
    out.bytes !== info.size ||
    !/^[0-9a-f]{64}$/.test(out.sha256 ?? "") ||
    out.sha256 !== (await sha256File(tgzPath))
  )
    bad("manifest-mismatch");
  const v = await inspectTgz(tgzPath, { signal });
  if (v.bad || v.findings) bad(tarProblemCode(v));
  if (
    v.files !== count(out.files) ||
    v.symlinks !== count(out.symlinks) ||
    v.entries !== count(out.files) + count(out.dirs) + count(out.symlinks) + 1
  )
    bad("manifest-mismatch");
  const before = manifest.scan.before ?? {};
  const after = manifest.scan.after;
  const allowlisted = (
    Array.isArray(manifest.scan.allowlistedHits)
      ? manifest.scan.allowlistedHits
      : []
  )
    .filter(
      (h) => typeof h?.package === "string" && typeof h?.rule === "string",
    )
    .slice(0, 20)
    .map((h) => ({
      package: h.package.slice(0, 100),
      rule: h.rule.slice(0, 60),
    }));
  return {
    tgzPath,
    artifactId: artifact.id,
    run,
    builder: descriptor,
    builderSha: manifest.builderSha,
    info: {
      output: {
        bytes: info.size,
        sha256: out.sha256,
        files: v.files,
        dirs: v.dirs,
        symlinks: v.symlinks,
      },
      scan: {
        findings: 0,
        maps: 0,
        tsOutsideNodeModules: 0,
        forbiddenPaths: 0,
        secretHits: 0,
        envFiles: 0,
        symlinkEscapes: 0,
        allowlisted,
        sanitised: {
          maps: Math.max(0, count(before.maps) - count(after.maps)),
          envExamples: Math.max(
            0,
            count(before.envExampleFiles) - count(after.envExampleFiles),
          ),
        },
      },
      tar: { entries: v.entries, bad: 0 },
      run: { id: runId, attempt: run.runAttempt, conclusion: "success" },
    },
  };
}
