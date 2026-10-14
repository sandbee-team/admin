import { useState } from "react";
import { Download, Mail, Ban, Upload as Store } from "lucide-react";
import { Badge, Button, ErrorBox, Field, Modal, Select } from "./ui";
import { ConfirmModal } from "./confirm";
import { withStepUp } from "./step-up";
import { api, download, dateTime } from "../lib/api";
import { can } from "../../../shared/policy";
import { STATES, formatPaise } from "../../../shared/sales";

export const money = (paise) =>
  paise === null || paise === undefined ? "—" : `Rs. ${formatPaise(paise)}`;
export const STATE_OPTIONS = [
  { value: "", label: "Select state" },
  ...STATES.map(([code, name]) => ({
    value: code,
    label: `${name} (${code})`,
  })),
];
// Saves a {blob, filename} from download() through a temporary link.
export function saveFile({ blob, filename }) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Bill-to fields shared by the client's billing details and the deal editor.
export function BillToFields({ value, onChange, disabled, prefix }) {
  const set = (key) => (event) =>
    onChange({ ...value, [key]: event.target.value });
  return (
    <div className="form-grid">
      <Field label={`${prefix} name`}>
        <input
          value={value.name}
          onChange={set("name")}
          maxLength={160}
          disabled={disabled}
          required
        />
      </Field>
      <Field label="GSTIN" hint="Leave blank for an unregistered client.">
        <input
          value={value.gstin}
          onChange={(e) =>
            onChange({ ...value, gstin: e.target.value.toUpperCase() })
          }
          maxLength={15}
          disabled={disabled}
          autoComplete="off"
        />
      </Field>
      <Field label="Address" hint="Up to four lines.">
        <textarea
          rows={3}
          value={value.address.join("\n")}
          onChange={(e) =>
            onChange({
              ...value,
              address: e.target.value.split("\n").slice(0, 4),
            })
          }
          disabled={disabled}
        />
      </Field>
      <div>
        <Field label="City">
          <input
            value={value.city}
            onChange={set("city")}
            maxLength={60}
            disabled={disabled}
          />
        </Field>
        <Field label="PIN code">
          <input
            value={value.pincode}
            onChange={set("pincode")}
            maxLength={6}
            inputMode="numeric"
            disabled={disabled}
          />
        </Field>
      </div>
      <Field label="State">
        <Select
          value={value.stateCode}
          onChange={set("stateCode")}
          options={STATE_OPTIONS}
          disabled={disabled}
        />
      </Field>
      <Field label="PAN">
        <input
          value={value.pan}
          onChange={(e) =>
            onChange({ ...value, pan: e.target.value.toUpperCase() })
          }
          maxLength={10}
          disabled={disabled}
        />
      </Field>
      <Field label="E-mail">
        <input
          type="email"
          value={value.email}
          onChange={set("email")}
          maxLength={254}
          disabled={disabled}
        />
      </Field>
      <Field label="Phone">
        <input
          value={value.phone}
          onChange={set("phone")}
          maxLength={32}
          disabled={disabled}
        />
      </Field>
    </div>
  );
}
// The API keeps address lines without blanks.
export const cleanBillTo = (b) => ({
  ...b,
  address: b.address.map((line) => line.trim()).filter(Boolean),
});

// storage: false when the server has no file store (no "Store copy" then).
export function DocumentTable({
  rows,
  user,
  defaultTo,
  onChanged,
  caption,
  storage = true,
}) {
  const [modal, setModal] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const billing = can(user.role, "billing");
  async function get(doc) {
    setError("");
    setBusy(`get-${doc.id}`);
    try {
      saveFile(await download(`/sales/documents/${doc.id}/download`));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  async function store(doc) {
    setError("");
    setBusy(`store-${doc.id}`);
    try {
      onChanged(
        await api(`/sales/documents/${doc.id}/store`, {
          method: "POST",
          body: {},
        }),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="panel table-wrap">
        <table>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th>Document</th>
              <th>Issued</th>
              <th>Total</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((doc) => (
              <tr key={doc.id}>
                <td>
                  <strong>{doc.title}</strong>
                  <span className="cell-subtext mono">{doc.label}</span>
                  <span className="cell-subtext">{doc.dealTitle}</span>
                </td>
                <td className="small">
                  {dateTime(doc.issuedAt)}
                  <span className="cell-subtext">{doc.issuedBy}</span>
                </td>
                <td>{money(doc.payable)}</td>
                <td>
                  <Badge value={doc.status} />
                  {storage && !doc.stored && (
                    <span className="cell-subtext">No stored copy</span>
                  )}
                  {doc.emails.length > 0 && (
                    <span className="cell-subtext">
                      E-mailed {doc.emails.length}×
                    </span>
                  )}
                </td>
                <td>
                  <div className="sales-row-actions">
                    <Button
                      variant="secondary"
                      busy={busy === `get-${doc.id}`}
                      onClick={() => get(doc)}
                      aria-label={`Download ${doc.label}`}
                    >
                      <Download size={14} />
                      Download
                    </Button>
                    {doc.status === "issued" && (
                      <Button
                        variant="secondary"
                        onClick={() => setModal({ type: "email", doc })}
                        aria-label={`E-mail ${doc.label}`}
                      >
                        <Mail size={14} />
                        E-mail
                      </Button>
                    )}
                    {storage && !doc.stored && doc.status !== "cancelled" && (
                      <Button
                        variant="secondary"
                        busy={busy === `store-${doc.id}`}
                        onClick={() => store(doc)}
                        aria-label={`Store copy of ${doc.label}`}
                      >
                        <Store size={14} />
                        Store copy
                      </Button>
                    )}
                    {billing &&
                      doc.status === "issued" &&
                      doc.type !== "quotation" && (
                        <Button
                          variant="secondary"
                          onClick={() => setModal({ type: "cancel", doc })}
                          aria-label={`Cancel ${doc.label}`}
                        >
                          <Ban size={14} />
                          Cancel
                        </Button>
                      )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal?.type === "email" && (
        <EmailModal
          doc={modal.doc}
          defaultTo={defaultTo}
          onClose={() => setModal(null)}
          onSent={(view) => {
            setModal(null);
            onChanged(view);
          }}
        />
      )}
      {modal?.type === "cancel" && (
        <CancelModal
          doc={modal.doc}
          onClose={() => setModal(null)}
          onDone={(view) => {
            setModal(null);
            onChanged(view);
          }}
        />
      )}
    </>
  );
}

function EmailModal({ doc, defaultTo, onClose, onSent }) {
  const [to, setTo] = useState(defaultTo || ""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function send(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const list = to
        .split(/[,;\s]+/)
        .map((v) => v.trim())
        .filter(Boolean);
      onSent(
        await api(`/sales/documents/${doc.id}/email`, {
          method: "POST",
          body: { to: list, message },
        }),
      );
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Modal title={`E-mail ${doc.label}`} onClose={onClose}>
      <form onSubmit={send}>
        <p className="subtle small">
          The PDF goes as an attachment from the admin mail address; replies go
          to the company e-mail. Check the address: this sends a real e-mail.
        </p>
        <Field label="To" hint="Up to three addresses, separated by commas.">
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            maxLength={800}
            required
          />
        </Field>
        <Field label="Message (optional)">
          <textarea
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={1000}
          />
        </Field>
        {error && <ErrorBox>{error}</ErrorBox>}
        <div className="confirm-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            <Mail size={14} />
            Send e-mail
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CancelModal({ doc, onClose, onDone }) {
  const [reason, setReason] = useState("");
  return (
    <ConfirmModal
      title={`Cancel ${doc.label}`}
      action="Cancel document"
      onClose={onClose}
      onConfirm={async () => {
        if (reason.trim().length < 5)
          throw new Error("Give a reason of at least 5 characters.");
        onDone(
          await withStepUp(() =>
            api(`/sales/documents/${doc.id}/cancel`, {
              method: "POST",
              body: { reason },
            }),
          ),
        );
      }}
    >
      <p>
        The document stays on record, marked cancelled. Cancel an invoice only
        before it is reported in your GST return; after that, correct it with a
        credit note.
      </p>
      <Field label="Reason">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
        />
      </Field>
    </ConfirmModal>
  );
}
