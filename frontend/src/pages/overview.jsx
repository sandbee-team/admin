import { useState } from "react";
import {
  Users,
  Layers3,
  ArrowUpRight,
  Clock3,
  ArrowRight,
  CircleCheck,
  KeyRound,
  ClipboardList,
  ShieldCheck,
  Search,
  Plus,
  RefreshCw,
  PanelRightOpen,
  Rocket,
} from "lucide-react";
import { useResource } from "../hooks/use-resource";
import { Resource, Badge, Empty, TextLink } from "../components/ui";
import { Link, navigate } from "../lib/router";
import { dateTime } from "../lib/api";
import { can } from "../../../shared/policy";
import { LifecycleReport } from "../components/dashboard/lifecycle-report";
import { WorkspaceBrief } from "../components/dashboard/workspace-brief";

export function Overview({ user }) {
  const resource = useResource("/overview");
  const [briefOpen, setBriefOpen] = useState(true);
  const [query, setQuery] = useState("");
  function search(event) {
    event.preventDefault();
    navigate(`/customers?search=${encodeURIComponent(query.trim())}`);
  }
  return (
    <>
      <header className="dashboard-heading">
        <div>
          <p>
            Welcome back, {user.name.split(" ")[0]}{" "}
            <span aria-hidden="true">✦</span>
          </p>
          <h1>Dashboard</h1>
        </div>
        <div className="dashboard-actions">
          <button
            className="icon-button"
            aria-label="Refresh dashboard"
            title="Refresh dashboard"
            onClick={resource.reload}
          >
            <RefreshCw size={16} />
          </button>
          {!briefOpen && (
            <button
              className="button secondary"
              onClick={() => setBriefOpen(true)}
            >
              <PanelRightOpen size={15} />
              Workspace brief
            </button>
          )}
          {can(user.role, "operate") && (
            <Link className="button secondary" href="/customers/new">
              <Plus size={15} />
              Add customer
            </Link>
          )}
        </div>
      </header>
      <Resource resource={resource}>
        {(data) => (
          <>
            <div
              className={`dashboard-layout ${briefOpen ? "" : "brief-closed"}`}
            >
              <div className="dashboard-primary">
                <div className="dashboard-intro-row">
                  <span>Everything you need to move work forward.</span>
                  <form
                    className="dashboard-search"
                    role="search"
                    onSubmit={search}
                  >
                    <Search size={16} />
                    <input
                      aria-label="Search customers"
                      placeholder="Search customers…"
                      maxLength={100}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <button type="submit" aria-label="Search customer registry">
                      <ArrowRight size={15} />
                    </button>
                  </form>
                </div>
                <div className="dashboard-summary-grid">
                  <LifecycleReport installations={data.installations} />
                  <div className="quick-stats">
                    <Metric
                      icon={Users}
                      label="Customers"
                      value={data.customers}
                      detail="Active registry"
                      href="/customers"
                    />
                    <Metric
                      icon={Layers3}
                      label="Products"
                      value={data.products}
                      detail="Active in your catalog"
                      href="/products"
                    />
                    <Metric
                      icon={Clock3}
                      label="Overdue tasks"
                      value={data.overdue}
                      detail={
                        data.overdue
                          ? "Ready for your attention"
                          : "No overdue work"
                      }
                      href="/tasks"
                    />
                  </div>
                </div>
                <div className="dashboard-detail-grid">
                  <section className="panel task-panel">
                    <div className="panel-title">
                      <div>
                        <h2>Next in the queue</h2>
                        <p>Your earliest scheduled work</p>
                      </div>
                      <TextLink href="/tasks">All tasks</TextLink>
                    </div>
                    {data.tasks.length ? (
                      <div className="task-list">
                        {data.tasks.map((task) => (
                          <Link key={task._id} href={`/tasks/${task._id}`}>
                            <span className="task-check">
                              <CircleCheck size={18} />
                            </span>
                            <div>
                              <strong>{task.title}</strong>
                              <small>{task.dueAt || "No due date"}</small>
                            </div>
                            <Badge value={task.priority} />
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <Empty icon={CircleCheck} title="A little space to plan">
                        <span>
                          No open tasks. Add follow-ups, renewals or customer
                          handovers.
                        </span>
                      </Empty>
                    )}
                    {can(user.role, "operate") && (
                      <div className="panel-foot">
                        <span>Give every next step an owner.</span>
                        <TextLink href="/tasks/new">Add a task</TextLink>
                      </div>
                    )}
                  </section>
                  <section className="panel attention-panel">
                    <div className="panel-title">
                      <div>
                        <h2>Needs attention</h2>
                        <p>Keep the important things in view</p>
                      </div>
                      <span className="attention-count">
                        {data.connections + data.overdue}
                      </span>
                    </div>
                    <div className="attention-list">
                      <Attention
                        icon={KeyRound}
                        href="/connections"
                        title="Provider connections"
                        text={
                          data.connections
                            ? `${data.connections} need review or expire within 7 days`
                            : "No recorded expiry alerts"
                        }
                      />
                      <Attention
                        icon={ClipboardList}
                        href="/tasks"
                        title="Work queue"
                        text={
                          data.overdue
                            ? `${data.overdue} overdue tasks to resolve`
                            : "No overdue tasks"
                        }
                      />
                      {can(user.role, "credentials") &&
                        data.pos &&
                        posAttention(data.pos).map((item) => (
                          <Attention
                            key={item.title}
                            icon={Rocket}
                            href="/pos-clients"
                            title={item.title}
                            text={item.text}
                          />
                        ))}
                      {can(user.role, "recovery") && (
                        <Attention
                          icon={ShieldCheck}
                          href="/recovery"
                          title="Recovery readiness"
                          text={
                            data.latestRecovery
                              ? `Last drill: ${data.latestRecovery.restoredAt}`
                              : "Record your first restore drill"
                          }
                        />
                      )}
                    </div>
                  </section>
                </div>
                <section className="panel recent-panel">
                  <div className="panel-title">
                    <div>
                      <h2>Recent changes</h2>
                      <p>A record of who changed what</p>
                    </div>
                    <TextLink href="/audit">Audit trail</TextLink>
                  </div>
                  <div className="recent-changes">
                    {data.activity.length ? (
                      data.activity.slice(0, 4).map((event) => (
                        <div key={event._id}>
                          <span className="change-avatar">
                            {event.actorName?.slice(0, 1) || "S"}
                          </span>
                          <div>
                            <strong>{event.actorName}</strong>
                            <p>{event.action.replaceAll(".", " ")}</p>
                          </div>
                          <time>{dateTime(event.createdAt)}</time>
                        </div>
                      ))
                    ) : (
                      <p>No changes recorded yet.</p>
                    )}
                  </div>
                </section>
              </div>
              {briefOpen && (
                <WorkspaceBrief
                  data={data}
                  onClose={() => setBriefOpen(false)}
                />
              )}
            </div>
            <p className="data-footnote">
              Snapshot {dateTime(data.asOf)} · Counts represent records, not
              provider health or billable usage.
            </p>
          </>
        )}
      </Resource>
    </>
  );
}
// POS fleet problems worth a look, from the counts in the overview.
function posAttention(pos) {
  const items = [];
  if (pos.failed)
    items.push({
      title: "POS deploys failed",
      text: `${pos.failed} client${pos.failed === 1 ? "" : "s"} with a failed deploy`,
    });
  if (pos.unverified)
    items.push({
      title: "POS clients unverified",
      text: `${pos.unverified} need a fresh credential check`,
    });
  if (pos.locked)
    items.push({
      title: "POS clients locked",
      text: `${pos.locked} locked against admin deploys`,
    });
  if (!pos.workerOnline && (pos.failed || pos.unverified || pos.locked))
    items.push({
      title: "POS deploy worker offline",
      text: "Deploys cannot run until the worker is back",
    });
  return items;
}
function Metric({ icon: Icon, label, value, detail, href }) {
  return (
    <Link className="quick-stat" href={href}>
      <span className="stat-icon">
        <Icon size={16} />
      </span>
      <ArrowUpRight size={15} className="stat-arrow" />
      <div>
        <span>{label}</span>
        <small>{detail}</small>
      </div>
      <strong>{value.toLocaleString("en-IN")}</strong>
    </Link>
  );
}
function Attention({ icon: Icon, href, title, text }) {
  return (
    <Link href={href}>
      <span className="attention-icon">
        <Icon size={17} />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
      <ArrowUpRight size={15} />
    </Link>
  );
}
