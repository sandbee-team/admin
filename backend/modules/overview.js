import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { transaction } from "../db.js";
import { audit } from "../lib/audit.js";
import { authorizeWrite } from "./records.js";
import { can } from "../../shared/policy.js";
import { WORKER_ONLINE_MS } from "../../shared/deploy.js";
import { keyFingerprint } from "../lib/crypto.js";
import { backupKeyInfo } from "../config.js";
import { drillState, latestKeyChecks } from "../lib/recovery-tasks.js";
// IP and user agent are for staff who manage the team only.
const withoutNetwork = ({ ip, userAgent, ...row }) => row;
export function overviewRoutes({ db, client, c, auth, cache, storeDb }) {
  const router = Router();
  router.use(auth.requireAuth);
  router.get("/overview", async (req, res) => {
    let data = cache.get("overview");
    if (!data) {
      const [
        customers,
        products,
        installations,
        tasks,
        activity,
        overdue,
        connections,
        latestRecovery,
        posFailed,
        posUnverified,
        posLocked,
        posWorker,
      ] = await Promise.all([
        db
          .collection("customers")
          .countDocuments({ status: { $ne: "archived" } }),
        db.collection("products").countDocuments({ status: "active" }),
        db
          .collection("installations")
          .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }], {
            maxTimeMS: 4000,
          })
          .toArray(),
        db
          .collection("tasks")
          .find({ status: { $ne: "done" } })
          .sort({ dueAt: 1, updatedAt: -1 })
          .limit(5)
          .toArray(),
        db
          .collection("audit_events")
          .find({})
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray(),
        db.collection("tasks").countDocuments({
          status: { $ne: "done" },
          dueAt: { $ne: "", $lt: new Date().toISOString().slice(0, 10) },
        }),
        db.collection("connections").countDocuments({
          $or: [
            { status: "attention" },
            {
              status: { $ne: "revoked" },
              expiresAt: {
                $ne: "",
                $lte: new Date(Date.now() + 7 * 86400000)
                  .toISOString()
                  .slice(0, 10),
              },
            },
          ],
        }),
        db.collection("recovery_checks").findOne(
          { type: { $ne: "key-check" } },
          // Every role reads /overview: expose only the drill date.
          { sort: { createdAt: -1 }, projection: { _id: 0, restoredAt: 1 } },
        ),
        // POS deploy attention: counts only, no installation detail.
        db.collection("installations").countDocuments({
          "pos.deploy.current.status": {
            $in: ["failed", "unhealthy", "rolled-back", "expired"],
          },
        }),
        db.collection("installations").countDocuments({
          pos: { $exists: true },
          status: { $ne: "retired" },
          $or: ["vercel", "project", "env", "mongo", "health"].map((key) => ({
            [`pos.verify.${key}`]: { $ne: "ok" },
          })),
        }),
        db.collection("installations").countDocuments({
          pos: { $exists: true },
          status: { $ne: "retired" },
          "pos.deployLock": { $ne: false },
        }),
        db
          .collection("system_state")
          .findOne({ _id: "pos-worker" }, { projection: { _id: 0, at: 1 } }),
      ]);
      data = {
        customers,
        products,
        installations,
        tasks,
        activity,
        overdue,
        connections,
        latestRecovery,
        pos: {
          failed: posFailed,
          unverified: posUnverified,
          locked: posLocked,
          workerOnline:
            posWorker?.at instanceof Date &&
            Date.now() - posWorker.at.getTime() < WORKER_ONLINE_MS,
        },
        asOf: new Date(),
      };
      cache.set("overview", data);
    }
    // The cached summary keeps full rows; strip per viewer at response time.
    res.json(
      can(req.staff.role, "team")
        ? data
        : { ...data, activity: data.activity.map(withoutNetwork) },
    );
  });
  router.get("/options/:kind", async (req, res) => {
    const kind = z
      .enum(["customers", "products", "installations", "connections", "staff"])
      .parse(req.params.kind);
    const { search, customerId } = z
      .object({
        search: z.string().max(100).default(""),
        customerId: z.union([z.uuid(), z.literal("")]).default(""),
      })
      .strict()
      .parse(req.query);
    const filter = { ...(customerId ? { customerId } : {}) };
    if (search)
      filter.name = {
        $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    if (kind === "staff") filter.status = "active";
    const rows = await db
      .collection(kind)
      .find(filter, {
        projection: { _id: 1, name: 1, provider: 1, customerId: 1, status: 1 },
      })
      .sort({ name: 1 })
      .limit(100)
      .maxTimeMS(4000)
      .toArray();
    res.json({ rows, limited: rows.length === 100 });
  });
  router.get("/audit", async (req, res) => {
    const seeNetwork = can(req.staff.role, "team");
    const { page, customerId } = z
      .object({
        page: z.coerce.number().int().min(1).max(10000).default(1),
        customerId: z.union([z.uuid(), z.literal("")]).default(""),
      })
      .parse({ page: req.query.page, customerId: req.query.customerId });
    // A customer's trail is its own events plus those of its installations.
    let filter = {};
    if (customerId) {
      const installations = await db
        .collection("installations")
        .find({ customerId }, { projection: { _id: 1 } })
        .limit(50)
        .toArray();
      filter = {
        resourceId: { $in: [customerId, ...installations.map((i) => i._id)] },
      };
    }
    const [rows, total] = await Promise.all([
      db
        .collection("audit_events")
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * 30)
        .limit(30)
        .maxTimeMS(4000)
        .toArray(),
      // The trail only grows: an exact count walks it, so use collection
      // metadata unless a filter makes the count meaningful.
      customerId
        ? db
            .collection("audit_events")
            .countDocuments(filter, { maxTimeMS: 4000 })
        : db
            .collection("audit_events")
            .estimatedDocumentCount({ maxTimeMS: 4000 }),
    ]);
    res.json({
      rows: seeNetwork ? rows : rows.map(withoutNetwork),
      total,
      page,
      pageSize: 30,
    });
  });
  router.get("/recovery", auth.permit("recovery"), async (_req, res) => {
    const drills = { type: { $ne: "key-check" } },
      backup = backupKeyInfo(c),
      vaultFingerprint = keyFingerprint(c.VAULT_KEY),
      backupFingerprint = backup.key ? keyFingerprint(backup.key) : null,
      [rows, last, checks] = await Promise.all([
        db
          .collection("recovery_checks")
          .find(drills)
          .sort({ createdAt: -1 })
          .limit(20)
          .toArray(),
        db
          .collection("recovery_checks")
          .findOne(drills, { sort: { restoredAt: -1 } }),
        latestKeyChecks(db),
      ]),
      current = { vault: vaultFingerprint, backup: backupFingerprint };
    // A check only counts while it matches the key in use today.
    for (const kind of Object.keys(checks))
      for (const copy of Object.keys(checks[kind]))
        if (checks[kind][copy])
          checks[kind][copy].current =
            checks[kind][copy].fingerprint === current[kind];
    res.json({
      rows,
      keys: {
        vault: { fingerprint: vaultFingerprint },
        backup: { fingerprint: backupFingerprint, state: backup.state },
      },
      keyChecks: checks,
      drillStatus: drillState(last?.restoredAt),
      environment: c.NODE_ENV,
      storeConfigured: Boolean(storeDb),
    });
  });
  router.post("/recovery", auth.permit("recovery"), async (req, res) => {
    const data = z
      .object({
        location: z.string().trim().min(3).max(200),
        sourceRevision: z.string().trim().min(3).max(160),
        restoredAt: z.iso
          .date()
          .refine(
            (value) => value <= new Date().toISOString().slice(0, 10),
            "A restore drill cannot be in the future.",
          ),
        notes: z.string().trim().min(15).max(2000),
        keyStoredSeparately: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const row = {
      ...data,
      _id: randomUUID(),
      recordedBy: req.staff.name,
      createdAt: new Date(),
      type: "operator-attestation",
    };
    await transaction(client, async (session) => {
      await authorizeWrite(db, session, req.staff, "recovery");
      await db.collection("recovery_checks").insertOne(row, { session });
      await audit(
        db,
        session,
        req.staff,
        "recovery.recorded",
        "recovery_checks",
        row._id,
        "",
        req,
      );
    });
    cache.clear();
    res.status(201).json(row);
  });
  router.get("/store", async (_req, res) => {
    if (!storeDb)
      return res.json({
        connected: false,
        reason: "A read-only Store connection has not been configured.",
      });
    const [users, workspaces, recent] = await Promise.all([
      storeDb.collection("users").countDocuments({}, { maxTimeMS: 3000 }),
      storeDb.collection("workspaces").countDocuments({}, { maxTimeMS: 3000 }),
      storeDb
        .collection("workspaces")
        .find({}, { projection: { _id: 1, name: 1, createdAt: 1 } })
        .sort({ createdAt: -1 })
        .limit(20)
        .maxTimeMS(3000)
        .toArray(),
    ]);
    res.json({ connected: true, readOnly: true, users, workspaces, recent });
  });
  return router;
}
