import { Badge, Button } from "../ui";
import { Link } from "../../lib/router";
import { dateTime } from "../../lib/api";
import { ITEM_TITLES, when } from "./format";
const CHIP = {
  ok: ["done", "Ready"],
  warn: ["paused", "Heads up"],
  blocked: ["disabled", "Needs attention"],
};
const GROUPS = [
  ["admin", "Admin setup", "Shared by every client."],
  ["client", "This client", "Settings and checks for this installation."],
];
function Fix({ fix }) {
  if (!fix) return null;
  return fix.kind === "link" ? (
    <Link href={fix.to} className="text-link">
      {fix.label}
    </Link>
  ) : (
    <span className="small subtle">{fix.text}</span>
  );
}
// actions: { [itemId]: {label, onClick, busy, reason} }. A reason means the
// action exists but cannot be used (shown as text, never a dead button).
export function ReadinessChecklist({ readiness, verify, actions = {} }) {
  return (
    <section className="panel" aria-labelledby="readiness-title">
      <div className="panel-title">
        <div>
          <h2 id="readiness-title">Is this client ready?</h2>
          <p>
            {readiness.ready
              ? "Everything required is in place."
              : "Fix the items marked “Needs attention” before deploying."}
          </p>
        </div>
        <Badge value={readiness.ready ? "done" : "disabled"}>
          {readiness.ready ? "Ready to deploy" : "Not ready"}
        </Badge>
      </div>
      <div className="check-groups">
        {GROUPS.map(([group, title, hint]) => {
          const items = readiness.items.filter((item) => item.group === group),
            good = items.filter((item) => item.state === "ok").length;
          return (
            <div key={group} className="check-group">
              <h3>
                {title}
                <span className="small subtle">
                  {" "}
                  {good} of {items.length} ready
                </span>
              </h3>
              <p className="small subtle">{hint}</p>
              <ul className="check-list">
                {items.map((item) => {
                  const [chip, text] = CHIP[item.state] || CHIP.blocked,
                    action = actions[item.id];
                  return (
                    <li
                      key={item.id}
                      className="check-item"
                      data-item={item.id}
                      data-state={item.state}
                    >
                      <Badge value={chip}>{text}</Badge>
                      <div className="check-body">
                        <strong>{ITEM_TITLES[item.id] || item.id}</strong>
                        {item.reason && (
                          <span className="small subtle">{item.reason}</span>
                        )}
                        {item.id === "verified" && verify?.at && (
                          <span className="small subtle">
                            Last verified {dateTime(verify.at)} (
                            {when(verify.at)})
                          </span>
                        )}
                      </div>
                      <div className="check-fix">
                        <Fix fix={item.state === "ok" ? null : item.fix} />
                        {action &&
                          item.state !== "ok" &&
                          (action.reason ? (
                            <span className="small subtle">
                              {action.reason}
                            </span>
                          ) : (
                            <Button
                              variant="secondary"
                              busy={action.busy}
                              onClick={action.onClick}
                            >
                              {action.label}
                            </Button>
                          ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
