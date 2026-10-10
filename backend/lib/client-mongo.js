// Short-lived connection to a CLIENT's MongoDB (verify now, backups later).
// Atlas only: every host must end with .mongodb.net, so a stored URI cannot be
// turned into a probe of the internal network. Errors are reduced to fixed
// codes; the URI (it carries a password) never reaches a message or a log.
import { MongoClient } from "mongodb";

export const atlasHost = (host) =>
  /^[a-z0-9.-]+\.mongodb\.net$/i.test(host) && !host.startsWith(".");
// The host names of a connection string, without credentials or ports.
export function hostsOf(uri) {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/?]*@)?([^/?]+)/i.exec(
    typeof uri === "string" ? uri : "",
  );
  if (!m) return [];
  return m[1]
    .split(",")
    .map((part) => part.replace(/:\d+$/, "").toLowerCase())
    .filter(Boolean);
}
export class ClientMongoError extends Error {
  constructor(code) {
    super(`Client database check failed (${code})`);
    this.name = "ClientMongoError";
    this.code = code; // invalid | not-atlas | auth-failed | unreachable
  }
}
const AUTH_CODES = new Set([13, 18]);
// -> {client, db}; the caller closes `client`. Throws ClientMongoError.
export async function openClientDb(
  uri,
  {
    allowHost = atlasHost,
    timeoutMs = 8000,
    Client = MongoClient,
    appName = "sandbee-admin-worker",
    readPreference,
  } = {},
) {
  const hosts = hostsOf(uri);
  if (!hosts.length) throw new ClientMongoError("invalid");
  if (!hosts.every((host) => allowHost(host)))
    throw new ClientMongoError("not-atlas");
  let client;
  try {
    client = new Client(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
      socketTimeoutMS: timeoutMs + 2000,
      maxPoolSize: 2,
      appName,
      ...(readPreference ? { readPreference } : {}),
    });
    await client.connect();
    return { client, db: client.db() };
  } catch (error) {
    await client?.close().catch(() => {});
    throw new ClientMongoError(
      AUTH_CODES.has(error?.code) || error?.codeName === "AuthenticationFailed"
        ? "auth-failed"
        : error?.name === "MongoParseError" ||
            error?.name === "MongoInvalidArgumentError"
          ? "invalid"
          : "unreachable",
    );
  }
}
// "ok" | "invalid" | "not-atlas" | "auth-failed" | "unreachable"
export async function pingClientMongo(uri, options = {}) {
  let opened;
  try {
    opened = await openClientDb(uri, options);
    await opened.db.command({ ping: 1 });
    return "ok";
  } catch (error) {
    if (error instanceof ClientMongoError) return error.code;
    return AUTH_CODES.has(error?.code) ? "auth-failed" : "unreachable";
  } finally {
    await opened?.client.close().catch(() => {});
  }
}
