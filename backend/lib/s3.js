import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import https from "node:https";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "./errors.js";
// Minimal S3 client: AWS Signature V4 over fetch + node:crypto. It needs five
// operations (put, get, delete, copy, list) so the full SDK is not worth its
// weight. Nothing here logs, and S3 response bodies never reach a message:
// failures become a fixed 503 (or 410) with an internal `s3Code`.
export const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
// RFC 3986: only A-Z a-z 0-9 - . _ ~ stay literal.
export const encodeRfc3986 = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export const encodePath = (path) =>
  path.split("/").map(encodeRfc3986).join("/");
const amzDateOf = (date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "");
// Pure signer. `path` is the raw (unencoded) path; `headers` are the extra
// headers to sign (host, x-amz-date and x-amz-content-sha256 are added).
export function signRequest({
  method,
  host,
  path,
  query = {},
  headers = {},
  payloadHash,
  region,
  service = "s3",
  accessKeyId,
  secretAccessKey,
  date,
}) {
  const amzDate = amzDateOf(date),
    day = amzDate.slice(0, 8);
  const all = {};
  for (const [name, value] of Object.entries({
    ...headers,
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  }))
    all[name.toLowerCase()] = String(value).trim().replace(/\s+/g, " ");
  const names = Object.keys(all).sort(),
    signedHeaders = names.join(";");
  const canonicalQuery = Object.entries(query)
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(String(v))])
    .sort((a, b) =>
      a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    method,
    encodePath(path),
    canonicalQuery,
    names.map((name) => `${name}:${all[name]}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const signingKey = [day, region, service, "aws4_request"].reduce(
    (key, part) => hmac(key, part),
    `AWS4${secretAccessKey}`,
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");
  return {
    amzDate,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    signature,
    canonicalQuery,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}
const unavailable = (s3Code = "") => {
  const error = new HttpError(503, "File storage is unavailable.", true);
  error.s3Code = s3Code;
  return error;
};
const gone = (s3Code) => {
  const error = new HttpError(410, "This file version is no longer available.");
  error.s3Code = s3Code;
  return error;
};
const codeOf = (text) => {
  const match = /<Code>([A-Za-z]{1,64})<\/Code>/.exec(text);
  return match ? match[1] : "";
};
async function readBody(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(),
    parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw unavailable("TooLarge");
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}
// Keys the streaming/build helpers may touch: client files and the build cache.
const KEY_RE = /^(?:files|builds)\/[A-Za-z0-9._/-]{1,900}$/;
export const validKey = (key) =>
  typeof key === "string" &&
  KEY_RE.test(key) &&
  !key.includes("//") &&
  !key.split("/").some((part) => part === "." || part === "..") &&
  !key.endsWith("/");
const SHA256_RE = /^[0-9a-f]{64}$/;
const unxml = (text) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
// Whether an error is S3 refusing a conditional write (If-None-Match).
export const isConflict = (error) =>
  ["PreconditionFailed", "ConditionalRequestConflict"].includes(error?.s3Code);
const validVersion = (id) =>
  typeof id === "string" &&
  id.length >= 1 &&
  id.length <= 1024 &&
  !/[\u0000-\u001f\u007f]/.test(id);
export function createS3({
  region,
  bucket,
  accessKeyId,
  secretAccessKey,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  httpsRequest = https.request,
}) {
  if (!BUCKET_RE.test(bucket ?? ""))
    throw new Error("Invalid S3 bucket name (dots are not supported).");
  if (!REGION_RE.test(region ?? "")) throw new Error("Invalid S3 region.");
  if (!accessKeyId || !secretAccessKey)
    throw new Error("S3 credentials are required.");
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  async function call({
    method,
    key = "",
    query = {},
    headers = {},
    body,
    timeout = 10000,
    maxBytes = 1024 * 1024,
  }) {
    const path = `/${key}`,
      payload = body ?? "";
    const signed = signRequest({
      method,
      host,
      path,
      query,
      headers,
      payloadHash: sha256(payload),
      region,
      accessKeyId,
      secretAccessKey,
      date: now(),
    });
    const sendHeaders = {
      ...Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      "x-amz-date": signed.amzDate,
      "x-amz-content-sha256": sha256(payload),
      authorization: signed.authorization,
    };
    const search = signed.canonicalQuery ? `?${signed.canonicalQuery}` : "";
    let response, data;
    try {
      response = await fetchImpl(
        `https://${host}${encodePath(path)}${search}`,
        {
          method,
          headers: sendHeaders,
          ...(body === undefined ? {} : { body }),
          redirect: "error",
          signal: AbortSignal.timeout(timeout),
        },
      );
      data = await readBody(response, response.ok ? maxBytes : 65536);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unavailable("Network");
    }
    if (!response.ok) {
      const code = codeOf(data.toString("utf8"));
      if (code === "NoSuchVersion" || code === "NoSuchKey") throw gone(code);
      throw unavailable(code || `Http${response.status}`);
    }
    return { status: response.status, headers: response.headers, data };
  }
  // Signs a request whose body is not buffered; returns query and headers.
  function sign({ method, key, query = {}, headers = {}, payloadHash }) {
    const signed = signRequest({
      method,
      host,
      path: `/${key}`,
      query,
      headers,
      payloadHash,
      region,
      accessKeyId,
      secretAccessKey,
      date: now(),
    });
    return {
      search: signed.canonicalQuery ? `?${signed.canonicalQuery}` : "",
      headers: {
        ...Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
        ),
        "x-amz-date": signed.amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization: signed.authorization,
      },
    };
  }
  const versionOf = (headers) => {
    const id = headers.get("x-amz-version-id");
    return validVersion(id) && id !== "null" ? id : null;
  };
  return {
    async put(key, buffer) {
      const { headers } = await call({
        method: "PUT",
        key,
        body: buffer,
        timeout: 30000,
        headers: {
          "content-type": "application/octet-stream",
          "if-none-match": "*",
          "x-amz-server-side-encryption": "AES256",
        },
      });
      const versionId = versionOf(headers);
      if (!versionId) {
        // Versioning is off: restore and recovery would not work, so refuse
        // and remove the unversioned object we just wrote.
        await call({ method: "DELETE", key }).catch(() => {});
        throw unavailable("NoVersionId");
      }
      return { versionId };
    },
    async get(key, versionId, maxBytes) {
      if (!validVersion(versionId)) throw unavailable("BadVersion");
      const { data } = await call({
        method: "GET",
        key,
        query: { versionId },
        timeout: 30000,
        maxBytes,
      });
      return data;
    },
    async del(key) {
      await call({ method: "DELETE", key });
    },
    async copy(key, versionId) {
      if (!validVersion(versionId)) throw unavailable("BadVersion");
      const { headers, data } = await call({
        method: "PUT",
        key,
        timeout: 30000,
        headers: {
          "x-amz-copy-source": `/${bucket}/${encodePath(key)}?versionId=${encodeRfc3986(versionId)}`,
          "x-amz-server-side-encryption": "AES256",
        },
      });
      // CopyObject can answer 200 and still carry an <Error> body.
      const text = data.toString("utf8");
      if (/<Error[\s>]/.test(text)) {
        const code = codeOf(text);
        if (code === "NoSuchVersion" || code === "NoSuchKey") throw gone(code);
        throw unavailable(code || "CopyFailed");
      }
      const newVersion = versionOf(headers);
      if (!newVersion) throw unavailable("NoVersionId");
      return { versionId: newVersion };
    },
    // Small objects (manifests): conditional create and current-version read.
    async putBytes(
      key,
      buffer,
      { ifNoneMatch = false, contentType = "application/octet-stream" } = {},
    ) {
      if (!validKey(key) || !Buffer.isBuffer(buffer))
        throw unavailable("BadKey");
      const { headers } = await call({
        method: "PUT",
        key,
        body: buffer,
        timeout: 30000,
        headers: {
          "content-type": contentType,
          ...(ifNoneMatch ? { "if-none-match": "*" } : {}),
          "x-amz-server-side-encryption": "AES256",
        },
      });
      return { versionId: versionOf(headers) };
    },
    async getBytes(key, maxBytes = 1024 * 1024) {
      if (!validKey(key)) throw unavailable("BadKey");
      const { data } = await call({
        method: "GET",
        key,
        timeout: 30000,
        maxBytes,
      });
      return data;
    },
    // Streams a local file with an explicit Content-Length and a signed
    // payload hash (sha256 hex of the file; computed here when not given).
    async putFile(
      key,
      path,
      {
        ifNoneMatch = false,
        sha256: known,
        contentType = "application/octet-stream",
        timeout = 300000,
      } = {},
    ) {
      if (!validKey(key)) throw unavailable("BadKey");
      if (known !== undefined && !SHA256_RE.test(known))
        throw unavailable("BadHash");
      let size, payloadHash;
      try {
        size = statSync(path).size;
        if (known) payloadHash = known;
        else {
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(path)) hash.update(chunk);
          payloadHash = hash.digest("hex");
        }
      } catch {
        throw unavailable("LocalFile");
      }
      const signed = sign({
        method: "PUT",
        key,
        payloadHash,
        headers: {
          "content-type": contentType,
          ...(ifNoneMatch ? { "if-none-match": "*" } : {}),
          "x-amz-server-side-encryption": "AES256",
        },
      });
      let sent = 0;
      const meter = new Transform({
        transform(chunk, _e, cb) {
          sent += chunk.length;
          cb(null, chunk);
        },
      });
      const result = await new Promise((resolve, reject) => {
        const req = httpsRequest(
          {
            hostname: host,
            port: 443,
            method: "PUT",
            path: `${encodePath(`/${key}`)}${signed.search}`,
            headers: { ...signed.headers, "content-length": String(size) },
          },
          (res) => {
            const parts = [];
            let got = 0;
            res.on("data", (chunk) => {
              got += chunk.length;
              if (got <= 65536) parts.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                headers: res.headers,
                text: Buffer.concat(parts).toString("utf8"),
              }),
            );
          },
        );
        req.setTimeout?.(timeout, () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        pipeline(
          createReadStream(path, { highWaterMark: 65536 }),
          meter,
          req,
        ).catch(reject);
      }).catch(() => {
        throw unavailable("Network");
      });
      if (result.status < 200 || result.status > 299) {
        const code = codeOf(result.text);
        throw unavailable(
          result.status === 412
            ? "PreconditionFailed"
            : code || `Http${result.status}`,
        );
      }
      if (sent !== size) throw unavailable("SizeChanged");
      const id = result.headers["x-amz-version-id"];
      return { versionId: validVersion(id) && id !== "null" ? id : null };
    },
    // Streams the current version to `path` (via `path.part`, renamed on
    // success). Refuses more than maxBytes; returns {bytes, sha256}.
    async getToFile(key, path, { maxBytes, timeout = 300000 } = {}) {
      if (!validKey(key) || !Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw unavailable("BadKey");
      const signed = sign({ method: "GET", key, payloadHash: sha256("") });
      const part = `${path}.part`;
      let response;
      try {
        response = await fetchImpl(
          `https://${host}${encodePath(`/${key}`)}${signed.search}`,
          {
            method: "GET",
            headers: signed.headers,
            redirect: "error",
            signal: AbortSignal.timeout(timeout),
          },
        );
      } catch {
        throw unavailable("Network");
      }
      if (!response.ok) {
        let text = "";
        try {
          text = (await readBody(response, 65536)).toString("utf8");
        } catch {
          // Only the status matters below.
        }
        const code = codeOf(text);
        if (code === "NoSuchKey" || code === "NoSuchVersion") throw gone(code);
        throw unavailable(code || `Http${response.status}`);
      }
      const header = response.headers.get("content-length");
      const declared = header === null ? null : Number(header);
      if (declared !== null && declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw unavailable("TooLarge");
      }
      const hash = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({
        transform(chunk, _e, cb) {
          bytes += chunk.length;
          if (bytes > maxBytes) return cb(new Error("TooLarge"));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        if (!response.body) throw new Error("Empty");
        await pipeline(
          Readable.fromWeb(response.body),
          meter,
          createWriteStream(part),
        );
        if (declared !== null && declared !== bytes)
          throw new Error("Truncated");
        await rename(part, path);
      } catch (error) {
        await unlink(part).catch(() => {});
        throw unavailable(
          error?.message === "TooLarge" ? "TooLarge" : "Network",
        );
      }
      return { bytes, sha256: hash.digest("hex") };
    },
    // Rewrites an object onto itself (resets the lifecycle clock). S3 insists
    // on MetadataDirective REPLACE for a self-copy, so content type and the
    // server-side encryption header are sent again.
    async copySelf(key, { contentType } = {}) {
      if (!validKey(key)) throw unavailable("BadKey");
      const type =
        contentType ??
        (key.endsWith(".json")
          ? "application/json"
          : "application/octet-stream");
      const { headers, data } = await call({
        method: "PUT",
        key,
        timeout: 60000,
        headers: {
          "x-amz-copy-source": `/${bucket}/${encodePath(key)}`,
          "x-amz-metadata-directive": "REPLACE",
          "content-type": type,
          "x-amz-server-side-encryption": "AES256",
        },
      });
      const text = data.toString("utf8");
      if (/<Error[\s>]/.test(text)) {
        const code = codeOf(text);
        if (code === "NoSuchKey") throw gone(code);
        throw unavailable(code || "CopyFailed");
      }
      return { versionId: versionOf(headers) };
    },
    async list(prefix, maxKeys = 1) {
      const { data } = await call({
        method: "GET",
        query: {
          "list-type": "2",
          prefix,
          "max-keys": String(maxKeys),
        },
      });
      const text = data.toString("utf8");
      if (!/<ListBucketResult[\s>]/.test(text)) throw unavailable("BadList");
      const objects = [
        ...text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g),
      ].map((m) => {
        const field = (tag) =>
          new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(m[1])?.[1] ?? "";
        return {
          key: unxml(field("Key")),
          size: Number(field("Size")) || 0,
          lastModified: field("LastModified"),
        };
      });
      return {
        keys: [...text.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]),
        objects,
        truncated: /<IsTruncated>true<\/IsTruncated>/.test(text),
      };
    },
  };
}
