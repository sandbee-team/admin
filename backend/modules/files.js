import { Router } from "express";
import {
  randomBytes,
  randomUUID,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { z } from "zod";
import {
  FILE_CATEGORIES,
  FILE_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_FILES,
} from "../../shared/schemas.js";
import { ensure, HttpError, staleError } from "../lib/errors.js";
import { decrypt, equal } from "../lib/crypto.js";
import { audit } from "../lib/audit.js";
import { consume } from "../lib/limiter.js";
import { encodeRfc3986 } from "../lib/s3.js";
import { createSealer, fileEntry, pushEntry } from "../lib/file-store.js";
import { transaction } from "../db.js";
import { authorizeWrite } from "./records.js";

const MAGIC = Buffer.from("SBF1");
const OVERHEAD = MAGIC.length + 12 + 16; // magic + iv + GCM tag
const DAY = 86400000;
const RESTORE_DAYS = 29,
  PURGE_DAYS = 31;
const MAX_TRANSFERS = 2;
const CLAIM_MS = 60000;
const aadOf = (cid, fid) => `file:${cid}:${fid}`;
const keyOf = (cid, fid) => `files/${cid}/${fid}`;
// Control, bidi and line-separator characters (format characters, category
// Cf, are removed separately).
const HIDDEN = new RegExp(
  "[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]",
  "gu",
);
// Returns {name, ext}; throws 400 for a name that cannot be kept.
export function cleanFileName(raw) {
  let name = String(raw)
    .normalize("NFC")
    .replace(HIDDEN, "")
    .replace(/\p{Cf}/gu, "")
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  const dot = name.lastIndexOf(".");
  ensure(dot > 0, 400, "The file needs a name and an extension.");
  const ext = name.slice(dot + 1).toLowerCase();
  ensure(FILE_EXTENSIONS.includes(ext), 400, "This file type is not allowed.");
  const chars = Array.from(name.slice(0, dot).trim());
  ensure(chars.length > 0, 400, "The file needs a name and an extension.");
  name = `${chars.slice(0, 150 - ext.length - 1).join("")}.${ext}`;
  return { name, ext };
}
const fileView = (file, now = Date.now()) => ({
  id: file.id,
  name: file.name,
  category: file.category,
  size: file.size,
  sha256: file.sha256,
  uploadedBy: file.uploadedBy,
  uploadedAt: file.uploadedAt,
  deletedAt: file.deletedAt ?? null,
  restorable: Boolean(
    file.deletedAt &&
    !file.purgedAt &&
    now - new Date(file.deletedAt).getTime() <= RESTORE_DAYS * DAY,
  ),
});
const integrity = () =>
  new HttpError(422, "This file failed its integrity check and was not sent.");
export function fileRoutes({ db, client, c, auth, s3 }) {
  const router = Router(),
    customers = db.collection("customers");
  router.use(auth.requireAuth);
  let transfers = 0;
  // In-process slot gate: bounds memory (each transfer buffers up to ~40 MB).
  // The slot is held until the handler itself finishes, so a client that
  // disconnects while its S3 call is still running does not free it early.
  function takeSlot() {
    if (transfers >= MAX_TRANSFERS)
      throw new HttpError(503, "File transfers are busy. Retry shortly.", true);
    transfers++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        transfers--;
      }
    };
  }
  const needStorage = () => {
    if (!s3) {
      const error = new HttpError(503, "File storage is not configured.", true);
      error.apiCode = "not-configured";
      throw error;
    }
  };
  const transfer = (handler) => async (req, res) => {
    needStorage();
    const release = takeSlot();
    try {
      await handler(req, res);
    } finally {
      release();
    }
  };
  const ids = (req) => ({
    cid: z.uuid().parse(req.params.id),
    fid: z.uuid().parse(req.params.fid),
  });
  async function findFile(cid, fid, session) {
    const row = await customers.findOne(
      { _id: cid, "files.id": fid },
      { session, projection: { files: { $elemMatch: { id: fid } } } },
    );
    ensure(row?.files?.[0], 404, "File not found.");
    return row.files[0];
  }
  router.get(
    "/customers/:id/files",
    auth.permit("credentials"),
    async (req, res) => {
      const cid = z.uuid().parse(req.params.id);
      const row = await customers.findOne(
        { _id: cid },
        { projection: { files: 1 } },
      );
      ensure(row, 404, "Customer not found.");
      const now = Date.now();
      res.json({ rows: (row.files ?? []).map((file) => fileView(file, now)) });
    },
  );

  router.post(
    "/customers/:id/files",
    auth.permit("credentials"),
    transfer(async (req, res) => {
      // Early refusals leave the body unread, so close the connection after them.
      res.set("Connection", "close");
      const cid = z.uuid().parse(req.params.id);
      await consume(db, `file-upload:${req.staff._id}`, 60, 3600000);
      ensure(
        !req.originalUrl.includes("?"),
        400,
        "Query strings are not allowed.",
      );
      const rawLength = req.get("content-length");
      ensure(rawLength !== undefined, 411, "Content-Length is required.");
      ensure(/^\d{1,12}$/.test(rawLength), 400, "Invalid Content-Length.");
      const length = Number(rawLength);
      ensure(length >= 1, 400, "The file is empty.");
      ensure(length <= MAX_FILE_BYTES, 413, "Files can be at most 20 MB.");
      const rawName = req.get("x-file-name") ?? "";
      ensure(
        rawName.length > 0 && rawName.length <= 1500,
        400,
        "Send the file name in X-File-Name.",
      );
      let decoded;
      try {
        decoded = decodeURIComponent(rawName);
      } catch {
        ensure(false, 400, "X-File-Name must be URL-encoded.");
      }
      const { name, ext } = cleanFileName(decoded);
      const category = z
        .enum(FILE_CATEGORIES)
        .parse(req.get("x-file-category"));
      ensure(
        await customers.findOne({ _id: cid }, { projection: { _id: 1 } }),
        404,
        "Customer not found.",
      );
      // Cheap refusal before any S3 traffic. Entries the upload below would
      // purge (deleted over 31 days ago) do not count toward the cap.
      const purgeBefore = new Date(Date.now() - PURGE_DAYS * DAY);
      ensure(
        !(await customers.findOne(
          {
            _id: cid,
            $expr: {
              $gte: [
                {
                  $size: {
                    $filter: {
                      input: { $ifNull: ["$files", []] },
                      cond: {
                        $not: [
                          {
                            $and: [
                              { $ne: ["$$this.deletedAt", null] },
                              { $lt: ["$$this.deletedAt", purgeBefore] },
                            ],
                          },
                        ],
                      },
                    },
                  },
                },
                MAX_FILES,
              ],
            },
          },
          { projection: { _id: 1 } },
        )),
        409,
        `A customer can hold at most ${MAX_FILES} files.`,
      );

      const fid = randomUUID(),
        sealer = createSealer(cid, fid);
      let received = 0,
        problem = null;
      // Chunk by chunk; never break out early (that would destroy the socket
      // before the error response is written).
      for await (const chunk of req) {
        received += chunk.length;
        if (problem || received > length) {
          problem ??= "The upload was longer than declared.";
          continue;
        }
        sealer.update(chunk);
      }
      ensure(!problem, 400, problem);
      ensure(received === length, 400, "The upload was shorter than declared.");
      res.removeHeader("Connection");
      const sealed = sealer.finish(c.VAULT_KEY);
      const object = sealed.object;

      const s3Key = keyOf(cid, fid);
      const { versionId } = await s3.put(s3Key, object);
      const now = new Date();
      const entry = fileEntry({
        fid,
        name,
        category,
        size: length,
        sealed,
        ext,
        s3Key,
        versionId,
        by: req.staff,
        now,
      });
      try {
        await transaction(client, async (session) => {
          await authorizeWrite(db, session, req.staff, "credentials");
          await pushEntry(customers, session, cid, entry);
          await audit(
            db,
            session,
            req.staff,
            "file.uploaded",
            "customers",
            cid,
            `${category}, ${length} bytes, ${fid.slice(0, 8)}`,
            req,
          );
        });
      } catch (error) {
        // The commit may have succeeded even though the driver reported a
        // failure. Only remove the object when the record verifiably does not
        // point at it; if the lookup itself fails, keep the object.
        const stored = await customers
          .findOne(
            { _id: cid, files: { $elemMatch: { id: fid, versionId } } },
            { projection: { _id: 1 } },
          )
          .catch(() => undefined);
        if (stored === undefined) throw error;
        if (stored === null) {
          await s3.del(s3Key).catch(() => {});
          throw error;
        }
      }
      res.status(201).json(fileView(entry));
    }),
  );

  router.post(
    "/customers/:id/files/:fid/download",
    auth.permit("secrets"),
    auth.requireStepUp,
    transfer(async (req, res) => {
      const { cid, fid } = ids(req);
      await consume(db, `file-download:${req.staff._id}`, 60, 3600000);
      const file = await findFile(cid, fid);
      ensure(!file.deletedAt, 409, "This file was deleted.");
      const aad = aadOf(cid, fid);
      const failIntegrity = async () => {
        await audit(
          db,
          undefined,
          req.staff,
          "file.integrity-failed",
          "customers",
          cid,
          fid.slice(0, 8),
          req,
        ).catch(() => {});
        throw integrity();
      };
      let body;
      try {
        body = await s3.get(file.s3Key, file.versionId, file.size + OVERHEAD);
      } catch (error) {
        // An object longer than it can legitimately be is a tampered object.
        if (error.s3Code !== "TooLarge") throw error;
        await failIntegrity();
      }
      let plain;
      try {
        // Nothing is sent until the whole object is authenticated and matches
        // the digest recorded at upload.
        if (
          body.length !== file.size + OVERHEAD ||
          !body.subarray(0, MAGIC.length).equals(MAGIC)
        )
          throw integrity();
        const dataKey = Buffer.from(
          decrypt(file.dataKey, c.VAULT_KEY, aad),
          "hex",
        );
        const decipher = createDecipheriv(
          "aes-256-gcm",
          dataKey,
          body.subarray(MAGIC.length, MAGIC.length + 12),
          { authTagLength: 16 },
        );
        decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(body.subarray(body.length - 16));
        plain = Buffer.concat([
          decipher.update(body.subarray(MAGIC.length + 12, body.length - 16)),
          decipher.final(),
        ]);
        if (
          plain.length !== file.size ||
          !equal(createHash("sha256").update(plain).digest("hex"), file.sha256)
        )
          throw integrity();
      } catch {
        await failIntegrity();
      }
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "secrets");
        if (
          !(await customers.findOne(
            {
              _id: cid,
              files: {
                $elemMatch: {
                  id: fid,
                  deletedAt: null,
                  versionId: file.versionId,
                },
              },
            },
            { session, projection: { _id: 1 } },
          ))
        )
          throw staleError("This file changed. Reload and try again.");
        await audit(
          db,
          session,
          req.staff,
          "file.downloaded",
          "customers",
          cid,
          `${file.category}, ${file.size} bytes, ${fid.slice(0, 8)}`,
          req,
        );
      });
      res
        .status(200)
        .set({
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeRfc3986(file.name)}`,
          "Content-Length": String(plain.length),
          "X-Content-Type-Options": "nosniff",
        })
        .end(plain);
    }),
  );

  router.delete(
    "/customers/:id/files/:fid",
    auth.permit("secrets"),
    auth.requireStepUp,
    async (req, res) => {
      needStorage();
      const { cid, fid } = ids(req);
      const file = await findFile(cid, fid);
      ensure(!file.deletedAt, 409, "This file is already deleted.");
      // Record first, S3 after the commit: the restore window is then always
      // measured from a deletedAt that is not later than the S3 delete. If the
      // S3 call fails the current version simply stays (restore still works
      // from the stored versionId) and the response says so.
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "secrets");
        const result = await customers.updateOne(
          { _id: cid, files: { $elemMatch: { id: fid, deletedAt: null } } },
          {
            $set: {
              "files.$.deletedAt": new Date(),
              "files.$.deletedBy": req.staff.name,
            },
          },
          { session },
        );
        if (result.matchedCount !== 1)
          throw staleError("This file changed. Reload and try again.");
        await audit(
          db,
          session,
          req.staff,
          "file.deleted",
          "customers",
          cid,
          `${file.category}, ${fid.slice(0, 8)}`,
          req,
        );
      });
      let storageDeleted = true;
      try {
        await s3.del(file.s3Key);
      } catch {
        storageDeleted = false;
      }
      res.json({ ok: true, storageDeleted });
    },
  );

  router.post(
    "/customers/:id/files/:fid/restore",
    auth.permit("credentials"),
    async (req, res) => {
      needStorage();
      const { cid, fid } = ids(req);
      z.object({})
        .strict()
        .parse(req.body ?? {});
      const file = await findFile(cid, fid);
      ensure(file.deletedAt, 409, "This file is not deleted.");
      ensure(!file.purgedAt, 410, "This file can no longer be restored.");
      ensure(
        Date.now() - new Date(file.deletedAt).getTime() <= RESTORE_DAYS * DAY,
        410,
        "The restore window for this file has passed.",
      );
      // 1. Claim the entry (short TTL so a crashed restore can be retried).
      //    Only the claim holder may copy, so two restores cannot leave the
      //    record pointing at a version that is not S3's current one.
      const token = randomUUID();
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        const claimed = await customers.updateOne(
          {
            _id: cid,
            files: {
              $elemMatch: {
                id: fid,
                deletedAt: { $ne: null },
                purgedAt: null,
                versionId: file.versionId,
                $or: [
                  { restoring: null },
                  { "restoring.until": { $lt: new Date() } },
                ],
              },
            },
          },
          {
            $set: {
              "files.$.restoring": {
                token,
                until: new Date(Date.now() + CLAIM_MS),
              },
            },
          },
          { session },
        );
        if (claimed.matchedCount !== 1)
          throw staleError(
            "This file is being restored or changed. Reload and try again.",
          );
      });
      const mine = {
        _id: cid,
        files: { $elemMatch: { id: fid, "restoring.token": token } },
      };
      const release = () =>
        customers
          .updateOne(mine, { $set: { "files.$.restoring": null } })
          .catch(() => {});
      // 2. Copy the stored version to a new current version.
      let copied;
      try {
        copied = await s3.copy(file.s3Key, file.versionId);
      } catch (error) {
        if (error.status === 410)
          await transaction(client, async (session) => {
            await authorizeWrite(db, session, req.staff, "credentials");
            await customers.updateOne(
              mine,
              {
                $set: {
                  "files.$.purgedAt": new Date(),
                  "files.$.restoring": null,
                },
              },
              { session },
            );
            await audit(
              db,
              session,
              req.staff,
              "file.purged",
              "customers",
              cid,
              fid.slice(0, 8),
              req,
            );
          }).catch(() => release());
        else await release();
        throw error;
      }
      // 3. Commit, guarded by the claim token.
      try {
        await transaction(client, async (session) => {
          await authorizeWrite(db, session, req.staff, "credentials");
          const result = await customers.updateOne(
            {
              _id: cid,
              files: {
                $elemMatch: {
                  id: fid,
                  deletedAt: { $ne: null },
                  versionId: file.versionId,
                  "restoring.token": token,
                },
              },
            },
            {
              $set: {
                "files.$.versionId": copied.versionId,
                "files.$.deletedAt": null,
                "files.$.deletedBy": null,
                "files.$.restoredAt": new Date(),
                "files.$.restoring": null,
              },
            },
            { session },
          );
          if (result.matchedCount !== 1)
            throw staleError("This file changed. Reload and try again.");
          await audit(
            db,
            session,
            req.staff,
            "file.restored",
            "customers",
            cid,
            `${file.category}, ${fid.slice(0, 8)}`,
            req,
          );
        });
      } catch (error) {
        // The commit may have succeeded despite the error: re-read the record.
        const now = await findFile(cid, fid).catch(() => undefined);
        if (now && now.versionId === copied.versionId && !now.deletedAt) {
          // Committed: nothing to undo.
        } else {
          // Re-delete only while the record is still the deleted entry this
          // request claimed; otherwise another restore owns S3's current
          // version and a delete marker would orphan the record's version.
          if (
            now &&
            now.deletedAt &&
            now.versionId === file.versionId &&
            (!now.restoring || now.restoring.token === token)
          )
            await s3.del(file.s3Key).catch(() => {});
          await release();
          throw error;
        }
      }
      res.json(fileView(await findFile(cid, fid)));
    },
  );

  router.post("/files/self-test", auth.permit("secrets"), async (req, res) => {
    needStorage();
    z.object({})
      .strict()
      .parse(req.body ?? {});
    await consume(db, `file-selftest:${req.staff._id}`, 10, 3600000);
    const key = `files/_selftest/${randomUUID()}`,
      probe = randomBytes(32);
    let versioning = false,
      roundtrip = false,
      removed = false,
      listing = false;
    try {
      const { versionId } = await s3.put(key, probe);
      versioning = true;
      roundtrip = (await s3.get(key, versionId, 1024)).equals(probe);
    } catch {
      // Reported through the flags below; S3 detail is never exposed.
    }
    try {
      await s3.del(key);
      removed = true;
    } catch {
      // Reported through the flags below.
    }
    try {
      await s3.list("files/_selftest/", 1);
      listing = true;
    } catch {
      // Reported through the flags below.
    }
    const ok = versioning && roundtrip && removed && listing;
    await transaction(client, async (session) => {
      await authorizeWrite(db, session, req.staff, "secrets");
      await audit(
        db,
        session,
        req.staff,
        "files.self-tested",
        "system",
        "files",
        ok ? "ok" : "failed",
        req,
      );
    });
    res.json({ ok, versioning, listing });
  });
  return router;
}
