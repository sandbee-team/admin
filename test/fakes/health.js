// Scripted stand-in for safe-https getText: answers /api/health and /login from
// queues (the last entry repeats). An Error entry is thrown. A health request
// with `query: {stats: "1"}` is answered from the `stats` queue when one is
// given (else from `health`).
export const HTML = "<!DOCTYPE html><html><body>login</body></html>";
export function createFakeHealth({ health = [], login = [], stats } = {}) {
  const calls = [];
  const queues = { "/api/health": [...health], "/login": [...login] };
  const statsQueue = stats ? [...stats] : null;
  async function get(host, path, options = {}) {
    calls.push({ host, path, options });
    const queue =
      path === "/api/health" && options.query?.stats === "1" && statsQueue
        ? statsQueue
        : queues[path];
    if (!queue) throw Object.assign(new Error("x"), { code: "bad-path" });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      headers: next.headers ?? {
        "content-type":
          path === "/login" ? "text/html; charset=utf-8" : "application/json",
      },
      text:
        next.text ?? (next.body === undefined ? "" : JSON.stringify(next.body)),
    };
  }
  return { get, calls };
}
