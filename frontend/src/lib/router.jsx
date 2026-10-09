import { useEffect, useSyncExternalStore } from "react";
const subscribe = (fn) => {
  window.addEventListener("popstate", fn);
  return () => window.removeEventListener("popstate", fn);
};
// Pages holding unsaved or one-time data register a guard; in-app navigation
// then asks first (the browser's own beforeunload covers reloads and closing).
const guards = new Set();
export function useNavigationGuard(message) {
  useEffect(() => {
    if (!message) return;
    const guard = () => message;
    guards.add(guard);
    return () => guards.delete(guard);
  }, [message]);
}
const current = () => location.pathname + location.search;
const announce = () => window.dispatchEvent(new PopStateEvent("popstate"));
// True when every active guard lets the user leave (asks once per guard).
export function confirmLeave() {
  for (const guard of guards) {
    const message = guard();
    if (message && !window.confirm(message)) return false;
  }
  return true;
}
// The URL the page state belongs to, for undoing a cancelled Back/Forward.
let shown = current();
// Registered before any subscriber, so a cancelled Back/Forward is swallowed
// before the app re-renders. Only real (trusted) history moves are asked about;
// our own synthetic popstate events are not.
window.addEventListener("popstate", (event) => {
  if (!event.isTrusted) return;
  if (current() === shown || confirmLeave()) {
    shown = current();
    return;
  }
  event.stopImmediatePropagation();
  history.pushState(null, "", shown);
});
export function navigate(path, { replace = false, force = false } = {}) {
  // Going to where we already are changes nothing (no duplicate history entry).
  if (path === current()) return;
  if (!force && !confirmLeave()) return;
  history[replace ? "replaceState" : "pushState"](null, "", path);
  shown = current();
  announce();
  window.scrollTo(0, 0);
}
// Rewrites only the query string of the current page (filters, paging).
// `replace` suits typing; paging and filter changes push a history entry.
export function setQuery(params, { replace = false } = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== "" && value != null && value !== 1) query.set(key, value);
  const text = query.toString(),
    next = location.pathname + (text ? `?${text}` : "");
  if (next === current()) return;
  history[replace ? "replaceState" : "pushState"](null, "", next);
  shown = current();
  announce();
}
export function usePath() {
  return useSyncExternalStore(subscribe, () => location.pathname);
}
export function useSearch() {
  return useSyncExternalStore(subscribe, () => location.search);
}
export function Link({ href, children, onClick, ...props }) {
  return (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (
          !event.defaultPrevented &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          event.button === 0 &&
          href.startsWith("/")
        ) {
          event.preventDefault();
          navigate(href);
        }
      }}
    >
      {children}
    </a>
  );
}
