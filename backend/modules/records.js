import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { schemas, listQuery } from "../../shared/schemas.js";
import { TRANSITIONS, can } from "../../shared/policy.js";
import { modelFor, providersFor } from "../../shared/product-models.js";
import { ensure, staleError } from "../lib/errors.js";
import { encrypt } from "../lib/crypto.js";
import { audit } from "../lib/audit.js";
import { transaction } from "../db.js";

export async function authorizeWrite(db, session, actor, permission) {
  const current = await db.collection("staff").findOneAndUpdate(
    {
      _id: actor._id,
      status: "active",
      authVersion: actor.authVersion,
      role: actor.role,
    },
    { $inc: { operationSequence: 1 } },
    { session, returnDocument: "after" },
  );
  ensure(
    current && can(current.role, permission),
    403,
    "Your access changed. Refresh and try again.",
  );
}
const permissionFor = (name) =>
  name === "products"
    ? "catalog"
    : name === "connections"
      ? "credentials"
      : "operate";
// Embedded vault blocks are owned by their own modules and never leave through
// the generic record API.
const scrub = (row) => {
  if (!row) return row;
  // eslint-disable-next-line no-unused-vars
  const { secret, accounts, files, pos, ...safe } = row;
  return {
    ...safe,
    ...(Object.hasOwn(row, "secret") ? { hasCredential: Boolean(secret) } : {}),
  };
};
export function recordRoutes({ db, client, c, auth, cache }) {
  const router = Router();
  router.use(auth.requireAuth);
  async function validateReferences(kind, data, old, session) {
    if (data.customerId)
      ensure(
        await db
          .collection("customers")
          .findOne({ _id: data.customerId }, { session }),
        400,
        "Customer does not exist.",
      );
    if (kind === "installations") {
      const product = await db
        .collection("products")
        .findOne({ _id: data.productId }, { session });
      ensure(product, 400, "Product does not exist.");
      const model = modelFor(product);
      // Serialize model changes with installation writes, preventing a new
      // installation from racing a product's delivery-policy update.
      await db
        .collection("products")
        .updateOne(
          { _id: product._id },
          { $inc: { installationRevision: 1 } },
          { session },
        );
      if (!old)
        ensure(
          product.status !== "retired" && data.status === "planned",
          400,
          "New installations must be planned for an available product.",
        );
      if (old) {
        ensure(
          data.customerId === old.customerId &&
            data.productId === old.productId &&
            data.environment === old.environment,
          400,
          "Customer, product and environment cannot change after creation.",
        );
        ensure(
          data.status === old.status ||
            TRANSITIONS[old.status].includes(data.status),
          400,
          "This lifecycle transition is not allowed.",
        );
      }
      const connections = await db
        .collection("connections")
        .find(
          { _id: { $in: data.connectionIds }, customerId: data.customerId },
          { session },
        )
        .toArray();
      ensure(
        new Set(data.connectionIds).size === data.connectionIds.length &&
          connections.length === data.connectionIds.length,
        400,
        "Connections must belong to this customer.",
      );
      if (["ready", "live"].includes(data.status)) {
        ensure(
          (!model.releaseRequired || data.release) &&
            (!model.sourceRequired || data.sourceUrl) &&
            model.checks
              .filter((key) => !["verification", "handover"].includes(key))
              .every((key) => data.checks.includes(key)),
          400,
          `Complete ownership and preparation checks for ${model.label.toLowerCase()}${model.releaseRequired ? ", including its version and source URL" : ""}.`,
        );
        ensure(
          connections.every((row) => row.status !== "revoked"),
          400,
          "Remove revoked provider connections.",
        );
        ensure(
          providersFor(product).every((provider) =>
            connections.some(
              (row) =>
                row.provider === provider &&
                (product.model !== "customer-deployment" ||
                  row.ownership === "customer"),
            ),
          ),
          400,
          "Link the required provider records for this product. Customer deployments require customer-owned accounts.",
        );
      }
      if (data.status === "live")
        ensure(
          (!model.endpointRequired || data.endpoint) &&
            data.evidence.trim().length >= 15 &&
            model.checks.every((check) => data.checks.includes(check)),
          400,
          `Live status requires the ${model.label.toLowerCase()} checks, verification evidence${model.endpointRequired ? " and an endpoint" : ""}.`,
        );
    }
    if (kind === "tasks") {
      if (data.assigneeId)
        ensure(
          await db
            .collection("staff")
            .findOne({ _id: data.assigneeId, status: "active" }, { session }),
          400,
          "Choose an active staff member.",
        );
      if (data.installationId)
        ensure(
          await db.collection("installations").findOne(
            {
              _id: data.installationId,
              ...(data.customerId ? { customerId: data.customerId } : {}),
            },
            { session },
          ),
          400,
          "Installation does not match the customer.",
        );
    }
    if (kind === "connections" && old)
      ensure(
        data.customerId === old.customerId,
        400,
        "Connection ownership cannot be reassigned.",
      );
    if (kind === "products" && old)
      ensure(
        data.slug === old.slug,
        400,
        "Product identifiers cannot change after creation.",
      );
    if (
      kind === "products" &&
      old &&
      (data.model !== old.model ||
        JSON.stringify([...data.requiredProviders].sort()) !==
          JSON.stringify([...providersFor(old)].sort()))
    ) {
      ensure(
        !(await db
          .collection("installations")
          .findOne(
            { productId: old._id, status: { $ne: "retired" } },
            { session },
          )),
        409,
        "This product has active installation records. Retire them before changing its delivery model or required providers.",
      );
    }
  }
  for (const [kind, schema] of Object.entries(schemas)) {
    router.get(`/${kind}`, async (req, res) => {
      const { page, search, status, customerId, productId, model } =
        listQuery.parse(req.query);
      const filter = {};
      if (status) filter.status = status;
      if (customerId) filter.customerId = customerId;
      if (productId) filter.productId = productId;
      if (model) filter.model = model;
      if (search)
        filter[kind === "tasks" ? "title" : "name"] = {
          $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          $options: "i",
        };
      const [rows, total] = await Promise.all([
        db
          .collection(kind)
          .find(filter, {
            projection: { secret: 0, accounts: 0, files: 0, pos: 0 },
          })
          .sort({ updatedAt: -1, _id: -1 })
          .skip((page - 1) * 30)
          .limit(30)
          .maxTimeMS(4000)
          .toArray(),
        db.collection(kind).countDocuments(filter, { maxTimeMS: 4000 }),
      ]);
      res.json({ rows, total, page, pageSize: 30 });
    });
    router.get(`/${kind}/:id`, async (req, res) => {
      z.uuid().parse(req.params.id);
      const row = await db.collection(kind).findOne({ _id: req.params.id });
      ensure(row, 404, "Record not found.");
      res.json(scrub(row));
    });
    router.post(
      `/${kind}`,
      auth.permit(permissionFor(kind)),
      async (req, res) => {
        const data = schema.parse(req.body);
        const row = {
          ...data,
          _id: randomUUID(),
          revision: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await transaction(client, async (session) => {
          await authorizeWrite(db, session, req.staff, permissionFor(kind));
          await validateReferences(kind, data, null, session);
          await db.collection(kind).insertOne(row, { session });
          await audit(
            db,
            session,
            req.staff,
            "record.created",
            kind,
            row._id,
            data.name || data.title,
            req,
          );
        });
        cache.clear();
        res.status(201).json(row);
      },
    );
    router.put(
      `/${kind}/:id`,
      auth.permit(permissionFor(kind)),
      async (req, res) => {
        z.uuid().parse(req.params.id);
        const { revision, ...data } = schema
          .extend({ revision: z.number().int().min(1) })
          .parse(req.body);
        const row = await transaction(client, async (session) => {
          await authorizeWrite(db, session, req.staff, permissionFor(kind));
          const old = await db
            .collection(kind)
            .findOne({ _id: req.params.id, revision }, { session });
          if (!old)
            throw staleError("This record changed. Reload it before saving.");
          await validateReferences(kind, data, old, session);
          const updated = await db.collection(kind).findOneAndUpdate(
            { _id: old._id, revision },
            {
              $set: { ...data, updatedAt: new Date() },
              $inc: { revision: 1 },
            },
            { session, returnDocument: "after" },
          );
          if (!updated)
            throw staleError("This record changed. Reload it before saving.");
          await audit(
            db,
            session,
            req.staff,
            "record.updated",
            kind,
            old._id,
            old.status !== data.status
              ? `${old.status} → ${data.status}`
              : "Details updated",
            req,
          );
          return scrub(updated);
        });
        cache.clear();
        res.json(row);
      },
    );
  }
  router.put(
    "/connections/:id/credential",
    auth.permit("credentials"),
    async (req, res) => {
      z.uuid().parse(req.params.id);
      const { credential, revision } = z
        .object({
          credential: z.string().min(8).max(16000),
          revision: z.number().int().min(1),
        })
        .strict()
        .parse(req.body);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        const updated = await db.collection("connections").updateOne(
          { _id: req.params.id, revision },
          {
            $set: {
              secret: encrypt(
                credential,
                c.VAULT_KEY,
                `connection:${req.params.id}`,
              ),
              hasCredential: true,
              credentialUpdatedAt: new Date(),
              updatedAt: new Date(),
            },
            $inc: { revision: 1 },
          },
          { session },
        );
        if (!updated.matchedCount)
          throw staleError(
            "Record changed. Reload before updating the credential.",
          );
        await audit(
          db,
          session,
          req.staff,
          "credential.replaced",
          "connections",
          req.params.id,
          "",
          req,
        );
      });
      res.json({ ok: true });
    },
  );
  router.delete(
    "/connections/:id/credential",
    auth.permit("credentials"),
    async (req, res) => {
      const { revision } = z
        .object({ revision: z.number().int().min(1) })
        .strict()
        .parse(req.body);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        const result = await db.collection("connections").updateOne(
          { _id: req.params.id, revision },
          {
            $unset: { secret: "" },
            $set: { hasCredential: false, updatedAt: new Date() },
            $inc: { revision: 1 },
          },
          { session },
        );
        if (!result.matchedCount)
          throw staleError(
            "Record changed. Reload before removing the credential.",
          );
        await audit(
          db,
          session,
          req.staff,
          "credential.removed",
          "connections",
          req.params.id,
          "",
          req,
        );
      });
      res.json({ ok: true });
    },
  );
  return router;
}
