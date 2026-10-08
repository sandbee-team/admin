import { z } from "zod";
import { MODELS, INSTALL_STATES, CHECKS } from "./policy.js";
import { PROVIDERS } from "./product-models.js";
const text = (max) => z.string().trim().max(max);
const name = text(120).min(2);
const id = z.uuid();
const optionalId = z.union([id, z.literal("")]).default("");
const https = z
  .union([
    z
      .url()
      .max(500)
      .refine((value) => {
        try {
          const u = new URL(value);
          return u.protocol === "https:" && !u.username && !u.password;
        } catch {
          return false;
        }
      }, "Use an HTTPS URL without credentials."),
    z.literal(""),
  ])
  .default("");
const date = z.union([z.iso.date(), z.literal("")]).default("");
export const schemas = {
  customers: z
    .object({
      name,
      email: z
        .email()
        .max(254)
        .transform((v) => v.toLowerCase()),
      company: text(160),
      phone: text(32),
      status: z.enum(["lead", "active", "paused", "archived"]),
      notes: text(2000),
      storeWorkspaceId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{0,100}$/)
        .default(""),
    })
    .strict(),
  products: z
    .object({
      name,
      slug: z.string().regex(/^[a-z][a-z0-9-]{1,48}$/),
      description: text(500),
      category: text(80).min(2),
      model: z.enum(MODELS),
      requiredProviders: z
        .array(z.enum(PROVIDERS))
        .max(PROVIDERS.length)
        .transform((values) => [...new Set(values)])
        .default([]),
      pricing: z.enum([
        "free",
        "prepaid",
        "one-time",
        "subscription",
        "custom",
      ]),
      status: z.enum(["active", "planned", "retired"]),
      website: https,
    })
    .strict(),
  installations: z
    .object({
      name,
      customerId: id,
      productId: id,
      environment: z.enum(["production", "staging", "development"]),
      status: z.enum(INSTALL_STATES),
      release: text(160),
      sourceUrl: https,
      endpoint: https,
      connectionIds: z.array(id).max(10),
      checks: z
        .array(z.enum(CHECKS.map((c) => c.id)))
        .max(CHECKS.length)
        .transform((v) => [...new Set(v)]),
      evidence: text(2000),
      notes: text(2000),
    })
    .strict(),
  connections: z
    .object({
      name,
      customerId: id,
      provider: z.enum(["vercel", "mongodb", "cloudflare", "aws", "other"]),
      ownership: z.enum(["customer", "sandbee"]),
      accountId: text(160),
      resourceId: text(160),
      expiresAt: date,
      status: z.enum(["recorded", "attention", "revoked"]),
      notes: text(1000),
    })
    .strict(),
  tasks: z
    .object({
      title: name,
      customerId: optionalId,
      installationId: optionalId,
      assigneeId: optionalId,
      status: z.enum(["open", "in-progress", "done"]),
      priority: z.enum(["normal", "high", "urgent"]),
      dueAt: date,
      notes: text(2000),
    })
    .strict(),
};
export const listQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    search: text(100).default(""),
    status: text(30).default(""),
    customerId: optionalId,
    productId: optionalId,
    model: z.union([z.enum(MODELS), z.literal("")]).default(""),
  })
  .strict();
