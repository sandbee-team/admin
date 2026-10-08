import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { LRUCache } from "lru-cache";
import { authModule } from "./modules/auth.js";
import { recordRoutes } from "./modules/records.js";
import { teamRoutes } from "./modules/team.js";
import { overviewRoutes } from "./modules/overview.js";
import { ecomRoutes } from "./modules/ecom.js";
import { consume } from "./lib/limiter.js";
import { ensure } from "./lib/errors.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createApp(deps) {
  const { db, c } = deps,
    app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", c.TRUST_PROXY_HOPS);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: c.NODE_ENV === "production" ? [] : null,
        },
      },
      strictTransportSecurity: c.NODE_ENV === "production" ? undefined : false,
    }),
  );
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set("X-Request-Id", req.requestId);
    res.set("X-Robots-Tag", "noindex, nofollow");
    next();
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/ready", async (_req, res) => {
    await db.command({ ping: 1 });
    res.json({ ok: true });
  });
  app.use(
    "/api",
    (req, res, next) => {
      res.set("Cache-Control", "no-store");
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        ensure(
          req.get("origin") === new URL(c.APP_URL).origin,
          403,
          "This request origin is not allowed.",
        );
        ensure(req.is("application/json"), 415, "Use JSON requests.");
      }
      next();
    },
    express.json({ limit: "32kb" }),
    cookieParser(),
    async (req, _res, next) => {
      await consume(db, `api-ip:${req.ip}`, 400, 60000);
      next();
    },
  );
  const cache = new LRUCache({ max: 20, ttl: 5000 });
  const auth = authModule(deps),
    context = { ...deps, auth, cache };
  app.use("/api/auth", auth.router);
  app.use("/api/team", teamRoutes(context));
  app.use("/api/ecom", ecomRoutes(context));
  app.use("/api", overviewRoutes(context));
  app.use("/api", recordRoutes(context));
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API route not found." }),
  );
  app.use(
    express.static(path.join(root, "dist"), { maxAge: "1h", index: false }),
  );
  app.get("/{*path}", (_req, res) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.join(root, "dist/index.html"));
  });
  app.use((error, req, res, _next) => {
    const status =
      error instanceof ZodError
        ? 400
        : error.code === 11000
          ? 409
          : error.status || 500;
    const message =
      error instanceof SyntaxError
        ? "Malformed JSON request."
        : error instanceof ZodError
          ? error.issues
              .map((i) => `${i.path.join(".") || "Input"}: ${i.message}`)
              .join("; ")
          : error.code === 11000
            ? "A record with these identifying details already exists."
            : status >= 500
              ? "Service unavailable. Please retry shortly."
              : error.message;
    // Never log request bodies, credentials, Mongo URIs or provider responses.
    if (status >= 500)
      console.error(
        JSON.stringify({
          requestId: req.requestId,
          status,
          event: "request.failed",
          type: error.name,
        }),
      );
    if (status === 429) res.set("Retry-After", "60");
    res.status(status).json({ error: message, requestId: req.requestId });
  });
  return app;
}
