import { createHash, createHmac } from "node:crypto";
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
      return {
        keys: [...text.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]),
      };
    },
  };
}
