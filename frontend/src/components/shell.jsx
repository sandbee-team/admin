import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import {
  LayoutDashboard,
  Users,
  Layers3,
  Rocket,
  Server,
  KeyRound,
  ListTodo,
  ScrollText,
  ShieldCheck,
  LifeBuoy,
  FileUp,
  LockKeyhole,
  Store,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  LogOut,
  ArrowUpRight,
  X,
} from "lucide-react";
import { Brand } from "./ui";
import { Link, usePath } from "../lib/router";
import { can } from "../../../shared/policy";
const groups = [
  [
    "WORKSPACE",
    [
      ["/", "Dashboard", LayoutDashboard],
      ["/customers", "Customers", Users],
      ["/products", "Products", Layers3],
      ["/installations", "Installations", Rocket],
    ],
  ],
  [
    "OPERATIONS",
    [
      ["/tasks", "Work queue", ListTodo],
      ["/pos-clients", "POS clients", Server],
      ["/connections", "Connections", KeyRound],
      ["/store", "Store bridge", Store],
      ["/ecom", "Ecom subscriptions", Layers3],
    ],
  ],
  [
    "GOVERNANCE",
    [
      ["/audit", "Audit trail", ScrollText],
      ["/team", "Team & access", ShieldCheck],
      ["/account", "Account security", LockKeyhole],
      ["/pos-import", "POS import", FileUp],
      ["/recovery", "Recovery", LifeBuoy],
    ],
  ],
];
const mobileQuery = window.matchMedia("(max-width: 760px)");
const watchMobile = (fn) => {
  mobileQuery.addEventListener("change", fn);
  return () => mobileQuery.removeEventListener("change", fn);
};
export function Shell({ user, onLogout, children }) {
  const path = usePath(),
    [collapsed, setCollapsed] = useState(
      () => localStorage.getItem("admin-sidebar") !== "wide",
    ),
    [mobile, setMobile] = useState(false);
  const isSmall = useSyncExternalStore(watchMobile, () => mobileQuery.matches),
    sidebarRef = useRef();
  useEffect(() => {
    if (!mobile || !isSmall) return;
    const previous = document.activeElement,
      sidebar = sidebarRef.current;
    sidebar.querySelector(".mobile-close").focus();
    function keys(event) {
      if (event.key === "Escape") {
        setMobile(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...sidebar.querySelectorAll("a,button")].filter(
        (el) =>
          el.getClientRects().length && getComputedStyle(el).display !== "none",
      );
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1).focus();
      } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0].focus();
      }
    }
    sidebar.addEventListener("keydown", keys);
    return () => {
      sidebar.removeEventListener("keydown", keys);
      previous?.focus();
    };
  }, [mobile, isSmall]);
  function toggle() {
    setCollapsed(!collapsed);
    localStorage.setItem("admin-sidebar", collapsed ? "wide" : "small");
  }
  return (
    <div className={`app-shell ${collapsed ? "is-collapsed" : ""}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {mobile && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        ref={sidebarRef}
        inert={isSmall && !mobile}
        className={`sidebar ${mobile ? "mobile-open" : ""}`}
      >
        <Link
          href="/"
          className="brand-link"
          aria-label="Sandbee Admin overview"
        >
          <Brand compact={collapsed && !isSmall} />
        </Link>
        <button
          className="mobile-close icon-button"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        >
          <X size={20} />
        </button>
        <nav aria-label="Main navigation">
          {groups.map(([title, links]) => (
            <div className="nav-group" key={title}>
              <p>{title}</p>
              {links
                .filter(
                  ([href]) =>
                    (href !== "/recovery" || can(user.role, "recovery")) &&
                    (href !== "/pos-import" || can(user.role, "secrets")) &&
                    (href !== "/pos-clients" || can(user.role, "credentials")),
                )
                .map(([href, text, Icon]) => (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setMobile(false)}
                    title={collapsed ? text : undefined}
                    aria-label={text}
                    aria-current={
                      (href === "/" ? path === "/" : path.startsWith(href))
                        ? "page"
                        : undefined
                    }
                  >
                    <Icon size={18} />
                    <span>{text}</span>
                  </Link>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a
            className="store-shortcut"
            aria-label="Open Sandbee Store"
            href="https://store.sandbee.in"
            target="_blank"
            rel="noreferrer"
          >
            <Store size={17} />
            <span>Open Sandbee Store</span>
            <ArrowUpRight size={14} />
          </a>
          <button
            className="collapse-button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <>
                <PanelLeftClose size={18} />
                <span>Collapse navigation</span>
              </>
            )}
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <button
              className="mobile-toggle icon-button"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={22} />
            </button>
            <span className="topbar-workspace">Sandbee Admin</span>
            <nav className="workspace-tabs" aria-label="Workspace navigation">
              {[
                ["/", "Dashboard", LayoutDashboard],
                ["/customers", "Customers", Users],
                ["/products", "Products", Layers3],
                ["/installations", "Installations", Rocket],
                ["/tasks", "Work queue", ListTodo],
              ].map(([href, title, Icon]) => (
                <Link
                  key={href}
                  href={href}
                  aria-current={
                    (href === "/" ? path === "/" : path.startsWith(href))
                      ? "page"
                      : undefined
                  }
                >
                  <Icon size={14} />
                  <span>{title}</span>
                </Link>
              ))}
            </nav>
          </div>
          <div>
            <span className="user-avatar">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-details">
              {user.name}
              <small>{user.role === "viewer" ? "Read-only" : user.role}</small>
            </span>
            <button
              className="icon-button"
              onClick={onLogout}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main id="main" className="main-content" tabIndex={-1}>
          {children}
        </main>
        <footer className="workspace-footer">
          <span>Sandbee Admin</span>
          <span>One workspace. Every product in view.</span>
        </footer>
      </div>
    </div>
  );
}
