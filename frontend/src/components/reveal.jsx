import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Copy, Eye, EyeOff } from "lucide-react";
import { Button, ErrorBox } from "./ui";
// Shows one decrypted value (or code list) on demand. The value lives only in
// this component's state: it is dropped after `ttl` seconds, when the component
// unmounts and when the page is hidden (including the back/forward cache). It
// is never written to storage, the URL or the console.
//   load()              -> Promise of the payload (wrap in withStepUp at the call site)
//   view(payload, tools)-> node; tools = {remaining, update(fn)}
//   copyText(payload)   -> string to offer a Copy button for, or null
//   ttl                 -> seconds, or a function of the payload
//   buttonName          -> accessible name of the opening button (default: buttonLabel + label)
//   countdown           -> text before the remaining seconds
export function RevealValue({
  label,
  buttonLabel = "Reveal",
  load,
  view,
  copyText,
  ttl = 30,
  countdown = "Hides in",
  buttonName,
}) {
  const [payload, setPayload] = useState(null),
    [deadline, setDeadline] = useState(0),
    [now, setNow] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false),
    live = useRef(true),
    group = useRef(),
    opener = useRef(),
    hider = useRef(),
    refocus = useRef(false);
  const wipe = () => {
    setPayload(null);
    setDeadline(0);
    setCopied(false);
  };
  // Hiding by hand, or by timer while focus is inside the value, puts focus
  // back on the Reveal button instead of dropping it to the page.
  const clear = (inside) => {
    refocus.current =
      inside === true ||
      Boolean(group.current?.contains(document.activeElement));
    wipe();
  };
  useEffect(() => {
    live.current = true;
    // flushSync: the DOM must be empty before the page can be frozen into the
    // back/forward cache.
    const hide = () => flushSync(wipe);
    window.addEventListener("pagehide", hide);
    return () => {
      live.current = false;
      window.removeEventListener("pagehide", hide);
    };
  }, []);
  useEffect(() => {
    if (payload) hider.current?.focus();
    else if (refocus.current) {
      refocus.current = false;
      opener.current?.focus();
    }
  }, [Boolean(payload)]);
  // One timer drops the value; a second one only refreshes the countdown text.
  useEffect(() => {
    if (!deadline) return;
    const drop = setTimeout(() => clear(), Math.max(0, deadline - Date.now()));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(drop);
      clearInterval(tick);
    };
  }, [deadline]);
  async function show() {
    setBusy(true);
    setError("");
    try {
      const result = await load();
      if (!live.current) return;
      const seconds = typeof ttl === "function" ? ttl(result) : ttl;
      setPayload(result);
      setNow(Date.now());
      setDeadline(Date.now() + Math.max(1, seconds) * 1000);
    } catch (e) {
      if (live.current && !e.cancelled) setError(e.message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText(payload));
      setCopied(true);
    } catch {
      setError("Copy is not available here.");
    }
  }
  const remaining = deadline
    ? Math.max(0, Math.ceil((deadline - now) / 1000))
    : 0;
  if (!payload)
    return (
      <>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Button
          ref={opener}
          type="button"
          variant="secondary"
          busy={busy}
          aria-label={buttonName || `${buttonLabel} ${label}`}
          onClick={show}
        >
          <Eye size={15} />
          {buttonLabel}
        </Button>
      </>
    );
  const text = copyText?.(payload);
  return (
    <div className="secret-reveal" role="group" aria-label={label} ref={group}>
      {error && <ErrorBox>{error}</ErrorBox>}
      {view(payload, {
        remaining,
        update: (fn) => setPayload((old) => (old ? fn(old) : old)),
      })}
      <div className="secret-meta">
        <span className="small subtle">
          {countdown} {remaining} s
        </span>
        <Button
          ref={hider}
          type="button"
          variant="secondary"
          aria-label={`Hide ${label}`}
          onClick={() => clear(true)}
        >
          <EyeOff size={15} />
          Hide
        </Button>
        {text && (
          <Button
            type="button"
            variant="secondary"
            aria-label={`Copy ${label}`}
            onClick={copy}
          >
            <Copy size={15} />
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </div>
      {copied && (
        <p className="form-note">
          Copying leaves the value in your clipboard until you replace it. It is
          not cleared automatically.
        </p>
      )}
    </div>
  );
}
