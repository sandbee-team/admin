import { Router } from "express";
import { randomInt } from "node:crypto";
import { z } from "zod";
import {
  token,
  digest,
  mac,
  equal,
  hashPassword,
  verifyPassword,
} from "../lib/crypto.js";
import { ensure, HttpError } from "../lib/errors.js";
import { consume } from "../lib/limiter.js";
import { audit } from "../lib/audit.js";
import { transaction } from "../db.js";
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
});
export function authModule({ db, client, c, sendCode }) {
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
    if (!["/login", "/verify", "/recover"].includes(req.path)) return next();
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
  async function requireAuth(req, _res, next) {
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
    const raw = token(),
      csrf = token();
    const user = await transaction(client, async (session) => {
      const used = await challenges.deleteOne(
        { _id: challenge._id, codeHash: challenge.codeHash },
        { session },
      );
      ensure(used.deletedCount === 1, 400, "This code has already been used.");
      let row = await staff.findOne(
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
      // Serialize concurrent sign-ins through the staff document and keep at most five sessions.
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
      );
      return row;
    });
    res
      .cookie(cookieName, raw, cookieOptions)
      .json({ staff: publicStaff(user), csrf });
  });
  router.get("/me", requireAuth, (req, res) =>
    res.json({ staff: publicStaff(req.staff), csrf: req.session.csrf }),
  );
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
      );
    });
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  return { router, requireAuth, permit };
}
