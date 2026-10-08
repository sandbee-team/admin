import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (!existsSync(".env")) {
  let value = readFileSync(".env.example", "utf8");
  value = value
    .replace("VAULT_KEY=", `VAULT_KEY=${randomBytes(32).toString("hex")}`)
    .replace("AUTH_SECRET=", `AUTH_SECRET=${randomBytes(48).toString("hex")}`);
  writeFileSync(".env", value, { mode: 0o600 });
}
mkdirSync(".local", { recursive: true });
if (!existsSync(".local/backup-key.txt"))
  writeFileSync(".local/backup-key.txt", randomBytes(32).toString("hex"), {
    mode: 0o600,
  });
console.info(
  "Local environment ready. Keep .env and .local/backup-key.txt in a separate secure off-machine location.",
);
