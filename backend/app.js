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
import { accountRoutes } from "./modules/accounts.js";
import { fileRoutes } from "./modules/files.js";
import { posRoutes } from "./modules/pos.js";
import { deployRoutes } from "./modules/deploys.js";
import { dbBackupRoutes } from "./modules/db-backup.js";
import { posImportRoutes } from "./modules/pos-import.js";
import { ecomRoutes } from "./modules/ecom.js";
import { consume } from "./lib/limiter.js";
import { ensure } from "./lib/errors.js";
// The one route that takes a raw (streamed) body instead of JSON.
const UPLOAD_PATH =
  /^\/customers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files\/?$/i;
// The go-live import posts a whole client file, so it gets a larger JSON limit.
const IMPORT_PATH = /^\/pos\/import\/(preview|confirm)\/?$/i;
const isUpload = (req) => req.method === "POST" && UPLOAD_PATH.test(req.path);
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
        if (isUpload(req))
          ensure(
            /^application\/octet-stream\s*(;|$)/i.test(
              req.get("content-type") ?? "",
            ),
            415,
            "Upload the file as application/octet-stream.",
          );
        else ensure(req.is("application/json"), 415, "Use JSON requests.");
      }
      next();
    },
    (() => {
      const small = express.json({ limit: "32kb" }),
        large = express.json({ limit: "128kb" });
      return (req, res, next) =>
        (IMPORT_PATH.test(req.path) ? large : small)(req, res, next);
    })(),
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
  app.use("/api", accountRoutes(context));
  app.use("/api", fileRoutes(context));
  app.use("/api", posRoutes(context));
  app.use("/api", deployRoutes(context));
  app.use("/api", dbBackupRoutes(context));
  app.use("/api", posImportRoutes(context));
  app.use("/api", recordRoutes(context));
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API route not found." }),
  );
  app.use(
    express.static(path.join(root, "dist"), {
      maxAge: "1h",
      index: false,
      // The shell must never be restored from cache (bfcache could bring back
      // one-time setup data); hashed assets keep their cache.
      setHeaders: (res, file) => {
        if (path.basename(file) === "index.html")
          res.set("Cache-Control", "no-store");
      },
    }),
  );
  app.get("/{*path}", (_req, res) => {
    res.set("Cache-Control", "no-store");
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
            : status >= 500 && !error.expose
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
    res.status(status).json({
      error: message,
      ...(error.apiCode ? { code: error.apiCode } : {}),
      ...(error.items ? { items: error.items } : {}),
      requestId: req.requestId,
    });
  });
  return app;
}
