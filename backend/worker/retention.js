// Build retention (D22). The bucket lifecycle rule expires everything under
// builds/ after 10 days (noncurrent versions after 1 day) and cannot exclude
// anything, so builds that must live longer are kept by COPY-FORWARD: an object
// copied onto itself gets a new last-modified time.
//   - the LIVE build of every installation is kept always: copied forward when
//     its touchedAt is older than 5 days (daily sweep);
//   - the PREVIOUS build is kept 10 days after it was replaced: copied forward
//     ONCE, at the moment it becomes previous (finalize), never afterwards;
//   - every other build simply expires.
// The sweep also removes transient leftovers (failed build rows, kept GitHub
// artifacts, local work directories).
import { manifestKey } from "../lib/build-cache.js";
import { pruneBuilds, rmDir } from "./fetch-build.js";

export const COPY_FORWARD_AFTER_MS = 5 * 24 * 60 * 60 * 1000;
export const RETENTION_EVERY_MS = 24 * 60 * 60 * 1000;
const FAILED_ROW_MS = 24 * 60 * 60 * 1000;
const ARTIFACT_KEEP_MS = 2 * 60 * 60 * 1000;
const READY_ROW_MS = 60 * 60 * 1000;
const dateOf = (value) => {
  const d = value instanceof Date ? value : new Date(value ?? NaN);
  return Number.isNaN(d.getTime()) ? null : d;
};
// Copies the object, then the manifest, onto themselves. -> "copied" | "missing" | "failed"
export async function copyForward(ctx, { sha, buildKey, objectKey }) {
  if (!ctx.s3 || !objectKey || !sha || !buildKey) return "failed";
  try {
    await ctx.s3.copySelf(objectKey, {
      contentType: "application/octet-stream",
    });
    await ctx.s3.copySelf(manifestKey(sha, buildKey), {
      contentType: "application/json",
    });
    return "copied";
  } catch (error) {
    return error?.status === 410 ? "missing" : "failed";
  }
}
// A version record's build, as finalize stores it, with a fresh touchedAt.
export async function touchVersionBuild(ctx, version) {
  const build = version?.build;
  if (!build?.objectKey) return build ?? null;
  const done = await copyForward(ctx, {
    sha: version.sha,
    buildKey: build.buildKey,
    objectKey: build.objectKey,
  });
  return done === "copied"
    ? { ...build, touchedAt: new Date(ctx.now()) }
    : build;
}
// The daily sweep. -> counts only.
export async function runRetention(ctx, { signal } = {}) {
  const result = {
    checked: 0,
    copied: 0,
    missing: 0,
    failed: 0,
    rows: 0,
    artifacts: 0,
  };
  const now = ctx.now();
  if (ctx.s3 && ctx.cache) {
    const cursor = ctx.coll.installations.find(
      { "pos.deploy.last.build.objectKey": { $type: "string" } },
      { projection: { "pos.deploy.last": 1 } },
    );
    for await (const row of cursor) {
      if (signal?.aborted) break;
      const last = row.pos?.deploy?.last;
      const touched = dateOf(last?.build?.touchedAt)?.getTime() ?? 0;
      result.checked++;
      if (now - touched <= COPY_FORWARD_AFTER_MS) continue;
      const done = await copyForward(ctx, {
        sha: last.sha,
        buildKey: last.build.buildKey,
        objectKey: last.build.objectKey,
      });
      if (done === "copied") {
        result.copied++;
        await ctx.coll.installations.updateOne(
          { _id: row._id, "pos.deploy.last.requestId": last.requestId },
          { $set: { "pos.deploy.last.build.touchedAt": new Date(now) } },
        );
      } else result[done]++;
    }
  }
  // Transient build rows.
  const rows = await ctx.coll.state
    .find({ kind: "build", status: { $in: ["failed", "cancelled", "ready"] } })
    .toArray();
  for (const row of rows) {
    const finished = dateOf(row.finishedAt)?.getTime() ?? 0;
    const age = now - finished;
    let remove = false;
    if (row.status !== "ready") remove = age > FAILED_ROW_MS;
    else if (row.artifactId) {
      // Cache off (or a store that failed): the GitHub artifact is kept for the
      // deploys that follow, then removed.
      if (age > ARTIFACT_KEEP_MS) {
        try {
          await ctx.github.deleteArtifact(row.artifactId);
          result.artifacts++;
          remove = true;
        } catch {
          remove = false;
        }
      }
    } else remove = age > READY_ROW_MS;
    if (remove) {
      const gone = await ctx.coll.state.deleteOne({
        _id: row._id,
        status: row.status,
        finishedAt: row.finishedAt,
      });
      result.rows += gone.deletedCount;
    }
  }
  await pruneBuilds(ctx);
  // A live build that could not be kept (or is already gone) is a risk to the
  // owner's rollback: surface it in the heartbeat row and by e-mail (counts only).
  await ctx.coll.state
    .updateOne(
      { _id: "pos-worker" },
      {
        $set: {
          retention: {
            at: new Date(now),
            checked: result.checked,
            copied: result.copied,
            missing: result.missing,
            failed: result.failed,
          },
        },
      },
      { upsert: true },
    )
    .catch(() => undefined);
  if ((result.failed || result.missing) && ctx.notify) {
    try {
      const owners = await ctx.db
        .collection("staff")
        .find({ role: "owner", status: "active" }, { projection: { email: 1 } })
        .toArray();
      for (const owner of owners)
        if (owner.email)
          await ctx
            .notify(owner.email, {
              subject: "POS build retention needs attention",
              text: `The daily build retention sweep could not keep ${result.failed} live build(s) and found ${result.missing} already expired. A rollback or redeploy of those clients will need a fresh build.`,
            })
            .catch(() => undefined);
    } catch {
      // Best effort.
    }
  }
  return result;
}
// Claims the daily sweep (one worker at a time, at most once a day).
export async function claimRetention(ctx) {
  const { state } = ctx.coll;
  const now = new Date(ctx.now());
  await state.updateOne(
    { _id: "pos-retention" },
    {
      $setOnInsert: {
        status: "idle",
        at: new Date(0),
        lease: { owner: null, until: null, fence: 0 },
        result: null,
      },
    },
    { upsert: true },
  );
  const got = await state.findOneAndUpdate(
    {
      _id: "pos-retention",
      $or: [
        {
          status: { $ne: "running" },
          at: { $lt: new Date(now - RETENTION_EVERY_MS) },
        },
        { status: "running", "lease.until": { $lt: now } },
      ],
    },
    {
      $set: {
        status: "running",
        "lease.owner": ctx.workerId,
        "lease.until": new Date(ctx.now() + ctx.t.leaseMs),
      },
      $inc: { "lease.fence": 1 },
    },
    { returnDocument: "after" },
  );
  return got?._id ? got : null;
}
