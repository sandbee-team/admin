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
import {
  GstTextWarning,
  ReadinessNotice,
  STATE_OPTIONS,
} from "../components/sales";
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
  design: s.design,
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
        description="GST registration, company profile, payment details, numbering and the texts printed on quotations, agreements and invoices."
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
    b = form.bank,
    registered = form.gst.registered === true;
  const addressField = (
    <Field
      label="Address"
      hint={registered ? "Required. Up to four lines." : "Up to four lines."}
    >
      <textarea
        rows={3}
        value={c.address.join("\n")}
        aria-required={registered ? "true" : undefined}
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
  );
  const stateField = (
    <Field
      label="State"
      hint={
        registered
          ? "Required. Decides CGST + SGST (same state) or IGST (other states)."
          : undefined
      }
    >
      <Select
        value={c.stateCode}
        onChange={set("company", "stateCode")}
        options={STATE_OPTIONS}
        disabled={!canEdit}
      />
    </Field>
  );
  const gstinField = (
    <Field
      label="GSTIN"
      hint={
        registered
          ? "Required for tax invoices."
          : "Not printed while you are not registered under GST. Clear it if it is not yours."
      }
    >
      <input
        value={c.gstin}
        onChange={(e) =>
          set(
            "company",
            "gstin",
          )({ target: { value: e.target.value.toUpperCase() } })
        }
        maxLength={15}
        aria-required={registered ? "true" : undefined}
      />
    </Field>
  );
  return (
    <>
      <ReadinessNotice
        ready={data.ready}
        intro="Missing before documents can be issued. "
        link={false}
      />
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
            <h2>GST registration</h2>
            <label className="check-row">
              <input
                type="checkbox"
                role="switch"
                checked={form.gst.registered}
                onChange={set("gst", "registered")}
                aria-describedby="sales-registered-hint"
              />
              Registered under GST
            </label>
            <p id="sales-registered-hint" className="form-note">
              Off: documents carry no GST and no GSTIN, and the invoice is
              titled 'Invoice'. Turn it on only after you get a GSTIN.
            </p>
          </section>
          <section className="form-section">
            <h2>Company</h2>
            <div className="form-grid">
              <Field label="Legal name" hint="Required.">
                <input
                  value={c.legalName}
                  onChange={set("company", "legalName")}
                  maxLength={160}
                  aria-required="true"
                />
              </Field>
              <Field label="Trade name">
                <input
                  value={c.tradeName}
                  onChange={set("company", "tradeName")}
                  maxLength={160}
                />
              </Field>
              <Field
                label="Company e-mail"
                hint="Required. Replies to e-mailed documents go here."
              >
                <input
                  type="email"
                  value={c.email}
                  onChange={set("company", "email")}
                  maxLength={254}
                  aria-required="true"
                />
              </Field>
              <Field label="Phone" hint="Required.">
                <input
                  value={c.phone}
                  onChange={set("company", "phone")}
                  maxLength={32}
                  aria-required="true"
                />
              </Field>
              <Field
                label="Jurisdiction city"
                hint="Required for agreements. Courts and arbitration seat named in the agreement, for example Ahmedabad."
              >
                <input
                  value={c.jurisdiction}
                  onChange={set("company", "jurisdiction")}
                  maxLength={60}
                />
              </Field>
              {registered && (
                <>
                  {addressField}
                  {stateField}
                  {gstinField}
                </>
              )}
            </div>
            <h3 className="sales-subheading">
              {registered ? "Optional" : "Optional - printed only when filled"}
            </h3>
            <div className="form-grid">
              {!registered && (
                <>
                  {addressField}
                  {stateField}
                  {/* A GSTIN already on file stays visible (and clearable). */}
                  {data.company.gstin && gstinField}
                </>
              )}
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
              Optional: printed on invoices and quotations only when filled.
              Issued documents keep the details they were issued with.
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
            <h2>{registered ? "Numbering and GST" : "Numbering"}</h2>
            <p className="form-note">
              Numbers restart every 1 April and never skip. An invoice number
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
              {registered && (
                <>
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
                </>
              )}
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
            {registered && (
              <p className="form-note">
                E-invoicing (IRN and QR code) is not supported; it is required
                only above Rs. 5 crore aggregate turnover.
              </p>
            )}
          </section>
          <section className="form-section">
            <h2>Document design</h2>
            <div className="form-grid">
              <Field
                label="Document accent colour"
                hint="Headings and rules on the PDFs. Default #355E45."
              >
                <input
                  value={form.design.accent}
                  onChange={(e) =>
                    set(
                      "design",
                      "accent",
                    )({ target: { value: e.target.value.toUpperCase() } })
                  }
                  maxLength={7}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <div className="field">
                <label htmlFor="sales-accent-picker">Pick a colour</label>
                <input
                  id="sales-accent-picker"
                  type="color"
                  className="sales-colour"
                  value={
                    /^#[0-9A-Fa-f]{6}$/.test(form.design.accent)
                      ? form.design.accent.toLowerCase()
                      : "#355e45"
                  }
                  onChange={(e) =>
                    set(
                      "design",
                      "accent",
                    )({ target: { value: e.target.value.toUpperCase() } })
                  }
                />
              </div>
            </div>
          </section>
          <section className="form-section">
            <h2>Default texts</h2>
            <p className="form-note">
              Used for every client without a custom text of its own.
              Placeholders: {PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}.
            </p>
            {TEXTS.map(([key, label, max]) => (
              <div key={key} className="sales-text-field">
                <Field label={label}>
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
                {canEdit && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={form.templates[key] === data.defaults[key]}
                    aria-label={`Restore default text: ${label}`}
                    onClick={() => {
                      setForm({
                        ...form,
                        templates: {
                          ...form.templates,
                          [key]: data.defaults[key],
                        },
                      });
                      setDirty(true);
                    }}
                  >
                    Restore default text
                  </Button>
                )}
                <GstTextWarning
                  registered={registered}
                  text={form.templates[key]}
                />
              </div>
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
