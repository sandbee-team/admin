import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
// Polls a GET route: `activeMs` while `isActive(data)` is true, `idleMs`
// otherwise. Nothing is fetched while the tab is hidden (it catches up the
// moment the tab is shown again), the loop stops on unmount, and the latest
// call wins: an older response never overwrites a newer one.
export function usePoll(
  path,
  { isActive, activeMs = 2000, idleMs = 15000 } = {},
) {
  const [state, setState] = useState({
      data: null,
      loading: true,
      error: "",
      status: 0,
    }),
    latest = useRef(0),
    timer = useRef(0),
    data = useRef(null),
    decide = useRef(isActive),
    tick = useRef(() => Promise.resolve());
  decide.current = isActive;
  useEffect(() => {
    let stopped = false;
    const abort = new AbortController();
    data.current = null;
    if (!path) {
      setState({ data: null, loading: false, error: "", status: 0 });
      return;
    }
    setState({ data: null, loading: true, error: "", status: 0 });
    const schedule = () => {
      clearTimeout(timer.current);
      if (stopped) return;
      const fast = Boolean(decide.current?.(data.current));
      timer.current = setTimeout(run, fast ? activeMs : idleMs);
    };
    async function run() {
      clearTimeout(timer.current);
      if (stopped) return;
      // Hidden tab: no request; the visibility handler resumes the loop.
      if (document.hidden) return;
      const mine = ++latest.current;
      try {
        const next = await api(path, { signal: abort.signal });
        if (!stopped && mine === latest.current) {
          data.current = next;
          setState({ data: next, loading: false, error: "", status: 0 });
        }
      } catch (error) {
        if (!stopped && !abort.signal.aborted && mine === latest.current)
          setState((old) => ({
            data: old.data,
            loading: false,
            error: error.message,
            status: error.status ?? 0,
          }));
      }
      schedule();
    }
    const visible = () => {
      if (!document.hidden) run();
    };
    tick.current = run;
    document.addEventListener("visibilitychange", visible);
    run();
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [path, activeMs, idleMs]);
  // Re-reads now (after an action) and resumes the normal cadence.
  const refresh = useCallback(() => tick.current(), []);
  return { ...state, refresh };
}
