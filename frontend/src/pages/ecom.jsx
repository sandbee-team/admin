import { useState } from "react";
import { api } from "../lib/api";
import { useResource } from "../hooks/use-resource";
import {
  PageTitle,
  Resource,
  Badge,
  Button,
  Field,
  Select,
  ErrorBox,
  Empty,
} from "../components/ui";
import { can } from "../../../shared/policy";
export function EcomPage({ user }) {
  const [page, setPage] = useState(1),
    resource = useResource(`/ecom/tenants?page=${page}`),
    [selected, setSelected] = useState(null),
    [plan, setPlan] = useState("starter"),
    [state, setState] = useState("active"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  function edit(row) {
    setSelected(row);
    setPlan(row.subscription.plan);
    setState(
      row.subscription.state === "pending" ? "active" : row.subscription.state,
    );
    setError("");
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api(`/ecom/tenants/${selected._id}/subscription`, {
        method: "PUT",
        body: {
          plan,
          state,
          expiresAt: new Date(
            form.get("expires") + "T23:59:59.000Z",
          ).toISOString(),
          reason: form.get("reason"),
          revision: selected.subscription.revision ?? 0,
        },
      });
      setSelected(null);
      resource.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="PRODUCT OPERATIONS"
        title="Sandbee Ecom"
        description="Seller workspaces, subscription access and allowances. Money collection remains separate."
      />
      {selected && (
        <section className="panel">
          <div className="panel-title">
            <h2>Manage {selected.name}</h2>
            <Button variant="secondary" onClick={() => setSelected(null)}>
              Close
            </Button>
          </div>
          <form key={selected._id} className="edit-form" onSubmit={save}>
            {error && <ErrorBox>{error}</ErrorBox>}
            <div className="form-section">
              <div className="form-grid">
                <Field label="Plan">
                  <Select
                    value={plan}
                    onChange={(e) => setPlan(e.target.value)}
                    options={["starter", "growth", "scale"]}
                  />
                </Field>
                <Field label="Access state">
                  <Select
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    options={["active", "suspended", "cancelled"]}
                  />
                </Field>
                <Field label="Access expiry (end of day UTC)">
                  <input
                    name="expires"
                    type="date"
                    required
                    defaultValue={new Date(
                      Math.max(
                        Date.now() + 30 * 86400000,
                        new Date(selected.subscription.expiresAt).getTime() ||
                          0,
                      ),
                    )
                      .toISOString()
                      .slice(0, 10)}
                  />
                </Field>
                <Field label="Reason / offline agreement reference">
                  <input
                    name="reason"
                    required
                    minLength={10}
                    maxLength={500}
                  />
                </Field>
              </div>
              <p className="data-footnote">
                Starter: 3 accounts / 10,000 monthly orders / 3 seats. Growth:
                10 / 100,000 / 10. Scale: 30 / 1,000,000 / 30. These are
                entitlement limits, not a throughput guarantee or a price quote.
              </p>
            </div>
            <div className="form-actions">
              <Button busy={busy} type="submit">
                Save subscription
              </Button>
            </div>
          </form>
        </section>
      )}
      <Resource resource={resource}>
        {(data) =>
          data.connected === false ? (
            <section className="panel">
              <Empty title="Ecom is not connected yet">
                Connect the Ecom service when it is ready to manage seller
                subscriptions here. Your other Admin tools remain available.
              </Empty>
            </section>
          ) : (
            <section className="panel">
              <div className="panel-title">
                <h2>Seller workspaces</h2>
                <span className="subtle">{data.total} workspaces</span>
              </div>
              {data.items.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Company</th>
                        <th>Plan</th>
                        <th>Access</th>
                        <th>Expires (UTC)</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((row) => (
                        <tr key={row._id}>
                          <td>
                            {row.name}
                            <small className="cell-subtext mono">
                              {row._id}
                            </small>
                            {row.demo && (
                              <Badge value="planned">Sample workspace</Badge>
                            )}
                          </td>
                          <td>{row.subscription.plan}</td>
                          <td>
                            <Badge value={row.subscription.state}>
                              {row.subscription.state}
                            </Badge>
                          </td>
                          <td>
                            {new Date(row.subscription.expiresAt).getTime() > 0
                              ? new Date(
                                  row.subscription.expiresAt,
                                ).toLocaleDateString("en-IN", {
                                  dateStyle: "medium",
                                  timeZone: "UTC",
                                })
                              : "Not activated"}
                          </td>
                          <td>
                            {can(user.role, "catalog") ? (
                              <Button
                                variant="secondary"
                                onClick={() => edit(row)}
                              >
                                Manage access
                              </Button>
                            ) : (
                              "Read-only"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="No seller workspaces yet">
                  Companies appear here after verified Ecom signup.
                </Empty>
              )}
              <div className="panel-foot">
                <Button
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>{" "}
                <span className="subtle">Page {page}</span>{" "}
                <Button
                  variant="secondary"
                  disabled={page * 50 >= data.total}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </section>
          )
        }
      </Resource>
      <p className="data-footnote">
        Subscription changes are version-checked and committed with an audit
        event in Ecom. A suspension blocks new imports; historical reports stay
        readable. This panel does not charge customers or claim marketplace API
        approval.
      </p>
    </>
  );
}
