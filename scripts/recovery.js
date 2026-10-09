import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config, backupKeyInfo } from "../backend/config.js";
import { connect, transaction } from "../backend/db.js";
import {
  makeSnapshot,
  parseSnapshot,
  BACKUP_COLLECTIONS,
} from "../backend/lib/snapshot.js";
import { resetTotp, verifyKey } from "../backend/lib/recovery-tasks.js";
import { notifier } from "../backend/modules/mail.js";
const [command, file] = process.argv.slice(2),
  c = config();
const option = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
// Reads a key without echo: a hidden prompt on a terminal, otherwise stdin.
async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    let text = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) text += chunk;
    return text.trim();
  }
  process.stderr.write(prompt);
  return new Promise((resolveKey, reject) => {
    let text = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const done = (fn) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n")
          return done(() => resolveKey(text.trim()));
        if (ch === "\u0003") return done(() => reject(new Error("Cancelled.")));
        if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
        else text += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}
if (command === "verify-key") {
  // A key on the command line would land in shell history and process lists.
  // Any positional argument is refused (never echoed) rather than ignored.
  if (
    process.argv
      .slice(3)
      .some(
        (arg) =>
          !arg.startsWith("--") ||
          /^--(key|vault-key|backup-key)(=|$)/.test(arg),
      )
  )
    throw new Error(
      "Never pass a key as an argument. Pipe it on stdin or type it at the hidden prompt.",
    );
  const kind = option("kind"),
    copy = option("copy"),
    fromEnv = process.argv.includes("--from-env");
  if (!["vault", "backup"].includes(kind))
    throw new Error("verify-key requires --kind=vault or --kind=backup.");
  if (!["server", "password-manager", "offline"].includes(copy))
    throw new Error(
      "verify-key requires --copy=server, --copy=password-manager or --copy=offline.",
    );
  if (fromEnv && copy !== "server")
    throw new Error("--from-env is only for --copy=server.");
  const key = fromEnv
    ? (kind === "vault" ? process.env.VAULT_KEY : backupKeyInfo(c).key) || ""
    : await readSecret(`Paste the ${kind} key (input is hidden): `);
  if (!/^[a-fA-F0-9]{64}$/.test(key.trim()))
    throw new Error(
      "That is not a 64-character hexadecimal key. Nothing was checked.",
    );
  const { db, client } = await connect(c);
  try {
    const { match, fingerprint } = await verifyKey(
      { db, client },
      { kind, copy, key, backupKey: backupKeyInfo(c).key },
    );
    if (!match) {
      console.error(
        `MISMATCH: that is not the ${kind} key for this database (fingerprint ${fingerprint}). The key does not match. No verification was recorded; the attempt was audited.`,
      );
      process.exitCode = 1;
    } else
      console.info(
        `MATCH: the ${copy} copy of the ${kind} key is correct (fingerprint ${fingerprint}). Recorded in Recovery.`,
      );
  } finally {
    await client.close();
  }
  process.exit();
}
// Only the snapshot commands need BACKUP_KEY; reset-totp must work without it.
const snapshotCommand = ["backup", "restore"].includes(command);
let backupKey = "";
if (snapshotCommand) {
  backupKey = backupKeyInfo(c).key;
  if (!/^[a-f0-9]{64}$/.test(backupKey))
    throw new Error("A 32-byte hexadecimal BACKUP_KEY is required.");
}
if (!process.argv.includes("--maintenance"))
  throw new Error(
    "Stop all Admin API replicas, then rerun with --maintenance. The snapshot tool requires a write-free window.",
  );
if (!snapshotCommand && command !== "reset-totp")
  throw new Error("Use backup, restore or reset-totp.");
const sourceDb = c.MONGODB_DB;
if (command === "restore") {
  if (
    !file ||
    !/^[a-zA-Z0-9_-]{3,80}$/.test(process.env.RESTORE_DB || "") ||
    process.env.RESTORE_DB === sourceDb
  )
    throw new Error(
      "Restore requires a snapshot path and RESTORE_DB naming a NEW distinct database.",
    );
  c.MONGODB_DB = process.env.RESTORE_DB;
}
const email = process.argv
  .find((arg) => arg.startsWith("--email="))
  ?.slice("--email=".length);
if (command === "reset-totp" && !email)
  throw new Error("reset-totp requires --email=<staff email>.");
const { db, client } = await connect(c);
try {
  if (command === "reset-totp") {
    const result = await resetTotp({ db, client, notify: notifier(c) }, email);
    console.info(
      `Authenticator reset for ${email}. ${result.sessionsRevoked} session(s) revoked. They sign in with password and email code, then set up the authenticator again.`,
    );
  } else if (command === "backup") {
    mkdirSync("backups", { recursive: true });
    const output =
      file && !file.startsWith("--")
        ? resolve(file)
        : resolve(
            "backups",
            `admin-${new Date().toISOString().replaceAll(":", "-")}.enc`,
          );
    const value = await makeSnapshot(db, c.VAULT_KEY, backupKey);
    writeFileSync(output, value, { flag: "wx", mode: 0o600 });
    console.info(
      `Encrypted snapshot created: ${output}. Copy off-machine; keep both keys separate.`,
    );
  } else {
    const snapshot = parseSnapshot(
      readFileSync(file, "utf8"),
      c.VAULT_KEY,
      backupKey,
    );
    for (const item of await db.listCollections().toArray())
      if (await db.collection(item.name).findOne({}))
        throw new Error(
          "Restore destination is not empty. No data was overwritten.",
        );
    await transaction(client, async (session) => {
      for (const name of BACKUP_COLLECTIONS) {
        const rows = snapshot.collections[name];
        if (name === "staff") for (const row of rows) row.authVersion += 1;
        if (rows.length)
          await db.collection(name).insertMany(rows, { session });
      }
    });
    console.info(
      `Restored into ${c.MONGODB_DB}. Sessions were excluded. Verify counts, login and encrypted connections before switching APP configuration.`,
    );
  }
} finally {
  await client.close();
}
