import { useState } from "react";
import { Select, TextLink } from "../ui";
import { INSTALL_STATES } from "../../../../shared/policy";

export function LifecycleReport({ installations }) {
  const [scope, setScope] = useState("active");
  const states = INSTALL_STATES.filter(
    (state) => scope === "all" || state !== "retired",
  );
  const rows = states.map((state) => ({
    state,
    count: installations.find((item) => item._id === state)?.count || 0,
  }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <section className="lifecycle-report" aria-labelledby="delivery-heading">
      <div className="report-title">
        <h2 id="delivery-heading">Delivery overview</h2>
        <Select
          aria-label="Installation scope"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          options={[
            { value: "active", label: "Active records" },
            { value: "all", label: "All records" },
          ]}
        />
      </div>
      <div className="delivery-total">
        <strong>{total.toLocaleString("en-IN")}</strong>
        <span>
          installation{total === 1 ? "" : "s"}
          <small>
            {scope === "active"
              ? "Excludes retired records"
              : "Across every lifecycle stage"}
          </small>
        </span>
      </div>
      <div
        className={`lifecycle-spectrum ${total ? "" : "is-empty"}`}
        role="img"
        aria-label={
          total
            ? rows.map(({ state, count }) => `${state}: ${count}`).join(", ")
            : "No installation records in this scope"
        }
      >
        {total ? (
          rows
            .filter((row) => row.count)
            .map(({ state, count }) => (
              <span
                key={state}
                style={{ flex: count, background: `var(--stage-${state})` }}
                title={`${state}: ${count}`}
              />
            ))
        ) : (
          <span />
        )}
      </div>
      <div className="lifecycle-legend">
        {rows.map(({ state, count }) => (
          <div key={state}>
            <i style={{ background: `var(--stage-${state})` }} />
            <span>{state}</span>
            <strong>{count}</strong>
          </div>
        ))}
      </div>
      <div className="report-foot">
        <span>
          {total
            ? "Recorded delivery stages"
            : "Your first installation will appear here"}
        </span>
        <TextLink href="/installations">View records</TextLink>
      </div>
    </section>
  );
}
