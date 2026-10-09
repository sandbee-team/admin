import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { createS3, signRequest } from "../backend/lib/s3.js";
// In-memory S3 for tests: versioned objects, delete markers, signature
// checking and failure injection. It never touches the network.
export const FAKE = {
  region: "ap-south-1",
  bucket: "sandbee-test-files",
  accessKeyId: "AKIAFAKEFAKEFAKE0001",
  secretAccessKey: "fake-secret-access-key-0123456789",
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const xml = (status, code, headers = {}) =>
  new Response(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`, {
    status,
    headers,
  });
export function createFakeS3({ versioning = true } = {}) {
  const store = new Map(); // key -> [{id, body, marker}]
  const calls = [];
  const failures = [];
  let counter = 0;
  const hooks = { afterPut: null, beforePut: null };
  const state = { versioning };
  const pending = [];
  const live = (key) => {
    const versions = store.get(key) ?? [];
    const last = versions[versions.length - 1];
    return last && !last.marker ? last : null;
  };
  function newVersion(key, body, marker = false, type = "") {
    const id = state.versioning ? `ver-${++counter}-${key.length}` : null;
    const entry = { id: id ?? "null", body, marker, type };
    store.set(key, [...(store.get(key) ?? []), entry]);
    return id;
  }
  function verify(url, init, body) {
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const auth = headers.authorization ?? "",
      match =
        /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/.exec(
          auth,
        );
    if (!match) return false;
    const [, akid, , region, signedHeaders, signature] = match;
    if (akid !== FAKE.accessKeyId || region !== FAKE.region) return false;
    if (headers["x-amz-content-sha256"] !== sha256(body ?? "")) return false;
    const extra = {};
    for (const name of signedHeaders.split(";"))
      if (!["host", "x-amz-date", "x-amz-content-sha256"].includes(name))
        extra[name] = headers[name];
    const u = new URL(url);
    const query = {};
    for (const [k, v] of u.searchParams) query[k] = v;
    const again = signRequest({
      method: init.method,
      host: u.host,
      path: decodeURIComponent(u.pathname),
      query,
      headers: extra,
      payloadHash: headers["x-amz-content-sha256"],
      region,
      accessKeyId: akid,
      secretAccessKey: FAKE.secretAccessKey,
      date: new Date(
        headers["x-amz-date"].replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
          "$1-$2-$3T$4:$5:$6Z",
        ),
      ),
    });
    return (
      again.signature === signature && again.signedHeaders === signedHeaders
    );
  }
  async function fetch(url, init = {}) {
    const u = new URL(url),
      method = init.method ?? "GET",
      key = decodeURIComponent(u.pathname.slice(1));
    const body = init.body === undefined ? undefined : Buffer.from(init.body);
    if (u.host !== `${FAKE.bucket}.s3.${FAKE.region}.amazonaws.com`)
      throw new TypeError("unexpected host");
    if (init.redirect !== "error") throw new Error("redirect must be error");
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const copySource = headers["x-amz-copy-source"];
    const op =
      method === "PUT"
        ? copySource
          ? "copy"
          : "put"
        : method === "GET"
          ? key
            ? "get"
            : "list"
          : "delete";
    calls.push({ op, key });
    const injected = failures.findIndex((f) => f.op === op && f.left !== 0);
    if (injected >= 0) {
      const f = failures[injected];
      if (f.left > 0) f.left--;
      if (f.throwNetwork) throw new TypeError("network down");
      return f.okBody
        ? new Response(f.okBody, { status: 200, headers: f.headers ?? {} })
        : xml(f.status ?? 500, f.code ?? "InternalError");
    }
    if (!verify(url, { ...init, method }, body))
      return xml(403, "SignatureDoesNotMatch");
    if (op === "put") {
      if (headers["if-none-match"] === "*" && live(key))
        return xml(412, "PreconditionFailed");
      if (headers["x-amz-server-side-encryption"] !== "AES256")
        return xml(400, "InvalidArgument");
      if (hooks.beforePut) await hooks.beforePut(key);
      const id = newVersion(key, body, false, headers["content-type"] ?? "");
      if (hooks.afterPut) await hooks.afterPut(key);
      return new Response(null, {
        status: 200,
        headers: id ? { "x-amz-version-id": id } : {},
      });
    }
    if (op === "copy") {
      const m = /^\/([^/]+)\/([^?]+)(?:\?versionId=(.+))?$/.exec(copySource);
      const [, bucket, srcKey, srcVersion] = m
        ? [
            m[0],
            m[1],
            decodeURIComponent(m[2]),
            m[3] && decodeURIComponent(m[3]),
          ]
        : [];
      if (bucket !== FAKE.bucket) return xml(404, "NoSuchBucket");
      // Like S3: copying an object onto itself needs MetadataDirective REPLACE.
      if (
        srcKey === key &&
        !srcVersion &&
        headers["x-amz-metadata-directive"] !== "REPLACE"
      )
        return xml(400, "InvalidRequest");
      if (headers["x-amz-server-side-encryption"] !== "AES256")
        return xml(400, "InvalidArgument");
      const found = srcVersion
        ? (store.get(srcKey) ?? []).find(
            (v) => v.id === srcVersion && !v.marker,
          )
        : live(srcKey);
      if (!found) return xml(404, srcVersion ? "NoSuchVersion" : "NoSuchKey");
      const id = newVersion(
        key,
        found.body,
        false,
        headers["content-type"] ?? found.type,
      );
      return new Response(
        "<CopyObjectResult><ETag>x</ETag></CopyObjectResult>",
        { status: 200, headers: id ? { "x-amz-version-id": id } : {} },
      );
    }
    if (op === "get") {
      const versionId = u.searchParams.get("versionId");
      const versions = store.get(key) ?? [];
      const found = versionId
        ? versions.find((v) => v.id === versionId)
        : versions[versions.length - 1];
      if (!found) return xml(404, versionId ? "NoSuchVersion" : "NoSuchKey");
      if (found.marker)
        return versionId
          ? xml(405, "MethodNotAllowed")
          : xml(404, "NoSuchKey", { "x-amz-delete-marker": "true" });
      return new Response(found.body, { status: 200 });
    }
    if (op === "delete") {
      newVersion(key, Buffer.alloc(0), true);
      return new Response(null, { status: 204 });
    }
    const prefix = u.searchParams.get("prefix") ?? "";
    const keys = [...store.keys()]
      .filter((k) => k.startsWith(prefix) && live(k))
      .sort();
    return new Response(
      `<ListBucketResult><KeyCount>${keys.length}</KeyCount>${keys
        .slice(0, Number(u.searchParams.get("max-keys") ?? 1000))
        .map(
          (k) =>
            `<Contents><Key>${k}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>${live(k).body.length}</Size></Contents>`,
        )
        .join("")}</ListBucketResult>`,
      { status: 200 },
    );
  }
  const fake = {
    fetch,
    calls,
    hooks,
    state,
    // Fails the next `times` calls of `op` (-1 = every call).
    fail(
      op,
      { status = 500, code = "InternalError", times = 1, ...rest } = {},
    ) {
      failures.push({ op, status, code, left: times, ...rest });
    },
    // Answers `op` with 200 and the given body (CopyObject-style error body).
    okWith(op, okBody, times = 1) {
      failures.push({ op, okBody, left: times });
    },
    reset() {
      failures.length = 0;
      calls.length = 0;
    },
    // Keys whose current version is a live object.
    liveKeys: () => [...store.keys()].filter((k) => live(k)),
    allKeys: () => [...store.keys()],
    versions: (key) => (store.get(key) ?? []).map((v) => ({ ...v })),
    // Flips a bit in every stored version of the key (ciphertext tampering).
    tamper(key, offset = 20) {
      for (const v of store.get(key) ?? [])
        if (v.body.length > offset) v.body[offset] ^= 1;
    },
    // Swaps the bytes of two keys (AAD/record swap).
    swap(a, b) {
      const [x, y] = [store.get(a).at(-1), store.get(b).at(-1)];
      [x.body, y.body] = [y.body, x.body];
    },
    // Replaces the body of the newest version (e.g. an oversized object).
    replace(key, buffer) {
      store.get(key).at(-1).body = buffer;
    },
    clear() {
      store.clear();
    },
    // Drops noncurrent versions, as the bucket lifecycle would.
    purgeNoncurrent(key) {
      const versions = store.get(key) ?? [];
      store.set(key, versions.slice(-1));
      if (versions.at(-1)?.marker) store.set(key, []);
    },
    pending,
    // node:https.request stand-in for streaming uploads: collects the body,
    // runs it through the same fake (signature check included) and answers
    // like an IncomingMessage.
    stats: { maxWriteChunk: 0, requests: 0 },
    request(options, onResponse) {
      const chunks = [];
      const req = new Writable({
        write(chunk, _e, cb) {
          fake.stats.maxWriteChunk = Math.max(
            fake.stats.maxWriteChunk,
            chunk.length,
          );
          chunks.push(chunk);
          cb();
        },
        final(cb) {
          const headers = options.headers ?? {};
          const body = Buffer.concat(chunks);
          fake.stats.requests++;
          fake.lastRequest = { options, bytes: body.length };
          (async () => {
            if (Number(headers["content-length"]) !== body.length)
              throw new Error("content-length mismatch");
            const res = await fetch(
              `https://${options.hostname}${options.path}`,
              { method: options.method, headers, body, redirect: "error" },
            );
            const buffer = Buffer.from(await res.arrayBuffer());
            const message = Readable.from(buffer.length ? [buffer] : []);
            message.statusCode = res.status;
            message.headers = Object.fromEntries(res.headers);
            onResponse(message);
          })().then(
            () => cb(),
            (error) => cb(error),
          );
        },
      });
      req.setTimeout = () => req;
      return req;
    },
    contentType: (key) => store.get(key)?.at(-1)?.type ?? "",
    client: (overrides = {}) =>
      createS3({ ...FAKE, fetch, httpsRequest: fake.request, ...overrides }),
  };
  return fake;
}
