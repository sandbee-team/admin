import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
export function useResource(path) {
  const [revision, setRevision] = useState(0),
    [state, setState] = useState({ data: null, loading: true, error: "" }),
    // Latest call wins: an older response never overwrites a newer one.
    latest = useRef(0);
  useEffect(() => {
    const mine = ++latest.current;
    const abort = new AbortController();
    setState({ data: null, loading: true, error: "" });
    if (!path) {
      setState({ data: null, loading: false, error: "" });
      return;
    }
    api(path, { signal: abort.signal })
      .then((data) => {
        if (!abort.signal.aborted && mine === latest.current)
          setState({ data, loading: false, error: "" });
      })
      .catch((error) => {
        if (!abort.signal.aborted && mine === latest.current)
          setState({ data: null, loading: false, error: error.message });
      });
    return () => abort.abort();
  }, [path, revision]);
  // refresh() re-reads without the loading state, so open forms stay mounted;
  // it resolves with the new data (and rejects on failure).
  const refresh = useCallback(async () => {
    const mine = ++latest.current,
      data = await api(path);
    if (mine === latest.current) setState({ data, loading: false, error: "" });
    return data;
  }, [path]);
  return { ...state, reload: () => setRevision((value) => value + 1), refresh };
}
