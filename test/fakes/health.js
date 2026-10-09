// Scripted stand-in for safe-https getText: answers /api/health and /login from
// queues (the last entry repeats). An Error entry is thrown.
export const HTML = "<!DOCTYPE html><html><body>login</body></html>";
export function createFakeHealth({ health = [], login = [] } = {}) {
  const calls = [];
  const queues = { "/api/health": [...health], "/login": [...login] };
  async function get(host, path, options = {}) {
    calls.push({ host, path, options });
    const queue = queues[path];
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
