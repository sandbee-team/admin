import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  CODE_RE,
  ERROR_CODES,
  describeCode,
  isKnownCode,
} from "../shared/deploy-errors.js";
import { DEPLOY_STEPS } from "../shared/deploy.js";
import { JobFail } from "../backend/worker/lease.js";
import { AcceptError } from "../backend/worker/artifact.js";

const dir = "backend/worker";
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".js"))
  .map((f) => [f, readFileSync(`${dir}/${f}`, "utf8")]);
const NOT_CODES = new Set([
  ...DEPLOY_STEPS,
  "failed",
  "running",
  "succeeded",
  "done",
  "list",
  "task",
  "collecting",
  "write-failed",
]);

describe("error code table", () => {
  it("every entry is well formed", () => {
    for (const [code, e] of Object.entries(ERROR_CODES)) {
      assert.match(code, CODE_RE);
      assert.ok(e.title && e.plainMessage && e.action && e.step, code);
      assert.ok(e.plainMessage.length <= 160, code);
    }
    assert.equal(describeCode("nope").title, ERROR_CODES.internal.title);
  });
  it("every code the worker can emit exists in the table (static scan)", () => {
    const found = new Set();
    for (const [, text] of sources) {
      for (const m of text.matchAll(
        /\b(?:JobFail|AcceptError|fail|bad)\(\s*(?=[^)\s])([\s\S]{0,200})/g,
      ))
      // The code literal(s) come first; the fixed message (with spaces) ends them.
      {
        // The first literal is the code; a ternary adds the one after ":".
        const first =
          /^[^"]{0,160}?"([a-z0-9]+(?:-[a-z0-9]+)*)"(\s*:\s*"([a-z0-9]+(?:-[a-z0-9]+)*)")?/.exec(
            m[1],
          );
        if (first) {
          found.add(first[1]);
          if (first[3]) found.add(first[3]);
        }
      }
      for (const m of text.matchAll(/\bcode:\s*"([a-z0-9-]+)"/g))
        found.add(m[1]);
    }
    const missing = [...found].filter(
      (c) => !NOT_CODES.has(c) && !isKnownCode(c),
    );
    assert.deepEqual(missing, []);
    assert.ok(found.size > 40, "the scan found the codes");
  });
  it("the generated families are covered (provider, CLI, cache, project, env)", () => {
    for (const p of ["github", "vercel", "cloudflare"])
      for (const c of [
        "unauthorized",
        "forbidden",
        "not-found",
        "rate-limited",
        "unavailable",
        "timeout",
        "network",
        "rejected",
        "digest-mismatch",
        "failed",
      ])
        assert.ok(isKnownCode(`${p}-${c}`), `${p}-${c}`);
    for (const c of [
      "rootdir-missing",
      "settings-mismatch",
      "no-prebuilt-output",
      "framework-missing",
      "auth-invalid-token",
      "rate-limited",
      "network-error",
      "upload-error",
      "timeout",
      "spawn-failed",
      "other",
    ])
      assert.ok(isKnownCode(`cli-${c}`), c);
    for (const c of [
      "seal-failed",
      "output-mismatch",
      "bad-info",
      "contested",
      "bad-input",
      "object-missing",
      "bad-size",
      "bad-object-hash",
      "bad-magic",
      "bad-key",
      "bad-tag",
      "bad-output",
      "bad-mac",
      "unclean-scan",
    ])
      assert.ok(isKnownCode(`cache-${c}`), c);
    for (const c of ["settings", "not-found", "unauthorized"])
      assert.ok(isKnownCode(`project-${c === "settings" ? "invalid" : c}`));
    assert.ok(isKnownCode("env-drift") && isKnownCode("env-forbidden"));
  });
  it("the worker refuses free-text codes", () => {
    assert.throws(() => new JobFail("made up code", "x"));
    assert.throws(() => new AcceptError("not-in-table"));
    assert.doesNotThrow(() => new JobFail("frozen", "x"));
  });
});
