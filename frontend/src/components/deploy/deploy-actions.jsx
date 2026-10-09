import { useState } from "react";
import { Button, ErrorBox, Field, Modal } from "../ui";
import { withStepUp } from "../step-up";
import { api } from "../../lib/api";
import { minutes, sha7, titlesOf } from "./format";
const MODAL = {
  deploy: {
    title: "Deploy this branch?",
    action: "Deploy",
    path: "deploys",
    typed: true,
    stepUp: true,
  },
  redeploy: {
    title: "Redeploy the live commit?",
    action: "Redeploy",
    path: "deploys",
    stepUp: true,
  },
  "redeploy-previous": {
    title: "Redeploy the previous commit?",
    action: "Redeploy previous",
    path: "deploys",
    stepUp: true,
  },
  rollback: {
    title: "Roll back to the previous version?",
    action: "Roll back",
    path: "rollback",
    typed: true,
    stepUp: true,
  },
  build: {
    title: "Prepare a build?",
    action: "Prepare build",
    path: "builds",
  },
};
function buildLine(kind, plan) {
  if (kind === "rollback")
    return "No rebuild. Vercel switches production back to this version. If Vercel refuses, the previous commit is redeployed from the stored build.";
  if (kind === "redeploy" || kind === "redeploy-previous")
    return "Same commit with this client’s current settings. A stored build is reused if it is still available; otherwise it builds first.";
  const cache = plan?.cache;
  if (cache?.state === "cached")
    return "Build ready (cached): no new build is needed.";
  if (cache?.state === "will-build")
    return `Will build first (~${plan.estimateMs ? minutes(plan.estimateMs) : "a few"} min).`;
  return "Builds first (the build cache is not available).";
}
export function DeployModal({
  kind,
  id,
  slug,
  projectName,
  host,
  target,
  plan,
  onClose,
  onDone,
}) {
  const spec = MODAL[kind],
    [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const base = `/installations/${id}/pos`;
  const body =
    kind === "deploy"
      ? {
          kind: "deploy",
          branch: target.branch,
          sha: target.sha,
          confirm: typed,
        }
      : kind === "redeploy"
        ? { kind: "redeploy", of: "last", confirm: true }
        : kind === "redeploy-previous"
          ? { kind: "redeploy", of: "previous", confirm: true }
          : kind === "rollback"
            ? { confirm: typed }
            : { branch: target.branch, sha: target.sha };
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const send = () => api(`${base}/${spec.path}`, { method: "POST", body });
    try {
      const result = await (spec.stepUp ? withStepUp(send) : send());
      onDone(result);
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
    <Modal title={spec.title} onClose={onClose}>
      <form onSubmit={submit} className="deploy-confirm">
        <dl className="deploy-summary">
          <div>
            <dt>Client</dt>
            <dd>
              <code>{slug}</code>
              {host && <span className="subtle"> · {host}</span>}
            </dd>
          </div>
          <div>
            <dt>Vercel project</dt>
            <dd>{projectName || "Not named"}</dd>
          </div>
          <div>
            <dt>Commit</dt>
            <dd>
              <code>
                {target.branch}@{sha7(target.sha)}
              </code>
              {target.headline && <span> — {target.headline}</span>}
            </dd>
          </div>
          <div>
            <dt>Build</dt>
            <dd>{buildLine(kind, plan)}</dd>
          </div>
        </dl>
        <p className="small subtle">
          {kind === "build"
            ? "This only prepares a build for later. The live site is not changed."
            : "Environment variables on Vercel are not changed."}
        </p>
        {error && <ErrorBox>{error}</ErrorBox>}
        {spec.typed && (
          <Field label={`Type ${slug} to confirm`}>
            <input
              required
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
        )}
        <div className="confirm-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            busy={busy}
            disabled={spec.typed && typed !== slug}
          >
            {spec.action}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
// Why each action is unavailable right now ("" when it can be used).
export function actionReasons({
  owner,
  active,
  selected,
  plan,
  last,
  previous,
  blocked,
  cacheOn,
}) {
  const stop = (gate) =>
    !owner
      ? "Only the owner can do this."
      : active
        ? "A deploy is already running for this client."
        : blocked[gate].length
          ? `Not ready: ${titlesOf(blocked[gate])}.`
          : "";
  const branch = !selected
    ? "Pick a branch first."
    : plan?.loading
      ? "Checking the branch…"
      : plan?.error
        ? "The branch could not be checked."
        : "";
  return {
    deploy: stop("deploy") || branch,
    redeploy: stop("deploy") || (last ? "" : "Nothing is live from admin yet."),
    rollback:
      stop("rollback") ||
      (previous?.vercelDeploymentId ? "" : "There is no previous version."),
    build: !owner
      ? "Only the owner can do this."
      : blocked.build.length
        ? `Not ready: ${titlesOf(blocked.build)}.`
        : !cacheOn
          ? "Build storage is off, so a prepared build would not be kept."
          : branch ||
            (plan?.data?.cache.state === "cached"
              ? "That build is already ready."
              : ""),
  };
}
// The four buttons, each with the reason it is unavailable (never a dead end).
export function DeployActions({ reasons, selected, onAction }) {
  const items = [
    {
      kind: "deploy",
      label: selected ? `Deploy ${selected}` : "Deploy",
      text: "Ship the picked branch to this client.",
      variant: "primary",
    },
    {
      kind: "redeploy",
      label: "Redeploy",
      text: "Ship the live commit again with the current settings.",
      variant: "secondary",
    },
    {
      kind: "rollback",
      label: "Roll back",
      text: "Switch back to the previous version.",
      variant: "secondary",
    },
    {
      kind: "build",
      label: "Prepare build",
      text: "Build the picked branch now. The live site is not changed.",
      variant: "secondary",
    },
  ];
  return (
    <div className="deploy-actions">
      {items.map((item) => (
        <div key={item.kind} className="deploy-action">
          <Button
            variant={item.variant}
            disabled={Boolean(reasons[item.kind])}
            aria-describedby={`why-${item.kind}`}
            onClick={() => onAction(item.kind)}
          >
            {item.label}
          </Button>
          <span id={`why-${item.kind}`} className="small subtle">
            {reasons[item.kind] || item.text}
          </span>
        </div>
      ))}
    </div>
  );
}
