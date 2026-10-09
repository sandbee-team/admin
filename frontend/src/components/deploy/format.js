import { sha7 } from "../../../../shared/deploy";
export { sha7 };
export const when = (value, now = Date.now()) => {
  const time = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};
export const clock = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000)),
    minutes = Math.floor(total / 60),
    seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};
export const minutes = (ms) => Math.max(1, Math.round(ms / 60000));
export const ITEM_TITLES = {
  worker: "Deploy worker online",
  builder: "Builder ready",
  "source-token": "Source code access",
  "build-cache": "Build storage",
  authenticator: "Your authenticator",
  "not-frozen": "Deploys not frozen",
  "vercel-token": "Vercel token",
  "project-ids": "Vercel project",
  verified: "Credentials verified",
  host: "Web address",
  "image-realtime": "Image and realtime settings",
  unlocked: "Deploy lock",
  "customer-active": "Customer active",
};
export const titlesOf = (ids = []) =>
  ids.map((id) => ITEM_TITLES[id] || id).join(", ");
// Plain-language text for the stored failure code. Unknown codes fall back to
// the server's own short message (it never carries secrets or provider bodies).
const ERROR_TEXT = {
  unauthorized: "Vercel or GitHub refused the stored token. Check the token.",
  forbidden: "The token is not allowed to do this. Check its permissions.",
  "not-found": "Something the deploy needs no longer exists.",
  conflict: "The provider reported a conflict. Try again in a moment.",
  invalid: "The provider rejected the request.",
  "rate-limited": "The provider is rate limiting requests. Try again later.",
  unavailable: "The provider is having problems. Try again later.",
  timeout: "A step took too long and was stopped.",
  network: "The worker could not reach the provider.",
  "build-failed": "The build failed on GitHub. Open the run for the log.",
  "scan-failed": "The built output failed the safety scan and was not used.",
  "integrity-failed": "The stored build failed its integrity check.",
  "health-failed": "The new version did not pass its health check.",
  "worker-restarted": "The worker restarted and the job could not resume.",
  "attempts-exceeded": "The job was tried several times and gave up.",
  drift: "Vercel settings changed since the last verify. Verify again.",
};
export const errorText = (error) =>
  ERROR_TEXT[error?.code] || error?.message || "The deploy failed.";
export const STEP_LABEL = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
};
