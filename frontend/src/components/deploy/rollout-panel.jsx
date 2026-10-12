import { useEffect, useRef, useState } from "react";
import { Badge, Button, ErrorBox, Field, Modal } from "../ui";
import { withStepUp } from "../step-up";
import { Link } from "../../lib/router";
import { api, dateTime } from "../../lib/api";
import { usePoll } from "../../hooks/use-poll";
import { useResource } from "../../hooks/use-resource";
import { can } from "../../../../shared/policy";
import {
  CANARY_SLUG,
  ROLLOUT_ACTIVE,
  ROLLOUT_CONFIRM,
  rolloutCounts,
} from "../../../../shared/rollout";
import { NO_ACTION } from "../../../../shared/deploy-errors";
import { BranchPicker } from "./branch-picker";
import { StaleBanner } from "./stale-banner";
import { PRE_ADMIN, describeError, titlesOf, when } from "./format";
const count = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
const problemOf = (e) =>
  e.items?.length ? `${e.message} Needs: ${titlesOf(e.items)}.` : e.message;
const isActive = (data) => ROLLOUT_ACTIVE.includes(data?.rollout?.status);
// A start refused for one of these means the plan on screen is out of date.
const STALE_PLAN = [
  "targets-changed",
  "branch-moved",
  "no-targets",
  "sha-not-on-branch",
];
const LIMITED = "More than 100 POS clients: a rollout covers at most 100.";
const TARGET = {
  pending: ["planned", "Waiting"],
  building: ["in-progress", "Building"],
  deploying: ["in-progress", "Deploying"],
  succeeded: ["done", "Live"],
  failed: ["disabled", "Failed"],
  skipped: ["paused", "Skipped"],
};
// The pre-build of a client still waiting for its turn.
const BUILD = {
  building: "Building in background",
  ready: "Build ready",
  failed: "Build failed — retried at its turn",
};
// A code's title, plus the readiness items behind target-not-ready.
function reasonOf(error) {
  if (!error?.code) return "";
  const title = describeError(error).title;
  return error.code === "target-not-ready" && error.items?.length
    ? `${title}: ${titlesOf(error.items)}`
    : title;
}
// What a client runs now; an empty sha is the version from before admin.
const liveOf = (live) =>
  !live
    ? "Not deployed"
    : live.sha7
      ? `${live.branch || "unknown"}@${live.sha7}`
      : PRE_ADMIN;
// Clients this commit moves back (live is newer) or replaces (live commit not
// on this branch): said in the plan and again in the dialog.
function moveWarnings(older, diverged) {
  const out = [];
  if (older)
    out.push(
      `${count(older, "client")} ${older === 1 ? "runs" : "run"} a newer commit and will be moved back.`,
    );
  if (diverged)
    out.push(
      `${count(diverged, "client")} ${diverged === 1 ? "runs" : "run"} a commit that is not on this branch; it will be replaced.`,
    );
  return out;
}
function Warnings({ items }) {
  if (!items.length) return null;
  return (
    <ul className="plan-warnings" aria-label="Warnings">
      {items.map((text) => (
        <li key={text}>
          <strong>Warning:</strong> {text}
        </li>
      ))}
    </ul>
  );
}
function statusText(rollout) {
  if (!rollout) return "";
  const c = rollout.counts ?? rolloutCounts(rollout.targets),
    done = c.succeeded + c.failed + c.skipped;
  switch (rollout.status) {
    case "running":
      return `${done} of ${c.total} done.`;
    case "cancelling":
      return "Cancelling… the current client finishes if its upload already started.";
    case "stopped":
      return `Stopped: ${c.succeeded} updated, ${c.failed} failed, ${c.skipped} skipped.`;
    case "cancelled":
      return `Cancelled: ${c.succeeded} updated, ${c.failed ? `${c.failed} failed, ` : ""}${c.skipped} skipped.`;
    case "completed":
      return `Completed: ${c.succeeded} updated, ${c.failed} failed, ${c.skipped} skipped.`;
    default:
      return "";
  }
}
// Why "Deploy to N clients…" is unavailable right now ("" when it can be used).
function startReason({ owner, frozen, offline, selected, plan }) {
  const p = plan.data;
  if (!owner) return "Only the owner can start a rollout.";
  if (p?.active) return "A rollout is already running.";
  if (frozen) return "Deploys are frozen.";
  if (!selected) return "Pick a branch first.";
  if (plan.error) return "The branch could not be checked.";
  if (!p) return "Checking the branch…";
  if (p.limited) return LIMITED;
  if (p.blocked?.length) return `Not ready: ${titlesOf(p.blocked)}.`;
  if (p.busy?.length) return "Wait for running deploys to finish.";
  if (!p.targets?.length)
    return "Nothing to deploy: every client is excluded or already on this commit.";
  if (offline) return "The deploy worker is offline.";
  return "";
}
// "Deploy this commit to all clients" (P3, docs/P3-ROLLOUT.md §6): preview a
// branch, start (owner, typed phrase, step-up), then follow, cancel, resume or
// dismiss. The worker drives it; this panel only reads and asks.
export function RolloutPanel({ user, fleet, onFleetRefresh }) {
  const owner = can(user.role, "deploy"),
    poll = usePoll("/pos/rollout", {
      isActive,
      activeMs: 3000,
      idleMs: 30000,
    }),
    rollout = poll.data?.rollout ?? null,
    idle = Boolean(poll.data) && !rollout,
    // The picker opens on demand: /pos/branches and the plan are rate limited
    // per staff (shared with the Deploy tab) and this page is opened often.
    [choosing, setChoosing] = useState(false),
    [selected, setSelected] = useState(""),
    branches = useResource(idle && choosing ? "/pos/branches" : null),
    plan = useResource(
      idle && choosing && selected
        ? `/pos/rollout/plan?branch=${encodeURIComponent(selected)}`
        : null,
    ),
    [problem, setProblem] = useState(null),
    [confirm, setConfirm] = useState(null),
    [dismissing, setDismissing] = useState(false),
    [refocus, setRefocus] = useState(false),
    title = useRef(null),
    focused = useRef(null),
    refresh = poll.refresh,
    // The rollout read carries both (fresh every poll); the fleet's are older.
    frozen =
      typeof poll.data?.freeze?.on === "boolean"
        ? poll.data.freeze.on
        : fleet?.freeze?.on === true,
    offline =
      typeof poll.data?.workerOnline === "boolean"
        ? !poll.data.workerOnline
        : fleet?.workerOnline === false;
  // The plan saw a rollout this panel does not show yet: read it now.
  const planActive = plan.data?.active === true;
  useEffect(() => {
    if (planActive) refresh();
  }, [planActive, refresh]);
  // A rollout on screen (started here or elsewhere) closes the picker.
  const shown = Boolean(rollout);
  useEffect(() => {
    if (!shown) return;
    setChoosing(false);
    setSelected("");
  }, [shown]);
  // A refused action's message stays for the state the refresh after it
  // showed (its baseline) and goes on a later change of state. Until that
  // refresh has answered, the baseline is not known yet.
  const statusKey = poll.data ? (rollout?.status ?? "idle") : "",
    answeredAt = poll.updatedAt;
  useEffect(() => {
    setProblem((p) => {
      if (!p) return p;
      if (p.base === undefined)
        return answeredAt >= p.at ? { ...p, base: statusKey } : p;
      return p.base === statusKey ? p : null;
    });
  }, [statusKey, answeredAt]);
  const report = (e) => setProblem({ text: problemOf(e), at: Date.now() });
  // After an action the button pressed goes away (or may), so focus moves to
  // the panel heading once the dialog has closed.
  useEffect(() => {
    if (!refocus || confirm) return;
    title.current?.focus();
    setRefocus(false);
  }, [refocus, confirm]);
  // A poll can remove the focused control (Cancel once the rollout ends, the
  // opener of a dialog): keep focus in the panel instead of losing it.
  useEffect(() => {
    const last = focused.current;
    if (!last || last.isConnected) return;
    focused.current = null;
    if (!document.activeElement || document.activeElement === document.body)
      title.current?.focus();
  });
  const refreshAll = () => {
    onFleetRefresh?.();
    return refresh();
  };
  const done = () => {
    setConfirm(null);
    setRefocus(true);
    refreshAll();
  };
  const fail = (e) => {
    setConfirm(null);
    setRefocus(true);
    report(e);
    refreshAll();
  };
  const sendDismiss = (id) =>
    api("/pos/rollout/dismiss", { method: "POST", body: { id } });
  async function dismiss() {
    setDismissing(true);
    setProblem(null);
    try {
      await sendDismiss(rollout.id);
      setRefocus(true);
    } catch (e) {
      report(e);
    } finally {
      // Busy until the new state is on screen.
      await refreshAll();
      setDismissing(false);
    }
  }
  function openStart() {
    const p = plan.data;
    setProblem(null);
    setConfirm({
      kind: "start",
      branch: p.branch,
      sha: p.head.sha,
      sha7: p.head.sha7,
      digest: p.digest,
      count: p.targets.length,
      firstSlug: p.targets[0]?.slug ?? "",
      older: p.targets.filter((t) => t.older).length,
      diverged: p.targets.filter((t) => t.diverged).length,
    });
  }
  const status = statusText(rollout);
  return (
    <section
      className="panel rollout-panel"
      aria-labelledby="rollout-title"
      data-status={
        poll.data
          ? (rollout?.status ?? "idle")
          : poll.error
            ? "error"
            : "loading"
      }
      onFocus={(event) => {
        focused.current = event.target;
      }}
    >
      <div className="panel-title">
        <div>
          <h2 id="rollout-title" ref={title} tabIndex={-1}>
            Deploy a commit to all clients
          </h2>
          <p>
            Starts every client’s build at once, then deploys one client at a
            time — {CANARY_SLUG} first, then A–Z. Stops at the first failure.
          </p>
        </div>
      </div>
      <div className="rollout-body">
        <StaleBanner poll={poll} />
        {problem && <ErrorBox>{problem.text}</ErrorBox>}
        {rollout && <RolloutHead rollout={rollout} offline={offline} />}
        {/* Always in the tree (hidden while empty) so the first message is announced. */}
        <p
          role="status"
          aria-live="polite"
          className={status ? "rollout-status" : "rollout-status sr-only"}
        >
          {status}
        </p>
        {!poll.data ? (
          poll.error ? (
            <ErrorBox retry={refresh}>{poll.error}</ErrorBox>
          ) : (
            <p className="small subtle">Checking for a rollout…</p>
          )
        ) : rollout ? (
          <>
            {rollout.status === "stopped" && (
              <StopAlert rollout={rollout} owner={owner} />
            )}
            <TargetTable rollout={rollout} fleet={fleet} />
            <RolloutActions
              rollout={rollout}
              owner={owner}
              frozen={frozen}
              offline={offline}
              dismissing={dismissing}
              onCancel={() => {
                setProblem(null);
                setConfirm({ kind: "cancel", id: rollout.id });
              }}
              onResume={() => {
                setProblem(null);
                setConfirm({
                  kind: "resume",
                  id: rollout.id,
                  slug: rollout.stop?.slug ?? "",
                });
              }}
              onDismiss={() => {
                // A stopped rollout could still be resumed: ask first.
                if (rollout.status !== "stopped") return dismiss();
                setProblem(null);
                setConfirm({ kind: "dismiss", id: rollout.id });
              }}
            />
          </>
        ) : (
          <>
            {/* One toggle that stays in place, so focus never gets lost. */}
            <div className="rollout-choose-bar">
              <Button
                variant="secondary"
                data-rollout="choose"
                aria-expanded={choosing}
                aria-controls={choosing ? "rollout-choose" : undefined}
                aria-describedby="why-rollout-choose"
                onClick={() => {
                  setProblem(null);
                  setSelected("");
                  setChoosing(!choosing);
                }}
              >
                {choosing ? "Close" : "Choose a commit…"}
              </Button>
              <span id="why-rollout-choose" className="small subtle">
                {choosing
                  ? "Closes the branch list. Nothing is deployed."
                  : "Pick a branch and see what every client would get. Nothing is deployed yet."}
              </span>
            </div>
            {choosing && (
              <div id="rollout-choose" className="rollout-choose">
                <BranchPicker
                  branches={branches}
                  selected={selected}
                  onSelect={(name) => {
                    setProblem(null);
                    setSelected(name);
                  }}
                  showCache={false}
                />
                {selected &&
                  (plan.error ? (
                    <ErrorBox retry={plan.reload}>{plan.error}</ErrorBox>
                  ) : plan.data ? (
                    <PlanView plan={plan.data} />
                  ) : (
                    <p className="small" role="status">
                      Checking this branch…
                    </p>
                  ))}
                <StartActions
                  reason={startReason({
                    owner,
                    frozen,
                    offline,
                    selected,
                    plan,
                  })}
                  plan={plan}
                  selected={selected}
                  onStart={openStart}
                  onReload={() => {
                    setProblem(null);
                    plan.reload();
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>
      {confirm?.kind === "start" && (
        <RolloutModal
          snap={confirm}
          onClose={() => setConfirm(null)}
          onDone={done}
          onFail={(e) => {
            fail(e);
            // Keeps the message: this reload is the answer to it.
            if (STALE_PLAN.includes(e.code)) plan.reload();
          }}
        />
      )}
      {confirm?.kind === "cancel" && (
        <ActionModal
          title="Cancel the rollout?"
          confirmLabel="Cancel rollout"
          closeLabel="Keep running"
          variant="danger"
          send={() =>
            api("/pos/rollout/cancel", {
              method: "POST",
              body: { id: confirm.id },
            })
          }
          onClose={() => setConfirm(null)}
          onDone={done}
          onFail={fail}
        >
          <p className="subtle">
            Cancels the current client unless its upload already started; the
            rest are skipped.
          </p>
        </ActionModal>
      )}
      {confirm?.kind === "resume" && (
        <ActionModal
          title="Resume the rollout?"
          confirmLabel="Resume"
          closeLabel="Not now"
          variant="primary"
          send={() =>
            withStepUp(() =>
              api("/pos/rollout/resume", {
                method: "POST",
                body: { id: confirm.id },
              }),
            )
          }
          onClose={() => setConfirm(null)}
          onDone={done}
          onFail={fail}
        >
          <p className="subtle">
            It retries <code>{confirm.slug}</code> first, then continues with
            the clients not reached. A client that is locked when its turn comes
            is skipped.
          </p>
        </ActionModal>
      )}
      {confirm?.kind === "dismiss" && (
        <ActionModal
          title="Dismiss the stopped rollout?"
          confirmLabel="Dismiss"
          closeLabel="Keep it"
          variant="danger"
          send={() => sendDismiss(confirm.id)}
          onClose={() => setConfirm(null)}
          onDone={done}
          onFail={fail}
        >
          <p className="subtle">
            It can no longer be resumed; clients not reached keep their current
            version. Builds still waiting for it are stopped (Resume keeps
            them).
          </p>
        </ActionModal>
      )}
    </section>
  );
}
// What the picked branch would do: the commit, the ordered clients, and who
// is left out and why.
function PlanView({ plan: p }) {
  const targets = p.targets ?? [],
    excluded = p.excluded ?? [],
    meta = [p.head?.headline, p.head?.authorName, when(p.head?.date)].filter(
      Boolean,
    ),
    warnings = moveWarnings(
      targets.filter((t) => t.older).length,
      targets.filter((t) => t.diverged).length,
    );
  return (
    <div className="rollout-plan">
      <p className="rollout-commit">
        <code>
          {p.branch}@{p.head?.sha7}
        </code>
        {meta.map((part, index) => (
          <span key={index}> — {part}</span>
        ))}
      </p>
      <p>
        <strong>{count(targets.length, "client")} will get this commit.</strong>
      </p>
      <Warnings items={warnings} />
      {p.limited && <p className="rollout-warn rollout-limited">{LIMITED}</p>}
      {p.blocked?.length > 0 && (
        <p className="rollout-warn rollout-blocked">
          Not ready: {titlesOf(p.blocked)}.
        </p>
      )}
      {p.busy?.length > 0 && (
        <p className="rollout-warn rollout-busy">
          Wait for running deploys to finish: {p.busy.join(", ")}.
        </p>
      )}
      {targets.length > 0 && (
        <div
          className="table-wrap rollout-list"
          role="region"
          aria-label="Clients in rollout order"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Client</th>
                <th scope="col">Slug</th>
                <th scope="col">Live now</th>
                <th scope="col">Build</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t, index) => (
                <tr key={t.installationId} data-slug={t.slug}>
                  <td>{index + 1}</td>
                  <td className="rollout-wrap">{t.customerName || "—"}</td>
                  <td className="mono small rollout-wrap">{t.slug}</td>
                  <td className="rollout-wrap">{liveOf(t.live)}</td>
                  <td>
                    {t.cached === true
                      ? "Cached"
                      : t.cached === false
                        ? "Will build"
                        : "Unknown"}
                  </td>
                  <td>
                    {t.older ? (
                      <span className="rollout-older">
                        Newer commit live — this moves it back
                      </span>
                    ) : t.diverged ? (
                      <span className="rollout-older">
                        Live commit not on this branch — this replaces it
                      </span>
                    ) : t.unhealthy ? (
                      <span className="rollout-older">
                        Live but unhealthy — deploys it again
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {excluded.length > 0 && (
        <div className="rollout-excluded">
          <h3>Not included ({excluded.length})</h3>
          <ul>
            {excluded.map((x) => (
              <li key={x.installationId} data-slug={x.slug} data-code={x.code}>
                <strong>{x.customerName || "—"}</strong> <code>{x.slug}</code> —{" "}
                {reasonOf(x)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
function StartActions({ reason, plan, selected, onStart, onReload }) {
  const n = plan.data?.targets?.length;
  return (
    <div className="rollout-actions">
      <div className="deploy-action">
        <Button
          variant="danger"
          data-rollout="start"
          disabled={Boolean(reason)}
          aria-describedby="why-rollout-start"
          onClick={onStart}
        >
          {plan.data
            ? `Deploy to ${count(n, "client")}…`
            : "Deploy to all clients…"}
        </Button>
        <span id="why-rollout-start" className="small subtle">
          {reason || "Asks you to confirm first. Nothing is deployed yet."}
        </span>
      </div>
      {selected && (
        <div className="deploy-action">
          <Button
            variant="secondary"
            data-rollout="preview"
            busy={plan.loading}
            aria-describedby="why-rollout-preview"
            onClick={onReload}
          >
            Preview again
          </Button>
          <span id="why-rollout-preview" className="small subtle">
            Reads the branch and every client again.
          </span>
        </div>
      )}
    </div>
  );
}
function RolloutHead({ rollout: r, offline }) {
  const active = ROLLOUT_ACTIVE.includes(r.status),
    total = r.counts?.total ?? r.targets?.length ?? 0,
    ref = (
      <code>
        {r.branch}@{r.sha7}
      </code>
    ),
    commit = [r.commit?.headline, r.commit?.authorName]
      .filter(Boolean)
      .join(" — "),
    started = when(r.startedAt);
  return (
    <div className="rollout-head">
      <p>
        <strong>
          {r.status === "cancelling" ? (
            <>Cancelling the rollout of {ref}</>
          ) : (
            <>
              {active ? "Deploying" : "Rollout of"} {ref} to{" "}
              {count(total, "client")}
            </>
          )}
        </strong>
      </p>
      {commit && <p className="small">{commit}</p>}
      <p className="small subtle">
        Started by {r.by?.name || "Unknown"}
        {started ? `, ${started}` : ""}.
        {r.resumed &&
          ` Resumed by ${r.resumed.by?.name || "Unknown"}${r.resumed.at ? `, ${when(r.resumed.at)}` : ""}.`}
        {r.finishedAt && ` Finished ${dateTime(r.finishedAt)}.`}
      </p>
      {/* Always rendered, so the notice is announced when it appears. */}
      <div className="rollout-live" aria-live="polite">
        {active && offline && (
          <div className="notice notice-warning">
            <span>Waiting for the deploy worker (offline).</span>
          </div>
        )}
      </div>
    </div>
  );
}
function StopAlert({ rollout, owner }) {
  const stop = rollout.stop;
  if (!stop) return null;
  const why = describeError({ code: stop.code }),
    target = rollout.targets?.find((t) => t.slug === stop.slug),
    items =
      stop.code === "target-not-ready" ? (target?.error?.items ?? []) : [];
  // A rollout code's own step already says Resume; a job's step speaks of
  // deploying again, which here means Resume.
  const own = why.step === "rollout",
    action =
      why.action === NO_ACTION
        ? ""
        : own
          ? why.action
          : why.action.replace(/deploy again/i, "press Resume"),
    nextStep = !own && !/resume/i.test(action);
  return (
    <div className="error-why rollout-stop" role="alert" data-code={stop.code}>
      <p>
        <strong>
          Stopped at {stop.slug}: {why.title}.
        </strong>{" "}
        {why.plainMessage}
      </p>
      {items.length > 0 && <p className="small">Needs: {titlesOf(items)}.</p>}
      {action && <p className="small">What to do: {action}</p>}
      {nextStep && (
        <p className="small">
          {owner
            ? `Then press Resume to retry ${stop.slug} first, or Dismiss to end the rollout.`
            : "An owner can Resume or Dismiss."}
        </p>
      )}
    </div>
  );
}
function targetDetail(t) {
  if (t.status === "pending") return BUILD[t.build] ?? "";
  if (t.status === "failed" || t.status === "skipped") return reasonOf(t.error);
  if (t.status === "succeeded")
    return t.finishedAt ? `Live ${when(t.finishedAt)}` : "";
  return t.startedAt ? `Started ${when(t.startedAt)}` : "";
}
function TargetTable({ rollout, fleet }) {
  const names = new Map(
    (fleet?.rows ?? []).map((row) => [row.installationId, row.customerName]),
  );
  return (
    <div
      className="table-wrap rollout-list"
      role="region"
      aria-label="Clients in this rollout"
      tabIndex={0}
    >
      <table>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Client</th>
            <th scope="col">Slug</th>
            <th scope="col">Status</th>
            <th scope="col">Detail</th>
            <th scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(rollout.targets ?? []).map((t, index) => {
            const [value, text] = TARGET[t.status] ?? ["planned", t.status];
            return (
              <tr
                key={t.installationId}
                data-slug={t.slug}
                data-target-status={t.status}
              >
                <td>{index + 1}</td>
                <td className="rollout-wrap">
                  {names.get(t.installationId) || "—"}
                </td>
                <td className="mono small rollout-wrap">{t.slug}</td>
                <td>
                  <Badge value={value}>{text}</Badge>
                </td>
                <td className="small rollout-wrap">{targetDetail(t) || "—"}</td>
                <td>
                  <Link
                    className="text-link"
                    href={`/installations/${t.installationId}/deploy`}
                    aria-label={`Open ${t.slug}`}
                  >
                    Open →
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function RolloutActions({
  rollout,
  owner,
  frozen,
  offline,
  dismissing,
  onCancel,
  onResume,
  onDismiss,
}) {
  if (!owner)
    return (
      <p className="small subtle">
        Read-only: only the owner can start or change a rollout.
      </p>
    );
  const s = rollout.status;
  if (s === "running")
    return (
      <div className="rollout-actions">
        <div className="deploy-action">
          <Button
            variant="secondary"
            data-rollout="cancel"
            aria-describedby="why-rollout-cancel"
            onClick={onCancel}
          >
            Cancel rollout…
          </Button>
          <span id="why-rollout-cancel" className="small subtle">
            Cancels the current client unless its upload already started; the
            rest are skipped.
          </span>
        </div>
      </div>
    );
  const resumeReason = frozen
    ? "Deploys are frozen."
    : offline
      ? "The deploy worker is offline."
      : "";
  return (
    <div className="rollout-actions">
      {s === "stopped" && (
        <div className="deploy-action">
          <Button
            data-rollout="resume"
            disabled={Boolean(resumeReason)}
            aria-describedby="why-rollout-resume"
            onClick={onResume}
          >
            Resume…
          </Button>
          <span id="why-rollout-resume" className="small subtle">
            {resumeReason ||
              `Retries ${rollout.stop?.slug || "the client it stopped at"} first, then continues.`}
          </span>
        </div>
      )}
      <div className="deploy-action">
        <Button
          variant="secondary"
          data-rollout="dismiss"
          busy={dismissing}
          aria-describedby="why-rollout-dismiss"
          onClick={onDismiss}
        >
          {s === "stopped" ? "Dismiss…" : "Dismiss"}
        </Button>
        <span id="why-rollout-dismiss" className="small subtle">
          {s === "stopped"
            ? "Ends this rollout; it can no longer be resumed. The audit trail is kept."
            : s === "cancelling"
              ? "Possible once its current client’s deploy has ended; refused until then."
              : "Clears this rollout from the panel. The audit trail is kept."}
        </span>
      </div>
    </div>
  );
}
// Sends exactly the plan that was on screen when the dialog opened.
function RolloutModal({ snap, onClose, onDone, onFail }) {
  const [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await withStepUp(() =>
        api("/pos/rollout", {
          method: "POST",
          body: {
            branch: snap.branch,
            sha: snap.sha,
            digest: snap.digest,
            confirm: typed,
          },
        }),
      );
      onDone();
    } catch (e) {
      if (e.cancelled) setBusy(false);
      else onFail(e);
    }
  }
  const what = count(snap.count, "client");
  return (
    <Modal title={`Deploy to ${what}?`} onClose={onClose}>
      <form onSubmit={submit} className="deploy-confirm">
        <p>
          Deploys{" "}
          <code>
            {snap.branch}@{snap.sha7}
          </code>{" "}
          to {what}, one at a time, <code>{snap.firstSlug}</code> first.
        </p>
        <Warnings items={moveWarnings(snap.older, snap.diverged)} />
        <p className="small subtle">
          Each client: build (cached or new), upload compiled output, go live,
          health check (if it fails, admin rolls back to the previous version
          when that one was healthy).
        </p>
        <p className="small subtle">
          Stops at the first failure; the rest are skipped. Environment
          variables on Vercel are not changed.
        </p>
        <Field label={`Type ${ROLLOUT_CONFIRM} to confirm`}>
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
            disabled={typed !== ROLLOUT_CONFIRM}
          >
            Deploy to {what}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
// A yes/no dialog (Cancel, Resume, Dismiss); a cancelled step-up keeps it open.
function ActionModal({
  title,
  confirmLabel,
  closeLabel,
  variant,
  send,
  onClose,
  onDone,
  onFail,
  children,
}) {
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await send();
      onDone();
    } catch (e) {
      if (e.cancelled) setBusy(false);
      else onFail(e);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="deploy-confirm">
        {children}
        <div className="confirm-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            {closeLabel}
          </Button>
          <Button type="submit" variant={variant} busy={busy}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
