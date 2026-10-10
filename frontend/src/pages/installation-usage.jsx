import { useState } from "react";
import { Activity, Server, TriangleAlert } from "lucide-react";
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
import { api, dateTime } from "../lib/api";
import { StaleBanner } from "../components/deploy/stale-banner";
import { Meter } from "../components/usage/meter";
import { LevelBadge, SiteBadge } from "../components/usage/badges";
import {
  NO_ACTION,
  OFFLINE_TEXT,
  ROLE_TEXT,
  WAITING_TEXT,
  checkError,
  checkText,
  count,
  describeUsageCode,
  isChecking,
  isToday,
  levelOf,
  levelSuffix,
  mb,
  ms,
  pct,
  tokenState,
} from "../components/usage/format";
// One POS client's usage (docs/PHASE2-PLAN.md §9): the current status only,
// checked when the owner asks. No history and no charts over time.
const active = (data) => isChecking(data?.check?.status);
// Re-read every 5 s only while the check can make progress; otherwise 60 s.
// `stalled` is the server's answer (server clock): the worker is offline, or
// this check has been queued for over 10 minutes while none is running.
const fastPoll = (data) => active(data) && data.stalled !== true;
const SOURCE_TEXT = {
  health: "From the POS health stats",
  direct: "Direct check — core cluster only",
};
export function InstallationUsage({ installation }) {
  const id = installation._id,
    base = `/installations/${id}/pos/usage`,
    poll = usePoll(base, { isActive: fastPoll, activeMs: 5000, idleMs: 60000 }),
    [busy, setBusy] = useState(""),
    [wantWatch, setWantWatch] = useState(null),
    [problem, setProblem] = useState("");
  const data = poll.data;
  if (!data) {
    if (poll.loading) return <Loading />;
    if (poll.status === 404)
      return (
        <div className="panel">
          <Empty icon={Server} title="POS settings have not been created">
            Create this client’s POS settings first, then come back to check its
            usage.
            <br />
            <Link href={`/installations/${id}/pos`} className="text-link">
              Open POS setup
            </Link>
          </Empty>
        </div>
      );
    return <ErrorBox retry={poll.refresh}>{poll.error}</ErrorBox>;
  }
  const check = data.check,
    last = data.last,
    running = active(data),
    now = Date.now(),
    // One notice at a time: the offline one, else (worker online) the
    // waiting one, only for a check that is still queued.
    waiting =
      data.workerOnline && data.stalled === true && check?.status === "queued",
    reason = running
      ? "A check is already queued or running for this client."
      : !data.workerOnline
        ? "The worker is offline, so no check can run."
        : "";
  // Both actions re-read BEFORE letting go of the busy flag, so the control
  // is never re-enabled on stale data.
  async function setWatch(watch) {
    setBusy("watch");
    setWantWatch(watch);
    setProblem("");
    try {
      try {
        await api(`${base}/watch`, { method: "PUT", body: { watch } });
      } catch (e) {
        setProblem(e.message || "The watch list could not be saved.");
      }
      await poll.refresh();
    } finally {
      setWantWatch(null);
      setBusy("");
    }
  }
  async function checkNow() {
    setBusy("check");
    setProblem("");
    try {
      try {
        await api(`${base}/check`, { method: "POST", body: {} });
      } catch (e) {
        setProblem(checkError(e));
      }
      await poll.refresh();
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <PageTitle
        eyebrow={installation.name}
        title="Usage"
        description="This client’s current site, database storage, Worker requests and token expiry. Checked only when you ask; only the latest result is kept."
        action={
          <Badge value={data.workerOnline ? "done" : "disabled"}>
            {data.workerOnline ? "Worker online" : "Worker offline"}
          </Badge>
        }
      />
      <div className="usage-stack">
        <StaleBanner poll={poll} />
        <section
          className="panel usage-status"
          aria-labelledby="usage-status-title"
          data-status={check?.status || "none"}
        >
          <div className="panel-title">
            <div>
              <h2 id="usage-status-title">Usage check</h2>
              <p>
                Runs once in the background worker when you press Check now.
                Nothing runs on a schedule.
              </p>
            </div>
          </div>
          <div className="usage-body">
            {/* Always rendered, so a notice added later is announced. */}
            <div className="usage-live" aria-live="polite">
              {!data.workerOnline ? (
                <div className="notice notice-warning usage-note usage-offline">
                  <TriangleAlert size={16} aria-hidden="true" />
                  <span>{OFFLINE_TEXT}</span>
                </div>
              ) : waiting ? (
                <div className="notice notice-warning usage-note usage-waiting">
                  <TriangleAlert size={16} aria-hidden="true" />
                  <span>{WAITING_TEXT}</span>
                </div>
              ) : null}
            </div>
            {!data.hasHost && (
              <div className="notice notice-warning usage-note">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>
                  No web address is set for this client, so its site, stats and
                  tokens cannot be checked.{" "}
                  <Link href={`/installations/${id}/pos`}>Open POS setup</Link>
                </span>
              </div>
            )}
            <div className="usage-watch">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={wantWatch ?? data.watch}
                  disabled={busy === "watch"}
                  aria-describedby="usage-watch-hint"
                  onChange={(event) => setWatch(event.target.checked)}
                />
                Watch this client
              </label>
              <span id="usage-watch-hint" className="small subtle">
                Watched clients are checked together by “Check watched clients”
                on the POS clients page.
              </span>
            </div>
            {problem && <ErrorBox>{problem}</ErrorBox>}
            <div className="usage-check-row">
              <Button
                busy={busy === "check"}
                disabled={Boolean(reason)}
                aria-describedby="usage-check-why"
                onClick={checkNow}
              >
                Check now
              </Button>
              <span id="usage-check-why" className="small subtle">
                {reason ||
                  "Checks once, usually within 3–15 seconds of the worker picking it up."}
              </span>
            </div>
            <p className="usage-check-status" role="status" aria-live="polite">
              {checkText(check, now)}
            </p>
          </div>
        </section>
        {!last ? (
          <div className="panel">
            <Empty icon={Activity} title="Not checked yet">
              Press Check now to see this client’s site, database storage,
              Worker requests and token expiry.
            </Empty>
          </div>
        ) : (
          <div className="usage-grid">
            <ResultPanel last={last} />
            <SitePanel site={last.site} />
            <WorkersPanel
              cf={last.cloudflare}
              limit={data.limits.workerRequests}
              now={now}
            />
            <StoragePanel mongo={last.mongo} limit={data.limits.mongoBytes} />
            <TokensPanel credentials={last.credentials} now={now} />
            <HobbyPanel hobby={data.hobby} />
          </div>
        )}
      </div>
    </>
  );
}
function Panel({ id, title, text, extra, className = "", children }) {
  return (
    <section
      className={`panel usage-panel ${className}`}
      aria-labelledby={`${id}-title`}
    >
      <div className="panel-title">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {text && <p>{text}</p>}
        </div>
        {extra}
      </div>
      <div className="usage-body">{children}</div>
    </section>
  );
}
// A stored code as a notice: title, plain message and what to do.
function CodeNote({ code }) {
  const entry = describeUsageCode(code);
  return (
    <div className="notice notice-warning usage-note" data-code={code}>
      <TriangleAlert size={16} aria-hidden="true" />
      <div>
        <p>
          <strong>{entry.title}</strong>
        </p>
        <p>{entry.plainMessage}</p>
        {entry.action !== NO_ACTION && (
          <p className="small">What to do: {entry.action}</p>
        )}
      </div>
    </div>
  );
}
const seconds = (value) =>
  `${(Math.round(value / 100) / 10).toLocaleString("en-IN")} s`;
function ResultPanel({ last }) {
  return (
    <Panel
      id="usage-result"
      className="usage-wide usage-result"
      title="Latest result"
      text={`Checked ${dateTime(last.at)}${last.durationMs != null ? ` · took ${seconds(last.durationMs)}` : ""}`}
      extra={<LevelBadge level={last.level} />}
    >
      <h3 className="usage-subtitle">Alerts of this check</h3>
      {last.alerts.length ? (
        <ul className="usage-alerts">
          {last.alerts.map((alert) => (
            <li key={alert.type}>
              <div>
                <strong>{alert.title}</strong>
                {alert.detail && (
                  <span className="small subtle">{alert.detail}</span>
                )}
              </div>
              <LevelBadge level={alert.level} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="small subtle">No alerts in the last check.</p>
      )}
    </Panel>
  );
}
function SitePanel({ site }) {
  return (
    <Panel
      id="usage-site"
      className="usage-site"
      title="Site"
      text="Our health probe of the POS: up to 3 tries, 5 seconds apart."
      extra={<SiteBadge state={site.state} />}
    >
      <dl className="usage-facts">
        <div>
          <dt>Response time</dt>
          <dd>{ms(site.latencyMs)}</dd>
        </div>
        <div>
          <dt>HTTP status</dt>
          <dd>{site.httpStatus || "—"}</dd>
        </div>
        <div>
          <dt>Probes</dt>
          <dd>{site.probes ?? "—"}</dd>
        </div>
      </dl>
      {site.code !== "ok" && <CodeNote code={site.code} />}
      {site.deployActive && (
        <p className="small subtle">
          A deploy or rollback was running during this check, so a failed probe
          was not raised as an alert.
        </p>
      )}
    </Panel>
  );
}
function storageText(cluster, limit) {
  const used = Number.isFinite(cluster.bytes)
    ? `${mb(cluster.bytes)} of ${mb(limit)}`
    : `Used of ${mb(limit)}`;
  return `${used} · ${pct(cluster.usedPct)}${levelSuffix(levelOf(cluster.usedPct))}`;
}
function StoragePanel({ mongo, limit }) {
  const statsNote = mongo.statsCode && mongo.statsCode !== "ok";
  return (
    <Panel
      id="usage-storage"
      className="usage-wide usage-storage"
      title="Database storage"
      text={`Data plus indexes of each MongoDB Atlas M0 cluster, against its ${mb(limit)} limit.`}
    >
      {mongo.source && (
        <p className="small subtle usage-source">{SOURCE_TEXT[mongo.source]}</p>
      )}
      {statsNote && <CodeNote code={mongo.statsCode} />}
      {mongo.clusters.length ? (
        <ul className="usage-clusters">
          {mongo.clusters.map((cluster) => (
            <li key={cluster.name} className="usage-cluster">
              <div className="usage-cluster-head">
                <strong className="mono">{cluster.name}</strong>
                <span className="small subtle">
                  {[ROLE_TEXT[cluster.role], cluster.label]
                    .filter(Boolean)
                    .join(" ")}
                </span>
                {cluster.active && <Badge value="ready">Active</Badge>}
                {cluster.paused && <Badge value="paused">Paused</Badge>}
              </div>
              {cluster.state === "ok" && cluster.usedPct != null ? (
                <Meter
                  fraction={cluster.usedPct}
                  label={`${cluster.name} storage`}
                  text={storageText(cluster, limit)}
                />
              ) : (
                <p className="small">
                  Not measured: the POS could not read this cluster this time.
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : mongo.code !== mongo.statsCode || !statsNote ? (
        <CodeNote code={mongo.code} />
      ) : null}
    </Panel>
  );
}
function WorkersPanel({ cf, limit, now }) {
  const today = cf.code === "ok" && isToday(cf.day, now) && cf.requests != null,
    fraction = today ? cf.requests / limit : null;
  return (
    <Panel
      id="usage-workers"
      className="usage-workers"
      title="Cloudflare Workers"
      text={`Requests of the client’s whole Cloudflare account, against the free ${count(limit)} a day.`}
    >
      {today ? (
        <>
          <Meter
            fraction={fraction}
            label="Worker requests today"
            text={`${count(cf.requests)} of ${count(limit)} requests today · ${pct(fraction)}${levelSuffix(levelOf(fraction))}`}
          />
          <p className="small subtle">
            Resets daily at 05:30 IST (00:00 UTC).
            {cf.errors ? ` ${count(cf.errors)} errors so far today.` : ""}
          </p>
          {cf.yesterday?.requests != null && (
            <p className="small">
              Yesterday: {count(cf.yesterday.requests)} requests.
            </p>
          )}
        </>
      ) : cf.code === "ok" ? (
        <p className="small">
          The last count is from {cf.day || "an earlier day"} (UTC):{" "}
          {count(cf.requests)} requests. Today’s count is not known yet — check
          again.
        </p>
      ) : (
        <CodeNote code={cf.code} />
      )}
    </Panel>
  );
}
function TokensPanel({ credentials, now }) {
  return (
    <Panel
      id="usage-tokens"
      className="usage-tokens"
      title="Tokens"
      text="When the Vercel and Cloudflare tokens stored for this client expire."
    >
      <dl className="usage-token-list">
        {[
          ["Vercel token", credentials.vercel],
          ["Cloudflare token", credentials.cloudflare],
        ].map(([name, token]) => {
          const state = tokenState(token, now);
          return (
            <div key={name}>
              <dt>{name}</dt>
              <dd>
                <span className="usage-token-state">
                  <strong>{state.text}</strong>
                  <LevelBadge level={state.level} />
                </span>
                {state.detail && (
                  <span className="cell-subtext">{state.detail}</span>
                )}
                {state.action && (
                  <span className="small usage-token-action">
                    What to do: {state.action}
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </Panel>
  );
}
function HobbyPanel({ hobby }) {
  return (
    <Panel
      id="usage-hobby"
      className="usage-hobby"
      title="Vercel (Hobby)"
      text="Reference only: nothing here is measured."
    >
      <p className="usage-honest">
        Vercel shows no usage numbers on the Hobby plan, so bandwidth, CPU and
        invocations are not measured here. Check the client’s Vercel dashboard →
        Usage.
      </p>
      <p className="small subtle">Included per month on Hobby:</p>
      <dl className="usage-facts">
        {hobby.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
