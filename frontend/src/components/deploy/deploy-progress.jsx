import { useEffect, useState } from "react";
import { Button } from "../ui";
import { CANCELLABLE_STEPS, UI_STEPS } from "../../../../shared/deploy";
import { STEP_LABEL, clock, sha7 } from "./format";
const VERB = {
  deploy: "Deploying",
  redeploy: "Redeploying",
  rollback: "Rolling back to",
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
// Folds the worker's internal steps into the five the panel shows.
export function groupSteps(steps, now) {
  return UI_STEPS.map((ui) => {
    const mine = steps.filter((step) => ui.steps.includes(step.name));
    if (!mine.length) return null;
    const states = mine.map((step) => step.state);
    const state = states.includes("failed")
      ? "failed"
      : states.includes("running")
        ? "running"
        : states.every((s) => s === "skipped")
          ? "skipped"
          : states.every((s) => s === "done" || s === "skipped")
            ? "done"
            : states.includes("done")
              ? "running"
              : "pending";
    const starts = mine.map((s) => time(s.startedAt)).filter(Number.isFinite),
      ends = mine.map((s) => time(s.endedAt)).filter(Number.isFinite);
    const start = starts.length ? Math.min(...starts) : NaN,
      end = state === "running" ? now : ends.length ? Math.max(...ends) : NaN;
    const notes = mine.filter((s) => s.note);
    const note = (
      mine.find((s) => s.state === "running" && s.note) ?? notes.at(-1)
    )?.note;
    return {
      ...ui,
      state,
      note: note || "",
      ms: Number.isFinite(start) && Number.isFinite(end) ? end - start : null,
    };
  }).filter(Boolean);
}
export function DeployProgress({ job, owner, onCancel, cancelling }) {
  const now = useNow(true),
    groups = groupSteps(job.steps, now),
    running = groups.find((g) => g.state === "running"),
    cancellable =
      job.status === "queued" ||
      (job.status === "running" && CANCELLABLE_STEPS.includes(job.step));
  const status = job.stalled
    ? "Worker restarted — resuming."
    : job.status === "queued"
      ? "Waiting for the worker to pick this up."
      : job.status === "cancelling"
        ? "Cancelling after the current step."
        : running
          ? `Now: ${running.label}.`
          : "Working.";
  return (
    <section
      className="panel deploy-progress"
      aria-labelledby="progress-title"
      data-status={job.status}
    >
      <div className="panel-title">
        <div>
          <h2 id="progress-title">
            {VERB[job.kind] || "Deploying"}{" "}
            <code>
              {job.branch}@{sha7(job.sha)}
            </code>
          </h2>
          <p>
            Started by {job.by?.name || "someone"}. You can leave this page; the
            deploy keeps going.
          </p>
        </div>
      </div>
      <p className="progress-status" role="status" aria-live="polite">
        {status}
      </p>
      <ol className="step-track" aria-label="Deploy steps">
        {groups.map((group) => (
          <li
            key={group.id}
            className="step-item"
            data-state={group.state}
            aria-current={group.state === "running" ? "step" : undefined}
          >
            <span className="step-dot" aria-hidden="true" />
            <div>
              <strong>
                {group.id === "build" && group.state === "skipped"
                  ? "Build: cached"
                  : group.label}
              </strong>
              <span className="step-state">{STEP_LABEL[group.state]}</span>
              {group.ms != null && group.state !== "pending" && (
                <span className="step-time">{clock(group.ms)}</span>
              )}
              <span className="small subtle step-note">
                {group.note ||
                  (group.id === "build" && group.state === "skipped"
                    ? "Using cached build"
                    : "")}
                {group.id === "build" &&
                  group.state === "running" &&
                  job.runUrl && (
                    <>
                      {" "}
                      <a
                        className="text-link"
                        href={job.runUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        GitHub run ↗
                      </a>
                    </>
                  )}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {owner && job.status !== "cancelling" && (
        <div className="panel-foot">
          {cancellable ? (
            <span>Stop this deploy before anything is uploaded.</span>
          ) : (
            <span>Too late to cancel: the upload has started.</span>
          )}
          <Button
            variant="secondary"
            disabled={!cancellable}
            busy={cancelling}
            onClick={onCancel}
          >
            Cancel deploy
          </Button>
        </div>
      )}
    </section>
  );
}
