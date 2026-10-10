import { sha7 } from "../../../../shared/deploy";
import { describeCode, isKnownCode } from "../../../../shared/deploy-errors";
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
export const PRE_ADMIN =
  "Version before admin took over (deployed outside admin)";
// branch@sha7, or a plain label for a pre-admin baseline (no sha, no link).
export const versionRef = (item) =>
  item?.sha ? `${item.branch || "unknown"}@${sha7(item.sha)}` : PRE_ADMIN;
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
// Title, plain message and next step for a stored code, from the one shared
// table. An unknown code reads as "internal" and keeps the server's own short
// message (it never carries secrets or provider bodies).
export function describeError(error) {
  const known = isKnownCode(error?.code),
    entry = describeCode(error?.code);
  return {
    ...entry,
    known,
    extra: !known && error?.message ? error.message : "",
  };
}
export const errorText = (error) => describeError(error).plainMessage;
// "Branch@sha7 - headline - author - when" for a commit-bearing record.
export function commitLine(item) {
  const c = item?.commit;
  return [
    versionRef({ ...item, sha: item?.sha || c?.sha }),
    c?.headline,
    c?.authorName,
    c?.date ? when(c.date) : "",
  ].filter(Boolean);
}
export const STEP_LABEL = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
};
