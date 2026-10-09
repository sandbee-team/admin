// Outbound HTTPS to a host a staff member typed (the health probe). The host
// must be a public DNS name; every address it resolves to must be public (a
// guarded lookup, so a rebind between check and connect cannot help); no
// redirects are followed; time and size are bounded.
import dns from "node:dns";
import https from "node:https";
import net from "node:net";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A DNS name with an alphabetic TLD; IP literals, ports and "localhost" fail.
export function validPublicHost(host) {
  if (typeof host !== "string" || host.length > 253) return false;
  const labels = host.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    /^[a-z]{2,63}$/.test(labels.at(-1))
  );
}
function parseV6(text) {
  if (text.includes("%")) return null;
  let head = text,
    tail = "";
  const dbl = text.indexOf("::");
  if (dbl >= 0) {
    if (text.indexOf("::", dbl + 1) >= 0) return null;
    head = text.slice(0, dbl);
    tail = text.slice(dbl + 2);
  }
  const split = (part) => (part === "" ? [] : part.split(":"));
  const groups = (parts) => {
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.includes(".")) {
        if (i !== parts.length - 1 || !net.isIPv4(part)) return null;
        const b = part.split(".").map(Number);
        out.push((b[0] << 8) | b[1], (b[2] << 8) | b[3]);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) out.push(parseInt(part, 16));
      else return null;
    }
    return out;
  };
  const a = groups(split(head)),
    b = groups(split(tail));
  if (!a || !b) return null;
  const missing = 8 - a.length - b.length;
  if (dbl >= 0 ? missing < 1 : missing !== 0) return null;
  const all = [...a, ...Array(dbl >= 0 ? missing : 0).fill(0), ...b];
  return all.length === 8 ? all : null;
}
const inV4 = (b, base, bits) => {
  const x = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  const y =
    ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (x & mask) === (y & mask);
};
const V4_BLOCKED = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];
// true only for an address a public host could have.
export function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const b = address.split(".").map(Number);
    return !V4_BLOCKED.some(([base, bits]) => inV4(b, base, bits));
  }
  if (!net.isIPv6(address)) return false;
  const g = parseV6(address);
  if (!g) return false;
  const v4 = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
  const first5 = g.slice(0, 5).every((x) => x === 0);
  // ::, ::1, IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible.
  if (first5 && (g[5] === 0xffff || g[5] === 0)) {
    return g[5] === 0xffff ? isPublicAddress(v4) : false;
  }
  // NAT64 (64:ff9b::/96) carries an IPv4 address; local-use NAT64 is blocked.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return isPublicAddress(v4);
  if (g[0] === 0x64 && g[1] === 0xff9b) return false;
  if ((g[0] & 0xe000) !== 0x2000) return false; // only 2000::/3 is global unicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  if (g[0] === 0x2002) return false; // 6to4
  if (g[0] === 0x3fff && g[1] < 0x1000) return false; // documentation (RFC 9637)
  return true;
}
// dns.lookup replacement that refuses any non-public answer. Handles both the
// `all: true` and single-address callback shapes.
export function guardedLookup(hostname, options, callback) {
  const opts = typeof options === "function" ? {} : (options ?? {});
  const done = typeof options === "function" ? options : callback;
  dns.lookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return done(error);
    if (
      !addresses.length ||
      !addresses.every((a) => isPublicAddress(a.address))
    )
      return done(
        Object.assign(new Error("blocked address"), { code: "EBLOCKED" }),
      );
    if (opts.all) return done(null, addresses);
    return done(null, addresses[0].address, addresses[0].family);
  });
}
export class SafeHttpsError extends Error {
  constructor(code) {
    super(`Request failed (${code})`);
    this.name = "SafeHttpsError";
    this.code = code;
  }
}
// GET https://<host><path> -> {status, headers, text}. `send` is the test seam.
export async function getText(
  host,
  path,
  {
    timeoutMs = 10000,
    maxBytes = 65536,
    headers = {},
    signal,
    lookup = guardedLookup,
    send = realSend,
  } = {},
) {
  if (!validPublicHost(host)) throw new SafeHttpsError("bad-host");
  if (
    typeof path !== "string" ||
    !/^\/[A-Za-z0-9._~\/-]{0,200}$/.test(path) ||
    path.includes("//") ||
    path.split("/").includes("..")
  )
    throw new SafeHttpsError("bad-path");
  return send({
    hostname: host,
    port: 443,
    path,
    method: "GET",
    headers: { "user-agent": "sandbee-admin-health", ...headers },
    lookup,
    timeoutMs,
    maxBytes,
    signal,
  });
}
export async function getJson(host, path, options = {}) {
  const result = await getText(host, path, {
    ...options,
    headers: { accept: "application/json", ...(options.headers ?? {}) },
  });
  let json = null;
  try {
    json = JSON.parse(result.text);
  } catch {
    json = null;
  }
  return { status: result.status, headers: result.headers, json };
}
function realSend({ timeoutMs, maxBytes, signal, ...options }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = https.request(options, (res) => {
      const parts = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          return finish(reject, new SafeHttpsError("too-large"));
        }
        parts.push(chunk);
      });
      res.on("error", () => finish(reject, new SafeHttpsError("network")));
      res.on("end", () =>
        finish(resolve, {
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(parts).toString("utf8"),
        }),
      );
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(reject, new SafeHttpsError("timeout"));
    }, timeoutMs);
    signal?.addEventListener("abort", () => {
      req.destroy();
      finish(reject, new SafeHttpsError("aborted"));
    });
    req.on("error", (error) =>
      finish(
        reject,
        new SafeHttpsError(error?.code === "EBLOCKED" ? "blocked" : "network"),
      ),
    );
    req.end();
  });
}
