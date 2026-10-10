// S3 build cache (rev 2 section 2): the scanned prebuilt output of one commit
// built from one exact set of inputs, stored as an SBB1 ciphertext object plus
// a MAC-protected JSON manifest (the commit point).
//
//   builds/<sha40>/<buildKey>.json                     manifest, If-None-Match: *
//   builds/<sha40>/<buildKey>/<storeId>.tgz.enc        SBB1 | iv(12) | GCM ciphertext | tag(16)
//
// Everything streams in 64 KB chunks. Nothing in an error, a manifest or a log
// carries a key, a data key or build bytes.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { decrypt, encrypt, equal, keyFingerprint } from "./crypto.js";
import { isConflict } from "./s3.js";
import { canonicalJSON, kManifestOf } from "./build-inputs.js";
import { BUILD_KEY_RE, SHA_RE } from "../../shared/deploy.js";

export const MANIFEST_FORMAT = "sandbee-build/1";
const MAGIC = Buffer.from("SBB1");
const IV_BYTES = 12,
  TAG_BYTES = 16,
  HEADER_BYTES = MAGIC.length + IV_BYTES;
export const OBJECT_OVERHEAD = HEADER_BYTES + TAG_BYTES;
const MAX_MANIFEST_BYTES = 65536;
const CHUNK = 65536;
const DISK_CODES = new Set(["ENOSPC", "EIO", "EROFS", "EDQUOT", "EACCES"]);
export const isDiskError = (error) => DISK_CODES.has(error?.code);
export class BuildCacheError extends Error {
  constructor(code) {
    super(`Build cache check failed (${code})`);
    this.name = "BuildCacheError";
    this.code = code;
  }
}
export const manifestKey = (sha, buildKey) => `builds/${sha}/${buildKey}.json`;
export const objectPrefix = (sha, buildKey) => `builds/${sha}/${buildKey}/`;
export const aadOf = (sha, buildKey) => `build:${sha}:${buildKey}`;
const hex = (n) => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`));
const count = z.number().int().min(0).max(1e12);
const iso = z.iso.datetime();
const box = z
  .object({
    version: z.literal(1),
    iv: z.string().max(64),
    tag: z.string().max(64),
    data: z.string().max(512),
  })
  .strict();
export const manifestSchema = z
  .object({
    format: z.literal(MANIFEST_FORMAT),
    sha: hex(40),
    buildKey: hex(64),
    keyFp: z.string().regex(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){3}$/),
    branch: z.string().min(1).max(200),
    commit: z
      .object({
        message: z.string().max(120),
        authorName: z.string().max(100),
        date: iso.nullable(),
      })
      .strict(),
    settings: z.record(
      z.string(),
      z.union([z.string(), z.boolean(), z.null()]),
    ),
    env: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
            set: z.boolean(),
            hmac16: hex(16),
          })
          .strict(),
      )
      .max(30),
    builder: z
      .object({
        sha: hex(40),
        workflow: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
        nodeVersion: z.string().max(20),
        cliVersion: z.string().max(40),
      })
      .strict(),
    run: z
      .object({
        id: z.number().int().min(0),
        attempt: z.number().int().min(0),
        conclusion: z.string().max(30),
      })
      .strict(),
    builtAt: iso,
    storedAt: iso,
    output: z
      .object({
        bytes: count,
        sha256: hex(64),
        files: count,
        dirs: count,
        symlinks: count,
      })
      .strict(),
    object: z
      .object({ key: z.string().max(200), bytes: count, sha256: hex(64) })
      .strict(),
    scan: z
      .object({
        findings: count,
        maps: count,
        tsOutsideNodeModules: count,
        forbiddenPaths: count,
        secretHits: count,
        envFiles: count,
        symlinkEscapes: count,
        allowlisted: z
          .array(
            z
              .object({
                package: z.string().max(100),
                rule: z.string().max(60),
              })
              .strict(),
          )
          .max(20)
          .optional(),
        sanitised: z
          .object({ maps: count, envExamples: count })
          .strict()
          .optional(),
      })
      .strict(),
    tar: z.object({ entries: count, bad: count }).strict(),
    dataKey: box,
    mac: hex(64),
  })
  .strict();
export const macOf = (manifest, vaultKey) => {
  const { mac: _ignored, ...rest } = manifest;
  return createHmac("sha256", kManifestOf(vaultKey))
    .update(canonicalJSON(rest))
    .digest("hex");
};
export const signManifest = (manifest, vaultKey) => ({
  ...manifest,
  mac: macOf(manifest, vaultKey),
});
// Verifies manifest bytes found at builds/<sha>/<buildKey>.json.
//  -> {state:"ok", manifest}
//   | {state:"miss", reason:"foreign-key"}      sealed under another VAULT_KEY: plain miss
//   | {state:"invalid", reason}                 integrity failure: quarantine
export function verifyManifest(buffer, { sha, buildKey, vaultKey }) {
  const invalid = (reason) => ({ state: "invalid", reason });
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_MANIFEST_BYTES)
    return invalid("too-large");
  let raw;
  try {
    raw = JSON.parse(buffer.toString("utf8"));
  } catch {
    return invalid("bad-json");
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return invalid("bad-schema");
  const m = parsed.data;
  if (m.keyFp !== keyFingerprint(vaultKey))
    return { state: "miss", reason: "foreign-key" };
  if (!equal(m.mac, macOf(m, vaultKey))) return invalid("bad-mac");
  if (
    m.format !== MANIFEST_FORMAT ||
    m.sha !== sha ||
    m.buildKey !== buildKey ||
    !new RegExp(
      `^builds/${sha}/${buildKey}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tgz\\.enc$`,
    ).test(m.object.key)
  )
    return invalid("path-mismatch");
  const s = m.scan;
  if (
    s.findings ||
    s.maps ||
    s.tsOutsideNodeModules ||
    s.forbiddenPaths ||
    s.envFiles ||
    s.symlinkEscapes
  )
    return invalid("unclean-scan");
  if (m.tar.bad || m.tar.entries < 1) return invalid("bad-tar");
  if (m.output.bytes < 1 || m.object.bytes !== m.output.bytes + OBJECT_OVERHEAD)
    return invalid("bad-size");
  return { state: "ok", manifest: m };
}
// ---- SBB1 streaming seal / open --------------------------------------------
class Seal extends Transform {
  constructor(cipher, iv, observe) {
    super({ highWaterMark: CHUNK });
    this.cipher = cipher;
    this.observe = observe;
    this.plain = createHash("sha256");
    this.cipherHash = createHash("sha256");
    this.plainBytes = 0;
    this.cipherBytes = 0;
    this.emit_(Buffer.concat([MAGIC, iv]));
  }
  emit_(buffer) {
    this.cipherHash.update(buffer);
    this.cipherBytes += buffer.length;
    this.push(buffer);
  }
  _transform(chunk, _e, cb) {
    this.observe?.(chunk.length);
    this.plain.update(chunk);
    this.plainBytes += chunk.length;
    const out = this.cipher.update(chunk);
    if (out.length) this.emit_(out);
    cb();
  }
  _flush(cb) {
    const last = this.cipher.final();
    if (last.length) this.emit_(last);
    this.emit_(this.cipher.getAuthTag());
    cb();
  }
}
// Encrypts srcPath (plaintext tgz) to destPath. The per-object data key is
// random and returned only sealed under VAULT_KEY (AAD build:<sha>:<buildKey>).
export async function sealToFile({
  srcPath,
  destPath,
  sha,
  buildKey,
  vaultKey,
  observe,
}) {
  const aad = aadOf(sha, buildKey);
  const dataKey = randomBytes(32),
    iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(aad));
  const seal = new Seal(cipher, iv, observe);
  try {
    await pipeline(
      createReadStream(srcPath, { highWaterMark: CHUNK }),
      seal,
      createWriteStream(destPath),
    );
  } catch (error) {
    await unlink(destPath).catch(() => {});
    throw new BuildCacheError(
      isDiskError(error) ? "work-disk-error" : "seal-failed",
    );
  }
  return {
    dataKey: encrypt(dataKey.toString("hex"), vaultKey, aad),
    output: { bytes: seal.plainBytes, sha256: seal.plain.digest("hex") },
    object: { bytes: seal.cipherBytes, sha256: seal.cipherHash.digest("hex") },
  };
}
async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : null;
}
// Verifies size, ciphertext hash, magic, data-key unwrap, the GCM tag (at the
// end of the stream) and the plaintext hash; decrypts to destPath.part and
// renames only after every check passed. Throws BuildCacheError(code).
export async function openToFile({
  srcPath,
  destPath,
  manifest,
  vaultKey,
  observe,
}) {
  const aad = aadOf(manifest.sha, manifest.buildKey);
  const part = `${destPath}.part`;
  let info;
  try {
    info = await stat(srcPath);
  } catch {
    throw new BuildCacheError("object-missing");
  }
  if (info.size !== manifest.object.bytes || info.size < OBJECT_OVERHEAD)
    throw new BuildCacheError("bad-size");
  // Pass 1: the ciphertext hash, before a single byte is decrypted.
  const whole = createHash("sha256");
  await pipeline(
    createReadStream(srcPath, { highWaterMark: CHUNK }),
    new Transform({
      transform(chunk, _e, cb) {
        whole.update(chunk);
        cb();
      },
    }),
  ).catch((error) => {
    throw new BuildCacheError(
      isDiskError(error) ? "work-disk-error" : "object-missing",
    );
  });
  if (whole.digest("hex") !== manifest.object.sha256)
    throw new BuildCacheError("bad-object-hash");
  const handle = await open(srcPath, "r");
  let head, tag;
  try {
    head = await readAt(handle, 0, HEADER_BYTES);
    tag = await readAt(handle, info.size - TAG_BYTES, TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!head || !tag || !head.subarray(0, MAGIC.length).equals(MAGIC))
    throw new BuildCacheError("bad-magic");
  let dataKey;
  try {
    dataKey = Buffer.from(decrypt(manifest.dataKey, vaultKey, aad), "hex");
    if (dataKey.length !== 32) throw new Error("length");
  } catch {
    throw new BuildCacheError("bad-key");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    dataKey,
    head.subarray(MAGIC.length),
    { authTagLength: TAG_BYTES },
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  const plain = createHash("sha256");
  let bytes = 0,
    overflow = false;
  const bodyLength = info.size - OBJECT_OVERHEAD;
  const body =
    bodyLength > 0
      ? createReadStream(srcPath, {
          start: HEADER_BYTES,
          end: info.size - TAG_BYTES - 1,
          highWaterMark: CHUNK,
        })
      : Readable.from([]);
  try {
    await pipeline(
      body,
      decipher,
      new Transform({
        transform(chunk, _e, cb) {
          observe?.(chunk.length);
          bytes += chunk.length;
          if (bytes > manifest.output.bytes) {
            overflow = true;
            return cb(new Error("overflow"));
          }
          plain.update(chunk);
          cb(null, chunk);
        },
      }),
      createWriteStream(part),
    );
  } catch (error) {
    await unlink(part).catch(() => {});
    throw new BuildCacheError(
      isDiskError(error)
        ? "work-disk-error"
        : overflow
          ? "bad-output"
          : "bad-tag",
    );
  }
  if (
    bytes !== manifest.output.bytes ||
    plain.digest("hex") !== manifest.output.sha256
  ) {
    await unlink(part).catch(() => {});
    throw new BuildCacheError("bad-output");
  }
  await rename(part, destPath);
  return { bytes };
}
// ---- the cache ---------------------------------------------------------------
const checkIds = (sha, buildKey) => {
  if (!SHA_RE.test(sha ?? "") || !BUILD_KEY_RE.test(buildKey ?? ""))
    throw new BuildCacheError("bad-input");
};
export function createBuildCache({
  s3,
  vaultKey,
  now = () => new Date(),
  uuid = randomUUID,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryMs = [1000, 3000],
}) {
  if (!s3) throw new Error("Build cache needs object storage.");
  // -> {state:"hit", manifest} | {state:"miss", reason} | {state:"invalid", reason}
  async function lookup({ sha, buildKey }) {
    checkIds(sha, buildKey);
    const key = manifestKey(sha, buildKey);
    // A missing key without matching ListBucket answers 403, so existence is
    // checked with a listing; the manifest sorts before its object folder.
    const { keys } = await s3.list(`builds/${sha}/${buildKey}`, 3);
    if (!keys.includes(key)) return { state: "miss", reason: "absent" };
    let raw;
    try {
      raw = await s3.getBytes(key, MAX_MANIFEST_BYTES + 1);
    } catch (error) {
      if (error?.status === 410) return { state: "miss", reason: "absent" };
      if (error?.s3Code === "TooLarge")
        return { state: "invalid", reason: "too-large" };
      throw error;
    }
    const checked = verifyManifest(raw, { sha, buildKey, vaultKey });
    return checked.state === "ok"
      ? { state: "hit", manifest: checked.manifest }
      : checked;
  }
  // Downloads and verifies the object into destPath.
  async function fetchBuild({ sha, buildKey, destPath }) {
    const found = await lookup({ sha, buildKey });
    if (found.state !== "hit") return found;
    const { manifest } = found;
    const encPath = `${destPath}.enc`;
    try {
      // Transient S3 errors are retried; a failure of our own disk is not an
      // integrity problem (no quarantine); an exhausted retry is "unavailable".
      for (let attempt = 0; ; attempt++) {
        try {
          await s3.getToFile(manifest.object.key, encPath, {
            maxBytes: manifest.object.bytes,
          });
          break;
        } catch (error) {
          if (error?.status === 410)
            return { state: "invalid", reason: "object-missing" };
          if (error?.s3Code === "TooLarge")
            return { state: "invalid", reason: "bad-size" };
          if (error?.s3Code === "WorkDisk")
            return { state: "error", reason: "work-disk-error" };
          if (attempt >= retryMs.length)
            return { state: "error", reason: "unavailable" };
          await sleep(retryMs[attempt]);
        }
      }
      try {
        await openToFile({ srcPath: encPath, destPath, manifest, vaultKey });
      } catch (error) {
        if (error instanceof BuildCacheError)
          return error.code === "work-disk-error"
            ? { state: "error", reason: "work-disk-error" }
            : { state: "invalid", reason: error.code };
        throw error;
      }
      return { state: "hit", manifest, path: destPath };
    } finally {
      await unlink(encPath).catch(() => {});
    }
  }
  // Delete marker on the manifest only (the object is left for the lifecycle).
  async function quarantine({ sha, buildKey }) {
    checkIds(sha, buildKey);
    await s3.del(manifestKey(sha, buildKey));
    return true;
  }
  // Seals srcPath (a plaintext tgz) and publishes it: object first, then the
  // manifest with If-None-Match (the commit point). -> {state:"stored"|"adopted", manifest}
  async function store({ sha, buildKey, srcPath, workDir, info }) {
    checkIds(sha, buildKey);
    const storeId = uuid();
    const encPath = `${workDir}/${storeId}.enc`;
    const objectKey = `${objectPrefix(sha, buildKey)}${storeId}.tgz.enc`;
    const sealed = await sealToFile({
      srcPath,
      destPath: encPath,
      sha,
      buildKey,
      vaultKey,
    });
    try {
      if (
        (info.output?.bytes !== undefined &&
          info.output.bytes !== sealed.output.bytes) ||
        (info.output?.sha256 !== undefined &&
          info.output.sha256 !== sealed.output.sha256)
      )
        throw new BuildCacheError("output-mismatch");
      let signed;
      try {
        signed = signManifest(
          {
            format: MANIFEST_FORMAT,
            sha,
            buildKey,
            keyFp: keyFingerprint(vaultKey),
            branch: info.branch,
            commit: info.commit,
            settings: info.settings,
            env: info.env,
            builder: info.builder,
            run: info.run,
            builtAt: info.builtAt,
            storedAt: now().toISOString(),
            output: { ...info.output, ...sealed.output },
            object: { key: objectKey, ...sealed.object },
            scan: info.scan,
            tar: info.tar,
            dataKey: sealed.dataKey,
          },
          vaultKey,
        );
      } catch {
        throw new BuildCacheError("bad-info");
      }
      const candidate = manifestSchema.safeParse(signed);
      if (!candidate.success) throw new BuildCacheError("bad-info");
      const manifest = candidate.data;
      const checked = verifyManifest(Buffer.from(JSON.stringify(manifest)), {
        sha,
        buildKey,
        vaultKey,
      });
      if (checked.state !== "ok") throw new BuildCacheError(checked.reason);
      await s3.putFile(objectKey, encPath, {
        ifNoneMatch: true,
        sha256: sealed.object.sha256,
        contentType: "application/octet-stream",
      });
      const body = Buffer.from(JSON.stringify(manifest));
      const dropOrphan = () => s3.del(objectKey).catch(() => {});
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await s3.putBytes(manifestKey(sha, buildKey), body, {
            ifNoneMatch: true,
            contentType: "application/json",
          });
          return { state: "stored", manifest };
        } catch (error) {
          if (!isConflict(error)) {
            await dropOrphan();
            throw error;
          }
        }
        // Another writer won. Verify its manifest and adopt it; one that
        // cannot be trusted (or is sealed under another key) is quarantined
        // and the write is retried once.
        let existing;
        try {
          existing = await lookup({ sha, buildKey });
        } catch (error) {
          await dropOrphan();
          throw error;
        }
        if (existing.state === "hit") {
          await dropOrphan();
          return { state: "adopted", manifest: existing.manifest };
        }
        // Only a manifest that is present but untrustworthy is quarantined;
        // one that vanished meanwhile is simply written again.
        if (attempt === 0 && existing.reason !== "absent")
          await quarantine({ sha, buildKey });
      }
      await dropOrphan();
      throw new BuildCacheError("contested");
    } finally {
      await unlink(encPath).catch(() => {});
    }
  }
  return { lookup, fetch: fetchBuild, store, quarantine };
}
