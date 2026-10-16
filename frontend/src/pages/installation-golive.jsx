import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  Notice,
  PageTitle,
} from "../components/ui";
import { ConfirmModal } from "../components/confirm";
import { withStepUp } from "../components/step-up";
import { Link } from "../lib/router";
import { useResource } from "../hooks/use-resource";
import { usePoll } from "../hooks/use-poll";
import { api, dateTime } from "../lib/api";
import { can } from "../../../shared/policy";
import { DRIFT_MESSAGES, goliveBlockedFor } from "../../../shared/golive";
import { ReadinessChecklist } from "../components/deploy/readiness-checklist";
import { BranchPicker } from "../components/deploy/branch-picker";
import { StaleBanner } from "../components/deploy/stale-banner";
import { sha7, titlesOf, when } from "../components/deploy/format";
import { GoliveProgress } from "../components/golive/golive-progress";
import { AddressRecords } from "../components/golive/address-records";
// Go live tab of a NEW client (P5 Stage 3, D41-D47). The worker does the
// steps; this page starts, checks, unlocks-and-deploys and cancels, and reads
// GET .../pos/golive (goliveView: no lease, secrets or provider text).
const FAST = ["queued", "running", "deploying"];
const isActive = (data) => FAST.includes(data?.golive?.status);
const WORDS = {
  title: "Is this client ready to go live?",
  verb: "starting",
  ready: "Ready to start",
};
const STATE_TEXT = {
  start: "A go-live cannot start now: it is deploying or already live.",
  check:
    "Check DNS is possible while the go-live waits for DNS or for its first deploy.",
  "sync-env": "Sync env is possible once the client is live.",
  realtime: "The realtime Worker can be updated once the client is live.",
  deploy: "Unlock and deploy is possible once DNS is ready.",
};
const RUNS = {
  start: {
    title: "Start the go-live?",
    button: "Start go-live",
    done: "Go-live queued. The worker runs the steps and stops when you need to act.",
  },
  "sync-env": {
    title: "Sync the environment variables?",
    button: "Sync env",
    done: "Sync env queued. Redeploy on the Deploy tab afterwards to make it effective.",
  },
  realtime: {
    title: "Update the realtime Worker?",
    button: "Update realtime Worker",
    done: "Worker update queued.",
  },
};
export function InstallationGolive({ installation, user }) {
  const id = installation._id,
    base = `/installations/${id}/pos`,
    owner = can(user.role, "deploy"),
    pos = useResource(base),
    ready = Boolean(pos.data?.pos),
    poll = usePoll(ready ? `${base}/golive` : null, { isActive }),
    data = poll.data,
    g = data?.golive ?? null,
    live = Boolean(g?.liveAt),
    // A branch is needed for Start and for a Worker update only.
    wantsBranch =
      owner &&
      Boolean(data) &&
      (live || !g || ["failed", "cancelled", "waiting"].includes(g.status)),
    branches = useResource(
      ready && wantsBranch ? `/pos/branches?installation=${id}` : null,
    ),
    [selected, setSelected] = useState(""),
    [modal, setModal] = useState(null),
    [notice, setNotice] = useState(""),
    [problem, setProblem] = useState(""),
    [busy, setBusy] = useState("");
  // Default branch: main.
  const names = branches.data?.branches?.map((b) => b.name) ?? [];
  useEffect(() => {
    if (!selected && names.includes("main")) setSelected("main");
  }, [names.join("\n")]);
  // What the worker learned (project name, Worker) lives in the POS block.
  const phase = g ? `${g.requestId}:${g.status}:${g.step}` : "";
  useEffect(() => {
    if (phase) pos.refresh().catch(() => {});
  }, [phase]);
  if (pos.loading) return <Loading />;
  if (pos.error) return <ErrorBox retry={pos.reload}>{pos.error}</ErrorBox>;
  if (!pos.data.pos)
    return (
      <div className="panel">
        <Empty icon={Globe} title="POS settings have not been created">
          Enter this client’s POS setup and secrets first (slug, web address
          label, Vercel token, database URI, image store, POS admin username),
          then come back to go live.
          <br />
          <Link href={`/installations/${id}/pos`} className="text-link">
            Open POS setup
          </Link>
        </Empty>
      </div>
    );
  if (!data)
    return poll.error ? (
      <ErrorBox retry={poll.refresh}>{poll.error}</ErrorBox>
    ) : (
      <Loading />
    );
  const settings = pos.data.pos,
    slug = data.slug,
    allowed = data.allowed,
    readiness = data.readiness,
    branch = branches.data?.branches?.find((b) => b.name === selected) ?? null;
  async function run(name, action, done) {
    setBusy(name);
    setProblem("");
    try {
      const result = await action();
      if (done) done(result);
      await poll.refresh();
    } catch (e) {
      if (!e.cancelled)
        setProblem(
          e.items?.length
            ? `${e.message} Needs: ${titlesOf(e.items)}.`
            : e.message,
        );
    } finally {
      setBusy("");
    }
  }
  // Why an action cannot run now, in the order the server checks it.
  // The role comes first: `allowed` says what the server would accept from
  // the owner (an admin's POST would get 403).
  function reasonFor(action) {
    if (action !== "check" && !owner) return "Only the owner can do this.";
    if (allowed[action]) return "";
    if (g?.blocking) return "A go-live run is active. Wait for it to finish.";
    if (data.busy)
      return "A deploy or task is running for this client. Wait for it to finish.";
    const drift = data.drift?.[action];
    if (drift) return DRIFT_MESSAGES[drift] ?? "POS setup changed.";
    if (action === "deploy") {
      if (data.deployBlocked.length)
        return `Before deploying: ${titlesOf(data.deployBlocked)}.${
          data.deployBlocked.includes("verified")
            ? " Press Check DNS to run the checks again."
            : ""
        }`;
      return STATE_TEXT.deploy;
    }
    const ids = goliveBlockedFor(readiness, action);
    if (ids.length) return `Needs: ${titlesOf(ids)}.`;
    return STATE_TEXT[action];
  }
  const branchReason = (action) =>
    reasonFor(action) || (!branch ? "Pick a branch first." : "");
  const openRun = (action) =>
    setModal({
      type: "run",
      action,
      rev: data.rev,
      branch: action === "sync-env" ? null : branch,
    });
  const waitingDns = g?.status === "waiting" && g.waitingFor === "dns",
    waitingDeploy = g?.status === "waiting" && g.waitingFor === "deploy",
    // Check DNS re-runs dns + ready (also refreshes a verify older than 24 h).
    waiting = waitingDns || waitingDeploy,
    showStart =
      !live && (!g || ["failed", "cancelled", "waiting"].includes(g.status)),
    cancelable = owner && allowed.cancel;
  const startLabel = !g
    ? "Start go-live…"
    : g.status === "waiting"
      ? "Run all steps again…"
      : "Start again…";
  const checkReason = reasonFor("check");
  return (
    <>
      <PageTitle
        eyebrow={installation.name}
        title="Go live"
        description="Bring a new client online: Vercel project, environment variables, web address, POS admin login, realtime Worker and the first deploy."
        action={
          <Badge value={data.worker.online ? "done" : "disabled"}>
            {data.worker.online ? "Worker online" : "Worker offline"}
          </Badge>
        }
      />
      <div className="deploy-stack">
        {!owner && (
          <p className="small subtle deploy-readonly">
            You can follow this go-live and press Check DNS. Only the owner can
            start, deploy, sync or cancel it.
          </p>
        )}
        <StaleBanner poll={poll} />
        {data.freeze.on && (
          <div className="notice notice-warning" role="status">
            <span>
              Deploys are frozen for every client
              {data.freeze.reason ? `: ${data.freeze.reason}` : "."} Unlock and
              deploy waits until an owner unfreezes.
            </span>
          </div>
        )}
        {notice && <Notice>{notice}</Notice>}
        {problem && <ErrorBox>{problem}</ErrorBox>}
        {g && (
          <GoliveProgress
            golive={g}
            installationId={id}
            workerOnline={data.worker.online}
            staleAt={poll.stale ? poll.updatedAt : 0}
            cancel={
              cancelable
                ? {
                    label: "Cancel go-live…",
                    text:
                      g.status === "running"
                        ? "Stops after the current step. What it created stays."
                        : "Ends this run. What it created stays; Start again continues.",
                    busy: busy === "cancel",
                    // Only a running run waits for its current step.
                    disabled: g.status === "running" && g.cancelRequested,
                    onClick: () => setModal({ type: "cancel" }),
                  }
                : null
            }
          />
        )}
        {g?.address && (
          <AddressRecords
            address={g.address}
            warnings={g.warnings}
            check={
              waiting
                ? {
                    reason: checkReason,
                    busy: busy === "check",
                    onClick: () => {
                      setNotice("");
                      run(
                        "check",
                        () =>
                          api(`${base}/golive/check`, {
                            method: "POST",
                            body: { rev: data.rev },
                          }),
                        () => setNotice("DNS check queued."),
                      );
                    },
                  }
                : null
            }
          />
        )}
        {waitingDeploy && (
          <section
            className="panel golive-deploy"
            aria-labelledby="golive-deploy-title"
          >
            <div className="panel-title">
              <div>
                <h2 id="golive-deploy-title">First deploy</h2>
                <p>
                  DNS is ready and the checks passed. Unlock and deploy turns
                  off the deploy lock and deploys{" "}
                  <code>
                    {g.branch}@{sha7(g.sha)}
                  </code>{" "}
                  to production in one step.
                </p>
              </div>
            </div>
            <div className="panel-foot">
              {reasonFor("deploy") ? (
                <span>{reasonFor("deploy")}</span>
              ) : (
                <>
                  <span>Needs your authenticator and the typed slug.</span>
                  <Button
                    onClick={() => setModal({ type: "deploy", rev: data.rev })}
                  >
                    Unlock and deploy…
                  </Button>
                </>
              )}
            </div>
          </section>
        )}
        {g && (waitingDeploy || g.status === "deploying" || live) && (
          <OwnerChecks golive={g} settings={settings} id={id} />
        )}
        <ReadinessChecklist readiness={readiness} words={WORDS} />
        {showStart && (
          <section className="panel" aria-labelledby="golive-start-title">
            <div className="panel-title">
              <div>
                <h2 id="golive-start-title">
                  {g ? "Run the go-live again" : "Start the go-live"}
                </h2>
                <p>
                  Web address <code>{data.address.host || "not set"}</code>
                  {data.address.problem && (
                    <span className="small subtle">
                      {" "}
                      (the label cannot be used: fix it in POS setup)
                    </span>
                  )}
                  . Every step checks before it creates, so running again
                  continues where it stopped.
                </p>
              </div>
            </div>
            {owner ? (
              <>
                <div className="deploy-body">
                  <BranchPicker
                    branches={branches}
                    selected={selected}
                    onSelect={setSelected}
                    plan={null}
                    live={null}
                    showCache={false}
                  />
                </div>
                <div className="panel-foot">
                  {branchReason("start") ? (
                    <span>{branchReason("start")}</span>
                  ) : (
                    <>
                      <span>
                        Commit{" "}
                        <code>
                          {branch.name}@{sha7(branch.sha)}
                        </code>{" "}
                        is used for the realtime Worker and the first deploy.
                      </span>
                      <Button onClick={() => openRun("start")}>
                        {startLabel}
                      </Button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="panel-foot">
                <span>Only the owner can start a go-live.</span>
              </div>
            )}
          </section>
        )}
        {live && (
          <section className="panel" aria-labelledby="golive-later-title">
            <div className="panel-title">
              <div>
                <h2 id="golive-later-title">After go-live</h2>
                <p>
                  Sync env writes the environment variables again (Redeploy
                  makes them effective). Update realtime Worker bundles the
                  Worker from a branch and writes its env.
                </p>
              </div>
            </div>
            {owner ? (
              <>
                <div className="deploy-body">
                  <BranchPicker
                    branches={branches}
                    selected={selected}
                    onSelect={setSelected}
                    plan={null}
                    live={null}
                    showCache={false}
                  />
                </div>
                <div className="golive-actions">
                  <div className="deploy-action">
                    <Button
                      variant="secondary"
                      disabled={Boolean(reasonFor("sync-env"))}
                      aria-describedby="why-sync-env"
                      onClick={() => openRun("sync-env")}
                    >
                      Sync env…
                    </Button>
                    <span id="why-sync-env" className="small subtle">
                      {reasonFor("sync-env") ||
                        "Writes the variables to Vercel (nothing is deleted)."}
                    </span>
                  </div>
                  <div className="deploy-action">
                    <Button
                      variant="secondary"
                      disabled={Boolean(branchReason("realtime"))}
                      aria-describedby="why-realtime"
                      onClick={() => openRun("realtime")}
                    >
                      Update realtime Worker…
                    </Button>
                    <span id="why-realtime" className="small subtle">
                      {branchReason("realtime") ||
                        `Bundles the Worker from ${branch.name}@${sha7(branch.sha)}.`}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div className="panel-foot">
                <span>Only the owner can sync env or update the Worker.</span>
              </div>
            )}
          </section>
        )}
        {g && <SetUpFacts golive={g} settings={settings} />}
      </div>
      {modal?.type === "run" && (
        <RunModal
          base={base}
          slug={slug}
          host={data.address.host}
          action={modal.action}
          rev={modal.rev}
          branch={modal.branch}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            setNotice(RUNS[modal.action].done);
            poll.refresh();
          }}
        />
      )}
      {modal?.type === "deploy" && (
        <UnlockDeployModal
          base={base}
          slug={slug}
          rev={modal.rev}
          golive={g}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            setNotice("Deploys are unlocked and the first deploy is queued.");
            poll.refresh();
          }}
        />
      )}
      {modal?.type === "cancel" && g && (
        <ConfirmModal
          title="Cancel this go-live run?"
          action="Cancel go-live"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await api(`${base}/golive/cancel`, {
              method: "POST",
              body: { requestId: g.requestId },
            });
            setModal(null);
            setNotice(
              g.status === "running"
                ? "The run stops after the current step."
                : "The go-live run was cancelled.",
            );
            poll.refresh();
          }}
        >
          <p>
            {g.status === "running"
              ? "The worker stops after the step it is on."
              : "The run ends now."}{" "}
            Nothing is deleted: the Vercel project, web address, Worker,
            environment variables and POS admin login stay as they are. Start
            again to continue later.
          </p>
        </ConfirmModal>
      )}
    </>
  );
}
// Ported from the local go-live summary (index.mjs printSummary): what is
// still manual after the first deploy.
function OwnerChecks({ golive: g, settings, id }) {
  const host = g.address?.host || settings.host,
    username = settings.posAdmin?.username;
  return (
    <section
      className="panel golive-checks"
      aria-labelledby="golive-checks-title"
    >
      <div className="panel-title">
        <div>
          <h2 id="golive-checks-title">Still manual (owner checks)</h2>
          <p>Admin does not do these for you.</p>
        </div>
      </div>
      <ol className="golive-check-list small">
        <li>
          Vercel → Project → Security → WAF: add the 3 rules for <code>/m</code>{" "}
          and <code>/api/public/*</code> (GO-LIVE-CHECKLIST §1).
        </li>
        {settings.image?.store === "r2" && (
          <li>
            R2 bucket CORS: allow PUT with <code>content-type</code> from{" "}
            <code>https://{host}</code>.
          </li>
        )}
        <li>
          {g.admin?.state === "exists" ? (
            "The client’s database already had a POS admin: admin did not create or change it, so the client keeps their own password."
          ) : (
            <>
              Sign in once at <code>https://{host}/login</code> with the POS
              admin login <code>{username || "(username not set)"}</code> to
              check it.
            </>
          )}
        </li>
        {g.admin?.changedInPos && (
          <li>
            The client changed the POS admin password in the POS: there is no
            password to hand over.
          </li>
        )}
        {g.admin?.state !== "exists" && !g.admin?.changedInPos && (
          <li>
            Reveal the POS admin password once and hand it to the client:{" "}
            <Link
              href={`/installations/${id}/pos#secrets`}
              className="text-link"
            >
              POS setup → Secrets
            </Link>
            .
          </li>
        )}
      </ol>
    </section>
  );
}
// What the go-live created or learned (stays when a run is cancelled).
function SetUpFacts({ golive: g, settings }) {
  const project = settings.vercel?.projectName,
    worker = settings.cloudflare?.workerName;
  const rows = [
    ["Vercel project", project ? project : "Not created yet"],
    ["Web address", g.address?.host || "Not added yet"],
    [
      "Realtime Worker",
      g.realtime?.deployedAt && worker
        ? `${worker} (uploaded ${when(g.realtime.deployedAt)})`
        : "Off or not uploaded yet",
    ],
    [
      "Environment variables",
      g.env?.at
        ? `${g.env.keys.length} written ${when(g.env.at)}`
        : "Not written yet",
    ],
    [
      "POS admin login",
      g.admin?.state === "seeded"
        ? `Created ${when(g.admin.at)}`
        : g.admin?.state === "exists"
          ? "Already existed (kept)"
          : "Not created yet",
    ],
  ];
  return (
    <section className="panel" aria-labelledby="golive-facts-title">
      <div className="panel-title">
        <div>
          <h2 id="golive-facts-title">What admin set up</h2>
          <p>
            Admin never deletes these; a cancelled run leaves them as they are.
            {g.liveAt ? ` Live since ${dateTime(g.liveAt)}.` : ""}
          </p>
        </div>
      </div>
      <dl className="golive-set-up">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
// Start / Sync env / Update realtime Worker: typed slug + step-up (D41).
function RunModal({ base, slug, host, action, rev, branch, onClose, onDone }) {
  const [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const words = RUNS[action];
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await withStepUp(() =>
        api(`${base}/golive`, {
          method: "POST",
          body: {
            action,
            rev,
            ...(branch ? { branch: branch.name, sha: branch.sha } : {}),
            confirm: typed,
          },
        }),
      );
      onDone();
    } catch (e) {
      if (!e.cancelled)
        setError(
          e.items?.length
            ? `${e.message} Needs: ${titlesOf(e.items)}.`
            : e.message,
        );
      setBusy(false);
    }
  }
  return (
    <Modal title={words.title} onClose={onClose}>
      <form onSubmit={submit} className="deploy-confirm">
        {action === "start" ? (
          <p className="subtle">
            Admin checks the inputs, creates or adopts the Vercel project{" "}
            <code>{slug}</code>, mints the missing secrets, sets up the realtime
            Worker (when a Cloudflare token is stored), adds <code>{host}</code>
            , writes the environment variables and creates the POS admin login.
            Nothing is deployed yet; it stops when you need to enter DNS records
            or deploy.
          </p>
        ) : action === "sync-env" ? (
          <p className="subtle">
            Writes the environment variables of <code>{slug}</code> to Vercel
            again (upsert only, nothing is deleted). Running sites keep their
            old values until the next deploy.
          </p>
        ) : (
          <p className="subtle">
            Bundles the realtime Worker of <code>{slug}</code>, uploads it to
            the client’s Cloudflare account when it changed, checks it and
            writes its environment variables.
          </p>
        )}
        {branch && (
          <p className="small">
            Commit:{" "}
            <code>
              {branch.name}@{sha7(branch.sha)}
            </code>{" "}
            {branch.headline}
          </p>
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
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
          <Button type="submit" busy={busy} disabled={typed !== slug}>
            {words.button}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
// UnlockModal of the Deploy tab without the local-lock box: a client gone
// live from admin has no local file (D47).
function UnlockDeployModal({ base, slug, rev, golive: g, onClose, onDone }) {
  const [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await withStepUp(() =>
        api(`${base}/golive/deploy`, {
          method: "POST",
          body: { rev, confirm: typed },
        }),
      );
      onDone();
    } catch (e) {
      if (!e.cancelled)
        setError(
          e.items?.length
            ? `${e.message} Needs: ${titlesOf(e.items)}.`
            : e.message,
        );
      setBusy(false);
    }
  }
  return (
    <Modal title="Unlock and deploy this client?" onClose={onClose}>
      <form onSubmit={submit} className="deploy-confirm">
        <p className="subtle">
          Turns off the deploy lock of <code>{slug}</code> and deploys{" "}
          <code>
            {g.branch}@{sha7(g.sha)}
          </code>{" "}
          to production. The go-live is live once the deploy is healthy, Verify
          is clean and the old <code>.vercel.app</code> names redirect to the
          web address.
        </p>
        {error && <ErrorBox>{error}</ErrorBox>}
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
          <Button type="submit" busy={busy} disabled={typed !== slug}>
            Unlock and deploy
          </Button>
        </div>
      </form>
    </Modal>
  );
}
