import { ArrowLeft } from "lucide-react";
import { Link } from "../lib/router";
// Left rail + content for a per-record workspace (customer, installation).
// Reuses the product workspace rail; `.record-workspace` only restores the
// editor's side column that the product workspace hides.
export function WorkspaceFrame({
  back,
  backLabel,
  title,
  subtitle,
  icon: Icon,
  base,
  tabs,
  section,
  navLabel,
  children,
}) {
  return (
    <div className="product-workspace record-workspace">
      <aside className="product-rail">
        <Link href={back} className="back-link">
          <ArrowLeft size={14} />
          {backLabel}
        </Link>
        <div className="product-context">
          <Icon size={20} />
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </div>
        <nav aria-label={navLabel}>
          {tabs.map(([path, name, TabIcon]) => (
            <Link
              key={path}
              href={`${base}${path ? `/${path}` : ""}`}
              aria-current={section === path ? "page" : undefined}
            >
              <TabIcon size={15} />
              {name}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="product-workspace-content">{children}</div>
    </div>
  );
}
