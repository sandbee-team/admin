import { it } from "node:test";
import assert from "node:assert/strict";
import { schemas } from "../shared/schemas.js";
import { config } from "../backend/config.js";
import { randomUUID } from "node:crypto";
import { verifyVaultKey } from "../backend/lib/vault.js";
import { equal } from "../backend/lib/crypto.js";
it("rejects multibyte CSRF input without a timingSafeEqual length exception", () => {
  assert.equal(equal("é", "a"), false);
  assert.equal(equal(undefined, "a"), false);
  assert.equal(equal("same", "same"), true);
});
it("validates blank optional URLs without throwing an internal URL exception", () => {
  const result = schemas.products.safeParse({
    name: "Product",
    slug: "product",
    description: "",
    category: "Business",
    model: "saas",
    pricing: "free",
    status: "planned",
    website: "",
  });
  assert.equal(result.success, true);
  assert.equal(
    schemas.products.safeParse({
      ...result.data,
      website: "https://username:password@example.test",
    }).success,
    false,
  );
  assert.equal(
    schemas.products.safeParse({
      ...result.data,
      website: "javascript:alert(1)",
    }).success,
    false,
  );
});
it("requires real production origins, secrets and SMTP authentication", () => {
  const base = {
    MONGODB_URI: "mongodb://localhost",
    VAULT_KEY: "a".repeat(64),
    AUTH_SECRET: "b".repeat(64),
    NODE_ENV: "production",
  };
  assert.throws(() => config(base));
  assert.throws(() =>
    config({
      ...base,
      APP_URL: "https://admin.example.test/path",
      SMTP_USER: "a",
      SMTP_PASSWORD: "b",
    }),
  );
  assert.equal(
    config({
      ...base,
      APP_URL: "https://admin.example.test",
      SMTP_USER: "a",
      SMTP_PASSWORD: "b",
    }).NODE_ENV,
    "production",
  );
});
it("validates strict identity fields and bounds long notes", () => {
  assert.equal(
    schemas.customers.safeParse({
      name: "Acme",
      email: "bad",
      company: "",
      phone: "",
      status: "active",
      notes: "",
    }).success,
    false,
  );
  assert.equal(
    schemas.tasks.safeParse({
      title: "Task",
      customerId: randomUUID(),
      installationId: "",
      assigneeId: "",
      status: "open",
      priority: "normal",
      dueAt: "2026-02-31",
      notes: "",
    }).success,
    false,
  );
});
it("vault verifier blocks a changed environment key", async () => {
  let document;
  const db = {
    collection: () => ({
      updateOne: async (_filter, update) => {
        document ??= update.$setOnInsert;
      },
      findOne: async () => document,
    }),
  };
  await verifyVaultKey(db, "a".repeat(64));
  await verifyVaultKey(db, "a".repeat(64));
  await assert.rejects(verifyVaultKey(db, "b".repeat(64)));
});
