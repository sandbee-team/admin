import { useState } from "react";
import {
  Layers3,
  X,
  ArrowUpRight,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import { useResource } from "../../hooks/use-resource";
import { Resource, Badge } from "../ui";
import { ProductIcon } from "../product-icon";
import { Link } from "../../lib/router";
import { dateTime } from "../../lib/api";
import { modelFor } from "../../../../shared/product-models";

export function WorkspaceBrief({ data, onClose }) {
  const [view, setView] = useState("summary");
  const active = data.installations
    .filter((row) => row._id !== "retired")
    .reduce((sum, row) => sum + row.count, 0);
  const live = data.installations.find((row) => row._id === "live")?.count || 0;
  const percent = active ? Math.round((live / active) * 100) : 0;
  return (
    <aside className="workspace-brief" aria-label="Workspace brief">
      <div className="brief-heading">
        <span className="brief-symbol">
          <Layers3 size={20} />
        </span>
        <div>
          <h2>Workspace brief</h2>
          <p>Sandbee Admin</p>
        </div>
        <button
          className="icon-button"
          aria-label="Close workspace brief"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="brief-summary">
        <div>
          <span>Active products</span>
          <strong>{data.products.toLocaleString("en-IN")}</strong>
          <small>In your product catalog</small>
        </div>
        <div className="live-ring">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle className="ring-track" cx="50" cy="50" r="43" />
            <circle
              className="ring-value"
              cx="50"
              cy="50"
              r="43"
              pathLength="100"
              strokeDasharray={`${percent} 100`}
            />
          </svg>
          <div>
            <strong>{active ? `${percent}%` : "—"}</strong>
            <span>live</span>
          </div>
        </div>
      </div>
      <p className="brief-definition">
        {active
          ? `${live} of ${active} active installation records are live.`
          : "Live coverage appears after you add an installation."}
      </p>
      <div
        className="brief-view-switch"
        role="group"
        aria-label="Workspace brief view"
      >
        {["summary", "activity", "products"].map((tab) => (
          <button
            key={tab}
            onClick={() => setView(tab)}
            aria-pressed={view === tab}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="brief-content">
        {view === "summary" && (
          <>
            <div className="brief-facts">
              <Link href="/customers">
                <span>Customers</span>
                <strong>{data.customers}</strong>
                <ArrowUpRight size={15} />
              </Link>
              <Link href="/tasks">
                <span>Overdue tasks</span>
                <strong>{data.overdue}</strong>
                <ArrowUpRight size={15} />
              </Link>
            </div>
            <div className="brief-note">
              <CheckCircle2 size={19} />
              <div>
                <h3>
                  {data.overdue
                    ? "A few things need a look"
                    : "Keep your next step clear"}
                </h3>
                <p>
                  {data.overdue
                    ? "Review outstanding tasks and agree the next step with your team."
                    : "Track customer setup, provider access and handover in one place."}
                </p>
              </div>
            </div>
            <Link className="brief-action" href="/products">
              Explore your products <ArrowRight size={16} />
            </Link>
            <div className="brief-timestamp">
              <span>Latest snapshot</span>
              <time>{dateTime(data.asOf)}</time>
            </div>
          </>
        )}
        {view === "activity" && (
          <div className="brief-activity">
            {data.activity.length ? (
              data.activity.map((event) => (
                <div key={event._id}>
                  <i />
                  <div>
                    <strong>{event.actorName}</strong>
                    <p>{event.action.replaceAll(".", " ")}</p>
                    <small>{dateTime(event.createdAt)}</small>
                  </div>
                </div>
              ))
            ) : (
              <p>No activity recorded yet.</p>
            )}
            <Link className="brief-action" href="/audit">
              Full audit trail <ArrowRight size={16} />
            </Link>
          </div>
        )}
        {view === "products" && <BriefProducts />}
      </div>
      <p className="brief-disclaimer">
        Record-based summary · provider health and billing are tracked
        separately.
      </p>
    </aside>
  );
}

function BriefProducts() {
  const resource = useResource("/products?status=active");
  return (
    <Resource resource={resource}>
      {(data) => (
        <div className="brief-products">
          {data.rows.length ? (
            data.rows.map((product) => (
              <Link key={product._id} href={`/products/${product._id}`}>
                <ProductIcon product={product} size={20} />
                <div>
                  <strong>{product.name}</strong>
                  <small>{modelFor(product).label}</small>
                </div>
                <Badge value={product.pricing} />
              </Link>
            ))
          ) : (
            <p>No active products in the catalog yet.</p>
          )}
          <Link className="brief-action" href="/products">
            View full catalog <ArrowRight size={16} />
          </Link>
        </div>
      )}
    </Resource>
  );
}
