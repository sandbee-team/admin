// Pure constants shared by the API, worker and panel for POS deploys (Stage 2).
// Nothing here touches the network, the database or the clock.
export const DEPLOY_STATES = [
  "queued",
  "running",
  "cancelling",
  "failed",
  "cancelled",
  "rolled-back",
  "unhealthy",
  "expired",
];
export const DEPLOY_KINDS = ["deploy", "redeploy", "rollback"];
// Internal worker steps, in order (rev 2 section 1, row 5).
export const DEPLOY_STEPS = [
  "queued",
  "preflight",
  "resolve",
  "build",
  "fetch",
  "upload",
  "vercel",
  "health",
  "finalize",
];
// The five steps the panel shows, mapped from the internal ones.
export const UI_STEPS = [
  { id: "resolve", label: "Resolve", steps: ["preflight", "resolve"] },
  { id: "build", label: "Build", steps: ["build", "fetch"] },
  { id: "upload", label: "Upload", steps: ["upload"] },
  { id: "live", label: "Go live", steps: ["vercel"] },
  { id: "health", label: "Health", steps: ["health", "finalize"] },
];
export const BUILD_STATES = [
  "queued",
  "dispatching",
  "building",
  "collecting",
  "storing",
  "ready",
  "failed",
  "cancelled",
];
export const TASK_KINDS = ["verify", "db-backup", "purge-preview", "purge"];
export const BUILD_SOURCES = ["cache", "fresh", "artifact"];
// Readiness item ids: one list for the UI checklist and the 409 not-ready body.
export const READINESS_ITEMS = [
  { id: "worker", group: "admin", required: true },
  { id: "builder", group: "admin", required: true },
  { id: "source-token", group: "admin", required: true },
  { id: "build-cache", group: "admin", required: false },
  { id: "authenticator", group: "admin", required: true },
  { id: "not-frozen", group: "admin", required: true },
  { id: "vercel-token", group: "client", required: true },
  { id: "project-ids", group: "client", required: true },
  { id: "verified", group: "client", required: true },
  { id: "host", group: "client", required: true },
  { id: "image-realtime", group: "client", required: true },
  { id: "unlocked", group: "client", required: true },
  { id: "customer-active", group: "client", required: true },
];
export const READINESS_IDS = READINESS_ITEMS.map((item) => item.id);
export const NEXT_PUBLIC_KEYS = [
  "NEXT_PUBLIC_R2_PUBLIC_BASE_URL",
  "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME",
  "NEXT_PUBLIC_REALTIME_URL",
];
export const SHA_RE = /^[0-9a-f]{40}$/;
export const BUILD_KEY_RE = /^[0-9a-f]{64}$/;
export const BRANCH_RE =
  /^(?!-)(?!.*\.\.)(?!\/)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;
export const isSha = (value) => typeof value === "string" && SHA_RE.test(value);
export const isBranch = (value) =>
  typeof value === "string" && BRANCH_RE.test(value);
export const sha7 = (sha) => (isSha(sha) ? sha.slice(0, 7) : "");
