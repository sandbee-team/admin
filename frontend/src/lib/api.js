let csrf = "";
export function setCsrf(value) {
  csrf = value || "";
}
// A 401 ends the session unless it comes from a pre-session auth route (login,
// verify, verify-totp, recover) or the boot-time /auth/me check.
const SESSION_AUTH = [
  "/auth/step-up",
  "/auth/totp/",
  "/auth/logout",
  "/auth/revoke-sessions",
];
const endsSession = (path) =>
  !path.startsWith("/auth/") || SESSION_AUTH.some((p) => path.startsWith(p));
// Turns a non-2xx response into an Error carrying `status`. 428 means
// "confirm with your authenticator" (see components/step-up.jsx); only 401 ends
// the session.
async function failure(res, path) {
  const value = await res
    .json()
    .catch(() => ({ error: "The server returned an unreadable response." }));
  const error = new Error(value.error || "Request failed.");
  error.status = res.status;
  // Machine-readable reason when the server sends one ("stale", "not-configured").
  if (typeof value.code === "string") error.code = value.code;
  if (res.status === 401 && endsSession(path))
    window.dispatchEvent(new Event("admin-session-expired"));
  return error;
}
export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...options.headers,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) throw await failure(res, path);
  return res
    .json()
    .catch(() => ({ error: "The server returned an unreadable response." }));
}
// Raw upload: the browser sets Content-Length from the Blob. The file name and
// category travel in headers (the route takes no query string).
export async function upload(path, file, headers = {}) {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/octet-stream",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...headers,
    },
    body: file,
  });
  if (!res.ok) throw await failure(res, path);
  return res.json();
}
// POST that returns a file: resolves {blob, filename} from the attachment.
export async function download(path, body = {}) {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, path);
  const match = /filename\*=UTF-8''([^;]+)/i.exec(
    res.headers.get("Content-Disposition") || "",
  );
  let filename = "download";
  try {
    if (match) filename = decodeURIComponent(match[1]);
  } catch {
    // Keep the generic name for a malformed header.
  }
  return { blob: await res.blob(), filename };
}
export const dateTime = (value) =>
  value
    ? new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Not recorded";
export const label = (value) =>
  value?.replaceAll("-", " ").replaceAll("_", " ") || "—";
