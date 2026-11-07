import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ExternalLink,
  Globe,
  LayoutDashboard,
  Lock,
  LockOpen,
  Rocket,
  Server,
} from "lucide-react";
import { useResource } from "../hooks/use-resource";
import {
  Resource,
  Loading,
  PageTitle,
  Badge,
  Button,
  Empty,
  ErrorBox,
  Field,
  Modal,
  Notice,
  Select,
  SecretInput,
} from "../components/ui";
import { WorkspaceFrame } from "../components/workspace-frame";
import { ConfirmModal } from "../components/confirm";
import { RevealValue } from "../components/reveal";
import { withStepUp } from "../components/step-up";
import { api, dateTime } from "../lib/api";
import { can } from "../../../shared/policy";
import { checksFor } from "../../../shared/product-models";
import { ACTIVE_TASK_STATES } from "../../../shared/deploy";
import { describeCode } from "../../../shared/deploy-errors";
import { RecordEditor } from "./record-editor";
import { InstallationDeploy } from "./installation-deploy";
import { InstallationGolive } from "./installation-golive";
import { InstallationUsage } from "./installation-usage";
import { Link } from "../lib/router";
// Go live tab (P5 §8): a go-live exists, or a block admin neither imported
// nor deployed. A hand-entered live client sees it too: its readiness item
// `new-client` explains why Start is refused (D42).
const goliveTab = (pos) =>
  !pos || Boolean(pos.golive) || (!pos.importedAt && !pos.deploy?.last);
export function InstallationWorkspace({ id, section = "", user }) {
  const resource = useResource(`/installations/${id}`),
    productResource = useResource(
      resource.data ? `/products/${resource.data.productId}` : null,
    ),
    // The product decides the tabs, so wait for it before drawing the rail.
    waiting =
      Boolean(resource.data) && !productResource.data && !productResource.error,
    isPos = productResource.data?.slug === "pos",
    staff = isPos && can(user.role, "credentials"),
    block = useResource(staff ? `/installations/${id}/pos` : null),
    golive =
      staff &&
      (section === "golive" || (block.data && goliveTab(block.data.pos))),
    tabs = [
      ["", "Summary", LayoutDashboard],
      ...(staff
        ? [
            ["pos", "POS setup", Server],
            ...(golive ? [["golive", "Go live", Globe]] : []),
            ["deploy", "Deploy", Rocket],
            ["usage", "Usage", Activity],
          ]
        : []),
    ];
  return (
    <Resource resource={resource}>
      {(installation) =>
        waiting ? (
          <Loading />
        ) : productResource.error ? (
          <ErrorBox retry={productResource.reload}>
            {productResource.error}
          </ErrorBox>
        ) : (
          <WorkspaceFrame
            back="/installations"
            backLabel="All installations"
            icon={Rocket}
            title={installation.name}
            subtitle={productResource.data?.name || installation.environment}
            base={`/installations/${id}`}
            tabs={tabs}
            section={section}
            navLabel="Installation navigation"
          >
            {section === "" ? (
              <Summary
                id={id}
                user={user}
                product={productResource.data}
                onSaved={() => resource.refresh().catch(() => {})}
              />
            ) : section === "pos" && isPos ? (
              can(user.role, "credentials") ? (
                <PosSetup installation={installation} user={user} />
              ) : (
                <div className="panel">
                  <Empty icon={Server} title="POS setup is restricted">
                    Your role cannot open POS settings. Ask an owner or admin.
                  </Empty>
                </div>
              )
            ) : section === "deploy" && isPos ? (
              can(user.role, "credentials") ? (
                <InstallationDeploy installation={installation} user={user} />
              ) : (
                <div className="panel">
                  <Empty icon={Rocket} title="Deploy is restricted">
                    Your role cannot open deploy status. Ask an owner or admin.
                  </Empty>
                </div>
              )
            ) : section === "golive" && isPos ? (
              can(user.role, "credentials") ? (
                <InstallationGolive installation={installation} user={user} />
              ) : (
                <div className="panel">
                  <Empty icon={Globe} title="Go live is restricted">
                    Your role cannot open the go-live. Ask an owner or admin.
                  </Empty>
                </div>
              )
            ) : section === "usage" && isPos ? (
              can(user.role, "credentials") ? (
                <InstallationUsage installation={installation} user={user} />
              ) : (
                <div className="panel">
                  <Empty icon={Activity} title="Usage is restricted">
                    Your role cannot open usage checks. Ask an owner or admin.
                  </Empty>
                </div>
              )
            ) : (
              <Empty title="Page not found">
                Choose an installation section to continue.
              </Empty>
            )}
          </WorkspaceFrame>
        )
      }
    </Resource>
  );
}
function Summary({ id, user, product, onSaved }) {
  // Saving in the editor re-reads the record so the steps below stay current.
  const [saves, setSaves] = useState(0);
  return (
    <>
      <RecordEditor
        kind="installations"
        id={id}
        user={user}
        onSaved={() => {
          setSaves((n) => n + 1);
          onSaved?.();
        }}
      />
      <SetupSteps key={saves} id={id} product={product} />
    </>
  );
}
function SetupSteps({ id, product }) {
  const resource = useResource(`/installations/${id}`);
  return (
    <section className="panel setup-steps" aria-labelledby="setup-steps-title">
      <div className="panel-title">
        <div>
          <h2 id="setup-steps-title">Setup steps</h2>
          <p>Operator-verified readiness. These do not run any provisioning.</p>
        </div>
      </div>
      <Resource resource={resource}>
        {(installation) => (
          <ul className="step-list">
            {checksFor(product).map((check) => {
              const done = installation.checks?.includes(check.id);
              return (
                <li key={check.id}>
                  <span>{check.label}</span>
                  <Badge value={done ? "done" : "paused"}>
                    {done ? "Done" : "Pending"}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Resource>
    </section>
  );
}
const SECRETS = [
  ["vercel.token", "Vercel token"],
  ["mongo.uri", "MongoDB connection string"],
  ["cloudflare.token", "Cloudflare token"],
  ["image.keys", "Image store keys"],
  ["generated.authSecret", "Auth secret"],
  ["generated.healthStatsToken", "Health stats token"],
  ["generated.realtimePublishSecret", "Realtime publish secret"],
  ["posAdmin.password", "POS admin password"],
];
// One short line per secret: where it comes from.
const SECRET_HELP = {
  "vercel.token": "Vercel → Account Settings → Tokens.",
  "mongo.uri":
    "Atlas → Connect → Drivers (a live client: its MONGODB_URI), with the database name at the end.",
  "cloudflare.token":
    "Cloudflare → My Profile → API Tokens (a live client: Account Analytics Read).",
  "image.keys": "Only with an image store.",
  "generated.authSecret": "Go live creates it.",
  "generated.healthStatsToken":
    "Go live creates it. A live client: HEALTH_STATS_TOKEN from Vercel, after the Host.",
  "generated.realtimePublishSecret": "Go live creates it.",
  "posAdmin.password": "Go live creates it; reveal it once for the client.",
};
// A new client on its way to Go live: no admin deploy, not imported, no
// project of its own yet (or one its go-live is still setting up). Its POS
// setup leads with four short steps; every field stays under "All settings".
const isNewClient = (pos) =>
  !pos ||
  (!pos.importedAt &&
    !pos.deploy?.last &&
    (!pos.vercel?.projectId || Boolean(pos.golive && !pos.golive.live)));
const OPEN = {
  vercel: "https://vercel.com/account/settings/tokens",
  atlas: "https://cloud.mongodb.com",
  cloudflare: "https://dash.cloudflare.com/profile/api-tokens",
};
// A finished Check (Verify) answer for one step, in plain words.
const CHECK_TEXT = {
  vercel: {
    ok: "Token works.",
    unauthorized: "Token rejected. Make a new one.",
    forbidden: "Token has no access. Check its scope (the client’s team).",
    denied: "Token has no access. Check its scope (the client’s team).",
  },
  mongo: {
    ok: "Database reachable.",
    "not-set": "Not set yet.",
    "not-atlas": "Use the Atlas connection string (…mongodb.net).",
    "auth-failed": "Wrong user or password in the string.",
    unreachable: "Cannot reach it. Atlas → Network Access: allow access.",
    invalid: "This is not a connection string.",
  },
  cloudflare: {
    ok: "Token works.",
    unauthorized: "Token rejected. Make a new one.",
    forbidden:
      "Token cannot reach the account. Give it the three permissions on the client’s account.",
    denied:
      "Token cannot reach the account. Give it the three permissions on the client’s account.",
    "cf-account-ambiguous":
      "Token sees several accounts: enter the Account ID.",
    "not-found": "Account not found. Check the Account ID.",
    invalid: "The token or the Account ID is not valid.",
  },
};
const checkText = (flag, code) =>
  CHECK_TEXT[flag]?.[code] ?? describeCode(code).title;
const STEPS = [
  { key: "address", title: "Web address" },
  { key: "vercel", title: "Vercel", secret: "vercel.token", flag: "vercel" },
  { key: "database", title: "Database", secret: "mongo.uri", flag: "mongo" },
  {
    key: "realtime",
    title: "Realtime",
    secret: "cloudflare.token",
    flag: "cloudflare",
    optional: true,
  },
];
// The API config of the form-shaped value (configOf).
const apiConfig = (value) => ({
  slug: value.slug,
  subdomain: value.subdomain,
  host: value.host,
  tenantId: value.tenantId,
  rootDomain: value.rootDomain,
  vercel: value.vercel,
  cloudflare: value.cloudflareOn ? value.cloudflare : null,
  image: { ...value.image, store: value.image.store || null },
  posAdmin: value.posAdmin,
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function ExternalButton({ href, children }) {
  return (
    <a
      className="button secondary"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}
function ClientSteps({
  base,
  installationId,
  pos,
  canWrite,
  onSaved,
  onChanged,
  onStale,
  openSecret,
  formDirty,
}) {
  const secretSet = (field) => Boolean(pos?.secrets?.[field]?.set);
  const [skipped, setSkipped] = useState(() => new Set()),
    firstOpen =
      STEPS.find(
        (s) =>
          !(s.key === "address" ? pos?.subdomain : secretSet(s.secret)) &&
          !s.optional,
      )?.key ?? "",
    [open, setOpen] = useState(firstOpen),
    [label, setLabel] = useState(pos?.subdomain || ""),
    [login, setLogin] = useState(pos?.posAdmin?.username || "admin"),
    [teamId, setTeamId] = useState(pos?.vercel?.orgId || ""),
    [accountId, setAccountId] = useState(pos?.cloudflare?.accountId || ""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    alive = useRef(true);
  useEffect(() => setLabel(pos?.subdomain || ""), [pos?.subdomain]);
  useEffect(
    () => setLogin(pos?.posAdmin?.username || "admin"),
    [pos?.posAdmin?.username],
  );
  useEffect(() => setTeamId(pos?.vercel?.orgId || ""), [pos?.vercel?.orgId]);
  useEffect(
    () => setAccountId(pos?.cloudflare?.accountId || ""),
    [pos?.cloudflare?.accountId],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Save config fields from a step (the rest of the block unchanged).
  async function save(name, patch) {
    // Never overwrite unsaved edits in All settings (or be overwritten).
    if (formDirty.current) {
      setError(
        "Save your changes in All settings first (or put the old values back).",
      );
      return null;
    }
    setBusy(name);
    setError("");
    try {
      const value = { ...configOf(pos), ...patch };
      const result = await api(base, {
        method: "PUT",
        body: { rev: pos?.rev ?? 0, config: apiConfig(value) },
      });
      onSaved(result.pos);
      return result.pos;
    } catch (e) {
      if (e.code === "stale") onStale();
      else setError(e.message);
      return null;
    } finally {
      if (alive.current) setBusy("");
    }
  }
  // Check = the normal Verify of this client; each step reads its own flag.
  async function check() {
    setBusy("check");
    setError("");
    try {
      const { task } = await api(`${base}/verify`, {
        method: "POST",
        body: {},
      });
      const until = Date.now() + 90000;
      while (alive.current) {
        await wait(2000);
        const fresh = (await api(base)).pos;
        if (!alive.current) return;
        if (!fresh) {
          onStale();
          break;
        }
        onChanged(fresh);
        const t = fresh.task;
        if (!t || t.id !== task.id) break;
        if (!ACTIVE_TASK_STATES.includes(t.status)) {
          if (t.status === "failed")
            setError(
              t.error?.code === "no-token"
                ? "Set the Vercel token first."
                : describeCode(t.error?.code).title,
            );
          else if (t.status !== "succeeded")
            setError("The check did not finish. Try again.");
          break;
        }
        if (Date.now() > until) {
          setError("The check is slow. Look again in a minute.");
          break;
        }
      }
    } catch (e) {
      if (alive.current)
        setError(
          e.code === "not-ready"
            ? "The deploy worker is offline. Try again in a minute."
            : e.message,
        );
    } finally {
      if (alive.current) setBusy("");
    }
  }
  // What the last Check said for a step: only when it ran after the secret
  // was last changed.
  const result = (step) => {
    const v = pos?.verify,
      code = step.flag && v?.[step.flag];
    if (!code || !v?.at) return null;
    const changed = pos.secrets?.[step.secret]?.changedAt;
    if (changed && new Date(changed) > new Date(v.at)) return null;
    return code;
  };
  const stateOf = (step) => {
    const done =
      step.key === "address" ? Boolean(pos?.subdomain) : secretSet(step.secret);
    const code = done ? result(step) : null;
    if (code && code !== "ok") return ["attention", "Problem"];
    if (code === "ok") return ["done", "Works"];
    if (done) return ["done", "Done"];
    if (skipped.has(step.key)) return ["disabled", "Skipped"];
    return ["paused", step.optional ? "Optional" : "To do"];
  };
  const doneCount = STEPS.filter(
    (s) => !s.optional && stateOf(s)[0] === "done",
  ).length;
  const next = (key) => {
    const i = STEPS.findIndex((s) => s.key === key);
    setOpen(STEPS[i + 1]?.key ?? "");
  };
  const skip = (key) => {
    setSkipped((old) => new Set(old).add(key));
    next(key);
  };
  const disabled = !canWrite || Boolean(busy);
  const foot = (step) => {
    const done =
      stateOf(step)[1] !== "To do" && stateOf(step)[1] !== "Optional";
    return (
      <div className="client-step-foot">
        {step.flag && (
          <Button
            variant="secondary"
            busy={busy === "check"}
            disabled={disabled || !pos}
            onClick={check}
          >
            Check
          </Button>
        )}
        <Button
          variant={done ? "primary" : "secondary"}
          disabled={Boolean(busy) && busy !== "check"}
          onClick={() => (done ? next(step.key) : skip(step.key))}
        >
          {done ? "Next" : "Skip"}
        </Button>
      </div>
    );
  };
  const body = {
    address: (
      <form
        className="client-step-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const name = label.trim().toLowerCase();
          const saved = await save("address", {
            slug: pos?.slug || name,
            subdomain: name,
            posAdmin: { username: login.trim() },
          });
          if (saved) next("address");
        }}
      >
        <p>The address the client opens.</p>
        <div className="client-step-fields">
          <Field label="Web address">
            <input
              required
              maxLength={63}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={disabled}
            />
          </Field>
          <span className="client-step-suffix">.sandbee.in</span>
          <Field label="POS login name">
            <input
              required
              maxLength={32}
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              disabled={disabled}
            />
          </Field>
        </div>
        <div className="client-step-foot">
          <Button type="submit" busy={busy === "address"} disabled={disabled}>
            Save
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={Boolean(busy) && busy !== "check"}
            onClick={() => next("address")}
          >
            Skip
          </Button>
        </div>
      </form>
    ),
    vercel: (
      <>
        <p>
          In the client’s Vercel account: Account Settings → Tokens → Create.
        </p>
        <div className="client-step-actions">
          <ExternalButton href={OPEN.vercel}>Open Vercel</ExternalButton>
          <Button
            variant="secondary"
            disabled={disabled || !pos}
            onClick={() => openSecret("vercel.token")}
          >
            {secretSet("vercel.token") ? "Replace token" : "Paste token"}
          </Button>
        </div>
        <form
          className="client-step-inline"
          onSubmit={(event) => {
            event.preventDefault();
            save("team", {
              vercel: { ...configOf(pos).vercel, orgId: teamId.trim() },
            });
          }}
        >
          <Field label="Team ID (team accounts: Settings → General)">
            <input
              maxLength={64}
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              disabled={disabled || !pos}
            />
          </Field>
          <Button
            type="submit"
            variant="secondary"
            busy={busy === "team"}
            disabled={disabled || !pos}
          >
            Save
          </Button>
        </form>
      </>
    ),
    database: (
      <>
        <p>
          MongoDB Atlas → Connect → Drivers. Add the database name at the end.
        </p>
        <div className="client-step-actions">
          <ExternalButton href={OPEN.atlas}>Open Atlas</ExternalButton>
          <Button
            variant="secondary"
            disabled={disabled || !pos}
            onClick={() => openSecret("mongo.uri")}
          >
            {secretSet("mongo.uri") ? "Replace" : "Paste connection string"}
          </Button>
        </div>
      </>
    ),
    realtime: (
      <>
        <p>
          Live updates between screens. Token permissions: Workers Scripts Edit,
          Account Settings Read, Account Analytics Read.
        </p>
        <div className="client-step-actions">
          <ExternalButton href={OPEN.cloudflare}>
            Open Cloudflare
          </ExternalButton>
          <Button
            variant="secondary"
            disabled={disabled || !pos}
            onClick={async () => {
              // The Cloudflare block comes first, then its token.
              if (
                !pos.cloudflare &&
                !(await save("realtime", { cloudflareOn: true }))
              )
                return;
              openSecret("cloudflare.token");
            }}
          >
            {secretSet("cloudflare.token") ? "Replace token" : "Paste token"}
          </Button>
        </div>
        {pos?.cloudflare && (
          <form
            className="client-step-inline"
            onSubmit={(event) => {
              event.preventDefault();
              save("account", {
                cloudflareOn: true,
                cloudflare: {
                  ...configOf(pos).cloudflare,
                  accountId: accountId.trim(),
                },
              });
            }}
          >
            <Field label="Account ID (only if Check asks)">
              <input
                maxLength={64}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                disabled={disabled}
              />
            </Field>
            <Button
              type="submit"
              variant="secondary"
              busy={busy === "account"}
              disabled={disabled}
            >
              Save
            </Button>
          </form>
        )}
      </>
    ),
  };
  return (
    <section
      className="panel client-steps"
      aria-labelledby="client-steps-title"
    >
      <div className="panel-title">
        <div>
          <h2 id="client-steps-title">Set up this client</h2>
          <p>Four steps, then Go live. Check is optional.</p>
        </div>
        <Badge value={doneCount === 3 ? "done" : "paused"}>
          {doneCount}/3 done
        </Badge>
      </div>
      {error && (
        <div className="client-steps-error">
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}
      <ol className="client-step-list">
        {STEPS.map((step, i) => {
          const [tone, word] = stateOf(step),
            code = result(step),
            isOpen = open === step.key;
          return (
            <li
              key={step.key}
              className={`client-step ${isOpen ? "is-open" : ""}`}
            >
              <button
                type="button"
                className="client-step-head"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? "" : step.key)}
              >
                <span className="client-step-n" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="client-step-title">
                  {step.title}
                  {step.optional && (
                    <span className="small subtle"> (optional)</span>
                  )}
                </span>
                <span className="client-step-summary small subtle">
                  {step.key === "address"
                    ? pos?.host ||
                      (pos?.subdomain ? `${pos.subdomain}.sandbee.in` : "")
                    : code
                      ? checkText(step.flag, code)
                      : ""}
                </span>
                <Badge value={tone}>{word}</Badge>
              </button>
              {isOpen && (
                <div className="client-step-body">
                  {body[step.key]}
                  {step.key !== "address" && foot(step)}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="panel-foot">
        <span>Photos (R2 or Cloudinary): All settings below.</span>
        <Link
          href={`/installations/${installationId}/golive`}
          className="button primary"
        >
          Go live
        </Link>
      </div>
    </section>
  );
}
const STALE = "POS settings changed. They were reloaded: review and try again.";
function PosSetup({ installation, user }) {
  const resource = useResource(`/installations/${installation._id}/pos`),
    [notice, setNotice] = useState("");
  // Fix links from the Deploy tab end in #vercel, #secrets, #host or #image;
  // the Go live tab adds #cloudflare and #admin.
  const loaded = Boolean(resource.data);
  useEffect(() => {
    if (!loaded || !location.hash) return;
    const target = document.getElementById(location.hash.slice(1));
    if (target) {
      // A new client keeps every field under "All settings": open it first.
      const fold = target.closest("details");
      if (fold) fold.open = true;
      target.scrollIntoView();
      target.querySelector("input,button")?.focus({ preventScroll: true });
    }
  }, [loaded]);
  return (
    <>
      <PageTitle
        eyebrow={installation.name}
        title="POS setup"
        description="Where this customer’s POS lives and the secrets it needs. Deploys are run from the Deploy tab."
      />
      {notice && <ErrorBox>{notice}</ErrorBox>}
      <Resource resource={resource}>
        {(data) => (
          <PosBody
            installationId={installation._id}
            initial={data.pos}
            user={user}
            onStale={() => {
              setNotice(STALE);
              resource.reload();
            }}
            onFresh={() => setNotice("")}
            reload={resource.reload}
          />
        )}
      </Resource>
    </>
  );
}
const configOf = (pos) => ({
  slug: pos?.slug || "",
  subdomain: pos?.subdomain || "",
  host: pos?.host || "",
  tenantId: pos?.tenantId || "",
  rootDomain: pos?.rootDomain || "",
  vercel: {
    projectName: pos?.vercel?.projectName || "",
    projectId: pos?.vercel?.projectId || "",
    orgId: pos?.vercel?.orgId || "",
    teamId: pos?.vercel?.teamId || "",
  },
  cloudflareOn: Boolean(pos?.cloudflare),
  cloudflare: {
    accountId: pos?.cloudflare?.accountId || "",
    workerName: pos?.cloudflare?.workerName || "",
    workerUrl: pos?.cloudflare?.workerUrl || "",
  },
  image: {
    store: pos?.image?.store || "",
    publicBaseUrl: pos?.image?.publicBaseUrl || "",
    cloudName: pos?.image?.cloudName || "",
    r2AccountId: pos?.image?.r2AccountId || "",
    bucket: pos?.image?.bucket || "",
  },
  posAdmin: { username: pos?.posAdmin?.username || "" },
});
function PosBody({ installationId, initial, user, onStale, onFresh, reload }) {
  const [pos, setPos] = useState(initial),
    [epoch, setEpoch] = useState(0),
    // Bumped when a step saves settings: the form below re-reads them.
    [formEpoch, setFormEpoch] = useState(0),
    [modal, setModal] = useState(null),
    // Unsaved edits in All settings: a step save waits for them.
    formDirty = useRef(false),
    posRef = useRef(pos),
    steps = isNewClient(pos);
  posRef.current = pos;
  // A Check poll can bring changes made elsewhere (another tab, a go-live):
  // an older reply is ignored, changed settings re-read the form, and unsaved
  // edits never sit on top of them (reload, like any stale write).
  function changed(fresh) {
    const old = posRef.current;
    if (old && fresh.rev < old.rev) return;
    if (
      old &&
      JSON.stringify(configOf(old)) !== JSON.stringify(configOf(fresh))
    ) {
      if (formDirty.current) {
        onStale();
        return;
      }
      setFormEpoch((n) => n + 1);
    }
    setPos(fresh);
  }
  const base = `/installations/${installationId}/pos`;
  const canWrite = can(user.role, "credentials"),
    owner = can(user.role, "secrets");
  if (!pos && !canWrite)
    return (
      <div className="panel">
        <Empty icon={Server} title="POS setup has not been created">
          Ask an owner or admin to set it up.
        </Empty>
      </div>
    );
  const form = (
    <PosForm
      key={formEpoch}
      base={base}
      installationId={installationId}
      pos={pos}
      writable={canWrite}
      live={!steps}
      onDirty={(dirty) => {
        formDirty.current = dirty;
      }}
      onSaved={(view) => {
        setPos(view);
        onFresh();
      }}
      onStale={onStale}
    />
  );
  const secrets = pos && (
    <section
      id="secrets"
      className="panel setup-steps"
      aria-labelledby="secrets-title"
    >
      <div className="panel-title">
        <div>
          <h2 id="secrets-title">Secrets</h2>
          <p>
            Encrypted values. Revealing needs your authenticator, is audited and
            hides after 30 seconds.
          </p>
        </div>
      </div>
      <ul className="step-list">
        {SECRETS.map(([field, name]) => {
          const info = pos.secrets[field];
          return (
            <li key={field} className="secret-row">
              <div className="secret-line">
                <span className="secret-name">{name}</span>
                <Badge value={info.set ? "active" : "paused"}>
                  {info.set ? "Set" : "Not set"}
                </Badge>
                {info.changedAt && (
                  <span className="small subtle">
                    Changed {dateTime(info.changedAt)}
                  </span>
                )}
                <div className="secret-actions">
                  {canWrite && (
                    <Button
                      variant="secondary"
                      aria-label={`${info.set ? "Replace" : "Set"} ${name}`}
                      onClick={() => setModal({ type: "secret", field })}
                    >
                      {info.set ? "Replace" : "Set"}
                    </Button>
                  )}
                  {owner && info.set && (
                    <>
                      <RevealValue
                        key={`${field}-${epoch}`}
                        label={name}
                        load={() =>
                          withStepUp(() =>
                            api(`${base}/reveal`, {
                              method: "POST",
                              body: { field },
                            }),
                          )
                        }
                        copyText={(payload) => payload.value}
                        view={(payload) => (
                          <code className="secret-value">{payload.value}</code>
                        )}
                      />
                      <Button
                        variant="danger"
                        aria-label={`Remove ${name}`}
                        onClick={() => setModal({ type: "remove", field })}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <p className="secret-help">{SECRET_HELP[field]}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
  return (
    <>
      {steps ? (
        <>
          <ClientSteps
            base={base}
            installationId={installationId}
            pos={pos}
            canWrite={canWrite}
            onSaved={(view) => {
              setPos(view);
              setFormEpoch((n) => n + 1);
              onFresh();
            }}
            onChanged={changed}
            onStale={onStale}
            openSecret={(field) => setModal({ type: "secret", field })}
            formDirty={formDirty}
          />
          <details className="all-settings">
            <summary>All settings</summary>
            {form}
            {secrets}
          </details>
        </>
      ) : (
        <>
          {form}
          {secrets}
        </>
      )}
      {pos && owner && (
        <section className="danger-zone" aria-labelledby="remove-pos-title">
          <h2 id="remove-pos-title">Remove POS settings</h2>
          <p>
            Deletes the settings and every stored secret for this installation.
            Use it to undo a wrong setup.
          </p>
          <Button variant="danger" onClick={() => setModal({ type: "block" })}>
            Remove POS settings
          </Button>
        </section>
      )}
      {modal?.type === "secret" && (
        <PosSecretModal
          base={base}
          pos={pos}
          field={modal.field}
          name={SECRETS.find(([field]) => field === modal.field)[1]}
          onClose={() => setModal(null)}
          onSaved={(view) => {
            setPos(view);
            setEpoch((n) => n + 1);
            setModal(null);
            onFresh();
          }}
          onStale={() => {
            setModal(null);
            onStale();
          }}
        />
      )}
      {modal?.type === "remove" && (
        <ConfirmModal
          title="Remove this secret?"
          action="Remove secret"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            try {
              const result = await withStepUp(() =>
                api(`${base}/secret`, {
                  method: "DELETE",
                  body: { rev: pos.rev, field: modal.field },
                }),
              );
              setPos(result.pos);
              setEpoch((n) => n + 1);
              setModal(null);
              onFresh();
            } catch (e) {
              if (e.code === "stale") {
                setModal(null);
                onStale();
              } else throw e;
            }
          }}
        >
          <p>The stored copy is deleted. It is not changed at the provider.</p>
        </ConfirmModal>
      )}
      {modal?.type === "block" && (
        <ConfirmModal
          title="Remove POS settings?"
          action="Remove POS settings"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            try {
              await withStepUp(() =>
                api(base, { method: "DELETE", body: { rev: pos.rev } }),
              );
              setModal(null);
              reload();
            } catch (e) {
              if (e.code === "stale") {
                setModal(null);
                onStale();
              } else throw e;
            }
          }}
        >
          <p>
            All settings and stored secrets for this installation are deleted.
          </p>
        </ConfirmModal>
      )}
    </>
  );
}
function PosForm({
  base,
  installationId,
  pos,
  writable,
  live,
  onDirty,
  onSaved,
  onStale,
}) {
  const [value, setValue] = useState(() => configOf(pos)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  // Unsaved = the form differs from what is saved (typing the old value
  // back clears it); an unmounted form holds nothing.
  const baseline = JSON.stringify(configOf(pos));
  useEffect(() => {
    onDirty?.(JSON.stringify(value) !== baseline);
  }, [value, baseline]);
  useEffect(
    () => () => {
      onDirty?.(false);
    },
    [],
  );
  const touch = () => setSaved(false);
  const top = (name) => ({
      value: value[name],
      onChange: (event) => {
        setValue((old) => ({ ...old, [name]: event.target.value }));
        touch();
      },
    }),
    nested = (group, name) => ({
      value: value[group][name],
      onChange: (event) => {
        setValue((old) => ({
          ...old,
          [group]: { ...old[group], [name]: event.target.value },
        }));
        touch();
      },
    });
  const store = value.image.store;
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api(base, {
        method: "PUT",
        body: { rev: pos?.rev ?? 0, config: apiConfig(value) },
      });
      setSaved(true);
      onSaved(result.pos);
    } catch (e) {
      if (e.code === "stale") onStale();
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="panel edit-form pos-form"
      onSubmit={submit}
      aria-label="POS configuration"
    >
      {error && <ErrorBox>{error}</ErrorBox>}
      {saved && <Notice>POS settings saved.</Notice>}
      <fieldset disabled={!writable || busy}>
        <div className="form-section" id="host">
          <h2>Where it lives</h2>
          <div className="form-grid">
            <Field
              label="Slug"
              hint="Short name; you type it to confirm deploys."
            >
              <input required maxLength={52} {...top("slug")} />
            </Field>
            <Field label="Subdomain" hint="One DNS label, e.g. shop.">
              <input maxLength={63} {...top("subdomain")} />
            </Field>
            <Field label="Host" hint="Without https://. A new client: empty.">
              <input maxLength={253} {...top("host")} />
            </Field>
            <Field
              label="Root domain"
              hint="ROOT_DOMAIN from the Vercel env. A new client: empty."
            >
              <input maxLength={253} {...top("rootDomain")} />
            </Field>
            <Field
              label="Tenant ID"
              hint="TENANT_ID from the Vercel env. A new client: empty."
            >
              <input maxLength={64} {...top("tenantId")} />
            </Field>
            <Field
              label="POS admin username"
              id="admin"
              hint="The POS login, e.g. admin."
            >
              <input maxLength={32} {...nested("posAdmin", "username")} />
            </Field>
          </div>
          <p className="status-line">
            <span className="field-label">Deploy lock</span>
            <Badge value={pos?.deployLock === false ? "live" : "paused"}>
              {pos?.deployLock === false ? (
                <LockOpen size={11} />
              ) : (
                <Lock size={11} />
              )}
              {pos?.deployLock === false ? "Unlocked" : "Locked"}
            </Badge>
            {pos && (
              <Link
                href={`/installations/${installationId}/deploy`}
                className="text-link"
              >
                Change it on the Deploy tab
              </Link>
            )}
          </p>
        </div>
        <div className="form-section" id="vercel">
          <h2>Vercel</h2>
          {live && (
            <p className="form-note">
              Function Region = Mumbai (bom1): Verify and every deploy set it
              with the stored token; a deployment outside Mumbai never goes
              live.
            </p>
          )}
          <div className="form-grid">
            <Field label="Vercel project name" hint="Empty = the slug.">
              <input maxLength={52} {...nested("vercel", "projectName")} />
            </Field>
            <Field
              label="Vercel project ID"
              hint="Vercel → Settings → General → Project ID. A new client: empty."
            >
              <input maxLength={64} {...nested("vercel", "projectId")} />
            </Field>
            <Field
              label="Vercel org ID"
              hint="Team ID (team_…) or, personal account, the Vercel ID: Settings → General."
            >
              <input maxLength={64} {...nested("vercel", "orgId")} />
            </Field>
            <Field label="Vercel team ID" hint="Leave empty.">
              <input maxLength={64} {...nested("vercel", "teamId")} />
            </Field>
          </div>
        </div>
        <div className="form-section" id="cloudflare">
          <h2>Cloudflare</h2>
          <label className="check-row">
            <input
              type="checkbox"
              checked={value.cloudflareOn}
              onChange={(event) => {
                setValue((old) => ({
                  ...old,
                  cloudflareOn: event.target.checked,
                }));
                touch();
              }}
            />
            This POS uses a Cloudflare Worker
          </label>
          <p className="form-note">
            Realtime (live updates between screens).
            {live &&
              " A live client: only if its Vercel env has NEXT_PUBLIC_REALTIME_URL."}
          </p>
          {value.cloudflareOn && (
            <div className="form-grid">
              <Field
                label="Cloudflare account ID"
                hint="Cloudflare → Account home → Account ID."
              >
                <input maxLength={64} {...nested("cloudflare", "accountId")} />
              </Field>
              <Field label="Worker name" hint="A new client: empty.">
                <input maxLength={52} {...nested("cloudflare", "workerName")} />
              </Field>
              <Field
                label="Worker URL"
                hint={
                  live
                    ? "HTTPS only: the host of NEXT_PUBLIC_REALTIME_URL, without /join."
                    : "HTTPS only. A new client: empty."
                }
              >
                <input
                  type="url"
                  maxLength={500}
                  {...nested("cloudflare", "workerUrl")}
                />
              </Field>
            </div>
          )}
        </div>
        <div className="form-section" id="image">
          <h2>Image store</h2>
          <Field
            label="Image store"
            hint={
              live
                ? "Must match the client’s NEXT_PUBLIC_* image setting."
                : "Only if the client uploads photos."
            }
          >
            <Select
              value={store}
              onChange={(event) => {
                setValue((old) => ({
                  ...old,
                  image: { ...old.image, store: event.target.value },
                }));
                touch();
              }}
              options={[
                { value: "", label: "None" },
                { value: "r2", label: "Cloudflare R2" },
                { value: "cloudinary", label: "Cloudinary" },
              ]}
            />
          </Field>
          {store === "r2" && (
            <div className="form-grid">
              <Field
                label="Public base URL"
                hint="HTTPS only. The bucket’s public URL."
              >
                <input
                  type="url"
                  maxLength={500}
                  {...nested("image", "publicBaseUrl")}
                />
              </Field>
              <Field label="R2 account ID" hint="Cloudflare → R2 → Account ID.">
                <input maxLength={64} {...nested("image", "r2AccountId")} />
              </Field>
              <Field label="Bucket" hint="Cloudflare → R2 → the bucket’s name.">
                <input maxLength={63} {...nested("image", "bucket")} />
              </Field>
            </div>
          )}
          {store === "cloudinary" && (
            <Field label="Cloud name" hint="Cloudinary dashboard → Cloud name.">
              <input maxLength={64} {...nested("image", "cloudName")} />
            </Field>
          )}
        </div>
      </fieldset>
      {writable && (
        <div className="form-actions">
          <span className="small subtle">
            {pos ? `Revision ${pos.rev}` : "Not created yet"}
          </span>
          <Button type="submit" busy={busy}>
            {pos ? "Save POS settings" : "Create POS settings"}
          </Button>
        </div>
      )}
    </form>
  );
}
function PosSecretModal({ base, pos, field, name, onClose, onSaved, onStale }) {
  const [value, setValue] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    json = field === "image.keys";
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api(`${base}/secret`, {
        method: "PUT",
        body: { rev: pos.rev, field, value },
      });
      setValue("");
      onSaved(result.pos);
    } catch (e) {
      if (e.code === "stale") onStale();
      else setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${pos.secrets[field].set ? "Replace" : "Set"} ${name.toLowerCase()}`}
      onClose={onClose}
    >
      <p className="subtle">
        It is encrypted before it is stored and cannot be read back without your
        authenticator.
      </p>
      <form onSubmit={submit}>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Field
          label={name}
          hint={
            json
              ? 'JSON: {"accessKeyId": "…", "secretAccessKey": "…"} for R2, or {"apiKey": "…", "apiSecret": "…"} for Cloudinary.'
              : SECRET_HELP[field]
          }
        >
          {json ? (
            <textarea
              rows={4}
              required
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <SecretInput
              required
              maxLength={4096}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" busy={busy}>
          Save encrypted secret
        </Button>
      </form>
    </Modal>
  );
}
