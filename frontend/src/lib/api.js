let csrf = "";
export function setCsrf(value) {
  csrf = value || "";
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
  const value = await res
    .json()
    .catch(() => ({ error: "The server returned an unreadable response." }));
  if (!res.ok) {
    const error = new Error(value.error || "Request failed.");
    error.status = res.status;
    if (res.status === 401 && !path.startsWith("/auth/"))
      window.dispatchEvent(new Event("admin-session-expired"));
    throw error;
  }
  return value;
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
