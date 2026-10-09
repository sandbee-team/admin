import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { accountSchemas, MAX_ACCOUNTS } from "../../shared/schemas.js";
import { ensure, staleError } from "../lib/errors.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { audit } from "../lib/audit.js";
import { consume } from "../lib/limiter.js";
import { transaction } from "../db.js";
import {
  base32Encode,
  base32Decode,
  parseKeyInput,
  codeAt,
  stepAt,
} from "../lib/totp.js";
import { authorizeWrite } from "./records.js";

// The only shape an account ever leaves in. Never spread the stored entry.
export const accountView = (entry) => ({
  id: entry.id,
  rev: entry.rev,
  service: entry.service,
  label: entry.label,
  login: entry.login,
  recoveryContact: entry.recoveryContact,
  notes: entry.notes,
  hasPassword: Boolean(entry.password),
  hasTotp: Boolean(entry.totpKey),
  codesTotal: entry.backupCodes ? (entry.backupCodesCount ?? 0) : 0,
  codesLeft: entry.backupCodes
    ? Math.max(
        0,
        (entry.backupCodesCount ?? 0) - (entry.backupCodesUsed?.length ?? 0),
      )
    : 0,
  changedAt: entry.changedAt,
});
export const aadOf = (customerId, accountId, field) =>
  `account:${customerId}:${accountId}:${field}`;
const BAD_KEY = "Enter a valid authenticator key or otpauth:// link.";
// Returns {box value text, params} for a TOTP key input; messages never echo it.
function normalizeKey(input) {
  let parsed;
  try {
    parsed = parseKeyInput(input);
  } catch {
    ensure(false, 400, BAD_KEY);
  }
  return { text: base32Encode(parsed.key), params: parsed.params };
}
export function accountRoutes({ db, client, c, auth }) {
  const router = Router(),
    customers = db.collection("customers");
  router.use(auth.requireAuth);
  const ids = (req) => ({
    cid: z.uuid().parse(req.params.id),
    aid: z.uuid().parse(req.params.aid),
  });
  // One entry of a customer, read inside the caller's transaction.
  async function loadEntry(session, cid, aid) {
    const row = await customers.findOne(
      { _id: cid, "accounts.id": aid },
      { session, projection: { accounts: { $elemMatch: { id: aid } } } },
    );
    ensure(row?.accounts?.[0], 404, "Account not found.");
    return row.accounts[0];
  }
  const stale = () => {
    throw staleError("This account changed. Reload it and try again.");
  };
  const label = (entry) => `${entry.service}: ${entry.label}`;
  // Applies `update` to the entry only while its rev still matches.
  async function updateEntry(session, cid, aid, rev, update) {
    const result = await customers.updateOne(
      { _id: cid, accounts: { $elemMatch: { id: aid, rev } } },
      update,
      { session },
    );
    if (result.matchedCount !== 1) stale();
  }
  const bump = (set) => ({
    $set: { ...set, "accounts.$.changedAt": new Date() },
    $inc: { "accounts.$.rev": 1 },
  });
  const viewOf = async (session, cid, aid) =>
    accountView(await loadEntry(session, cid, aid));

  router.get(
    "/customers/:id/accounts",
    auth.permit("credentials"),
    async (req, res) => {
      const cid = z.uuid().parse(req.params.id);
      const row = await customers.findOne(
        { _id: cid },
        { projection: { accounts: 1 } },
      );
      ensure(row, 404, "Customer not found.");
      res.json({ rows: (row.accounts ?? []).map(accountView) });
    },
  );
  router.post(
    "/customers/:id/accounts",
    auth.permit("credentials"),
    async (req, res) => {
      const cid = z.uuid().parse(req.params.id);
      const { password, totpKey, backupCodes, ...details } =
        accountSchemas.create.parse(req.body);
      const key = totpKey === undefined ? null : normalizeKey(totpKey);
      const aid = randomUUID(),
        now = new Date();
      const entry = {
        id: aid,
        rev: 1,
        ...details,
        password:
          password === undefined
            ? null
            : encrypt(password, c.VAULT_KEY, aadOf(cid, aid, "password")),
        totpKey: key
          ? encrypt(key.text, c.VAULT_KEY, aadOf(cid, aid, "totpKey"))
          : null,
        totpParams: key ? key.params : null,
        backupCodes:
          backupCodes === undefined
            ? null
            : encrypt(
                JSON.stringify(backupCodes),
                c.VAULT_KEY,
                aadOf(cid, aid, "backupCodes"),
              ),
        backupCodesCount: backupCodes?.length ?? 0,
        backupCodesUsed: [],
        createdAt: now,
        changedAt: now,
      };
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        const result = await customers.updateOne(
          {
            _id: cid,
            [`accounts.${MAX_ACCOUNTS - 1}`]: { $exists: false },
          },
          { $push: { accounts: entry } },
          { session },
        );
        if (result.matchedCount !== 1) {
          ensure(
            await customers.findOne(
              { _id: cid },
              { session, projection: { _id: 1 } },
            ),
            404,
            "Customer not found.",
          );
          ensure(
            false,
            409,
            `A customer can hold at most ${MAX_ACCOUNTS} accounts.`,
          );
        }
        await audit(
          db,
          session,
          req.staff,
          "account.created",
          "customers",
          cid,
          label(entry),
          req,
        );
      });
      res.status(201).json(accountView(entry));
    },
  );
  router.put(
    "/customers/:id/accounts/:aid",
    auth.permit("credentials"),
    async (req, res) => {
      const { cid, aid } = ids(req);
      const { rev, ...details } = accountSchemas.update.parse(req.body);
      const view = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        await loadEntry(session, cid, aid);
        await updateEntry(
          session,
          cid,
          aid,
          rev,
          bump(
            Object.fromEntries(
              Object.entries(details).map(([k, v]) => [`accounts.$.${k}`, v]),
            ),
          ),
        );
        await audit(
          db,
          session,
          req.staff,
          "account.updated",
          "customers",
          cid,
          `${details.service}: ${details.label}`,
          req,
        );
        return viewOf(session, cid, aid);
      });
      res.json(view);
    },
  );
  router.put(
    "/customers/:id/accounts/:aid/secret",
    auth.permit("credentials"),
    async (req, res) => {
      const { cid, aid } = ids(req);
      const { rev, field, value } = accountSchemas.secret.parse(req.body);
      const set = {};
      if (field === "totpKey") {
        const key = normalizeKey(value);
        set["accounts.$.totpKey"] = encrypt(
          key.text,
          c.VAULT_KEY,
          aadOf(cid, aid, field),
        );
        set["accounts.$.totpParams"] = key.params;
      } else if (field === "backupCodes") {
        set["accounts.$.backupCodes"] = encrypt(
          JSON.stringify(value),
          c.VAULT_KEY,
          aadOf(cid, aid, field),
        );
        set["accounts.$.backupCodesCount"] = value.length;
        set["accounts.$.backupCodesUsed"] = [];
      } else
        set["accounts.$.password"] = encrypt(
          value,
          c.VAULT_KEY,
          aadOf(cid, aid, field),
        );
      const view = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        const entry = await loadEntry(session, cid, aid);
        await updateEntry(session, cid, aid, rev, bump(set));
        await audit(
          db,
          session,
          req.staff,
          "account.secret-replaced",
          "customers",
          cid,
          `${label(entry)} (${field})`,
          req,
        );
        return viewOf(session, cid, aid);
      });
      res.json(view);
    },
  );
  router.delete(
    "/customers/:id/accounts/:aid/secret",
    auth.permit("secrets"),
    auth.requireStepUp,
    async (req, res) => {
      const { cid, aid } = ids(req);
      const { rev, field } = accountSchemas.removeSecret.parse(req.body);
      const set = { [`accounts.$.${field}`]: null };
      if (field === "totpKey") set["accounts.$.totpParams"] = null;
      if (field === "backupCodes") {
        set["accounts.$.backupCodesCount"] = 0;
        set["accounts.$.backupCodesUsed"] = [];
      }
      const view = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "secrets");
        const entry = await loadEntry(session, cid, aid);
        await updateEntry(session, cid, aid, rev, bump(set));
        await audit(
          db,
          session,
          req.staff,
          "account.secret-removed",
          "customers",
          cid,
          `${label(entry)} (${field})`,
          req,
        );
        return viewOf(session, cid, aid);
      });
      res.json(view);
    },
  );
  router.delete(
    "/customers/:id/accounts/:aid",
    auth.permit("secrets"),
    auth.requireStepUp,
    async (req, res) => {
      const { cid, aid } = ids(req);
      const { rev } = accountSchemas.remove.parse(req.body);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "secrets");
        const entry = await loadEntry(session, cid, aid);
        const result = await customers.updateOne(
          { _id: cid, accounts: { $elemMatch: { id: aid, rev } } },
          { $pull: { accounts: { id: aid } } },
          { session },
        );
        if (result.matchedCount !== 1) stale();
        await audit(
          db,
          session,
          req.staff,
          "account.deleted",
          "customers",
          cid,
          label(entry),
          req,
        );
      });
      res.json({ ok: true });
    },
  );
  // Reveal and show-code decrypt and audit inside one transaction; the value
  // is sent only after it commits, so an unaudited reveal cannot happen.
  router.post(
    "/customers/:id/accounts/:aid/reveal",
    auth.permit("secrets"),
    auth.requireStepUp,
    async (req, res) => {
      const { cid, aid } = ids(req);
      const { field } = accountSchemas.reveal.parse(req.body);
      await consume(db, `reveal:${req.staff._id}`, 30, 3600000);
      const payload = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "secrets");
        const entry = await loadEntry(session, cid, aid);
        ensure(entry[field], 404, "Nothing is stored in this field.");
        const plain = decrypt(
          entry[field],
          c.VAULT_KEY,
          aadOf(cid, aid, field),
        );
        await audit(
          db,
          session,
          req.staff,
          "account.revealed",
          "customers",
          cid,
          `${label(entry)} (${field})`,
          req,
        );
        if (field !== "backupCodes") return { value: plain };
        const used = new Set(entry.backupCodesUsed ?? []);
        return {
          codes: JSON.parse(plain).map((code, index) => ({
            index,
            code,
            used: used.has(index),
          })),
        };
      });
      res.json(payload);
    },
  );
  router.post(
    "/customers/:id/accounts/:aid/code",
    auth.permit("secrets"),
    auth.requireStepUp,
    async (req, res) => {
      const { cid, aid } = ids(req);
      z.object({})
        .strict()
        .parse(req.body ?? {});
      await consume(db, `totp-code:${req.staff._id}`, 60, 3600000);
      const payload = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "secrets");
        const entry = await loadEntry(session, cid, aid);
        ensure(
          entry.totpKey && entry.totpParams,
          404,
          "No authenticator key is stored.",
        );
        const key = base32Decode(
          decrypt(entry.totpKey, c.VAULT_KEY, aadOf(cid, aid, "totpKey")),
        );
        const now = Date.now(),
          period = entry.totpParams.period;
        const code = codeAt(key, stepAt(now, period), entry.totpParams);
        await audit(
          db,
          session,
          req.staff,
          "account.code-shown",
          "customers",
          cid,
          label(entry),
          req,
        );
        return { code, expiresIn: period - (Math.floor(now / 1000) % period) };
      });
      res.json(payload);
    },
  );
  router.post(
    "/customers/:id/accounts/:aid/backup-codes/used",
    auth.permit("credentials"),
    async (req, res) => {
      const { cid, aid } = ids(req);
      const { rev, index } = accountSchemas.codeUsed.parse(req.body);
      const view = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        const entry = await loadEntry(session, cid, aid);
        const result = await customers.updateOne(
          {
            _id: cid,
            accounts: {
              $elemMatch: {
                id: aid,
                rev,
                backupCodes: { $ne: null },
                backupCodesCount: { $gt: index },
                backupCodesUsed: { $ne: index },
              },
            },
          },
          {
            $addToSet: { "accounts.$.backupCodesUsed": index },
            $set: { "accounts.$.changedAt": new Date() },
            $inc: { "accounts.$.rev": 1 },
          },
          { session },
        );
        if (result.matchedCount !== 1) stale();
        await audit(
          db,
          session,
          req.staff,
          "account.backup-code-marked",
          "customers",
          cid,
          `${label(entry)} (code ${index + 1})`,
          req,
        );
        return viewOf(session, cid, aid);
      });
      res.json(view);
    },
  );
  return router;
}
