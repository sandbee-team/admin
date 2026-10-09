import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { isConflict, validKey } from "../backend/lib/s3.js";
import { keyFingerprint } from "../backend/lib/crypto.js";
import {
  BUILD_SETTINGS,
  buildInputs,
  buildKeyOf,
  canonicalJSON,
  envFingerprints,
  kBuildOf,
  nextPublicOf,
  parseBuilderJson,
} from "../backend/lib/build-inputs.js";
import {
  BuildCacheError,
  OBJECT_OVERHEAD,
  createBuildCache,
  manifestKey,
  objectPrefix,
  openToFile,
  sealToFile,
  signManifest,
  verifyManifest,
} from "../backend/lib/build-cache.js";
import { newPos } from "../backend/modules/pos.js";
import { assertNoSecrets, VAULT_KEY } from "./helpers.js";
import { createFakeS3, FAKE } from "./fake-s3.js";

const OTHER_KEY = "d".repeat(64);
const BUILDER_SHA = "c".repeat(40);
const SHA1 = "1".repeat(40),
  SHA2 = "2".repeat(40);
const MARKER = "SECRET-BUILD-MARKER-9f8e7d6c5b4a";
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const BUILDER = { protocol: 1, nodeVersion: "22.11.0", cliVersion: "39.1.0" };
const R2 = "https://pub-1234.example.r2.dev";
const WORKER = "https://rt.example.workers.dev";
const posOf = (image, cloudflare = null) => ({ image, cloudflare });
const POS = posOf({ store: "r2", publicBaseUrl: R2 }, { workerUrl: WORKER });
const inputsOf = (pos = POS, builderSha = BUILDER_SHA, builder = BUILDER) =>
  buildInputs({ pos, builderSha, builder });
const leaks = (error, secrets) =>
  assertNoSecrets(
    {
      message: error.message,
      stack: String(error.stack),
      code: error.code,
      s3Code: error.s3Code,
    },
    secrets,
    "error",
  );
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
// Writes `bytes` of random data in 1 MB pieces (never held whole in memory).
async function randomFile(path, bytes, marker = MARKER) {
  const out = createWriteStream(path);
  out.write(marker);
  let written = marker.length;
  while (written < bytes) {
    const piece = randomBytes(Math.min(1 << 20, bytes - written));
    written += piece.length;
    if (!out.write(piece)) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
}
const fileHash = async (path) => sha256(await readFile(path));

describe("build inputs and buildKey", () => {
  it("derives the three NEXT_PUBLIC_* keys exactly like pos.js nextPublic", () => {
    const configOf = (image) => ({
      slug: "demo",
      subdomain: "demo",
      host: "demo.example.com",
      tenantId: "demo",
      rootDomain: "example.com",
      deployLock: true,
      vercel: {},
      cloudflare: null,
      image,
      posAdmin: { username: "admin" },
    });
    for (const image of [
      { store: "r2", publicBaseUrl: R2, cloudName: "ignored" },
      { store: "cloudinary", publicBaseUrl: "", cloudName: "my-cloud" },
      { store: null, publicBaseUrl: "", cloudName: "" },
    ]) {
      const stored = newPos(configOf(image)).build.nextPublic;
      const derived = nextPublicOf({ image });
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(derived)
            .filter(([, v]) => v !== "")
            .filter(([k]) => k !== "NEXT_PUBLIC_REALTIME_URL"),
        ),
        Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== "")),
      );
      assert.equal(
        Object.keys(derived).length,
        3,
        "all three keys, '' when unset",
      );
    }
  });
  it("build env values are canonical: URLs in new URL().href form, lowercase cloud name", () => {
    const env = inputsOf(
      posOf(
        { store: "r2", publicBaseUrl: R2 },
        { workerUrl: "https://RT.Example.workers.dev" },
      ),
    ).env;
    for (const value of Object.values(env).filter(Boolean))
      assert.equal(new URL(value).href, value);
    assert.equal(env.NEXT_PUBLIC_R2_PUBLIC_BASE_URL, `${R2}/`);
    assert.equal(
      env.NEXT_PUBLIC_REALTIME_URL,
      "wss://rt.example.workers.dev/join",
    );
    const cloud = inputsOf(
      posOf({ store: "cloudinary", cloudName: "My-Cloud_1" }),
    ).env;
    assert.equal(cloud.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, "my-cloud_1");
    // Equivalent spellings share one buildKey.
    assert.equal(
      buildKeyOf(
        VAULT_KEY,
        inputsOf(posOf({ store: "r2", publicBaseUrl: R2 })),
      ),
      buildKeyOf(
        VAULT_KEY,
        inputsOf(posOf({ store: "r2", publicBaseUrl: `${R2}/` })),
      ),
    );
  });
  it("derives the realtime URL from the worker host", () => {
    assert.equal(
      nextPublicOf(POS).NEXT_PUBLIC_REALTIME_URL,
      "wss://rt.example.workers.dev/join",
    );
    assert.equal(
      nextPublicOf(posOf({ store: null }, { workerUrl: `${WORKER}/` }))
        .NEXT_PUBLIC_REALTIME_URL,
      "wss://rt.example.workers.dev/join",
    );
    for (const cf of [
      null,
      {},
      { workerUrl: "" },
      { workerUrl: "http://x.test" },
      { workerUrl: "nonsense" },
    ])
      assert.equal(
        nextPublicOf(posOf({ store: null }, cf)).NEXT_PUBLIC_REALTIME_URL,
        "",
      );
  });
  it("is stable for equal inputs, whatever the key order", () => {
    const a = buildKeyOf(VAULT_KEY, inputsOf());
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, buildKeyOf(VAULT_KEY, inputsOf()));
    const shuffled = {
      builder: inputsOf().builder,
      env: Object.fromEntries(Object.entries(inputsOf().env).reverse()),
      settings: inputsOf().settings,
      v: 1,
    };
    assert.equal(buildKeyOf(VAULT_KEY, shuffled), a);
  });
  it("is keyed by VAULT_KEY: another vault key gives another buildKey", () => {
    assert.notEqual(
      buildKeyOf(VAULT_KEY, inputsOf()),
      buildKeyOf(OTHER_KEY, inputsOf()),
    );
    const expected = createHmac(
      "sha256",
      createHmac("sha256", Buffer.from(VAULT_KEY, "hex"))
        .update("sandbee-build-key-v1")
        .digest(),
    )
      .update(canonicalJSON(inputsOf()))
      .digest("hex");
    assert.equal(buildKeyOf(VAULT_KEY, inputsOf()), expected);
    assert.equal(kBuildOf(VAULT_KEY).length, 32);
    assert.throws(() => buildKeyOf("short", inputsOf()), /vault key/i);
  });
  it("any changed input changes the key", () => {
    const base = buildKeyOf(VAULT_KEY, inputsOf());
    const variants = [
      inputsOf(
        posOf({ store: "r2", publicBaseUrl: `${R2}x` }, { workerUrl: WORKER }),
      ),
      inputsOf(
        posOf({ store: "cloudinary", cloudName: "c1" }, { workerUrl: WORKER }),
      ),
      inputsOf(
        posOf(
          { store: "r2", publicBaseUrl: R2 },
          { workerUrl: "https://other.example.workers.dev" },
        ),
      ),
      inputsOf(posOf({ store: "r2", publicBaseUrl: R2 }, null)),
      inputsOf(POS, "d".repeat(40)),
      inputsOf(POS, BUILDER_SHA, { ...BUILDER, nodeVersion: "22.12.0" }),
      inputsOf(POS, BUILDER_SHA, { ...BUILDER, cliVersion: "39.1.1" }),
    ];
    const keys = new Set([
      base,
      ...variants.map((i) => buildKeyOf(VAULT_KEY, i)),
    ]);
    assert.equal(keys.size, variants.length + 1);
    for (const field of ["v", "settings", "env", "builder"]) {
      const edited = {
        ...inputsOf(),
        [field]: field === "v" ? 2 : { ...inputsOf()[field], extra: "1" },
      };
      assert.notEqual(buildKeyOf(VAULT_KEY, edited), base, field);
    }
    const settings = { ...BUILD_SETTINGS, nodeVersion: "20.x" };
    assert.notEqual(buildKeyOf(VAULT_KEY, { ...inputsOf(), settings }), base);
  });
  it("never contains values: the key, the manifest env form and errors", () => {
    const inputs = inputsOf();
    const key = buildKeyOf(VAULT_KEY, inputs);
    for (const value of Object.values(inputs.env).filter(Boolean))
      assert.equal(key.includes(value), false);
    const view = envFingerprints(VAULT_KEY, inputs.env);
    assert.deepEqual(
      view.map((e) => e.name),
      [
        "NEXT_PUBLIC_R2_PUBLIC_BASE_URL",
        "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME",
        "NEXT_PUBLIC_REALTIME_URL",
      ],
    );
    assert.deepEqual(
      view.map((e) => e.set),
      [true, false, true],
    );
    for (const entry of view) assert.match(entry.hmac16, /^[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(view).includes("example"), false);
    assert.notDeepEqual(
      envFingerprints(VAULT_KEY, inputs.env),
      envFingerprints(OTHER_KEY, inputs.env),
    );
    const secretish = "https://user:pa55w0rd@evil.example/\u0000";
    const error = (() => {
      try {
        inputsOf(posOf({ store: "r2", publicBaseUrl: secretish }));
      } catch (e) {
        return e;
      }
    })();
    assert.match(error.message, /NEXT_PUBLIC_R2_PUBLIC_BASE_URL/);
    assert.equal(error.message.includes("pa55w0rd"), false);
  });
  it("validates the builder descriptor and commit", () => {
    assert.deepEqual(parseBuilderJson(BUILDER), BUILDER);
    for (const bad of [
      null,
      {},
      { ...BUILDER, protocol: 0 },
      { ...BUILDER, nodeVersion: "22" },
      { ...BUILDER, cliVersion: "x" },
      "str",
    ])
      assert.throws(() => parseBuilderJson(bad));
    assert.throws(() => inputsOf(POS, "nothex"));
  });
  it("canonicalJSON is deterministic and strict", () => {
    assert.equal(
      canonicalJSON({ b: [1, { d: null, c: true }], a: "x" }),
      '{"a":"x","b":[1,{"c":true,"d":null}]}',
    );
    for (const bad of [
      { a: undefined },
      { a: 1.5 },
      { a: NaN },
      new Date(),
      () => 1,
      { a: 10n },
    ])
      assert.throws(() => canonicalJSON(bad));
  });
});

describe("s3 streaming helpers", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "s2-s3-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));
  it("putFile streams with Content-Length and a signed payload hash; getToFile streams back", async () => {
    const fake = createFakeS3();
    const s3 = fake.client();
    const src = join(dir, "big.bin");
    await randomFile(src, 6 * 1024 * 1024 + 123);
    const hash = await fileHash(src);
    const { versionId } = await s3.putFile("builds/x/big.bin", src, {
      ifNoneMatch: true,
      sha256: hash,
      contentType: "application/octet-stream",
    });
    assert.ok(versionId);
    const sent = fake.lastRequest.options.headers;
    assert.equal(sent["x-amz-content-sha256"], hash);
    assert.equal(sent["content-length"], String(6 * 1024 * 1024 + 123));
    assert.equal(sent["if-none-match"], "*");
    assert.match(
      sent.authorization,
      /SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-server-side-encryption,/,
    );
    assert.ok(
      fake.stats.maxWriteChunk <= 65536,
      "body is written in 64 KB pieces",
    );
    const dest = join(dir, "big.out");
    const got = await s3.getToFile("builds/x/big.bin", dest, {
      maxBytes: 7 * 1024 * 1024,
    });
    assert.equal(got.sha256, hash);
    assert.equal(await fileHash(dest), hash);
    assert.equal(
      (await readdir(dir)).some((n) => n.endsWith(".part")),
      false,
    );
  });
  it("computes the payload hash itself when none is given, and a wrong hash is refused", async () => {
    const fake = createFakeS3();
    const s3 = fake.client();
    const src = join(dir, "small.bin");
    await writeFile(src, "hello build cache");
    await s3.putFile("builds/x/small.bin", src);
    assert.equal(
      fake.lastRequest.options.headers["x-amz-content-sha256"],
      sha256("hello build cache"),
    );
    const error = await rejects(
      s3.putFile("builds/x/small2.bin", src, { sha256: "0".repeat(64) }),
    );
    assert.equal(error.status, 503);
    assert.equal(fake.liveKeys().includes("builds/x/small2.bin"), false);
    await rejects(
      s3.putFile("builds/x/s.bin", src, { sha256: "nothex" }),
      (e) => assert.equal(e.s3Code, "BadHash"),
    );
    await rejects(s3.putFile("builds/x/s.bin", join(dir, "missing")), (e) =>
      assert.equal(e.s3Code, "LocalFile"),
    );
  });
  it("If-None-Match gives a conflict the caller can recognise", async () => {
    const fake = createFakeS3();
    const s3 = fake.client();
    const src = join(dir, "once.bin");
    await writeFile(src, "one");
    await s3.putFile("builds/x/once", src, { ifNoneMatch: true });
    const error = await rejects(
      s3.putFile("builds/x/once", src, { ifNoneMatch: true }),
    );
    assert.equal(isConflict(error), true);
    const e2 = await rejects(
      s3.putBytes("builds/x/once", Buffer.from("two"), { ifNoneMatch: true }),
    );
    assert.equal(isConflict(e2), true);
    await s3.putBytes("builds/x/once", Buffer.from("two"));
    assert.equal(fake.versions("builds/x/once").length, 2);
  });
  it("getToFile refuses oversize bodies, maps missing keys and leaves no partial file", async () => {
    const fake = createFakeS3();
    const s3 = fake.client();
    await s3.putBytes("builds/x/obj", Buffer.alloc(5000, 1));
    const dest = join(dir, "limited");
    await rejects(s3.getToFile("builds/x/obj", dest, { maxBytes: 1000 }), (e) =>
      assert.equal(e.s3Code, "TooLarge"),
    );
    await rejects(
      s3.getToFile("builds/x/none", dest, { maxBytes: 1000 }),
      (e) => assert.equal(e.status, 410),
    );
    fake.fail("get", { status: 500, code: "InternalError" });
    await rejects(s3.getToFile("builds/x/obj", dest, { maxBytes: 9999 }), (e) =>
      assert.equal(e.status, 503),
    );
    for (const name of await readdir(dir))
      assert.equal(name.startsWith("limited"), false, name);
    await rejects(s3.getToFile("builds/x/obj", dest, {}), (e) =>
      assert.equal(e.s3Code, "BadKey"),
    );
  });
  it("only files/ and builds/ keys are accepted by the new helpers", async () => {
    const fake = createFakeS3();
    const s3 = fake.client();
    for (const key of [
      "other/x",
      "builds",
      "builds/",
      "files/../x",
      "builds//x",
      "builds/./x",
      "/builds/x",
      "builds/x y",
      "builds/x/",
      "builds/\u0000",
    ])
      assert.equal(validKey(key), false, key);
    assert.equal(validKey("builds/abc/def.json"), true);
    assert.equal(validKey("files/cid/fid"), true);
    const src = join(dir, "k.bin");
    await writeFile(src, "x");
    for (const call of [
      () => s3.putFile("other/x", src),
      () => s3.getToFile("other/x", join(dir, "o"), { maxBytes: 1 }),
      () => s3.putBytes("other/x", Buffer.from("x")),
      () => s3.getBytes("other/x"),
      () => s3.copySelf("other/x"),
    ])
      await rejects(call(), (e) => assert.equal(e.s3Code, "BadKey"));
    assert.equal(fake.calls.length, 0);
  });
  it("copySelf rewrites onto itself with REPLACE, keeps the content and re-sends content type + SSE", async () => {
    const fake = createFakeS3();
    const s3 = fake.client();
    await s3.putBytes("builds/x/m.json", Buffer.from('{"a":1}'), {
      contentType: "application/json",
    });
    const before = fake.versions("builds/x/m.json").length;
    const { versionId } = await s3.copySelf("builds/x/m.json");
    assert.ok(versionId);
    assert.equal(fake.versions("builds/x/m.json").length, before + 1);
    assert.equal(fake.contentType("builds/x/m.json"), "application/json");
    assert.equal((await s3.getBytes("builds/x/m.json")).toString(), '{"a":1}');
    await s3.putBytes("builds/x/o.bin", Buffer.from("zz"));
    await s3.copySelf("builds/x/o.bin");
    assert.equal(
      fake.contentType("builds/x/o.bin"),
      "application/octet-stream",
    );
    await rejects(s3.copySelf("builds/x/missing.bin"), (e) =>
      assert.equal(e.status, 410),
    );
    fake.okWith("copy", "<Error><Code>InternalError</Code></Error>");
    await rejects(s3.copySelf("builds/x/o.bin"), (e) =>
      assert.equal(e.status, 503),
    );
    await s3.del("builds/x/o.bin");
    await rejects(
      s3.getBytes("builds/x/o.bin"),
      (e) => assert.equal(e.status, 410),
      "a delete marker reads as missing",
    );
  });
  it("list returns key, size and lastModified (and keeps the keys list)", async () => {
    const fake = createFakeS3();
    const s3 = fake.client();
    await s3.putBytes("builds/a/2.json", Buffer.alloc(7));
    await s3.putBytes("builds/a/1.json", Buffer.alloc(3));
    await s3.putBytes("files/z", Buffer.alloc(1));
    const out = await s3.list("builds/a/", 10);
    assert.deepEqual(out.keys, ["builds/a/1.json", "builds/a/2.json"]);
    assert.deepEqual(
      out.objects.map((o) => [o.key, o.size]),
      [
        ["builds/a/1.json", 3],
        ["builds/a/2.json", 7],
      ],
    );
    assert.match(out.objects[0].lastModified, /^\d{4}-\d\d-\d\dT/);
    assert.equal(out.truncated, false);
  });
  it("errors carry no credentials", async () => {
    const fake = createFakeS3();
    const s3 = fake.client();
    const src = join(dir, "e.bin");
    await writeFile(src, "x");
    fake.fail("put", { status: 500, code: "InternalError", times: -1 });
    const error = await rejects(s3.putFile("builds/x/e", src));
    leaks(error, [FAKE.secretAccessKey, FAKE.accessKeyId]);
  });
});

describe("SBB1 seal and open", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "s2-sbb-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));
  const BK = "e".repeat(64);
  const manifestFor = (sealed, extra = {}) => ({
    sha: SHA1,
    buildKey: BK,
    dataKey: sealed.dataKey,
    output: sealed.output,
    object: sealed.object,
    ...extra,
  });
  it("round-trips a multi-MB file in 64 KB chunks and the object is real ciphertext", async () => {
    const src = join(dir, "plain.tgz");
    await randomFile(src, 24 * 1024 * 1024 + 17);
    const chunks = { seal: 0, open: 0 };
    const enc = join(dir, "plain.enc");
    const sealed = await sealToFile({
      srcPath: src,
      destPath: enc,
      sha: SHA1,
      buildKey: BK,
      vaultKey: VAULT_KEY,
      observe: (n) => (chunks.seal = Math.max(chunks.seal, n)),
    });
    assert.ok(chunks.seal <= 65536 && chunks.seal > 0);
    assert.equal(sealed.output.bytes, 24 * 1024 * 1024 + 17);
    assert.equal(sealed.object.bytes, sealed.output.bytes + OBJECT_OVERHEAD);
    assert.equal(sealed.output.sha256, await fileHash(src));
    assert.equal(sealed.object.sha256, await fileHash(enc));
    assert.equal((await stat(enc)).size, sealed.object.bytes);
    const head = (await readFile(enc)).subarray(0, 4).toString();
    assert.equal(head, "SBB1");
    const dest = join(dir, "plain.out");
    await openToFile({
      srcPath: enc,
      destPath: dest,
      manifest: manifestFor(sealed),
      vaultKey: VAULT_KEY,
      observe: (n) => (chunks.open = Math.max(chunks.open, n)),
    });
    assert.ok(chunks.open <= 65536 && chunks.open > 0);
    assert.equal(await fileHash(dest), sealed.output.sha256);
    assert.equal(
      (await readdir(dir)).filter((n) => n.startsWith("plain.out")).join(),
      "plain.out",
      "no .part left",
    );
    // a second seal of the same input uses a fresh data key and iv
    const again = await sealToFile({
      srcPath: src,
      destPath: join(dir, "plain2.enc"),
      sha: SHA1,
      buildKey: BK,
      vaultKey: VAULT_KEY,
    });
    assert.notEqual(again.object.sha256, sealed.object.sha256);
    assert.notDeepEqual(again.dataKey, sealed.dataKey);
    assert.equal(JSON.stringify(sealed.dataKey).includes(VAULT_KEY), false);
  });
  it("round-trips an empty-ish and a one-byte file", async () => {
    for (const [name, bytes] of [
      ["one", Buffer.from("x")],
      ["empty", Buffer.alloc(0)],
    ]) {
      const src = join(dir, `${name}.in`);
      await writeFile(src, bytes);
      const sealed = await sealToFile({
        srcPath: src,
        destPath: join(dir, `${name}.enc`),
        sha: SHA1,
        buildKey: BK,
        vaultKey: VAULT_KEY,
      });
      const dest = join(dir, `${name}.out`);
      await openToFile({
        srcPath: join(dir, `${name}.enc`),
        destPath: dest,
        manifest: manifestFor(sealed),
        vaultKey: VAULT_KEY,
      });
      assert.deepEqual(await readFile(dest), bytes);
    }
  });
  async function sealSmall(name, size = 300000) {
    const src = join(dir, `${name}.in`);
    await randomFile(src, size);
    const enc = join(dir, `${name}.enc`);
    const sealed = await sealToFile({
      srcPath: src,
      destPath: enc,
      sha: SHA1,
      buildKey: BK,
      vaultKey: VAULT_KEY,
    });
    return { src, enc, sealed, dest: join(dir, `${name}.out`) };
  }
  const code = (promise) =>
    rejects(promise).then(
      (e) => (assert.ok(e instanceof BuildCacheError), e.code),
    );
  it("a flipped ciphertext bit is caught by the hash, and by the GCM tag when the hash is forged", async () => {
    const { enc, sealed, dest } = await sealSmall("flip");
    const bytes = await readFile(enc);
    bytes[1000] ^= 1;
    await writeFile(enc, bytes);
    assert.equal(
      await code(
        openToFile({
          srcPath: enc,
          destPath: dest,
          manifest: manifestFor(sealed),
          vaultKey: VAULT_KEY,
        }),
      ),
      "bad-object-hash",
    );
    // An attacker who also fixes the manifest hash still fails the tag.
    const forged = manifestFor({
      ...sealed,
      object: { ...sealed.object, sha256: sha256(bytes) },
    });
    assert.equal(
      await code(
        openToFile({
          srcPath: enc,
          destPath: dest,
          manifest: forged,
          vaultKey: VAULT_KEY,
        }),
      ),
      "bad-tag",
    );
    const entries = await readdir(dir);
    assert.equal(
      entries.some((n) => n.startsWith("flip.out")),
      false,
      "no plaintext (not even .part) left",
    );
  });
  it("a flipped tag, header or truncated/padded object is refused", async () => {
    const { enc, sealed, dest } = await sealSmall("shape");
    const good = await readFile(enc);
    const attempt = async (bytes, patch = {}) => {
      await writeFile(enc, bytes);
      const object = { bytes: bytes.length, sha256: sha256(bytes) };
      return code(
        openToFile({
          srcPath: enc,
          destPath: dest,
          manifest: manifestFor({ ...sealed, object }, patch),
          vaultKey: VAULT_KEY,
        }),
      );
    };
    const tag = Buffer.from(good);
    tag[tag.length - 1] ^= 1;
    assert.equal(await attempt(tag), "bad-tag");
    const iv = Buffer.from(good);
    iv[6] ^= 1;
    assert.equal(await attempt(iv), "bad-tag");
    const magic = Buffer.from(good);
    magic[0] ^= 1;
    assert.equal(await attempt(magic), "bad-magic");
    // truncated: the manifest still says the original size
    await writeFile(enc, good.subarray(0, good.length - 10));
    assert.equal(
      await code(
        openToFile({
          srcPath: enc,
          destPath: dest,
          manifest: manifestFor(sealed),
          vaultKey: VAULT_KEY,
        }),
      ),
      "bad-size",
    );
    await writeFile(enc, Buffer.concat([good, Buffer.from("x")]));
    assert.equal(
      await code(
        openToFile({
          srcPath: enc,
          destPath: dest,
          manifest: manifestFor(sealed),
          vaultKey: VAULT_KEY,
        }),
      ),
      "bad-size",
    );
    // a wrong declared plaintext size or hash is refused after the tag passes
    await writeFile(enc, good);
    assert.equal(
      await code(
        openToFile({
          srcPath: enc,
          destPath: dest,
          manifest: manifestFor({
            ...sealed,
            output: { ...sealed.output, bytes: sealed.output.bytes - 1 },
          }),
          vaultKey: VAULT_KEY,
        }),
      ),
      "bad-output",
    );
    assert.equal(
      await code(
        openToFile({
          srcPath: enc,
          destPath: dest,
          manifest: manifestFor({
            ...sealed,
            output: { ...sealed.output, sha256: "0".repeat(64) },
          }),
          vaultKey: VAULT_KEY,
        }),
      ),
      "bad-output",
    );
    await rm(enc);
    assert.equal(
      await code(
        openToFile({
          srcPath: enc,
          destPath: dest,
          manifest: manifestFor(sealed),
          vaultKey: VAULT_KEY,
        }),
      ),
      "object-missing",
    );
    assert.equal(
      (await readdir(dir)).some((n) => n.startsWith("shape.out")),
      false,
    );
  });
  it("the wrong AAD (other sha or buildKey) or the wrong vault key cannot unwrap the data key", async () => {
    const { enc, sealed, dest } = await sealSmall("aad");
    assert.equal(
      await code(
        openToFile({
          srcPath: enc,
          destPath: dest,
          manifest: manifestFor(sealed, { sha: SHA2 }),
          vaultKey: VAULT_KEY,
        }),
      ),
      "bad-key",
    );
    assert.equal(
      await code(
        openToFile({
          srcPath: enc,
          destPath: dest,
          manifest: manifestFor(sealed, { buildKey: "f".repeat(64) }),
          vaultKey: VAULT_KEY,
        }),
      ),
      "bad-key",
    );
    assert.equal(
      await code(
        openToFile({
          srcPath: enc,
          destPath: dest,
          manifest: manifestFor(sealed),
          vaultKey: OTHER_KEY,
        }),
      ),
      "bad-key",
    );
    assert.equal(
      (await readdir(dir)).some((n) => n.startsWith("aad.out")),
      false,
    );
  });
  it("errors never carry keys or plaintext", async () => {
    const { enc, sealed, dest } = await sealSmall("leak");
    const error = await rejects(
      openToFile({
        srcPath: enc,
        destPath: dest,
        manifest: manifestFor(sealed, { sha: SHA2 }),
        vaultKey: VAULT_KEY,
      }),
    );
    leaks(error, [VAULT_KEY, MARKER, sealed.dataKey.data, sealed.dataKey.iv]);
  });
});

describe("build cache (fake S3)", () => {
  let dir, n;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "s2-cache-"));
    n = 0;
  });
  after(() => rm(dir, { recursive: true, force: true }));
  const BUILD_KEY = buildKeyOf(VAULT_KEY, inputsOf());
  const infoFor = (vault = VAULT_KEY, extra = {}) => ({
    branch: "main",
    commit: {
      message: "Headline",
      authorName: "Dev Person",
      date: "2026-10-01T10:00:00Z",
    },
    settings: BUILD_SETTINGS,
    env: envFingerprints(vault, inputsOf().env),
    builder: inputsOf().builder,
    run: { id: 5001, attempt: 1, conclusion: "success" },
    builtAt: "2026-10-10T10:00:00Z",
    output: { files: 10, dirs: 3, symlinks: 0 },
    scan: {
      findings: 0,
      maps: 0,
      tsOutsideNodeModules: 0,
      forbiddenPaths: 0,
      secretHits: 2,
      envFiles: 0,
      symlinkEscapes: 0,
    },
    tar: { entries: 13, bad: 0 },
    ...extra,
  });
  async function fixture({
    fake = createFakeS3(),
    vault = VAULT_KEY,
    size = 400000,
    uuid,
  } = {}) {
    const src = join(dir, `src-${++n}.tgz`);
    await randomFile(src, size);
    const cache = createBuildCache({
      s3: fake.client(),
      vaultKey: vault,
      now: () => new Date("2026-10-10T12:00:00Z"),
      ...(uuid ? { uuid } : {}),
    });
    return { fake, cache, src, plain: await fileHash(src) };
  }
  const args = (src, extra = {}) => ({
    sha: SHA1,
    buildKey: BUILD_KEY,
    srcPath: src,
    workDir: dir,
    info: infoFor(),
    ...extra,
  });
  const mKey = manifestKey(SHA1, BUILD_KEY);
  it("stores, looks up and fetches a build; S3 holds only ciphertext and a manifest without values", async () => {
    const { fake, cache, src, plain } = await fixture();
    const stored = await cache.store(args(src));
    assert.equal(stored.state, "stored");
    const keys = fake.liveKeys().sort();
    assert.equal(keys.length, 2);
    assert.equal(keys[0], mKey);
    assert.match(
      keys[1],
      new RegExp(`^${objectPrefix(SHA1, BUILD_KEY)}[0-9a-f-]{36}\\.tgz\\.enc$`),
    );
    assert.equal(stored.manifest.object.key, keys[1]);
    assert.equal(fake.contentType(mKey), "application/json");
    const raw = fake.versions(keys[1]).at(-1).body;
    assert.equal(
      raw.includes(Buffer.from(MARKER)),
      false,
      "plaintext marker must not appear in S3",
    );
    assert.equal(raw.subarray(0, 4).toString(), "SBB1");
    const text = fake.versions(mKey).at(-1).body.toString();
    const { dataKey, ...rest } = JSON.parse(text);
    assert.equal(text.includes(R2), false);
    assert.equal(text.includes(WORKER), false);
    assert.equal(text.includes(VAULT_KEY), false);
    assertNoSecrets(
      rest,
      [VAULT_KEY, R2, WORKER, MARKER, "Dev Person@", "@example"],
      "manifest",
    );
    assert.equal(stored.manifest.keyFp, keyFingerprint(VAULT_KEY));
    assert.equal(stored.manifest.storedAt, "2026-10-10T12:00:00.000Z");
    assert.ok(fake.stats.maxWriteChunk <= 65536);
    assert.deepEqual(
      (await readdir(dir)).filter(
        (x) => x.endsWith(".enc") || x.endsWith(".part"),
      ),
      [],
      "temp files removed",
    );
    assert.deepEqual(
      await cache
        .lookup({ sha: SHA1, buildKey: BUILD_KEY })
        .then((r) => [r.state, r.manifest.output.sha256]),
      ["hit", plain],
    );
    const dest = join(dir, `fetched-${n}.tgz`);
    const got = await cache.fetch({
      sha: SHA1,
      buildKey: BUILD_KEY,
      destPath: dest,
    });
    assert.equal(got.state, "hit");
    assert.equal(await fileHash(dest), plain);
    assert.deepEqual(
      (await readdir(dir)).filter((x) => x.startsWith(`fetched-${n}`)),
      [`fetched-${n}.tgz`],
    );
  });
  it("a different buildKey or sha is a miss; bad ids are refused", async () => {
    const { cache, src } = await fixture();
    await cache.store(args(src));
    assert.deepEqual(
      await cache.lookup({ sha: SHA1, buildKey: "9".repeat(64) }),
      { state: "miss", reason: "absent" },
    );
    assert.deepEqual(await cache.lookup({ sha: SHA2, buildKey: BUILD_KEY }), {
      state: "miss",
      reason: "absent",
    });
    for (const bad of [
      { sha: "short", buildKey: BUILD_KEY },
      { sha: SHA1, buildKey: "x" },
      { sha: `${SHA1}/../x`, buildKey: BUILD_KEY },
      {},
    ])
      await rejects(cache.lookup(bad), (e) =>
        assert.equal(e.code, "bad-input"),
      );
  });
  it("works in an unversioned bucket too", async () => {
    const { cache, src, plain } = await fixture({
      fake: createFakeS3({ versioning: false }),
    });
    assert.equal((await cache.store(args(src))).state, "stored");
    const dest = join(dir, `unv-${n}.tgz`);
    assert.equal(
      (await cache.fetch({ sha: SHA1, buildKey: BUILD_KEY, destPath: dest }))
        .state,
      "hit",
    );
    assert.equal(await fileHash(dest), plain);
  });
  // ---- manifest MAC ---------------------------------------------------------
  const leafPaths = (value, prefix = []) =>
    value && typeof value === "object"
      ? Object.entries(value).flatMap(([k, v]) =>
          leafPaths(v, [...prefix, Array.isArray(value) ? Number(k) : k]),
        )
      : [prefix];
  const edit = (manifest, path) => {
    const copy = JSON.parse(JSON.stringify(manifest));
    const parent = path.slice(0, -1).reduce((o, k) => o[k], copy);
    const key = path.at(-1);
    const v = parent[key];
    parent[key] =
      typeof v === "number"
        ? v + 1
        : typeof v === "boolean"
          ? !v
          : /^[0-9a-f-]+$/.test(v) && v.length > 8
            ? v.slice(0, -1) + (v.endsWith("a") ? "b" : "a")
            : `${v}x`;
    return copy;
  };
  it("the manifest MAC rejects an edit of any single field", async () => {
    const { fake, cache, src } = await fixture();
    const { manifest } = await cache.store(args(src));
    const paths = leafPaths(manifest);
    assert.ok(paths.length > 40);
    let macRejections = 0;
    for (const path of paths) {
      const result = verifyManifest(
        Buffer.from(JSON.stringify(edit(manifest, path))),
        { sha: SHA1, buildKey: BUILD_KEY, vaultKey: VAULT_KEY },
      );
      assert.notEqual(result.state, "ok", path.join("."));
      if (result.reason === "bad-mac") macRejections++;
    }
    assert.ok(
      macRejections >= 30,
      `only ${macRejections} edits reached the MAC check`,
    );
    // added and removed fields
    const extra = { ...manifest, extra: 1 };
    assert.equal(
      verifyManifest(Buffer.from(JSON.stringify(extra)), {
        sha: SHA1,
        buildKey: BUILD_KEY,
        vaultKey: VAULT_KEY,
      }).reason,
      "bad-schema",
    );
    const { mac, ...without } = manifest;
    assert.equal(
      verifyManifest(Buffer.from(JSON.stringify(without)), {
        sha: SHA1,
        buildKey: BUILD_KEY,
        vaultKey: VAULT_KEY,
      }).reason,
      "bad-schema",
    );
    assert.equal(
      verifyManifest(Buffer.from("not json"), {
        sha: SHA1,
        buildKey: BUILD_KEY,
        vaultKey: VAULT_KEY,
      }).reason,
      "bad-json",
    );
    assert.equal(
      verifyManifest(Buffer.alloc(70000), {
        sha: SHA1,
        buildKey: BUILD_KEY,
        vaultKey: VAULT_KEY,
      }).reason,
      "too-large",
    );
    // the same bytes, signed with another vault key, are a plain miss for this one
    assert.equal(
      verifyManifest(
        Buffer.from(
          JSON.stringify(
            signManifest(
              { ...manifest, keyFp: keyFingerprint(OTHER_KEY) },
              OTHER_KEY,
            ),
          ),
        ),
        { sha: SHA1, buildKey: BUILD_KEY, vaultKey: VAULT_KEY },
      ).reason,
      "foreign-key",
    );
    assert.equal(fake.calls.length > 0, true);
  });
  it("a manifest signed under another VAULT_KEY is a plain miss, never an error", async () => {
    const a = await fixture();
    await a.cache.store(args(a.src, { info: infoFor() }));
    const b = createBuildCache({ s3: a.fake.client(), vaultKey: OTHER_KEY });
    const found = await b.lookup({ sha: SHA1, buildKey: BUILD_KEY });
    assert.deepEqual(found, { state: "miss", reason: "foreign-key" });
    const fetched = await b.fetch({
      sha: SHA1,
      buildKey: BUILD_KEY,
      destPath: join(dir, "never.tgz"),
    });
    assert.deepEqual(fetched, { state: "miss", reason: "foreign-key" });
    assert.equal((await readdir(dir)).includes("never.tgz"), false);
  });
  // ---- integrity on reuse ---------------------------------------------------
  it("tampered ciphertext in S3 is rejected without leaving plaintext", async () => {
    const { fake, cache, src } = await fixture();
    const { manifest } = await cache.store(args(src));
    fake.tamper(manifest.object.key, 200);
    const dest = join(dir, `tamper-${n}.tgz`);
    assert.deepEqual(
      await cache.fetch({ sha: SHA1, buildKey: BUILD_KEY, destPath: dest }),
      { state: "invalid", reason: "bad-object-hash" },
    );
    assert.deepEqual(
      (await readdir(dir)).filter((x) => x.startsWith(`tamper-${n}`)),
      [],
    );
  });
  it("a truncated or padded object, or a missing one, is rejected", async () => {
    for (const [mutate, reason] of [
      [
        (fake, key) =>
          fake.replace(key, fake.versions(key).at(-1).body.subarray(0, 5000)),
        "bad-size",
      ],
      [
        (fake, key) =>
          fake.replace(
            key,
            Buffer.concat([fake.versions(key).at(-1).body, Buffer.from("pad")]),
          ),
        "bad-size",
      ],
      [(fake, key) => fake.replace(key, Buffer.alloc(0)), "bad-size"],
      [async (fake, key) => fake.client().del(key), "object-missing"],
    ]) {
      const { fake, cache, src } = await fixture();
      const { manifest } = await cache.store(args(src));
      await mutate(fake, manifest.object.key);
      const result = await cache.fetch({
        sha: SHA1,
        buildKey: BUILD_KEY,
        destPath: join(dir, `trunc-${n}.tgz`),
      });
      assert.deepEqual(result, { state: "invalid", reason });
    }
  });
  it("another build's object swapped under this manifest is rejected", async () => {
    const a = await fixture();
    const b = await fixture({ fake: a.fake });
    const ma = (await a.cache.store(args(a.src))).manifest;
    const mb = (await b.cache.store({ ...args(b.src), sha: SHA2 })).manifest;
    a.fake.swap(ma.object.key, mb.object.key);
    const result = await a.cache.fetch({
      sha: SHA1,
      buildKey: BUILD_KEY,
      destPath: join(dir, `swap-${n}.tgz`),
    });
    assert.equal(result.state, "invalid");
  });
  it("a manifest copied to another path (sha/buildKey mismatch) is rejected", async () => {
    const { fake, cache, src } = await fixture();
    await cache.store(args(src));
    const raw = fake.versions(mKey).at(-1).body;
    await fake.client().putBytes(manifestKey(SHA2, BUILD_KEY), raw);
    assert.deepEqual(await cache.lookup({ sha: SHA2, buildKey: BUILD_KEY }), {
      state: "invalid",
      reason: "path-mismatch",
    });
    const other = "7".repeat(64);
    await fake.client().putBytes(manifestKey(SHA1, other), raw);
    assert.deepEqual(await cache.lookup({ sha: SHA1, buildKey: other }), {
      state: "invalid",
      reason: "path-mismatch",
    });
  });
  it("a correctly signed manifest that points at a foreign or traversing object key is rejected", async () => {
    const { fake, cache, src } = await fixture();
    const { manifest } = await cache.store(args(src));
    for (const key of [
      `builds/${SHA2}/${BUILD_KEY}/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.tgz.enc`,
      `builds/${SHA1}/${BUILD_KEY}/../x.tgz.enc`,
      `files/cid/fid`,
      `builds/${SHA1}/${BUILD_KEY}/not-a-uuid.tgz.enc`,
    ]) {
      const forged = signManifest(
        { ...manifest, object: { ...manifest.object, key } },
        VAULT_KEY,
      );
      assert.equal(
        verifyManifest(Buffer.from(JSON.stringify(forged)), {
          sha: SHA1,
          buildKey: BUILD_KEY,
          vaultKey: VAULT_KEY,
        }).reason,
        "path-mismatch",
        key,
      );
    }
    assert.ok(fake);
  });
  it("an unclean scan, bad tar or inconsistent sizes are rejected even when correctly signed", async () => {
    const { cache, src } = await fixture();
    const { manifest } = await cache.store(args(src));
    const check = (patch) =>
      verifyManifest(
        Buffer.from(
          JSON.stringify(signManifest({ ...manifest, ...patch }, VAULT_KEY)),
        ),
        { sha: SHA1, buildKey: BUILD_KEY, vaultKey: VAULT_KEY },
      );
    for (const field of [
      "findings",
      "maps",
      "tsOutsideNodeModules",
      "forbiddenPaths",
      "envFiles",
      "symlinkEscapes",
    ])
      assert.deepEqual(
        check({ scan: { ...manifest.scan, [field]: 1 } }),
        { state: "invalid", reason: "unclean-scan" },
        field,
      );
    assert.equal(
      check({ scan: { ...manifest.scan, secretHits: 5 } }).state,
      "ok",
      "allowlisted hits are only counted",
    );
    assert.equal(check({ tar: { entries: 5, bad: 1 } }).reason, "bad-tar");
    assert.equal(check({ tar: { entries: 0, bad: 0 } }).reason, "bad-tar");
    assert.equal(
      check({
        output: { ...manifest.output, bytes: manifest.output.bytes + 1 },
      }).reason,
      "bad-size",
    );
    assert.equal(
      check({
        object: { ...manifest.object, bytes: manifest.object.bytes + 1 },
      }).reason,
      "bad-size",
    );
    assert.equal(
      check({ output: { ...manifest.output, bytes: 0 } }).reason,
      "bad-size",
    );
    // an unclean build is not stored in the first place
    for (const scan of [
      { ...infoFor().scan, findings: 1 },
      { ...infoFor().scan, envFiles: 2 },
    ]) {
      const fresh = await fixture();
      await rejects(
        fresh.cache.store(
          args(fresh.src, { info: infoFor(VAULT_KEY, { scan }) }),
        ),
        (e) => assert.equal(e.code, "unclean-scan"),
      );
      assert.deepEqual(fresh.fake.liveKeys(), []);
    }
  });
  it("store refuses bad info or a plaintext mismatch before writing anything", async () => {
    const { fake, cache, src, plain } = await fixture();
    for (const [info, code] of [
      [infoFor(VAULT_KEY, { scan: undefined }), "bad-info"],
      [infoFor(VAULT_KEY, { branch: "" }), "bad-info"],
      [
        infoFor(VAULT_KEY, {
          output: { files: 1, dirs: 1, symlinks: 0, sha256: "0".repeat(64) },
        }),
        "output-mismatch",
      ],
      [
        infoFor(VAULT_KEY, {
          output: { files: 1, dirs: 1, symlinks: 0, bytes: 1 },
        }),
        "output-mismatch",
      ],
    ]) {
      const error = await rejects(cache.store(args(src, { info })), (e) =>
        assert.equal(e.code, code),
      );
      leaks(error, [VAULT_KEY, MARKER]);
    }
    assert.deepEqual(
      fake.calls.filter((c) => c.op === "put"),
      [],
    );
    assert.equal(
      (
        await cache.store(
          args(src, {
            info: infoFor(VAULT_KEY, {
              output: { files: 1, dirs: 1, symlinks: 0, sha256: plain },
            }),
          }),
        )
      ).state,
      "stored",
    );
    assert.deepEqual(
      (await readdir(dir)).filter((x) => x.endsWith(".enc")),
      [],
    );
  });
  // ---- races and quarantine -------------------------------------------------
  it("two writers: one manifest wins, the other verifies it and adopts", async () => {
    const fake = createFakeS3();
    const one = await fixture({ fake, size: 300000 });
    const two = await fixture({ fake, size: 310000 });
    const [ra, rb] = await Promise.all([
      one.cache.store(args(one.src)),
      two.cache.store(args(two.src)),
    ]);
    assert.deepEqual([ra.state, rb.state].sort(), ["adopted", "stored"]);
    assert.deepEqual(
      ra.manifest,
      rb.manifest,
      "both end up with the winner's manifest",
    );
    const live = fake.liveKeys().sort();
    assert.equal(
      live.length,
      2,
      "manifest + the winner's object only; the loser's orphan is dropped",
    );
    assert.equal(live.filter((k) => k.endsWith(".json")).length, 1);
    assert.equal(fake.versions(mKey).length, 1, "the manifest is written once");
    const winnerPlain = ra.state === "stored" ? one.plain : two.plain;
    const dest = join(dir, `race-${n}.tgz`);
    assert.equal(
      (
        await one.cache.fetch({
          sha: SHA1,
          buildKey: BUILD_KEY,
          destPath: dest,
        })
      ).state,
      "hit",
    );
    assert.equal(await fileHash(dest), winnerPlain);
    // a later writer also adopts
    const three = await fixture({ fake });
    assert.equal((await three.cache.store(args(three.src))).state, "adopted");
    assert.equal(fake.liveKeys().length, 2);
  });
  it("an untrustworthy manifest in the way is quarantined and the write retried once", async () => {
    for (const planted of [
      (fake) => fake.client().putBytes(mKey, Buffer.from("garbage")),
      async (fake) => {
        const other = await fixture({ fake, vault: OTHER_KEY });
        await other.cache.store(args(other.src, { info: infoFor(OTHER_KEY) }));
      },
    ]) {
      const fake = createFakeS3();
      await planted(fake);
      const { cache, src, plain } = await fixture({ fake });
      const result = await cache.store(args(src));
      assert.equal(result.state, "stored");
      assert.ok(
        fake.versions(mKey).some((v) => v.marker),
        "a delete marker was written",
      );
      const dest = join(dir, `plant-${n}.tgz`);
      assert.equal(
        (await cache.fetch({ sha: SHA1, buildKey: BUILD_KEY, destPath: dest }))
          .state,
        "hit",
      );
      assert.equal(await fileHash(dest), plain);
    }
  });
  it("quarantine adds a delete marker to the manifest and leaves the object", async () => {
    const { fake, cache, src } = await fixture();
    const { manifest } = await cache.store(args(src));
    assert.equal(
      await cache.quarantine({ sha: SHA1, buildKey: BUILD_KEY }),
      true,
    );
    const versions = fake.versions(mKey);
    assert.equal(versions.length, 2);
    assert.equal(versions.at(-1).marker, true);
    assert.equal(versions[0].marker, false, "the old version is not destroyed");
    assert.deepEqual(await cache.lookup({ sha: SHA1, buildKey: BUILD_KEY }), {
      state: "miss",
      reason: "absent",
    });
    assert.ok(fake.liveKeys().includes(manifest.object.key));
    // a rebuild after quarantine can be stored again (If-None-Match passes over a delete marker)
    const again = await fixture({ fake });
    assert.equal((await again.cache.store(args(again.src))).state, "stored");
    await rejects(cache.quarantine({ sha: "bad", buildKey: BUILD_KEY }), (e) =>
      assert.equal(e.code, "bad-input"),
    );
  });
  it("S3 trouble surfaces as errors the caller can treat as a miss; nothing is half-written", async () => {
    const { fake, cache, src } = await fixture();
    fake.fail("list", { status: 500 });
    await rejects(cache.lookup({ sha: SHA1, buildKey: BUILD_KEY }), (e) =>
      assert.equal(e.status, 503),
    );
    fake.reset();
    fake.fail("put", { status: 500, times: -1 });
    const error = await rejects(cache.store(args(src)), (e) =>
      assert.equal(e.status, 503),
    );
    leaks(error, [VAULT_KEY, FAKE.secretAccessKey]);
    assert.deepEqual(fake.liveKeys(), []);
    assert.deepEqual(
      (await readdir(dir)).filter((x) => x.endsWith(".enc")),
      [],
    );
    fake.reset();
    // a failing manifest write drops the orphan object
    fake.calls.length = 0;
    let first = true;
    const realFetch = fake.fetch;
    const flaky = createBuildCache({
      s3: fake.client({
        fetch: async (url, init) =>
          init.method === "PUT" && url.endsWith(".json") && first
            ? ((first = false),
              new Response("<Error><Code>InternalError</Code></Error>", {
                status: 500,
              }))
            : realFetch(url, init),
      }),
      vaultKey: VAULT_KEY,
    });
    await rejects(flaky.store(args(src)), (e) => assert.equal(e.status, 503));
    assert.deepEqual(fake.liveKeys(), [], "no orphan object, no manifest");
    // a transient error while checking the winner must not quarantine it
    const winner = await fixture({ fake });
    await winner.cache.store(args(winner.src));
    fake.fail("list", { status: 500 });
    await rejects(cache.store(args(src)), (e) => assert.equal(e.status, 503));
    assert.equal(
      (await cache.lookup({ sha: SHA1, buildKey: BUILD_KEY })).state,
      "hit",
    );
    assert.equal(
      fake.versions(mKey).some((v) => v.marker),
      false,
    );
  });
  it("a huge manifest planted at the key is an integrity failure, not a stuck lookup", async () => {
    const { fake, cache } = await fixture();
    await fake.client().putBytes(mKey, Buffer.alloc(200000, 120));
    assert.deepEqual(await cache.lookup({ sha: SHA1, buildKey: BUILD_KEY }), {
      state: "invalid",
      reason: "too-large",
    });
  });
});
