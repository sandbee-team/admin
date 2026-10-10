// Owner-triggered backup of a CLIENT's MongoDB (D6, D28): every non-system
// collection streamed as canonical EJSON lines (header, one {"c","d"} line per
// document, trailer with exact counts) -> gzip -> SBF1 seal exactly like a
// client file -> S3 -> registered on the customer as category `db-backup`.
// Memory is bounded by the 20 MB compressed cap: the run aborts as soon as the
// compressed size passes it and nothing is stored. The plaintext never touches
// disk or S3; the URI and the documents never reach a log, a row or an audit.
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import { BSON } from "mongodb";
import { audit } from "../lib/audit.js";
import { ClientMongoError, openClientDb } from "../lib/client-mongo.js";
import {
  createSealer,
  fileEntry,
  keyOf,
  pushEntry,
} from "../lib/file-store.js";
import { describeCode } from "../../shared/deploy-errors.js";
import { MAX_FILE_BYTES } from "../../shared/schemas.js";
import { transaction } from "../db.js";
import { JobFail, LeaseLost, ensureLive, withLease } from "./lease.js";
import { WORKER_ACTOR, failTask, loadTarget, openSecret } from "./verify.js";

export const BACKUP_FORMAT = "sandbee-db-backup/1";
const line = (value) => `${BSON.EJSON.stringify(value, { relaxed: false })}\n`;
const stamp = (ms) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .slice(0, 13)
    .replace("T", "-");
const fail = (code) => {
  const d = describeCode(code);
  return new JobFail(code, `${d.plainMessage} ${d.action}`.slice(0, 160));
};

// Async generator of the plain text lines of the backup.
async function* lines(db, names, startedAt, stats, signal) {
  yield line({
    type: "header",
    format: BACKUP_FORMAT,
    db: db.databaseName,
    startedAt,
    collections: names,
  });
  for (const name of names) {
    let n = 0;
    const cursor = db
      .collection(name)
      .find({}, { batchSize: 500, readPreference: "secondaryPreferred" });
    try {
      for await (const doc of cursor) {
        ensureLive(signal);
        n++;
        stats.documents++;
        yield line({ c: name, d: doc });
      }
    } finally {
      await cursor.close().catch(() => {});
    }
    stats.counts[name] = n;
    stats.collections++;
  }
  yield line({
    type: "trailer",
    counts: stats.counts,
    finishedAt: new Date().toISOString(),
  });
}
export async function runDbBackup(ctx, claim) {
  const { slot } = claim;
  await withLease(
    ctx,
    claim,
    async (signal) => {
      const task = claim.doc;
      // Not resumable: the stream cannot continue after a restart.
      if (claim.takeover) throw fail("backup-failed");
      if (!ctx.s3) throw fail("backup-no-storage");
      const target = await loadTarget(ctx, claim.installationId, {
        needToken: false,
      });
      const uri = openSecret(
        ctx,
        claim.installationId,
        target.pos,
        "mongo.uri",
      );
      if (!uri) throw fail("backup-no-uri");
      const row = await ctx.coll.installations.findOne(
        { _id: claim.installationId },
        { projection: { customerId: 1 } },
      );
      const cid = row.customerId;
      const fid = randomUUID();
      const sealer = createSealer(cid, fid);
      const stats = { collections: 0, documents: 0, counts: {} };
      let opened;
      try {
        opened = await (ctx.openClientDb ?? openClientDb)(uri, {
          readPreference: "secondaryPreferred",
        });
      } catch (error) {
        if (error instanceof ClientMongoError) throw fail(error.code);
        throw fail("backup-failed");
      }
      let compressed = 0;
      let lastProgress = 0;
      try {
        await slot.mustSet({
          step: "list",
          progress: { collections: 0, documents: 0, bytes: 0 },
        });
        const listed = await opened.db
          .listCollections({}, { nameOnly: false })
          .toArray();
        const names = listed
          .filter((c) => c.type !== "view" && !c.name.startsWith("system."))
          .map((c) => c.name)
          .sort();
        await slot.mustSet({ step: "read" });
        const gzip = zlib.createGzip();
        const source = Readable.from(
          lines(
            opened.db,
            names,
            new Date(ctx.now()).toISOString(),
            stats,
            signal,
          ),
        );
        source.on("error", (error) => gzip.destroy(error));
        source.pipe(gzip);
        try {
          for await (const chunk of gzip) {
            compressed += chunk.length;
            if (compressed > MAX_FILE_BYTES) {
              source.destroy();
              gzip.destroy();
              throw fail("backup-too-large");
            }
            sealer.update(chunk);
            if (ctx.now() - lastProgress >= 2000) {
              lastProgress = ctx.now();
              await slot.mustSet({
                progress: {
                  collections: stats.collections,
                  documents: stats.documents,
                  bytes: compressed,
                },
              });
            }
          }
        } catch (error) {
          if (error instanceof JobFail || error instanceof LeaseLost)
            throw error;
          if (signal.aborted) throw signal.reason;
          throw fail("backup-failed");
        }
      } finally {
        await opened.client.close().catch(() => {});
      }
      ensureLive(signal);
      const sealed = sealer.finish(ctx.c.VAULT_KEY);
      const s3Key = keyOf(cid, fid);
      await slot.mustSet({ step: "store" });
      const { versionId } = await ctx.s3.put(s3Key, sealed.object);
      const now = new Date(ctx.now());
      const name = `${target.pos.slug}-db-${stamp(ctx.now())}.jsonl.gz`;
      const entry = fileEntry({
        fid,
        name,
        category: "db-backup",
        size: compressed,
        sealed,
        ext: "gz",
        s3Key,
        versionId,
        by: {
          _id: task.by?.id ?? "worker",
          name: task.by?.name ?? "Deploy worker",
        },
        now,
      });
      try {
        await transaction(ctx.client, async (session) => {
          await pushEntry(ctx.db.collection("customers"), session, cid, entry);
          const done = await ctx.coll.installations.updateOne(
            slot.filterOf(),
            {
              $set: slot.prefixed({
                status: "succeeded",
                step: "done",
                finishedAt: now,
                error: null,
                progress: {
                  collections: stats.collections,
                  documents: stats.documents,
                  bytes: compressed,
                },
                result: {
                  collections: stats.collections,
                  documents: stats.documents,
                  bytes: compressed,
                },
              }),
            },
            { session },
          );
          if (done.matchedCount !== 1) throw new LeaseLost();
          await audit(
            ctx.db,
            session,
            WORKER_ACTOR,
            "pos.db-backup.created",
            "installations",
            claim.installationId,
            `${compressed} bytes, ${stats.collections} collections, ${fid.slice(0, 8)}`,
          );
        });
      } catch (error) {
        // Remove the object only when the record verifiably does not point at it.
        const stored = await ctx.db
          .collection("customers")
          .findOne(
            { _id: cid, files: { $elemMatch: { id: fid, versionId } } },
            { projection: { _id: 1 } },
          )
          .catch(() => undefined);
        if (stored === null) await ctx.s3.del(s3Key).catch(() => {});
        if (stored === undefined || stored === null) throw error;
      }
    },
    (error) => failTask(ctx, claim, error),
  );
}
