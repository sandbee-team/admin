import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startApp,
  assertNoSecrets,
  VAULT_KEY,
  BACKUP_KEY,
  AUTH_SECRET,
} from "./helpers.js";
import { config, backupKeyInfo } from "../backend/config.js";
import { keyFingerprint } from "../backend/lib/crypto.js";
import { verifyVaultKey } from "../backend/lib/vault.js";
import { verifyKey, drillState } from "../backend/lib/recovery-tasks.js";

const OTHER_KEY = "c".repeat(64);
const DAY = 86400000;
let ctx, owner;
const deps = () => ({ db: ctx.db, client: ctx.client });
const checks = () =>
  ctx.db.collection("recovery_checks").find({ type: "key-check" }).toArray();
const events = (action) =>
  ctx.db.collection("audit_events").find({ action }).toArray();
function runCli(args, { input, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["scripts/recovery.js", "verify-key", ...args],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          MONGODB_URI: ctx.repl.getUri(),
          MONGODB_DB: "admin_test",
          VAULT_KEY,
          AUTH_SECRET,
          ...env,
        },
      },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input ?? "");
  });
}

describe("key fingerprints", () => {
  it("is stable, distinct per key and never a slice of the key", () => {
    const a = keyFingerprint(VAULT_KEY);
    assert.equal(keyFingerprint(VAULT_KEY), a);
    assert.notEqual(keyFingerprint(OTHER_KEY), a);
    assert.match(a, /^[a-f0-9]{4}(-[a-f0-9]{4}){3}$/);
    for (const key of [VAULT_KEY, OTHER_KEY, "0123456789abcdef".repeat(4)]) {
      const fp = keyFingerprint(key).replaceAll("-", "");
      for (let i = 0; i + 16 <= key.length; i++)
        assert.notEqual(key.slice(i, i + 16), fp);
    }
  });
});

describe("drill status thresholds", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const ago = (days) =>
    new Date(Date.parse("2026-10-09") - days * DAY).toISOString().slice(0, 10);
  for (const [days, state] of [
    [0, "green"],
    [100, "green"],
    [101, "amber"],
    [190, "amber"],
    [191, "red"],
  ])
    it(`${days} days is ${state}`, () =>
      assert.equal(drillState(ago(days), now).state, state));
  it("no drill is red", () => {
    const none = drillState(undefined, now);
    assert.equal(none.state, "red");
    assert.equal(none.lastDrill, null);
  });
});

describe("BACKUP_KEY handling", () => {
  const env = {
    NODE_ENV: "test",
    MONGODB_URI: "mongodb://127.0.0.1:1/x",
    VAULT_KEY,
    AUTH_SECRET,
  };
  it("a malformed BACKUP_KEY never stops config and reads as invalid", () => {
    const c = config({ ...env, BACKUP_KEY: "not-a-key" });
    assert.equal(backupKeyInfo(c, "no-such-file.txt").state, "invalid");
    assert.equal(backupKeyInfo(c, "no-such-file.txt").key, "");
  });
  it("reports missing, configured and file-based keys", () => {
    assert.equal(
      backupKeyInfo(config(env), "no-such-file.txt").state,
      "missing",
    );
    assert.equal(
      backupKeyInfo(config({ ...env, BACKUP_KEY }), "no-such-file.txt").state,
      "configured",
    );
    const dir = mkdtempSync(join(tmpdir(), "bk-"));
    try {
      writeFileSync(join(dir, "k.txt"), `${BACKUP_KEY}\n`);
      const info = backupKeyInfo(config(env), join(dir, "k.txt"));
      assert.deepEqual(info, { state: "configured", key: BACKUP_KEY });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("verify-key and the Recovery page", () => {
  before(async () => {
    ctx = await startApp({ dbName: "admin_test" });
    await verifyVaultKey(ctx.db, VAULT_KEY);
    owner = await ctx.login("owner@example.test");
  });
  after(async () => ctx?.stop());
  beforeEach(async () => {
    await ctx.db.collection("recovery_checks").deleteMany({});
    await ctx.db.collection("audit_events").deleteMany({
      action: { $in: ["recovery.key-verified", "recovery.key-mismatch"] },
    });
    ctx.c.BACKUP_KEY = "";
  });

  it("a vault match writes one check row and one audit event", async () => {
    const result = await verifyKey(deps(), {
      kind: "vault",
      copy: "password-manager",
      key: VAULT_KEY.toUpperCase(),
    });
    assert.equal(result.match, true);
    const rows = await checks();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].keyKind, "vault");
    assert.equal(rows[0].copy, "password-manager");
    assert.equal(rows[0].result, "match");
    assert.equal(rows[0].fingerprint, keyFingerprint(VAULT_KEY));
    const [event] = await events("recovery.key-verified");
    assert.equal(event.actorId, "system");
    assert.equal(event.detail, "vault key, password-manager copy");
    assertNoSecrets([rows, event], [VAULT_KEY]);
  });

  it("a vault mismatch writes no check row and is audited", async () => {
    const result = await verifyKey(deps(), {
      kind: "vault",
      copy: "offline",
      key: OTHER_KEY,
    });
    assert.equal(result.match, false);
    assert.equal((await checks()).length, 0);
    assert.equal((await events("recovery.key-mismatch")).length, 1);
    assert.equal((await events("recovery.key-verified")).length, 0);
  });

  it("rejects malformed keys, kinds and copies without echoing input", async () => {
    for (const key of ["short", "z".repeat(64), "", undefined])
      await assert.rejects(
        verifyKey(deps(), { kind: "vault", copy: "server", key }),
        (error) => {
          assert.match(error.message, /64 hexadecimal/);
          assert.equal(error.message.includes("short"), false);
          return true;
        },
      );
    await assert.rejects(
      verifyKey(deps(), { kind: "x", copy: "server", key: VAULT_KEY }),
      /vault or backup/,
    );
    await assert.rejects(
      verifyKey(deps(), { kind: "vault", copy: "x", key: VAULT_KEY }),
      /Copy must be/,
    );
    assert.equal((await checks()).length, 0);
  });

  it("backup kind: missing, invalid and configured BACKUP_KEY", async () => {
    await assert.rejects(
      verifyKey(deps(), { kind: "backup", copy: "offline", key: BACKUP_KEY }),
      /No valid BACKUP_KEY/,
    );
    await assert.rejects(
      verifyKey(deps(), {
        kind: "backup",
        copy: "offline",
        key: BACKUP_KEY,
        backupKey: "garbage",
      }),
      /No valid BACKUP_KEY/,
    );
    const wrong = await verifyKey(deps(), {
      kind: "backup",
      copy: "offline",
      key: OTHER_KEY,
      backupKey: BACKUP_KEY,
    });
    assert.equal(wrong.match, false);
    assert.equal((await checks()).length, 0);
    const right = await verifyKey(deps(), {
      kind: "backup",
      copy: "offline",
      key: BACKUP_KEY,
      backupKey: BACKUP_KEY,
    });
    assert.equal(right.match, true);
    assert.equal((await checks()).length, 1);
  });

  it("the real CLI: piped stdin match, mismatch, bad format, --key= rejected", async () => {
    const good = await runCli(["--kind=vault", "--copy=offline"], {
      input: `${VAULT_KEY}\n`,
    });
    assert.equal(good.code, 0, good.out);
    assert.match(good.out, /MATCH/);
    assert.match(good.out, new RegExp(keyFingerprint(VAULT_KEY)));
    assert.equal((await checks()).length, 1);
    assert.equal(good.out.includes(VAULT_KEY), false);

    const env = await runCli(["--kind=vault", "--copy=server", "--from-env"]);
    assert.equal(env.code, 0, env.out);
    assert.equal((await checks()).length, 2);

    const bad = await runCli(["--kind=vault", "--copy=offline"], {
      input: `${OTHER_KEY}\n`,
    });
    assert.equal(bad.code, 1);
    assert.match(bad.out, /MISMATCH/);
    assert.equal(bad.out.includes(OTHER_KEY), false);
    assert.equal((await checks()).length, 2);

    const junk = await runCli(["--kind=vault", "--copy=offline"], {
      input: "my-secret-typo\n",
    });
    assert.notEqual(junk.code, 0);
    assert.match(junk.out, /64-character hexadecimal/);
    assert.equal(junk.out.includes("my-secret-typo"), false);

    const arg = await runCli(
      ["--kind=vault", "--copy=offline", `--key=${VAULT_KEY}`],
      { input: `${VAULT_KEY}\n` },
    );
    assert.notEqual(arg.code, 0);
    assert.match(arg.out, /Never pass a key as an argument/);
    assert.equal(arg.out.includes(VAULT_KEY), false);
    assert.equal((await checks()).length, 2);

    const plain = await runCli(["--kind=vault", "--copy=offline", VAULT_KEY], {
      input: `${VAULT_KEY}
`,
    });
    assert.notEqual(plain.code, 0);
    assert.match(plain.out, /Never pass a key as an argument/);
    assert.equal(plain.out.includes(VAULT_KEY), false);

    const wrongCopy = await runCli([
      "--kind=vault",
      "--copy=offline",
      "--from-env",
    ]);
    assert.notEqual(wrongCopy.code, 0);
    assert.match(wrongCopy.out, /--from-env is only for --copy=server/);
    assert.equal((await checks()).length, 2);
    assert.match(
      bad.out,
      /No verification was recorded; the attempt was audited/,
    );

    const backup = await runCli(["--kind=backup", "--copy=offline"], {
      input: `${BACKUP_KEY}\n`,
      env: { BACKUP_KEY },
    });
    assert.equal(backup.code, 0, backup.out);
    assert.equal((await checks()).length, 3);
  });

  it("GET /recovery splits drills from checks and shows fingerprints only", async () => {
    const empty = await ctx.request("/recovery", { session: owner });
    assert.equal(empty.status, 200);
    assert.equal(empty.data.keys.vault.fingerprint, keyFingerprint(VAULT_KEY));
    assert.equal(empty.data.keys.backup.state, "missing");
    assert.equal(empty.data.keys.backup.fingerprint, null);
    assert.equal(empty.data.keyChecks.vault["password-manager"], null);
    assert.equal(empty.data.drillStatus.state, "red");
    assert.equal(empty.data.drillStatus.lastDrill, null);

    ctx.c.BACKUP_KEY = BACKUP_KEY;
    const old = new Date(Date.now() - 5 * DAY);
    await ctx.db.collection("recovery_checks").insertOne({
      _id: "old-check",
      type: "key-check",
      keyKind: "vault",
      copy: "offline",
      fingerprint: keyFingerprint(VAULT_KEY),
      result: "match",
      createdAt: old,
    });
    await verifyKey(deps(), { kind: "vault", copy: "offline", key: VAULT_KEY });
    await ctx.db.collection("recovery_checks").insertOne({
      _id: "drill-1",
      type: "operator-attestation",
      location: "scratch machine",
      sourceRevision: "dump-1",
      restoredAt: new Date(Date.now() - 100 * DAY).toISOString().slice(0, 10),
      notes: "restored and logged in fine",
      keyStoredSeparately: true,
      recordedBy: "owner",
      createdAt: new Date(),
    });
    const full = await ctx.request("/recovery", { session: owner });
    assert.deepEqual(
      full.data.rows.map((row) => row._id),
      ["drill-1"],
    );
    assert.equal(full.data.keys.backup.state, "configured");
    assert.equal(full.data.keys.backup.fingerprint, keyFingerprint(BACKUP_KEY));
    const offline = full.data.keyChecks.vault.offline;
    assert.ok(new Date(offline.at) > old, "latest check wins");
    assert.equal(offline.current, true);
    assert.equal(full.data.keyChecks.vault.server, null);
    assert.equal(full.data.keyChecks.backup.offline, null);
    assert.equal(full.data.drillStatus.state, "green");
    assert.equal(full.data.drillStatus.daysSince, 100);
    assertNoSecrets(full.data, [VAULT_KEY, BACKUP_KEY]);

    ctx.c.BACKUP_KEY = "not-hex-at-all";
    const bad = await ctx.request("/recovery", { session: owner });
    assert.equal(bad.data.keys.backup.state, "invalid");
    assertNoSecrets(bad.data, [VAULT_KEY, BACKUP_KEY, "not-hex-at-all"]);
  });

  it("key-check rows are excluded from /overview latestRecovery", async () => {
    await ctx.db.collection("recovery_checks").insertOne({
      _id: "drill-old",
      type: "operator-attestation",
      restoredAt: "2026-01-01",
      createdAt: new Date(Date.now() - 10 * DAY),
    });
    await verifyKey(deps(), { kind: "vault", copy: "server", key: VAULT_KEY });
    const overview = await ctx.request("/overview", { session: owner });
    assert.equal(overview.data.latestRecovery._id, "drill-old");
    assertNoSecrets(overview.data, [VAULT_KEY, BACKUP_KEY]);
  });

  it("only owners can read recovery status", async () => {
    for (const email of ["admin", "operations", "viewer"]) {
      const session = await ctx.login(`${email}@example.test`);
      assert.equal((await ctx.request("/recovery", { session })).status, 403);
    }
  });
});
