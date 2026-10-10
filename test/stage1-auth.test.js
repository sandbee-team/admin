import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  startApp,
  assertNoSecrets,
  PASSWORD,
  VAULT_KEY,
  AUTH_SECRET,
  BACKUP_KEY,
  clearOfWindow,
} from "./helpers.js";
import {
  base32Encode,
  base32Decode,
  codeAt,
  verify,
  stepAt,
  otpauthUri,
  parseKeyInput,
} from "../backend/lib/totp.js";
import { qrSvg } from "../backend/lib/qr.js";
import { audit } from "../backend/lib/audit.js";
import { authModule } from "../backend/modules/auth.js";
import { resetTotp } from "../backend/lib/recovery-tasks.js";
import { secretBoxes } from "../backend/lib/secrets.js";
import { makeSnapshot, parseSnapshot } from "../backend/lib/snapshot.js";
import { encrypt, hashPassword, digest } from "../backend/lib/crypto.js";
import { can } from "../shared/policy.js";
const ascii = (text) => Buffer.from(text);
describe("RFC 6238 TOTP primitives", () => {
  // Appendix B vectors (8 digits): the SHA1 key is 20 bytes, SHA256 32, SHA512 64.
  const sha1 = ascii("12345678901234567890");
  const sha256 = ascii("12345678901234567890123456789012");
  const sha512 = ascii(
    "1234567890123456789012345678901234567890123456789012345678901234",
  );
  const vectors = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  for (const [time, one, two, five] of vectors)
    it(`matches the Appendix B vectors at T=${time}`, () => {
      const step = stepAt(time * 1000);
      assert.equal(codeAt(sha1, step, { digits: 8 }), one);
      assert.equal(
        codeAt(sha256, step, { algorithm: "sha256", digits: 8 }),
        two,
      );
      assert.equal(
        codeAt(sha512, step, { algorithm: "sha512", digits: 8 }),
        five,
      );
    });
  it("accepts one step of drift and rejects two", () => {
    const key = sha1,
      now = 1700000000000,
      step = stepAt(now);
    assert.equal(verify(key, codeAt(key, step), now), step);
    assert.equal(verify(key, codeAt(key, step - 1), now), step - 1);
    assert.equal(verify(key, codeAt(key, step + 1), now), step + 1);
    assert.equal(verify(key, codeAt(key, step - 2), now), null);
    assert.equal(verify(key, codeAt(key, step + 2), now), null);
  });
  it("rejects malformed codes without throwing", () => {
    const now = 1700000000000;
    for (const bad of [
      "",
      "12345",
      "1234567",
      "abcdef",
      "12 345",
      null,
      123456,
    ])
      assert.equal(verify(sha1, bad, now), null);
  });
  it("encodes base32 per RFC 4648 and tolerates spacing and case", () => {
    assert.equal(base32Encode(ascii("foobar")), "MZXW6YTBOI");
    assert.equal(base32Decode("mzxw 6ytb-oi").toString(), "foobar");
    assert.throws(() => base32Decode("not*base32"), /Invalid base32/);
    assert.throws(() => base32Decode(""));
  });
  it("parses bare keys and otpauth URIs and rejects unsafe input", () => {
    const key = sha1,
      b32 = base32Encode(key);
    assert.deepEqual(parseKeyInput(b32).key, key);
    assert.deepEqual(parseKeyInput(b32).params, {
      algorithm: "sha1",
      digits: 6,
      period: 30,
    });
    const parsed = parseKeyInput(
      `otpauth://totp/Acme:me?secret=${b32}&algorithm=SHA256&digits=8&period=60`,
    );
    assert.deepEqual(parsed.params, {
      algorithm: "sha256",
      digits: 8,
      period: 60,
    });
    assert.throws(() => parseKeyInput(`otpauth://hotp/x?secret=${b32}`));
    assert.throws(() =>
      parseKeyInput(`otpauth://totp/x?secret=${b32}&digits=7`),
    );
    assert.throws(() => parseKeyInput("AAAA"));
    const uri = otpauthUri(key, "a@b.test", "Sandbee Admin");
    assert.match(uri, /^otpauth:\/\/totp\/Sandbee%20Admin%3Aa%40b\.test\?/);
    assert.ok(uri.includes(`secret=${b32}`));
  });
  it("renders a server-side SVG QR code", () => {
    const svg = qrSvg("otpauth://totp/x?secret=ABCDEFGH");
    assert.match(svg, /^<svg[\s>]/);
    assert.equal(svg.includes("<script"), false);
  });
  it("grants the secrets permission to the owner only", () => {
    assert.equal(can("owner", "secrets"), true);
    for (const role of ["admin", "operations", "viewer"])
      assert.equal(can(role, "secrets"), false);
  });
});
describe("TOTP enrolment, login, step-up and recovery", () => {
  let ctx, hash, request;
  const added = [];
  async function addStaff(role = "admin") {
    const email = `u${added.length}-${randomUUID().slice(0, 6)}@example.test`;
    added.push(email);
    await ctx.db.collection("staff").insertOne({
      _id: randomUUID(),
      email,
      name: `staff ${added.length}`,
      role,
      status: "active",
      authVersion: 1,
      revision: 1,
      passwordHash: hash,
      createdAt: new Date(),
    });
    return email;
  }
  const row = (email) => ctx.db.collection("staff").findOne({ email });
  const now = () => stepAt(Date.now());
  const post = (path, body, session) =>
    request(path, { method: "POST", body, session });
  async function enrol(role = "admin") {
    const email = await addStaff(role),
      session = await ctx.login(email);
    const start = await post("/auth/totp/enrol/start", {}, session);
    assert.equal(start.status, 200, JSON.stringify(start.data));
    const key = base32Decode(start.data.secret);
    const confirm = await post(
      "/auth/totp/enrol/confirm",
      { code: codeAt(key, now()) },
      session,
    );
    assert.equal(confirm.status, 200, JSON.stringify(confirm.data));
    return { email, session, key, codes: confirm.data.backupCodes, start };
  }
  // The replay guard allows one code per step, so tests reset it to take a
  // fresh code; the replay tests themselves never reset it.
  async function fresh(who, offset = 0) {
    await ctx.db
      .collection("staff")
      .updateOne({ email: who.email }, { $set: { "totp.lastStep": 0 } });
    return codeAt(who.key, now() + offset);
  }
  async function totpLogin(email, factor) {
    const first = await ctx.loginStart(email);
    assert.equal(first.status, 200);
    assert.equal(first.data.totpRequired, true);
    return post("/auth/verify-totp", {
      challengeId: first.data.challengeId,
      ...factor,
    });
  }
  const stepUp = (who, body) => post("/auth/step-up", body, who.session);
  before(async () => {
    ctx = await startApp({ dbName: "stage1_auth" });
    request = ctx.request;
    hash = await hashPassword(PASSWORD);
  });
  beforeEach(async () => {
    await ctx.db.collection("rate_limits").deleteMany({});
  });
  after(async () => ctx?.stop());
  it("starts enrolment with a no-store QR payload", async () => {
    assert.equal((await post("/auth/totp/enrol/start", {})).status, 401);
    const email = await addStaff(),
      session = await ctx.login(email);
    const start = await post("/auth/totp/enrol/start", {}, session);
    assert.equal(start.status, 200);
    assert.match(start.headers.get("cache-control"), /no-store/);
    assert.match(start.data.secret, /^[A-Z2-7]{32}$/);
    assert.ok(start.data.uri.includes(`secret=${start.data.secret}`));
    assert.match(start.data.qrSvg, /^<svg/);
    const stored = await row(email);
    assert.equal(JSON.stringify(stored).includes(start.data.secret), false);
    assert.ok(stored.totpPending.expiresAt > new Date());
    assert.equal(stored.totp, undefined);
    // Not enabled yet: nothing changes for login.
    assert.equal((await ctx.loginStart(email)).data.totpRequired, undefined);
  });
  it("rejects enrolment from a stale session", async () => {
    const email = await addStaff(),
      session = await ctx.login(email);
    await ctx.db
      .collection("sessions")
      .updateMany(
        { staffId: (await row(email))._id },
        { $set: { createdAt: new Date(Date.now() - 16 * 60000) } },
      );
    const start = await post("/auth/totp/enrol/start", {}, session);
    assert.equal(start.status, 403);
    assert.match(start.data.error, /Sign in again/);
    assert.equal((await row(email)).totpPending, undefined);
  });
  it("treats a session without a creation time as stale", async () => {
    const email = await addStaff(),
      session = await ctx.login(email);
    await ctx.db
      .collection("sessions")
      .updateMany(
        { staffId: (await row(email))._id },
        { $unset: { createdAt: "" } },
      );
    assert.equal(
      (await post("/auth/totp/enrol/start", {}, session)).status,
      403,
    );
  });
  it("rejects a wrong, expired or missing confirmation code", async () => {
    const email = await addStaff(),
      session = await ctx.login(email),
      confirm = (code) => post("/auth/totp/enrol/confirm", { code }, session);
    assert.equal((await confirm("123456")).status, 400);
    const start = await post("/auth/totp/enrol/start", {}, session);
    const key = base32Decode(start.data.secret);
    assert.equal((await confirm(codeAt(key, now() + 5))).status, 400);
    assert.equal((await confirm("12ab56")).status, 400);
    await ctx.db
      .collection("staff")
      .updateOne(
        { email },
        { $set: { "totpPending.expiresAt": new Date(Date.now() - 1000) } },
      );
    const expired = await confirm(codeAt(key, now()));
    assert.equal(expired.status, 400);
    assert.match(expired.data.error, /expired|Start again/i);
    assert.equal((await row(email)).totp, undefined);
  });
  it("enables TOTP atomically and returns backup codes once", async () => {
    const email = await addStaff(),
      session = await ctx.login(email),
      other = await ctx.login(email);
    const start = await post("/auth/totp/enrol/start", {}, session);
    const key = base32Decode(start.data.secret),
      code = codeAt(key, now());
    const confirm = await post("/auth/totp/enrol/confirm", { code }, session);
    assert.equal(confirm.status, 200);
    const codes = confirm.data.backupCodes;
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const c of codes)
      assert.match(c, /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    const stored = await row(email);
    assert.equal(stored.totpPending, undefined);
    assert.equal(stored.totpBackupCodes.length, 10);
    assert.equal(stored.totp.lastStep, now());
    assert.equal(stored.revision, 2);
    const raw = JSON.stringify(stored);
    for (const secret of [
      start.data.secret,
      ...codes,
      ...codes.map((c) => c.replace("-", "")),
    ])
      assert.equal(raw.includes(secret), false);
    // The other session is gone, the current one is stepped up.
    assert.equal((await request("/auth/me", { session: other })).status, 401);
    const me = await request("/auth/me", { session });
    assert.equal(me.status, 200);
    assert.equal(me.data.staff.totpEnabled, true);
    assert.equal(me.data.staff.backupCodesLeft, 10);
    assert.ok(new Date(me.data.staff.stepUpUntil) > new Date());
    assertNoSecrets(
      me.data,
      [start.data.secret, ...codes, VAULT_KEY, AUTH_SECRET, PASSWORD],
      "/auth/me",
    );
    // The confirm response deliberately carries the one-time backup codes.
    assertNoSecrets(
      { ...confirm.data, backupCodes: undefined },
      [start.data.secret, VAULT_KEY, AUTH_SECRET],
      "confirm",
    );
    const events = await ctx.db
      .collection("audit_events")
      .find({ resourceId: stored._id, action: "totp.enabled" })
      .toArray();
    assert.equal(events.length, 1);
    assert.equal(JSON.stringify(events).includes(start.data.secret), false);
    // Confirming again with the same pending key is impossible.
    assert.equal(
      (await post("/auth/totp/enrol/confirm", { code }, session)).status,
      400,
    );
  });
  it("sends no cookie after the email code when TOTP is enabled", async () => {
    const who = await enrol();
    const first = await ctx.loginStart(who.email);
    assert.equal(first.status, 200);
    assert.equal(first.data.totpRequired, true);
    assert.equal(first.headers.get("set-cookie"), null);
    assert.equal(first.data.staff, undefined);
    assert.equal(first.data.csrf, undefined);
    const done = await post("/auth/verify-totp", {
      challengeId: first.data.challengeId,
      code: await fresh(who, 1),
    });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.ok(done.headers.get("set-cookie"));
    assert.equal(done.data.staff.email, who.email);
    assert.equal(done.data.staff.totpEnabled, true);
    const session = ctx.sessionOf(done);
    assert.equal((await request("/auth/me", { session })).status, 200);
    // A TOTP login is not a step-up.
    assert.equal(
      (await post("/auth/totp/backup-codes", {}, session)).status,
      428,
    );
    const created = await ctx.db
      .collection("audit_events")
      .findOne(
        { resourceId: (await row(who.email))._id, action: "session.created" },
        { sort: { createdAt: -1 } },
      );
    assert.match(created.detail, /authenticator/);
    // The challenge is single use.
    assert.equal(
      (
        await post("/auth/verify-totp", {
          challengeId: first.data.challengeId,
          code: await fresh(who, 1),
        })
      ).status,
      400,
    );
  });
  it("does not accept a TOTP challenge on the email-code endpoint", async () => {
    const who = await enrol();
    const first = await ctx.loginStart(who.email);
    for (const code of ["000000", "123456"]) {
      const res = await post("/auth/verify", {
        challengeId: first.data.challengeId,
        code,
      });
      assert.equal(res.status, 400);
    }
    const challenge = await ctx.db
      .collection("challenges")
      .findOne({ _id: first.data.challengeId });
    assert.equal(challenge.purpose, "totp");
    assert.equal(challenge.attempts, 0);
    assert.ok(challenge.expiresAt > new Date());
  });
  it("validates verify-totp input, attempts, expiry and access changes", async () => {
    const who = await enrol();
    const verifyTotp = (body) => post("/auth/verify-totp", body);
    const first = await ctx.loginStart(who.email),
      id = first.data.challengeId;
    assert.equal((await verifyTotp({ challengeId: id })).status, 400);
    assert.equal(
      (
        await verifyTotp({
          challengeId: id,
          code: "123456",
          backupCode: "ABCDE-FGHJK",
        })
      ).status,
      400,
    );
    assert.equal(
      (await verifyTotp({ challengeId: id, code: "123456", extra: 1 })).status,
      400,
    );
    assert.equal(
      (await verifyTotp({ challengeId: "x".repeat(30), code: "123456" }))
        .status,
      400,
    );
    // Five wrong tries kill the challenge, even for the right code.
    const wrong = codeAt(who.key, now() + 7);
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await verifyTotp({ challengeId: id, code: wrong })).status,
        400,
      );
    assert.equal(
      (await verifyTotp({ challengeId: id, code: await fresh(who) })).status,
      400,
    );
    // Expiry.
    const second = await ctx.loginStart(who.email);
    await ctx.db
      .collection("challenges")
      .updateOne(
        { _id: second.data.challengeId },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
    assert.equal(
      (
        await verifyTotp({
          challengeId: second.data.challengeId,
          code: await fresh(who),
        })
      ).status,
      400,
    );
    // Access changed after the email step.
    const third = await ctx.loginStart(who.email);
    await ctx.db
      .collection("staff")
      .updateOne({ email: who.email }, { $inc: { authVersion: 1 } });
    assert.equal(
      (
        await verifyTotp({
          challengeId: third.data.challengeId,
          code: await fresh(who),
        })
      ).status,
      401,
    );
  });
  it("rejects a code that was already used", async () => {
    const who = await enrol();
    const code = await fresh(who);
    const ok = await stepUp(who, { code });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const again = await stepUp(who, { code });
    assert.equal(again.status, 400);
    assert.match(again.data.error, /already used/);
    // An older code than the last accepted step is also refused.
    assert.equal(
      (await stepUp(who, { code: codeAt(who.key, now() - 1) })).status,
      400,
    );
    // The next step is accepted.
    assert.equal(
      (await stepUp(who, { code: codeAt(who.key, now() + 1) })).status,
      200,
    );
  });
  it("lets exactly one of several concurrent step-ups with the same code succeed", async () => {
    const who = await enrol();
    const code = await fresh(who);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => stepUp(who, { code })),
    );
    assert.deepEqual(
      results.map((r) => r.status).sort(),
      [200, 400, 400, 400, 400],
    );
  });
  it("does not allow a login code to be replayed for step-up", async () => {
    const who = await enrol();
    const code = await fresh(who);
    const done = await totpLogin(who.email, { code });
    assert.equal(done.status, 200);
    const replay = await post("/auth/step-up", { code }, ctx.sessionOf(done));
    assert.equal(replay.status, 400);
  });
  it("expires step-up after ten minutes and answers 428 without ending the session", async () => {
    const who = await enrol();
    const me = await request("/auth/me", { session: who.session });
    assert.ok(new Date(me.data.staff.stepUpUntil) > new Date());
    const staffId = (await row(who.email))._id;
    await ctx.db
      .collection("sessions")
      .updateMany(
        { staffId },
        { $set: { stepUpUntil: new Date(Date.now() - 1000) } },
      );
    const gated = () => post("/auth/totp/backup-codes", {}, who.session);
    const denied = await gated();
    assert.equal(denied.status, 428);
    assert.match(denied.data.error, /authenticator/i);
    assert.ok(denied.data.requestId);
    assert.equal(
      (await request("/auth/me", { session: who.session })).status,
      200,
    );
    const up = await stepUp(who, { code: await fresh(who, 1) });
    assert.equal(up.status, 200);
    const until = new Date(up.data.stepUpUntil).getTime();
    assert.ok(
      until > Date.now() + 9 * 60000 && until <= Date.now() + 10 * 60000 + 1000,
    );
    assert.equal((await gated()).status, 200);
    assert.equal(
      await ctx.db
        .collection("audit_events")
        .countDocuments({ action: "session.stepped-up", actorId: staffId }),
      1,
    );
  });
  it("answers 428 to step-up and gated routes when TOTP is not enabled", async () => {
    const session = await ctx.login("owner@example.test");
    assert.equal(
      (await post("/auth/step-up", { code: "123456" }, session)).status,
      428,
    );
    assert.equal(
      (await post("/auth/totp/backup-codes", {}, session)).status,
      428,
    );
  });
  it("answers 403 to a viewer before 428 and 428 to an owner without step-up", async () => {
    // Compose the exported guards exactly as feature routes will.
    const auth = authModule({
      db: ctx.db,
      client: ctx.client,
      c: ctx.c,
      sendCode: async () => {},
    });
    assert.equal(typeof auth.requireStepUp, "function");
    const app = express();
    app.use(cookieParser());
    app.get(
      "/owner-only",
      auth.requireAuth,
      auth.permit("secrets"),
      auth.requireStepUp,
      (_req, res) => res.json({ ok: true }),
    );
    app.use((error, _req, res, _next) =>
      res.status(error.status || 500).json({ error: error.message }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const url = `http://127.0.0.1:${server.address().port}/owner-only`;
      const get = (session) =>
        fetch(url, { headers: { Cookie: session.cookie } });
      const viewer = await ctx.login("viewer@example.test");
      assert.equal((await get(viewer)).status, 403);
      const owner = await ctx.login("owner@example.test");
      assert.equal((await get(owner)).status, 428);
      const ownerRow = await row("owner@example.test");
      await ctx.db
        .collection("sessions")
        .updateMany(
          { staffId: ownerRow._id },
          { $set: { stepUpUntil: new Date(Date.now() + 60000) } },
        );
      assert.equal((await get(owner)).status, 200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
  it("consumes a backup code exactly once, including under a race", async () => {
    const who = await enrol();
    const [first, second, third] = who.codes;
    const login = (code) => totpLogin(who.email, { backupCode: code });
    const ok = await login(first.toLowerCase());
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal((await login(first)).status, 400);
    assert.equal((await row(who.email)).totpBackupCodes.length, 9);
    assert.equal((await login("ABCDE-FGHJK")).status, 400);
    assert.equal((await login("short")).status, 400);
    // Concurrent consumption through step-up: one winner.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => stepUp(who, { backupCode: second })),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400, 400, 400]);
    assert.equal((await row(who.email)).totpBackupCodes.length, 8);
    assert.equal((await stepUp(who, { backupCode: second })).status, 400);
    // Spaces and a missing hyphen are tolerated.
    assert.equal(
      (await stepUp(who, { backupCode: ` ${third.replace("-", "")} ` })).status,
      200,
    );
    assert.equal(
      await ctx.db.collection("audit_events").countDocuments({
        action: "totp.backup-code-used",
        actorId: (await row(who.email))._id,
      }),
      3,
    );
  });
  it("throttles repeated wrong codes per account", async () => {
    await clearOfWindow(900000);
    const who = await enrol();
    const statuses = [];
    for (let i = 0; i < 12; i++)
      statuses.push(
        (await stepUp(who, { code: codeAt(who.key, now() + 9) })).status,
      );
    assert.equal(statuses.filter((s) => s === 400).length, 10);
    assert.equal(
      statuses.slice(10).every((s) => s === 429),
      true,
    );
  });
  it("regenerates backup codes behind step-up and invalidates the old set", async () => {
    const who = await enrol();
    const res = await post("/auth/totp/backup-codes", {}, who.session);
    assert.equal(res.status, 200);
    assert.equal(res.data.backupCodes.length, 10);
    assert.equal(
      res.data.backupCodes.some((c) => who.codes.includes(c)),
      false,
    );
    assert.equal((await stepUp(who, { backupCode: who.codes[0] })).status, 400);
    assert.equal(
      (await stepUp(who, { backupCode: res.data.backupCodes[0] })).status,
      200,
    );
    assert.ok(
      await ctx.db
        .collection("audit_events")
        .findOne({ action: "totp.backup-codes-regenerated" }),
    );
  });
  it("replaces an enrolled authenticator only after step-up", async () => {
    const who = await enrol();
    await ctx.db
      .collection("sessions")
      .updateMany({}, { $unset: { stepUpUntil: "" } });
    assert.equal(
      (await post("/auth/totp/enrol/start", {}, who.session)).status,
      428,
    );
    assert.equal(
      (await stepUp(who, { code: await fresh(who, 1) })).status,
      200,
    );
    const start = await post("/auth/totp/enrol/start", {}, who.session);
    assert.equal(start.status, 200);
    const key = base32Decode(start.data.secret);
    const confirm = await post(
      "/auth/totp/enrol/confirm",
      { code: codeAt(key, now()), currentCode: await fresh(who) },
      who.session,
    );
    assert.equal(confirm.status, 200);
    assert.ok(
      await ctx.db
        .collection("audit_events")
        .findOne({ action: "totp.replaced" }),
    );
    who.key = key;
    const done = await totpLogin(who.email, { code: await fresh(who) });
    assert.equal(done.status, 200);
  });
  it("lets non-owners disable TOTP behind step-up and never owners", async () => {
    const admin = await enrol("admin");
    const disable = (who) => post("/auth/totp/disable", {}, who.session);
    await ctx.db
      .collection("sessions")
      .updateMany({}, { $unset: { stepUpUntil: "" } });
    assert.equal((await disable(admin)).status, 428);
    assert.equal(
      (await stepUp(admin, { code: await fresh(admin, 1) })).status,
      200,
    );
    assert.equal((await disable(admin)).status, 200);
    const stored = await row(admin.email);
    assert.equal(stored.totp, undefined);
    assert.equal(stored.totpBackupCodes, undefined);
    assert.ok(
      await ctx.db
        .collection("audit_events")
        .findOne({ action: "totp.disabled" }),
    );
    const plain = await ctx.loginStart(admin.email);
    assert.equal(plain.data.totpRequired, undefined);
    assert.ok(plain.data.csrf);
    const owner = await enrol("owner");
    assert.equal((await disable(owner)).status, 409);
    assert.ok((await row(owner.email)).totp);
  });
  it("keeps the password unchanged during recovery until TOTP passes", async () => {
    const who = await enrol();
    const next = "A brand new passphrase 456?";
    const start = await post("/auth/recover", { email: who.email });
    const verified = await post("/auth/verify", {
      challengeId: start.data.challengeId,
      code: ctx.mail.get(who.email),
      password: next,
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.data.totpRequired, true);
    assert.equal(verified.headers.get("set-cookie"), null);
    const before = await row(who.email);
    assert.equal(before.passwordHash, hash);
    const wrong = await post("/auth/verify-totp", {
      challengeId: verified.data.challengeId,
      code: codeAt(who.key, now() + 8),
    });
    assert.equal(wrong.status, 400);
    assert.equal((await row(who.email)).passwordHash, hash);
    const done = await post("/auth/verify-totp", {
      challengeId: verified.data.challengeId,
      code: await fresh(who, 1),
    });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    const after = await row(who.email);
    assert.notEqual(after.passwordHash, hash);
    assert.equal(after.authVersion, before.authVersion + 1);
    assert.equal(
      (await request("/auth/me", { session: who.session })).status,
      401,
    );
    assert.ok(
      await ctx.db
        .collection("audit_events")
        .findOne({ action: "access.recovered", resourceId: after._id }),
    );
    const old = await post("/auth/login", {
      email: who.email,
      password: PASSWORD,
    });
    assert.equal(old.status, 401);
    // The parked password hash does not outlive the challenge.
    assert.equal(
      await ctx.db
        .collection("challenges")
        .findOne({ _id: verified.data.challengeId }),
      null,
    );
  });
  it("still recovers accounts without TOTP in one step", async () => {
    const email = await addStaff();
    const start = await post("/auth/recover", { email });
    const done = await post("/auth/verify", {
      challengeId: start.data.challengeId,
      code: ctx.mail.get(email),
      password: "Another long passphrase 789!",
    });
    assert.equal(done.status, 200);
    assert.ok(done.data.csrf);
    assert.ok(done.headers.get("set-cookie"));
  });
  it("resets TOTP from the maintenance task and revokes sessions", async () => {
    const who = await enrol();
    const keep = await addStaff();
    const keepSession = await ctx.login(keep);
    const deps = { db: ctx.db, client: ctx.client };
    await assert.rejects(
      resetTotp(deps, "nobody@example.test"),
      /No staff member/,
    );
    await assert.rejects(resetTotp(deps, keep), /no authenticator/i);
    const before = await row(who.email);
    const result = await resetTotp(deps, who.email.toUpperCase());
    assert.equal(result.staffId, before._id);
    const after = await row(who.email);
    for (const field of ["totp", "totpPending", "totpBackupCodes"])
      assert.equal(after[field], undefined);
    assert.equal(after.authVersion, before.authVersion + 1);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(
      (await request("/auth/me", { session: who.session })).status,
      401,
    );
    assert.equal(
      await ctx.db
        .collection("sessions")
        .countDocuments({ staffId: before._id }),
      0,
    );
    assert.equal(
      (await request("/auth/me", { session: keepSession })).status,
      200,
    );
    const event = await ctx.db
      .collection("audit_events")
      .findOne({ action: "totp.reset", resourceId: before._id });
    assert.equal(event.actorId, "system");
    const login = await ctx.loginStart(who.email);
    assert.equal(login.status, 200);
    assert.equal(login.data.totpRequired, undefined);
    assert.ok(login.data.csrf);
  });
  it("records IP and user agent on audit rows and sanitises them", async () => {
    const email = await addStaff();
    await ctx.login(email, {
      headers: { "User-Agent": "UnitTest/1.0 (probe)" },
    });
    const event = await ctx.db.collection("audit_events").findOne({
      action: "session.created",
      resourceId: (await row(email))._id,
    });
    assert.match(event.ip, /127\.0\.0\.1/);
    assert.equal(event.userAgent, "UnitTest/1.0 (probe)");
    const fake = {
      ip: "10.0.0.9",
      get: () => `a\u0000b\u001f\u007f${"x".repeat(400)}`,
    };
    await audit(ctx.db, undefined, null, "unit.test", "staff", "u1", "", fake);
    await audit(ctx.db, undefined, null, "unit.test-none", "staff", "u1", "");
    const withReq = await ctx.db
      .collection("audit_events")
      .findOne({ action: "unit.test" });
    assert.equal(withReq.ip, "10.0.0.9");
    assert.equal(withReq.userAgent.length, 200);
    assert.equal(/[\u0000-\u001f\u007f]/.test(withReq.userAgent), false);
    const without = await ctx.db
      .collection("audit_events")
      .findOne({ action: "unit.test-none" });
    assert.equal("ip" in without, false);
    assert.equal("userAgent" in without, false);
  });
  it("passes req to existing audited mutations", async () => {
    const owner = await ctx.login("owner@example.test");
    const created = await request("/customers", {
      method: "POST",
      session: owner,
      body: {
        name: "Audit Customer",
        company: "Co",
        email: `audit-${randomUUID().slice(0, 6)}@example.test`,
        phone: "",
        status: "active",
        notes: "",
        storeWorkspaceId: "",
      },
    });
    assert.equal(created.status, 201);
    const event = await ctx.db
      .collection("audit_events")
      .findOne({ action: "record.created", resourceId: created.data._id });
    assert.ok(event.ip);
    const invited = await post(
      "/team",
      {
        name: "Invited",
        email: `inv-${randomUUID().slice(0, 6)}@example.test`,
        role: "viewer",
      },
      owner,
    );
    assert.equal(invited.status, 201);
    assert.ok(
      (
        await ctx.db
          .collection("audit_events")
          .findOne({ action: "staff.invited", resourceId: invited.data._id })
      ).ip,
    );
    const revoked = await post(
      "/auth/revoke-sessions",
      {},
      await ctx.login(await addStaff()),
    );
    assert.equal(revoked.status, 200);
    assert.ok(
      (
        await ctx.db
          .collection("audit_events")
          .findOne({ action: "sessions.revoked" })
      ).ip,
    );
  });
  it("exposes no TOTP key, box, hash or code in any read response", async () => {
    const who = await enrol("owner");
    const plain = [
      base32Encode(who.key),
      ...who.codes,
      ...who.codes.map((c) => c.replace("-", "")),
      VAULT_KEY,
      AUTH_SECRET,
      PASSWORD,
      who.start.data.uri,
    ];
    for (const path of ["/auth/me", "/audit?page=1", "/team", "/overview"]) {
      const res = await request(path, { session: who.session });
      assert.equal(res.status, 200, path);
      assertNoSecrets(res.data, plain, path);
    }
    const team = await request("/team", { session: who.session });
    assert.equal(
      team.data.rows.find((r) => r.email === who.email).totpEnabled,
      true,
    );
    const first = await ctx.loginStart(who.email);
    assertNoSecrets(first.data, plain, "login");
    const done = await post("/auth/verify-totp", {
      challengeId: first.data.challengeId,
      code: await fresh(who, 1),
    });
    assertNoSecrets(done.data, plain, "verify-totp");
    const events = await ctx.db.collection("audit_events").find({}).toArray();
    assertNoSecrets(events, plain, "audit rows");
  });
  const bucket = (key, windowMs) =>
    digest(`${key}:${Math.floor(Date.now() / windowMs)}`);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  it("counts only failed codes against the per-account limiter", async () => {
    const who = await enrol();
    for (let i = 0; i < 12; i++)
      assert.equal(
        (await stepUp(who, { code: await fresh(who) })).status,
        200,
        `success ${i}`,
      );
    const id = (await row(who.email))._id;
    assert.equal(
      await ctx.db
        .collection("rate_limits")
        .findOne({ _id: bucket(`totp:${id}`, 900000) }),
      null,
    );
  });
  it("audits every failed second-factor attempt without the code", async () => {
    const who = await enrol();
    const id = (await row(who.email))._id;
    const wrong = codeAt(who.key, now() + 9);
    assert.equal((await stepUp(who, { code: wrong })).status, 400);
    assert.equal(
      (await stepUp(who, { backupCode: "ABCDE-FGHJK" })).status,
      400,
    );
    const first = await ctx.loginStart(who.email);
    assert.equal(
      (
        await post("/auth/verify-totp", {
          challengeId: first.data.challengeId,
          code: wrong,
        })
      ).status,
      400,
    );
    const start = await post("/auth/totp/enrol/start", {}, who.session);
    assert.equal(start.status, 200);
    const confirm = await post(
      "/auth/totp/enrol/confirm",
      {
        code: codeAt(base32Decode(start.data.secret), now() + 9),
        currentCode: await fresh(who),
      },
      who.session,
    );
    assert.equal(confirm.status, 400);
    const events = await ctx.db
      .collection("audit_events")
      .find({ action: "totp.failed", resourceId: id })
      .toArray();
    assert.deepEqual(events.map((e) => e.detail).sort(), [
      "enrol",
      "login",
      "step-up",
      "step-up",
    ]);
    for (const event of events) assert.ok(event.ip);
    const text = JSON.stringify(events);
    for (const secret of [wrong, "ABCDE-FGHJK", base32Encode(who.key)])
      assert.equal(text.includes(secret), false);
  });
  it("locks wrong authenticator codes for a day but keeps backup codes working", async () => {
    const who = await enrol();
    const id = (await row(who.email))._id;
    // 19 wrong codes already recorded in the past 24 h; the next one trips
    // the rolling lock.
    await ctx.db.collection("staff").updateOne(
      { _id: id },
      {
        $set: {
          totpFailures: Array.from(
            { length: 19 },
            (_, i) => new Date(Date.now() - (i + 1) * 60000),
          ),
        },
      },
    );
    const wrong = codeAt(who.key, now() + 9);
    assert.equal((await stepUp(who, { code: wrong })).status, 400);
    await settle();
    assert.equal(
      await ctx.db
        .collection("audit_events")
        .countDocuments({ action: "totp.locked", resourceId: id }),
      1,
    );
    assert.equal(
      ctx.notices.filter(
        (n) => n.email === who.email && /locked/i.test(n.subject),
      ).length,
      1,
    );
    // Even the correct code is refused now, in every code path.
    const locked = await stepUp(who, { code: await fresh(who) });
    assert.equal(locked.status, 429);
    assert.match(locked.data.error, /Too many wrong authenticator codes/);
    const first = await ctx.loginStart(who.email);
    assert.equal(
      (
        await post("/auth/verify-totp", {
          challengeId: first.data.challengeId,
          code: await fresh(who),
        })
      ).status,
      429,
    );
    const start = await post("/auth/totp/enrol/start", {}, who.session);
    assert.equal(start.status, 200);
    assert.equal(
      (
        await post(
          "/auth/totp/enrol/confirm",
          {
            code: codeAt(base32Decode(start.data.secret), now()),
            currentBackupCode: who.codes[5],
          },
          who.session,
        )
      ).status,
      429,
    );
    // Locking is announced once, not on every refused attempt.
    assert.equal(
      await ctx.db
        .collection("audit_events")
        .countDocuments({ action: "totp.locked", resourceId: id }),
      1,
    );
    // Backup codes still work (login and step-up).
    assert.equal(
      (await totpLogin(who.email, { backupCode: who.codes[0] })).status,
      200,
    );
    assert.equal((await stepUp(who, { backupCode: who.codes[1] })).status, 200);
    // A maintenance reset clears the lock.
    await resetTotp({ db: ctx.db, client: ctx.client }, who.email);
    const cleared = await row(who.email);
    assert.equal(cleared.totpLockedUntil, undefined);
    assert.equal(cleared.totpFailures, undefined);
  });
  it("applies the authentication gate to case and trailing-slash variants", async () => {
    // Downstream calls are held open so eight requests occupy the gate.
    let release,
      arrived = 0;
    const hold = new Promise((resolve) => (release = resolve));
    const slow = (collection, method) =>
      new Proxy(collection, {
        get: (target, prop) =>
          prop === method
            ? async (...args) => {
                arrived++;
                await hold;
                return target[prop](...args);
              }
            : typeof target[prop] === "function"
              ? target[prop].bind(target)
              : target[prop],
      });
    const slowDb = {
      collection: (name) =>
        name === "staff"
          ? slow(ctx.db.collection(name), "findOne")
          : name === "challenges"
            ? slow(ctx.db.collection(name), "findOneAndUpdate")
            : ctx.db.collection(name),
    };
    const auth = authModule({
      db: slowDb,
      client: ctx.client,
      c: ctx.c,
      sendCode: async () => {},
    });
    const app = express();
    app.use(express.json());
    app.use("/api/auth", auth.router);
    app.use((error, _req, res, _next) =>
      res.status(error.status || 500).json({ error: error.message }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}/api/auth`;
    const send = (path, body) =>
      fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const challengeId = "x".repeat(30);
    const totp = { challengeId, code: "123456" };
    const mail = { email: "owner@example.test", password: PASSWORD };
    try {
      const held = [
        send("/VERIFY-TOTP", totp),
        send("/verify-totp/", totp),
        send("/Verify-Totp", totp),
        send("/VERIFY-TOTP/", totp),
        send("/Verify", totp),
        send("/Verify/", totp),
        send("/LOGIN/", mail),
        send("/Login", mail),
      ];
      // Wait on observable state, not time: all eight are inside the gate.
      for (let i = 0; arrived < 8; i++) {
        assert.ok(i < 1000, `only ${arrived} of 8 requests reached the gate`);
        await new Promise((r) => setTimeout(r, 10));
      }
      const busy = await send("/verify-totp/", totp);
      assert.equal(busy.status, 503);
      assert.equal((await send("/RECOVER", { email: mail.email })).status, 503);
      release();
      const done = await Promise.all(held);
      for (const res of done) assert.notEqual(res.status, 503);
      // Capacity is returned once the held requests finish.
      assert.notEqual((await send("/verify-totp/", totp)).status, 503);
    } finally {
      release();
      await new Promise((r) => server.close(r));
    }
  });
  it("consumes one backup code and creates one session when two logins race", async () => {
    const who = await enrol();
    const first = await ctx.loginStart(who.email);
    const results = await Promise.all(
      [who.codes[0], who.codes[1]].map((backupCode) =>
        post("/auth/verify-totp", {
          challengeId: first.data.challengeId,
          backupCode,
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    const stored = await row(who.email);
    assert.equal(stored.totpBackupCodes.length, 9);
    // The losing request's claim rolled back with its aborted sign-in.
    assert.equal(
      await ctx.db.collection("audit_events").countDocuments({
        action: "totp.backup-code-used",
        resourceId: stored._id,
      }),
      1,
    );
  });
  it("rolls back a claimed code when the sign-in transaction then fails", async () => {
    // The challenge delete inside the sign-in transaction fails AFTER the
    // second-factor claim ran. With the claim in the same transaction it rolls
    // back; with the old order (claim first, outside) the code stayed spent.
    const flags = { fail: false };
    const failing = (collection) =>
      new Proxy(collection, {
        get: (target, prop) =>
          prop === "deleteOne"
            ? async (...args) => {
                if (flags.fail) throw new Error("injected failure");
                return target.deleteOne(...args);
              }
            : typeof target[prop] === "function"
              ? target[prop].bind(target)
              : target[prop],
      });
    const proxied = {
      collection: (name) =>
        name === "challenges"
          ? failing(ctx.db.collection(name))
          : ctx.db.collection(name),
    };
    const auth = authModule({
      db: proxied,
      client: ctx.client,
      c: ctx.c,
      sendCode: async () => {},
    });
    const app = express();
    app.use(express.json());
    app.use("/api/auth", auth.router);
    app.use((error, _req, res, _next) =>
      res.status(error.status || 500).json({ error: error.message }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const attempt = async (email, factor) => {
      const first = await ctx.loginStart(email);
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/api/auth/verify-totp`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            challengeId: first.data.challengeId,
            ...factor,
          }),
        },
      );
      return res;
    };
    try {
      const who = await enrol();
      const id = (await row(who.email))._id;
      const sessionsNow = () =>
        ctx.db.collection("sessions").countDocuments({ staffId: id });
      const before = await sessionsNow();
      // Backup code.
      flags.fail = true;
      const failed = await attempt(who.email, { backupCode: who.codes[0] });
      assert.equal(failed.status, 500);
      assert.equal(failed.headers.get("set-cookie"), null);
      assert.equal(await sessionsNow(), before);
      assert.equal((await row(who.email)).totpBackupCodes.length, 10);
      assert.equal(
        await ctx.db
          .collection("audit_events")
          .countDocuments({ action: "totp.backup-code-used", resourceId: id }),
        0,
      );
      // Authenticator code: lastStep must not advance.
      const code = await fresh(who);
      const lastStep = (await row(who.email)).totp.lastStep;
      const failedCode = await attempt(who.email, { code });
      assert.equal(failedCode.status, 500);
      assert.equal((await row(who.email)).totp.lastStep, lastStep);
      assert.equal(await sessionsNow(), before);
      flags.fail = false;
      // Both factors still work on a fresh, valid challenge.
      assert.equal(
        (await totpLogin(who.email, { backupCode: who.codes[0] })).status,
        200,
      );
      assert.equal((await row(who.email)).totpBackupCodes.length, 9);
      assert.equal((await totpLogin(who.email, { code })).status, 200);
    } finally {
      flags.fail = false;
      await new Promise((r) => server.close(r));
    }
  });
  it("cleans the IP and user agent stored on audit rows", async () => {
    const make = (ip, ua) => ({ ip, get: () => ua });
    const cases = [
      [make("<script>alert(1)</script>", "x"), "invalid"],
      [make("1.2.3.4\nX-Forged: 1", "x"), "invalid"],
      [make("1".repeat(65), "x"), "invalid"],
      [make("::ffff:10.0.0.1", "x"), "::ffff:10.0.0.1"],
      [make("2001:db8::1", "x"), "2001:db8::1"],
    ];
    for (const [req, expected] of cases) {
      const id = randomUUID();
      await audit(ctx.db, undefined, null, "unit.ip", "staff", id, "", req);
      assert.equal(
        (await ctx.db.collection("audit_events").findOne({ resourceId: id }))
          .ip,
        expected,
      );
    }
    const id = randomUUID();
    await audit(
      ctx.db,
      undefined,
      null,
      "unit.ua",
      "staff",
      id,
      "",
      make("1.1.1.1", "a b c‮d⁦e⁩f‎g"),
    );
    assert.equal(
      (await ctx.db.collection("audit_events").findOne({ resourceId: id }))
        .userAgent,
      "abcdefg",
    );
  });
  it("shows IP and user agent only to staff with the team permission", async () => {
    const owner = await ctx.login("owner@example.test");
    const viewer = await ctx.login("viewer@example.test");
    const admin = await ctx.login("admin@example.test");
    // Cached summaries must not leak across roles either.
    for (const [session, visible] of [
      [owner, true],
      [viewer, false],
      [admin, false],
      [owner, true],
    ]) {
      const audit = await request("/audit?page=1", { session });
      assert.equal(audit.status, 200);
      assert.ok(audit.data.rows.length > 0);
      for (const r of audit.data.rows) {
        if (!visible) {
          assert.equal("ip" in r, false);
          assert.equal("userAgent" in r, false);
        }
      }
      assert.equal(
        audit.data.rows.some((r) => "ip" in r),
        visible,
      );
      const overview = await request("/overview", { session });
      assert.equal(overview.status, 200);
      assert.ok(overview.data.activity.length > 0);
      assert.equal(
        overview.data.activity.some((r) => "ip" in r || "userAgent" in r),
        visible,
      );
    }
  });
  it("requires a current authenticator or backup code to replace it", async () => {
    const who = await enrol();
    const start = await post("/auth/totp/enrol/start", {}, who.session);
    const key = base32Decode(start.data.secret);
    const confirm = (extra) =>
      post(
        "/auth/totp/enrol/confirm",
        { code: codeAt(key, now()), ...extra },
        who.session,
      );
    assert.equal((await confirm({})).status, 400);
    assert.equal(
      (
        await confirm({
          currentCode: "123456",
          currentBackupCode: who.codes[0],
        })
      ).status,
      400,
    );
    assert.equal(
      (await confirm({ currentCode: codeAt(who.key, now() + 8) })).status,
      400,
    );
    assert.equal(
      (await confirm({ currentBackupCode: "ABCDE-FGHJK" })).status,
      400,
    );
    // Nothing changed so far.
    const before = (await row(who.email)).totp.key.iv;
    const ok = await confirm({ currentBackupCode: who.codes[2] });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const after = await row(who.email);
    assert.notEqual(after.totp.key.iv, before);
    assert.equal(after.totpBackupCodes.length, 10);
    // A first enrolment takes no current code.
    const fresh1 = await addStaff();
    const session = await ctx.login(fresh1);
    const s = await post("/auth/totp/enrol/start", {}, session);
    assert.equal(
      (
        await post(
          "/auth/totp/enrol/confirm",
          {
            code: codeAt(base32Decode(s.data.secret), now()),
            currentCode: "123456",
          },
          session,
        )
      ).status,
      200,
    );
  });
  it("sends best-effort security notices without codes or keys", async () => {
    ctx.notices.length = 0;
    const who = await enrol("admin");
    await settle();
    const sent = () => ctx.notices.filter((n) => n.email === who.email);
    assert.equal(sent().length, 1);
    assert.match(sent()[0].subject, /enabled/i);
    // Replace.
    const start = await post("/auth/totp/enrol/start", {}, who.session);
    const key = base32Decode(start.data.secret);
    const replaced = await post(
      "/auth/totp/enrol/confirm",
      { code: codeAt(key, now()), currentCode: await fresh(who) },
      who.session,
    );
    assert.equal(replaced.status, 200);
    who.key = key;
    await settle();
    assert.match(sent().at(-1).subject, /replaced/i);
    // Disable.
    assert.equal(
      (await post("/auth/totp/disable", {}, who.session)).status,
      200,
    );
    await settle();
    assert.match(sent().at(-1).subject, /turned off|disabled/i);
    // Recovery (no authenticator now): one-step recovery sends a notice.
    const recover = await post("/auth/recover", { email: who.email });
    const done = await post("/auth/verify", {
      challengeId: recover.data.challengeId,
      code: ctx.mail.get(who.email),
      password: "Yet another long passphrase 321!",
    });
    assert.equal(done.status, 200);
    await settle();
    assert.match(sent().at(-1).subject, /password/i);
    // CLI reset.
    const reset = await enrol("admin");
    ctx.notices.length = 0;
    await resetTotp(
      {
        db: ctx.db,
        client: ctx.client,
        notify: async (email, message) =>
          ctx.notices.push({ email, ...message }),
      },
      reset.email,
    );
    assert.equal(ctx.notices.length, 1);
    for (const n of ctx.notices) assert.equal(typeof n.text, "string");
    const everything = JSON.stringify(ctx.notices);
    for (const secret of [
      ...who.codes,
      ...reset.codes,
      base32Encode(key),
      base32Encode(reset.key),
      VAULT_KEY,
      AUTH_SECRET,
      PASSWORD,
    ])
      assert.equal(everything.includes(secret), false);
  });
  it("sends the reset notice from the maintenance task", async () => {
    const who = await enrol();
    const seen = [];
    await resetTotp(
      {
        db: ctx.db,
        client: ctx.client,
        notify: async (email, message) => seen.push({ email, ...message }),
      },
      who.email,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].email, who.email);
    assert.match(seen[0].subject, /reset/i);
    const other = await enrol();
    await resetTotp(
      {
        db: ctx.db,
        client: ctx.client,
        notify: async () => {
          throw new Error("smtp down");
        },
      },
      other.email,
    );
    assert.equal((await row(other.email)).totp, undefined);
  });
  it("never lets a failing notifier change an HTTP result", async () => {
    ctx.flags.failNotify = true;
    try {
      const who = await enrol("admin");
      const start = await post("/auth/totp/enrol/start", {}, who.session);
      const replaced = await post(
        "/auth/totp/enrol/confirm",
        {
          code: codeAt(base32Decode(start.data.secret), now()),
          currentBackupCode: who.codes[0],
        },
        who.session,
      );
      assert.equal(replaced.status, 200);
      assert.equal(
        (await post("/auth/totp/disable", {}, who.session)).status,
        200,
      );
      const recover = await post("/auth/recover", { email: who.email });
      const done = await post("/auth/verify", {
        challengeId: recover.data.challengeId,
        code: ctx.mail.get(who.email),
        password: "Another long passphrase 654!",
      });
      assert.equal(done.status, 200);
    } finally {
      ctx.flags.failNotify = false;
    }
  });
  it("serves the app shell with no-store and keeps long caching for assets", async () => {
    // Self-sufficient: without a prior `npm run build` a tiny fixture is created
    // and removed again; a real build is left untouched.
    const dist = new URL("../dist/", import.meta.url);
    const made = [];
    const ensure = (rel, text) => {
      const url = new URL(rel, dist);
      if (!existsSync(url)) {
        mkdirSync(new URL(".", url), { recursive: true });
        writeFileSync(url, text);
        made.push(url);
      }
    };
    ensure("index.html", "<!doctype html><title>fixture</title>");
    ensure("assets/fixture.js", "/* fixture */");
    try {
      for (const path of ["/", "/account", "/index.html"]) {
        const res = await fetch(`${ctx.origin}${path}`);
        assert.match(res.headers.get("cache-control") || "", /no-store/, path);
      }
      const assets = readdirSync(new URL("assets", dist));
      assert.ok(assets.length);
      const res = await fetch(`${ctx.origin}/assets/${assets[0]}`);
      assert.match(res.headers.get("cache-control") || "", /max-age=3600/);
    } finally {
      for (const url of made.reverse()) rmSync(url, { force: true });
    }
  });
  it("roundtrips snapshots with enrolled TOTP and checks every staff box", async () => {
    const who = await enrol();
    const id = (await row(who.email))._id;
    await ctx.db.collection("staff").updateOne(
      { email: who.email },
      {
        $set: {
          totpPending: {
            key: encrypt(
              "ABCDEFGHIJKLMNOP",
              VAULT_KEY,
              `staff:${id}:totp-pending`,
            ),
            expiresAt: new Date(Date.now() + 60000),
          },
        },
      },
    );
    const encoded = await makeSnapshot(ctx.db, VAULT_KEY, BACKUP_KEY);
    assert.equal(encoded.includes(who.email), false);
    const snapshot = parseSnapshot(encoded, VAULT_KEY, BACKUP_KEY);
    const saved = snapshot.collections.staff.find((s) => s.email === who.email);
    assert.ok(saved.totp.key.iv);
    assert.equal(saved.totpBackupCodes.length, 10);
    assert.ok(saved.totp.enabledAt instanceof Date);
    assert.throws(() => parseSnapshot(encoded, "d".repeat(64), BACKUP_KEY));
    assert.deepEqual(
      [...secretBoxes("staff", saved)].map(([, aad]) => aad).sort(),
      [`staff:${id}:totp`, `staff:${id}:totp-pending`],
    );
    assert.deepEqual([...secretBoxes("staff", { _id: "x" })], []);
    assert.deepEqual([...secretBoxes("tasks", { _id: "x", secret: {} })], []);
    // A box bound to another record fails the snapshot check.
    await ctx.db.collection("staff").updateOne(
      { email: who.email },
      {
        $set: {
          "totp.key": encrypt(
            "ABCDEFGHIJKLMNOP",
            VAULT_KEY,
            "staff:someone-else:totp",
          ),
        },
      },
    );
    await assert.rejects(makeSnapshot(ctx.db, VAULT_KEY, BACKUP_KEY));
  });
});
