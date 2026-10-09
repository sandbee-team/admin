import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { signRequest, createS3, encodeRfc3986 } from "../backend/lib/s3.js";
import { config } from "../backend/config.js";
import { createFakeS3, FAKE } from "./fake-s3.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// AWS documentation example credentials (public, not real).
const AWS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  host: "examplebucket.s3.amazonaws.com",
  date: new Date("2013-05-24T00:00:00Z"),
};

describe("SigV4 signer against the AWS S3 documentation examples", () => {
  it("GET Object with a Range header", () => {
    const signed = signRequest({
      ...AWS,
      method: "GET",
      path: "/test.txt",
      headers: { range: "bytes=0-9" },
      payloadHash: sha256(""),
    });
    assert.equal(
      signed.canonicalRequest,
      [
        "GET",
        "/test.txt",
        "",
        "host:examplebucket.s3.amazonaws.com",
        "range:bytes=0-9",
        "x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date:20130524T000000Z",
        "",
        "host;range;x-amz-content-sha256;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
    assert.equal(
      signed.stringToSign,
      [
        "AWS4-HMAC-SHA256",
        "20130524T000000Z",
        "20130524/us-east-1/s3/aws4_request",
        "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
      ].join("\n"),
    );
    assert.equal(
      signed.signature,
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    assert.equal(
      signed.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
  it("PUT Object (path with $, extra signed headers, payload hash)", () => {
    const payload = "Welcome to Amazon S3.";
    const signed = signRequest({
      ...AWS,
      method: "PUT",
      path: "/test$file.text",
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash: sha256(payload),
    });
    assert.equal(
      sha256(payload),
      "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    );
    assert.equal(
      signed.signedHeaders,
      "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class",
    );
    assert.equal(
      signed.signature,
      "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });
  it("encodes per RFC 3986 and sorts query parameters", () => {
    assert.equal(
      encodeRfc3986("a b!'()*~-._/+="),
      "a%20b%21%27%28%29%2A~-._%2F%2B%3D",
    );
    const signed = signRequest({
      ...AWS,
      method: "GET",
      path: "/",
      query: { versionId: "a+b/c=", "list-type": "2", prefix: "files/" },
      payloadHash: sha256(""),
    });
    assert.equal(
      signed.canonicalQuery,
      "list-type=2&prefix=files%2F&versionId=a%2Bb%2Fc%3D",
    );
  });
});

describe("S3 client", () => {
  const key = "files/cid/fid";
  it("round-trips put/get/list/delete with a versioned bucket", async () => {
    const fake = createFakeS3(),
      s3 = fake.client();
    const { versionId } = await s3.put(key, Buffer.from("hello"));
    assert.match(versionId, /^ver-/);
    assert.equal((await s3.get(key, versionId, 100)).toString(), "hello");
    assert.deepEqual((await s3.list("files/", 1)).keys, [key]);
    await s3.del(key);
    assert.deepEqual((await s3.list("files/", 1)).keys, []);
    // The version survives the delete marker and can still be read by id.
    assert.equal((await s3.get(key, versionId, 100)).toString(), "hello");
  });
  it("encodes versionId and copy source with RFC 3986", async () => {
    const seen = [];
    const version = "3/L4kq+tJ=lcp.x_y-z~";
    const s3 = createS3({
      ...FAKE,
      fetch: async (url, init) => {
        seen.push({ url, headers: init.headers, init });
        const copy = Boolean(init.headers["x-amz-copy-source"]);
        return new Response(copy ? "<CopyObjectResult/>" : "ok", {
          status: 200,
          headers: { "x-amz-version-id": version },
        });
      },
    });
    const put = await s3.put(key, Buffer.from("x"));
    assert.equal(put.versionId, version);
    await s3.get(key, version, 10);
    await s3.copy(key, version);
    const encoded = "3%2FL4kq%2BtJ%3Dlcp.x_y-z~";
    assert.ok(seen[1].url.endsWith(`?versionId=${encoded}`));
    assert.ok(
      seen[2].headers["x-amz-copy-source"].endsWith(`?versionId=${encoded}`),
    );
    assert.equal(
      seen[2].headers["x-amz-copy-source"].startsWith(
        `/${FAKE.bucket}/files/cid/fid?`,
      ),
      true,
    );
    for (const call of seen) {
      assert.equal(call.init.redirect, "error");
      assert.ok(call.init.signal instanceof AbortSignal);
    }
    // Writes request SSE and refuse to overwrite.
    assert.equal(seen[0].headers["x-amz-server-side-encryption"], "AES256");
    assert.equal(seen[0].headers["if-none-match"], "*");
  });
  it("rejects a PUT answered without a version id and cleans up", async () => {
    const fake = createFakeS3({ versioning: false }),
      s3 = fake.client();
    await assert.rejects(s3.put(key, Buffer.from("x")), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.s3Code, "NoVersionId");
      assert.equal(error.message, "File storage is unavailable.");
      return true;
    });
    assert.deepEqual(fake.liveKeys(), []);
    assert.ok(fake.calls.some((call) => call.op === "delete"));
  });
  it("CopyObject returns the NEW version and parses a 200 <Error> body", async () => {
    const fake = createFakeS3(),
      s3 = fake.client();
    const first = await s3.put(key, Buffer.from("data"));
    await s3.del(key);
    const copied = await s3.copy(key, first.versionId);
    assert.notEqual(copied.versionId, first.versionId);
    assert.equal((await s3.get(key, copied.versionId, 100)).toString(), "data");
    fake.okWith(
      "copy",
      "<Error><Code>InternalError</Code><Message>secret detail</Message></Error>",
    );
    await assert.rejects(s3.copy(key, first.versionId), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.s3Code, "InternalError");
      assert.equal(
        JSON.stringify(error.message).includes("secret detail"),
        false,
      );
      return true;
    });
    fake.okWith("copy", "<Error><Code>NoSuchVersion</Code></Error>");
    await assert.rejects(
      s3.copy(key, first.versionId),
      (e) => e.status === 410,
    );
  });
  it("maps errors without leaking bodies; NoSuchVersion is 410", async () => {
    const fake = createFakeS3(),
      s3 = fake.client();
    fake.fail("put", { status: 403, code: "AccessDenied" });
    await assert.rejects(s3.put(key, Buffer.from("x")), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.message, "File storage is unavailable.");
      assert.equal(error.s3Code, "AccessDenied");
      return true;
    });
    await assert.rejects(
      s3.get(key, "nope", 10),
      (error) => error.status === 410,
    );
    fake.fail("get", { throwNetwork: true });
    await assert.rejects(s3.get(key, "nope", 10), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.s3Code, "Network");
      return true;
    });
  });
  it("caps the size of a downloaded object", async () => {
    const fake = createFakeS3(),
      s3 = fake.client();
    const { versionId } = await s3.put(key, Buffer.alloc(100));
    await assert.rejects(s3.get(key, versionId, 50), (e) => e.status === 503);
  });
  it("signs with the configured region and rejects bad settings", async () => {
    const fake = createFakeS3();
    const wrong = fake.client({
      secretAccessKey: "another-secret-key-0123456789",
    });
    await assert.rejects(
      wrong.put(key, Buffer.from("x")),
      (e) => e.s3Code === "SignatureDoesNotMatch",
    );
    assert.throws(() => createS3({ ...FAKE, bucket: "my.dotted.bucket" }));
    assert.throws(() => createS3({ ...FAKE, bucket: "UPPER" }));
    assert.throws(() => createS3({ ...FAKE, region: "mars" }));
  });
});

describe("file storage configuration", () => {
  const base = {
    NODE_ENV: "test",
    MONGODB_URI: "mongodb://localhost:27017/x",
    VAULT_KEY: "a".repeat(64),
    AUTH_SECRET: "c".repeat(64),
  };
  const full = {
    FILES_S3_BUCKET: "sandbee-test-files",
    FILES_S3_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE0001",
    FILES_S3_SECRET_ACCESS_KEY: "fake-secret-access-key-0123456789",
  };
  it("all unset disables files", () => {
    assert.equal(config(base).FILES_S3_BUCKET, "");
  });
  it("defaults the region to ap-south-1", () => {
    assert.equal(config({ ...base, ...full }).FILES_S3_REGION, "ap-south-1");
  });
  it("a partial set stops boot and names only the variables", () => {
    for (const [drop, names] of [
      ["FILES_S3_BUCKET", "FILES_S3_BUCKET"],
      ["FILES_S3_ACCESS_KEY_ID", "FILES_S3_ACCESS_KEY_ID"],
      ["FILES_S3_SECRET_ACCESS_KEY", "FILES_S3_SECRET_ACCESS_KEY"],
    ]) {
      const env = { ...base, ...full };
      delete env[drop];
      assert.throws(
        () => config(env),
        (error) => {
          assert.ok(error.message.includes(names));
          assert.equal(
            error.message.includes(full.FILES_S3_SECRET_ACCESS_KEY),
            false,
          );
          assert.equal(
            error.message.includes(full.FILES_S3_ACCESS_KEY_ID),
            false,
          );
          return true;
        },
      );
    }
    assert.throws(
      () => config({ ...base, FILES_S3_REGION: "ap-south-1" }),
      /FILES_S3_BUCKET/,
    );
  });
  it("rejects malformed values without echoing them", () => {
    for (const [name, value] of [
      ["FILES_S3_BUCKET", "has.dots.in.it"],
      ["FILES_S3_REGION", "nowhere"],
      ["FILES_S3_ACCESS_KEY_ID", "lowercase-key-id-0000"],
      ["FILES_S3_SECRET_ACCESS_KEY", "short"],
    ])
      assert.throws(
        () => config({ ...base, ...full, [name]: value }),
        (error) =>
          error.message.includes(name) && !error.message.includes(value),
      );
  });
});
