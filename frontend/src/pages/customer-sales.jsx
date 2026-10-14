import { useState } from "react";
import { Receipt, Plus } from "lucide-react";
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
  Notice,
} from "../components/ui";
import {
  BillToFields,
  DocumentTable,
  cleanBillTo,
  money,
} from "../components/sales";
import { api, dateTime, isStale } from "../lib/api";
import { withStepUp } from "../components/step-up";
import { Link, navigate, useNavigationGuard } from "../lib/router";
import { can } from "../../../shared/policy";
import { DealPage } from "./sales-deal";

const TEXTS = [
  ["quotationTerms", "Quotation terms"],
  ["agreementBody", "Agreement text"],
  ["invoiceTerms", "Invoice terms"],
];

export function SalesSection({ customerId, sub, user }) {
  if (!can(user.role, "sales"))
    return (
      <>
        <PageTitle eyebrow="CUSTOMER" title="Sales" />
        <div className="panel">
          <Empty icon={Receipt} title="Sales documents are restricted">
            Your role cannot open quotations, agreements or invoices. Ask an
            owner or admin.
          </Empty>
        </div>
      </>
    );
  if (sub)
    return (
      <DealPage key={sub} customerId={customerId} dealId={sub} user={user} />
    );
  return <SalesOverview customerId={customerId} user={user} />;
}

function SalesOverview({ customerId, user }) {
  const resource = useResource(`/customers/${customerId}/sales`),
    [creating, setCreating] = useState(false),
    [stale, setStale] = useState(false);
  return (
    <>
      <PageTitle
        eyebrow="CUSTOMER"
        title="Sales"
        description="Deals, quotations, agreements and tax invoices for this customer."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} />
            New deal
          </Button>
        }
      />
      <div role="status">
        {stale && (
          <div className="notice notice-warning">
            <span>
              The billing details were changed elsewhere and have been reloaded;
              your unsaved edits were not kept.
            </span>
          </div>
        )}
      </div>

      <Resource resource={resource}>
        {(data) => (
          <div className="sales-stack">
            {!data.ready.quotation && (
              <div className="notice notice-warning">
                <span>
                  The company profile is incomplete, so no document can be
                  issued yet.{" "}
                  <Link href="/sales-settings">Open Sales settings</Link>
                </span>
              </div>
            )}
            {data.limited && (
              <p className="small subtle">
                Showing the newest 200 deals and documents.
              </p>
            )}
            <section aria-labelledby="sales-deals">
              <h2 id="sales-deals" className="sales-heading">
                Deals
              </h2>
              {data.deals.length ? (
                <div className="panel table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Deal</th>
                        <th>Status</th>
                        <th>Lines</th>
                        <th>Total</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.deals.map((d) => (
                        <tr key={d.id}>
                          <td>
                            <Link
                              className="table-name"
                              href={`/customers/${customerId}/sales/${d.id}`}
                            >
                              {d.title}
                            </Link>
                          </td>
                          <td>
                            <Badge value={d.status} />
                          </td>
                          <td>{d.lines}</td>
                          <td>{money(d.payable)}</td>
                          <td className="small subtle">
                            {dateTime(d.updatedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="panel">
                  <Empty icon={Receipt} title="No deals yet">
                    Start a deal to prepare a quotation for this customer.
                  </Empty>
                </div>
              )}
            </section>
            <section aria-labelledby="sales-documents">
              <h2 id="sales-documents" className="sales-heading">
                Issued documents
              </h2>
              {data.documents.length ? (
                <DocumentTable
                  rows={data.documents}
                  user={user}
                  storage={data.storage}
                  caption="Issued documents"
                  defaultTo={data.profile.billTo.email || data.customer.email}
                  onChanged={() => resource.refresh().catch(() => {})}
                />
              ) : (
                <p className="small subtle">Nothing issued yet.</p>
              )}
            </section>
            <ProfileForm
              customerId={customerId}
              initial={data.profile}
              templates={data.templates}
              user={user}
              onStale={() => {
                setStale(true);
                resource.reload();
              }}
              onSaved={() => resource.refresh().catch(() => {})}
            />
          </div>
        )}
      </Resource>
      {creating && (
        <NewDealModal
          customerId={customerId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            resource.refresh().catch(() => {});
          }}
        />
      )}
    </>
  );
}

function NewDealModal({ customerId, onClose, onCreated }) {
  const [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const deal = await api(`/customers/${customerId}/sales/deals`, {
        method: "POST",
        body: { title },
      });
      // The deal exists now, whether or not the page may be left (unsaved
      // billing details ask first).
      onCreated();
      navigate(`/customers/${customerId}/sales/${deal.id}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Modal title="New deal" onClose={onClose}>
      <form onSubmit={create}>
        <Field
          label="Deal title"
          hint="Shown as the subject on every document."
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            minLength={2}
            maxLength={160}
            required
          />
        </Field>
        {error && <ErrorBox>{error}</ErrorBox>}
        <div className="confirm-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Create deal
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// Billing details and this client's own texts (copies, never the defaults).
function ProfileForm({
  customerId,
  initial,
  templates,
  user,
  onSaved,
  onStale,
}) {
  const billing = can(user.role, "billing");
  const [form, setForm] = useState(initial),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useNavigationGuard(
    dirty ? "Billing details have unsaved changes. Leave anyway?" : "",
  );
  const change = (next) => {
    setForm(next);
    setDirty(true);
    setNotice("");
  };
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = await withStepUp(() =>
        api(`/customers/${customerId}/sales/profile`, {
          method: "PUT",
          body: {
            rev: form.rev,
            billTo: cleanBillTo(form.billTo),
            overrides: form.overrides,
          },
        }),
      );
      setForm(saved);
      setDirty(false);
      setNotice("Billing details saved. New deals start from them.");
      onSaved();
    } catch (e) {
      if (e.cancelled) return;
      if (isStale(e)) onStale();
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="panel edit-form"
      onSubmit={save}
      aria-labelledby="sales-profile"
    >
      <section className="form-section">
        <h2 id="sales-profile">Billing details</h2>
        <p className="form-note">
          Copied into each new deal. Editing a deal never changes them.
        </p>
        <BillToFields
          value={form.billTo}
          prefix="Billing"
          onChange={(billTo) => change({ ...form, billTo })}
        />
      </section>
      <section className="form-section">
        <h2>Texts for this client</h2>
        <p className="form-note">
          A custom text is a copy kept for this client only; the defaults in
          Sales settings and other clients are not affected. Issued documents
          keep the text they were issued with.
        </p>
        {TEXTS.map(([key, label]) => {
          const custom = form.overrides[key] !== null,
            // Quotation and invoice terms print next to the payment details:
            // owner only (the server asks for a step-up).
            locked = key !== "agreementBody" && !billing;
          return (
            <fieldset key={key} className="sales-text-choice">
              <legend>{label}</legend>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={custom}
                  disabled={locked}
                  onChange={(e) =>
                    change({
                      ...form,
                      overrides: {
                        ...form.overrides,
                        [key]: e.target.checked ? templates[key] : null,
                      },
                    })
                  }
                />
                Custom text for this client
              </label>
              {locked && (
                <p className="form-note">
                  Only an owner can change this client's {label.toLowerCase()}.
                </p>
              )}
              {custom && (
                <Field
                  label={`${label} (this client)`}
                  hint="Placeholders such as {{client.name}} are filled in when a document is issued."
                >
                  <textarea
                    rows={6}
                    disabled={locked}
                    value={form.overrides[key]}
                    onChange={(e) =>
                      change({
                        ...form,
                        overrides: { ...form.overrides, [key]: e.target.value },
                      })
                    }
                    maxLength={key === "agreementBody" ? 20000 : 4000}
                  />
                </Field>
              )}
            </fieldset>
          );
        })}
      </section>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div role="status">{notice && <Notice>{notice}</Notice>}</div>
      <div className="form-actions">
        <span className="small subtle">
          {dirty ? "Unsaved changes" : "Saved"}
        </span>
        <Button type="submit" busy={busy} disabled={!dirty}>
          Save billing details
        </Button>
      </div>
    </form>
  );
}
