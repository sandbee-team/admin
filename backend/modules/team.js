import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { publicStaff } from "./auth.js";
import { authorizeWrite } from "./records.js";
import { transaction } from "../db.js";
import { audit } from "../lib/audit.js";
import { ensure } from "../lib/errors.js";
export function teamRoutes({ db, client, auth }) {
  const router = Router();
  router.use(auth.requireAuth);
  router.get("/", async (_req, res) => {
    const rows = await db
      .collection("staff")
      .find({}, { projection: { passwordHash: 0 } })
      .sort({ createdAt: 1 })
      .limit(200)
      .toArray();
    res.json({ rows: rows.map(publicStaff) });
  });
  router.post("/", auth.permit("team"), async (req, res) => {
    const data = z
      .object({
        name: z.string().trim().min(2).max(100),
        email: z
          .email()
          .max(254)
          .transform((v) => v.toLowerCase()),
        role: z.enum(["admin", "operations", "viewer"]),
      })
      .strict()
      .parse(req.body);
    const row = {
      ...data,
      _id: randomUUID(),
      status: "invited",
      authVersion: 1,
      revision: 1,
      createdAt: new Date(),
    };
    await transaction(client, async (session) => {
      await authorizeWrite(db, session, req.staff, "team");
      ensure(
        (await db.collection("staff").countDocuments({}, { session })) < 200,
        409,
        "Staff limit reached. Review existing access.",
      );
      await db.collection("staff").insertOne(row, { session });
      await audit(
        db,
        session,
        req.staff,
        "staff.invited",
        "staff",
        row._id,
        row.role,
      );
    });
    res.status(201).json(publicStaff(row));
  });
  router.patch("/:id", auth.permit("team"), async (req, res) => {
    const data = z
      .object({
        revision: z.number().int().min(1),
        role: z.enum(["admin", "operations", "viewer"]),
        status: z.enum(["active", "disabled"]),
      })
      .strict()
      .parse(req.body);
    await transaction(client, async (session) => {
      await authorizeWrite(db, session, req.staff, "team");
      const user = await db
        .collection("staff")
        .findOne({ _id: req.params.id, revision: data.revision }, { session });
      ensure(
        user && user.role !== "owner" && user._id !== req.staff._id,
        409,
        "Cannot change this account. Reload to see its current state.",
      );
      const status =
        data.status === "active" && !user.passwordHash
          ? "invited"
          : data.status;
      await db.collection("staff").updateOne(
        { _id: user._id, revision: data.revision },
        {
          $set: { role: data.role, status },
          $inc: { revision: 1, authVersion: 1 },
        },
        { session },
      );
      await db
        .collection("sessions")
        .deleteMany({ staffId: user._id }, { session });
      await audit(
        db,
        session,
        req.staff,
        "staff.access-changed",
        "staff",
        user._id,
        `${data.role} / ${status}`,
      );
    });
    res.json({ ok: true });
  });
  return router;
}
