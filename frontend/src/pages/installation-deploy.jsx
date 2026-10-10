import { useEffect, useRef, useState } from "react";
import { Lock, LockOpen, Rocket } from "lucide-react";
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
import { api } from "../lib/api";
import { can } from "../../../shared/policy";
import {
  ACTIVE_STATES,
  ACTIVE_TASK_STATES,
  blockedFor,
} from "../../../shared/deploy";
import { ReadinessChecklist } from "../components/deploy/readiness-checklist";
import { BranchPicker } from "../components/deploy/branch-picker";
import {
  DeployActions,
  DeployModal,
  actionReasons,
} from "../components/deploy/deploy-actions";
import { DeployProgress } from "../components/deploy/deploy-progress";
import { DeployError } from "../components/deploy/deploy-error";
import { BackupPanel } from "../components/deploy/backup-panel";
import { StaleBanner } from "../components/deploy/stale-banner";
import { VersionCard } from "../components/deploy/version-card";
import { describeError, titlesOf } from "../components/deploy/format";
const VERIFY_LABEL = {
  vercel: "Vercel token",
  project: "Project settings",
  env: "Environment variables",
  mongo: "Database",
  cloudflare: "Cloudflare",
  health: "Health check",
};
const isActive = (data) =>
  Boolean(
    (data?.current && ACTIVE_STATES.includes(data.current.status)) ||
    (data?.task && ACTIVE_TASK_STATES.includes(data.task.status)),
  );
export function InstallationDeploy({ installation, user }) {
  const id = installation._id,
    base = `/installations/${id}/pos`,
    owner = can(user.role, "deploy"),
    pos = useResource(base),
    ready = Boolean(pos.data?.pos),
    poll = usePoll(ready ? `${base}/deploys` : null, { isActive }),
    data = poll.data,
    [selected, setSelected] = useState(""),
    branches = useResource(ready ? `/pos/branches?installation=${id}` : null),
    plan = useResource(
      selected
        ? `${base}/deploy-plan?branch=${encodeURIComponent(selected)}`
        : null,
    ),
    [modal, setModal] = useState(null),
    [notice, setNotice] = useState(""),
    [problem, setProblem] = useState(""),
    [busy, setBusy] = useState(""),
    [storage, setStorage] = useState(null);
  // A finished deploy changes what is live, so re-read the comparison.
  const liveRequest = data?.last?.requestId,
    seen = useRef(undefined);
  useEffect(() => {
    if (seen.current !== undefined && seen.current !== liveRequest) {
      plan.reload();
      branches.reload();
    }
    seen.current = liveRequest;
  }, [liveRequest]);
  if (pos.loading) return <Loading />;
  if (pos.error) return <ErrorBox retry={pos.reload}>{pos.error}</ErrorBox>;
  if (!pos.data.pos)
    return (
      <div className="panel">
        <Empty icon={Rocket} title="POS settings have not been created">
          Create this client’s POS settings first, then come back to deploy.
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
    current = data.current,
    shown = current && ACTIVE_STATES.includes(current.status),
    finished = current && !shown,
    blocked = {
      deploy: blockedFor(data.readiness, "deploy"),
      rollback: blockedFor(data.readiness, "rollback"),
      build: blockedFor(data.readiness, "build"),
      unlock: blockedFor(data.readiness, "unlock"),
      verify: blockedFor(data.readiness, "verify"),
    },
    active = Boolean(current?.blocking),
    reasons = actionReasons({
      owner,
      active,
      selected,
      plan,
      last: data.last,
      previous: data.previous,
      blocked,
      cacheOn: data.cache.configured,
    }),
    verifying =
      data.task?.kind === "verify" &&
      ACTIVE_TASK_STATES.includes(data.task.status);
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
          e.code === "not-cancellable"
            ? "This rollback has already started and cannot be cancelled."
            : e.items?.length
              ? `${e.message} Needs: ${titlesOf(e.items)}.`
              : e.message,
        );
      throw e;
    } finally {
      setBusy("");
    }
  }
  const quiet = (name, action, done) => run(name, action, done).catch(() => {});
  const post = (path, body = {}) =>
    api(`${base}/${path}`, { method: "POST", body });
  const target = (kind) =>
    kind === "deploy"
      ? {
          branch: selected,
          sha: plan.data?.head.sha,
          headline: plan.data?.head.headline,
        }
      : kind === "build"
        ? {
            branch: selected,
            sha: plan.data?.head.sha,
            headline: plan.data?.head.headline,
          }
        : kind === "redeploy"
          ? { ...data.last, headline: data.last?.commit?.headline }
          : { ...data.previous, headline: data.previous?.commit?.headline };
  // The commit is fixed when the dialog opens: a plan reload never changes it.
  function openAction(kind) {
    setModal({
      type: "action",
      kind,
      snap: { target: target(kind), plan: plan.data ?? null },
    });
  }
  const actions = {
    verified: !blocked.verify.length
      ? {
          label: "Verify now",
          busy: busy === "verify" || verifying,
          onClick: () => {
            setNotice("");
            quiet("verify", () => post("verify"));
          },
        }
      : { reason: "Needs the deploy worker." },
    unlocked: !owner
      ? { reason: "Only the owner can unlock." }
      : blocked.unlock.length
        ? { reason: `Before unlocking: ${titlesOf(blocked.unlock)}.` }
        : { label: "Unlock…", onClick: () => setModal({ type: "unlock" }) },
    "not-frozen": !owner
      ? { reason: "Only the owner can unfreeze." }
      : {
          label: "Unfreeze deploys…",
          onClick: () => setModal({ type: "unfreeze" }),
        },
  };
  const previousAction = {
    label: "Roll back to this",
    reason: reasons.rollback,
    onClick: () => openAction("rollback"),
  };
  return (
    <>
      <PageTitle
        eyebrow={installation.name}
        title="Deploy"
        description="Pick a branch, check that this client is ready, then deploy. Environment variables on Vercel are never changed from here."
        action={
          <Badge value={data.worker.online ? "done" : "disabled"}>
            {data.worker.online ? "Worker online" : "Worker offline"}
          </Badge>
        }
      />
      <div className="deploy-stack">
        {!owner && (
          <p className="small subtle deploy-readonly">
            You can see this client’s deploy status. Only the owner can deploy,
            roll back, unlock or prepare builds.
          </p>
        )}
        <StaleBanner poll={poll} />
        {data.freeze.on && (
          <div className="notice notice-warning" role="status">
            <span>
              Deploys are frozen for every client
              {data.freeze.reason ? `: ${data.freeze.reason}` : "."}
            </span>
          </div>
        )}
        {notice && <Notice>{notice}</Notice>}
        {problem && <ErrorBox>{problem}</ErrorBox>}
        {shown && (
          <DeployProgress
            job={current}
            owner={owner}
            workerOnline={data.worker.online}
            staleAt={poll.stale ? poll.updatedAt : 0}
            cancelling={busy === "cancel"}
            onCancel={() =>
              quiet("cancel", () =>
                post("deploys/cancel", { requestId: current.requestId }),
              )
            }
          />
        )}
        {finished && (
          <DeployError
            job={current}
            last={data.last}
            previous={data.previous}
            owner={owner}
            busy={busy === "dismiss"}
            onDismiss={() =>
              quiet("dismiss", () =>
                post("deploys/dismiss", { requestId: current.requestId }),
              )
            }
            onRedeployPrevious={() => openAction("redeploy-previous")}
          />
        )}
        <div className="version-grid">
          <VersionCard
            title="Live version"
            version={data.last}
            empty="Nothing has been deployed from admin yet."
          />
          <VersionCard
            title="Previous version"
            version={data.previous}
            empty="There is no previous version to roll back to."
            action={data.previous ? previousAction : null}
          />
        </div>
        <ReadinessChecklist
          readiness={data.readiness}
          verify={data.verify}
          actions={actions}
        />
        <section
          className="panel check-extra"
          aria-label="Verification details"
        >
          {verifying ? (
            <p role="status">Verifying this client’s credentials…</p>
          ) : data.task?.kind === "verify" && data.task.status === "failed" ? (
            <p role="status">
              The last verification could not finish
              {data.task.error
                ? `: ${describeError(data.task.error).title}. ${describeError(data.task.error).plainMessage} ${describeError(data.task.error).action}`
                : "."}
            </p>
          ) : null}
          {data.verify && (
            <ul className="verify-flags">
              {Object.entries(VERIFY_LABEL).map(([key, name]) =>
                data.verify[key] == null ? null : (
                  <li key={key}>
                    {name}:{" "}
                    <strong>
                      {data.verify[key] === "ok" ? "OK" : data.verify[key]}
                    </strong>
                  </li>
                ),
              )}
            </ul>
          )}
          {data.verify && data.verify.env && data.verify.env !== "ok" && (
            <p className="small subtle">
              Environment variables on Vercel differ from the stored settings.
              Use the local console’s “Update on Vercel” until admin can do
              this.
            </p>
          )}
          {owner && data.cache.configured && (
            <div className="account-actions">
              <Button
                variant="secondary"
                busy={busy === "storage"}
                onClick={() => {
                  setStorage(null);
                  quiet(
                    "storage",
                    () =>
                      api("/pos/build-cache/self-test", {
                        method: "POST",
                        body: {},
                      }),
                    setStorage,
                  );
                }}
              >
                Test build storage
              </Button>
              {storage && (
                <span role="status" className="small">
                  {storage.ok
                    ? "Build storage works: write, list, read and delete all passed."
                    : "Build storage has a problem. Check the S3 settings and permissions."}
                </span>
              )}
            </div>
          )}
        </section>
        <section className="panel" aria-labelledby="deploy-title">
          <div className="panel-title">
            <div>
              <h2 id="deploy-title">Deploy a branch</h2>
              <p>
                Production for <code>{settings.slug}</code>
                {settings.host ? ` (${settings.host})` : ""}
              </p>
            </div>
          </div>
          <div className="deploy-body">
            <BranchPicker
              branches={branches}
              selected={selected}
              onSelect={setSelected}
              plan={selected ? plan : null}
              live={data.last}
              cacheOn={data.cache.configured}
            />
            <DeployActions
              reasons={reasons}
              selected={selected}
              onAction={(kind) => {
                setNotice("");
                openAction(kind);
              }}
            />
          </div>
        </section>
        <BackupPanel
          installationId={id}
          customerId={installation.customerId}
          owner={owner}
        />
        <section className="panel deploy-freeze" aria-labelledby="freeze-title">
          <div className="panel-title">
            <div>
              <h2 id="freeze-title">Freeze all deploys</h2>
              <p>
                {data.freeze.on
                  ? "Frozen: no client can deploy, redeploy or build until the owner unfreezes."
                  : "An emergency stop for every client. Not frozen."}
              </p>
            </div>
            <Badge value={data.freeze.on ? "disabled" : "live"}>
              {data.freeze.on ? "Frozen" : "Not frozen"}
            </Badge>
          </div>
          <div className="panel-foot">
            {owner ? (
              <>
                <span>
                  {data.freeze.on
                    ? "Rollbacks, verifies and tasks still work while frozen."
                    : "Takes effect at once for every client."}
                </span>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setModal({ type: data.freeze.on ? "unfreeze" : "freeze" })
                  }
                >
                  {data.freeze.on ? "Unfreeze deploys…" : "Freeze deploys…"}
                </Button>
              </>
            ) : (
              <span>Only the owner can freeze or unfreeze deploys.</span>
            )}
          </div>
        </section>
        <section className="panel deploy-lock" aria-labelledby="lock-title">
          <div className="panel-title">
            <div>
              <h2 id="lock-title">Deploy lock</h2>
              <p>
                {data.locked
                  ? "Locked: admin cannot deploy this client. New POS settings always start locked."
                  : "Unlocked: admin may deploy this client. Keep the local client file locked so only one tool deploys."}
              </p>
            </div>
            <Badge value={data.locked ? "paused" : "live"}>
              {data.locked ? <Lock size={11} /> : <LockOpen size={11} />}
              {data.locked ? "Locked" : "Unlocked"}
            </Badge>
          </div>
          {owner ? (
            <div className="panel-foot">
              <span>
                {data.locked
                  ? "Unlocking needs a clean verify from the last 24 hours."
                  : "Lock again to stop all deploys for this client."}
              </span>
              {data.locked ? (
                blocked.unlock.length ? (
                  <span className="small subtle">
                    Before unlocking: {titlesOf(blocked.unlock)}.
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => setModal({ type: "unlock" })}
                  >
                    Unlock…
                  </Button>
                )
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => setModal({ type: "lock" })}
                >
                  Lock deploys
                </Button>
              )}
            </div>
          ) : (
            <div className="panel-foot">
              <span>Only the owner can lock or unlock deploys.</span>
            </div>
          )}
        </section>
      </div>
      {modal?.type === "action" && (
        <DeployModal
          kind={modal.kind}
          id={id}
          slug={settings.slug}
          projectName={settings.vercel?.projectName}
          host={settings.host}
          target={modal.snap.target}
          plan={modal.snap.plan}
          onChanged={() => {
            plan.reload();
            branches.reload();
          }}
          onClose={() => setModal(null)}
          onDone={(result) => {
            setModal(null);
            setNotice(
              modal.kind === "build"
                ? result.build?.state === "cached"
                  ? "That build is already ready (cached)."
                  : result.build?.existing
                    ? `A build for this commit already exists (${result.build.state}).`
                    : "Build queued. It shows as cached once it has finished."
                : modal.kind === "rollback"
                  ? "Rollback queued."
                  : "Deploy queued.",
            );
            poll.refresh();
            if (modal.kind === "build") branches.reload();
          }}
        />
      )}
      {modal?.type === "unlock" && (
        <UnlockModal
          base={base}
          slug={settings.slug}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            setNotice("Deploys are unlocked for this client.");
            poll.refresh();
          }}
        />
      )}
      {modal?.type === "lock" && (
        <ConfirmModal
          title="Lock deploys for this client?"
          action="Lock deploys"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await post("lock");
            setModal(null);
            setNotice("Deploys are locked for this client.");
            poll.refresh();
          }}
        >
          <p>No deploy can start until the owner unlocks it again.</p>
        </ConfirmModal>
      )}
      {modal?.type === "freeze" && (
        <FreezeModal
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            setNotice("Deploys are frozen for every client.");
            poll.refresh();
          }}
        />
      )}
      {modal?.type === "unfreeze" && (
        <ConfirmModal
          title="Unfreeze deploys for every client?"
          action="Unfreeze deploys"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            await withStepUp(() =>
              api("/pos/unfreeze", { method: "POST", body: {} }),
            );
            setModal(null);
            setNotice("Deploys are no longer frozen.");
            poll.refresh();
          }}
        >
          <p>Deploys and redeploys can start again for all clients.</p>
        </ConfirmModal>
      )}
    </>
  );
}
function FreezeModal({ onClose, onDone }) {
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await withStepUp(() =>
        api("/pos/freeze", { method: "POST", body: { reason } }),
      );
      onDone();
    } catch (e) {
      if (!e.cancelled) setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Freeze deploys for every client?" onClose={onClose}>
      <form onSubmit={submit} className="deploy-confirm">
        <p className="subtle">
          All deploys, redeploys and builds stop for every client until an owner
          unfreezes. Jobs already running finish; rollbacks, verifies and other
          tasks still work.
        </p>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Field label="Reason (optional)" hint="Shown to everyone while frozen.">
          <input
            maxLength={200}
            autoComplete="off"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <div className="confirm-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" busy={busy}>
            Freeze deploys
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function UnlockModal({ base, slug, onClose, onDone }) {
  const [typed, setTyped] = useState(""),
    [local, setLocal] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await withStepUp(() =>
        api(`${base}/unlock`, {
          method: "POST",
          body: { confirm: typed, ...(local ? { localLocked: true } : {}) },
        }),
      );
      onDone();
    } catch (e) {
      if (!e.cancelled) setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Unlock deploys for this client?" onClose={onClose}>
      <form onSubmit={submit} className="deploy-confirm">
        <p className="subtle">
          Unlocking lets admin deploy <code>{slug}</code>. Two tools deploying
          the same client can overwrite each other, so keep the local go-live
          client file locked.
        </p>
        {error && <ErrorBox>{error}</ErrorBox>}
        <label className="check-row">
          <input
            type="checkbox"
            checked={local}
            onChange={(event) => setLocal(event.target.checked)}
          />
          I set deployLock in the local client file
        </label>
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
            Unlock
          </Button>
        </div>
      </form>
    </Modal>
  );
}
