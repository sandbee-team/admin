import { useState } from "react";
import {
  ArrowLeft,
  LayoutDashboard,
  Rocket,
  Settings2,
  ExternalLink,
} from "lucide-react";
import { useResource } from "../hooks/use-resource";
import { Link } from "../lib/router";
import {
  Resource,
  PageTitle,
  Badge,
  NewLink,
  Empty,
  Pagination,
} from "../components/ui";
import { ProductIcon } from "../components/product-icon";
import { RecordEditor } from "./record-editor";
import {
  modelFor,
  providersFor,
  checksFor,
} from "../../../shared/product-models";
import { can } from "../../../shared/policy";
export function ProductWorkspace({ id, section = "", user }) {
  const resource = useResource(`/products/${id}`);
  return (
    <Resource resource={resource}>
      {(product) => (
        <div className="product-workspace">
          <aside className="product-rail">
            <Link href="/products" className="back-link">
              <ArrowLeft size={14} />
              All products
            </Link>
            <div className="product-context">
              <ProductIcon product={product} />
              <strong>{product.name}</strong>
              <small>{modelFor(product).label}</small>
            </div>
            <nav aria-label="Product navigation">
              {[
                ["", "Overview", LayoutDashboard],
                ["installations", "Installations", Rocket],
                ["settings", "Settings", Settings2],
              ].map(([path, title, Icon]) => (
                <Link
                  key={path}
                  href={`/products/${id}${path ? `/${path}` : ""}`}
                  aria-current={section === path ? "page" : undefined}
                >
                  <Icon size={15} />
                  {title}
                </Link>
              ))}
            </nav>
            <div className="product-context-foot">
              <Badge value={product.pricing} />
              <p>Product operations</p>
            </div>
          </aside>
          <div className="product-workspace-content">
            {section === "settings" ? (
              <RecordEditor
                kind="products"
                id={id}
                user={user}
                onSaved={resource.reload}
              />
            ) : section === "installations" ? (
              <ProductInstallations product={product} user={user} />
            ) : section === "" ? (
              <ProductOverview product={product} />
            ) : (
              <Empty title="Page not found">
                Choose a product section to continue.
              </Empty>
            )}
          </div>
        </div>
      )}
    </Resource>
  );
}
function ProductOverview({ product }) {
  const model = modelFor(product),
    providers = providersFor(product);
  return (
    <>
      <PageTitle
        eyebrow={product.category}
        title={product.name}
        description={product.description}
        action={<Badge value={product.status} />}
      />
      <div className="product-summary">
        <section className="panel aside-card">
          <h2>Delivery model</h2>
          <p className="model-title">{model.label}</p>
          <p>{model.description}</p>
          <dl className="permission-list">
            <dt>Pricing</dt>
            <dd>
              <Badge value={product.pricing} />
            </dd>
            <dt>Providers</dt>
            <dd>
              {providers.length
                ? providers.join(", ")
                : "No provider accounts required"}
            </dd>
            <dt>Endpoint</dt>
            <dd>
              {model.endpointRequired
                ? "Required before live"
                : "Optional for local processing"}
            </dd>
          </dl>
        </section>
        <section className="panel aside-card">
          <h2>Readiness requirements</h2>
          <ul className="model-checks">
            {checksFor(product).map((check) => (
              <li key={check.id}>{check.label}</li>
            ))}
          </ul>
          <p className="small">
            These checks record operator verification. They do not execute
            provisioning, payments or deployment.
          </p>
        </section>
      </div>
      <section className="panel product-actions">
        <Link
          href={`/products/${product._id}/installations`}
          className="button primary"
        >
          View product installations
        </Link>
        <Link
          href={`/products/${product._id}/settings`}
          className="button secondary"
        >
          Product settings
        </Link>
        {product.website && (
          <a
            href={product.website}
            className="text-link"
            target="_blank"
            rel="noreferrer"
          >
            Product website
            <ExternalLink size={14} />
          </a>
        )}
      </section>
    </>
  );
}
function ProductInstallations({ product, user }) {
  const [page, setPage] = useState(1),
    resource = useResource(
      `/installations?productId=${product._id}&page=${page}`,
    );
  return (
    <>
      <PageTitle
        eyebrow={product.name}
        title="Installations"
        description="Customer environments linked to this product only."
        action={
          can(user.role, "operate") &&
          product.status !== "retired" && (
            <NewLink href={`/installations/new?productId=${product._id}`}>
              Add installation
            </NewLink>
          )
        }
      />
      <Resource resource={resource}>
        {(data) =>
          data.rows.length ? (
            <>
              <div className="panel table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Installation</th>
                      <th>Environment</th>
                      <th>Release</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row._id}>
                        <td>
                          <Link
                            className="table-name"
                            href={`/installations/${row._id}`}
                          >
                            {row.name}
                          </Link>
                        </td>
                        <td>{row.environment}</td>
                        <td>{row.release || "Not recorded"}</td>
                        <td>
                          <Badge value={row.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination data={data} page={page} onPage={setPage} />
            </>
          ) : (
            <div className="panel">
              <Empty icon={Rocket} title="No installations for this product">
                Add a customer installation to track configuration, readiness
                and handover.
              </Empty>
            </div>
          )
        }
      </Resource>
    </>
  );
}
