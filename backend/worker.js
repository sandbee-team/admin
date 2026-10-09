// Deploy worker entrypoint (Stage 2). A separate container process that
// executes the jobs the API enqueues; it decrypts customer tokens, so it never
// prints, logs or stores one.
//   node backend/worker.js                          the loop
//   node backend/worker.js --health                 container health: /work/heartbeat < 60 s old
//   node backend/worker.js --self-check [--installation=<id>]
import { stat } from "node:fs/promises";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--health")) {
  try {
    const info = await stat(
      path.join(process.env.POS_WORK_DIR || "/work", "heartbeat"),
    );
    process.exit(Date.now() - info.mtimeMs < 60000 ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
const { config } = await import("./config.js");
const { connect } = await import("./db.js");
const { verifyVaultKey } = await import("./lib/vault.js");
const { createS3 } = await import("./lib/s3.js");
const { createBuildCache } = await import("./lib/build-cache.js");
const { notifier } = await import("./modules/mail.js");
const { buildContext, selfCheck } = await import("./worker/context.js");
const { createLoop } = await import("./worker/loop.js");

const c = config();
const { db, client } = await connect(c);
await verifyVaultKey(db, c.VAULT_KEY);
const s3 = c.FILES_S3_BUCKET
  ? createS3({
      region: c.FILES_S3_REGION,
      bucket: c.FILES_S3_BUCKET,
      accessKeyId: c.FILES_S3_ACCESS_KEY_ID,
      secretAccessKey: c.FILES_S3_SECRET_ACCESS_KEY,
    })
  : undefined;
const cache =
  c.POS_BUILD_CACHE === "on" && s3
    ? createBuildCache({ s3, vaultKey: c.VAULT_KEY })
    : null;
const notify = c.SMTP_HOST ? notifier(c) : undefined;
const ctx = await buildContext({ c, db, client, s3, cache, notify });

const selfIndex = argv.indexOf("--self-check");
if (selfIndex >= 0) {
  const installation = argv
    .find((a) => a.startsWith("--installation="))
    ?.slice(15);
  const done = await selfCheck(ctx, { installationId: installation });
  await client.close();
  process.exit(done.ok ? 0 : 1);
}

const loop = createLoop(ctx);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  ctx.log("stopping", {});
  await loop.stop();
  await client.close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
ctx.log("started", { worker: ctx.workerId, cli: ctx.cliVersion });
await loop.run();
