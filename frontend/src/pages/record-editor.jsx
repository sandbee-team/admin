import { useState } from "react";
import {
  ArrowLeft,
  Save,
  KeyRound,
  ShieldCheck,
  CheckCircle2,
} from "lucide-react";
import { definitions } from "./records-config";
import { RecordFields } from "./record-fields";
import { useResource } from "../hooks/use-resource";
import {
  Resource,
  PageTitle,
  Badge,
  Field,
  Button,
  ErrorBox,
  Notice,
  Modal,
} from "../components/ui";
import { Link, navigate } from "../lib/router";
import { api, dateTime } from "../lib/api";
import { can } from "../../../shared/policy";
import { checksFor, providersFor } from "../../../shared/product-models";
export function RecordEditor({ kind, id, user, onSaved }) {
  const resource = useResource(id === "new" ? null : `/${kind}/${id}`);
  return (
    <Resource resource={resource}>
      {(data) => (
        <Editor
          key={`${kind}-${id}-${data?.revision || 0}`}
          kind={kind}
          initial={data}
          user={user}
          reload={resource.reload}
          onSaved={onSaved}
        />
      )}
    </Resource>
  );
}
function Editor({ kind, initial, user, reload, onSaved }) {
  const def = definitions[kind],
    [value, setValue] = useState(() =>
      Object.fromEntries(
        Object.keys(def.defaults).map((key) => [
          key,
          initial?.[key] ??
            (key === "requiredProviders"
              ? providersFor(initial)
              : key === "productId" && kind === "installations"
                ? new URLSearchParams(location.search).get("productId") || ""
                : def.defaults[key]),
        ]),
      ),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [credentialOpen, setCredentialOpen] = useState(false);
  const writable = can(user.role, def.permission),
    set = (name, next) => {
      setValue((old) => ({ ...old, [name]: next }));
      setSaved(false);
    };
  const productResource = useResource(
    kind === "installations" && value.productId
      ? `/products/${value.productId}`
      : null,
  );
  const product = productResource.data;
  const checks = product ? checksFor(product) : [];
  const completed = checks.filter((check) =>
    value.checks?.includes(check.id),
  ).length;
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api(`/${kind}${initial ? `/${initial._id}` : ""}`, {
        method: initial ? "PUT" : "POST",
        body: { ...value, ...(initial ? { revision: initial.revision } : {}) },
      });
      if (!initial) navigate(`/${kind}/${result._id}`);
      else {
        setSaved(true);
        reload();
        onSaved?.();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link href={`/${kind}`} className="back-link">
        <ArrowLeft size={15} />
        {def.title}
      </Link>
      <PageTitle
        eyebrow={initial ? `RECORD · ${initial._id.slice(0, 8)}` : "NEW RECORD"}
        title={initial?.name || initial?.title || `Add ${def.singular}`}
        description={
          initial
            ? `Last updated ${dateTime(initial.updatedAt)} · Revision ${initial.revision}`
            : "Create a clear starting point for your team."
        }
        action={initial && <Badge value={initial.status} />}
      />
      <div className="detail-layout">
        <form className="panel edit-form" onSubmit={save}>
          {error && <ErrorBox>{error}</ErrorBox>}
          {productResource.error && (
            <ErrorBox retry={productResource.reload}>
              {productResource.error}
            </ErrorBox>
          )}
          {saved && <Notice>Changes saved.</Notice>}
          <fieldset disabled={!writable || busy}>
            <RecordFields
              kind={kind}
              value={value}
              set={set}
              existing={initial}
              product={product}
            />
          </fieldset>
          <div className="form-actions">
            <Link href={`/${kind}`} className="button secondary">
              Back to {def.title.toLowerCase()}
            </Link>
            {writable && (
              <Button
                type="submit"
                busy={busy}
                disabled={
                  kind === "installations" &&
                  (!product || productResource.loading)
                }
              >
                <Save size={16} />
                {initial ? "Save changes" : `Create ${def.singular}`}
              </Button>
            )}
          </div>
        </form>
        <aside className="detail-aside">
          {kind === "installations" ? (
            <div className="panel aside-card">
              <span className="aside-icon">
                <CheckCircle2 size={22} />
              </span>
              <h2>Ready for handover?</h2>
              <strong className="progress-number">
                {completed}
                <span> / {checks.length}</span>
              </strong>
              <div className="readiness-bar">
                <span
                  style={{
                    width: `${checks.length ? (completed / checks.length) * 100 : 0}%`,
                  }}
                />
              </div>
              <p>
                Readiness records keep ownership and recovery visible before a
                customer goes live.
              </p>
              <p className="small">
                Provider execution is connected separately for each product.
                This checklist records verified operational readiness.
              </p>
            </div>
          ) : (
            <div className="panel aside-card">
              <span className="aside-icon">
                <ShieldCheck size={22} />
              </span>
              <h2>
                {kind === "connections"
                  ? "Ownership stays clear."
                  : "A shared source of truth."}
              </h2>
              <p>
                {kind === "connections"
                  ? "Record the customer’s account and resource IDs. Your credential is encrypted and never returned to the browser."
                  : "Your changes are saved centrally in MongoDB and recorded in the audit trail."}
              </p>
              <p className="small">
                Concurrent edits are checked before saving, so another
                operator’s changes are not silently overwritten.
              </p>
            </div>
          )}
          {kind === "connections" && initial && (
            <div className="panel aside-card">
              <KeyRound size={21} />
              <h2>Credential</h2>
              <Badge value={initial.hasCredential ? "active" : "planned"}>
                {initial.hasCredential
                  ? "Encrypted credential stored"
                  : "No credential stored"}
              </Badge>
              <p>
                Save or replace the token without exposing the previous value.
                Never paste it into notes.
              </p>
              {writable && (
                <Button
                  variant="secondary"
                  onClick={() => setCredentialOpen(true)}
                >
                  {initial.hasCredential
                    ? "Manage credential"
                    : "Store credential"}
                </Button>
              )}
            </div>
          )}
          {kind === "customers" && initial && (
            <CustomerInstallations customerId={initial._id} />
          )}
        </aside>
      </div>
      {credentialOpen && (
        <CredentialModal
          connection={initial}
          onClose={() => setCredentialOpen(false)}
          onSaved={() => {
            setCredentialOpen(false);
            reload();
          }}
        />
      )}
    </>
  );
}
function CustomerInstallations({ customerId }) {
  const resource = useResource(`/installations?customerId=${customerId}`);
  return (
    <section className="panel aside-card">
      <h2>Product installations</h2>
      <Resource resource={resource}>
        {(data) =>
          data.rows.length ? (
            <ul className="related-list">
              {data.rows.map((row) => (
                <li key={row._id}>
                  <Link href={`/installations/${row._id}`}>
                    {row.name}
                    <Badge value={row.status} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p>No installations linked yet. Create one from Installations.</p>
          )
        }
      </Resource>
    </section>
  );
}
function CredentialModal({ connection, onClose, onSaved }) {
  const [credential, setCredential] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmRemove, setConfirmRemove] = useState(false);
  async function submit(remove) {
    setBusy(true);
    setError("");
    try {
      await api(`/connections/${connection._id}/credential`, {
        method: remove ? "DELETE" : "PUT",
        body: {
          revision: connection.revision,
          ...(!remove ? { credential } : {}),
        },
      });
      setCredential("");
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Encrypted credential" onClose={onClose}>
      <p className="subtle">
        {connection.name} · A replacement is encrypted before it is stored.
        Saving does not verify the token with its provider.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(false);
        }}
      >
        {error && <ErrorBox>{error}</ErrorBox>}
        <Field label="New credential">
          <input
            autoComplete="off"
            type="password"
            minLength={8}
            maxLength={16000}
            required
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
          />
        </Field>
        <Button type="submit" busy={busy}>
          Save encrypted credential
        </Button>
      </form>
      {connection.hasCredential && (
        <div className="danger-zone">
          <p>
            Removing this stored copy does not revoke the token at its provider.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmRemove}
              onChange={(event) => setConfirmRemove(event.target.checked)}
            />
            I want to remove the stored credential
          </label>
          <Button
            variant="danger"
            busy={busy}
            disabled={!confirmRemove}
            onClick={() => submit(true)}
          >
            Remove credential
          </Button>
        </div>
      )}
    </Modal>
  );
}
