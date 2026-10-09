import { TriangleAlert } from "lucide-react";
import { Button } from "../ui";
import { UI_STEPS } from "../../../../shared/deploy";
import { dateTime } from "../../lib/api";
import { errorText, sha7 } from "./format";
const stepLabel = (name) =>
  UI_STEPS.find((ui) => ui.steps.includes(name))?.label || name;
const NOUN = { deploy: "deploy", redeploy: "redeploy", rollback: "rollback" };
// What happened to the last job that did not succeed, in plain words.
export function DeployError({
  job,
  last,
  owner,
  busy,
  onDismiss,
  onRedeployPrevious,
}) {
  const noun = NOUN[job.kind] || "deploy",
    restored = last
      ? `${last.branch}@${sha7(last.sha)}`
      : "the previous version";
  const title =
    job.status === "rolled-back"
      ? `Health check failed — rolled back to ${restored}`
      : job.status === "unhealthy"
        ? "Health check failed — the site may be down"
        : job.status === "cancelled"
          ? `The ${noun} was cancelled`
          : job.status === "expired"
            ? `The ${noun} expired before it finished`
            : `The ${noun} failed`;
  const detail =
    job.status === "rolled-back"
      ? "The new version did not pass its health check, so the previous version was put back. Customers are not affected."
      : job.status === "unhealthy"
        ? "The new version failed its health check and the previous version could not be restored automatically. Check the site now."
        : job.status === "cancelled"
          ? "Nothing was changed on the live site."
          : job.status === "expired"
            ? "The worker never finished this job. Nothing was changed on the live site."
            : job.error
              ? errorText(job.error)
              : "No reason was recorded.";
  const loud = !["cancelled", "expired"].includes(job.status);
  return (
    <section
      className="panel deploy-error"
      aria-labelledby="deploy-error-title"
      role={loud ? "alert" : "status"}
      data-status={job.status}
    >
      <div className="deploy-error-body">
        <TriangleAlert size={20} aria-hidden="true" />
        <div>
          <h2 id="deploy-error-title">{title}</h2>
          <p>{detail}</p>
          <dl className="version-facts">
            <div>
              <dt>Branch</dt>
              <dd>
                <code>
                  {job.branch}@{sha7(job.sha)}
                </code>
              </dd>
            </div>
            {job.error?.step && (
              <div>
                <dt>Failed at</dt>
                <dd>{stepLabel(job.error.step)}</dd>
              </div>
            )}
            {job.error?.code && (
              <div>
                <dt>Code</dt>
                <dd>
                  <code>{job.error.code}</code>
                </dd>
              </div>
            )}
            {job.finishedAt && (
              <div>
                <dt>Ended</dt>
                <dd>{dateTime(job.finishedAt)}</dd>
              </div>
            )}
          </dl>
          <div className="account-actions">
            {job.runUrl && (
              <a
                className="button secondary"
                href={job.runUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open GitHub run ↗
              </a>
            )}
            {owner && job.kind === "rollback" && job.status === "failed" && (
              <Button variant="secondary" onClick={onRedeployPrevious}>
                Redeploy previous commit (cached)
              </Button>
            )}
            {owner ? (
              <Button variant="secondary" busy={busy} onClick={onDismiss}>
                Dismiss
              </Button>
            ) : (
              <span className="small subtle">
                An owner can dismiss this message.
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
