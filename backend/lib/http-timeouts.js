// Server timeouts (Node docs, http.Server):
// - keepAliveTimeout (default 5 s): idle time after a response before the
//   socket is destroyed. The proxy in front (Caddy) keeps upstream connections
//   idle for about two minutes, so ours must be longer or a request can be
//   written to a socket Node is closing, which the proxy reports as a 502.
// - headersTimeout: time allowed to receive the complete HTTP headers of a
//   request (slowloris protection). It is independent of keepAliveTimeout.
// - requestTimeout: time allowed to receive the entire request, which bounds
//   the 20 MB file uploads.
export const TIMEOUTS = {
  keepAliveTimeout: 125000,
  headersTimeout: 10000,
  requestTimeout: 60000,
};
export function applyTimeouts(server, overrides = {}) {
  Object.assign(server, { ...TIMEOUTS, ...overrides });
  return server;
}
