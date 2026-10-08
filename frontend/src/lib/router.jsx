import { useSyncExternalStore } from "react";
const subscribe = (fn) => {
  window.addEventListener("popstate", fn);
  return () => window.removeEventListener("popstate", fn);
};
export function navigate(path) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}
export function usePath() {
  return useSyncExternalStore(subscribe, () => location.pathname);
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
