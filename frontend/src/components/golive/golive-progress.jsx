import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "../ui";
import { dateTime } from "../../lib/api";
import { Link } from "../../lib/router";
import { describeCode } from "../../../../shared/deploy-errors";
import { STEP_LABEL, clock, describeError, sha7, when } from "../deploy/format";
// Markup and aria-live of deploy-progress.jsx; the steps are the go-live's own
// (shared/golive.js GOLIVE_STEPS), shown one by one.
export const GOLIVE_STEP_LABEL = {
  check: "Check inputs",
  project: "Vercel project",
  secrets: "Secrets",
  realtime: "Realtime Worker",
  domain: "Web address",
  env: "Environment variables",
  admin: "POS admin login",
  dns: "DNS",
  ready: "Ready check",
  deploy: "First deploy",
  finish: "Finish",
};
const ACTION_TITLE = {
  start: "Go-live",
  check: "DNS check",
  "sync-env": "Sync env",
  realtime: "Realtime Worker update",
};
function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
const time = (value) => (value ? new Date(value).getTime() : NaN);
const msOf = (step, now) => {
  const start = time(step.startedAt),
    end = step.state === "running" ? now : time(step.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
};
// The DNS waiting reasons the worker keeps in `warnings` (D55).
export const DNS_REASONS = [
  "dns-pending",
  "dns-wrong-target",
  "txt-pending",
  "dns-unreachable",
  "domain-unverified",
];
// One sentence for where the go-live stands. `workerOnline`: a stalled run
// resumes when the worker is back.
export function statusText(g, workerOnline) {
  if (g.status === "queued")
    return workerOnline
      ? "Waiting for the worker to pick this up."
      : "The deploy worker is offline — the run starts when it is back.";
  if (g.status === "running") {
    if (g.cancelRequested) return "Cancelling after the current step.";
    if (g.stalled)
      return workerOnline
        ? "Worker restarted — resuming."
        : "The deploy worker is offline — the run resumes when it is back.";
    const step = g.steps.find((s) => s.state === "running");
    return step
      ? `Now: ${GOLIVE_STEP_LABEL[step.name] || step.name}.`
      : "Working.";
  }
  if (g.status === "waiting")
    return g.waitingFor === "dns"
      ? "Waiting for DNS: enter the records below at GoDaddy, then press Check DNS."
      : "Ready for the first deploy: press Unlock and deploy.";
  if (g.status === "deploying")
    return "The first deploy is running. Follow it on the Deploy tab; this page finishes the go-live when it is healthy.";
  if (g.status === "live")
    return g.liveAt ? `Live since ${dateTime(g.liveAt)}.` : "Finished.";
  if (g.status === "cancelled")
    return "Cancelled. What it already created stays as it is.";
  return "Stopped.";
}
export function GoliveProgress({
  golive: g,
  installationId,
  workerOnline = true,
  staleAt = 0,
  cancel,
}) {
  // While the panel cannot reach the server, timers stop instead of implying
  // progress we cannot see.
  const live = useNow(g.status === "running" && !staleAt),
    at = staleAt || live,
    failed = g.status === "failed" && g.error,
    why = failed ? describeError(g.error) : null,
    // A Check DNS run carries the go-live on (waiting, deploying, live): it
    // is named after the go-live, not the check, from then on.
    flow = ["start", "check"].includes(g.action),
    // A check run is "DNS check" only while it is on its own steps.
    checking =
      g.action === "check" &&
      ["queued", "dns", "ready"].includes(g.error?.step || g.step),
    title =
      flow && g.status === "live"
        ? "This client is live"
        : flow && ["waiting", "deploying"].includes(g.status)
          ? "Go-live"
          : `${flow && !checking ? "Go-live" : ACTION_TITLE[g.action] || "Go-live"}${
              g.status === "failed"
                ? " failed"
                : g.status === "cancelled"
                  ? " cancelled"
                  : g.status === "live"
                    ? " done"
                    : ""
            }`,
    // Warnings that are not the DNS waiting reasons (those sit with the
    // records): e.g. admin-exists, redirect-failed.
    notes = g.warnings.filter((code) => !DNS_REASONS.includes(code));
  return (
    <section
      className={`panel deploy-progress golive-progress${failed ? " golive-failed" : ""}`}
      aria-labelledby="golive-progress-title"
      data-status={g.status}
    >
      <div className="panel-title">
        <div>
          <h2 id="golive-progress-title">
            {title}
            {g.sha && (
              <>
                {" "}
                <code>
                  {g.branch}@{sha7(g.sha)}
                </code>
              </>
            )}
          </h2>
          <p>
            Started by {g.by?.name || "someone"}
            {g.requestedAt ? ` ${when(g.requestedAt)}` : ""}. You can leave this
            page; the go-live keeps its place.
          </p>
        </div>
      </div>
      <p className="progress-status" role="status" aria-live="polite">
        {statusText(g, workerOnline)}
        {g.status === "deploying" && (
          <>
            {" "}
            <Link
              className="text-link"
              href={`/installations/${installationId}/deploy`}
            >
              Open the Deploy tab
            </Link>
          </>
        )}
      </p>
      {failed && (
        <div className="golive-error" role="alert">
          <TriangleAlert size={18} aria-hidden="true" />
          <div>
            <strong>
              {GOLIVE_STEP_LABEL[g.error.step]
                ? `${GOLIVE_STEP_LABEL[g.error.step]}: `
                : ""}
              {why.title}
            </strong>
            <span>{why.plainMessage}</span>
            {why.extra && <span className="subtle">{why.extra}</span>}
            <span className="subtle">{why.action}</span>
          </div>
        </div>
      )}
      {notes.length > 0 && (
        <ul className="golive-notes small">
          {notes.map((code) => (
            <li key={code}>
              <strong>{describeCode(code).title}:</strong>{" "}
              {describeCode(code).plainMessage}
            </li>
          ))}
        </ul>
      )}
      <ol className="step-track" aria-label="Go-live steps">
        {g.steps.map((step) => {
          const ms = msOf(step, at);
          return (
            <li
              key={step.name}
              className="step-item"
              data-step={step.name}
              data-state={step.state}
              aria-current={step.state === "running" ? "step" : undefined}
            >
              <span className="step-dot" aria-hidden="true" />
              <div>
                <strong>{GOLIVE_STEP_LABEL[step.name] || step.name}</strong>
                <span className="step-state">{STEP_LABEL[step.state]}</span>
                {ms != null && step.state !== "pending" && (
                  <span className="step-time">{clock(ms)}</span>
                )}
                {step.note && (
                  <span className="small subtle step-note">{step.note}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {cancel && (
        <div className="panel-foot">
          <span>{cancel.text}</span>
          <Button
            variant="secondary"
            busy={cancel.busy}
            disabled={cancel.disabled}
            onClick={cancel.onClick}
          >
            {cancel.label}
          </Button>
        </div>
      )}
    </section>
  );
}
