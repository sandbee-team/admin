import { useEffect, useRef, useState } from "react";
import { Button, ErrorBox, Field, Modal } from "../ui";
import { withStepUp } from "../step-up";
import { api, dateTime } from "../../lib/api";
import { ACTIVE_TASK_STATES, PURGE_WINDOW_MS } from "../../../../shared/deploy";
import { describeError, titlesOf } from "./format";
const count = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
const shortId = (id = "") => (id.length > 12 ? `${id.slice(0, 12)}…` : id);
const word = (value) =>
  value ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : "—";
const problemOf = (e) =>
  e.items?.length ? `${e.message} Needs: ${titlesOf(e.items)}.` : e.message;
// What the worker never deletes (backend/worker/purge.js classify()).
function KeptNote({ cutoverAt }) {
  return (
    <div className="purge-kept small">
      <p>Always kept, never listed:</p>
      <ul>
        <li>the deployment that is live in production now;</li>
        <li>admin’s Live and Previous versions;</li>
        <li>every prebuilt deployment (everything admin uploaded);</li>
        <li>
          anything created since the first admin deploy ({dateTime(cutoverAt)}
          );
        </li>
        <li>any deployment without a creation date.</li>
      </ul>
    </div>
  );
}
// Old SOURCE deployments in the client's own Vercel account (made before admin
// took over): preview, then remove exactly what was previewed (owner only).
// The state comes from the Deploy tab's poll (`data.task`, `data.cutoverAt`).
export function PurgePanel({ base, data, owner, slug, blocked, onRefresh }) {
  const task = data.task,
    cutoverAt = data.cutoverAt,
    running = Boolean(task && ACTIVE_TASK_STATES.includes(task.status)),
    preview = task?.kind === "purge-preview" ? task : null,
    purge = task?.kind === "purge" ? task : null,
    ready = preview?.status === "succeeded" && preview.result ? preview : null,
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(""),
    [confirm, setConfirm] = useState(null),
    [refocus, setRefocus] = useState(false),
    [, setTick] = useState(0),
    title = useRef(null);
  // The server allows 30 minutes after the preview finished; re-render at
  // that moment so the Remove button goes away (the server stays the judge).
  const finished = ready ? new Date(ready.finishedAt).getTime() : NaN,
    expiresAt = Number.isFinite(finished) ? finished + PURGE_WINDOW_MS : 0;
  useEffect(() => {
    const left = expiresAt - Date.now();
    if (!expiresAt || left <= 0) return;
    const timer = setTimeout(() => {
      // Remove disappears now; keep focus in the panel.
      if (document.activeElement?.dataset?.purge === "remove") setRefocus(true);
      setTick((n) => n + 1);
    }, left + 50);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  // The dialog's opener (Remove) goes away once the removal is queued, so
  // focus moves to the panel heading after the dialog has closed.
  useEffect(() => {
    if (!refocus || confirm) return;
    title.current?.focus();
    setRefocus(false);
  }, [refocus, confirm]);
  const expired = Boolean(ready) && Date.now() >= expiresAt,
    candidates = ready?.result.candidates ?? [],
    reason = !owner
      ? "Only the owner can remove old deployments."
      : blocked.length
        ? `Not ready: ${titlesOf(blocked)}.`
        : running
          ? preview || purge
            ? "Wait for the current step to finish."
            : "Another task (verify or backup) is running for this client."
          : "";
  async function startPreview() {
    setBusy(true);
    setProblem("");
    try {
      await api(`${base}/purge/preview`, { method: "POST", body: {} });
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      // Busy until the new task is on screen: a second click would only be
      // refused as busy.
      await onRefresh();
      setBusy(false);
    }
  }
  if (!cutoverAt)
    return (
      <section className="panel purge-panel" aria-labelledby="purge-title">
        <PurgeTitle titleRef={title} />
        <div className="purge-body">
          <p>
            Available after the first verified admin deploy. Until then this
            client’s Vercel project is still deployed by the local console.
          </p>
        </div>
      </section>
    );
  const why =
    (preview || purge)?.status === "failed" && task.error
      ? describeError(task.error)
      : null;
  const status =
    preview?.status === "queued"
      ? "Preview queued. Waiting for the worker."
      : preview?.status === "running"
        ? "Listing this client’s Vercel deployments…"
        : purge?.status === "queued"
          ? "Removal queued. Waiting for the worker."
          : purge?.status === "running"
            ? `Removing old deployments…${purge.progress?.total ? ` ${purge.progress.done} of ${purge.progress.total} done.` : ""}`
            : purge?.status === "succeeded" && purge.result
              ? `Removed ${count(purge.result.deleted ?? 0, "old deployment")}.${purge.result.skipped ? ` ${purge.result.skipped} skipped (no longer on the list when the removal ran).` : ""} Preview again to check for more.`
              : ["expired", "cancelled"].includes((preview || purge)?.status)
                ? "The worker did not finish this step. Try again."
                : expired && candidates.length
                  ? "This preview is older than 30 minutes. Preview again before removing anything."
                  : "";
  return (
    <section
      className="panel purge-panel"
      aria-labelledby="purge-title"
      data-status={
        task && (preview || purge) ? `${task.kind}:${task.status}` : "none"
      }
    >
      <PurgeTitle titleRef={title} />
      <div className="purge-body">
        {problem && <ErrorBox>{problem}</ErrorBox>}
        {/* Always in the tree (hidden while empty) so the first message is announced. */}
        <p
          role="status"
          aria-live="polite"
          className={status ? "purge-status" : "purge-status sr-only"}
        >
          {status}
        </p>
        {why && (
          <div className="error-why" role="alert" data-code={task.error.code}>
            <p>
              <strong>{purge ? "Removal" : "Preview"} failed.</strong>{" "}
              {why.plainMessage}
            </p>
            {purge?.result && (
              <p className="small">
                {purge.result.deleted ?? 0} removed, {purge.result.skipped ?? 0}{" "}
                skipped, {purge.result.failed ?? 0} could not be removed.
              </p>
            )}
            <p className="small">What to do: {why.action}</p>
            {why.extra && (
              <p className="small subtle">Server message: {why.extra}</p>
            )}
          </div>
        )}
        {ready && (
          <div className="purge-result">
            <p>
              <strong>
                {ready.result.total
                  ? `${count(ready.result.total, "old source deployment")} found`
                  : "No old source deployments found"}
              </strong>
              , {ready.result.keep} kept. Previewed {dateTime(ready.finishedAt)}
              . Each preview checks the newest 500 deployments.
            </p>
            {ready.result.total > candidates.length && (
              <p className="small">
                Showing {candidates.length} of {ready.result.total}. This run
                removes these {candidates.length}; preview again afterwards for
                the rest.
              </p>
            )}
            {candidates.length > 0 && (
              <div
                className="table-wrap purge-list"
                role="region"
                aria-label="Old deployments to remove"
                tabIndex={0}
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Deployment</th>
                      <th scope="col">Created</th>
                      <th scope="col">State</th>
                      <th scope="col">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <code>{shortId(item.id)}</code>
                        </td>
                        <td>{dateTime(item.createdAt)}</td>
                        <td>{word(item.state)}</td>
                        <td>{item.target ? word(item.target) : "Preview"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {candidates.length > 0 && !expired && (
              <p className="small">
                Use this preview before {dateTime(expiresAt)} (30 minutes).
              </p>
            )}
          </div>
        )}
        <KeptNote cutoverAt={cutoverAt} />
        <div className="purge-actions">
          {ready && candidates.length > 0 && !expired && (
            <div className="deploy-action">
              <Button
                variant="danger"
                data-purge="remove"
                disabled={Boolean(reason)}
                aria-describedby="why-purge-remove"
                onClick={() => {
                  setProblem("");
                  setConfirm({
                    id: ready.id,
                    digest: ready.result.digest,
                    size: candidates.length,
                    total: ready.result.total,
                    expiresAt,
                  });
                }}
              >
                Remove {count(candidates.length, "old deployment")}…
              </Button>
              <span id="why-purge-remove" className="small subtle">
                {reason ||
                  "Deletes only deployments on the list above. Cannot be undone."}
              </span>
            </div>
          )}
          <div className="deploy-action">
            <Button
              variant="secondary"
              busy={busy}
              disabled={Boolean(reason)}
              aria-describedby="why-purge-preview"
              onClick={startPreview}
            >
              {preview || purge ? "Preview again" : "Preview old deployments"}
            </Button>
            <span id="why-purge-preview" className="small subtle">
              {reason || "Lists what would be removed. Nothing is deleted yet."}
            </span>
          </div>
        </div>
      </div>
      {confirm && (
        <PurgeModal
          base={base}
          slug={slug}
          snap={confirm}
          cutoverAt={cutoverAt}
          onClose={() => {
            // The preview may have expired meanwhile, removing the opener.
            if (Date.now() >= confirm.expiresAt) setRefocus(true);
            setConfirm(null);
          }}
          onDone={() => {
            setConfirm(null);
            setRefocus(true);
            onRefresh();
          }}
          onFail={(e) => {
            setConfirm(null);
            setRefocus(true);
            setProblem(problemOf(e));
            onRefresh();
          }}
        />
      )}
    </section>
  );
}
function PurgeTitle({ titleRef }) {
  return (
    <div className="panel-title">
      <div>
        <h2 id="purge-title" ref={titleRef} tabIndex={-1}>
          Old source deployments
        </h2>
        <p>
          Source uploads left in this client’s Vercel account from before admin
          took over. Admin deploys compiled output only.
        </p>
      </div>
    </div>
  );
}
// Sends exactly the preview that was on screen when the dialog opened.
function PurgeModal({ base, slug, snap, cutoverAt, onClose, onDone, onFail }) {
  const [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await withStepUp(() =>
        api(`${base}/purge`, {
          method: "POST",
          body: { previewTaskId: snap.id, digest: snap.digest, confirm: typed },
        }),
      );
      onDone();
    } catch (e) {
      if (e.cancelled) setBusy(false);
      else onFail(e);
    }
  }
  const what = count(snap.size, "old deployment"),
    // Re-rendered by the panel's expiry timer.
    late = Date.now() >= snap.expiresAt;
  return (
    <Modal title={`Remove ${what}?`} onClose={onClose}>
      <form onSubmit={submit} className="deploy-confirm">
        <p className="subtle">
          These {what} were uploaded to this client’s Vercel account before
          admin took over (before {dateTime(cutoverAt)}). They are deleted one
          at a time and cannot be restored. The live site is not changed.
        </p>
        {snap.total > snap.size && (
          <p className="small">
            {snap.total - snap.size} more stay for now; preview again after this
            run.
          </p>
        )}
        <p className="small subtle">
          The live deployment, admin’s Live and Previous versions, every
          prebuilt deployment and anything since the first admin deploy are
          always kept. The list is checked against Vercel again when the removal
          starts; anything that changed is skipped.
        </p>
        <p role="status" className={late ? "small" : "sr-only"}>
          {late
            ? "This preview is now older than 30 minutes. Close this and preview again."
            : ""}
        </p>
        <Field label={`Type ${slug} to confirm`}>
          <input
            required
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </Field>
        <div className="confirm-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            busy={busy}
            disabled={late || typed !== slug}
          >
            Remove {what}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
