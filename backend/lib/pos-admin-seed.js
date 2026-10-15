// Seeds the POS admin login in a client's own database (D45). A port of the
// POS's scripts/seed-admin.ts: only when no staff has role "admin"; an existing
// admin is never touched. Writes exactly the fields the POS's Staff model
// (mongoose timestamps) stores into the `staffs` collection; the password is a
// bcryptjs hash, cost 12 (the POS's own library, so its login accepts it).
// Atlas only (client-mongo.js). Errors carry a fixed code; the URI, the
// username and the password never reach a message, a property or a log.
import bcrypt from "bcryptjs";
import { openClientDb } from "./client-mongo.js";

export const STAFF_COLLECTION = "staffs";
export const BCRYPT_COST = 12;
export class AdminSeedError extends Error {
  constructor(reason = "failed") {
    super("POS admin login could not be set up (admin-seed-failed)");
    this.name = "AdminSeedError";
    this.code = "admin-seed-failed";
    // client-mongo's own fixed tokens (not-atlas, auth-failed, unreachable,
    // invalid) or "failed" / "weak-password" / "name-taken".
    this.reason = reason;
  }
}
// seed-admin.ts's strength rule.
export const strongPassword = (password) =>
  typeof password === "string" &&
  password.length >= 8 &&
  password.length <= 72 &&
  /\d/.test(password) &&
  /[^A-Za-z0-9]/.test(password);
const usernameOf = (value) => {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  return name && name.length <= 100 ? name : "";
};
async function withDb(uri, open, clientOptions, fn) {
  let opened;
  try {
    opened = await open(uri, clientOptions);
    return await fn(opened.db.collection(STAFF_COLLECTION));
  } catch (error) {
    if (error instanceof AdminSeedError) throw error;
    const reason =
      typeof error?.code === "string" && /^[a-z-]{1,20}$/.test(error.code)
        ? error.code
        : "failed";
    throw new AdminSeedError(reason);
  } finally {
    await opened?.client.close().catch(() => {});
  }
}
// -> {state: "exists" | "seeded"}. "exists": some admin was already there
// (nothing changed) or another seed won a race (ours is removed again).
// Throws AdminSeedError.
export async function seedPosAdmin({
  uri,
  username,
  password,
  open = openClientDb,
  clientOptions = {},
  now = () => new Date(),
}) {
  const name = usernameOf(username);
  if (!name) throw new AdminSeedError("failed");
  if (!strongPassword(password)) throw new AdminSeedError("weak-password");
  return withDb(uri, open, clientOptions, async (staffs) => {
    if (await staffs.findOne({ role: "admin" }, { projection: { _id: 1 } }))
      return { state: "exists" };
    // A non-admin staff already uses the name: seed-admin.ts would fail on
    // the unique username, and so do we (nothing is changed).
    if (await staffs.findOne({ username: name }, { projection: { _id: 1 } }))
      throw new AdminSeedError("name-taken");
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const at = now();
    // One atomic upsert keyed on the role, so two seeds at once insert one
    // document; if the database has no unique index and both still insert,
    // the lower _id wins and the other removes its own row.
    let result;
    try {
      result = await staffs.updateOne(
        { role: "admin" },
        {
          $setOnInsert: {
            name: "Admin",
            username: name,
            mobile: "0000000000",
            password: hash,
            role: "admin",
            isActive: true,
            createdAt: at,
            updatedAt: at,
            __v: 0,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (error?.code === 11000) {
        if (await staffs.findOne({ role: "admin" }, { projection: { _id: 1 } }))
          return { state: "exists" };
        throw new AdminSeedError("name-taken");
      }
      throw error;
    }
    if (!result.upsertedId) return { state: "exists" };
    const mine = result.upsertedId;
    const admins = await staffs
      .find({ role: "admin" }, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(2)
      .toArray();
    if (admins.length > 1 && String(admins[0]._id) !== String(mine)) {
      await staffs.deleteOne({ _id: mine });
      return { state: "exists" };
    }
    const stored = await staffs.findOne({ _id: mine });
    let same = false;
    try {
      same =
        typeof stored?.password === "string" &&
        (await bcrypt.compare(password, stored.password));
    } catch {
      same = false;
    }
    if (!same) {
      await staffs.deleteOne({ _id: mine }).catch(() => {});
      throw new AdminSeedError("failed");
    }
    return { state: "seeded" };
  });
}
// Read-only: {adminExists, userFound, passwordMatches}. userFound = an admin
// with that username; passwordMatches (null unless found) = the stored hash
// matches `password`. Throws AdminSeedError.
export async function checkPosAdmin({
  uri,
  username,
  password,
  open = openClientDb,
  clientOptions = {},
}) {
  const name = usernameOf(username);
  if (!name || typeof password !== "string" || !password)
    throw new AdminSeedError("failed");
  return withDb(uri, open, clientOptions, async (staffs) => {
    const adminExists = Boolean(
      await staffs.findOne({ role: "admin" }, { projection: { _id: 1 } }),
    );
    const user = await staffs.findOne(
      { username: name, role: "admin" },
      { projection: { password: 1 } },
    );
    let passwordMatches = null;
    if (user) {
      try {
        passwordMatches =
          typeof user.password === "string" &&
          (await bcrypt.compare(password, user.password));
      } catch {
        passwordMatches = false;
      }
    }
    return { adminExists, userFound: Boolean(user), passwordMatches };
  });
}
