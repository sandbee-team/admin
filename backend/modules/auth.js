import { Router } from "express";
import { randomInt, createHmac } from "node:crypto";
import { z } from "zod";
import {
  token,
  digest,
  mac,
  equal,
  hashPassword,
  verifyPassword,
  encrypt,
  decrypt,
} from "../lib/crypto.js";
import { ensure, HttpError } from "../lib/errors.js";
import { consume, exceeded } from "../lib/limiter.js";
import { audit } from "../lib/audit.js";
import { transaction } from "../db.js";
import {
  generateKey,
  base32Encode,
  base32Decode,
  verify as verifyTotp,
  otpauthUri,
} from "../lib/totp.js";
import { qrSvg } from "../lib/qr.js";
import { authorizeWrite } from "./records.js";
import { can } from "../../shared/policy.js";

const emailSchema = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
export const passwordSchema = z
  .string()
  .min(14, "Use at least 14 characters.")
  .max(128);
export const publicStaff = (staff) => ({
  _id: staff._id,
  email: staff.email,
  name: staff.name,
  role: staff.role,
  status: staff.status,
  revision: staff.revision,
  createdAt: staff.createdAt,
  totpEnabled: Boolean(staff.totp?.enabledAt),
});
const STEP_UP_MS = 10 * 60000,
  ENROL_FRESH_MS = 15 * 60000,
  PENDING_MS = 10 * 60000,
  TOTP_CHALLENGE_MS = 5 * 60000;
const BACKUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const codeField = z.string().regex(/^[0-9]{6}$/, "Enter the 6-digit code.");
// Exactly one of an authenticator code or a backup code.
const factorSchema = (extra = {}) =>
  z
    .object({
      ...extra,
      code: codeField.optional(),
      backupCode: z.string().min(10).max(32).optional(),
    })
    .strict()
    .refine((d) => (d.code === undefined) !== (d.backupCode === undefined), {
      message: "Send either an authenticator code or a backup code.",
    });
const BAD_CODE = "Code is incorrect.";
const ISSUER = "Sandbee Admin";
export function authModule({ db, client, c, sendCode, notify }) {
  const router = Router(),
    cookieName =
      c.NODE_ENV === "production" ? "__Host-sandbee_admin" : "sandbee_admin";
  const cookieOptions = {
    httpOnly: true,
    secure: c.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 8 * 60 * 60 * 1000,
  };
  const staff = db.collection("staff"),
    challenges = db.collection("challenges"),
    sessions = db.collection("sessions");
  let activeRequests = 0;
  router.use((req, res, next) => {
    // Express matches routes case-insensitively and ignores trailing slashes.
    const route = req.path.toLowerCase().replace(/\/+$/, "");
    if (!["/login", "/verify", "/verify-totp", "/recover"].includes(route))
      return next();
    ensure(activeRequests < 8, 503, "Authentication is busy. Retry shortly.");
    activeRequests++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeRequests--;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  });
  // Requests already authenticated by requireAuth. Module-private, so nothing
  // a client sends (or any other module) can mark a request as authenticated.
  const authenticated = new WeakSet();
  async function requireAuth(req, _res, next) {
    if (authenticated.has(req)) return next();
    const raw = req.cookies[cookieName];
    ensure(
      typeof raw === "string" && raw.length < 200,
      401,
      "Sign in to continue.",
    );
    const session = await sessions.findOne({
      _id: digest(raw),
      expiresAt: { $gt: new Date() },
    });
    ensure(session, 401, "Your session has expired. Sign in again.");
    const user = await staff.findOne({
      _id: session.staffId,
      status: "active",
      authVersion: session.authVersion,
    });
    ensure(user, 401, "Your access has changed. Sign in again.");
    req.staff = user;
    req.session = session;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method))
      ensure(
        equal(req.get("x-csrf-token"), session.csrf),
        403,
        "Refresh the page and try again.",
      );
    authenticated.add(req);
    next();
  }
  const permit = (permission) => (req, _res, next) => {
    ensure(
      can(req.staff?.role, permission),
      403,
      "Your role does not allow this action.",
    );
    next();
  };
  async function sendChallenge(user, purpose) {
    const _id = token(),
      code = String(randomInt(100000, 1000000));
    await challenges.insertOne({
      _id,
      staffId: user._id,
      purpose,
      authVersion: user.authVersion,
      codeHash: mac(c.AUTH_SECRET, `${_id}:${code}`),
      attempts: 0,
      expiresAt: new Date(Date.now() + 600000),
    });
    try {
      await sendCode(user.email, code);
    } catch {
      await challenges.deleteOne({ _id });
      throw new HttpError(
        503,
        "Email delivery is unavailable. Try again shortly.",
      );
    }
    return _id;
  }
  router.post("/login", async (req, res) => {
    const data = z
      .object({ email: emailSchema, password: z.string().max(128) })
      .strict()
      .parse(req.body);
    await consume(db, `login-ip:${req.ip}`, 20, 900000);
    await consume(db, `login-email:${data.email}`, 6, 900000);
    const user = await staff.findOne({ email: data.email, status: "active" });
    ensure(
      (await verifyPassword(data.password, user?.passwordHash)) && user,
      401,
      "Email or password is incorrect.",
    );
    res.json({ challengeId: await sendChallenge(user, "login") });
  });
  router.post("/recover", async (req, res) => {
    const { email } = z.object({ email: emailSchema }).strict().parse(req.body);
    await consume(db, `recovery-ip:${req.ip}`, 10, 900000);
    await consume(db, `recovery-email:${email}`, 3, 900000);
    const user = await staff.findOne({
      email,
      status: { $in: ["active", "invited"] },
    });
    const challengeId = user ? await sendChallenge(user, "recovery") : token();
    res.json({
      challengeId,
      message: "If this email has staff access, a code has been sent.",
    });
  });
  const BACKUP_KEY = createHmac("sha256", Buffer.from(c.VAULT_KEY, "hex"))
    .update("staff-backup-codes-v1")
    .digest();
  const hashBackup = (staffId, code) => mac(BACKUP_KEY, `${staffId}:${code}`);
  const normalizeBackup = (value) => {
    const code = String(value).toUpperCase().replace(/[\s-]/g, "");
    return /^[A-HJKMNP-Z2-9]{10}$/.test(code) ? code : null;
  };
  function newBackupCodes(staffId) {
    const codes = new Set();
    while (codes.size < 10)
      codes.add(
        Array.from(
          { length: 10 },
          () => BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)],
        ).join(""),
      );
    return {
      display: [...codes].map((v) => `${v.slice(0, 5)}-${v.slice(5)}`),
      hashes: [...codes].map((v) => hashBackup(staffId, v)),
    };
  }
  const keyOf = (user, field) =>
    base32Decode(
      decrypt(
        user[field].key,
        c.VAULT_KEY,
        `staff:${user._id}:${field === "totp" ? "totp" : "totp-pending"}`,
      ),
    );
  const boxKey = (user, field, key) =>
    encrypt(
      base32Encode(key),
      c.VAULT_KEY,
      `staff:${user._id}:${field === "totp" ? "totp" : "totp-pending"}`,
    );
  const steppedUp = (session) =>
    Boolean(session?.stepUpUntil && session.stepUpUntil > new Date());
  // 428, not 401: the session is fine and only a fresh authenticator code is
  // missing, so the browser must not treat it as an expired session.
  function requireStepUp(req, _res, next) {
    ensure(
      steppedUp(req.session),
      428,
      "Confirm with your authenticator code.",
    );
    next?.();
  }
  // Best-effort security notices: fired after the change has committed, never
  // awaited, never able to fail the request, and never carrying codes or keys.
  function tell(user, subject, text) {
    void (async () => {
      try {
        await notify?.(user.email, { subject, text });
      } catch {
        // Mail trouble must not affect authentication.
      }
    })();
  }
  const NOTICES = {
    enabled: [
      "Authenticator enabled on your Sandbee Admin account",
      "An authenticator app was turned on for your Sandbee Admin account. If this was not you, tell your owner and change your password.",
    ],
    replaced: [
      "Your Sandbee Admin authenticator was replaced",
      "The authenticator app on your Sandbee Admin account was replaced and your other sessions were signed out. If this was not you, tell your owner and change your password.",
    ],
    disabled: [
      "Your Sandbee Admin authenticator was turned off",
      "The authenticator app on your Sandbee Admin account was turned off. If this was not you, tell your owner and change your password.",
    ],
    locked: [
      "Authenticator codes are locked on your Sandbee Admin account",
      "There were 20 wrong authenticator codes in 24 hours, so authenticator codes are locked for 24 hours. Backup codes still work. If this was not you, change your password and ask your owner to reset your authenticator.",
    ],
    recovered: [
      "Your Sandbee Admin password was reset",
      "The password on your Sandbee Admin account was reset using an email code. If this was not you, tell your owner immediately.",
    ],
  };
  const tellOf = (user, name) => tell(user, ...NOTICES[name]);
  const LOCK_MS = 86400000,
    FAILURE_LIMIT = 20;
  const LOCK_MESSAGE =
    "Too many wrong authenticator codes. Use a backup code or ask for a reset.";
  const TOO_MANY = "Too many requests. Please wait before trying again.";
  // Failures are recorded outside any transaction so they survive an aborted
  // sign-in. Wrong CODES (not backup codes) also feed a 24 hour lockout.
  async function recordFailure(user, input, req, context) {
    try {
      await audit(
        db,
        undefined,
        user,
        "totp.failed",
        "staff",
        user._id,
        context,
        req,
      );
    } catch {
      // Accounting must not turn a refusal into a server error.
    }
    try {
      await consume(db, `totp:${user._id}`, 10, 900000);
    } catch {
      // Already over the limit; the next attempt is refused up front.
    }
    if (input.backupCode !== undefined) return;
    try {
      // Rolling window: keep the last 20 failure times that fall inside the
      // past 24 h and lock for 24 h from the failure that fills the list.
      // One atomic pipeline update, so racing failures cannot skip the lock.
      const now = new Date(),
        lockUntil = new Date(now.getTime() + LOCK_MS);
      const before = await staff.findOneAndUpdate(
        { _id: user._id },
        [
          {
            $set: {
              totpFailures: {
                $slice: [
                  {
                    $concatArrays: [
                      {
                        $filter: {
                          input: { $ifNull: ["$totpFailures", []] },
                          cond: {
                            $gt: ["$$this", new Date(now.getTime() - LOCK_MS)],
                          },
                        },
                      },
                      [now],
                    ],
                  },
                  -FAILURE_LIMIT,
                ],
              },
            },
          },
          {
            $set: {
              totpLockedUntil: {
                $cond: [
                  {
                    $and: [
                      { $gte: [{ $size: "$totpFailures" }, FAILURE_LIMIT] },
                      {
                        $not: [
                          {
                            $gt: [{ $ifNull: ["$totpLockedUntil", now] }, now],
                          },
                        ],
                      },
                    ],
                  },
                  lockUntil,
                  "$totpLockedUntil",
                ],
              },
            },
          },
        ],
        { returnDocument: "before" },
      );
      // Decide from the document as it was BEFORE this update: updates on one
      // record are serialized, so exactly one request sees the lock absent (or
      // expired) while the in-window count reaches the limit.
      const inWindow = (before?.totpFailures ?? []).filter(
        (at) => at > new Date(now.getTime() - LOCK_MS),
      ).length;
      const armed =
        Boolean(before) &&
        inWindow + 1 >= FAILURE_LIMIT &&
        !(before.totpLockedUntil && before.totpLockedUntil > now);
      if (armed) {
        await audit(
          db,
          undefined,
          user,
          "totp.locked",
          "staff",
          user._id,
          "20 wrong codes in 24 hours",
          req,
        );
        tellOf(user, "locked");
      }
    } catch (error) {
      // The caller still rejects this attempt (fails closed), but a lock that
      // could not be recorded must be visible: log request id and error type
      // only, never values.
      console.error(
        JSON.stringify({
          requestId: req?.requestId,
          event: "totp.lock-record-failed",
          type: error?.name,
        }),
      );
    }
  }
  // The lock is a timestamp on the staff record (set at the 20th wrong code
  // inside a rolling 24 h), checked on every authenticator-code attempt.
  // Backup codes bypass it, and a successful backup-code use does NOT clear
  // it: it protects against guessing, and only a maintenance reset-totp or the
  // 24 h expiry lifts it.
  const lockedOut = async (user) =>
    Boolean(user.totpLockedUntil && user.totpLockedUntil > new Date());
  const factorFailure = (message) => {
    const error = new HttpError(400, message);
    error.factorFailure = true;
    return error;
  };
  // Step 1 of every second-factor check: pure verification with no writes
  // except failure accounting. Returns the atomic claim to run inside the
  // caller's transaction, so an aborted sign-in rolls the claim back.
  async function prepareFactor(user, input, req, context) {
    ensure(
      !(await exceeded(db, `totp:${user._id}`, 10, 900000)),
      429,
      TOO_MANY,
    );
    const reject = async (message = BAD_CODE) => {
      await recordFailure(user, input, req, context);
      throw new HttpError(400, message);
    };
    if (input.backupCode !== undefined) {
      const code = normalizeBackup(input.backupCode);
      if (!code) return reject();
      const hashed = hashBackup(user._id, code);
      let known = false;
      for (const stored of user.totpBackupCodes ?? [])
        if (equal(stored, hashed)) known = true;
      if (!known) return reject("Code is incorrect or already used.");
      return {
        label: "backup code",
        async claim(session) {
          const used = await staff.updateOne(
            {
              _id: user._id,
              "totp.enabledAt": { $exists: true },
              totpBackupCodes: hashed,
            },
            { $pull: { totpBackupCodes: hashed } },
            { session },
          );
          if (used.matchedCount !== 1)
            throw factorFailure("Code is incorrect or already used.");
          await audit(
            db,
            session,
            user,
            "totp.backup-code-used",
            "staff",
            user._id,
            "Backup code used",
            req,
          );
        },
      };
    }
    ensure(!(await lockedOut(user)), 429, LOCK_MESSAGE);
    if (!user.totp?.key) return reject();
    const step = verifyTotp(keyOf(user, "totp"), input.code, Date.now());
    if (step === null) return reject();
    return {
      label: "authenticator",
      async claim(session) {
        const claimed = await staff.updateOne(
          {
            _id: user._id,
            "totp.enabledAt": { $exists: true },
            $or: [
              { "totp.lastStep": { $lt: step } },
              { "totp.lastStep": null },
            ],
          },
          { $set: { "totp.lastStep": step } },
          { session },
        );
        if (claimed.matchedCount !== 1)
          throw factorFailure(
            "This code was already used — wait for the next one.",
          );
      },
    };
  }
  // Runs `work` in one transaction together with the atomic claim of the
  // verified code (authenticator step or backup code).
  async function withSecondFactor(user, input, req, context, work) {
    const gate = await prepareFactor(user, input, req, context);
    try {
      return await transaction(client, async (session) => {
        await gate.claim(session);
        return work(session, gate.label);
      });
    } catch (error) {
      if (error.factorFailure) await recordFailure(user, input, req, context);
      throw error;
    }
  }
  // Runs inside the caller's transaction. Serializes concurrent sign-ins
  // through the staff document and keeps at most five sessions.
  async function createSession(session, row, { newHash, detail, req }) {
    const raw = token(),
      csrf = token();
    if (newHash) {
      row = await staff.findOneAndUpdate(
        { _id: row._id },
        {
          $set: { passwordHash: newHash, status: "active" },
          $inc: { authVersion: 1, revision: 1 },
        },
        { session, returnDocument: "after" },
      );
      await sessions.deleteMany({ staffId: row._id }, { session });
    }
    await staff.updateOne(
      { _id: row._id },
      { $set: { lastLoginAt: new Date() } },
      { session },
    );
    const old = await sessions
      .find({ staffId: row._id }, { session })
      .sort({ createdAt: -1 })
      .skip(4)
      .toArray();
    if (old.length)
      await sessions.deleteMany(
        { _id: { $in: old.map((s) => s._id) } },
        { session },
      );
    await sessions.insertOne(
      {
        _id: digest(raw),
        staffId: row._id,
        csrf,
        authVersion: row.authVersion,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + cookieOptions.maxAge),
      },
      { session },
    );
    await audit(
      db,
      session,
      row,
      newHash ? "access.recovered" : "session.created",
      "staff",
      row._id,
      detail,
      req,
    );
    return { row, raw, csrf };
  }
  const startedSession = (res, { row, raw, csrf }) =>
    res
      .cookie(cookieName, raw, cookieOptions)
      .json({ staff: publicStaff(row), csrf });
  router.post("/verify", async (req, res) => {
    const data = z
      .object({
        challengeId: z.string().min(20).max(100),
        code: z.string().regex(/^\d{6}$/),
        password: passwordSchema.optional(),
      })
      .strict()
      .parse(req.body);
    await consume(db, `verify-ip:${req.ip}`, 40, 900000);
    const challenge = await challenges.findOneAndUpdate(
      {
        _id: data.challengeId,
        purpose: { $in: ["login", "recovery"] },
        expiresAt: { $gt: new Date() },
        attempts: { $lt: 5 },
      },
      { $inc: { attempts: 1 } },
      { returnDocument: "after" },
    );
    ensure(
      challenge &&
        equal(
          challenge.codeHash,
          mac(c.AUTH_SECRET, `${data.challengeId}:${data.code}`),
        ),
      400,
      "Code is invalid, expired or has too many attempts.",
    );
    if (challenge.purpose === "recovery") passwordSchema.parse(data.password);
    const newHash =
      challenge.purpose === "recovery"
        ? await hashPassword(data.password)
        : null;
    const result = await transaction(client, async (session) => {
      const used = await challenges.deleteOne(
        { _id: challenge._id, codeHash: challenge.codeHash },
        { session },
      );
      ensure(used.deletedCount === 1, 400, "This code has already been used.");
      const row = await staff.findOne(
        {
          _id: challenge.staffId,
          authVersion: challenge.authVersion,
          status: {
            $in:
              challenge.purpose === "login"
                ? ["active"]
                : ["active", "invited"],
          },
        },
        { session },
      );
      ensure(row, 401, "Access changed. Request a new code.");
      if (row.totp?.enabledAt) {
        // No session yet. A recovery password stays parked in the challenge
        // and is applied only after the authenticator step succeeds.
        const totpChallenge = token();
        await challenges.insertOne(
          {
            _id: totpChallenge,
            staffId: row._id,
            purpose: "totp",
            authVersion: row.authVersion,
            attempts: 0,
            ...(newHash ? { pendingPasswordHash: newHash } : {}),
            expiresAt: new Date(Date.now() + TOTP_CHALLENGE_MS),
          },
          { session },
        );
        return { totpChallenge };
      }
      return createSession(session, row, {
        newHash,
        detail: newHash
          ? "Password reset with email code"
          : "Password and email code",
        req,
      });
    });
    if (result.totpChallenge)
      return res.json({
        totpRequired: true,
        challengeId: result.totpChallenge,
      });
    if (newHash) tellOf(result.row, "recovered");
    startedSession(res, result);
  });
  router.post("/verify-totp", async (req, res) => {
    const data = factorSchema({
      challengeId: z.string().min(20).max(100),
    }).parse(req.body);
    await consume(db, `verify-ip:${req.ip}`, 40, 900000);
    const challenge = await challenges.findOneAndUpdate(
      {
        _id: data.challengeId,
        purpose: "totp",
        expiresAt: { $gt: new Date() },
        attempts: { $lt: 5 },
      },
      { $inc: { attempts: 1 } },
      { returnDocument: "after" },
    );
    ensure(
      challenge,
      400,
      "Code is invalid, expired or has too many attempts.",
    );
    const user = await staff.findOne({
      _id: challenge.staffId,
      status: "active",
      authVersion: challenge.authVersion,
    });
    ensure(user?.totp?.enabledAt, 401, "Access changed. Sign in again.");
    // The code is claimed inside the same transaction that consumes the
    // challenge and creates the session, so a failed sign-in releases it.
    const result = await withSecondFactor(
      user,
      data,
      req,
      "login",
      async (session, factor) => {
        const used = await challenges.deleteOne(
          { _id: challenge._id },
          { session },
        );
        ensure(
          used.deletedCount === 1,
          400,
          "This code has already been used.",
        );
        const row = await staff.findOne(
          {
            _id: challenge.staffId,
            authVersion: challenge.authVersion,
            status: "active",
          },
          { session },
        );
        ensure(row?.totp?.enabledAt, 401, "Access changed. Sign in again.");
        return createSession(session, row, {
          newHash: challenge.pendingPasswordHash,
          detail: challenge.pendingPasswordHash
            ? `Password reset with email code and ${factor}`
            : `Password, email code and ${factor}`,
          req,
        });
      },
    );
    if (challenge.pendingPasswordHash) tellOf(result.row, "recovered");
    startedSession(res, result);
  });
  router.get("/me", requireAuth, (req, res) =>
    res.json({
      staff: {
        ...publicStaff(req.staff),
        backupCodesLeft: req.staff.totpBackupCodes?.length ?? 0,
        stepUpUntil: steppedUp(req.session) ? req.session.stepUpUntil : null,
      },
      csrf: req.session.csrf,
    }),
  );
  router.post("/step-up", requireAuth, async (req, res) => {
    const data = factorSchema().parse(req.body ?? {});
    ensure(
      req.staff.totp?.enabledAt,
      428,
      "Set up your authenticator in Account security first.",
    );
    const stepUpUntil = new Date(Date.now() + STEP_UP_MS);
    await withSecondFactor(
      req.staff,
      data,
      req,
      "step-up",
      async (session, factor) => {
        await sessions.updateOne(
          { _id: req.session._id },
          { $set: { stepUpUntil } },
          { session },
        );
        await audit(
          db,
          session,
          req.staff,
          "session.stepped-up",
          "staff",
          req.staff._id,
          `Confirmed with ${factor}`,
          req,
        );
      },
    );
    res.json({ stepUpUntil });
  });
  router.post("/totp/enrol/start", requireAuth, async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    await consume(db, `totp-enrol:${req.staff._id}`, 20, 900000);
    // Replacing a working authenticator needs step-up; a first enrolment
    // needs a recent sign-in so a stolen idle session cannot claim the account.
    if (req.staff.totp?.enabledAt) requireStepUp(req);
    else {
      const created = req.session.createdAt
        ? new Date(req.session.createdAt).getTime()
        : 0;
      ensure(
        created > Date.now() - ENROL_FRESH_MS,
        403,
        "Sign in again to set up the authenticator.",
      );
    }
    const key = generateKey();
    await staff.updateOne(
      { _id: req.staff._id },
      {
        $set: {
          totpPending: {
            key: boxKey(req.staff, "totpPending", key),
            expiresAt: new Date(Date.now() + PENDING_MS),
          },
        },
      },
    );
    const uri = otpauthUri(key, req.staff.email, ISSUER);
    res.json({ secret: base32Encode(key), uri, qrSvg: qrSvg(uri) });
  });
  router.post("/totp/enrol/confirm", requireAuth, async (req, res) => {
    const data = z
      .object({
        code: codeField,
        currentCode: codeField.optional(),
        currentBackupCode: z.string().min(10).max(32).optional(),
      })
      .strict()
      .parse(req.body);
    const user = req.staff,
      pending = user.totpPending,
      replacing = Boolean(user.totp?.enabledAt);
    await consume(db, `totp-enrol:${user._id}`, 20, 900000);
    ensure(
      !(await exceeded(db, `totp:${user._id}`, 10, 900000)),
      429,
      TOO_MANY,
    );
    ensure(!(await lockedOut(user)), 429, LOCK_MESSAGE);
    ensure(
      pending?.key && pending.expiresAt > new Date(),
      400,
      "Setup expired. Start again.",
    );
    // Replacing a working authenticator needs step-up AND proof of the old one.
    let current = null;
    if (replacing) {
      requireStepUp(req);
      ensure(
        (data.currentCode === undefined) !==
          (data.currentBackupCode === undefined),
        400,
        "Enter a code from your current authenticator, or one backup code.",
      );
      current =
        data.currentCode !== undefined
          ? { code: data.currentCode }
          : { backupCode: data.currentBackupCode };
    }
    const key = keyOf(user, "totpPending"),
      step = verifyTotp(key, data.code, Date.now());
    if (step === null) {
      await recordFailure(user, { code: data.code }, req, "enrol");
      throw new HttpError(400, BAD_CODE);
    }
    const gate = current
        ? await prepareFactor(user, current, req, "enrol")
        : null,
      backup = newBackupCodes(user._id),
      stepUpUntil = new Date(Date.now() + STEP_UP_MS);
    try {
      await transaction(client, async (session) => {
        await gate?.claim(session);
        await authorizeWrite(db, session, user, "read");
        const done = await staff.updateOne(
          {
            _id: user._id,
            authVersion: user.authVersion,
            "totpPending.key.iv": pending.key.iv,
            "totpPending.expiresAt": { $gt: new Date() },
          },
          {
            $set: {
              totp: {
                key: boxKey(user, "totp", key),
                enabledAt: new Date(),
                lastStep: step,
              },
              totpBackupCodes: backup.hashes,
            },
            $unset: { totpPending: "" },
            $inc: { revision: 1 },
          },
          { session },
        );
        ensure(done.matchedCount === 1, 409, "Setup changed. Start again.");
        await sessions.deleteMany(
          { staffId: user._id, _id: { $ne: req.session._id } },
          { session },
        );
        await sessions.updateOne(
          { _id: req.session._id },
          { $set: { stepUpUntil } },
          { session },
        );
        await audit(
          db,
          session,
          user,
          replacing ? "totp.replaced" : "totp.enabled",
          "staff",
          user._id,
          "",
          req,
        );
      });
    } catch (error) {
      if (error.factorFailure) await recordFailure(user, current, req, "enrol");
      throw error;
    }
    tellOf(user, replacing ? "replaced" : "enabled");
    res.json({ backupCodes: backup.display, stepUpUntil });
  });
  router.post(
    "/totp/backup-codes",
    requireAuth,
    requireStepUp,
    async (req, res) => {
      const backup = newBackupCodes(req.staff._id);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "read");
        const done = await staff.updateOne(
          {
            _id: req.staff._id,
            authVersion: req.staff.authVersion,
            "totp.enabledAt": { $exists: true },
          },
          { $set: { totpBackupCodes: backup.hashes } },
          { session },
        );
        ensure(done.matchedCount === 1, 409, "Authenticator changed. Reload.");
        await audit(
          db,
          session,
          req.staff,
          "totp.backup-codes-regenerated",
          "staff",
          req.staff._id,
          "",
          req,
        );
      });
      res.json({ backupCodes: backup.display });
    },
  );
  router.post("/totp/disable", requireAuth, async (req, res) => {
    ensure(
      req.staff.role !== "owner",
      409,
      "Owners must keep the authenticator enabled.",
    );
    requireStepUp(req);
    await transaction(client, async (session) => {
      await authorizeWrite(db, session, req.staff, "read");
      const done = await staff.updateOne(
        {
          _id: req.staff._id,
          authVersion: req.staff.authVersion,
          "totp.enabledAt": { $exists: true },
        },
        {
          $unset: { totp: "", totpPending: "", totpBackupCodes: "" },
          $inc: { revision: 1 },
        },
        { session },
      );
      ensure(done.matchedCount === 1, 409, "Authenticator changed. Reload.");
      await sessions.deleteMany(
        { staffId: req.staff._id, _id: { $ne: req.session._id } },
        { session },
      );
      await sessions.updateOne(
        { _id: req.session._id },
        { $unset: { stepUpUntil: "" } },
        { session },
      );
      await audit(
        db,
        session,
        req.staff,
        "totp.disabled",
        "staff",
        req.staff._id,
        "",
        req,
      );
    });
    tellOf(req.staff, "disabled");
    res.json({ ok: true });
  });
  router.post("/logout", requireAuth, async (req, res) => {
    await sessions.deleteOne({ _id: req.session._id });
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  router.post("/revoke-sessions", requireAuth, async (req, res) => {
    await transaction(client, async (session) => {
      await staff.updateOne(
        { _id: req.staff._id },
        { $inc: { authVersion: 1 } },
        { session },
      );
      await sessions.deleteMany({ staffId: req.staff._id }, { session });
      await audit(
        db,
        session,
        req.staff,
        "sessions.revoked",
        "staff",
        req.staff._id,
        "",
        req,
      );
    });
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  return { router, requireAuth, permit, requireStepUp };
}
