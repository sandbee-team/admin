import { useEffect, useState } from "react";
import { api } from "../lib/api";
export function useResource(path) {
  const [revision, setRevision] = useState(0),
    [state, setState] = useState({ data: null, loading: true, error: "" });
  useEffect(() => {
    const abort = new AbortController();
    setState({ data: null, loading: true, error: "" });
    if (!path) {
      setState({ data: null, loading: false, error: "" });
      return;
    }
    api(path, { signal: abort.signal })
      .then((data) => {
        if (!abort.signal.aborted)
          setState({ data, loading: false, error: "" });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setState({ data: null, loading: false, error: error.message });
      });
    return () => abort.abort();
  }, [path, revision]);
  return { ...state, reload: () => setRevision((value) => value + 1) };
}
