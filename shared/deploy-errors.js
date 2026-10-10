// The single table of every failure or status code the deploy worker can store
// in `current.error.code`, a task error or a verify flag. The worker only emits
// codes from here (JobFail/AcceptError check them); the panel imports the same
// table to show a title, a plain message and what to do next. Pure data: no
// network, database or clock. Codes match ^[a-z0-9-]{1,40}$.
export const CODE_RE = /^[a-z0-9-]{1,40}$/;
const T = {};
const add = (code, step, title, plainMessage, action) => {
  if (!CODE_RE.test(code)) throw new Error(`bad code ${code}`);
  if (plainMessage.length > 160) throw new Error(`message too long ${code}`);
  T[code] = { step, title, plainMessage, action };
};
const NONE = "No action needed.";
const RETRY = "Try again in a few minutes.";
const LOOK = "Open the GitHub run for details.";

// ---- job lifecycle ------------------------------------------------------------
add(
  "cancelled",
  "queued",
  "Cancelled",
  "The deploy was cancelled before anything went live.",
  NONE,
);
add(
  "frozen",
  "queued",
  "Deploys frozen",
  "Deploys are frozen for all clients, so this one was stopped before upload.",
  "Ask the owner to unfreeze deploys, then deploy again.",
);
add(
  "expired",
  "queued",
  "Not picked up",
  "The worker did not pick this deploy up within 10 minutes.",
  "Check that the worker is online, then deploy again.",
);
add(
  "worker-stopped",
  "queued",
  "Worker stopped",
  "The worker stopped repeatedly while running this job.",
  "Check the worker container, then try again.",
);
add(
  "internal",
  "queued",
  "Unexpected error",
  "The worker hit an unexpected error.",
  "Try again; if it repeats, check the worker logs.",
);
add(
  "unsupported",
  "queued",
  "Not available",
  "This task is not available in this worker version.",
  "Update the worker image.",
);
add(
  "bad-id",
  "queued",
  "Invalid job",
  "The job id is not valid.",
  "Start a new deploy.",
);
add(
  "not-found",
  "preflight",
  "Client gone",
  "The installation no longer exists.",
  "Reload the page.",
);
add(
  "locked",
  "preflight",
  "Deploys locked",
  "Deploys are locked for this client.",
  "The owner must unlock deploys for this client.",
);
add(
  "customer-inactive",
  "preflight",
  "Client inactive",
  "The customer is paused or archived, or the installation is retired.",
  "Reactivate the customer first.",
);
add(
  "no-token",
  "preflight",
  "No Vercel token",
  "No Vercel token is stored for this client.",
  "Add the client's Vercel token in POS setup.",
);
add(
  "secret-unreadable",
  "preflight",
  "Secret unreadable",
  "A stored secret could not be decrypted.",
  "Check the vault key, or save the secret again.",
);
add(
  "project-settings",
  "preflight",
  "Project settings differ",
  "The Vercel project settings are not the expected Next.js, apps/cafe, Node 22 setup.",
  "Fix the project settings in Vercel, then verify again.",
);
add(
  "env-drift",
  "preflight",
  "Environment differs",
  "A plain Vercel environment value differs from what admin expects.",
  "Fix the listed variables in Vercel, then verify again.",
);
add(
  "env-missing",
  "preflight",
  "Environment incomplete",
  "The Vercel project is missing required environment variables.",
  "Add the listed variables in Vercel, then verify again.",
);
add(
  "target-changed",
  "preflight",
  "Target changed",
  "The rollback target changed while the job waited.",
  "Reload and choose the rollback again.",
);
add(
  "production-changed",
  "vercel",
  "Production changed",
  "Production was changed outside admin, so admin did not touch it.",
  "Check the Vercel dashboard, then deploy again.",
);
// ---- build --------------------------------------------------------------------
add(
  "builder-not-ready",
  "resolve",
  "Builder not ready",
  "The builder is unreachable or its CLI version differs from the worker's.",
  "Update the worker image or pos-builder, then retry.",
);
add(
  "build-inputs",
  "resolve",
  "Build settings invalid",
  "Image or realtime settings cannot be used for a build.",
  "Fix the image and realtime settings in POS setup.",
);
add(
  "build-busy",
  "build",
  "Build queue full",
  "Too many deploys are waiting for the same build.",
  RETRY,
);
add(
  "build-vanished",
  "build",
  "Build lost",
  "The build disappeared before it finished.",
  "Deploy again.",
);
add(
  "build-cancelled",
  "build",
  "Build cancelled",
  "The GitHub build was cancelled.",
  "Deploy again.",
);
add(
  "build-failed",
  "build",
  "Build failed",
  "The POS build failed on GitHub.",
  LOOK,
);
add(
  "build-timeout",
  "build",
  "Build too slow",
  "The GitHub build ran for more than 30 minutes and was cancelled.",
  LOOK,
);
add(
  "build-queued-timeout",
  "build",
  "Build never started",
  "GitHub did not start the build within 15 minutes.",
  "Check GitHub Actions status, then retry.",
);
add(
  "dispatch-lost",
  "build",
  "Build not started",
  "GitHub did not report the build run.",
  RETRY,
);
add(
  "source-read",
  "build",
  "Source unreadable",
  "The builder could not read the POS source repository.",
  "Check the builder's LUCIFER_READ_TOKEN in pos-builder.",
);
add(
  "bad-inputs",
  "build",
  "Inputs rejected",
  "The builder rejected the build inputs.",
  "Contact support with the GitHub run link.",
);
add(
  "builder-versions",
  "build",
  "Builder versions differ",
  "The builder's tool versions do not match its descriptor.",
  "Fix pos-builder, then retry.",
);
add(
  "scan-failed",
  "build",
  "Safety scan failed",
  "The build output failed the safety scan.",
  LOOK,
);
add(
  "no-space",
  "fetch",
  "Disk almost full",
  "The worker's work volume has less than 2 GB free.",
  "Free space on the server, then retry.",
);
add(
  "build-gone",
  "fetch",
  "Build missing",
  "The built output is no longer available.",
  "Deploy again to rebuild.",
);
add(
  "cache-integrity",
  "fetch",
  "Cache check failed",
  "The stored build failed its integrity check twice.",
  "Deploy again; if it repeats, tell support.",
);
add(
  "deployment-not-found",
  "upload",
  "Deployment not found",
  "Vercel did not report the new deployment.",
  "Check the Vercel project, then deploy again.",
);
add(
  "tar-invalid",
  "upload",
  "Output invalid",
  "The build output failed validation.",
  "Deploy again to rebuild.",
);
// ---- builder acceptance -------------------------------------------------------
add(
  "run-not-success",
  "build",
  "Run not successful",
  "The builder run did not finish successfully.",
  LOOK,
);
add(
  "run-provenance",
  "build",
  "Unexpected run",
  "The run is not a dispatch of the expected workflow on the main branch.",
  "Check pos-builder settings.",
);
add(
  "run-not-latest",
  "build",
  "Old run attempt",
  "The artifact is not from the latest attempt of the run.",
  "Deploy again.",
);
add(
  "artifact-count",
  "build",
  "Wrong artifacts",
  "The run did not produce exactly one build artifact.",
  LOOK,
);
add(
  "artifact-expired",
  "build",
  "Artifact expired",
  "The build artifact expired before it was collected.",
  "Deploy again.",
);
add(
  "artifact-digest",
  "build",
  "No artifact digest",
  "GitHub gave no digest for the build artifact.",
  RETRY,
);
add(
  "artifact-digest-mismatch",
  "build",
  "Artifact altered",
  "The downloaded artifact does not match its digest.",
  "Deploy again; if it repeats, tell support.",
);
add(
  "artifact-too-large",
  "build",
  "Artifact too large",
  "The build artifact is larger than the allowed size.",
  "Tell support.",
);
add(
  "artifact-redirect-host",
  "build",
  "Download refused",
  "The artifact download pointed at an unexpected host.",
  "Tell support.",
);
add(
  "zip-invalid",
  "build",
  "Archive invalid",
  "The artifact is not the expected archive.",
  "Deploy again.",
);
add(
  "too-large",
  "build",
  "Archive too large",
  "A file in the artifact is larger than allowed.",
  "Tell support.",
);
add(
  "manifest-invalid",
  "build",
  "Manifest unreadable",
  "The builder manifest could not be read.",
  "Deploy again.",
);
add(
  "manifest-mismatch",
  "build",
  "Manifest mismatch",
  "The builder manifest does not match what was requested.",
  "Deploy again; if it repeats, tell support.",
);
add(
  "scan-unclean",
  "build",
  "Scan not clean",
  "The builder reported findings in the build output.",
  LOOK,
);
add(
  "builder-unreadable",
  "build",
  "Builder unreadable",
  "The builder descriptor at the run's commit could not be read.",
  RETRY,
);
add(
  "cli-mismatch",
  "build",
  "CLI version differs",
  "The build was made with another Vercel CLI version than the worker's.",
  "Update the worker image or pos-builder.",
);
// ---- vercel: ready, promote, alias, rollback ----------------------------------
add(
  "vercel-build-error",
  "vercel",
  "Vercel build failed",
  "Vercel could not make the deployment ready; production was not changed.",
  "Check the deployment in Vercel, then deploy again.",
);
add(
  "vercel-timeout",
  "vercel",
  "Vercel too slow",
  "Vercel took too long to make the deployment ready.",
  RETRY,
);
add(
  "promote-failed",
  "vercel",
  "Promote failed",
  "Vercel did not promote the new deployment.",
  "Check the Vercel project, then deploy again.",
);
add(
  "alias-failed",
  "vercel",
  "Domain switch failed",
  "Vercel could not point production at the new deployment.",
  "Check the Vercel project, then deploy again.",
);
add(
  "alias-timeout",
  "vercel",
  "Domain switch slow",
  "Vercel took too long to switch production.",
  "Check the Vercel project.",
);
add(
  "rollback-gone",
  "vercel",
  "Previous version gone",
  "The previous deployment no longer exists in Vercel.",
  "Deploy that branch again.",
);
add(
  "rollback-refused",
  "vercel",
  "Rollback refused",
  "Vercel refused the rollback and no cached build can replace it.",
  "Deploy that branch again.",
);
add(
  "health-failed",
  "health",
  "Health check failed",
  "The new version failed its health check after going live.",
  "Check the client's site and logs; deploy again after fixing.",
);
// ---- CLI categories -----------------------------------------------------------
for (const [c, title, msg, action] of [
  [
    "rootdir-missing",
    "Root directory",
    "The Vercel project root directory is not usable.",
    "Check the project settings in Vercel.",
  ],
  [
    "settings-mismatch",
    "Project settings",
    "The Vercel project settings do not match.",
    "Check the project settings in Vercel.",
  ],
  [
    "no-prebuilt-output",
    "No output",
    "Vercel found no prebuilt output.",
    "Deploy again to rebuild.",
  ],
  [
    "framework-missing",
    "Framework settings",
    "Vercel could not use the project's framework settings.",
    "Check the project settings in Vercel.",
  ],
  [
    "auth-invalid-token",
    "Token rejected",
    "Vercel rejected the stored token.",
    "Save a new Vercel token in POS setup.",
  ],
  ["rate-limited", "Rate limited", "Vercel is rate limiting requests.", RETRY],
  [
    "network-error",
    "Network error",
    "The network failed while uploading to Vercel.",
    RETRY,
  ],
  ["upload-error", "Upload failed", "The upload to Vercel failed.", RETRY],
  ["timeout", "Upload too slow", "The Vercel upload took too long.", RETRY],
  [
    "spawn-failed",
    "CLI not started",
    "The Vercel CLI could not be started.",
    "Update the worker image.",
  ],
  [
    "other",
    "Upload failed",
    "The Vercel upload failed.",
    "Try again; if it repeats, check the worker logs.",
  ],
])
  add(`cli-${c}`, "upload", title, msg, action);
// ---- provider codes (provider-http.js, github.js, vercel.js) --------------------
const PROVIDER = {
  unauthorized: [
    "Token rejected",
    "The provider rejected the stored token.",
    "Replace the token.",
  ],
  forbidden: [
    "Access refused",
    "The provider refused access for this token.",
    "Check the token's permissions.",
  ],
  "not-found": [
    "Not found",
    "The provider could not find the item.",
    "Check the ids and names.",
  ],
  conflict: ["Conflict", "The provider reported a conflict.", RETRY],
  invalid: [
    "Request invalid",
    "The provider rejected the request as invalid.",
    "Check the settings.",
  ],
  "rate-limited": [
    "Rate limited",
    "The provider is rate limiting requests.",
    RETRY,
  ],
  unavailable: [
    "Provider down",
    "The provider is temporarily unavailable.",
    RETRY,
  ],
  timeout: ["Provider too slow", "The provider did not answer in time.", RETRY],
  network: ["Network error", "The provider could not be reached.", RETRY],
  redirect: [
    "Unexpected redirect",
    "The provider answered with an unexpected redirect.",
    "Tell support.",
  ],
  rejected: [
    "Request rejected",
    "The provider rejected the request.",
    "Check the settings.",
  ],
  "too-large": [
    "Response too large",
    "The provider's answer was larger than allowed.",
    "Tell support.",
  ],
  "bad-response": [
    "Odd response",
    "The provider's answer was not understood.",
    RETRY,
  ],
  aborted: ["Interrupted", "The request was interrupted.", RETRY],
  "no-digest": ["No digest", "GitHub gave no digest for the artifact.", RETRY],
  expired: ["Expired", "The provider item expired.", "Deploy again."],
  "redirect-host": [
    "Download refused",
    "The download pointed at an unexpected host.",
    "Tell support.",
  ],
  "digest-mismatch": [
    "Altered download",
    "The download does not match its digest.",
    "Deploy again.",
  ],
  "blob-failed": ["Download failed", "GitHub's file download failed.", RETRY],
  stalled: ["Download stalled", "The download stopped making progress.", RETRY],
  "not-configured": [
    "Not configured",
    "The provider is not configured.",
    "Set the token in the server settings.",
  ],
  failed: ["Failed", "The provider request failed.", RETRY],
};
for (const [code, [title, msg, action]] of Object.entries(PROVIDER)) {
  for (const p of ["github", "vercel", "cloudflare"])
    add(
      `${p}-${code}`,
      p === "github" ? "build" : "vercel",
      title,
      msg,
      action,
    );
  // Bare provider codes appear as verify flags and as project/env flags.
  add(
    `project-${code}`,
    "preflight",
    title,
    `The Vercel project could not be read: ${msg.toLowerCase()}`.slice(0, 160),
    action,
  );
  add(
    `env-${code}`,
    "preflight",
    title,
    `The Vercel environment could not be read: ${msg.toLowerCase()}`.slice(
      0,
      160,
    ),
    action,
  );
}
// ---- build cache (build-cache.js) -------------------------------------------------
for (const [c, msg] of [
  ["seal-failed", "The build could not be sealed for the cache."],
  ["output-mismatch", "The sealed output does not match the checked one."],
  ["bad-info", "The cache entry description was invalid."],
  ["contested", "Another worker kept replacing the cache entry."],
  ["bad-input", "The cache entry id was invalid."],
  ["object-missing", "The cached build file is missing."],
  ["bad-size", "The cached build has the wrong size."],
  ["bad-object-hash", "The cached build failed its hash check."],
  ["bad-magic", "The cached build is not in the expected format."],
  ["bad-key", "The cached build could not be unlocked."],
  ["bad-tag", "The cached build failed its authenticity check."],
  ["bad-output", "The cached build decrypted to unexpected content."],
  ["too-large", "The cache manifest is too large."],
  ["bad-json", "The cache manifest is not valid."],
  ["bad-schema", "The cache manifest has an unexpected shape."],
  ["bad-mac", "The cache manifest failed its authenticity check."],
  ["path-mismatch", "The cache manifest is for another build."],
  ["unclean-scan", "The cache manifest records an unclean scan."],
  ["bad-tar", "The cache manifest records an invalid archive."],
])
  add(
    `cache-${c}`,
    "fetch",
    "Build cache problem",
    msg,
    "Deploy again to rebuild.",
  );
// ---- verify / task flags and codes -------------------------------------------------
for (const [c, msg, action] of [
  [
    "settings",
    "The Vercel project settings are not the expected ones.",
    "Fix the project settings in Vercel.",
  ],
  ["missing", "Required values are missing.", "Add them in Vercel."],
  [
    "drift",
    "A plain Vercel value differs from admin's.",
    "Fix the variable in Vercel.",
  ],
  [
    "unhealthy",
    "The client's health endpoint failed.",
    "Check the client's site.",
  ],
  [
    "login-failed",
    "The client's login page failed.",
    "Check the client's site.",
  ],
  ["not-set", "No value is stored for this check.", "Add it in POS setup."],
  [
    "not-atlas",
    "The client database is not an Atlas cluster.",
    "Use the Atlas connection string.",
  ],
  [
    "auth-failed",
    "The client database rejected the credentials.",
    "Save a new database URI.",
  ],
  [
    "unreachable",
    "The client database could not be reached.",
    "Check Atlas network access.",
  ],
  ["invalid", "The value is not valid.", "Check the setting."],
  [
    "no-cutover",
    "Purge needs a first verified admin deploy.",
    "Deploy once, then try again.",
  ],
  [
    "digest-mismatch",
    "The purge list does not match what was confirmed.",
    "Preview again, then confirm.",
  ],
  ["delete-failed", "Some deployments could not be deleted.", RETRY],
])
  add(c, "task", c.replace(/-/g, " "), msg, action);
for (const code of [
  "unauthorized",
  "forbidden",
  "not-found",
  "rate-limited",
  "unavailable",
  "timeout",
  "network",
  "failed",
])
  if (!T[code])
    add(code, "task", PROVIDER[code][0], PROVIDER[code][1], PROVIDER[code][2]);
// ---- client database backup ---------------------------------------------------------
add(
  "backup-too-large",
  "backup",
  "Backup too large",
  "The database is over 20 MB compressed, so nothing was stored.",
  "Run mongodump on your own computer instead.",
);
add(
  "backup-failed",
  "backup",
  "Backup failed",
  "The database backup could not be completed.",
  RETRY,
);
add(
  "backup-no-uri",
  "backup",
  "No database URI",
  "No database URI is stored for this client.",
  "Add the URI in POS setup.",
);
add(
  "backup-no-storage",
  "backup",
  "Storage off",
  "File storage is not configured.",
  "Set up S3 storage first.",
);

export const ERROR_CODES = Object.freeze(T);
export const isKnownCode = (code) =>
  typeof code === "string" && Object.hasOwn(T, code);
// Always returns a usable entry (unknown codes read as "internal").
export const describeCode = (code) => T[code] ?? T.internal;
// Throws for a code that is not in the table: the worker never writes free text.
export function knownCode(code) {
  if (!isKnownCode(code))
    throw new Error(`Unknown error code: ${String(code).slice(0, 40)}`);
  return code;
}
