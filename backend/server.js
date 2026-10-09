import { MongoClient } from "mongodb";
import { config } from "./config.js";
import { connect } from "./db.js";
import { createApp } from "./app.js";
import { mailer, notifier } from "./modules/mail.js";
import { seedCatalog } from "./modules/catalog-seed.js";
import { verifyVaultKey } from "./lib/vault.js";
import { createS3 } from "./lib/s3.js";
import { applyTimeouts } from "./lib/http-timeouts.js";
const c = config(),
  { db, client } = await connect(c);
await verifyVaultKey(db, c.VAULT_KEY);
await seedCatalog(db);
let storeClient, storeDb;
if (c.STORE_MONGODB_URI) {
  storeClient = new MongoClient(c.STORE_MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 4000,
  });
  // Keep optional Store outages out of the Admin startup path. The read-only route
  // connects lazily and reports its own bounded failure.
  storeDb = storeClient.db(c.STORE_MONGODB_DB);
}
const app = createApp({
  c,
  db,
  client,
  storeDb,
  sendCode: mailer(c),
  notify: notifier(c),
  s3: c.FILES_S3_BUCKET
    ? createS3({
        region: c.FILES_S3_REGION,
        bucket: c.FILES_S3_BUCKET,
        accessKeyId: c.FILES_S3_ACCESS_KEY_ID,
        secretAccessKey: c.FILES_S3_SECRET_ACCESS_KEY,
      })
    : undefined,
});
const server = app.listen(c.PORT, "0.0.0.0", () =>
  console.info(`Sandbee Admin listening on port ${c.PORT}`),
);
applyTimeouts(server);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  server.close(async () => {
    await client.close();
    await storeClient?.close();
    process.exit(0);
  });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
