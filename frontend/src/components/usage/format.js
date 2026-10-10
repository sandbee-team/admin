// Text for usage check results (docs/PHASE2-PLAN.md §9). Numbers are always
// shown as text next to any colour, so a level never relies on colour alone.
import {
  ACTIVE_CHECK_STATES,
  MIB,
  credentialLevel,
  levelOf,
  pctText,
  utcDay,
} from "../../../../shared/usage";
import { describeUsageCode } from "../../../../shared/usage-codes";
import { dateTime } from "../../lib/api";
import { when } from "../deploy/format";
export { describeUsageCode, levelOf, pctText };

const DAY_MS = 86400000;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
// Western grouping (100,000), the same as the shared alert details and Hobby
// limits shown beside these numbers, so one screen never mixes 1,00,000 and
// 100,000.
const NUMBERS = "en-US";
export const count = (value) =>
  finite(value) ? Math.round(value).toLocaleString(NUMBERS) : "—";
// Whole megabytes; one decimal below 10 MB so a small database is not "0 MB".
export const mb = (bytes) => {
  if (!finite(bytes)) return "—";
  const value = bytes / MIB;
  return `${(value < 10 ? Math.round(value * 10) / 10 : Math.round(value)).toLocaleString(NUMBERS)} MB`;
};
export const pct = (fraction) => (finite(fraction) ? pctText(fraction) : "—");
export const ms = (value) => (finite(value) ? `${count(value)} ms` : "—");
export const LEVEL_WORD = {
  ok: "OK",
  warning: "Warning",
  critical: "Critical",
};
// The level word to add after a value: only when it needs attention.
export const levelSuffix = (level) =>
  level === "warning" || level === "critical" ? ` · ${LEVEL_WORD[level]}` : "";
export const LEVEL_BADGE = {
  ok: "live",
  warning: "attention",
  critical: "disabled",
};
export const SITE_BADGE = {
  up: ["live", "Up"],
  down: ["disabled", "Down"],
  paused: ["paused", "Paused"],
  unknown: ["planned", "Unknown"],
};
export const ROLE_TEXT = {
  core: "Core",
  ledger: "Ledger",
  standby: "Standby",
};
export const isChecking = (status) => ACTIVE_CHECK_STATES.includes(status);
// Whether checks have stalled comes from the server (`usageStalled` on GET
// /pos/fleet, `stalled` on the Usage GET), by the server clock: the worker is
// offline, or a check has been queued for over 10 minutes while none is
// running. A queued check never expires by age while the worker is online (a
// long batch runs one at a time); the worker expires it only when it starts
// again after its heartbeat was stale for 10 minutes. The panels then stop
// polling fast and say why.
export const WAITING_TEXT =
  "Waiting for the worker — checks are queued but not running.";
export const OFFLINE_TEXT =
  "The background worker is offline. No check can run until it is back online.";
// Today's Worker count only counts while it is still today (UTC).
export const isToday = (day, now = Date.now()) =>
  typeof day === "string" && day === utcDay(now);
export const NO_ACTION = "No action needed.";

/** One stored token result -> {text, detail, action, level}. */
export function tokenState(token, now = Date.now()) {
  if (token?.code === "ok") {
    if (!token.expiresAt)
      return { text: "No expiry", detail: "", action: "", level: null };
    const at = new Date(token.expiresAt).getTime();
    const days = Math.ceil((at - now) / DAY_MS);
    return {
      text:
        days <= 0
          ? "Expired"
          : `Expires in ${days} day${days === 1 ? "" : "s"}`,
      detail: dateTime(token.expiresAt),
      action:
        days <= 14 ? "Create a new token and replace it in POS setup." : "",
      level: credentialLevel({ code: "ok", expiresAt: at }, now),
    };
  }
  const entry = describeUsageCode(token?.code);
  return {
    text: entry.title,
    detail: entry.plainMessage,
    action: entry.action === NO_ACTION ? "" : entry.action,
    level: token?.code === "token-invalid" ? "critical" : null,
  };
}

/** The check slot as one line of text, or "" before any check. */
export function checkText(check, now = Date.now()) {
  if (!check) return "";
  if (check.status === "queued")
    return `Queued ${when(check.requestedAt, now)} — waiting for the worker.`;
  if (check.status === "running")
    return `Checking… started ${when(check.startedAt, now)}.`;
  if (check.status === "done")
    return `Finished ${when(check.finishedAt, now)}${check.by?.name ? ` · asked by ${check.by.name}` : ""}.`;
  const entry = describeUsageCode(check.error?.code);
  if (check.status === "expired")
    return `Expired — ${entry.title.toLowerCase()}. ${entry.plainMessage} ${entry.action}`;
  return `Failed: ${entry.title}. ${entry.plainMessage} ${entry.action}`;
}

/** What a refused check request means, in plain words. */
export function checkError(error, { batch = false } = {}) {
  if (error?.status === 503)
    return "The worker is offline, so no check was queued. Try again when it is back online.";
  if (error?.code === "busy")
    return batch
      ? "Every watched client already has a check queued or running."
      : "A check is already queued or running for this client.";
  if (error?.code === "no-watched")
    return "No clients are on the watch list. Tick Watch for the clients you want to check.";
  if (error?.status === 429)
    return "Too many checks were asked for in the last hour. Try again later.";
  return error?.message || "The check could not be queued.";
}
