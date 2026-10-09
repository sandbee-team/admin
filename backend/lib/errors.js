export class HttpError extends Error {
  // `expose` lets a deliberate 5xx message reach the client; without it the
  // error handler replaces 5xx messages with a generic one.
  constructor(status, message, expose = false) {
    super(message);
    this.status = status;
    this.expose = expose;
  }
}
// 409 for a stale revision: the envelope carries `code: "stale"` so clients
// can reload without matching on the message.
export const staleError = (message) => {
  const error = new HttpError(409, message);
  error.apiCode = "stale";
  return error;
};
export function ensure(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}
