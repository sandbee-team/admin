// The single table of every code a usage check stores in `pos.usage.last` or
// `pos.usage.check.error` (same style as shared/deploy-errors.js). The worker
// stores only codes from here (anything else is written as "internal" via
// isUsageCode); the panel imports the same table
// to show a title, a plain message and what to do next. Pure data.
export const USAGE_CODE_RE = /^[a-z0-9-]{1,40}$/;
const T = {};
const add = (code, area, title, plainMessage, action) => {
  if (!USAGE_CODE_RE.test(code)) throw new Error(`bad code ${code}`);
  if (plainMessage.length > 160) throw new Error(`message too long ${code}`);
  T[code] = { area, title, plainMessage, action };
};
const NONE = "No action needed.";
const RETRY = "Check again in a few minutes.";
const SETUP = "Fix it in POS setup, then check again.";

add("ok", "any", "OK", "Answered as expected.", NONE);

// ---- site (GET https://<host>/api/health) -----------------------------------
add(
  "paused",
  "site",
  "Paused by Vercel",
  "Vercel answered 503 DEPLOYMENT_PAUSED: the client's Hobby project is paused (usage limits or a policy).",
  "Open the client's Vercel dashboard (Usage) and inform the client.",
);
add(
  "http-error",
  "site",
  "Site error",
  "The POS answered the health check with an HTTP error.",
  "Open the site; if it stays down, check the last deploy.",
);
add(
  "db-down",
  "site",
  "Database unreachable",
  "The POS is up but cannot reach its database cluster.",
  "Check Atlas Network Access (0.0.0.0/0) and the cluster state.",
);
add(
  "bad-body",
  "site",
  "Unexpected answer",
  "The health check answer was not in the POS health format.",
  "Check that the web address points at this client's Vercel project.",
);
add(
  "tenant-mismatch",
  "site",
  "Wrong tenant",
  "The site answered for a different tenant than this installation.",
  "Check the host and TENANT_ID of this client.",
);
add(
  "timeout",
  "site",
  "No answer in time",
  "The POS did not answer the health check within 10 seconds.",
  RETRY,
);
add(
  "no-response",
  "site",
  "No response",
  "The POS could not be reached.",
  "Check the DNS of the web address and the Vercel project.",
);
add(
  "blocked",
  "site",
  "Address refused",
  "The web address resolves to a non-public address, so it was not called.",
  "Fix the DNS of the web address.",
);
add(
  "bad-host",
  "site",
  "Invalid web address",
  "The installation has no valid public web address.",
  SETUP,
);
add(
  "too-large",
  "site",
  "Answer too large",
  "The health check answer was larger than 64 KB.",
  "Check that the web address points at the POS.",
);
add(
  "aborted",
  "site",
  "Stopped",
  "The check was stopped before the POS answered.",
  RETRY,
);
add(
  "no-host",
  "site",
  "No web address",
  "No host is set for this installation, so nothing was checked.",
  SETUP,
);

// ---- storage (cafe health stats, else dbStats via the stored URI) -----------
add(
  "stats-denied",
  "storage",
  "Stats token mismatch",
  "The POS refused the health stats token stored in admin (it changed on the client).",
  "Replace the health stats token in POS setup.",
);
add(
  "stats-error",
  "storage",
  "Stats failed on the POS",
  "The POS could not measure its clusters this time.",
  RETRY,
);
add(
  "stats-host-changed",
  "storage",
  "Stats token not sent",
  "The health stats token was saved for another web address, so it was not sent to this one.",
  "Check that the web address is correct, then save the health stats token again in POS setup.",
);
add(
  "stats-token-invalid",
  "storage",
  "Stats token unusable",
  "The stored health stats token contains characters that cannot be sent in a request header.",
  "Replace the health stats token in POS setup.",
);
add(
  "stats-not-set",
  "storage",
  "Stats token not set",
  "No health stats token is stored and the POS requires one.",
  "Add the health stats token in POS setup.",
);
add(
  "stats-bad-body",
  "storage",
  "Stats not understood",
  "The POS answered without readable cluster stats.",
  "Check that the deployed POS version reports stats.",
);
add(
  "stats-unavailable",
  "storage",
  "Stats unavailable",
  "The site did not answer, so the POS stats could not be read.",
  "See the site result.",
);
add(
  "mongo-not-set",
  "storage",
  "Database URI not set",
  "No database connection string is stored, so the direct check was skipped.",
  "Add the MongoDB URI in POS setup.",
);
add(
  "mongo-invalid",
  "storage",
  "Database URI invalid",
  "The stored database connection string could not be read.",
  SETUP,
);
add(
  "mongo-not-atlas",
  "storage",
  "Not an Atlas database",
  "The stored database host is not on mongodb.net, so it was not contacted.",
  SETUP,
);
add(
  "mongo-auth-failed",
  "storage",
  "Database login failed",
  "The database refused the stored user or password.",
  SETUP,
);
add(
  "mongo-unreachable",
  "storage",
  "Database unreachable",
  "The database could not be reached from the admin server.",
  "Check Atlas Network Access for the admin server.",
);
add(
  "mongo-stats-failed",
  "storage",
  "Database size unknown",
  "The database did not report its size.",
  RETRY,
);

// ---- Cloudflare Worker requests (GraphQL Analytics) -------------------------
add(
  "cf-not-set",
  "cloudflare",
  "Cloudflare not set",
  "No Cloudflare token or account id is stored for this client.",
  "Add both in POS setup.",
);
add(
  "cf-denied",
  "cloudflare",
  "Analytics permission missing",
  "The client's Cloudflare token cannot read analytics (Account Analytics: Read).",
  "Edit the token in the client's Cloudflare dashboard and add Account Analytics: Read.",
);
add(
  "cf-unauthorized",
  "cloudflare",
  "Cloudflare token rejected",
  "Cloudflare rejected the stored token.",
  "Create a new token and replace it in POS setup.",
);
add(
  "cf-rate-limited",
  "cloudflare",
  "Cloudflare busy",
  "Cloudflare limited the analytics requests.",
  RETRY,
);
add(
  "cf-unavailable",
  "cloudflare",
  "Cloudflare unavailable",
  "Cloudflare analytics did not answer.",
  RETRY,
);
add(
  "cf-bad-response",
  "cloudflare",
  "Analytics not understood",
  "Cloudflare answered in an unexpected format.",
  RETRY,
);
add(
  "cf-failed",
  "cloudflare",
  "Analytics failed",
  "The Cloudflare analytics request failed.",
  RETRY,
);

// ---- credentials (Vercel tokens/current, Cloudflare tokens/verify) ----------
add(
  "token-not-set",
  "credentials",
  "Token not set",
  "No token is stored for this service.",
  NONE,
);
add(
  "token-invalid",
  "credentials",
  "Token invalid",
  "The provider rejected this token (revoked, disabled or expired).",
  "Create a new token and replace it in POS setup.",
);
add(
  "expiry-unknown",
  "credentials",
  "Expiry unknown",
  "The provider did not say when this token expires.",
  NONE,
);
add(
  "token-check-failed",
  "credentials",
  "Token check failed",
  "The token could not be checked this time.",
  RETRY,
);

// ---- the check itself ---------------------------------------------------------
add(
  "secret-unreadable",
  "check",
  "Secret unreadable",
  "A stored secret could not be decrypted, so this part was not checked.",
  "Replace the secret in POS setup.",
);
add(
  "not-picked-up",
  "check",
  "Not picked up",
  "The worker was offline too long to start this check.",
  "Check that the worker is online, then check again.",
);
add(
  "worker-stopped",
  "check",
  "Worker stopped",
  "The worker stopped repeatedly during this check.",
  "Check the worker, then check again.",
);
add(
  "check-timeout",
  "check",
  "Check took too long",
  "The check did not finish within its time budget and was stopped; the previous result is kept.",
  "Check again in a few minutes.",
);
add(
  "internal",
  "check",
  "Internal error",
  "Something unexpected went wrong during the check.",
  RETRY,
);

export const USAGE_CODES = Object.freeze(T);
export const isUsageCode = (code) =>
  typeof code === "string" && Object.hasOwn(T, code);
// Always returns a usable entry (unknown codes read as "internal").
export const describeUsageCode = (code) =>
  isUsageCode(code) ? T[code] : T.internal;
// Throws for a code that is not in the table: the worker never writes free text.
export function knownUsageCode(code) {
  if (!isUsageCode(code))
    throw new Error(`Unknown usage code: ${String(code).slice(0, 40)}`);
  return code;
}
