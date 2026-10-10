import { RefreshCw, Server } from "lucide-react";
import { Badge, Empty, ErrorBox, Loading, PageTitle } from "../components/ui";
import { Link } from "../lib/router";
import { usePoll } from "../hooks/use-poll";
import { can } from "../../../shared/policy";
import { StaleBanner } from "../components/deploy/stale-banner";
import { when } from "../components/deploy/format";
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
const isBusy = (data) =>
  Boolean(data?.rows.some((r) => r.state === "deploying"));
export function PosFleet({ user }) {
  const fleet = usePoll("/pos/fleet", {
    isActive: isBusy,
    activeMs: 15000,
    idleMs: 60000,
  });
  const rows = fleet.data?.rows ?? [],
    count = (state) => rows.filter((row) => row.state === state).length;
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
          <div className="panel table-wrap">
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
                    className={row.state === "unhealthy" ? "row-urgent" : ""}
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
          {fleet.data.limited && (
            <p className="small subtle">Showing the first 100 clients.</p>
          )}
        </>
      )}
    </>
  );
}
