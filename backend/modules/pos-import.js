import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  posImportSchemas,
  schemas,
  MAX_ACCOUNTS,
  POS_SECRET_FIELDS,
} from "../../shared/schemas.js";
import { ensure, HttpError } from "../lib/errors.js";
import { encrypt, equal } from "../lib/crypto.js";
import { audit } from "../lib/audit.js";
import { parseImport, importDigest } from "../lib/pos-import.js";
import { transaction } from "../db.js";
import { authorizeWrite } from "./records.js";
import { newPos, aadOf as posAad, changedKey } from "./pos.js";
import { aadOf as accountAad } from "./accounts.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const setPath = (object, path, value) => {
  const parts = path.split(".");
  const last = parts.pop();
  parts.reduce((o, part) => o[part], object)[last] = value;
};
const matchView = (row) => ({
  id: row._id,
  name: row.name,
  company: row.company,
  email: row.email,
  status: row.status,
});

export function posImportRoutes({ db, client, c, auth, cache }) {
  const router = Router(),
    customers = db.collection("customers"),
    installations = db.collection("installations"),
    products = db.collection("products");
  router.use(auth.requireAuth);

  const existingBySlug = (slug, session) =>
    installations.findOne(
      { "pos.slug": slug },
      { session, projection: { customerId: 1 } },
    );

  router.post(
    "/pos/import/preview",
    auth.permit("secrets"),
    async (req, res) => {
      const body = posImportSchemas.preview.parse(req.body);
      const parsed = parseImport(body);
      const found = await existingBySlug(parsed.config.slug);
      const existingCustomer = found
        ? await customers.findOne(
            { _id: found.customerId },
            { projection: { name: 1 } },
          )
        : null;
      const or = [
        ...(parsed.hints.emails.length
          ? [{ email: { $in: parsed.hints.emails } }]
          : []),
        ...parsed.hints.names.flatMap((name) => {
          const exact = new RegExp(`^${escapeRegex(name)}$`, "i");
          return [{ name: exact }, { company: exact }];
        }),
      ];
      const matches = or.length
        ? await customers
            .find(
              { $or: or },
              { projection: { name: 1, company: 1, email: 1, status: 1 } },
            )
            .limit(5)
            .toArray()
        : [];
      res.json({
        digest: importDigest(c.AUTH_SECRET, body.client, body.profile),
        mapping: parsed.mapping,
        secrets: POS_SECRET_FIELDS.map((target) => ({
          target,
          present: target in parsed.secrets,
        })),
        accounts: parsed.accounts.map((a) => ({
          service: a.service,
          label: a.label,
          login: a.login,
          hasPassword: Boolean(a.password),
        })),
        dropped: parsed.dropped,
        warnings: parsed.warnings,
        defaults: parsed.defaults,
        existing: found
          ? {
              installationId: found._id,
              customerId: found.customerId,
              customerName: existingCustomer?.name ?? "",
            }
          : null,
        customerMatches: matches.map(matchView),
      });
    },
  );

  router.post(
    "/pos/import/confirm",
    auth.permit("secrets"),
    async (req, res) => {
      const body = posImportSchemas.confirm.parse(req.body);
      const parsed = parseImport(body);
      ensure(
        equal(
          body.digest,
          importDigest(c.AUTH_SECRET, body.client, body.profile),
        ),
        400,
        "The file changed since the preview. Preview it again before confirming.",
      );
      const result = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "secrets");
        const { config } = parsed,
          now = new Date();
        ensure(
          !(await existingBySlug(config.slug, session)),
          409,
          "This client was already imported. Remove its POS setup first to import it again.",
        );
        const product = await products.findOne(
          { slug: "pos", status: { $ne: "retired" } },
          { session, projection: { _id: 1 } },
        );
        ensure(product, 409, "The POS product is missing or retired.");

        // Customer: attach to an existing one or create a new one.
        let customerId, existingAccounts;
        const stamp = () => ({
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
        if (body.customer.mode === "existing") {
          const row = await customers.findOne(
            { _id: body.customer.customerId },
            { session, projection: { accounts: 1 } },
          );
          ensure(row, 404, "Customer not found.");
          customerId = row._id;
          existingAccounts = row.accounts ?? [];
        } else {
          const { mode: _mode, ...details } = body.customer;
          const data = schemas.customers.parse({
            ...details,
            status: "active",
            notes: "",
            storeWorkspaceId: "",
          });
          customerId = randomUUID();
          existingAccounts = [];
          try {
            await customers.insertOne(
              { ...data, _id: customerId, ...stamp() },
              { session },
            );
          } catch (error) {
            if (error.code === 11000)
              throw new HttpError(
                409,
                "A customer with this email already exists. Choose it from the existing customers instead.",
              );
            throw error;
          }
          await audit(
            db,
            session,
            req.staff,
            "record.created",
            "customers",
            customerId,
            data.name,
            req,
          );
        }

        // Installation: reuse the production POS one without a block, or create.
        let installationId = null,
          created = false;
        const current = await installations.findOne(
          {
            customerId,
            productId: product._id,
            environment: "production",
          },
          { session, projection: { pos: 1 } },
        );
        if (current) {
          ensure(
            !current.pos,
            409,
            "This customer's production POS installation already has POS settings. Remove them first or choose another customer.",
          );
          installationId = current._id;
        } else {
          installationId = randomUUID();
          created = true;
        }

        const pos = newPos(config);
        pos.importedAt = now;
        pos.importedBy = req.staff._id;
        for (const [field, value] of Object.entries(parsed.secrets)) {
          setPath(
            pos,
            field,
            encrypt(value, c.VAULT_KEY, posAad(installationId, field)),
          );
          pos.secretsChangedAt[changedKey(field)] = now;
        }
        if (created) {
          const data = schemas.installations.parse({
            name: parsed.installationName,
            customerId,
            productId: product._id,
            environment: "production",
            status: "planned",
            release: "",
            sourceUrl: "",
            endpoint: parsed.mapping.endpoint,
            connectionIds: [],
            checks: [],
            evidence: "",
            notes: "",
          });
          await installations.insertOne(
            { ...data, _id: installationId, pos, ...stamp() },
            { session },
          );
          await audit(
            db,
            session,
            req.staff,
            "record.created",
            "installations",
            installationId,
            data.name,
            req,
          );
        } else {
          const done = await installations.updateOne(
            { _id: installationId, pos: { $exists: false } },
            { $set: { pos, updatedAt: now }, $inc: { revision: 1 } },
            { session },
          );
          ensure(
            done.matchedCount === 1,
            409,
            "This installation changed while importing. Try again.",
          );
        }

        // Accounts: skip entries this customer already holds (importKey).
        const have = new Set(existingAccounts.map((a) => a.importKey));
        const entries = parsed.accounts
          .filter((a) => !have.has(a.importKey))
          .map((a) => {
            const id = randomUUID();
            return {
              id,
              rev: 1,
              importKey: a.importKey,
              service: a.service,
              label: a.label,
              login: a.login,
              recoveryContact: "",
              notes: "Imported from a go-live file.",
              password: a.password
                ? encrypt(
                    a.password,
                    c.VAULT_KEY,
                    accountAad(customerId, id, "password"),
                  )
                : null,
              totpKey: null,
              totpParams: null,
              backupCodes: null,
              backupCodesCount: 0,
              backupCodesUsed: [],
              createdAt: now,
              changedAt: now,
            };
          });
        ensure(
          existingAccounts.length + entries.length <= MAX_ACCOUNTS,
          409,
          `A customer can hold at most ${MAX_ACCOUNTS} accounts.`,
        );
        if (entries.length)
          await customers.updateOne(
            { _id: customerId },
            { $push: { accounts: { $each: entries } } },
            { session },
          );
        await audit(
          db,
          session,
          req.staff,
          "pos.imported",
          "installations",
          installationId,
          `${config.slug} (${Object.keys(parsed.secrets).length} secrets, ${entries.length} accounts)`,
          req,
        );
        return { customerId, installationId };
      });
      cache.clear();
      res.status(201).json(result);
    },
  );
  return router;
}
