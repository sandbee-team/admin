import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Eye,
  FilePlus2,
  Lock,
  LockOpen,
  Plus,
  Receipt,
  Trash2,
} from "lucide-react";
import { useResource } from "../hooks/use-resource";
import {
  PageTitle,
  Resource,
  Badge,
  Button,
  Empty,
  ErrorBox,
  Field,
  Notice,
  Select,
} from "../components/ui";
import { ConfirmModal } from "../components/confirm";
import {
  BillToFields,
  DocumentTable,
  STATE_OPTIONS,
  cleanBillTo,
  money,
  saveFile,
} from "../components/sales";
import { api, download, isStale } from "../lib/api";
import { Link, useNavigationGuard } from "../lib/router";
import {
  GST_RATES,
  MAX_LINES,
  computeTotals,
  formatPercent,
  paiseText,
  parsePercent,
  parseQty,
  parseRupees,
  formatQty,
  localTaxLabel,
} from "../../../shared/sales";

const RATE_OPTIONS = GST_RATES.map((bp) => ({
  value: String(bp),
  label: formatPercent(bp),
}));
const DISCOUNT_OPTIONS = [
  { value: "none", label: "No discount" },
  { value: "percent", label: "Percent (%)" },
  { value: "amount", label: "Amount (Rs.)" },
];
const ISSUE_LABEL = {
  quotation: "quotation",
  agreement: "agreement",
  invoice: "tax invoice",
};
let nextId = 0;
const lineId = () => `l${Date.now().toString(36)}${(nextId++).toString(36)}`;

// Editor form ⇄ API deal. Money and quantities are typed as text and parsed
// with the same rules as the server (paise, thousandths, basis points).
const discountText = (d) =>
  d.type === "percent"
    ? paiseText(d.value)
    : d.type === "amount"
      ? paiseText(d.value)
      : "";
function toForm(deal) {
  return {
    title: deal.title,
    billTo: deal.billTo,
    placeOfSupply: deal.placeOfSupply,
    validUntil: deal.validUntil,
    notes: deal.notes,
    discountType: deal.discount.type,
    discountText: discountText(deal.discount),
    lines: deal.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      description: l.description,
      sac: l.sac,
      unit: l.unit,
      qtyText: formatQty(l.qty),
      priceText: paiseText(l.unitPrice),
      discountType: l.discount.type,
      discountText: discountText(l.discount),
      gstRate: String(l.gstRate),
    })),
  };
}
const discountOf = (type, text) => {
  if (type === "none") return { type, value: 0 };
  const value = type === "percent" ? parsePercent(text) : parseRupees(text);
  return value === null ? null : { type, value };
};
// -> {deal} or {problem}
function toDeal(form) {
  const lines = [];
  for (const [i, l] of form.lines.entries()) {
    const qty = parseQty(l.qtyText),
      unitPrice = parseRupees(l.priceText),
      discount = discountOf(l.discountType, l.discountText);
    if (!qty)
      return {
        problem: `Line ${i + 1}: enter a quantity above zero (up to 3 decimals).`,
      };
    if (unitPrice === null)
      return {
        problem: `Line ${i + 1}: enter the unit price in rupees (up to 2 decimals).`,
      };
    if (!discount)
      return { problem: `Line ${i + 1}: enter the discount as a number.` };
    lines.push({
      id: l.id,
      productId: l.productId,
      description: l.description,
      sac: l.sac.trim(),
      unit: l.unit,
      qty,
      unitPrice,
      discount,
      gstRate: Number(l.gstRate),
    });
  }
  const discount = discountOf(form.discountType, form.discountText);
  if (!discount) return { problem: "Enter the overall discount as a number." };
  return {
    deal: {
      title: form.title,
      billTo: cleanBillTo(form.billTo),
      placeOfSupply: form.placeOfSupply,
      lines,
      discount,
      validUntil: form.validUntil,
      notes: form.notes,
    },
  };
}

export function DealPage({ customerId, dealId, user }) {
  const resource = useResource(`/sales/deals/${dealId}`),
    settings = useResource("/sales/settings"),
    products = useResource("/options/products"),
    // Kept here: the editor remounts on every new revision (after an issue too).
    // {text, warning}
    [notice, setNotice] = useState(null);
  return (
    <>
      <Link href={`/customers/${customerId}/sales`} className="back-link">
        <ArrowLeft size={14} />
        All deals of this customer
      </Link>
      <div role="status" className="sales-status">
        {notice &&
          (notice.warning ? (
            <div className="notice notice-warning">
              <span>{notice.text}</span>
            </div>
          ) : (
            <Notice>{notice.text}</Notice>
          ))}
      </div>
      <Resource resource={resource}>
        {(deal) =>
          deal.customerId !== customerId ? (
            <div className="panel">
              <Empty
                icon={Receipt}
                title="This deal belongs to another customer"
              >
                <Link href={`/customers/${deal.customerId}/sales/${deal.id}`}>
                  Open it under its customer
                </Link>
              </Empty>
            </div>
          ) : (
            <Resource resource={settings}>
              {(config) => (
                <DealEditor
                  key={deal.rev}
                  deal={deal}
                  config={config}
                  products={products.data?.rows ?? []}
                  user={user}
                  setNotice={setNotice}
                  onChanged={() => resource.refresh().catch(() => {})}
                  onStale={() => {
                    setNotice({
                      text: "This deal was changed in another window or by someone else. It has been reloaded; your unsaved edits were not kept.",
                      warning: true,
                    });
                    resource.reload();
                  }}
                />
              )}
            </Resource>
          )
        }
      </Resource>
    </>
  );
}

function DealEditor({
  deal,
  config,
  products,
  user,
  setNotice,
  onChanged,
  onStale,
}) {
  const [form, setForm] = useState(() => toForm(deal)),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(null),
    [previewType, setPreviewType] = useState("quotation"),
    [confirmInvoice, setConfirmInvoice] = useState(false);
  useNavigationGuard(
    dirty ? "This deal has unsaved changes. Leave anyway?" : "",
  );
  const draft = deal.status === "draft",
    parsed = useMemo(() => toDeal(form), [form]),
    // {totals} or {problem}: the same RangeError text the server would give.
    computed = useMemo(() => {
      if (!parsed.deal) return { problem: parsed.problem };
      try {
        return {
          totals: computeTotals(parsed.deal, {
            sellerState: deal.sellerState || parsed.deal.placeOfSupply,
            roundOff: deal.roundOff,
          }),
        };
      } catch (e) {
        return { problem: e.message };
      }
    }, [parsed, deal.sellerState, deal.roundOff]),
    totals = computed.totals ?? null;
  const change = (next) => {
    setForm(next);
    setDirty(true);
    setNotice(null);
  };
  const setLine = (index, patch) =>
    change({
      ...form,
      lines: form.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    });
  function addLine(productId = "") {
    const product = products.find((p) => p._id === productId);
    change({
      ...form,
      lines: [
        ...form.lines,
        {
          id: lineId(),
          productId,
          description: product?.name ?? "",
          sac: config.gst.defaultSac,
          unit: "nos",
          qtyText: "1",
          priceText: "",
          discountType: "none",
          discountText: "",
          gstRate: String(config.gst.defaultRate),
        },
      ],
    });
  }
  async function run(name, action, done) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      await done?.(result);
    } catch (e) {
      if (isStale(e)) onStale();
      else setError(e);
    } finally {
      setBusy("");
    }
  }
  const save = (event) => {
    event?.preventDefault();
    if (parsed.problem) return setError({ message: parsed.problem });
    return run(
      "save",
      () =>
        api(`/sales/deals/${deal.id}`, {
          method: "PUT",
          body: { rev: deal.rev, ...parsed.deal },
        }),
      () => {
        setDirty(false);
        setNotice({ text: "Deal saved." });
        return onChanged();
      },
    );
  };
  const status = (action) =>
    run(
      "status",
      () =>
        api(`/sales/deals/${deal.id}/status`, {
          method: "POST",
          body: { rev: deal.rev, action },
        }),
      onChanged,
    );
  const issue = (type) =>
    run(
      `issue-${type}`,
      () =>
        api(`/sales/deals/${deal.id}/issue`, {
          method: "POST",
          body: { rev: deal.rev, type },
        }),
      (doc) => {
        setNotice({
          text: `${doc.title} ${doc.label} issued.${doc.stored ? " A copy is stored in Files." : deal.storage ? " No copy could be stored in Files yet; use Store copy below." : ""}`,
        });
        return onChanged();
      },
    );
  const preview = () =>
    run("preview", async () =>
      saveFile(
        await download(`/sales/deals/${deal.id}/preview`, {
          type: previewType,
        }),
      ),
    );
  const hasInvoice = deal.documents.some(
    (d) => d.type === "invoice" && d.status === "issued",
  );
  const disabled = !draft;
  return (
    <>
      <PageTitle
        eyebrow="DEAL"
        title={deal.title}
        description={`Created by ${deal.createdBy}. ${draft ? "Draft: edit, save, then issue a quotation or finalise." : deal.status === "final" ? "Final: the commercial terms are locked. Issue the agreement and the tax invoice." : "Closed as lost."}`}
        action={<Badge value={deal.status} />}
      />
      <form className="panel edit-form" onSubmit={save} aria-label="Deal">
        <fieldset disabled={disabled} className="sales-fieldset">
          <section className="form-section">
            <h2>Deal</h2>
            <div className="form-grid">
              <Field label="Title">
                <input
                  value={form.title}
                  onChange={(e) => change({ ...form, title: e.target.value })}
                  maxLength={160}
                  required
                />
              </Field>
              <Field
                label="Place of supply"
                hint={
                  deal.sellerState
                    ? form.placeOfSupply === deal.sellerState
                      ? "Same state as the company: CGST + SGST."
                      : "Another state: IGST."
                    : "Set the company state in Sales settings."
                }
              >
                <Select
                  value={form.placeOfSupply}
                  onChange={(e) =>
                    change({ ...form, placeOfSupply: e.target.value })
                  }
                  options={STATE_OPTIONS}
                  disabled={disabled}
                />
              </Field>
              <Field
                label="Quotation valid until"
                hint={`Blank: ${config.quotation.validityDays} days from the issue date.`}
              >
                <input
                  type="date"
                  value={form.validUntil}
                  onChange={(e) =>
                    change({ ...form, validUntil: e.target.value })
                  }
                />
              </Field>
              <Field label="Notes on the documents">
                <textarea
                  rows={3}
                  value={form.notes}
                  onChange={(e) => change({ ...form, notes: e.target.value })}
                  maxLength={2000}
                />
              </Field>
            </div>
          </section>
          <section className="form-section">
            <h2>Bill to</h2>
            <BillToFields
              value={form.billTo}
              prefix="Client"
              disabled={disabled}
              onChange={(billTo) =>
                change({
                  ...form,
                  billTo,
                  // A new state moves the place of supply with it (s.12(2) IGST Act).
                  placeOfSupply:
                    billTo.stateCode !== form.billTo.stateCode &&
                    billTo.stateCode
                      ? billTo.stateCode
                      : form.placeOfSupply,
                })
              }
            />
          </section>
          <section className="form-section">
            <h2>Products and services</h2>
            {form.lines.length === 0 && (
              <p className="form-note">
                No lines yet. Add a product or a free line.
              </p>
            )}
            <ol className="sales-lines">
              {form.lines.map((line, i) => (
                <li key={line.id} className="sales-line">
                  <fieldset>
                    <legend>Line {i + 1}</legend>
                    <div className="sales-line-grid">
                      <Field
                        label="Description"
                        className="field sales-line-desc"
                      >
                        <textarea
                          rows={2}
                          value={line.description}
                          onChange={(e) =>
                            setLine(i, { description: e.target.value })
                          }
                          maxLength={300}
                          required
                        />
                      </Field>
                      <Field label="SAC">
                        <input
                          value={line.sac}
                          onChange={(e) => setLine(i, { sac: e.target.value })}
                          maxLength={8}
                          inputMode="numeric"
                        />
                      </Field>
                      <Field label="Quantity">
                        <input
                          value={line.qtyText}
                          onChange={(e) =>
                            setLine(i, { qtyText: e.target.value })
                          }
                          inputMode="decimal"
                          maxLength={12}
                        />
                      </Field>
                      <Field label="Unit">
                        <input
                          value={line.unit}
                          onChange={(e) => setLine(i, { unit: e.target.value })}
                          maxLength={12}
                        />
                      </Field>
                      <Field label="Unit price (Rs.)">
                        <input
                          value={line.priceText}
                          onChange={(e) =>
                            setLine(i, { priceText: e.target.value })
                          }
                          inputMode="decimal"
                          maxLength={14}
                        />
                      </Field>
                      <Field label="Discount">
                        <Select
                          value={line.discountType}
                          onChange={(e) =>
                            setLine(i, { discountType: e.target.value })
                          }
                          options={DISCOUNT_OPTIONS}
                          disabled={disabled}
                        />
                      </Field>
                      {line.discountType !== "none" && (
                        <Field
                          label={
                            line.discountType === "percent"
                              ? "Discount %"
                              : "Discount (Rs.)"
                          }
                        >
                          <input
                            value={line.discountText}
                            onChange={(e) =>
                              setLine(i, { discountText: e.target.value })
                            }
                            inputMode="decimal"
                            maxLength={14}
                          />
                        </Field>
                      )}
                      <Field label="GST rate">
                        <Select
                          value={line.gstRate}
                          onChange={(e) =>
                            setLine(i, { gstRate: e.target.value })
                          }
                          options={RATE_OPTIONS}
                          disabled={disabled}
                        />
                      </Field>
                      <div className="sales-line-amount">
                        <span className="small subtle">Line total</span>
                        <strong>
                          {totals ? money(totals.lines[i].amount) : "—"}
                        </strong>
                        {totals &&
                          totals.lines[i].discount + totals.lines[i].share >
                            0 && (
                            <span className="small subtle">
                              Taxable {money(totals.lines[i].taxable)}
                            </span>
                          )}
                      </div>
                      {draft && (
                        <button
                          type="button"
                          className="icon-button sales-line-remove"
                          aria-label={`Remove line ${i + 1}`}
                          onClick={() =>
                            change({
                              ...form,
                              lines: form.lines.filter((_, k) => k !== i),
                            })
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </fieldset>
                </li>
              ))}
            </ol>
            {draft && form.lines.length < MAX_LINES && (
              <div className="sales-add">
                <Field label="Add from catalog">
                  <Select
                    value=""
                    onChange={(e) => e.target.value && addLine(e.target.value)}
                    options={[
                      { value: "", label: "Choose a product" },
                      ...products.map((p) => ({ value: p._id, label: p.name })),
                    ]}
                  />
                </Field>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => addLine()}
                >
                  <Plus size={15} />
                  Add free line
                </Button>
              </div>
            )}
          </section>
          <section className="form-section">
            <h2>Overall discount and totals</h2>
            <div className="sales-totals-layout">
              <div className="form-grid">
                <Field label="Overall discount">
                  <Select
                    value={form.discountType}
                    onChange={(e) =>
                      change({ ...form, discountType: e.target.value })
                    }
                    options={DISCOUNT_OPTIONS}
                    disabled={disabled}
                  />
                </Field>
                {form.discountType !== "none" && (
                  <Field
                    label={
                      form.discountType === "percent"
                        ? "Overall discount %"
                        : "Overall discount (Rs.)"
                    }
                  >
                    <input
                      value={form.discountText}
                      onChange={(e) =>
                        change({ ...form, discountText: e.target.value })
                      }
                      inputMode="decimal"
                      maxLength={14}
                    />
                  </Field>
                )}
              </div>
              <Totals
                totals={totals}
                problem={computed.problem}
                discount={parsed.deal?.discount}
                roundOff={deal.roundOff}
                placeOfSupply={form.placeOfSupply}
              />
            </div>
          </section>
        </fieldset>
        {error && (
          <ErrorBox>
            {error.message}
            {error.code === "settings-incomplete" && (
              <>
                {" "}
                <Link href="/sales-settings">Open Sales settings</Link>
              </>
            )}
          </ErrorBox>
        )}
        <div className="form-actions sales-actions">
          <span className="small subtle">
            {dirty
              ? "Unsaved changes: save before issuing."
              : draft
                ? "Saved draft"
                : "Locked"}
          </span>
          <div className="account-actions">
            {draft && (
              <Button type="submit" busy={busy === "save"} disabled={!dirty}>
                Save deal
              </Button>
            )}
          </div>
        </div>
      </form>

      <section
        className="panel sales-issue"
        aria-labelledby="sales-issue-title"
      >
        <div className="panel-title">
          <div>
            <h2 id="sales-issue-title">Documents</h2>
            <p>
              Each issue makes a numbered, unchangeable PDF. A new quotation or
              agreement is a new version.
            </p>
          </div>
        </div>
        <div className="sales-issue-body">
          <div className="sales-preview">
            <Field label="Preview type">
              <Select
                value={previewType}
                onChange={(e) => setPreviewType(e.target.value)}
                options={[
                  { value: "quotation", label: "Quotation" },
                  { value: "agreement", label: "Agreement" },
                  { value: "invoice", label: "Tax invoice" },
                ]}
              />
            </Field>
            <Button
              type="button"
              variant="secondary"
              busy={busy === "preview"}
              disabled={dirty}
              onClick={preview}
            >
              <Eye size={15} />
              Preview PDF
            </Button>
          </div>
          <div className="account-actions">
            {deal.status !== "lost" && (
              <Button
                type="button"
                busy={busy === "issue-quotation"}
                disabled={dirty || !!busy}
                onClick={() => issue("quotation")}
              >
                <FilePlus2 size={15} />
                Issue {ISSUE_LABEL.quotation}
              </Button>
            )}
            {deal.status === "final" && (
              <>
                <Button
                  type="button"
                  busy={busy === "issue-agreement"}
                  disabled={!!busy}
                  onClick={() => issue("agreement")}
                >
                  <FilePlus2 size={15} />
                  Issue {ISSUE_LABEL.agreement}
                </Button>
                <Button
                  type="button"
                  busy={busy === "issue-invoice"}
                  disabled={!!busy || hasInvoice}
                  onClick={() => setConfirmInvoice(true)}
                >
                  <FilePlus2 size={15} />
                  Issue {ISSUE_LABEL.invoice}
                </Button>
              </>
            )}
            {draft && (
              <Button
                type="button"
                variant="secondary"
                busy={busy === "status"}
                disabled={dirty || !!busy}
                onClick={() => status("finalize")}
              >
                <Lock size={15} />
                Finalise deal
              </Button>
            )}
            {deal.status !== "draft" && (
              <Button
                type="button"
                variant="secondary"
                busy={busy === "status"}
                disabled={!!busy || hasInvoice}
                onClick={() => status("reopen")}
              >
                <LockOpen size={15} />
                Reopen as draft
              </Button>
            )}
            {deal.status !== "lost" && !hasInvoice && (
              <Button
                type="button"
                variant="secondary"
                disabled={dirty || !!busy}
                onClick={() => status("lost")}
              >
                Close as lost
              </Button>
            )}
          </div>
          {hasInvoice && (
            <p className="small subtle">
              This deal has an active tax invoice. Cancel it (owner) to reopen
              the deal or issue another.
            </p>
          )}
        </div>
      </section>
      {deal.documents.length > 0 && (
        <DocumentTable
          rows={deal.documents}
          user={user}
          caption="Documents of this deal"
          defaultTo={deal.billTo.email}
          storage={deal.storage}
          onChanged={onChanged}
        />
      )}
      {confirmInvoice && (
        <ConfirmModal
          title="Issue the tax invoice?"
          action="Issue tax invoice"
          onClose={() => setConfirmInvoice(false)}
          onConfirm={async () => {
            setConfirmInvoice(false);
            await issue("invoice");
          }}
        >
          <p>
            It takes the next invoice number of this financial year and can
            never be edited. To correct it later the owner has to cancel it
            (only before it is reported in your GST return).
          </p>
        </ConfirmModal>
      )}
    </>
  );
}

function Totals({ totals, problem, discount, roundOff, placeOfSupply }) {
  if (!totals)
    return (
      <div className="sales-totals" role="status">
        <p className="small subtle">
          {problem || "Totals appear when every line is complete."}
        </p>
      </div>
    );
  const rows = [
    ["Subtotal", money(totals.gross)],
    ...(totals.lineDiscount
      ? [["Line discounts", `- ${money(totals.lineDiscount)}`]]
      : []),
    ...(totals.overallDiscount
      ? [
          [
            discount?.type === "percent"
              ? `Overall discount (${formatPercent(discount.value)})`
              : "Overall discount",
            `- ${money(totals.overallDiscount)}`,
          ],
        ]
      : []),
    ["Taxable value", money(totals.taxable)],
    ...(totals.intra
      ? [
          ["CGST", money(totals.cgst)],
          [localTaxLabel(placeOfSupply), money(totals.sgst)],
        ]
      : [["IGST", money(totals.igst)]]),
    ...(roundOff ? [["Round off", money(totals.roundOff)]] : []),
  ];
  return (
    <dl className="sales-totals" aria-label="Totals">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
      <div className="sales-total">
        <dt>Total</dt>
        <dd>{money(totals.payable)}</dd>
      </div>
    </dl>
  );
}
