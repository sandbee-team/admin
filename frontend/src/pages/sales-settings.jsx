import { useRef, useState } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { useResource } from "../hooks/use-resource";
import {
  PageTitle,
  Resource,
  Button,
  ErrorBox,
  Field,
  Select,
} from "../components/ui";
import { STATE_OPTIONS } from "../components/sales";
import { withStepUp } from "../components/step-up";
import { api, upload, isStale, dateTime } from "../lib/api";
import { useNavigationGuard } from "../lib/router";
import { can } from "../../../shared/policy";
import {
  GST_RATES,
  PLACEHOLDERS,
  docNumber,
  formatPercent,
  fyOf,
} from "../../../shared/sales";

const MISSING = {
  "legal-name": "legal name",
  address: "address",
  state: "state",
  gstin: "GSTIN (needed for tax invoices)",
};
const TEXTS = [
  ["quotationTerms", "Quotation terms", 4000],
  ["agreementBody", "Agreement text", 20000],
  ["invoiceTerms", "Invoice terms", 4000],
];
const editable = (s) => ({
  company: s.company,
  bank: s.bank,
  signatory: s.signatory,
  numbering: s.numbering,
  gst: s.gst,
  quotation: s.quotation,
  invoice: s.invoice,
  templates: s.templates,
});

export function SalesSettings({ user }) {
  const resource = useResource("/sales/settings"),
    [stale, setStale] = useState(false);
  return (
    <>
      <PageTitle
        eyebrow="SALES"
        title="Sales settings"
        description="Company profile, payment details, numbering, GST and the texts printed on quotations, agreements and tax invoices."
      />
      <div role="status">
        {stale && (
          <div className="notice notice-warning">
            <span>
              The settings were changed elsewhere and have been reloaded; your
              unsaved edits were not kept.
            </span>
          </div>
        )}
      </div>
      <Resource resource={resource}>
        {(data) => (
          <SettingsForm
            key={data.rev}
            data={data}
            canEdit={can(user.role, "billing")}
            onSaved={() => resource.refresh().catch(() => {})}
            onStale={() => {
              setStale(true);
              resource.reload();
            }}
          />
        )}
      </Resource>
    </>
  );
}

function SettingsForm({ data, canEdit, onSaved, onStale }) {
  const [form, setForm] = useState(() => editable(data)),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useNavigationGuard(
    dirty ? "Sales settings have unsaved changes. Leave anyway?" : "",
  );
  const set = (section, key) => (event) => {
    const value =
      event.target.type === "checkbox"
        ? event.target.checked
        : event.target.value;
    setForm({ ...form, [section]: { ...form[section], [key]: value } });
    setDirty(true);
  };
  const fy = fyOf(new Date()).label;
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = {
        rev: data.rev,
        ...form,
        company: {
          ...form.company,
          address: form.company.address.map((l) => l.trim()).filter(Boolean),
        },
        gst: { ...form.gst, defaultRate: Number(form.gst.defaultRate) },
        quotation: { validityDays: Number(form.quotation.validityDays) },
        invoice: { dueDays: Number(form.invoice.dueDays) },
      };
      await withStepUp(() => api("/sales/settings", { method: "PUT", body }));
      setDirty(false);
      onSaved();
    } catch (e) {
      if (e.cancelled) return;
      if (isStale(e)) onStale();
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const c = form.company,
    b = form.bank;
  return (
    <>
      {!data.ready.invoice && (
        <div className="notice notice-warning">
          <span>
            Missing before documents can be issued:{" "}
            {data.ready.missing.map((m) => MISSING[m]).join(", ")}.
          </span>
        </div>
      )}
      {!canEdit && (
        <p className="small subtle sales-readonly">
          Only an owner can change these settings (with an authenticator
          confirmation).
        </p>
      )}
      <Images data={data} canEdit={canEdit} dirty={dirty} onSaved={onSaved} />
      <form
        className="panel edit-form"
        onSubmit={save}
        aria-label="Sales settings"
      >
        <fieldset disabled={!canEdit} className="sales-fieldset">
          <section className="form-section">
            <h2>Company</h2>
            <div className="form-grid">
              <Field label="Legal name">
                <input
                  value={c.legalName}
                  onChange={set("company", "legalName")}
                  maxLength={160}
                />
              </Field>
              <Field label="Trade name">
                <input
                  value={c.tradeName}
                  onChange={set("company", "tradeName")}
                  maxLength={160}
                />
              </Field>
              <Field label="Address" hint="Up to four lines.">
                <textarea
                  rows={3}
                  value={c.address.join("\n")}
                  onChange={(e) => {
                    setForm({
                      ...form,
                      company: {
                        ...c,
                        address: e.target.value.split("\n").slice(0, 4),
                      },
                    });
                    setDirty(true);
                  }}
                />
              </Field>
              <div>
                <Field label="City">
                  <input
                    value={c.city}
                    onChange={set("company", "city")}
                    maxLength={60}
                  />
                </Field>
                <Field label="PIN code">
                  <input
                    value={c.pincode}
                    onChange={set("company", "pincode")}
                    maxLength={6}
                    inputMode="numeric"
                  />
                </Field>
              </div>
              <Field
                label="State"
                hint="Decides CGST + SGST (same state) or IGST (other states)."
              >
                <Select
                  value={c.stateCode}
                  onChange={set("company", "stateCode")}
                  options={STATE_OPTIONS}
                  disabled={!canEdit}
                />
              </Field>
              <Field label="GSTIN">
                <input
                  value={c.gstin}
                  onChange={(e) =>
                    set(
                      "company",
                      "gstin",
                    )({ target: { value: e.target.value.toUpperCase() } })
                  }
                  maxLength={15}
                />
              </Field>
              <Field label="PAN">
                <input
                  value={c.pan}
                  onChange={(e) =>
                    set(
                      "company",
                      "pan",
                    )({ target: { value: e.target.value.toUpperCase() } })
                  }
                  maxLength={10}
                />
              </Field>
              <Field
                label="Company e-mail"
                hint="Replies to e-mailed documents go here."
              >
                <input
                  type="email"
                  value={c.email}
                  onChange={set("company", "email")}
                  maxLength={254}
                />
              </Field>
              <Field label="Phone">
                <input
                  value={c.phone}
                  onChange={set("company", "phone")}
                  maxLength={32}
                />
              </Field>
              <Field label="Website">
                <input
                  value={c.website}
                  onChange={set("company", "website")}
                  maxLength={120}
                />
              </Field>
            </div>
          </section>
          <section className="form-section">
            <h2>Payment details</h2>
            <p className="form-note">
              Printed on quotations and invoices. Issued documents keep the
              details they were issued with.
            </p>
            <div className="form-grid">
              <Field label="Account name">
                <input
                  value={b.accountName}
                  onChange={set("bank", "accountName")}
                  maxLength={160}
                />
              </Field>
              <Field label="Account number">
                <input
                  value={b.accountNumber}
                  onChange={set("bank", "accountNumber")}
                  maxLength={24}
                  autoComplete="off"
                />
              </Field>
              <Field label="IFSC">
                <input
                  value={b.ifsc}
                  onChange={(e) =>
                    set(
                      "bank",
                      "ifsc",
                    )({ target: { value: e.target.value.toUpperCase() } })
                  }
                  maxLength={11}
                />
              </Field>
              <Field label="Bank name">
                <input
                  value={b.bankName}
                  onChange={set("bank", "bankName")}
                  maxLength={120}
                />
              </Field>
              <Field label="Branch">
                <input
                  value={b.branch}
                  onChange={set("bank", "branch")}
                  maxLength={120}
                />
              </Field>
              <Field label="UPI ID">
                <input
                  value={b.upiId}
                  onChange={set("bank", "upiId")}
                  maxLength={300}
                />
              </Field>
              <Field label="Signatory name">
                <input
                  value={form.signatory.name}
                  onChange={set("signatory", "name")}
                  maxLength={120}
                />
              </Field>
              <Field label="Signatory title">
                <input
                  value={form.signatory.title}
                  onChange={set("signatory", "title")}
                  maxLength={120}
                />
              </Field>
            </div>
          </section>
          <section className="form-section">
            <h2>Numbering and GST</h2>
            <p className="form-note">
              Numbers restart every 1 April and never skip. A tax invoice number
              may have at most 16 characters (Rule 46): the invoice prefix can
              have up to 6.
            </p>
            <div className="form-grid">
              {[
                ["quotation", "Quotation prefix"],
                ["agreement", "Agreement prefix"],
                ["invoice", "Invoice prefix"],
              ].map(([type, label]) => (
                <Field
                  key={type}
                  label={label}
                  hint={`Next new number: ${docNumber(form.numbering[type].prefix, fy, Number(data.next[type].split("/").pop()))}`}
                >
                  <input
                    value={form.numbering[type].prefix}
                    onChange={(e) => {
                      setForm({
                        ...form,
                        numbering: {
                          ...form.numbering,
                          [type]: { prefix: e.target.value },
                        },
                      });
                      setDirty(true);
                    }}
                    maxLength={6}
                  />
                </Field>
              ))}
              <Field
                label="Default SAC"
                hint="998314 = IT design and development services."
              >
                <input
                  value={form.gst.defaultSac}
                  onChange={set("gst", "defaultSac")}
                  maxLength={8}
                  inputMode="numeric"
                />
              </Field>
              <Field label="Default GST rate">
                <Select
                  value={String(form.gst.defaultRate)}
                  onChange={set("gst", "defaultRate")}
                  options={GST_RATES.map((r) => ({
                    value: String(r),
                    label: formatPercent(r),
                  }))}
                  disabled={!canEdit}
                />
              </Field>
              <Field label="Quotation valid for (days)">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={form.quotation.validityDays}
                  onChange={set("quotation", "validityDays")}
                />
              </Field>
              <Field label="Invoice due after (days)">
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={form.invoice.dueDays}
                  onChange={set("invoice", "dueDays")}
                />
              </Field>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.gst.roundOff}
                onChange={set("gst", "roundOff")}
              />
              Round the total to the nearest rupee (printed as a separate "Round
              off" line)
            </label>
            <p className="form-note">
              E-invoicing (IRN and QR code) is not supported; it is required
              only above Rs. 5 crore aggregate turnover.
            </p>
          </section>
          <section className="form-section">
            <h2>Default texts</h2>
            <p className="form-note">
              Used for every client without a custom text of its own.
              Placeholders: {PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}.
            </p>
            {TEXTS.map(([key, label, max]) => (
              <Field key={key} label={label}>
                <textarea
                  rows={key === "agreementBody" ? 12 : 5}
                  value={form.templates[key]}
                  onChange={(e) => {
                    setForm({
                      ...form,
                      templates: { ...form.templates, [key]: e.target.value },
                    });
                    setDirty(true);
                  }}
                  maxLength={max}
                />
              </Field>
            ))}
          </section>
        </fieldset>
        {error && <ErrorBox>{error}</ErrorBox>}
        <div className="form-actions">
          <span className="small subtle">
            {dirty
              ? "Unsaved changes"
              : data.updatedAt
                ? `Saved ${dateTime(data.updatedAt)} by ${data.updatedBy}`
                : "Not saved yet"}
          </span>
          {canEdit && (
            <Button type="submit" busy={busy} disabled={!dirty}>
              Save settings
            </Button>
          )}
        </div>
      </form>
    </>
  );
}

function Images({ data, canEdit, dirty, onSaved }) {
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    inputs = { logo: useRef(), signature: useRef() };
  async function put(kind, file) {
    if (file.size > 512 * 1024) {
      setError("Images can be at most 512 KB.");
      if (inputs[kind].current) inputs[kind].current.value = "";
      return;
    }
    setBusy(kind);
    setError("");
    try {
      await withStepUp(() =>
        upload(`/sales/settings/images/${kind}`, file, {}, "PUT"),
      );
      onSaved();
    } catch (e) {
      if (!e.cancelled) setError(e.message);
    } finally {
      setBusy("");
      if (inputs[kind].current) inputs[kind].current.value = "";
    }
  }
  async function remove(kind) {
    setBusy(kind);
    setError("");
    try {
      await withStepUp(() =>
        api(`/sales/settings/images/${kind}`, { method: "DELETE", body: {} }),
      );
      onSaved();
    } catch (e) {
      if (!e.cancelled) setError(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="panel sales-images" aria-labelledby="sales-images">
      <div className="panel-title">
        <div>
          <h2 id="sales-images">Logo and signature</h2>
          <p>
            PNG (8-bit) or JPEG, at most 512 KB and 2000 × 2000 pixels. Printed
            on every new document.
          </p>
          {canEdit && dirty && (
            <p>Save or reload the settings below before changing an image.</p>
          )}
        </div>
      </div>
      <div className="sales-image-grid">
        {[
          ["logo", "Logo"],
          ["signature", "Signature"],
        ].map(([kind, label]) => {
          const meta = data.images[kind];
          return (
            <div key={kind} className="sales-image">
              <strong>{label}</strong>
              <span className="small subtle">
                {meta.set
                  ? `${meta.type.toUpperCase()}, ${meta.width} × ${meta.height}, ${Math.ceil(meta.size / 1024)} KB`
                  : "Not set"}
              </span>
              {canEdit && (
                <div className="account-actions">
                  <label className="button secondary">
                    <ImageUp size={14} />
                    {busy === kind
                      ? "Uploading…"
                      : meta.set
                        ? `Replace ${label.toLowerCase()}`
                        : `Upload ${label.toLowerCase()}`}
                    <input
                      ref={inputs[kind]}
                      type="file"
                      accept="image/png,image/jpeg"
                      className="sr-only"
                      disabled={!!busy || dirty}
                      onChange={(e) =>
                        e.target.files?.[0] && put(kind, e.target.files[0])
                      }
                    />
                  </label>
                  {meta.set && (
                    <Button
                      variant="secondary"
                      busy={busy === kind}
                      disabled={dirty}
                      onClick={() => remove(kind)}
                      aria-label={`Remove ${label.toLowerCase()}`}
                    >
                      <Trash2 size={14} />
                      Remove
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </section>
  );
}
