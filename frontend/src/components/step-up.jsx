import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { Link } from "../lib/router";
import { Modal, Field, Button, ErrorBox } from "./ui";
// A feature route that needs a fresh authenticator code answers 428. The host
// (mounted once) asks for the code; withStepUp() retries the action once.
let ask = null;
export async function withStepUp(action) {
  try {
    return await action();
  } catch (error) {
    if (error.status !== 428 || !ask) throw error;
    await ask();
    return action();
  }
}
// Concurrent 428s queue behind one prompt: success resolves every waiter
// (each retries once), cancel rejects every waiter. None is left hanging.
function cancelled() {
  const error = new Error("Confirmation cancelled.");
  error.status = 428;
  error.cancelled = true;
  return error;
}
export function StepUpHost({ user, refresh }) {
  const waiters = useRef([]),
    [, render] = useState(0);
  const settle = (outcome) => {
    const list = waiters.current;
    waiters.current = [];
    for (const waiter of list) outcome(waiter);
    render((n) => n + 1);
  };
  useEffect(() => {
    ask = () =>
      new Promise((resolve, reject) => {
        waiters.current.push({ resolve, reject });
        render((n) => n + 1);
      });
    return () => {
      ask = null;
      settle((waiter) => waiter.reject(cancelled()));
    };
  }, []);
  if (!waiters.current.length) return null;
  const cancel = () => settle((waiter) => waiter.reject(cancelled()));
  return (
    <Modal title="Confirm it’s you" onClose={cancel}>
      {user?.totpEnabled ? (
        <StepUpForm onDone={() => settle((waiter) => waiter.resolve())} />
      ) : (
        <NotEnrolled refresh={refresh} cancel={cancel} />
      )}
    </Modal>
  );
}
// The signed-in user may have enrolled a moment ago, so re-read it before
// claiming there is no authenticator (a fresh user flips the host to the form).
function NotEnrolled({ refresh, cancel }) {
  const [checked, setChecked] = useState(!refresh);
  useEffect(() => {
    let live = true;
    refresh?.().finally(() => live && setChecked(true));
    return () => {
      live = false;
    };
  }, []);
  if (!checked)
    return (
      <p className="subtle" role="status">
        Checking your authenticator…
      </p>
    );
  return (
    <>
      <p className="subtle">
        This action needs your authenticator app, and it is not set up yet.
      </p>
      <Link href="/account" className="button primary" onClick={cancel}>
        Set up authenticator
      </Link>
    </>
  );
}
function StepUpForm({ onDone }) {
  const [backup, setBackup] = useState(false),
    [value, setValue] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    input = useRef();
  useEffect(() => {
    // The dialog opens after this effect runs, so focus on the next tick.
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [backup]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/step-up", {
        method: "POST",
        body: backup ? { backupCode: value } : { code: value },
      });
      onDone();
    } catch (e) {
      setError(e.message);
      setValue("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <p className="subtle">
        {backup
          ? "Enter one of your unused backup codes. Each works once."
          : "Enter the 6-digit code from your authenticator app. Confirmation lasts 10 minutes."}
      </p>
      {error && <ErrorBox>{error}</ErrorBox>}
      {backup ? (
        <Field label="Backup code">
          <input
            ref={input}
            className="backup-input"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={12}
            required
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
      ) : (
        <Field label="Authenticator code">
          <input
            ref={input}
            className="otp-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={value}
            onChange={(event) =>
              setValue(event.target.value.replace(/\D/g, ""))
            }
          />
        </Field>
      )}
      <Button type="submit" busy={busy}>
        Confirm
      </Button>
      <button
        type="button"
        className="plain-link"
        onClick={() => {
          setBackup(!backup);
          setValue("");
          setError("");
        }}
      >
        {backup ? "Use my authenticator app" : "Use a backup code"}
      </button>
    </form>
  );
}
