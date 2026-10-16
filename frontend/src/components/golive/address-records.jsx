import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Badge, Button } from "../ui";
import { dateTime } from "../../lib/api";
import { describeCode } from "../../../../shared/deploy-errors";
import { when } from "../deploy/format";
import { DNS_REASONS } from "./golive-progress";
// The records the owner enters at GoDaddy by hand (D40, D44), what the last
// check found, and Check DNS. Everything here is public DNS data.
const STATE = {
  ready: ["done", "DNS ready"],
  "pending-dns": ["paused", "Waiting for DNS"],
  "pending-verify": ["paused", "Waiting for Vercel"],
  "pending-cert": ["in-progress", "Certificate pending"],
  "check-failed": ["disabled", "Check failed"],
  "tenant-mismatch": ["disabled", "Address mismatch"],
};
function CopyButton({ text, what }) {
  const [state, setState] = useState(""),
    timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(""), 4000);
  }
  return (
    <Button
      type="button"
      variant="secondary"
      className="copy-button"
      aria-label={`Copy ${what}`}
      onClick={copy}
    >
      {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Select and copy"
          : "Copy"}
    </Button>
  );
}
const found = (part) =>
  part?.ok === true
    ? "found and correct"
    : part?.ok === false
      ? Array.isArray(part.found)
        ? part.found.length
          ? `found, but different: ${part.found.join(", ")}`
          : "not found yet"
        : part.found
          ? `points to ${part.found}`
          : "not found yet"
      : "not checked yet";
// check: {onClick, busy, reason} — a reason replaces the button with text.
export function AddressRecords({ address, warnings = [], check }) {
  const [chip, chipText] = STATE[address.state] || STATE["pending-dns"],
    txt = address.records.some((r) => r.type === "TXT"),
    reasons = warnings.filter((code) => DNS_REASONS.includes(code));
  return (
    <section
      className="panel golive-address"
      aria-labelledby="golive-address-title"
    >
      <div className="panel-title">
        <div>
          <h2 id="golive-address-title">Web address</h2>
          <p>
            <code>https://{address.host}</code>
          </p>
        </div>
        <Badge value={chip}>{chipText}</Badge>
      </div>
      <div className="golive-body">
        {address.records.length > 0 ? (
          <>
            <p className="small">
              Add{" "}
              {address.records.length === 1 ? "this record" : "these records"}{" "}
              at GoDaddy (DNS → Add record) exactly as shown, with the default
              TTL. Then press Check DNS.
            </p>
            <table className="dns-records">
              <caption className="sr-only">
                DNS records to add at GoDaddy
              </caption>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Name (Host)</th>
                  <th scope="col">Value (Points to)</th>
                </tr>
              </thead>
              <tbody>
                {address.records.map((record) => (
                  <tr
                    key={`${record.type}-${record.name}`}
                    data-type={record.type}
                  >
                    <td data-label="Type">
                      <code>{record.type}</code>
                    </td>
                    <td data-label="Name (Host)">
                      <span className="dns-value">
                        <code>{record.name}</code>
                        <CopyButton
                          text={record.name}
                          what={`${record.type} name ${record.name}`}
                        />
                      </span>
                    </td>
                    <td data-label="Value (Points to)">
                      <span className="dns-value">
                        <code>{record.value}</code>
                        <CopyButton
                          text={record.value}
                          what={`${record.type} value ${record.value}`}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="small subtle">
            The records appear here once the go-live has added the address to
            the Vercel project.
          </p>
        )}
        {reasons.length > 0 && (
          <ul className="golive-reasons" aria-label="Why DNS is not ready">
            {reasons.map((code) => {
              const entry = describeCode(code);
              return (
                <li key={code} data-code={code}>
                  <strong>{entry.title}.</strong> {entry.plainMessage}{" "}
                  <span className="subtle">{entry.action}</span>
                </li>
              );
            })}
          </ul>
        )}
        <ul className="golive-facts small" aria-label="Last DNS check">
          <li>
            CNAME: <strong>{found(address.cname)}</strong>
          </li>
          {txt && (
            <li>
              TXT: <strong>{found(address.txt)}</strong>
            </li>
          )}
          <li>
            Vercel:{" "}
            <strong>
              {address.verified ? "verified" : "not verified yet"}
              {address.configured === true
                ? ", configured"
                : address.configured === false
                  ? ", not configured yet"
                  : ""}
            </strong>
          </li>
          <li>
            HTTPS:{" "}
            <strong>
              {address.tls
                ? "certificate ready"
                : "comes with the first deploy"}
            </strong>
          </li>
          <li>
            Last checked:{" "}
            <strong>
              {address.checkedAt
                ? `${dateTime(address.checkedAt)} (${when(address.checkedAt)})`
                : "never"}
            </strong>
          </li>
        </ul>
      </div>
      {check && (
        <div className="panel-foot">
          {check.reason ? (
            <span>{check.reason}</span>
          ) : (
            <>
              <span>Asks GoDaddy’s own nameservers, then Vercel.</span>
              <Button busy={check.busy} onClick={check.onClick}>
                Check DNS
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
