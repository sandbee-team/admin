import { Router } from "express";
import { z } from "zod";
import { ensure, HttpError } from "../lib/errors.js";
import { can } from "../../shared/policy.js";
export function ecomRoutes({ db, c, auth }) {
  const router = Router();
  router.use(auth.requireAuth);
  async function request(path, options = {}) {
    ensure(
      c.ECOM_SERVICE_URL && c.ECOM_SERVICE_KEY,
      503,
      "Ecom bridge is not configured. Set ECOM_SERVICE_URL and ECOM_SERVICE_KEY on the Admin server.",
    );
    // Upstream failures are Bad Gateway, never the upstream's own status: a
    // 401 from Ecom must not look like an expired Admin session (the console
    // signs the user out on 401). Upstream error text is never forwarded.
    const upstream = (message, code) => {
      const error = new HttpError(502, message, true);
      error.apiCode = code;
      return error;
    };
    let response, data;
    try {
      response = await fetch(new URL(path, c.ECOM_SERVICE_URL), {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${c.ECOM_SERVICE_KEY}`,
        },
      });
    } catch {
      throw upstream("The Ecom service is unavailable.", "upstream");
    }
    if ([401, 403].includes(response.status))
      throw upstream(
        "The Ecom service rejected Admin's service key.",
        "upstream-auth",
      );
    try {
      data = await response.json();
    } catch {
      throw upstream(
        "The Ecom service sent an unreadable response.",
        "upstream",
      );
    }
    if (!response.ok)
      throw upstream(
        "The Ecom service could not complete the request.",
        "upstream",
      );
    return data;
  }
  router.get("/tenants", async (req, res) => {
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(1)
      .parse(req.query.page);
    if (!c.ECOM_SERVICE_URL || !c.ECOM_SERVICE_KEY)
      return res.json({ connected: false, items: [], total: 0 });
    res.json(await request(`/internal/tenants?page=${page}`));
  });
  router.put("/tenants/:id/subscription", async (req, res) => {
    const current = await db.collection("staff").findOne({
      _id: req.staff._id,
      status: "active",
      authVersion: req.staff.authVersion,
    });
    ensure(
      current && can(current.role, "catalog"),
      403,
      "Only an owner or admin can manage subscriptions.",
    );
    const id = z.uuid().parse(req.params.id);
    const input = z
      .object({
        plan: z.enum(["starter", "growth", "scale"]),
        state: z.enum(["active", "suspended", "cancelled"]),
        expiresAt: z.iso.datetime(),
        reason: z.string().trim().min(10).max(500),
        revision: z.number().int().min(0),
      })
      .strict()
      .parse(req.body);
    // Ecom commits subscription and authoritative audit together. No transaction
    // spans both services; stale retries are rejected by subscription revision.
    res.json(
      await request(`/internal/tenants/${id}/subscription`, {
        method: "PUT",
        body: JSON.stringify({ ...input, actor: current._id }),
      }),
    );
  });
  return router;
}
