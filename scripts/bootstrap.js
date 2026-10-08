import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { config } from "../backend/config.js";
import { connect, transaction } from "../backend/db.js";
import { hashPassword } from "../backend/lib/crypto.js";
import { audit } from "../backend/lib/audit.js";
const c = config(),
  emailArg = process.argv.find((arg) => arg.startsWith("--email="))?.slice(8);
if (c.NODE_ENV === "production" && !emailArg)
  throw new Error("Provide --email=YOUR_EMAIL for the initial owner.");
const email = z
  .email()
  .parse(emailArg || "owner@sandbee.local")
  .toLowerCase();
const { db, client } = await connect(c);
try {
  if (await db.collection("staff").findOne({ role: "owner" })) {
    console.info("Owner already exists. Bootstrap made no changes.");
  } else {
    const password = randomBytes(24).toString("base64url");
    const row = {
      _id: "00000000-0000-4000-8000-000000000001",
      email,
      name: "Workspace owner",
      role: "owner",
      status: "active",
      authVersion: 1,
      revision: 1,
      passwordHash: await hashPassword(password),
      createdAt: new Date(),
    };
    await transaction(client, async (session) => {
      await db.collection("staff").insertOne(row, { session });
      await audit(db, session, row, "owner.bootstrapped", "staff", row._id);
    });
    mkdirSync(".local", { recursive: true });
    writeFileSync(
      ".local/owner-access.txt",
      `Sandbee Admin\nEmail: ${email}\nPassword: ${password}\nLogin requires the email OTP as well.\nChange this password through account recovery after first access.\n`,
      { mode: 0o600 },
    );
    console.info(
      "Owner created. Initial access details saved to .local/owner-access.txt (not printed).",
    );
  }
} finally {
  await client.close();
}
