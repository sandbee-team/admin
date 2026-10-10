import { useState } from "react";
import { Button, ErrorBox, Notice } from "../ui";
import { ConfirmModal } from "../confirm";
import { withStepUp } from "../step-up";
import { Link } from "../../lib/router";
import { api, dateTime } from "../../lib/api";
import { usePoll } from "../../hooks/use-poll";
import { StaleBanner } from "./stale-banner";
import { describeError } from "./format";
const active = (data) => ["queued", "running"].includes(data?.task?.status);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
// Owner button: back up this client's own database into the customer's Files.
export function BackupPanel({ installationId, customerId, owner }) {
  const base = `/installations/${installationId}/pos/db-backup`,
    poll = usePoll(base, { isActive: active }),
    [open, setOpen] = useState(false),
    [problem, setProblem] = useState("");
  const data = poll.data,
    task = data?.task,
    running = active(data),
    off = data && !data.configured,
    reason = !owner
      ? "Only the owner can back up a client database."
      : off
        ? "File storage is not configured, so a backup cannot be kept."
        : running
          ? "A backup or other task is already running for this client."
          : "";
  const why =
    task?.status === "failed" && task.error ? describeError(task.error) : null;
  async function start() {
    setProblem("");
    try {
      await withStepUp(() => api(base, { method: "POST", body: {} }));
      setOpen(false);
      await poll.refresh();
    } catch (e) {
      if (e.cancelled) throw e;
      setOpen(false);
      setProblem(
        e.code === "not-configured"
          ? "File storage is not configured, so a backup cannot be kept."
          : e.message,
      );
      poll.refresh();
    }
  }
  return (
    <section
      className="panel backup-panel"
      aria-labelledby="backup-title"
      data-status={task?.status || "none"}
    >
      <div className="panel-title">
        <div>
          <h2 id="backup-title">Client database backup</h2>
          <p>
            An encrypted copy of this client’s own database, kept in the
            customer’s Files. Never automatic.
          </p>
        </div>
      </div>
      <div className="backup-body">
        <StaleBanner poll={poll} />
        {problem && <ErrorBox>{problem}</ErrorBox>}
        {poll.error && !data && (
          <ErrorBox retry={poll.refresh}>{poll.error}</ErrorBox>
        )}
        {running && (
          <p role="status" aria-live="polite" className="progress-status">
            {task.status === "queued"
              ? "Backup queued. Waiting for the worker."
              : `Backing up… ${task.progress ? `${task.progress.collections} collections, ${task.progress.documents} documents, ${mb(task.progress.bytes)} so far.` : ""}`}
          </p>
        )}
        {task?.status === "succeeded" && task.result && (
          <Notice>
            Backup finished {dateTime(task.finishedAt)}:{" "}
            {task.result.collections} collections, {task.result.documents}{" "}
            documents, {mb(task.result.bytes)}.{" "}
            <Link href={`/customers/${customerId}/files`} className="text-link">
              Open the file in Files (Database backup)
            </Link>
          </Notice>
        )}
        {why && (
          <div className="error-why" role="alert" data-code={task.error.code}>
            <p>
              <strong>Backup failed: {why.title}.</strong> {why.plainMessage}
            </p>
            <p className="small">What to do: {why.action}</p>
            {why.extra && (
              <p className="small subtle">Server message: {why.extra}</p>
            )}
          </div>
        )}
        {task?.status === "expired" && (
          <p role="status">The last backup was not picked up. Try again.</p>
        )}
        <div className="deploy-action">
          <Button
            variant="secondary"
            disabled={Boolean(reason)}
            aria-describedby="why-backup"
            onClick={() => {
              setProblem("");
              setOpen(true);
            }}
          >
            Back up database now
          </Button>
          <span id="why-backup" className="small subtle">
            {reason || "Takes about a minute. Limit 20 MB compressed."}
          </span>
        </div>
      </div>
      {open && (
        <ConfirmModal
          title="Back up this client’s database?"
          action="Back up now"
          onClose={() => setOpen(false)}
          onConfirm={start}
        >
          <p>
            The worker reads every collection of this client’s database and
            stores one encrypted file in this customer’s Files (category
            Database backup). It takes about a minute and is limited to 20 MB
            compressed; a larger database is refused and nothing is stored. It
            is not automatic and the live site is not changed.
          </p>
        </ConfirmModal>
      )}
    </section>
  );
}
