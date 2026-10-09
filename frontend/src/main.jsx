import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-300.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";
import { api, setCsrf } from "./lib/api";
import { usePath, navigate, confirmLeave, Link } from "./lib/router";
import { Shell } from "./components/shell";
import { Loading, ErrorBox, Empty } from "./components/ui";
import { StepUpHost } from "./components/step-up";
import { ShieldAlert } from "lucide-react";
import { Login } from "./pages/login";
import { AccountSecurity } from "./pages/account-security";
import { Overview } from "./pages/overview";
import { EcomPage } from "./pages/ecom";
import { ProductWorkspace } from "./pages/product-workspace";
import { CustomerWorkspace } from "./pages/customer-workspace";
import { InstallationWorkspace } from "./pages/installation-workspace";
import { PosImport } from "./pages/pos-import";
import { PosFleet } from "./pages/pos-fleet";
import { RecordList } from "./pages/record-list";
import { RecordEditor } from "./pages/record-editor";
import { definitions } from "./pages/records-config";
import {
  AuditPage,
  TeamPage,
  StorePage,
  RecoveryPage,
} from "./pages/governance";
import { can } from "../../shared/policy";
// `resetKey` (the route) clears a caught error, so the next page can render.
class ErrorBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidUpdate(previous) {
    if (this.state.error && previous.resetKey !== this.props.resetKey)
      this.setState({ error: false });
  }
  render() {
    if (!this.state.error) return this.props.children;
    const box = (
      <ErrorBox retry={() => location.reload()}>
        This view could not be loaded. Reload to recover.
      </ErrorBox>
    );
    return this.props.inline ? box : <div className="fatal-error">{box}</div>;
  }
}
function App() {
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    // Failures after sign-in (refresh, logout) show inline, not as a dead end.
    // {message, retry}: what failed and how to run it again.
    [problem, setProblem] = useState(null),
    path = usePath();
  useEffect(() => {
    api("/auth/me", { boot: true })
      .then((result) => {
        setUser(result.staff);
        setCsrf(result.csrf);
      })
      .catch((e) => {
        if (e.status !== 401) setError(e.message);
      })
      .finally(() => setLoading(false));
    const expired = () => {
      setUser(null);
      setCsrf("");
    };
    window.addEventListener("admin-session-expired", expired);
    return () => window.removeEventListener("admin-session-expired", expired);
  }, []);
  useEffect(() => {
    document.title = `${path === "/" ? "Dashboard" : path.split("/")[1].replace(/^./, (c) => c.toUpperCase())} · Sandbee Admin`;
    setProblem(null);
  }, [path]);
  // Re-reads the signed-in staff member after enrolment changes (banner, step-up).
  async function refreshUser() {
    try {
      setUser((await api("/auth/me")).staff);
    } catch (e) {
      if (e.status !== 401)
        setProblem({ message: e.message, retry: refreshUser });
    }
  }
  async function logout() {
    // Ask before anything is sent: leaving may discard one-time data.
    if (!confirmLeave()) return;
    try {
      await api("/auth/logout", { method: "POST", body: {} });
    } catch (e) {
      if (e.status !== 401) {
        setProblem({ message: e.message, retry: logout });
        return;
      }
    }
    setProblem(null);
    setUser(null);
    setCsrf("");
    navigate("/", { force: true });
  }
  if (loading) return <Loading />;
  if (error)
    return (
      <div className="fatal-error">
        <ErrorBox retry={() => location.reload()}>{error}</ErrorBox>
      </div>
    );
  if (!user) return <Login onLogin={setUser} />;
  const [kind, id, section] = path.split("/").filter(Boolean);
  let page;
  if (!kind) page = <Overview user={user} />;
  else if (kind === "ecom") page = <EcomPage user={user} />;
  else if (kind === "pos-import" && can(user.role, "secrets"))
    page = <PosImport />;
  else if (kind === "pos-clients" && can(user.role, "credentials"))
    page = <PosFleet user={user} />;
  else if (definitions[kind] && !id)
    page = <RecordList key={kind} kind={kind} user={user} />;
  else if (kind === "products" && id && id !== "new")
    page = <ProductWorkspace key={id} id={id} section={section} user={user} />;
  else if (kind === "customers" && id && id !== "new")
    page = <CustomerWorkspace key={id} id={id} section={section} user={user} />;
  else if (kind === "installations" && id && id !== "new")
    page = (
      <InstallationWorkspace key={id} id={id} section={section} user={user} />
    );
  else if (definitions[kind] && id)
    page = (
      <RecordEditor key={`${kind}-${id}`} kind={kind} id={id} user={user} />
    );
  else if (kind === "audit") page = <AuditPage />;
  else if (kind === "team")
    page = (
      <TeamPage
        user={user}
        onLogout={() => {
          setUser(null);
          setCsrf("");
          navigate("/");
        }}
      />
    );
  else if (kind === "account")
    page = <AccountSecurity user={user} onChange={refreshUser} />;
  else if (kind === "store") page = <StorePage />;
  else if (kind === "recovery" && can(user.role, "recovery"))
    page = <RecoveryPage />;
  else
    page = (
      <Empty title="This page is not available">
        Choose a page from the navigation to continue.
      </Empty>
    );
  return (
    <>
      <Shell user={user} onLogout={logout}>
        {user.role === "owner" && !user.totpEnabled && kind !== "account" && (
          <div className="notice notice-warning">
            <ShieldAlert size={16} />
            <span>
              Set up your authenticator app to protect owner access.{" "}
              <Link href="/account">Open account security</Link>
            </span>
          </div>
        )}
        {problem && (
          <ErrorBox
            retry={() => {
              setProblem(null);
              problem.retry();
            }}
          >
            {problem.message}
          </ErrorBox>
        )}
        <ErrorBoundary inline resetKey={path}>
          {page}
        </ErrorBoundary>
      </Shell>
      <StepUpHost user={user} refresh={refreshUser} />
    </>
  );
}
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
