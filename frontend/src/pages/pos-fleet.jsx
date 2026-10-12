import { useEffect, useState } from "react";
import { RefreshCw, Server } from "lucide-react";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Loading,
  PageTitle,
} from "../components/ui";
import { Link } from "../lib/router";
import { usePoll } from "../hooks/use-poll";
import { api } from "../lib/api";
import { can } from "../../../shared/policy";
import { StaleBanner } from "../components/deploy/stale-banner";
import { RolloutPanel } from "../components/deploy/rollout-panel";
import { when } from "../components/deploy/format";
import { SiteBadge } from "../components/usage/badges";
import {
  LEVEL_WORD,
  OFFLINE_TEXT,
  WAITING_TEXT,
  checkError,
  isChecking,
  isToday,
  levelOf,
  ms,
  pct,
} from "../components/usage/format";
const STATE = {
  live: ["live", "Live"],
  failed: ["disabled", "Failed"],
  unhealthy: ["disabled", "Unhealthy — site may be down"],
  "rolled-back": ["in-progress", "Rolled back — site is fine"],
  deploying: ["in-progress", "Deploying"],
  locked: ["paused", "Locked"],
  unverified: ["paused", "Unverified"],
  "not-deployed": ["planned", "Not deployed"],
};
export function StateBadge({ state }) {
  const [value, text] = STATE[state] || ["planned", state];
  return <Badge value={value}>{text}</Badge>;
}
// How far the live commit is behind its branch head, said honestly.
export function behindText(row, light = false) {
  if (light && row.behindBy == null) return "—";
  if (row.relation === "behind")
    return `Behind by ${row.behindBy} commit${row.behindBy === 1 ? "" : "s"}`;
  return (
    {
      current: "Up to date",
      ahead: "Branch moved back",
      diverged: "Diverged from branch",
      "branch-gone": "Branch gone",
      unknown: "Unknown",
    }[row.relation] || "—"
  );
}
export function LiveHeadline({ row }) {
  const text = row.live?.headline;
  if (!text) return null;
  return (
    <span className="cell-subtext headline-cell" title={text}>
      {text}
    </span>
  );
}
export const liveText = (row) =>
  row.live ? `${row.live.branch}@${row.live.sha7}` : "Not deployed";
// Usage checks (Phase 2) still waiting for or inside the worker, and whether
// they have stalled. `usageStalled` is the server's answer (server clock): the
// worker is offline, or a check has been queued for over 10 minutes while
// none is running (a long batch runs one at a time, so it is not stalled).
function checksOf(data) {
  const checking = (data?.rows ?? []).filter((r) =>
    isChecking(r.usage?.check),
  ).length;
  return { checking, stalled: checking > 0 && data.usageStalled === true };
}
// The normal cadence: 15 s while a deploy runs, 60 s otherwise.
const isDeploying = (data) =>
  Boolean(data?.rows.some((r) => r.state === "deploying"));
// While checks are queued or running (and not stalled) the page also re-reads
// 10 s after each answer; each check takes a few seconds once the worker
// picks it up.
const CHECKING_MS = 10000;
// A storage or Worker fraction with its level said in words, not only colour.
function LevelValue({ fraction }) {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return "—";
  const level = levelOf(fraction);
  return (
    <>
      <span className={`usage-level usage-level-${level}`}>
        {pct(fraction)}
      </span>
      {level !== "ok" && (
        <span className="cell-subtext">{LEVEL_WORD[level]}</span>
      )}
    </>
  );
}
function checkedText(usage) {
  if (usage?.check === "queued") return "Queued";
  if (usage?.check === "running") return "Checking…";
  return usage?.checkedAt ? when(usage.checkedAt) : "Not checked";
}
const CHECK_ENDED = {
  failed: "Last check failed",
  expired: "Last check expired",
};
export function PosFleet({ user }) {
  const fleet = usePoll("/pos/fleet", {
    isActive: isDeploying,
    activeMs: 15000,
    idleMs: 60000,
  });
  const rows = fleet.data?.rows ?? [],
    count = (state) => rows.filter((row) => row.state === state).length,
    // Watch switches being saved: installationId -> the wanted value.
    [pending, setPending] = useState({}),
    [problem, setProblem] = useState(""),
    [batch, setBatch] = useState({ busy: false, message: "", error: "" }),
    { checking, stalled } = checksOf(fleet.data),
    fast = checking > 0 && !stalled,
    refresh = fleet.refresh,
    watchOf = (row) => pending[row.installationId] ?? row.usage?.watch === true,
    // In the next batch: the server's `usage.batchable` (watched, not
    // retired); a watch switch being saved counts as saved.
    inBatch = (row) =>
      row.installationId in pending
        ? pending[row.installationId] && row.installationStatus !== "retired"
        : row.usage?.batchable === true,
    watched = rows.filter(inBatch).length,
    // Only the first 100 clients are listed: watched ones may be hidden, so
    // the count is not known and the server decides (409 no-watched).
    limited = fleet.data?.limited === true;
  // The one fast timer, chained: the next read is scheduled 10 s after the
  // previous one has answered, so a slow read is never cut short by the next.
  // Started when checks become active, cleared when they end or stall and on
  // unmount. Each read also re-arms usePoll's own (slower) timer.
  useEffect(() => {
    if (!fast) return undefined;
    let timer = 0,
      stopped = false;
    const next = () => {
      timer = setTimeout(async () => {
        try {
          await refresh();
        } finally {
          if (!stopped) next();
        }
      }, CHECKING_MS);
    };
    next();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [fast, refresh]);
  async function toggleWatch(row, watch) {
    const id = row.installationId;
    setPending((old) => ({ ...old, [id]: watch }));
    setProblem("");
    try {
      await api(`/installations/${id}/pos/usage/watch`, {
        method: "PUT",
        body: { watch },
      });
      await refresh();
    } catch (e) {
      setProblem(
        `${row.customerName || row.slug}: ${e.message || "The watch list could not be saved."}`,
      );
    } finally {
      setPending(({ [id]: _done, ...rest }) => rest);
    }
  }
  async function checkWatched() {
    setBatch({ busy: true, message: "", error: "" });
    let next;
    try {
      const result = await api("/pos/usage/check", {
        method: "POST",
        body: {},
      });
      next = {
        message: `Queued ${result.queued}, skipped ${result.skipped}.${result.skipped ? " Skipped clients already had a check queued or running." : ""}`,
        error: "",
      };
    } catch (e) {
      next = { message: "", error: checkError(e, { batch: true }) };
    }
    // Re-read first, so the button is never enabled on stale rows.
    try {
      await refresh();
    } finally {
      setBatch({ busy: false, ...next });
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="OPERATIONS"
        title="POS clients"
        description="Every POS installation, what is live, and how far behind its branch it is."
        action={
          <button
            className="icon-button"
            aria-label="Refresh POS clients"
            title="Refresh"
            onClick={fleet.refresh}
          >
            <RefreshCw size={16} />
          </button>
        }
      />
      <StaleBanner poll={fleet} />
      {fleet.data?.freeze?.on && (
        <div className="notice notice-warning" role="status">
          <span>
            Deploys are frozen for every client
            {fleet.data.freeze.reason ? `: ${fleet.data.freeze.reason}` : "."}
          </span>
        </div>
      )}
      {fleet.error && !fleet.data ? (
        <ErrorBox retry={fleet.refresh}>{fleet.error}</ErrorBox>
      ) : !fleet.data ? (
        <Loading />
      ) : !rows.length ? (
        <div className="panel">
          <Empty icon={Server} title="No POS clients yet">
            A client appears here once its installation has POS settings. Import
            one from the go-live file, or open a POS installation and create its
            settings.
            {can(user.role, "secrets") && (
              <>
                <br />
                <Link href="/pos-import" className="text-link">
                  Import a client
                </Link>
              </>
            )}
          </Empty>
        </div>
      ) : (
        <>
          <RolloutPanel
            user={user}
            fleet={fleet.data}
            onFleetRefresh={fleet.refresh}
          />
          <p className="fleet-summary status-line" aria-label="Summary">
            <span>
              <strong>{rows.length}</strong> client
              {rows.length === 1 ? "" : "s"}
            </span>
            {[
              "live",
              "deploying",
              "unhealthy",
              "rolled-back",
              "failed",
              "locked",
              "unverified",
            ].map(
              (state) =>
                count(state) > 0 && (
                  <span key={state}>
                    <StateBadge state={state} /> {count(state)}
                  </span>
                ),
            )}
          </p>
          <div className="usage-toolbar">
            <div className="usage-toolbar-action">
              <Button
                variant="secondary"
                busy={batch.busy}
                disabled={(!watched && !limited) || checking > 0}
                aria-describedby="usage-batch-hint"
                onClick={checkWatched}
              >
                {limited
                  ? "Check watched clients"
                  : `Check watched clients (${watched})`}
              </Button>
              <span id="usage-batch-hint" className="small subtle">
                {checking > 0
                  ? "Checks are already queued or running. Wait for them to finish."
                  : !watched && !limited
                    ? "Tick Watch for the clients you want to check."
                    : "Checks each watched client once, one at a time, in the background."}
              </span>
            </div>
            <p
              className="usage-batch-status status-line"
              role="status"
              aria-live="polite"
            >
              {batch.message}
              {checking > 0 && <span> Checking: {checking} left.</span>}
            </p>
          </div>
          {batch.error && <ErrorBox>{batch.error}</ErrorBox>}
          {problem && <ErrorBox>{problem}</ErrorBox>}
          {/* Always rendered, so the notice is announced when it appears. */}
          <div className="usage-live" aria-live="polite">
            {stalled && (
              <div className="notice notice-warning usage-waiting">
                <span>
                  {fleet.data.workerOnline === false
                    ? OFFLINE_TEXT
                    : WAITING_TEXT}
                </span>
              </div>
            )}
          </div>
          <div className="panel table-wrap usage-fleet-wrap">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Slug</th>
                  <th>Host</th>
                  <th>Live</th>
                  <th>Branch head</th>
                  <th>Behind</th>
                  <th>State</th>
                  <th>Build</th>
                  <th>Watch</th>
                  <th>Site</th>
                  <th>DB</th>
                  <th>Workers</th>
                  <th>Checked</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.installationId}
                    data-slug={row.slug}
                    className={
                      row.state === "unhealthy" ||
                      row.usage?.level === "critical"
                        ? "row-urgent"
                        : ""
                    }
                  >
                    <td>
                      <Link
                        className="table-name"
                        href={`/customers/${row.customerId}`}
                      >
                        {row.customerName || "Customer"}
                      </Link>
                    </td>
                    <td className="mono small">{row.slug}</td>
                    <td className="small">{row.host || "—"}</td>
                    <td>
                      {liveText(row)}
                      <LiveHeadline row={row} />
                      {row.live?.at && (
                        <span className="cell-subtext">
                          {when(row.live.at)}
                        </span>
                      )}
                    </td>
                    <td>
                      {row.head ? (
                        <>
                          <code>{row.head.sha7}</code>
                          <span className="cell-subtext">
                            {row.head.headline}
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{behindText(row)}</td>
                    <td>
                      <StateBadge state={row.state} />
                    </td>
                    <td className="small">
                      {row.cached === true
                        ? "Cached"
                        : row.cached === false
                          ? "Will build"
                          : "—"}
                    </td>
                    <td className="usage-watch-cell">
                      <input
                        type="checkbox"
                        aria-label={`Watch ${row.customerName || "Customer"} (${row.slug})`}
                        checked={watchOf(row)}
                        disabled={row.installationId in pending}
                        onChange={(event) =>
                          toggleWatch(row, event.target.checked)
                        }
                      />
                    </td>
                    <td>
                      {row.usage?.site ? (
                        <>
                          <SiteBadge state={row.usage.site} />
                          {row.usage.latencyMs != null && (
                            <span className="cell-subtext">
                              {ms(row.usage.latencyMs)}
                            </span>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <LevelValue fraction={row.usage?.storagePct} />
                    </td>
                    <td>
                      <LevelValue
                        fraction={
                          isToday(row.usage?.workersDay)
                            ? row.usage.workersPct
                            : null
                        }
                      />
                    </td>
                    <td className="small">
                      {checkedText(row.usage)}
                      {CHECK_ENDED[row.usage?.check] && (
                        <span className="cell-subtext">
                          {CHECK_ENDED[row.usage.check]}
                        </span>
                      )}
                    </td>
                    <td>
                      <Link
                        className="text-link"
                        href={`/installations/${row.installationId}/deploy`}
                        aria-label={`Open ${row.slug}`}
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="usage-live" aria-live="polite">
            {limited && (
              <p className="small subtle usage-limited">
                Showing the first 100 POS clients; a batch checks every watched
                client.
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}
