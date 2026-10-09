import { useEffect, useRef, useState } from "react";
import {
  PageTitle,
  Field,
  Button,
  ErrorBox,
  Notice,
  Picker,
} from "../components/ui";
import { Select } from "../components/select";
import { Link } from "../lib/router";
import { api } from "../lib/api";

const MAX_BYTES = 120 * 1024;
const PROFILE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_LABELS = {
  "vercel.token": "Vercel token",
  "mongo.uri": "MongoDB connection string",
  "cloudflare.token": "Cloudflare token",
  "image.keys": "Image store keys",
  "generated.authSecret": "Cafe auth secret",
  "generated.healthStatsToken": "Health stats token",
  "generated.realtimePublishSecret": "Realtime publish secret",
  "posAdmin.password": "POS admin password",
};
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
// Reads a local file as JSON; the message never repeats file content.
async function readJson(file, what) {
  if (file.size > MAX_BYTES)
    throw new Error(
      `The ${what} is larger than 120 KB. Check you picked the right file.`,
    );
  let value;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error(`The ${what} is not valid JSON.`);
  }
  if (!isObject(value)) throw new Error(`The ${what} must be a JSON object.`);
  return value;
}
const SECRETISH = /token|secret|password|key|uri|auth|backup|totp|notes/i;
const show = (value) => (value === "" || value == null ? "—" : String(value));

export function PosImport() {
  const [client, setClient] = useState(null),
    [profiles, setProfiles] = useState(null),
    [profileName, setProfileName] = useState(""),
    [preview, setPreview] = useState(null),
    [mode, setMode] = useState("new"),
    [fields, setFields] = useState({
      name: "",
      email: "",
      company: "",
      phone: "",
    }),
    [customerId, setCustomerId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(null),
    [formKey, setFormKey] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    // File contents never outlive the page: cleared on pagehide and unmount.
    const wipe = () => {
      clearAll();
      setDone(null);
    };
    window.addEventListener("pagehide", wipe);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", wipe);
      clearAll();
    };
  }, []);
  const profileEntry =
    profiles && profileName && isObject(profiles[profileName])
      ? { name: profileName, entry: profiles[profileName] }
      : null;
  function clearAll() {
    setClient(null);
    setProfiles(null);
    setProfileName("");
    setPreview(null);
    setCustomerId("");
    setFields({ name: "", email: "", company: "", phone: "" });
    setMode("new");
    setError("");
    setFormKey((k) => k + 1);
  }
  async function pickClient(event) {
    const file = event.target.files?.[0];
    setPreview(null);
    setError("");
    setClient(null);
    if (!file) return;
    try {
      setClient(await readJson(file, "client file"));
    } catch (e) {
      setError(e.message);
    }
  }
  async function pickProfiles(event) {
    const file = event.target.files?.[0];
    setPreview(null);
    setError("");
    setProfiles(null);
    setProfileName("");
    if (!file) return;
    try {
      setProfiles(await readJson(file, "profiles file"));
    } catch (e) {
      setError(e.message);
    }
  }
  async function runPreview() {
    setBusy(true);
    setError("");
    try {
      const result = await api("/pos/import/preview", {
        method: "POST",
        body: { client, profile: profileEntry },
      });
      if (!mounted.current) return;
      setPreview(result);
      setFields({
        name: result.defaults.name,
        email: "",
        company: result.defaults.company,
        phone: result.defaults.phone,
      });
      setMode("new");
      setCustomerId("");
    } catch (e) {
      if (mounted.current) {
        setPreview(null);
        setError(e.message);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const result = await api("/pos/import/confirm", {
        method: "POST",
        body: {
          client,
          profile: profileEntry,
          digest: preview.digest,
          customer:
            mode === "new"
              ? { mode, ...fields }
              : { mode: "existing", customerId },
        },
      });
      if (!mounted.current) return;
      clearAll();
      setDone(result);
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const profileNames = profiles
    ? Object.keys(profiles).filter(
        (name) => PROFILE_NAME.test(name) && isObject(profiles[name]),
      )
    : [];
  const canConfirm =
    preview &&
    !preview.existing &&
    (mode === "new"
      ? fields.name.trim().length >= 2 && /.+@.+\..+/.test(fields.email)
      : Boolean(customerId));
  return (
    <>
      <PageTitle
        eyebrow="GOVERNANCE"
        title="POS import"
        description="Bring a go-live client file into the admin: customer, POS installation, encrypted secrets and account entries."
      />
      {done && (
        <Notice>
          Imported.{" "}
          <Link href={`/customers/${done.customerId}`}>
            Open the customer workspace
          </Link>
          {" · "}
          <Link href={`/installations/${done.installationId}/pos`}>
            Open the POS setup
          </Link>
        </Notice>
      )}
      <section className="panel form-section" aria-labelledby="import-files">
        <h2 id="import-files">1. Choose the files</h2>
        <p className="form-note">
          Files are read in this browser. Nothing is uploaded until you press
          Preview, and the preview shows no secret values. The server encrypts
          every secret when you confirm.
        </p>
        <div key={formKey} className="form-grid">
          <Field
            label="Go-live client file (JSON)"
            hint="The clients/<name>.json file for this cafe."
          >
            <input
              type="file"
              accept=".json,application/json"
              onChange={pickClient}
            />
          </Field>
          <Field
            label="Deploy profiles file (optional)"
            hint="deploy.profiles.json stays on this PC. Only the entry you pick below is sent."
          >
            <input
              type="file"
              accept=".json,application/json"
              onChange={pickProfiles}
            />
          </Field>
        </div>
        {profiles && (
          <Field label="Profile entry">
            <Select
              value={profileName}
              onChange={(event) => {
                setProfileName(event.target.value);
                setPreview(null);
              }}
              options={[
                { value: "", label: "Do not use a profile" },
                ...profileNames.map((name) => ({ value: name, label: name })),
              ]}
            />
          </Field>
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
        <div className="form-actions">
          <Button variant="secondary" type="button" onClick={clearAll}>
            Clear files
          </Button>
          <Button
            type="button"
            busy={busy}
            disabled={!client}
            onClick={runPreview}
          >
            Preview import
          </Button>
        </div>
      </section>
      {preview && <PreviewPanel preview={preview} />}
      {preview && !preview.existing && (
        <section
          className="panel form-section"
          aria-labelledby="import-customer"
        >
          <h2 id="import-customer">3. Customer</h2>
          <fieldset
            className="form-note"
            style={{ border: 0, padding: 0, margin: "0 0 14px" }}
          >
            <legend>Who owns this POS?</legend>
            <label className="check-row">
              <input
                type="radio"
                name="customer-mode"
                checked={mode === "new"}
                onChange={() => setMode("new")}
              />
              <span>Create a new customer</span>
            </label>
            <label className="check-row">
              <input
                type="radio"
                name="customer-mode"
                checked={mode === "existing"}
                onChange={() => setMode("existing")}
              />
              <span>Attach to an existing customer</span>
            </label>
          </fieldset>
          {mode === "new" ? (
            <div className="form-grid">
              {[
                ["name", "Name"],
                ["email", "Email (required)"],
                ["company", "Company"],
                ["phone", "Phone"],
              ].map(([key, title]) => (
                <Field key={key} label={title}>
                  <input
                    type={key === "email" ? "email" : "text"}
                    autoComplete="off"
                    value={fields[key]}
                    onChange={(event) =>
                      setFields({ ...fields, [key]: event.target.value })
                    }
                  />
                </Field>
              ))}
            </div>
          ) : (
            <>
              {preview.customerMatches.length > 0 && (
                <p className="form-note">
                  Possible matches:{" "}
                  {preview.customerMatches.map((match) => (
                    <Button
                      key={match.id}
                      type="button"
                      variant="secondary"
                      onClick={() => setCustomerId(match.id)}
                    >
                      {match.name}
                      {match.company ? ` · ${match.company}` : ""}
                    </Button>
                  ))}
                </p>
              )}
              <Picker
                kind="customers"
                label="Customer"
                value={customerId}
                onChange={setCustomerId}
                initialLabel={
                  preview.customerMatches.find((m) => m.id === customerId)?.name
                }
              />
            </>
          )}
          {error && <ErrorBox>{error}</ErrorBox>}
          <div className="form-actions">
            <Button variant="secondary" type="button" onClick={clearAll}>
              Cancel
            </Button>
            <Button
              type="button"
              busy={busy}
              disabled={!canConfirm}
              onClick={confirm}
            >
              Import and encrypt
            </Button>
          </div>
        </section>
      )}
    </>
  );
}

function PreviewPanel({ preview }) {
  const m = preview.mapping;
  const rows = [
    ["Client slug", m.slug],
    ["Subdomain", m.subdomain],
    ["Host", m.host],
    ["Tenant id", m.tenantId],
    ["Root domain", m.rootDomain],
    ["Installation", `${m.installationName} (planned, production)`],
    ["Endpoint", m.endpoint],
    ["Vercel project", m.vercel.projectName],
    ["Vercel project id", m.vercel.projectId],
    ["Vercel org id", m.vercel.orgId],
    ["Vercel team id", m.vercel.teamId],
    ["MongoDB", m.mongo.host ? `${m.mongo.host} / ${m.mongo.database}` : ""],
    [
      "Cloudflare",
      m.cloudflare
        ? `${m.cloudflare.workerName || "worker"} (${m.cloudflare.accountId || "account not set"})`
        : "Not used",
    ],
    ["Image store", m.image.store || "None"],
    ["POS admin username", m.posAdmin.username],
    [
      "Deploy lock",
      m.fileDeployLock === false
        ? "On (the file had it off; imported as locked)"
        : "On",
    ],
  ];
  return (
    <section className="panel form-section" aria-labelledby="import-preview">
      <h2 id="import-preview">2. Preview</h2>
      {preview.existing && (
        <ErrorBox>
          This client was already imported
          {preview.existing.customerName
            ? ` for ${preview.existing.customerName}`
            : ""}
          . Remove its POS setup first to import it again.{" "}
          <Link href={`/customers/${preview.existing.customerId}`}>
            Open the customer
          </Link>
        </ErrorBox>
      )}
      {preview.warnings.length > 0 && (
        <div className="notice notice-warning" role="status">
          <ul>
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <h3>Will be created</h3>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Values that will be imported</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, value]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>{show(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Secrets (encrypted on the server, never shown)</h3>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Secrets found in the file</caption>
          <thead>
            <tr>
              <th scope="col">Secret</th>
              <th scope="col">In the file</th>
            </tr>
          </thead>
          <tbody>
            {preview.secrets.map((secret) => (
              <tr key={secret.target}>
                <th scope="row">
                  {SECRET_LABELS[secret.target] || secret.target}
                </th>
                <td>{secret.present ? "Present" : "Missing"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Accounts to add</h3>
      {preview.accounts.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">
              Account entries that will be added
            </caption>
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Label</th>
                <th scope="col">Login</th>
                <th scope="col">Password</th>
              </tr>
            </thead>
            <tbody>
              {preview.accounts.map((account) => (
                <tr key={account.label}>
                  <td>{account.service}</td>
                  <td>{account.label}</td>
                  <td>{show(account.login)}</td>
                  <td>{account.hasPassword ? "Set" : "Not set"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="form-note">The file has no account logins.</p>
      )}
      <h3>Not imported</h3>
      <p className="form-note">
        These values were NOT imported. Copy anything you need by hand into an
        account entry. The notes field may contain passwords.
      </p>
      {preview.dropped.length ? (
        <ul className="step-list">
          {preview.dropped.map((path) => (
            <li key={path}>
              <code>{path}</code>
              {SECRETISH.test(path) && (
                <strong> (may hold a secret: copy it by hand if needed)</strong>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="form-note">Nothing is left out.</p>
      )}
    </section>
  );
}
