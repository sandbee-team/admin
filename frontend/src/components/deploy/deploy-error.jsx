import { TriangleAlert } from "lucide-react";
import { Button } from "../ui";
import { UI_STEPS } from "../../../../shared/deploy";
import { dateTime } from "../../lib/api";
import { commitLine, describeError, sha7, versionRef } from "./format";
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
  previous,
  onRedeployPrevious,
}) {
  const noun = NOUN[job.kind] || "deploy",
    restored = last?.sha ? versionRef(last) : "the previous version";
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
      ? `The new version failed its health check and was rolled back to ${restored}. It may have been live for up to about a minute.`
      : job.status === "unhealthy"
        ? "The new version failed its health check and the previous version could not be restored automatically. Check the site now."
        : job.status === "cancelled"
          ? "Nothing was changed on the live site."
          : job.status === "expired"
            ? "The worker never finished this job. Nothing was changed on the live site."
            : job.error
              ? ""
              : "No reason was recorded.";
  const why = job.error ? describeError(job.error) : null;
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
          {detail && <p>{detail}</p>}
          {why && (
            <div className="error-why" data-code={job.error.code}>
              <p>
                <strong>{why.title}.</strong> {why.plainMessage}
              </p>
              <p className="small">What to do: {why.action}</p>
              {why.extra && (
                <p className="small subtle">Server message: {why.extra}</p>
              )}
            </div>
          )}
          <p className="small subtle">{commitLine(job).join(" — ")}</p>
          <dl className="version-facts">
            <div>
              <dt>Branch</dt>
              <dd>
                {job.sha ? (
                  <code>
                    {job.branch}@{sha7(job.sha)}
                  </code>
                ) : (
                  <span>The version before admin took over</span>
                )}
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
            {owner &&
              job.kind === "rollback" &&
              job.status === "failed" &&
              previous?.sha && (
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
