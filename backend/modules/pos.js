import { Router } from "express";
import { z } from "zod";
import { posSchemas, POS_SECRET_FIELDS } from "../../shared/schemas.js";
import { HttpError, ensure, staleError } from "../lib/errors.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { audit } from "../lib/audit.js";
import { consume } from "../lib/limiter.js";
import { transaction } from "../db.js";
import { authorizeWrite } from "./records.js";
import {
  deployView,
  nextPublicView,
  taskView,
  verifyView,
} from "../lib/deploy-view.js";
import { jobBlocks, taskBlocks } from "../../shared/deploy.js";

// Settings that a running job reads are frozen while it is active.
const JOB_FIELDS = ["vercel.token", "mongo.uri", "cloudflare.token"];
export const busyError = (message) => {
  const error = new HttpError(409, message);
  error.apiCode = "busy";
  return error;
};
// 409 error for a gate that names readiness item ids (shared with deploys.js).
export const notReadyError = (items) => {
  const error = new HttpError(409, "This client is not ready yet.");
  error.apiCode = "not-ready";
  error.items = items;
  return error;
};
// What "verify" checks: changing any of these makes the last verify stale.
const verifyFingerprint = (x) =>
  JSON.stringify([
    x.host ?? "",
    x.tenantId ?? "",
    x.rootDomain ?? "",
    [
      x.vercel?.projectId ?? "",
      x.vercel?.orgId ?? "",
      x.vercel?.teamId ?? "",
      x.vercel?.projectName ?? "",
    ],
    x.cloudflare
      ? [
          x.cloudflare.accountId ?? "",
          x.cloudflare.workerName ?? "",
          x.cloudflare.workerUrl ?? "",
        ]
      : null,
    [
      x.image?.store ?? null,
      x.image?.publicBaseUrl ?? "",
      x.image?.cloudName ?? "",
      x.image?.r2AccountId ?? "",
      x.image?.bucket ?? "",
    ],
  ]);
// Secrets a verify reads: replacing or removing one also invalidates it.
const VERIFY_SECRETS = ["vercel.token", "mongo.uri", "cloudflare.token"];
const at = (object, path) =>
  path.split(".").reduce((value, part) => value?.[part], object);
export const changedKey = (field) => field.replace(".", "_");
export const aadOf = (installationId, field) =>
  `pos:${installationId}:${field}`;
// NEXT_PUBLIC_* values are derived here from the image settings and are never
// accepted from the client.
const nextPublic = (image) =>
  image.store === "r2"
    ? { NEXT_PUBLIC_R2_PUBLIC_BASE_URL: image.publicBaseUrl }
    : image.store === "cloudinary"
      ? { NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: image.cloudName }
      : {};
// Whitelist view: configuration plus {set, changedAt} per secret, never a box.
export const posView = (pos) => ({
  rev: pos.rev,
  slug: pos.slug,
  subdomain: pos.subdomain,
  host: pos.host,
  tenantId: pos.tenantId,
  rootDomain: pos.rootDomain,
  deployLock: pos.deployLock,
  vercel: {
    projectId: pos.vercel?.projectId ?? "",
    orgId: pos.vercel?.orgId ?? "",
    teamId: pos.vercel?.teamId ?? "",
    projectName: pos.vercel?.projectName ?? "",
  },
  cloudflare: pos.cloudflare
    ? {
        accountId: pos.cloudflare.accountId ?? "",
        workerName: pos.cloudflare.workerName ?? "",
        workerUrl: pos.cloudflare.workerUrl ?? "",
      }
    : null,
  image: {
    store: pos.image?.store ?? null,
    publicBaseUrl: pos.image?.publicBaseUrl ?? "",
    cloudName: pos.image?.cloudName ?? "",
    r2AccountId: pos.image?.r2AccountId ?? "",
    bucket: pos.image?.bucket ?? "",
  },
  posAdmin: { username: pos.posAdmin?.username ?? "" },
  build: { nextPublic: nextPublicView(pos.build?.nextPublic) },
  // Lease, fence, object keys and run ids never leave the server (deployView).
  deploy: deployView(pos.deploy),
  task: taskView(pos.task),
  verify: verifyView(pos.verify),
  secrets: Object.fromEntries(
    POS_SECRET_FIELDS.map((field) => [
      field,
      {
        set: Boolean(at(pos, field)),
        changedAt: pos.secretsChangedAt?.[changedKey(field)] ?? null,
      },
    ]),
  ),
  importedAt: pos.importedAt ?? null,
});
export const newPos = (config) => ({
  rev: 1,
  slug: config.slug,
  subdomain: config.subdomain,
  host: config.host,
  tenantId: config.tenantId,
  rootDomain: config.rootDomain,
  // Always locked: only the owner-only unlock route can change it.
  deployLock: true,
  vercel: { ...config.vercel, token: null },
  mongo: { uri: null },
  cloudflare: config.cloudflare ? { ...config.cloudflare, token: null } : null,
  image: { ...config.image, keys: null },
  generated: {
    authSecret: null,
    healthStatsToken: null,
    realtimePublishSecret: null,
  },
  posAdmin: { username: config.posAdmin.username, password: null },
  build: { nextPublic: nextPublic(config.image) },
  deploy: { current: null, last: null, previous: null, cutoverAt: null },
  secretsChangedAt: {},
  importedAt: null,
  importedBy: null,
});
// Dotted paths for every non-secret field: a config save can never touch a box.
function configPaths(config) {
  const set = {
    "pos.slug": config.slug,
    "pos.subdomain": config.subdomain,
    "pos.host": config.host,
    "pos.tenantId": config.tenantId,
    "pos.rootDomain": config.rootDomain,
    "pos.build.nextPublic": nextPublic(config.image),
    "pos.posAdmin.username": config.posAdmin.username,
  };
  for (const [k, v] of Object.entries(config.vercel))
    set[`pos.vercel.${k}`] = v;
  for (const [k, v] of Object.entries(config.image)) set[`pos.image.${k}`] = v;
  return set;
}
export function posRoutes({ db, client, c, auth }) {
  const router = Router(),
    installations = db.collection("installations");
  router.use(auth.requireAuth);
  const iid = (req) => z.uuid().parse(req.params.id);
  // 409 busy while a deploy job or a task (verify, purge, backup) is active.
  async function idle(pos, session) {
    const worker = await db
      .collection("system_state")
      .findOne({ _id: "pos-worker" }, { session, projection: { at: 1 } });
    const workerAt = worker?.at ?? null;
    const now = Date.now();
    if (jobBlocks(pos.deploy?.current, now, workerAt))
      throw busyError(
        "A deploy is running for this installation. Wait for it to finish or cancel it.",
      );
    if (taskBlocks(pos.task, now, workerAt))
      throw busyError(
        "A task is running for this installation. Wait for it to finish.",
      );
  }
  // Loads the installation and requires the POS product (looked up by slug).
  async function load(id, session) {
    const row = await installations.findOne(
      { _id: id },
      { session, projection: { productId: 1, pos: 1 } },
    );
    ensure(row, 404, "Installation not found.");
    const product = await db
      .collection("products")
      .findOne({ _id: row.productId }, { session, projection: { slug: 1 } });
    ensure(
      product?.slug === "pos",
      400,
      "POS settings are only available for POS installations.",
    );
    return row;
  }
  const requirePos = (row, rev) => {
    ensure(row.pos, 404, "POS settings have not been set up.");
    if (rev !== undefined && row.pos.rev !== rev)
      throw staleError("POS settings changed. Reload and try again.");
    return row.pos;
  };
  const stale = () => {
    throw staleError("POS settings changed. Reload and try again.");
  };
  const guarded = (id, rev) => ({ _id: id, "pos.rev": rev });
  const fresh = async (session, id) =>
    posView((await installations.findOne({ _id: id }, { session })).pos);

  router.get(
    "/installations/:id/pos",
    auth.permit("credentials"),
    async (req, res) => {
      const row = await load(iid(req));
      res.json({ pos: row.pos ? posView(row.pos) : null });
    },
  );

  router.put(
    "/installations/:id/pos",
    auth.permit("credentials"),
    async (req, res) => {
      const id = iid(req);
      const { rev, config } = posSchemas.put.parse(req.body);
      const view = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        const row = await load(id, session);
        if (rev === 0) {
          if (row.pos) throw staleError("POS settings already exist. Reload.");
          await installations.updateOne(
            { _id: id, pos: { $exists: false } },
            { $set: { pos: newPos(config) } },
            { session },
          );
        } else {
          const pos = requirePos(row, rev);
          await idle(pos, session);
          ensure(
            config.image.store === (pos.image?.store ?? null) ||
              !pos.image?.keys,
            409,
            "Remove the image keys before changing the image store.",
          );
          const set = configPaths(config),
            update = { $inc: { "pos.rev": 1 } };
          if (config.cloudflare === null) {
            ensure(
              !pos.cloudflare?.token,
              409,
              "Remove the Cloudflare token before removing the Cloudflare details.",
            );
            set["pos.cloudflare"] = null;
          } else if (!pos.cloudflare)
            set["pos.cloudflare"] = { ...config.cloudflare, token: null };
          else
            for (const [k, v] of Object.entries(config.cloudflare))
              set[`pos.cloudflare.${k}`] = v;
          // Anything verify checks changed: the last verify no longer counts.
          if (verifyFingerprint(pos) !== verifyFingerprint(config))
            set["pos.verify"] = null;
          update.$set = set;
          const done = await installations.updateOne(guarded(id, rev), update, {
            session,
          });
          if (done.matchedCount !== 1) stale();
        }
        await audit(
          db,
          session,
          req.staff,
          "pos.configured",
          "installations",
          id,
          `${config.slug} (${rev === 0 ? "created" : "updated"})`,
          req,
        );
        return fresh(session, id);
      });
      res.json({ pos: view });
    },
  );

  router.put(
    "/installations/:id/pos/secret",
    auth.permit("credentials"),
    async (req, res) => {
      const id = iid(req);
      const { rev, field, value } = posSchemas.secret.parse(req.body);
      const view = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        const pos = requirePos(await load(id, session), rev);
        if (JOB_FIELDS.includes(field)) await idle(pos, session);
        if (field === "cloudflare.token")
          ensure(pos.cloudflare, 409, "Save the Cloudflare details first.");
        if (field === "image.keys") {
          ensure(pos.image?.store, 409, "Choose the image store first.");
          const keys = Object.keys(JSON.parse(value));
          ensure(
            pos.image.store === "r2"
              ? keys.includes("accessKeyId")
              : keys.includes("apiKey"),
            400,
            "Image keys do not match the image store.",
          );
        }
        const done = await installations.updateOne(
          guarded(id, rev),
          {
            $set: {
              [`pos.${field}`]: encrypt(value, c.VAULT_KEY, aadOf(id, field)),
              [`pos.secretsChangedAt.${changedKey(field)}`]: new Date(),
              ...(VERIFY_SECRETS.includes(field) ? { "pos.verify": null } : {}),
            },
            $inc: { "pos.rev": 1 },
          },
          { session },
        );
        if (done.matchedCount !== 1) stale();
        await audit(
          db,
          session,
          req.staff,
          "pos.secret-replaced",
          "installations",
          id,
          field,
          req,
        );
        return fresh(session, id);
      });
      res.json({ pos: view });
    },
  );

  router.delete(
    "/installations/:id/pos/secret",
    auth.permit("secrets"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      const { rev, field } = posSchemas.removeSecret.parse(req.body);
      const view = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "secrets");
        const pos = requirePos(await load(id, session), rev);
        if (JOB_FIELDS.includes(field)) await idle(pos, session);
        ensure(at(pos, field), 404, "Nothing is stored in this field.");
        const done = await installations.updateOne(
          guarded(id, rev),
          {
            $set: {
              [`pos.${field}`]: null,
              ...(VERIFY_SECRETS.includes(field) ? { "pos.verify": null } : {}),
            },
            $unset: { [`pos.secretsChangedAt.${changedKey(field)}`]: "" },
            $inc: { "pos.rev": 1 },
          },
          { session },
        );
        if (done.matchedCount !== 1) stale();
        await audit(
          db,
          session,
          req.staff,
          "pos.secret-removed",
          "installations",
          id,
          field,
          req,
        );
        return fresh(session, id);
      });
      res.json({ pos: view });
    },
  );

  router.post(
    "/installations/:id/pos/reveal",
    auth.permit("secrets"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      const { field } = posSchemas.reveal.parse(req.body);
      await consume(db, `reveal:${req.staff._id}`, 30, 3600000);
      const value = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "secrets");
        const pos = requirePos(await load(id, session));
        const box = at(pos, field);
        ensure(box, 404, "Nothing is stored in this field.");
        const plain = decrypt(box, c.VAULT_KEY, aadOf(id, field));
        await audit(
          db,
          session,
          req.staff,
          "pos.secret-revealed",
          "installations",
          id,
          field,
          req,
        );
        return plain;
      });
      res.json({ value });
    },
  );

  router.delete(
    "/installations/:id/pos",
    auth.permit("secrets"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      const { rev } = posSchemas.remove.parse(req.body);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "secrets");
        const pos = requirePos(await load(id, session), rev);
        await idle(pos, session);
        const done = await installations.updateOne(
          guarded(id, rev),
          { $unset: { pos: "" } },
          { session },
        );
        if (done.matchedCount !== 1) stale();
        await audit(
          db,
          session,
          req.staff,
          "pos.removed",
          "installations",
          id,
          pos.slug,
          req,
        );
      });
      res.json({ ok: true });
    },
  );
  return router;
}
