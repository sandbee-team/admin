import { useEffect, useState } from "react";
import { LayoutDashboard, Lock, LockOpen, Rocket, Server } from "lucide-react";
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
import { Link } from "../lib/router";
export function InstallationWorkspace({ id, section = "", user }) {
  const resource = useResource(`/installations/${id}`),
    productResource = useResource(
      resource.data ? `/products/${resource.data.productId}` : null,
    ),
    // The product decides the tabs, so wait for it before drawing the rail.
    waiting =
      Boolean(resource.data) && !productResource.data && !productResource.error,
    isPos = productResource.data?.slug === "pos",
    tabs = [
      ["", "Summary", LayoutDashboard],
      ...(isPos && can(user.role, "credentials")
        ? [
            ["pos", "POS setup", Server],
            ["deploy", "Deploy", Rocket],
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
const STALE = "POS settings changed. They were reloaded: review and try again.";
function PosSetup({ installation, user }) {
  const resource = useResource(`/installations/${installation._id}/pos`),
    [notice, setNotice] = useState("");
  // Fix links from the Deploy tab end in #vercel, #secrets, #host or #image.
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
            <Field label="Slug" hint="Lowercase letters, digits and hyphens.">
              <input required maxLength={52} {...top("slug")} />
            </Field>
            <Field label="Subdomain" hint="One DNS label, e.g. shop.">
              <input maxLength={63} {...top("subdomain")} />
            </Field>
            <Field label="Host">
              <input maxLength={253} {...top("host")} />
            </Field>
            <Field label="Root domain">
              <input maxLength={253} {...top("rootDomain")} />
            </Field>
            <Field label="Tenant ID">
              <input maxLength={64} {...top("tenantId")} />
            </Field>
            <Field label="POS admin username">
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
            <Field label="Vercel project name">
              <input maxLength={52} {...nested("vercel", "projectName")} />
            </Field>
            <Field label="Vercel project ID">
              <input maxLength={64} {...nested("vercel", "projectId")} />
            </Field>
            <Field label="Vercel org ID">
              <input maxLength={64} {...nested("vercel", "orgId")} />
            </Field>
            <Field label="Vercel team ID">
              <input maxLength={64} {...nested("vercel", "teamId")} />
            </Field>
          </div>
        </div>
        <div className="form-section">
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
          {value.cloudflareOn && (
            <div className="form-grid">
              <Field label="Cloudflare account ID">
                <input maxLength={64} {...nested("cloudflare", "accountId")} />
              </Field>
              <Field label="Worker name">
                <input maxLength={52} {...nested("cloudflare", "workerName")} />
              </Field>
              <Field label="Worker URL" hint="HTTPS only.">
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
          <Field label="Image store">
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
              <Field label="Public base URL" hint="HTTPS only.">
                <input
                  type="url"
                  maxLength={500}
                  {...nested("image", "publicBaseUrl")}
                />
              </Field>
              <Field label="R2 account ID">
                <input maxLength={64} {...nested("image", "r2AccountId")} />
              </Field>
              <Field label="Bucket">
                <input maxLength={63} {...nested("image", "bucket")} />
              </Field>
            </div>
          )}
          {store === "cloudinary" && (
            <Field label="Cloud name">
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
              : undefined
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
