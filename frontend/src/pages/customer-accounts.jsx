import { useState } from "react";
import { KeyRound, Pencil, Plus } from "lucide-react";
import { useResource } from "../hooks/use-resource";
import {
  PageTitle,
  Resource,
  Badge,
  Button,
  Empty,
  ErrorBox,
  Field,
  Modal,
  Select,
  SecretInput,
} from "../components/ui";
import { RevealValue } from "../components/reveal";
import { withStepUp } from "../components/step-up";
import { api } from "../lib/api";
import { can } from "../../../shared/policy";
// Mirrors ACCOUNT_SERVICES in shared/schemas.js (the API enforces it).
const SERVICES = [
  { value: "gmail", label: "Gmail" },
  { value: "vercel", label: "Vercel" },
  { value: "atlas", label: "MongoDB Atlas" },
  { value: "cloudflare", label: "Cloudflare" },
  { value: "godaddy", label: "GoDaddy" },
  { value: "r2", label: "Cloudflare R2" },
  { value: "cloudinary", label: "Cloudinary" },
  { value: "other", label: "Other" },
];
const MAX_ACCOUNTS = 50;
const serviceName = (value) =>
  SERVICES.find((item) => item.value === value)?.label || value;
const FIELDS = {
  password: { name: "Password", noun: "password" },
  totpKey: { name: "Authenticator key", noun: "authenticator key" },
  backupCodes: { name: "Backup codes", noun: "backup codes" },
};
const STALE =
  "This account was changed by someone else. It was reloaded: review it and try again.";
const codeLines = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
export function AccountsSection({ customerId, user }) {
  const allowed = can(user.role, "credentials"),
    resource = useResource(
      allowed ? `/customers/${customerId}/accounts` : null,
    ),
    [notice, setNotice] = useState("");
  return (
    <>
      <PageTitle
        eyebrow="CUSTOMER VAULT"
        title="Accounts"
        description="Third-party logins for this customer. Secrets are encrypted and shown only on request."
      />
      {!allowed ? (
        <div className="panel">
          <Empty icon={KeyRound} title="Accounts are restricted">
            Your role cannot open the account vault. Ask an owner or admin.
          </Empty>
        </div>
      ) : (
        <>
          {notice && <ErrorBox>{notice}</ErrorBox>}
          <Resource resource={resource}>
            {(data) => (
              <AccountList
                customerId={customerId}
                initial={data.rows}
                user={user}
                onStale={() => {
                  setNotice(STALE);
                  resource.reload();
                }}
                onFresh={() => setNotice("")}
              />
            )}
          </Resource>
        </>
      )}
    </>
  );
}
function AccountList({ customerId, initial, user, onStale, onFresh }) {
  const [rows, setRows] = useState(initial),
    [modal, setModal] = useState(null),
    // Bumped when a secret is replaced or removed so open reveals are dropped.
    [epoch, setEpoch] = useState({});
  const base = `/customers/${customerId}/accounts`,
    current = (id) => rows.find((row) => row.id === id);
  const put = (view) =>
    setRows((list) => list.map((row) => (row.id === view.id ? view : row)));
  const secretChanged = (view) => {
    put(view);
    setEpoch((old) => ({ ...old, [view.id]: (old[view.id] || 0) + 1 }));
  };
  return (
    <>
      <div className="account-toolbar">
        <p className="small subtle">
          {rows.length} of {MAX_ACCOUNTS} accounts
        </p>
        <Button
          disabled={rows.length >= MAX_ACCOUNTS}
          onClick={() => setModal({ type: "create" })}
        >
          <Plus size={16} />
          Add account
        </Button>
      </div>
      {rows.length ? (
        <div className="account-grid">
          {rows.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              base={base}
              user={user}
              epoch={epoch[account.id] || 0}
              onEdit={() => setModal({ type: "edit", id: account.id })}
              onSet={(field) =>
                setModal({ type: "secret", id: account.id, field })
              }
              onChanged={put}
              onStale={onStale}
            />
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty icon={KeyRound} title="No accounts recorded">
            Add the customer’s Gmail, Vercel, MongoDB Atlas and other logins
            here instead of in notes.
          </Empty>
        </div>
      )}
      {modal?.type === "create" && (
        <AccountModal
          base={base}
          onClose={() => setModal(null)}
          onSaved={(view) => {
            setRows((list) => [...list, view]);
            setModal(null);
            onFresh();
          }}
        />
      )}
      {modal?.type === "edit" && current(modal.id) && (
        <AccountModal
          base={base}
          account={current(modal.id)}
          user={user}
          onClose={() => setModal(null)}
          onSaved={(view, secret) => {
            if (secret) secretChanged(view);
            else put(view);
            onFresh();
            if (!secret) setModal(null);
          }}
          onDeleted={(id) => {
            setRows((list) => list.filter((row) => row.id !== id));
            setModal(null);
            onFresh();
          }}
          onStale={() => {
            setModal(null);
            onStale();
          }}
        />
      )}
      {modal?.type === "secret" && current(modal.id) && (
        <SecretModal
          base={base}
          account={current(modal.id)}
          field={modal.field}
          onClose={() => setModal(null)}
          onSaved={(view) => {
            secretChanged(view);
            setModal(null);
            onFresh();
          }}
          onStale={() => {
            setModal(null);
            onStale();
          }}
        />
      )}
    </>
  );
}
function AccountCard({
  account,
  base,
  user,
  epoch,
  onEdit,
  onSet,
  onChanged,
  onStale,
}) {
  const [error, setError] = useState(""),
    // One "Mark used" at a time: each call moves the entry's rev.
    [marking, setMarking] = useState(false);
  const canWrite = can(user.role, "credentials"),
    canReveal = can(user.role, "secrets"),
    path = `${base}/${account.id}`;
  const stepped = (request) => withStepUp(request);
  async function markUsed(index, tools) {
    if (marking) return;
    setMarking(true);
    setError("");
    try {
      const view = await api(`${path}/backup-codes/used`, {
        method: "POST",
        body: { rev: account.rev, index },
      });
      onChanged(view);
      tools.update((payload) => ({
        ...payload,
        codes: payload.codes.map((item) =>
          item.index === index ? { ...item, used: true } : item,
        ),
      }));
    } catch (e) {
      if (e.code === "stale") onStale();
      else setError(e.message);
    } finally {
      setMarking(false);
    }
  }
  const rows = [
    ["password", account.hasPassword],
    ["totpKey", account.hasTotp],
    ["backupCodes", account.codesTotal > 0],
  ];
  return (
    <article
      className="panel account-card"
      aria-labelledby={`account-${account.id}`}
    >
      <header className="account-head">
        <div>
          <h2 id={`account-${account.id}`}>{account.label}</h2>
          <p className="small subtle">
            {serviceName(account.service)} ·{" "}
            {account.login || "No login recorded"}
          </p>
        </div>
        {canWrite && (
          <Button
            variant="secondary"
            aria-label={`Edit ${account.label}`}
            onClick={onEdit}
          >
            <Pencil size={14} />
            Edit
          </Button>
        )}
      </header>
      {error && <ErrorBox>{error}</ErrorBox>}
      <ul className="secret-rows">
        {rows.map(([field, isSet]) => (
          <li className="secret-row" key={field}>
            <div className="secret-line">
              <span className="secret-name">{FIELDS[field].name}</span>
              <Badge value={isSet ? "active" : "paused"}>
                {isSet
                  ? field === "backupCodes"
                    ? `${account.codesLeft} of ${account.codesTotal} left`
                    : "Set"
                  : "Not set"}
              </Badge>
              <div className="secret-actions">
                {canWrite && (
                  <Button
                    variant="secondary"
                    aria-label={`${isSet ? "Replace" : "Set"} ${FIELDS[field].noun} for ${account.label}`}
                    onClick={() => onSet(field)}
                  >
                    {isSet ? "Replace" : "Set"}
                  </Button>
                )}
                {canReveal && isSet && (
                  <RevealValue
                    key={`${field}-${epoch}`}
                    label={`${FIELDS[field].noun} for ${account.label}`}
                    load={() =>
                      stepped(() =>
                        api(`${path}/reveal`, {
                          method: "POST",
                          body: { field },
                        }),
                      )
                    }
                    copyText={(payload) =>
                      payload.codes
                        ? payload.codes
                            .filter((item) => !item.used)
                            .map((item) => item.code)
                            .join("\n")
                        : payload.value
                    }
                    view={(payload, tools) =>
                      payload.codes ? (
                        <ol className="backup-codes" aria-label="Backup codes">
                          {payload.codes.map((item) => (
                            <li
                              key={item.index}
                              className={item.used ? "is-used" : ""}
                            >
                              <code className="secret-value">{item.code}</code>
                              {item.used ? (
                                <Badge value="retired">Used</Badge>
                              ) : (
                                <Button
                                  variant="secondary"
                                  disabled={marking}
                                  aria-label={`Mark backup code ${item.index + 1} used`}
                                  onClick={() => markUsed(item.index, tools)}
                                >
                                  Mark used
                                </Button>
                              )}
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <code className="secret-value">{payload.value}</code>
                      )
                    }
                  />
                )}
                {canReveal && field === "totpKey" && isSet && (
                  <RevealValue
                    key={`code-${epoch}`}
                    buttonLabel="Show code"
                    buttonName={`Show code for ${account.label}`}
                    countdown="Expires in"
                    label={`authenticator code for ${account.label}`}
                    load={() =>
                      stepped(() =>
                        api(`${path}/code`, { method: "POST", body: {} }),
                      )
                    }
                    ttl={(payload) => payload.expiresIn}
                    copyText={(payload) => payload.code}
                    view={(payload) => (
                      <code className="secret-value">{payload.code}</code>
                    )}
                  />
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {(account.recoveryContact || account.notes) && (
        <dl className="permission-list">
          {account.recoveryContact && (
            <>
              <dt>Recovery contact</dt>
              <dd>{account.recoveryContact}</dd>
            </>
          )}
          {account.notes && (
            <>
              <dt>Notes</dt>
              <dd>{account.notes}</dd>
            </>
          )}
        </dl>
      )}
    </article>
  );
}
function AccountModal({
  base,
  account,
  user,
  onClose,
  onSaved,
  onDeleted,
  onStale,
}) {
  const editing = Boolean(account),
    [value, setValue] = useState({
      service: account?.service || "gmail",
      label: account?.label || "",
      login: account?.login || "",
      recoveryContact: account?.recoveryContact || "",
      notes: account?.notes || "",
      password: "",
      totpKey: "",
      backupCodes: "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [sure, setSure] = useState(false);
  const set = (name, next) => setValue((old) => ({ ...old, [name]: next })),
    text = (name) => ({
      value: value[name],
      onChange: (event) => set(name, event.target.value),
    });
  async function run(action, secret = false) {
    setBusy(true);
    setError("");
    try {
      const result = await action();
      onSaved(result, secret);
    } catch (e) {
      if (e.code === "stale" && onStale) onStale();
      else if (!e.cancelled) setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function submit(event) {
    event.preventDefault();
    const details = {
      service: value.service,
      label: value.label,
      login: value.login,
      recoveryContact: value.recoveryContact,
      notes: value.notes,
    };
    if (editing)
      return run(() =>
        api(`${base}/${account.id}`, {
          method: "PUT",
          body: { ...details, rev: account.rev },
        }),
      );
    const lines = codeLines(value.backupCodes);
    if (lines.length > 30) return setError("Use at most 30 backup codes.");
    run(() =>
      api(base, {
        method: "POST",
        body: {
          ...details,
          ...(value.password ? { password: value.password } : {}),
          ...(value.totpKey ? { totpKey: value.totpKey.trim() } : {}),
          ...(lines.length ? { backupCodes: lines } : {}),
        },
      }),
    );
  }
  const removeSecret = (field) =>
    run(
      () =>
        withStepUp(() =>
          api(`${base}/${account.id}/secret`, {
            method: "DELETE",
            body: { rev: account.rev, field },
          }),
        ),
      true,
    );
  async function deleteAccount() {
    setBusy(true);
    setError("");
    try {
      await withStepUp(() =>
        api(`${base}/${account.id}`, {
          method: "DELETE",
          body: { rev: account.rev },
        }),
      );
      onDeleted(account.id);
    } catch (e) {
      if (e.code === "stale") onStale();
      else if (!e.cancelled) setError(e.message);
      setBusy(false);
    }
  }
  const stored = editing
    ? [
        ["password", account.hasPassword],
        ["totpKey", account.hasTotp],
        ["backupCodes", account.codesTotal > 0],
      ].filter(([, isSet]) => isSet)
    : [];
  return (
    <Modal title={editing ? "Edit account" : "Add account"} onClose={onClose}>
      <form onSubmit={submit}>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Field label="Service">
          <Select
            value={value.service}
            onChange={(event) => set("service", event.target.value)}
            options={SERVICES}
          />
        </Field>
        <Field label="Label" hint="A name you will recognise, e.g. Shop Gmail.">
          <input required maxLength={80} {...text("label")} />
        </Field>
        <Field label="Login">
          <input maxLength={254} autoComplete="off" {...text("login")} />
        </Field>
        <Field label="Recovery contact">
          <input
            maxLength={254}
            autoComplete="off"
            {...text("recoveryContact")}
          />
        </Field>
        <Field
          label="Notes"
          hint="Keep passwords and keys in the secret fields, not here."
        >
          <textarea rows={3} maxLength={1000} {...text("notes")} />
        </Field>
        {!editing && (
          <>
            <Field label="Password (optional)">
              <SecretInput maxLength={1024} {...text("password")} />
            </Field>
            <Field
              label="Authenticator key (optional)"
              hint="The text key or an otpauth:// link."
            >
              <SecretInput maxLength={512} {...text("totpKey")} />
            </Field>
            <Field
              label="Backup codes (optional)"
              hint="One code per line, up to 30."
            >
              <textarea
                rows={3}
                autoComplete="off"
                spellCheck={false}
                {...text("backupCodes")}
              />
            </Field>
          </>
        )}
        <Button type="submit" busy={busy}>
          {editing ? "Save changes" : "Create account"}
        </Button>
      </form>
      {editing && can(user.role, "secrets") && (
        <div className="danger-zone">
          <h3>Danger zone</h3>
          <p>
            Removing a stored secret does not change it at the provider. Each
            action needs your authenticator.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={sure}
              onChange={(event) => setSure(event.target.checked)}
            />
            I understand this cannot be undone
          </label>
          <div className="account-actions">
            {stored.map(([field]) => (
              <Button
                key={field}
                variant="danger"
                busy={busy}
                disabled={!sure}
                onClick={() => removeSecret(field)}
              >
                Remove {FIELDS[field].noun}
              </Button>
            ))}
            <Button
              variant="danger"
              busy={busy}
              disabled={!sure}
              onClick={deleteAccount}
            >
              Delete account
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
function SecretModal({ base, account, field, onClose, onSaved, onStale }) {
  const meta = FIELDS[field],
    isSet = {
      password: account.hasPassword,
      totpKey: account.hasTotp,
      backupCodes: account.codesTotal > 0,
    }[field],
    [value, setValue] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    let sent = value;
    if (field === "backupCodes") {
      sent = codeLines(value);
      if (!sent.length) return setError("Add at least one backup code.");
      if (sent.length > 30) return setError("Use at most 30 backup codes.");
    } else if (field === "totpKey") sent = value.trim();
    setBusy(true);
    setError("");
    try {
      const view = await api(`${base}/${account.id}/secret`, {
        method: "PUT",
        body: { rev: account.rev, field, value: sent },
      });
      setValue("");
      onSaved(view);
    } catch (e) {
      if (e.code === "stale") onStale();
      else setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${isSet ? "Replace" : "Set"} ${meta.noun}`}
      onClose={onClose}
    >
      <p className="subtle">
        {account.label} · It is encrypted before it is stored and cannot be read
        back without your authenticator.
      </p>
      <form onSubmit={submit}>
        {error && <ErrorBox>{error}</ErrorBox>}
        {field === "backupCodes" ? (
          <Field
            label="Backup codes"
            hint="One code per line. Replacing resets which codes are used."
          >
            <textarea
              rows={6}
              required
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
        ) : (
          <Field
            label={field === "password" ? "New password" : "Authenticator key"}
            hint={
              field === "totpKey"
                ? "Paste the text key or an otpauth:// link."
                : undefined
            }
          >
            <SecretInput
              required
              maxLength={field === "password" ? 1024 : 512}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
        )}
        <Button type="submit" busy={busy}>
          Save encrypted {meta.noun}
        </Button>
      </form>
    </Modal>
  );
}
