import { useEffect, useState } from "react";
import {
  Activity,
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
// Where each secret comes from (shown under its row and in its Set box).
const SECRET_HELP = {
  "vercel.token":
    "Vercel → Account Settings → Tokens → Create. Scope: the team or account that owns the client's project.",
  "mongo.uri":
    "A live client: MONGODB_URI from Vercel → Project → Settings → Environment Variables (or Atlas → Connect → Drivers). A new client: a new, empty database. It must end with /<database>.",
  "cloudflare.token":
    "Cloudflare → My Profile → API Tokens → Create, for the client's account only. A live client: Account Analytics Read. Realtime from Go live: also Workers Scripts Edit and Account Settings Read.",
  "image.keys":
    "A new client with an image store: its API keys (R2 or Cloudinary). A live client: leave empty.",
  "generated.authSecret":
    "Leave empty: Go live creates it. A live client does not need it.",
  "generated.healthStatsToken":
    "A live client: HEALTH_STATS_TOKEN from the Vercel environment variables, if it exists. Set the Host first. Go live creates it for a new client.",
  "generated.realtimePublishSecret":
    "Leave empty: Go live creates it. A live client does not need it.",
  "posAdmin.password":
    "A new client: leave empty, Go live creates the login and you reveal the password once to hand it over. A live client: optional, stored only.",
};
// Setup guide (the owner's ask, 2026-10-31): the order of the steps and where
// every value comes from, for a client already live on Vercel (moved from the
// local console) and for a new client (Go live tab).
function PosGuide({ defaultOpen }) {
  const [open] = useState(defaultOpen);
  return (
    <details className="panel pos-guide" open={open}>
      <summary>
        <span className="pos-guide-title">Setup guide</span>
        <span className="small subtle">
          What to fill in, where each value comes from, and in which order.
        </span>
      </summary>
      <div className="pos-guide-body">
        <section aria-labelledby="guide-live-title">
          <h2 id="guide-live-title">A client already live on Vercel</h2>
          <ol>
            <li>
              Fill in the fields below: each one says where its value comes from
              (the client’s Vercel project: Settings → General and Settings →
              Environment Variables). Then save.
            </li>
            <li>
              Secrets: Vercel token and MongoDB connection string; the Health
              stats token if the Vercel env has HEALTH_STATS_TOKEN; the
              Cloudflare token if the client uses a Worker. Leave the rest
              empty.
            </li>
            <li>
              Deploy tab → Verify now. Every check must be ok; fix here what it
              reports.
            </li>
            <li>
              Vercel → Project → Settings → Functions → Function Region: Mumbai
              (bom1). Admin’s builds carry no region, so without it the
              functions run in the USA.
            </li>
            <li>
              Stop the local console for this client (deployLock in its client
              file, or remove its profile), so only admin uploads from now on.
            </li>
            <li>
              Deploy tab → Unlock (slug and authenticator) → deploy a branch.
              Everything on that branch goes live; a failed health check rolls
              back by itself.
            </li>
            <li>Usage tab → Watch.</li>
          </ol>
        </section>
        <section aria-labelledby="guide-new-title">
          <h2 id="guide-new-title">A new client</h2>
          <ol>
            <li>
              Slug, Subdomain (the web address label: label.sandbee.in) and POS
              admin username. Leave Host, Root domain, Tenant ID and Vercel
              project ID empty: Go live fills them. Vercel org ID: the team’s ID
              (team_…) for a team account, else empty.
            </li>
            <li>
              Image store if the client uses one; for realtime, tick Cloudflare
              and add the account ID. Then save.
            </li>
            <li>
              Secrets: Vercel token, MongoDB connection string, Image store keys
              (with a store), Cloudflare token (for realtime). Leave the other
              four empty: admin creates them.
            </li>
            <li>
              Go live tab → Start → enter the DNS record it shows at GoDaddy →
              Check DNS → Unlock and deploy.
            </li>
          </ol>
        </section>
        <p className="form-note">
          Copy every secret from its source straight into its Set box; never
          into notes or chat.
        </p>
      </div>
    </details>
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
    [modal, setModal] = useState(null);
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
  return (
    <>
      <PosGuide
        defaultOpen={
          !pos?.secrets?.["vercel.token"]?.set ||
          !pos?.secrets?.["mongo.uri"]?.set
        }
      />
      <PosForm
        base={base}
        installationId={installationId}
        pos={pos}
        writable={canWrite}
        onSaved={(view) => {
          setPos(view);
          onFresh();
        }}
        onStale={onStale}
      />
      {pos && (
        <section
          id="secrets"
          className="panel setup-steps"
          aria-labelledby="secrets-title"
        >
          <div className="panel-title">
            <div>
              <h2 id="secrets-title">Secrets</h2>
              <p>
                Encrypted values. Revealing needs your authenticator, is audited
                and hides after 30 seconds.
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
                              <code className="secret-value">
                                {payload.value}
                              </code>
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
function PosForm({ base, installationId, pos, writable, onSaved, onStale }) {
  const [value, setValue] = useState(() => configOf(pos)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const top = (name) => ({
      value: value[name],
      onChange: (event) => {
        setValue((old) => ({ ...old, [name]: event.target.value }));
        setSaved(false);
      },
    }),
    nested = (group, name) => ({
      value: value[group][name],
      onChange: (event) => {
        setValue((old) => ({
          ...old,
          [group]: { ...old[group], [name]: event.target.value },
        }));
        setSaved(false);
      },
    });
  const store = value.image.store;
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const config = {
        slug: value.slug,
        subdomain: value.subdomain,
        host: value.host,
        tenantId: value.tenantId,
        rootDomain: value.rootDomain,
        vercel: value.vercel,
        cloudflare: value.cloudflareOn ? value.cloudflare : null,
        image: { ...value.image, store: store || null },
        posAdmin: value.posAdmin,
      };
      const result = await api(base, {
        method: "PUT",
        body: { rev: pos?.rev ?? 0, config },
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
              hint="Lowercase letters, digits and hyphens. Your short name for this client; you type it to confirm deploys."
            >
              <input required maxLength={52} {...top("slug")} />
            </Field>
            <Field
              label="Subdomain"
              hint="One DNS label, e.g. shop. A new client: its web address label (label.sandbee.in). A live client: the first part of its host."
            >
              <input maxLength={63} {...top("subdomain")} />
            </Field>
            <Field
              label="Host"
              hint="A live client: the address that opens its POS directly, without https:// (e.g. name.vercel.app or its own domain). A new client: leave empty, Go live fills it."
            >
              <input maxLength={253} {...top("host")} />
            </Field>
            <Field
              label="Root domain"
              hint="A live client: the ROOT_DOMAIN value in Vercel → Project → Settings → Environment Variables, exactly. A new client: leave empty."
            >
              <input maxLength={253} {...top("rootDomain")} />
            </Field>
            <Field
              label="Tenant ID"
              hint="A live client: the TENANT_ID value in the Vercel environment variables, exactly (its /api/health shows it as tenant). A new client: leave empty."
            >
              <input maxLength={64} {...top("tenantId")} />
            </Field>
            <Field
              label="POS admin username"
              id="admin"
              hint="A new client: the POS login Go live creates (e.g. admin). A live client: optional, stored only."
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
          <div className="form-grid">
            <Field
              label="Vercel project name"
              hint="The project’s name in Vercel. A live client: for your reference only. A new client: the name Go live gives the project (empty = the slug)."
            >
              <input maxLength={52} {...nested("vercel", "projectName")} />
            </Field>
            <Field
              label="Vercel project ID"
              hint="A live client: Vercel → Project → Settings → General → Project ID (prj_…). A new client: leave empty, Go live fills it."
            >
              <input maxLength={64} {...nested("vercel", "projectId")} />
            </Field>
            <Field
              label="Vercel org ID"
              hint="Team account: Team Settings → General → Team ID (team_…). Personal account: Account Settings → General → Vercel ID. A new client on a personal account: leave empty."
            >
              <input maxLength={64} {...nested("vercel", "orgId")} />
            </Field>
            <Field
              label="Vercel team ID"
              hint="Leave empty: admin uses a team_… org ID by itself."
            >
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
                setSaved(false);
              }}
            />
            This POS uses a Cloudflare Worker
          </label>
          <p className="form-note">
            Realtime. A live client: tick it only when its Vercel environment
            variables have NEXT_PUBLIC_REALTIME_URL. A new client: tick it for
            realtime (Go live uploads the Worker).
          </p>
          {value.cloudflareOn && (
            <div className="form-grid">
              <Field
                label="Cloudflare account ID"
                hint="Cloudflare dashboard → the client’s account → Account ID (32 characters, also in the address bar)."
              >
                <input maxLength={64} {...nested("cloudflare", "accountId")} />
              </Field>
              <Field
                label="Worker name"
                hint="A live client: the Worker’s name in Cloudflare → Workers & Pages. A new client: leave empty, Go live names it."
              >
                <input maxLength={52} {...nested("cloudflare", "workerName")} />
              </Field>
              <Field
                label="Worker URL"
                hint="HTTPS only. A live client: https:// and the host of NEXT_PUBLIC_REALTIME_URL (without /join), exactly: every build uses it. A new client: leave empty."
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
            hint="A live client: Cloudflare R2 if its Vercel environment variables have NEXT_PUBLIC_R2_PUBLIC_BASE_URL, Cloudinary if NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, else None. Every build uses it, so it must match."
          >
            <Select
              value={store}
              onChange={(event) => {
                setValue((old) => ({
                  ...old,
                  image: { ...old.image, store: event.target.value },
                }));
                setSaved(false);
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
                hint="HTTPS only. A live client: NEXT_PUBLIC_R2_PUBLIC_BASE_URL, exactly. Else Cloudflare → R2 → the bucket → Settings → Public access."
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
            <Field
              label="Cloud name"
              hint="A live client: NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, exactly. Else Cloudinary dashboard → Cloud name."
            >
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
