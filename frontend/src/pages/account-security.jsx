import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Copy, ShieldAlert, ShieldCheck } from "lucide-react";
import { useResource } from "../hooks/use-resource";
import {
  PageTitle,
  Resource,
  Badge,
  Button,
  Field,
  ErrorBox,
  Notice,
} from "../components/ui";
import { withStepUp } from "../components/step-up";
import { api, dateTime } from "../lib/api";
import { useNavigationGuard } from "../lib/router";
const groups = (secret) => secret.match(/.{1,4}/g)?.join(" ") || secret;
const svgSource = (svg) => `data:image/svg+xml;base64,${btoa(svg)}`;
export function AccountSecurity({ user, onChange }) {
  const resource = useResource("/auth/me");
  return (
    <>
      <PageTitle
        eyebrow="ACCOUNT"
        title="Account security"
        description="Sign-in protection for your own staff account."
      />
      <Resource resource={resource}>
        {(data) => (
          <Security
            me={data.staff}
            user={user}
            onUser={onChange}
            onChange={() => {
              resource.reload();
              onChange?.();
            }}
          />
        )}
      </Resource>
    </>
  );
}
function Security({ me, onChange, onUser }) {
  const [phase, setPhase] = useState("idle"),
    [setup, setSetup] = useState(null),
    [codes, setCodes] = useState([]),
    [saved, setSaved] = useState(false),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false),
    [current, setCurrent] = useState(""),
    [currentBackup, setCurrentBackup] = useState(false);
  const owner = me.role === "owner";
  // One-time secrets must not outlive the page: clear them when it is hidden
  // (including entering the back/forward cache) and on unmount.
  useEffect(() => {
    // flushSync: the DOM must be empty before the page can be frozen into the
    // back/forward cache. Unmounting needs no cleanup: the state goes with it.
    const clear = () =>
      flushSync(() => {
        setSetup(null);
        setCodes([]);
        setCode("");
        setCurrent("");
        setPhase("idle");
      });
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  const unsaved = phase === "codes" && !saved;
  // Backup codes exist only in this page; ask before leaving, in the app (the
  // guard) and by reload or closing the tab (beforeunload).
  useNavigationGuard(
    unsaved
      ? "Your backup codes are shown only once and you have not confirmed saving them. Leave this page anyway?"
      : "",
  );
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  async function run(name, action) {
    setBusy(name);
    setError("");
    try {
      await action();
    } catch (e) {
      if (!e.cancelled) setError(e.message);
    } finally {
      setBusy("");
    }
  }
  const start = () =>
    run("start", async () => {
      const result = await withStepUp(() =>
        api("/auth/totp/enrol/start", { method: "POST", body: {} }),
      );
      setSetup(result);
      setCode("");
      setCurrent("");
      setCurrentBackup(false);
      setPhase("enrol");
    });
  const confirm = (event) => {
    event.preventDefault();
    run("confirm", async () => {
      // Replacing needs a code from the current authenticator (or a backup
      // code) as well as the new one.
      const proof = !me.totpEnabled
        ? {}
        : currentBackup
          ? { currentBackupCode: current }
          : { currentCode: current };
      const result = await withStepUp(() =>
        api("/auth/totp/enrol/confirm", {
          method: "POST",
          body: { code, ...proof },
        }),
      );
      showCodes(result.backupCodes);
      // Enrolment is complete now: let the app know at once (banner, step-up).
      onUser?.();
    });
  };
  const regenerate = () =>
    run("regenerate", async () => {
      const result = await withStepUp(() =>
        api("/auth/totp/backup-codes", { method: "POST", body: {} }),
      );
      showCodes(result.backupCodes);
    });
  const disable = () =>
    run("disable", async () => {
      await withStepUp(() =>
        api("/auth/totp/disable", { method: "POST", body: {} }),
      );
      onChange();
    });
  function showCodes(list) {
    setSetup(null);
    setCode("");
    setCurrent("");
    setCodes(list);
    setSaved(false);
    setCopied(false);
    setPhase("codes");
    // The counts on this page are refreshed once the codes are acknowledged.
  }
  function finish() {
    setCodes([]);
    setPhase("idle");
    onChange();
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setError("Copy is not available here. Write the codes down instead.");
    }
  }
  if (phase === "codes")
    return (
      <section className="panel account-panel" aria-labelledby="codes-title">
        <div className="panel-title">
          <div>
            <h2 id="codes-title">Your backup codes</h2>
            <p>
              Each code works once if you lose your phone. They are shown only
              now. Store them somewhere safe and offline.
            </p>
          </div>
        </div>
        <div className="account-body">
          {error && <ErrorBox>{error}</ErrorBox>}
          <ol className="backup-codes" aria-label="Backup codes">
            {codes.map((value) => (
              <li key={value}>
                <code>{value}</code>
              </li>
            ))}
          </ol>
          <div className="account-actions">
            <Button variant="secondary" type="button" onClick={copy}>
              <Copy size={15} />
              {copied ? "Copied" : "Copy codes"}
            </Button>
          </div>
          <p className="form-note">
            Copying leaves the codes in your clipboard until you replace it.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            <span>I saved these backup codes</span>
          </label>
          <Button disabled={!saved} onClick={finish}>
            Done
          </Button>
        </div>
      </section>
    );
  return (
    <>
      {error && <ErrorBox>{error}</ErrorBox>}
      <section className="panel account-panel" aria-labelledby="status-title">
        <div className="panel-title">
          <div>
            <h2 id="status-title">Authenticator app</h2>
            <p>
              A 6-digit code from an app such as Google Authenticator, 1Password
              or Authy is checked after your email code on every sign-in.
            </p>
          </div>
          {me.totpEnabled ? (
            <Badge value="active">Enabled</Badge>
          ) : (
            <Badge value="paused">Not set up</Badge>
          )}
        </div>
        <div className="account-body">
          {me.totpEnabled ? (
            <>
              <p className="status-line">
                <ShieldCheck size={16} /> Two-step sign-in is on.{" "}
                <strong>{me.backupCodesLeft}</strong> of 10 backup codes left.
              </p>
              {me.stepUpUntil && (
                <p className="small subtle">
                  Sensitive actions are confirmed until{" "}
                  {dateTime(me.stepUpUntil)}.
                </p>
              )}
              <div className="account-actions">
                <Button
                  variant="secondary"
                  busy={busy === "regenerate"}
                  onClick={regenerate}
                >
                  Regenerate backup codes
                </Button>
                <Button
                  variant="secondary"
                  busy={busy === "start"}
                  onClick={start}
                >
                  Replace authenticator
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="status-line">
                <ShieldAlert size={16} />
                {owner
                  ? " Required for owners: revealing secrets needs it."
                  : " Recommended for your account."}
              </p>
              {phase !== "enrol" && (
                <Button busy={busy === "start"} onClick={start}>
                  Set up authenticator
                </Button>
              )}
            </>
          )}
        </div>
      </section>
      {phase === "enrol" && setup && (
        <section
          className="panel account-panel section-gap"
          aria-labelledby="enrol-title"
        >
          <div className="panel-title">
            <div>
              <h2 id="enrol-title">Add it to your authenticator app</h2>
              <p>
                Scan the QR code, or type the setup key into your app. Then
                enter the 6-digit code it shows.
              </p>
            </div>
          </div>
          <div className="account-body">
            <div className="qr-box">
              <img
                src={svgSource(setup.qrSvg)}
                alt="QR code for your authenticator app"
                width="192"
                height="192"
              />
            </div>
            <p className="field-label" id="setup-key-label">
              Setup key
            </p>
            <code className="setup-key" aria-labelledby="setup-key-label">
              {groups(setup.secret)}
            </code>
            <form onSubmit={confirm}>
              <Field label="6-digit code from your app">
                <input
                  className="otp-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/[^0-9]/g, ""))
                  }
                />
              </Field>
              {me.totpEnabled && (
                <>
                  <Field
                    label={
                      currentBackup
                        ? "Current backup code"
                        : "Code from your current authenticator"
                    }
                    hint="Proves you still hold the authenticator you are replacing."
                  >
                    <input
                      className={currentBackup ? "backup-input" : "otp-input"}
                      inputMode={currentBackup ? "text" : "numeric"}
                      autoComplete="off"
                      maxLength={currentBackup ? 12 : 6}
                      required
                      value={current}
                      onChange={(event) =>
                        setCurrent(
                          currentBackup
                            ? event.target.value
                            : event.target.value.replace(/[^0-9]/g, ""),
                        )
                      }
                    />
                  </Field>
                  <button
                    type="button"
                    className="plain-link"
                    onClick={() => {
                      setCurrentBackup(!currentBackup);
                      setCurrent("");
                    }}
                  >
                    {currentBackup
                      ? "Use my current authenticator"
                      : "Use a backup code instead"}
                  </button>
                </>
              )}
              <div className="account-actions">
                <Button type="submit" busy={busy === "confirm"}>
                  Turn on authenticator
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setSetup(null);
                    setPhase("idle");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
            <p className="form-note">
              Turning it on signs you out everywhere except this browser.
            </p>
          </div>
        </section>
      )}
      <section className="danger-zone" aria-labelledby="off-title">
        <h2 id="off-title">Turn off</h2>
        {owner ? (
          <p>Owners must keep the authenticator on.</p>
        ) : me.totpEnabled ? (
          <>
            <p>Sign-in goes back to password and email code only.</p>
            <Button
              variant="danger"
              busy={busy === "disable"}
              onClick={disable}
            >
              Turn off authenticator
            </Button>
          </>
        ) : (
          <p>The authenticator is not turned on.</p>
        )}
      </section>
      {me.totpEnabled && (
        <Notice>
          Lost your phone and your backup codes? Ask the person running this
          server to reset your authenticator.
        </Notice>
      )}
    </>
  );
}
