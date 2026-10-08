import { useState } from "react";
import {
  ArrowRight,
  ShieldCheck,
  Layers3,
  Fingerprint,
  Waypoints,
} from "lucide-react";
import { api, setCsrf } from "../lib/api";
import { Brand, Button, ErrorBox, Field } from "../components/ui";
export function Login({ onLogin }) {
  const [mode, setMode] = useState("login"),
    [challenge, setChallenge] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (challenge) {
        const result = await api("/auth/verify", {
          method: "POST",
          body: {
            challengeId: challenge,
            code,
            ...(mode === "recovery" ? { password } : {}),
          },
        });
        setCsrf(result.csrf);
        onLogin(result.staff);
      } else {
        const result = await api(
          mode === "login" ? "/auth/login" : "/auth/recover",
          {
            method: "POST",
            body: { email, ...(mode === "login" ? { password } : {}) },
          },
        );
        setChallenge(result.challengeId);
        setPassword("");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function switchMode(next) {
    setMode(next);
    setChallenge("");
    setCode("");
    setPassword("");
    setError("");
  }
  return (
    <div className="login-layout">
      <section className="login-story">
        <Brand />
        <div className="login-story-body">
          <p className="eyebrow">ONE PLACE. EVERY PRODUCT.</p>
          <h1>
            Every product.
            <br />
            One operations workspace.
          </h1>
          <p>
            Customers, connections and the work that moves your products
            forward.
          </p>
          <div className="auth-products">
            <div>
              <Fingerprint size={20} />
              <span>
                <strong>APIs & installed packages</strong>
                <small>Hosted endpoints and customer-side software.</small>
              </span>
            </div>
            <div>
              <Layers3 size={20} />
              <span>
                <strong>SaaS & prepaid services</strong>
                <small>
                  Customer access, delivery and operational readiness.
                </small>
              </span>
            </div>
            <div>
              <Waypoints size={20} />
              <span>
                <strong>Customer-owned deployments</strong>
                <small>
                  Provider accounts, releases and verified handovers.
                </small>
              </span>
            </div>
          </div>
        </div>
        <p className="login-story-foot">
          Sandbee Admin · Built for the people behind the products.
        </p>
      </section>
      <section className="login-form-side">
        <span className="login-access">
          <ShieldCheck size={16} /> Authorized team access
        </span>
        <div className="login-form-wrap">
          <p className="eyebrow">YOUR OPERATIONS DESK</p>
          <h2>
            {challenge
              ? "Check your inbox"
              : mode === "recovery"
                ? "Set up or recover access"
                : "Welcome back."}
          </h2>
          <p className="subtle">
            {challenge
              ? `If ${email} has access, a verification code has been sent. It expires in 10 minutes.`
              : mode === "recovery"
                ? "Use the email your owner added to the team. Public signup is not available."
                : "Sign in with your staff account. An email code verifies each new session."}
          </p>
          <form onSubmit={submit}>
            {error && <ErrorBox>{error}</ErrorBox>}
            {!challenge ? (
              <>
                <Field label="Work email">
                  <input
                    type="email"
                    autoComplete="username"
                    required
                    maxLength={254}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>
                {mode === "login" && (
                  <Field label="Password">
                    <input
                      type="password"
                      autoComplete="current-password"
                      required
                      maxLength={128}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </Field>
                )}
              </>
            ) : (
              <>
                <Field label="Verification code">
                  <input
                    className="otp-input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\D/g, ""))
                    }
                    autoFocus
                  />
                </Field>
                {mode === "recovery" && (
                  <Field
                    label="New password"
                    hint="Use at least 14 characters. A long passphrase works well."
                  >
                    <input
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={14}
                      maxLength={128}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </Field>
                )}
              </>
            )}
            <Button type="submit" busy={busy}>
              {challenge ? "Verify and continue" : "Continue"}
              <ArrowRight size={16} />
            </Button>
          </form>
          <button
            className="plain-link"
            onClick={() => switchMode(mode === "login" ? "recovery" : "login")}
          >
            {mode === "login"
              ? "First time here or forgot your password?"
              : "Back to sign in"}
          </button>
          {challenge && (
            <button className="plain-link" onClick={() => switchMode(mode)}>
              Use a different email or request a new code
            </button>
          )}
        </div>
        <p className="login-note">
          Your customer Store account and staff access are separate.
        </p>
      </section>
    </div>
  );
}
