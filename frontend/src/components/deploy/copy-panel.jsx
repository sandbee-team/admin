import { useState } from "react";
import { Button, ErrorBox, Field, Notice, SecretInput } from "../ui";
import { ConfirmModal } from "../confirm";
import { withStepUp } from "../step-up";
import { api, dateTime } from "../../lib/api";
import { usePoll } from "../../hooks/use-poll";
import { StaleBanner } from "./stale-banner";
import { describeError } from "./format";
import {
  COPY_GROUPS,
  COPY_LABELS,
  sortGroups,
} from "../../../../shared/data-copy";

const active = (data) => ["queued", "running"].includes(data?.task?.status);
const n = (value) => Number(value ?? 0).toLocaleString("en-IN");
const SETTINGS_GROUPS = ["details", "settings"];
// Today in India time, the cafe's day.
const today = () =>
  new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const keyOf = (from, groups) => `${from}|${sortGroups(groups).join(",")}`;
const BLOCK_LABELS = {
  orders: "bills",
  customers: "customers",
  payments: "due payments",
  expenses: "expenses",
};
function noteText(code, r) {
  switch (code) {
    case "telegram":
      return "Telegram: connect it again in the new POS.";
    case "device-printers":
      return "USB / Bluetooth printers: pick the device again in the new POS (Printers).";
    case "images":
      return "Photos and logo show only if the new POS uses the same image storage.";
    case "older-customers":
      return `${n(r.older)} customers are older than the date: their totals include older bills.`;
    case "open-orders":
      return `${n(r.open)} open bills come along.`;
    case "old-open-orders":
      return `${n(r.oldOpen)} open bills from before the date stay behind.`;
    case "undated":
      return `${n(r.undated)} bills have no date and are not copied.`;
    case "index-skipped":
      return "Some indexes were not copied; the POS builds its own.";
    default:
      return null;
  }
}
function Notes({ result }) {
  const lines = [
    ...result.notes.map((code) => noteText(code, result)).filter(Boolean),
    ...(result.kept
      ? [
          `${n(result.kept)} logins already in the new POS stay as they are (like admin).`,
        ]
      : []),
    ...(result.others.length
      ? [
          `Not copied: ${result.others.map((o) => `${o.name} (${n(o.count)})`).join(", ")}.`,
        ]
      : []),
  ];
  if (!lines.length) return null;
  return (
    <ul className="copy-notes">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
// Owner tool: copy a client's demo data (old POS database) into this POS.
export function CopyPanel({ installationId, owner }) {
  const base = `/installations/${installationId}/pos/data-copy`,
    poll = usePoll(base, { isActive: active }),
    [uri, setUri] = useState(""),
    [editing, setEditing] = useState(false),
    [choice, setChoice] = useState(null),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(""),
    [problem, setProblem] = useState("");
  const data = poll.data,
    task = data?.task,
    source = data?.source,
    running = active(data),
    params = task?.params;
  // Until the owner changes something, the last run's choice is shown.
  const from = choice?.from ?? params?.from ?? "",
    groups =
      choice?.groups ?? (params?.groups.length ? params.groups : COPY_GROUPS);
  // A Check counts only for the same choice and the same saved old database.
  const result = task?.status === "succeeded" ? task.result : null,
    sameSource =
      Boolean(source?.savedAt && params?.sourceAt) &&
      new Date(source.savedAt).getTime() ===
        new Date(params.sourceAt).getTime(),
    sameChoice =
      Boolean(params) &&
      sameSource &&
      keyOf(from, groups) === keyOf(params.from, params.groups),
    counts = result && sameChoice ? result.groups : null,
    checked = result?.mode === "check" && sameChoice,
    stopped = checked && Boolean(result.blocked || result.needs.length),
    copiedNow = result?.mode === "copy" && task.result;
  const reason = !owner
    ? "Only the owner can copy data."
    : data && !data.target
      ? "Add this client's database URI in POS setup first."
      : !source
        ? "Save the old database first."
        : running
          ? "A copy or other task is running for this client."
          : !from
            ? "Pick the From date."
            : "";
  const why =
    task?.status === "failed" && task.error ? describeError(task.error) : null;
  const pick = (next) => {
    setProblem("");
    setChoice({ from, groups, ...next });
  };
  async function call(label, request) {
    setProblem("");
    setBusy(label);
    try {
      await request();
      await poll.refresh();
      return true;
    } catch (e) {
      if (e.cancelled) return false;
      setProblem(e.message);
      poll.refresh();
      return false;
    } finally {
      setBusy("");
    }
  }
  const saveSource = (event) => {
    event.preventDefault();
    return call("save", () =>
      withStepUp(() =>
        api(`${base}/source`, { method: "PUT", body: { uri: uri.trim() } }),
      ),
    ).then((ok) => {
      if (ok) {
        setUri("");
        setEditing(false);
      }
    });
  };
  const removeSource = () =>
    call("remove", () =>
      withStepUp(() => api(`${base}/source`, { method: "DELETE", body: {} })),
    );
  const body = { from, groups: sortGroups(groups) };
  const check = () =>
    call("check", () => api(`${base}/check`, { method: "POST", body }));
  // The modal shows a refusal itself and stays open for it.
  const copy = async () => {
    await withStepUp(() => api(base, { method: "POST", body }));
    setConfirm(false);
    setProblem("");
    await poll.refresh();
  };
  const progress = !running
    ? ""
    : task.status === "queued"
      ? "Waiting for the worker…"
      : params.mode === "check"
        ? "Checking both databases…"
        : `Copying ${COPY_LABELS[task.step] ?? ""}… ${n(task.progress?.documents)} records so far.`;
  return (
    <section
      className="panel copy-panel"
      aria-labelledby="copy-title"
      data-status={task?.status || "none"}
    >
      <div className="panel-title">
        <div>
          <h2 id="copy-title">Copy data from the demo</h2>
          <p>
            Brings the client’s demo data into this POS. The demo is not
            changed.
          </p>
        </div>
      </div>
      <div className="copy-body">
        <StaleBanner poll={poll} />
        {poll.error && !data && (
          <ErrorBox retry={poll.refresh}>{poll.error}</ErrorBox>
        )}
        {source && !editing ? (
          <div className="copy-row">
            <span className="copy-label">Old database</span>
            <code className="copy-source">
              {source.hosts[0]} / {source.db}
            </code>
            <span className="copy-row-actions">
              <Button
                variant="secondary"
                disabled={!owner || running || Boolean(busy)}
                onClick={() => setEditing(true)}
              >
                Replace
              </Button>
              <Button
                variant="secondary"
                busy={busy === "remove"}
                disabled={!owner || running || Boolean(busy)}
                onClick={removeSource}
              >
                Remove
              </Button>
            </span>
          </div>
        ) : (
          <form className="copy-row copy-source-form" onSubmit={saveSource}>
            <Field
              label="Old database"
              hint="Atlas → Connect → Drivers. Include the database name."
            >
              <SecretInput
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                placeholder="mongodb+srv://…mongodb.net/dbname"
                disabled={!owner}
              />
            </Field>
            <span className="copy-row-actions">
              <Button
                type="submit"
                busy={busy === "save"}
                disabled={!owner || !uri.trim() || Boolean(busy)}
              >
                Save
              </Button>
              {source && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setUri("");
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              )}
            </span>
          </form>
        )}
        <div className="copy-row">
          <Field
            label="From date"
            hint="Bills, dues, expenses and bookings from this date. The rest: everything."
          >
            <input
              type="date"
              value={from}
              max={today()}
              min="2020-01-01"
              disabled={!owner || running}
              onChange={(e) => pick({ from: e.target.value })}
            />
          </Field>
        </div>
        <fieldset className="copy-groups" disabled={!owner || running}>
          <legend>What to copy</legend>
          {COPY_GROUPS.map((group) => {
            const on = groups.includes(group),
              count = counts?.[group];
            return (
              <label key={group} className="copy-group" data-on={on}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    pick({
                      groups: on
                        ? groups.filter((g) => g !== group)
                        : [...groups, group],
                    })
                  }
                />
                <span>{COPY_LABELS[group]}</span>
                {on && count !== undefined && (
                  <span className="copy-count">
                    {SETTINGS_GROUPS.includes(group)
                      ? count
                        ? "✓"
                        : "none"
                      : n(count)}
                  </span>
                )}
              </label>
            );
          })}
        </fieldset>
        {problem && <ErrorBox>{problem}</ErrorBox>}
        {progress && (
          <p role="status" aria-live="polite" className="progress-status">
            {progress}
          </p>
        )}
        {checked && result.blocked && (
          <div className="error-why" role="alert" data-code="copy-target-used">
            <p>
              <strong>Copy blocked: the new POS is already in use.</strong> New
              or changed there:{" "}
              {Object.entries(result.blocked)
                .filter(([, v]) => v)
                .map(([k, v]) => `${n(v)} ${BLOCK_LABELS[k]}`)
                .join(", ")}
              .
            </p>
          </div>
        )}
        {checked && !result.blocked && result.needs.length > 0 && (
          <div className="error-why" role="alert" data-code="copy-needs">
            {result.needs.includes("admin") && (
              <p>
                <strong>Go live first:</strong> the new POS has no admin login
                yet (or untick Staff logins).
              </p>
            )}
            {result.needs.includes("settings") && (
              <p>
                <strong>Open the new POS once first:</strong> it has no settings
                yet (or tick both settings boxes).
              </p>
            )}
          </div>
        )}
        {checked && !stopped && (
          <div className="copy-result" role="status">
            <p>
              <strong>Ready to copy.</strong> Press Copy to bring this into the
              new POS.
            </p>
            <Notes result={result} />
          </div>
        )}
        {copiedNow && sameChoice && (
          <Notice>
            Copied {n(result.documents)} records {dateTime(task.finishedAt)}.
            Open the new POS and check it.
            <Notes result={result} />
          </Notice>
        )}
        {why && (
          <div className="error-why" role="alert" data-code={task.error.code}>
            <p>
              <strong>
                {params?.mode === "copy" ? "Copy" : "Check"} failed: {why.title}
                .
              </strong>{" "}
              {why.plainMessage}
            </p>
            <p className="small">What to do: {why.action}</p>
          </div>
        )}
        {task?.status === "expired" && (
          <p role="status">The last run was not picked up. Try again.</p>
        )}
        <div className="copy-foot">
          <Button
            variant="secondary"
            busy={busy === "check" || (running && params?.mode === "check")}
            disabled={Boolean(reason) || !groups.length || Boolean(busy)}
            onClick={check}
          >
            Check
          </Button>
          <Button
            disabled={Boolean(reason) || !checked || stopped || Boolean(busy)}
            onClick={() => {
              setProblem("");
              setConfirm(true);
            }}
          >
            Copy
          </Button>
          <span className="small subtle">
            {reason ||
              (!groups.length
                ? "Pick at least one kind of data."
                : checked
                  ? ""
                  : "Press Check to see what will be copied.")}
          </span>
        </div>
      </div>
      {confirm && (
        <ConfirmModal
          title="Copy the demo data into this POS?"
          action="Copy now"
          onClose={() => setConfirm(false)}
          onConfirm={copy}
        >
          <p>
            Menu, tables, printers and settings you picked are replaced by the
            demo’s. Bills, customers, expenses and bookings from {from} are
            added. The demo is not changed. You can copy again (new bills come
            along) until the client starts using the new POS.
          </p>
        </ConfirmModal>
      )}
    </section>
  );
}
