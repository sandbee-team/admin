import { RefreshCw } from "lucide-react";
import { Badge, Button, ErrorBox, Loading } from "../ui";
import { dateTime } from "../../lib/api";
import { minutes, sha7, when } from "./format";
const cacheChip = (branch, cacheOn) =>
  branch.cached === true ? (
    <Badge value="done">Build ready (cached)</Badge>
  ) : branch.cached === false ? (
    <Badge value="paused">Will build</Badge>
  ) : (
    <span className="small subtle">
      {cacheOn ? "Build state unknown" : "Build cache off"}
    </span>
  );
// The "what will happen" lines for one branch, from the deploy plan.
export function PlanSummary({ plan, live }) {
  if (plan.error) return <ErrorBox retry={plan.reload}>{plan.error}</ErrorBox>;
  if (plan.loading || !plan.data)
    return <p role="status">Checking this branch…</p>;
  const p = plan.data,
    r = p.relation,
    c = p.cache;
  const relation = !r
    ? live
      ? "Could not compare with the live version."
      : "Nothing is live from admin yet, so this is the first deploy."
    : r.status === "identical"
      ? "Same commit as the live version."
      : r.status === "ahead"
        ? `${r.behindBy} commit${r.behindBy === 1 ? "" : "s"} newer than live.`
        : r.status === "behind"
          ? `${r.aheadBy} commit${r.aheadBy === 1 ? "" : "s"} older than live. Deploying goes back in time.`
          : "Has a different history from live (diverged).";
  const build =
    c.state === "cached"
      ? `Build ready (cached${c.builtAt ? `, built ${when(c.builtAt)}` : ""}). No new build needed.`
      : c.state === "will-build"
        ? `Will build first (~${p.estimateMs ? minutes(p.estimateMs) : "a few"} min).`
        : c.state === "off"
          ? "Build cache is off: this deploy builds first."
          : "Build storage is unavailable: this deploy builds first if needed.";
  return (
    <div className="plan-summary" aria-live="polite" data-cache={c.state}>
      <p>
        <strong>{p.branch}</strong>@<code>{sha7(p.head.sha)}</code>{" "}
        {p.head.headline}
      </p>
      <ul>
        <li>{relation}</li>
        <li>{build}</li>
        {p.settingsChanged && (
          <li>
            Settings changed since the live build, so a new build is needed.
          </li>
        )}
      </ul>
    </div>
  );
}
export function BranchPicker({
  branches,
  selected,
  onSelect,
  plan,
  live,
  cacheOn,
}) {
  return (
    <div className="branch-picker">
      <div className="branch-bar">
        <h3 id="branch-title">Pick a branch</h3>
        <Button
          variant="secondary"
          onClick={branches.reload}
          aria-label="Reload branches"
        >
          <RefreshCw size={14} />
          Reload
        </Button>
      </div>
      {branches.loading || (!branches.data && !branches.error) ? (
        <Loading />
      ) : branches.error ? (
        <ErrorBox retry={branches.reload}>{branches.error}</ErrorBox>
      ) : !branches.data.branches.length ? (
        <p className="small subtle">
          No branches were found in the source repository.
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-labelledby="branch-title"
          className="branch-list"
        >
          {branches.data.branches.map((branch) => (
            <label
              key={branch.name}
              className={`branch-option ${selected === branch.name ? "is-selected" : ""}`}
            >
              <input
                type="radio"
                name="branch"
                value={branch.name}
                checked={selected === branch.name}
                onChange={() => onSelect(branch.name)}
              />
              <span className="branch-main">
                <strong>{branch.name}</strong>
                <code>{sha7(branch.sha)}</code>
                {live?.sha === branch.sha && <Badge value="live">Live</Badge>}
                <span className="branch-headline">{branch.headline}</span>
                <span className="small subtle">
                  {branch.date
                    ? `${when(branch.date)} · ${dateTime(branch.date)}`
                    : ""}
                </span>
              </span>
              <span className="branch-cache">{cacheChip(branch, cacheOn)}</span>
            </label>
          ))}
        </div>
      )}
      {selected && plan && <PlanSummary plan={plan} live={live} />}
    </div>
  );
}
