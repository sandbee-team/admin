import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config } from "../backend/config.js";
import { HttpError } from "../backend/lib/errors.js";
import {
  ProviderError,
  request,
  urlFor,
} from "../backend/lib/provider-http.js";
import { allowedBlobUrl, createGitHub } from "../backend/lib/github.js";
import { createVercel } from "../backend/lib/vercel.js";
import { verifyToken } from "../backend/lib/cloudflare.js";
import { redact } from "../backend/lib/redact.js";
import {
  getText,
  guardedLookup,
  isPublicAddress,
  validPublicHost,
} from "../backend/lib/safe-https.js";
import {
  healthVerdict,
  probeLogin,
  waitHealthy,
} from "../backend/lib/pos-health.js";
import { can } from "../shared/policy.js";
import { READINESS_IDS, UI_STEPS, DEPLOY_STEPS } from "../shared/deploy.js";
import { assertNoSecrets, VAULT_KEY, AUTH_SECRET } from "./helpers.js";
import {
  BLD,
  BLOB_HOST,
  SHAS,
  SRC,
  createFakeGitHub,
  json,
} from "./fakes/github.js";
import { createFakeVercel } from "./fakes/vercel.js";
import { HTML, createFakeHealth } from "./fakes/health.js";

const TOKEN_A = `github_pat_${"A1b2C3d4E5".repeat(6)}`;
const TOKEN_B = `github_pat_${"Z9y8X7w6V5".repeat(6)}`;
const VERCEL_TOKEN = "vcp_SECRETVERCELTOKEN0123456789abcdef";
const SECRET_BODY = "SECRET-BODY-xyz-do-not-leak-0123456789";
const noSleep = async () => {};
const base = {
  NODE_ENV: "test",
  MONGODB_URI: "mongodb://127.0.0.1:27017/x",
  VAULT_KEY,
  AUTH_SECRET,
};
const FILES = {
  FILES_S3_REGION: "ap-south-1",
  FILES_S3_BUCKET: "sandbee-test-files",
  FILES_S3_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE0001",
  FILES_S3_SECRET_ACCESS_KEY: "fake-secret-access-key-0123456789",
};
// Every error property and the stack, checked for the given secrets.
const noLeak = (error, secrets) =>
  assertNoSecrets(
    {
      message: error.message,
      stack: String(error.stack),
      ...JSON.parse(JSON.stringify(error)),
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

describe("POS deploy config", () => {
  it("defaults: features off, cache follows file storage", () => {
    const off = config(base);
    assert.equal(off.POS_GITHUB_SOURCE_TOKEN, "");
    assert.equal(off.POS_GITHUB_BUILDER_TOKEN, "");
    assert.equal(off.POS_BUILDER_WORKFLOW, "build.yml");
    assert.equal(off.POS_BUILDER_REF, "main");
    assert.equal(off.POS_WORK_DIR, "/work");
    assert.equal(off.POS_BUILD_CACHE, "off");
    assert.equal(config({ ...base, ...FILES }).POS_BUILD_CACHE, "on");
    assert.equal(
      config({ ...base, ...FILES, POS_BUILD_CACHE: "off" }).POS_BUILD_CACHE,
      "off",
    );
  });
  it("accepts well-formed tokens and repos", () => {
    const c = config({
      ...base,
      POS_GITHUB_SOURCE_TOKEN: TOKEN_A,
      POS_GITHUB_BUILDER_TOKEN: TOKEN_B,
      POS_GITHUB_SOURCE_REPO: "acme/pos.source",
    });
    assert.equal(c.POS_GITHUB_SOURCE_TOKEN, TOKEN_A);
  });
  it("malformed values stop the boot and the error lists names only", () => {
    const secret = "github_pat_short-but-secret";
    const error = (() => {
      try {
        config({
          ...base,
          POS_GITHUB_SOURCE_TOKEN: secret,
          POS_GITHUB_BUILDER_TOKEN: "not-a-token-either",
          POS_GITHUB_SOURCE_REPO: "bad repo!",
          POS_BUILDER_REF: "..",
          POS_WORK_DIR: "relative/dir",
        });
      } catch (e) {
        return e;
      }
    })();
    assert.ok(error);
    for (const name of [
      "POS_GITHUB_SOURCE_TOKEN",
      "POS_GITHUB_BUILDER_TOKEN",
      "POS_GITHUB_SOURCE_REPO",
      "POS_BUILDER_REF",
      "POS_WORK_DIR",
    ])
      assert.match(error.message, new RegExp(name));
    for (const value of [secret, "not-a-token-either", "bad repo!"])
      assert.equal(error.message.includes(value), false);
  });
  it("POS_BUILD_CACHE=on without file storage, or any other value, is a boot error", () => {
    assert.throws(
      () => config({ ...base, POS_BUILD_CACHE: "on" }),
      /POS_BUILD_CACHE/,
    );
    assert.throws(
      () => config({ ...base, POS_BUILD_CACHE: "yes" }),
      /POS_BUILD_CACHE/,
    );
    assert.equal(
      config({ ...base, ...FILES, POS_BUILD_CACHE: "on" }).POS_BUILD_CACHE,
      "on",
    );
  });
  it("deploy is an owner-only permission", () => {
    assert.equal(can("owner", "deploy"), true);
    for (const role of ["admin", "operations", "viewer"])
      assert.equal(can(role, "deploy"), false);
  });
  it("shared deploy constants are consistent", () => {
    assert.ok(READINESS_IDS.includes("worker"));
    assert.equal(new Set(READINESS_IDS).size, READINESS_IDS.length);
    for (const ui of UI_STEPS)
      for (const step of ui.steps) assert.ok(DEPLOY_STEPS.includes(step));
  });
});

describe("provider-http", () => {
  const ok = () => json(200, { ok: true });
  it("builds URLs from fixed bases only", async () => {
    assert.equal(
      urlFor("github", "/repos/a/b").href,
      "https://api.github.com/repos/a/b",
    );
    assert.equal(
      urlFor("cloudflare", "/user/tokens/verify").href,
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
    );
    for (const provider of ["evil", "", undefined, "https://evil.test"])
      assert.throws(() => urlFor(provider, "/x"), ProviderError);
    for (const path of [
      "//evil.test/x",
      "https://evil.test/x",
      "/a/../b",
      "/a/./b",
      "/a?x=1",
      "/a#f",
      "/a@evil.test",
      "/%2e%2e/x",
      "/a%2Fb",
      "/a\\b",
      "/a\nb",
      "evil.test/x",
      "",
    ])
      assert.throws(() => urlFor("vercel", path), ProviderError, path);
    let called = 0;
    await rejects(
      request({
        provider: "github",
        path: "//evil.test/x",
        token: TOKEN_A,
        fetch: async () => (called++, ok()),
      }),
      (e) => assert.equal(e.code, "invalid"),
    );
    assert.equal(called, 0);
  });
  it("sends the token only as a bearer header and never follows redirects", async () => {
    let seen;
    await request({
      provider: "vercel",
      path: "/v2/user",
      token: VERCEL_TOKEN,
      query: { teamId: "team_a" },
      fetch: async (url, init) => ((seen = { url: String(url), init }), ok()),
    });
    assert.equal(seen.url, "https://api.vercel.com/v2/user?teamId=team_a");
    assert.equal(seen.init.redirect, "manual");
    assert.equal(seen.init.headers.authorization, `Bearer ${VERCEL_TOKEN}`);
    assert.equal(seen.url.includes(VERCEL_TOKEN), false);
  });
  it("rejects bad tokens before any network call", async () => {
    for (const token of ["", "short", "bad\r\nX-Evil: 1token", undefined]) {
      let called = 0;
      await rejects(
        request({
          provider: "github",
          path: "/x",
          token,
          fetch: async () => (called++, ok()),
        }),
        (e) => assert.equal(e.code, "invalid"),
      );
      assert.equal(called, 0);
    }
  });
  it("any 3xx is an error unless the caller asks to see it", async () => {
    let calls = 0;
    const redirect = async () => (
      calls++,
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/steal" },
      })
    );
    const error = await rejects(
      request({
        provider: "github",
        path: "/x",
        token: TOKEN_A,
        fetch: redirect,
      }),
      (e) => assert.equal(e.code, "redirect"),
    );
    assert.equal(calls, 1, "no retry, no follow");
    noLeak(error, ["evil.test", TOKEN_A]);
    const seen = await request({
      provider: "github",
      path: "/x",
      token: TOKEN_A,
      fetch: redirect,
      followRedirect: true,
    });
    assert.equal(seen.status, 302);
    assert.equal(seen.location, "https://evil.test/steal");
  });
  it("caps response bodies at 2 MB (and honours a larger explicit cap)", async () => {
    const big = () =>
      new Response(JSON.stringify({ pad: "x".repeat(3 * 1024 * 1024) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await rejects(
      request({ provider: "github", path: "/x", token: TOKEN_A, fetch: big }),
      (e) => assert.equal(e.code, "too-large"),
    );
    const done = await request({
      provider: "github",
      path: "/x",
      token: TOKEN_A,
      fetch: big,
      maxBytes: 4 * 1024 * 1024,
    });
    assert.equal(done.json.pad.length, 3 * 1024 * 1024);
  });
  it("an unreadable 2xx body is bad-response", async () => {
    await rejects(
      request({
        provider: "github",
        path: "/x",
        token: TOKEN_A,
        fetch: async () =>
          new Response("{not json" + SECRET_BODY, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
      (e) => {
        assert.equal(e.code, "bad-response");
        noLeak(e, [SECRET_BODY, TOKEN_A]);
      },
    );
  });
  it("maps statuses to codes and never leaks bodies, tokens or URLs", async () => {
    const cases = [
      [401, {}, "unauthorized"],
      [403, {}, "forbidden"],
      [403, { "x-ratelimit-remaining": "0" }, "rate-limited"],
      [404, {}, "not-found"],
      [409, {}, "conflict"],
      [422, {}, "invalid"],
      [429, {}, "rate-limited"],
      [418, {}, "rejected"],
      [500, {}, "unavailable"],
      [503, {}, "unavailable"],
    ];
    for (const [status, headers, code] of cases) {
      const error = await rejects(
        request({
          provider: "vercel",
          path: "/v2/user",
          token: VERCEL_TOKEN,
          fetch: async () =>
            new Response(
              JSON.stringify({
                message: SECRET_BODY,
                uri: "mongodb://u:p@h/x",
              }),
              {
                status,
                headers: { "content-type": "application/json", ...headers },
              },
            ),
          sleep: noSleep,
          retryDelays: [],
        }),
      );
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, code, String(status));
      assert.equal(error.status, status);
      assert.equal(error.message, `Vercel request failed (${code})`);
      noLeak(error, [
        SECRET_BODY,
        VERCEL_TOKEN,
        "mongodb://u:p@h/x",
        "api.vercel.com",
      ]);
    }
  });
  it("keeps a provider error code only when it is a short snake_case token", async () => {
    const withCode = (code) =>
      request({
        provider: "vercel",
        path: "/x",
        token: VERCEL_TOKEN,
        fetch: async () => json(400, { error: { code, message: SECRET_BODY } }),
      });
    assert.equal(
      (await rejects(withCode("project_not_ready"))).providerCode,
      "project_not_ready",
    );
    for (const hostile of ["Bad <b>", SECRET_BODY, "x".repeat(50), 42])
      assert.equal((await rejects(withCode(hostile))).providerCode, "");
  });
  it("retries idempotent calls on 429/5xx, honouring Retry-After", async () => {
    const sleeps = [];
    let n = 0;
    const flaky = async () => {
      n++;
      if (n === 1) return json(429, {}, { "retry-after": "7" });
      if (n === 2) return json(503, {});
      return json(200, { done: true });
    };
    const result = await request({
      provider: "github",
      path: "/x",
      token: TOKEN_A,
      fetch: flaky,
      sleep: async (ms) => sleeps.push(ms),
    });
    assert.deepEqual(result.json, { done: true });
    assert.equal(n, 3);
    assert.equal(sleeps[0], 7000, "Retry-After beats the 2 s backoff");
    assert.equal(sleeps[1], 5000);
  });
  it("does not wait for an excessive Retry-After and does not retry non-idempotent calls", async () => {
    let n = 0;
    const slow = await rejects(
      request({
        provider: "github",
        path: "/x",
        token: TOKEN_A,
        fetch: async () => (n++, json(429, {}, { "retry-after": "120" })),
        sleep: async () => assert.fail("must not sleep"),
      }),
    );
    assert.equal(slow.code, "rate-limited");
    assert.equal(slow.retryAfterMs, 120000);
    assert.equal(n, 1);
    n = 0;
    await rejects(
      request({
        provider: "github",
        path: "/x",
        method: "POST",
        body: {},
        token: TOKEN_A,
        fetch: async () => (n++, json(503, {})),
        sleep: async () => assert.fail("must not sleep"),
      }),
      (e) => assert.equal(e.code, "unavailable"),
    );
    assert.equal(n, 1);
  });
  it("gives up after three retries", async () => {
    let n = 0;
    await rejects(
      request({
        provider: "github",
        path: "/x",
        token: TOKEN_A,
        fetch: async () => (n++, json(502, {})),
        sleep: noSleep,
      }),
      (e) => assert.equal(e.code, "unavailable"),
    );
    assert.equal(n, 4);
  });
  it("times out and honours the job signal", async () => {
    // AbortSignal.timeout timers are unref'd; a real socket keeps the loop alive.
    const keepAlive = setInterval(() => {}, 20);
    const hang = (url, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => {
          clearInterval(keepAlive);
          reject(init.signal.reason);
        }),
      );
    await rejects(
      request({
        provider: "github",
        path: "/x",
        token: TOKEN_A,
        fetch: hang,
        timeoutMs: 20,
        retryDelays: [],
      }),
      (e) => assert.equal(e.code, "timeout"),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await rejects(
      request({
        provider: "github",
        path: "/x",
        token: TOKEN_A,
        fetch: hang,
        timeoutMs: 5000,
        signal: controller.signal,
      }),
      (e) => assert.equal(e.code, "aborted"),
    );
  });
  it("a network failure is a retryable network error without detail", async () => {
    const error = await rejects(
      request({
        provider: "cloudflare",
        path: "/x",
        token: TOKEN_A,
        fetch: async () => {
          throw new TypeError(`connect ECONNREFUSED ${TOKEN_A}`);
        },
        retryDelays: [],
      }),
    );
    assert.equal(error.code, "network");
    assert.equal(error.retryable, true);
    noLeak(error, [TOKEN_A]);
  });
});

describe("GitHub adapter", () => {
  const make = (fake, extra = {}) =>
    createGitHub({
      sourceRepo: SRC,
      sourceToken: TOKEN_A,
      builderRepo: BLD,
      builderToken: TOKEN_B,
      workflow: "build.yml",
      ref: "main",
      fetch: fake.fetch,
      sleep: noSleep,
      ...extra,
    });
  const tmp = () => mkdtemp(join(tmpdir(), "s2-gh-"));
  it("lists branches (name, sha, headline, date) newest first, without e-mails", async () => {
    const fake = createFakeGitHub();
    const gh = make(fake);
    const list = await gh.branches();
    assert.deepEqual(
      list.map((b) => [b.name, b.sha, b.headline]),
      [
        ["feature/x", SHAS.b, "Feature work"],
        ["main", SHAS.a, "Main headline"],
      ],
    );
    assert.equal(JSON.stringify(list).includes("dev@example.test"), false);
    const head = await gh.branchHead("feature/x");
    assert.deepEqual(head, {
      name: "feature/x",
      sha: SHAS.b,
      headline: "Feature work",
      date: "2026-10-05T10:00:00Z",
    });
    assert.ok(
      fake.calls.some((c) => c.path === `/repos/${SRC}/branches/feature/x`),
    );
    const commit = await gh.commit(SHAS.a);
    assert.deepEqual(Object.keys(commit).sort(), [
      "authorName",
      "date",
      "headline",
      "sha",
    ]);
    assert.equal(commit.authorName, "Dev Person");
  });
  it("compare returns status and ahead/behind", async () => {
    const fake = createFakeGitHub();
    fake.state.compare = { status: "diverged", ahead_by: 3, behind_by: 1 };
    assert.deepEqual(await make(fake).compare(SHAS.a, SHAS.b), {
      status: "diverged",
      aheadBy: 3,
      behindBy: 1,
    });
    fake.state.compare = { status: "weird" };
    await rejects(make(fake).compare(SHAS.a, SHAS.b), (e) =>
      assert.equal(e.code, "bad-response"),
    );
  });
  it("validates branch names and shas before any request", async () => {
    const fake = createFakeGitHub();
    const gh = make(fake);
    for (const name of [
      "-x",
      "a..b",
      "a b",
      "/a",
      "a/",
      "a//b",
      "",
      "a?x=1",
      "x".repeat(201),
    ])
      await rejects(gh.branchHead(name), (e) =>
        assert.equal(e.code, "invalid"),
      );
    await rejects(gh.commit("abc"), (e) => assert.equal(e.code, "invalid"));
    await rejects(gh.compare(SHAS.a, "zz"), (e) =>
      assert.equal(e.code, "invalid"),
    );
    assert.equal(fake.calls.length, 0);
  });
  it("uses the source token for source calls and the builder token for builder calls", async () => {
    const fake = createFakeGitHub();
    const gh = make(fake);
    await gh.branchHead("main");
    await gh.builderHead();
    const byPath = (p) => fake.calls.find((c) => c.path.startsWith(p));
    assert.equal(byPath(`/repos/${SRC}/`).token, TOKEN_A);
    assert.equal(byPath(`/repos/${BLD}/`).token, TOKEN_B);
  });
  it("is 'not-configured' (503) without the relevant token", async () => {
    const fake = createFakeGitHub();
    const gh = make(fake, { builderToken: "", sourceToken: "" });
    for (const call of [
      () => gh.branches(),
      () => gh.dispatch({ buildId: "abcdefgh12", inputs: {} }),
      () => gh.builderHead(),
    ]) {
      const error = await rejects(Promise.resolve().then(call));
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.apiCode, "not-configured");
    }
    assert.equal(fake.calls.length, 0);
  });
  it("dispatch uses return_run_details and takes the run id from the response", async () => {
    const fake = createFakeGitHub();
    const out = await make(fake).dispatch({
      buildId: "req-0001-abcd",
      inputs: { request_id: "req-0001-abcd", sha: SHAS.a },
    });
    assert.deepEqual(out, {
      runId: 5001,
      htmlUrl: `https://github.com/${BLD}/actions/runs/5001`,
      via: "response",
    });
    const call = fake.calls.find((c) => c.method === "POST");
    assert.equal(call.body.return_run_details, true);
    assert.equal(call.body.ref, "main");
    assert.equal(
      call.path,
      `/repos/${BLD}/actions/workflows/build.yml/dispatches`,
    );
    assert.equal(call.token, TOKEN_B);
  });
  it("dispatch falls back to the run-name when the response has no run id", async () => {
    const fake = createFakeGitHub();
    fake.state.dispatchMode = "204";
    const out = await make(fake).dispatch({
      buildId: "req-0002-abcd",
      inputs: { request_id: "req-0002-abcd" },
    });
    assert.equal(out.via, "search");
    assert.equal(out.runId, 5001);
    const runs = fake.calls.find((c) => c.path.endsWith("/runs"));
    assert.equal(runs.query.event, "workflow_dispatch");
    assert.match(runs.query.created, /^>=\d{4}-/);
  });
  it("dispatch reports no run (without throwing) when the run never shows up", async () => {
    const fake = createFakeGitHub();
    fake.state.dispatchMode = "204-invisible";
    const out = await make(fake).dispatch({
      buildId: "req-0003-abcd",
      inputs: { request_id: "req-0003-abcd" },
    });
    assert.deepEqual(out, { runId: null, htmlUrl: null, via: "none" });
  });
  it("dispatch is never retried and refuses malformed inputs", async () => {
    const fake = createFakeGitHub();
    fake.rule(
      (m, p) => m === "POST",
      () => json(502, {}),
      { times: -1 },
    );
    await rejects(
      make(fake).dispatch({
        buildId: "req-0004-abcd",
        inputs: { request_id: "x" },
      }),
      (e) => assert.equal(e.code, "unavailable"),
    );
    assert.equal(fake.calls.filter((c) => c.method === "POST").length, 1);
    const gh = make(createFakeGitHub());
    await rejects(gh.dispatch({ buildId: "x", inputs: {} }), (e) =>
      assert.equal(e.code, "invalid"),
    );
    await rejects(
      gh.dispatch({ buildId: "req-0005-abcd", inputs: { A: "1" } }),
      (e) => assert.equal(e.code, "invalid"),
    );
    await rejects(
      gh.dispatch({ buildId: "req-0005-abcd", inputs: { a: 1 } }),
      (e) => assert.equal(e.code, "invalid"),
    );
    await rejects(
      gh.dispatch({
        buildId: "req-0005-abcd",
        inputs: Object.fromEntries(
          Array.from({ length: 26 }, (_, i) => [
            `k_${"a".repeat(i % 5)}${String.fromCharCode(97 + i)}`,
            "v",
          ]),
        ),
      }),
      (e) => assert.equal(e.code, "invalid"),
    );
  });
  it("reads run status, failed step, artifacts and cancels", async () => {
    const fake = createFakeGitHub();
    const gh = make(fake);
    const { runId } = await gh.dispatch({
      buildId: "req-0006-abcd",
      inputs: { request_id: "req-0006-abcd" },
    });
    const run = fake.state.runs.get(runId);
    run.status = "in_progress";
    assert.deepEqual(
      (({ status, conclusion, runAttempt, htmlUrl }) => ({
        status,
        conclusion,
        runAttempt,
        htmlUrl,
      }))(await gh.run(runId)),
      {
        status: "in_progress",
        conclusion: null,
        runAttempt: 1,
        htmlUrl: `https://github.com/${BLD}/actions/runs/${runId}`,
      },
    );
    assert.equal(await gh.cancelRun(runId), true);
    run.status = "completed";
    run.conclusion = "failure";
    run.jobs = [
      {
        steps: [
          { name: "Checkout", conclusion: "success" },
          { name: "Scan output", conclusion: "failure" },
        ],
      },
    ];
    assert.equal(await gh.failedStepName(runId), "Scan output");
    assert.equal(await gh.cancelRun(runId), false, "already finished");
    fake.addArtifact({ id: 77, runId, body: Buffer.from("zip-bytes") });
    const [artifact] = await gh.listArtifacts(runId);
    assert.equal(artifact.id, 77);
    assert.match(artifact.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(await gh.deleteArtifact(77), true);
    assert.equal(await gh.deleteArtifact(77), true, "already gone");
  });
  it("downloads an artifact to a file: no credentials on the blob request, digest verified", async () => {
    const dir = await tmp();
    try {
      const fake = createFakeGitHub();
      const body = Buffer.from("PK-fake-zip-".repeat(5000));
      fake.addArtifact({ id: 9, runId: 1, body });
      const out = await make(fake).downloadArtifact(9, join(dir, "a.zip"), {
        maxBytes: 1e6,
      });
      assert.equal(out.sha256, createHash("sha256").update(body).digest("hex"));
      assert.deepEqual(await readFile(join(dir, "a.zip")), body);
      assert.deepEqual(await readdir(dir), ["a.zip"]);
      assert.equal(fake.state.blobCalls.length, 1);
      assert.equal(fake.state.blobCalls[0].host, BLOB_HOST);
      assert.equal(fake.state.blobCalls[0].headers.authorization, undefined);
      assert.equal(fake.state.blobCalls[0].redirect, "error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("refuses a redirect to a host that is not allowed (nothing is fetched)", async () => {
    const dir = await tmp();
    try {
      for (const location of [
        "https://files.evil.test/x",
        "http://abcd.blob.core.windows.net/x",
        "https://evilblob.core.windows.net/x",
        "https://blob.core.windows.net/x",
        "https://user:pw@abcd.blob.core.windows.net/x",
        "https://abcd.blob.core.windows.net:8443/x",
        "https://127.0.0.1/x",
        "not a url",
      ]) {
        const fake = createFakeGitHub();
        fake.addArtifact({ id: 9, runId: 1, body: Buffer.from("zipzip") });
        fake.state.blobLocation = location;
        const error = await rejects(
          make(fake).downloadArtifact(9, join(dir, "b.zip"), { maxBytes: 1e6 }),
          (e) => assert.equal(e.code, "redirect-host", location),
        );
        assert.equal(fake.state.blobCalls.length, 0, location);
        noLeak(error, ["evil.test", "SECRETSIG", TOKEN_B]);
      }
      assert.deepEqual(await readdir(dir), []);
      assert.ok(allowedBlobUrl("https://x.actions.githubusercontent.com/y"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("a digest mismatch, oversize, missing digest, expiry or stall leaves no file", async () => {
    const dir = await tmp();
    try {
      const body = Buffer.from("payload".repeat(2000));
      const run = async (setup, options = {}) => {
        const fake = createFakeGitHub();
        setup(fake);
        return rejects(
          make(fake).downloadArtifact(9, join(dir, "c.zip"), {
            maxBytes: 1e6,
            ...options,
          }),
        );
      };
      let e = await run((f) =>
        f.addArtifact({
          id: 9,
          runId: 1,
          body,
          digest: `sha256:${"0".repeat(64)}`,
        }),
      );
      assert.equal(e.code, "digest-mismatch");
      e = await run((f) => f.addArtifact({ id: 9, runId: 1, body }), {
        maxBytes: 100,
      });
      assert.equal(e.code, "too-large");
      e = await run((f) => {
        f.addArtifact({ id: 9, runId: 1, body });
        f.state.artifacts.get(9).meta.digest = null;
      });
      assert.equal(e.code, "no-digest");
      e = await run((f) =>
        f.addArtifact({ id: 9, runId: 1, body, expired: true }),
      );
      assert.equal(e.code, "expired");
      e = await run(
        (f) => {
          f.addArtifact({ id: 9, runId: 1, body });
          f.state.blobBody = () =>
            new Response(new ReadableStream({ start() {} }), { status: 200 });
        },
        { stallMs: 30 },
      );
      assert.equal(e.code, "stalled");
      e = await run((f) => {
        f.addArtifact({ id: 9, runId: 1, body });
        f.state.blobStatus = 403;
        f.state.blobBody = body;
      });
      assert.equal(e.code, "blob-failed");
      assert.deepEqual(
        await readdir(dir),
        [],
        "no file and no .part left behind",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("reads the builder head and builder.json at an exact commit", async () => {
    const fake = createFakeGitHub();
    const gh = make(fake);
    assert.deepEqual(await gh.builderHead(), { ref: "main", sha: SHAS.c });
    assert.deepEqual(await gh.builderFile(SHAS.c), {
      protocol: 1,
      nodeVersion: "22.11.0",
      cliVersion: "39.1.0",
    });
    assert.equal(fake.calls.at(-1).query.ref, SHAS.c);
    await rejects(gh.builderFile("main"), (e) =>
      assert.equal(e.code, "invalid"),
    );
    await rejects(gh.builderFile(SHAS.c, "../x"), (e) =>
      assert.equal(e.code, "invalid"),
    );
  });
  it("provider errors from GitHub carry no body or token", async () => {
    const fake = createFakeGitHub();
    fake.rule(
      (m, p) => p.includes("/branches"),
      () => json(500, { message: SECRET_BODY }),
      { times: -1 },
    );
    const error = await rejects(make(fake).branches());
    assert.equal(error.code, "unavailable");
    noLeak(error, [SECRET_BODY, TOKEN_A, TOKEN_B]);
  });
});

describe("Vercel adapter", () => {
  const make = (fake, extra = {}) =>
    createVercel({
      token: VERCEL_TOKEN,
      fetch: fake.fetch,
      sleep: async () => {},
      ...extra,
    });
  it("returns whitelisted user and project fields only", async () => {
    const fake = createFakeVercel();
    const vc = make(fake);
    assert.deepEqual(await vc.user(), {
      id: "u1",
      username: "owner",
      defaultTeamId: null,
    });
    const project = await vc.project("prj_test1");
    assert.equal(project.rootDirectory, "apps/cafe");
    assert.equal(project.productionDeploymentId, "dpl_live");
    assert.deepEqual(project.lastAliasRequest, {
      toDeploymentId: "dpl_live",
      jobStatus: "succeeded",
      type: "promote",
    });
    assert.equal(JSON.stringify(project).includes("secretExtra"), false);
    await rejects(vc.project("prj_missing"), (e) =>
      assert.equal(e.code, "not-found"),
    );
    await rejects(vc.project("../x"), (e) => assert.equal(e.code, "invalid"));
  });
  it("environment: plain values only, never decrypted", async () => {
    const fake = createFakeVercel();
    const envs = await make(fake).projectEnv("prj_test1");
    assert.deepEqual(envs.find((e) => e.key === "TENANT_ID").value, "demo");
    assert.equal(envs.find((e) => e.key === "MONGODB_URI").value, null);
    assert.equal(JSON.stringify(envs).includes("ENCRYPTEDBLOB"), false);
    assert.equal(fake.calls.at(-1).query.decrypt, undefined);
  });
  it("scopes calls to a team with teamId", async () => {
    const fake = createFakeVercel({ teamId: "team_abc" });
    await make(fake, { teamId: "team_abc" }).user();
    assert.equal(fake.calls[0].query.teamId, "team_abc");
    await rejects(make(fake).user(), (e) => assert.equal(e.code, "forbidden"));
    assert.throws(() => make(fake, { teamId: "bad id" }));
  });
  it("findDeploymentByMeta lists, matches locally and retries until the deployment shows", async () => {
    const fake = createFakeVercel();
    fake.state.hiddenPolls = 2;
    fake.state.deployments = [
      {
        uid: "dpl_other",
        url: "o.vercel.app",
        state: "READY",
        meta: { sandbeeRequest: "req-x" },
      },
      {
        uid: "dpl_1",
        url: "demo-abc.vercel.app",
        state: "BUILDING",
        target: "production",
        meta: { sandbeeRequest: "req-1", junk: { nested: 1 } },
      },
    ];
    const sleeps = [];
    const found = await make(fake, {
      sleep: async (ms) => sleeps.push(ms),
    }).findDeploymentByMeta("prj_test1", "sandbeeRequest", "req-1", {
      delayMs: 1234,
    });
    assert.equal(found.id, "dpl_1");
    assert.equal(found.url, "demo-abc.vercel.app");
    assert.deepEqual(found.meta, { sandbeeRequest: "req-1" });
    assert.equal(
      fake.calls.filter((c) => c.path === "/v6/deployments").length,
      3,
    );
    assert.deepEqual(sleeps, [1234, 1234]);
    const none = await make(fake).findDeploymentByMeta(
      "prj_test1",
      "sandbeeRequest",
      "req-nope",
      { attempts: 2 },
    );
    assert.equal(none, null);
    await rejects(
      make(fake).findDeploymentByMeta("prj_test1", "bad key", "v"),
      (e) => assert.equal(e.code, "invalid"),
    );
    await rejects(make(fake).findDeploymentByMeta("prj_test1", "k", ""), (e) =>
      assert.equal(e.code, "invalid"),
    );
  });
  it("deployment(), promote(), rollback() and deleteDeployment()", async () => {
    const fake = createFakeVercel();
    fake.state.deployments = [
      {
        uid: "dpl_1",
        url: "demo-abc.vercel.app",
        state: "READY",
        target: "production",
        meta: {},
      },
    ];
    const vc = make(fake);
    const d = await vc.deployment("dpl_1");
    assert.equal(d.readyState, "READY");
    assert.equal(JSON.stringify(d).includes("private@example.test"), false);
    assert.equal((await vc.deployment("demo-abc.vercel.app")).id, "dpl_1");
    await rejects(vc.deployment("evil/../x"), (e) =>
      assert.equal(e.code, "invalid"),
    );
    assert.deepEqual(await vc.promote("prj_test1", "dpl_1"), { status: 201 });
    assert.deepEqual(await vc.rollback("prj_test1", "dpl_1"), { status: 201 });
    assert.ok(
      fake.calls.some(
        (c) =>
          c.method === "POST" &&
          c.path === "/v10/projects/prj_test1/promote/dpl_1",
      ),
    );
    assert.ok(
      fake.calls.some(
        (c) =>
          c.method === "POST" &&
          c.path === "/v1/projects/prj_test1/rollback/dpl_1",
      ),
    );
    assert.equal(await vc.deleteDeployment("dpl_1"), true);
    assert.equal(await vc.deleteDeployment("dpl_gone"), true);
  });
  it("a refused rollback surfaces as a coded error without the body", async () => {
    const fake = createFakeVercel();
    fake.rule(
      (m, p) => p.includes("/rollback/"),
      () => json(403, { error: { code: "forbidden", message: SECRET_BODY } }),
    );
    const error = await rejects(make(fake).rollback("prj_test1", "dpl_1"));
    assert.equal(error.code, "forbidden");
    noLeak(error, [SECRET_BODY, VERCEL_TOKEN]);
  });
  it("listDeployments follows pagination up to the cap", async () => {
    const fake = createFakeVercel();
    const mk = (n) =>
      Array.from({ length: n }, (_, i) => ({
        uid: `dpl_${i}`,
        url: `u${i}.vercel.app`,
        state: "READY",
        meta: {},
      }));
    fake.state.pages = [
      { deployments: mk(3), next: 111 },
      { after: 111, deployments: mk(3), next: 222 },
      { after: 222, deployments: mk(3) },
    ];
    assert.equal(
      (await make(fake).listDeployments("prj_test1", { limit: 3 })).length,
      9,
    );
    assert.equal(
      (await make(fake).listDeployments("prj_test1", { limit: 3, max: 5 }))
        .length,
      5,
    );
  });
});

describe("Cloudflare token verify", () => {
  const fetchOf = (routes) => async (url) => {
    const path = new URL(url).pathname;
    const r = routes[path];
    return r ? json(r[0], r[1]) : json(404, {});
  };
  const ACCOUNT = "a".repeat(32);
  it("verifies user and account tokens", async () => {
    const active = { success: true, result: { status: "active" } };
    assert.deepEqual(
      await verifyToken(TOKEN_A, "", {
        fetch: fetchOf({ "/client/v4/user/tokens/verify": [200, active] }),
      }),
      { ok: true, form: "user" },
    );
    const account = await verifyToken(TOKEN_A, ACCOUNT, {
      fetch: fetchOf({
        "/client/v4/user/tokens/verify": [401, {}],
        [`/client/v4/accounts/${ACCOUNT}/tokens/verify`]: [200, active],
      }),
    });
    assert.deepEqual(account, { ok: true, form: "account" });
  });
  it("is not ok for disabled or rejected tokens and refuses a bad account id", async () => {
    assert.deepEqual(
      await verifyToken(TOKEN_A, "", {
        fetch: fetchOf({
          "/client/v4/user/tokens/verify": [
            200,
            { success: true, result: { status: "disabled" } },
          ],
        }),
      }),
      { ok: false, form: null },
    );
    assert.deepEqual(
      await verifyToken(TOKEN_A, ACCOUNT, {
        fetch: fetchOf({
          "/client/v4/user/tokens/verify": [401, {}],
          [`/client/v4/accounts/${ACCOUNT}/tokens/verify`]: [403, {}],
        }),
      }),
      { ok: false, form: null },
    );
    await rejects(verifyToken(TOKEN_A, "../x", { fetch: fetchOf({}) }), (e) =>
      assert.equal(e.code, "invalid"),
    );
    const down = await rejects(
      verifyToken(TOKEN_A, "", {
        fetch: fetchOf({
          "/client/v4/user/tokens/verify": [500, { x: SECRET_BODY }],
        }),
        sleep: noSleep,
      }),
    );
    noLeak(down, [SECRET_BODY, TOKEN_A]);
  });
});

describe("redact", () => {
  it("removes known secrets in several encodings and well-known shapes", () => {
    const secret = 'p@ss "word"/+=secret';
    const text = [
      `plain ${secret}`,
      `url ${encodeURIComponent(secret)}`,
      `json ${JSON.stringify(secret).slice(1, -1)}`,
      `b64 ${Buffer.from(secret).toString("base64")}`,
      `tok ${TOKEN_A} ${VERCEL_TOKEN} ghp_${"a".repeat(36)}`,
      "uri mongodb+srv://user:pw@cluster.example.test/db?x=1 end",
      "Authorization: Bearer abcdefghijklmnop",
      "key AKIAABCDEFGHIJKLMNOP end",
      `long ${"Qz1".repeat(20)}`,
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redact(text, [secret], 2000);
    for (const leak of [
      secret,
      encodeURIComponent(secret),
      TOKEN_A,
      VERCEL_TOKEN,
      "user:pw",
      "abcdefghijklmnop",
      "AKIAABCDEFGHIJKLMNOP",
      "Qz1Qz1Qz1",
      "MIIEvQ",
      "ghp_",
    ])
      assert.equal(out.includes(leak), false, leak);
    assert.match(out, /\[redacted\]/);
  });
  it("strips control characters and caps the length", () => {
    const out = redact(`a\u0000b\u001b[31m\n\tc ${"word ".repeat(100)}`);
    assert.equal(/[\u0000-\u001f]/.test(out), false);
    assert.ok(out.length <= 160);
    assert.equal(redact(undefined), "");
    assert.equal(
      redact("short", ["abc"]),
      "short",
      "secrets under 4 chars are ignored",
    );
  });
});

describe("safe-https", () => {
  it("accepts public DNS names only", () => {
    for (const ok of [
      "pos.example.com",
      "a-b.example.co.in",
      "demo.sandbee.in",
    ])
      assert.equal(validPublicHost(ok), true, ok);
    for (const bad of [
      "localhost",
      "127.0.0.1",
      "10.0.0.1",
      "[::1]",
      "example",
      "example.123",
      "a..b.com",
      "-a.example.com",
      "ex ample.com",
      "pos.example.com:8443",
      "pos.example.com/x",
      "",
      null,
      "a".repeat(254) + ".com",
    ])
      assert.equal(validPublicHost(bad), false, String(bad));
  });
  it("classifies addresses: loopback, private, link-local, CGNAT, ULA and mapped forms are refused", () => {
    const refused = [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.5",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:a9fe:a9fe",
      "64:ff9b::7f00:1",
      "64:ff9b:1::1",
      "2001:db8::1",
      "2002:7f00:1::1",
      "2001::1",
      "::127.0.0.1",
      "fe80::1%eth0",
      "not an ip",
      "1.2.3",
      "300.1.1.1",
    ];
    for (const a of refused) assert.equal(isPublicAddress(a), false, a);
    const allowed = [
      "8.8.8.8",
      "1.1.1.1",
      "100.63.255.255",
      "100.128.0.1",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "198.20.0.1",
      "2606:4700:4700::1111",
      "2a00:1450:4009::200e",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
    ];
    for (const a of allowed) assert.equal(isPublicAddress(a), true, a);
  });
  it("the guarded lookup refuses a name that resolves to a loopback address", async () => {
    const error = await new Promise((resolve) =>
      guardedLookup("localhost", {}, (e) => resolve(e)),
    );
    assert.ok(error, "localhost must not resolve to a usable address");
    const all = await new Promise((resolve) =>
      guardedLookup("localhost", { all: true }, (e) => resolve(e)),
    );
    assert.ok(all);
  });
  it("getText validates host and path and hands the guarded lookup to the transport", async () => {
    let seen;
    const send = async (options) => (
      (seen = options),
      { status: 200, headers: {}, text: "x" }
    );
    await getText("pos.example.com", "/api/health", { send });
    assert.equal(seen.lookup, guardedLookup);
    assert.equal(seen.port, 443);
    assert.equal(seen.hostname, "pos.example.com");
    for (const host of ["127.0.0.1", "localhost", "evil.com:81"])
      await rejects(getText(host, "/api/health", { send }), (e) =>
        assert.equal(e.code, "bad-host"),
      );
    for (const path of [
      "api/health",
      "/a b",
      "/a?x=1",
      "//evil.test",
      "/a\r\nHost: x",
    ])
      await rejects(getText("pos.example.com", path, { send }), (e) =>
        assert.equal(e.code, "bad-path"),
      );
  });
});

describe("pos-health", () => {
  const good = { status: 200, body: { ok: true, db: "up", tenant: "demo" } };
  const page = { status: 200, text: HTML };
  it("healthVerdict matches the go-live console", () => {
    assert.equal(
      healthVerdict(200, { ok: true, db: "up", tenant: "sunrise" }, "sunrise")
        .ok,
      true,
    );
    assert.match(
      healthVerdict(
        503,
        { ok: false, db: "down", tenant: "sunrise" },
        "sunrise",
      ).reason,
      /Atlas Network Access/,
    );
    assert.match(
      healthVerdict(200, { ok: true, db: "up", tenant: "dev" }, "sunrise")
        .reason,
      /disagree/,
    );
    assert.match(healthVerdict(404, null, "sunrise").reason, /HTTP 404/);
    assert.equal(
      healthVerdict(200, { ok: false, db: "up", tenant: "x" }, "x").reason,
      "unexpected health body",
    );
    assert.equal(
      healthVerdict(200, { ok: true, db: "down", tenant: "x" }, "x").reason,
      "unexpected health body",
    );
    assert.equal(
      healthVerdict(200, null, "x").reason,
      "unexpected health body",
    );
  });
  it("a hostile tenant label is not echoed", () => {
    const v = healthVerdict(
      200,
      { ok: true, db: "up", tenant: "<script>alert(1)</script>" },
      "demo",
    );
    assert.equal(v.ok, false);
    assert.equal(v.reason.includes("<script>"), false);
  });
  it("passes only when health is ok for the tenant and /login is HTML", async () => {
    const fake = createFakeHealth({ health: [good], login: [page] });
    const out = await waitHealthy({
      host: "demo.example.com",
      tenantId: "demo",
      get: fake.get,
      sleep: noSleep,
    });
    assert.deepEqual(out, {
      ok: true,
      phase: "login",
      reason: "ok",
      attempts: 1,
    });
    assert.deepEqual(
      fake.calls.map((c) => c.path),
      ["/api/health", "/login"],
    );
  });
  it("retries health, then reports the last reason", async () => {
    const sleeps = [];
    const fake = createFakeHealth({
      health: [
        { status: 503, body: { ok: false, db: "down" } },
        { status: 502 },
        good,
      ],
      login: [page],
    });
    const ok = await waitHealthy({
      host: "demo.example.com",
      tenantId: "demo",
      get: fake.get,
      sleep: async (ms) => sleeps.push(ms),
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(sleeps, [5000, 5000]);
    const never = createFakeHealth({
      health: [{ status: 404 }],
      login: [page],
    });
    const out = await waitHealthy({
      host: "demo.example.com",
      tenantId: "demo",
      attempts: 3,
      get: never.get,
      sleep: noSleep,
    });
    assert.deepEqual(
      [out.ok, out.phase, out.reason, out.attempts],
      [false, "health", "HTTP 404", 3],
    );
    assert.equal(
      never.calls.every((c) => c.path === "/api/health"),
      true,
      "login is not probed until health passes",
    );
  });
  it("tenant mismatch fails in the health phase", async () => {
    const fake = createFakeHealth({
      health: [{ status: 200, body: { ok: true, db: "up", tenant: "other" } }],
      login: [page],
    });
    const out = await waitHealthy({
      host: "demo.example.com",
      tenantId: "demo",
      attempts: 2,
      get: fake.get,
      sleep: noSleep,
    });
    assert.equal(out.ok, false);
    assert.equal(out.phase, "health");
    assert.match(out.reason, /disagree/);
  });
  it("login probe failure (middleware 404, non-HTML, error) fails the go-live", async () => {
    for (const [login, reason] of [
      [{ status: 404, text: "nf" }, /login page HTTP 404/],
      [
        {
          status: 200,
          headers: { "content-type": "application/json" },
          text: "{}",
        },
        /not HTML/,
      ],
      [{ status: 200, text: "plain text" }, /not HTML/],
      [{ status: 307 }, /HTTP 307/],
    ]) {
      const fake = createFakeHealth({ health: [good], login: [login] });
      const out = await waitHealthy({
        host: "demo.example.com",
        tenantId: "demo",
        get: fake.get,
        sleep: noSleep,
      });
      assert.equal(out.ok, false);
      assert.equal(out.phase, "login");
      assert.match(out.reason, reason);
      assert.equal(fake.calls.filter((c) => c.path === "/login").length, 3);
    }
    const flaky = createFakeHealth({
      health: [good],
      login: [{ status: 404 }, page],
    });
    assert.equal(
      (
        await waitHealthy({
          host: "demo.example.com",
          tenantId: "demo",
          get: flaky.get,
          sleep: noSleep,
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await probeLogin({
          host: "demo.example.com",
          get: createFakeHealth({ login: [new Error("x")] }).get,
        })
      ).ok,
      false,
    );
  });
  it("refuses unsafe hosts without any request and reports network failures plainly", async () => {
    for (const host of [
      "127.0.0.1",
      "localhost",
      "demo.example.com:8080",
      "169.254.169.254",
    ]) {
      const fake = createFakeHealth({ health: [good], login: [page] });
      const out = await waitHealthy({
        host,
        tenantId: "demo",
        attempts: 1,
        get: fake.get,
        sleep: noSleep,
      });
      assert.equal(out.ok, false);
      assert.equal(out.reason, "invalid host");
      assert.equal(fake.calls.length, 0);
    }
    const down = createFakeHealth({
      health: [Object.assign(new Error("secret detail"), { code: "network" })],
    });
    const out = await waitHealthy({
      host: "demo.example.com",
      tenantId: "demo",
      attempts: 1,
      get: down.get,
      sleep: noSleep,
    });
    assert.equal(out.reason, "no response (network)");
    assert.equal(JSON.stringify(out).includes("secret detail"), false);
  });
  it("stops when the job signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = createFakeHealth({ health: [good] });
    const out = await waitHealthy({
      host: "demo.example.com",
      tenantId: "demo",
      get: fake.get,
      sleep: noSleep,
      signal: controller.signal,
    });
    assert.equal(out.reason, "aborted");
    assert.equal(fake.calls.length, 0);
  });
});
