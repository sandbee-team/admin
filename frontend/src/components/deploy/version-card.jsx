import { Badge, Button } from "../ui";
import { dateTime } from "../../lib/api";
import { sha7, when } from "./format";
const BUILT = {
  cache: "Reused a cached build",
  fresh: "Built fresh",
  artifact: "Built on GitHub",
};
// One deployed version: the live one or the rollback target.
export function VersionCard({ title, version, empty, action }) {
  return (
    <section
      className="panel version-card"
      aria-label={title}
      data-version={title.split(" ")[0].toLowerCase()}
    >
      <div className="version-head">
        <h3>{title}</h3>
        {version && (
          <Badge value={version.status === "pre-admin" ? "paused" : "live"}>
            {version.status === "rolled-back-to"
              ? "Restored by rollback"
              : version.status === "pre-admin"
                ? "Before admin"
                : "Deployed"}
          </Badge>
        )}
      </div>
      {version ? (
        <>
          <p className="version-commit">
            <code>
              {version.branch || "unknown branch"}@{sha7(version.sha)}
            </code>
          </p>
          <p>{version.commit?.headline || "No commit message recorded."}</p>
          {version.commit?.authorName && (
            <p className="small subtle">
              {version.commit.authorName}
              {version.commit.date ? ` · ${when(version.commit.date)}` : ""}
            </p>
          )}
          <dl className="version-facts">
            <div>
              <dt>When</dt>
              <dd>
                {dateTime(version.at)}{" "}
                <span className="subtle">({when(version.at)})</span>
              </dd>
            </div>
            <div>
              <dt>By</dt>
              <dd>{version.by?.name || "Unknown"}</dd>
            </div>
            {version.build && (
              <div>
                <dt>Build</dt>
                <dd>
                  {BUILT[version.build.source] || "Build"}
                  {version.build.key8 && (
                    <>
                      {" "}
                      <code>#{version.build.key8}</code>
                    </>
                  )}
                </dd>
              </div>
            )}
          </dl>
          {version.runUrl && (
            <a
              className="text-link"
              href={version.runUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open GitHub run ↗
            </a>
          )}
          {action &&
            (action.reason ? (
              <p className="small subtle">{action.reason}</p>
            ) : (
              <Button variant="secondary" onClick={action.onClick}>
                {action.label}
              </Button>
            ))}
        </>
      ) : (
        <p className="small subtle">{empty}</p>
      )}
    </section>
  );
}
