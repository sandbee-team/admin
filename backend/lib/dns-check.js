// DNS as the apex's OWN nameservers see it (P5 Stage 3, D44). A lookup made
// before a record existed is negatively cached by an ordinary resolver (RFC
// 2308), so the owner would see "not found" long after the record is live:
// every lookup here goes NS -> A of each NS -> a Resolver pointed at those
// IPs. Ported from the local go-live tool (F:\lucifer\scripts\go-live
// dns-check.mjs authoritative/checkRecords); the HTTPS probe is the worker's
// TLS probe instead. Answers are bounded and failures are codes, never the
// resolver's text. `dns`/`Resolver` are injectable for tests.
import nodeDns from "node:dns";
import { VERCEL_CNAME_RE } from "../../shared/web-address.js";

const MISS_CODES = new Set(["ENODATA", "ENOTFOUND"]);
const MAX_SERVERS = 8;
const MAX_ANSWERS = 8;
const MAX_NAME = 253;
const MAX_TXT = 1024;
const unreachable = () =>
  Object.assign(new Error("dns-unreachable"), { code: "dns-unreachable" });
const bare = (name) => String(name).replace(/\.+$/, "");

export function createDnsCheck({
  dns = nodeDns.promises,
  Resolver = nodeDns.promises.Resolver,
  timeoutMs = 4000,
} = {}) {
  async function authoritative(apex) {
    let nsHosts;
    try {
      nsHosts = await dns.resolveNs(apex);
    } catch {
      throw unreachable();
    }
    const ips = [];
    for (const host of (Array.isArray(nsHosts) ? nsHosts : []).slice(
      0,
      MAX_SERVERS,
    )) {
      try {
        ips.push(...(await dns.resolve4(host)));
      } catch {
        // One nameserver not resolving is not fatal; the others may answer.
      }
    }
    if (ips.length === 0) throw unreachable();
    const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
    resolver.setServers(ips.slice(0, MAX_SERVERS));
    return resolver;
  }

  // The first CNAME target (no trailing dot), null when there is none; any
  // other failure -> dns-unreachable.
  async function cnameOf(resolver, host) {
    try {
      const found = await resolver.resolveCname(host);
      return Array.isArray(found) && found.length ? bare(found[0]) : null;
    } catch (err) {
      if (MISS_CODES.has(err?.code)) return null;
      throw unreachable();
    }
  }

  // {cname: {found, ok, error?}, txt: {found, ok, error?}}; txt.ok is null
  // when no TXT row is asked for. Never throws.
  async function checkRecords({ apex, host, txt }) {
    const noTxt = { found: [], ok: null };
    let resolver;
    try {
      resolver = await authoritative(apex);
    } catch {
      const error = "dns-unreachable";
      return {
        cname: { found: null, ok: false, error },
        txt: txt ? { found: [], ok: false, error } : noTxt,
      };
    }
    let cname;
    try {
      const found = await cnameOf(resolver, host);
      cname = {
        found: found === null ? null : found.slice(0, MAX_NAME),
        ok:
          found !== null &&
          found.length <= MAX_NAME &&
          VERCEL_CNAME_RE.test(found),
      };
    } catch (err) {
      cname = { found: null, ok: false, error: err.code };
    }
    let txtResult = noTxt;
    if (txt) {
      const txtHost = txt.name === "@" ? apex : `${txt.name}.${apex}`;
      try {
        const rows = (await resolver.resolveTxt(txtHost)).map((chunks) =>
          (Array.isArray(chunks) ? chunks : [chunks]).join(""),
        );
        txtResult = {
          found: rows.slice(0, MAX_ANSWERS).map((v) => v.slice(0, MAX_TXT)),
          ok: rows.includes(txt.value),
        };
      } catch (err) {
        txtResult = MISS_CODES.has(err?.code)
          ? { found: [], ok: false }
          : { found: [], ok: false, error: "dns-unreachable" };
      }
    }
    return { cname, txt: txtResult };
  }

  // What the apex's nameservers already answer for `host` (a label in use by
  // someone else must not be taken over). Throws dns-unreachable when the
  // answer is unknown: an unknown answer is never read as "free".
  async function lookupLabel({ apex, host }) {
    const resolver = await authoritative(apex);
    const cname = await cnameOf(resolver, host);
    let a = [];
    if (cname === null) {
      try {
        a = (await resolver.resolve4(host)).slice(0, MAX_ANSWERS);
      } catch (err) {
        if (!MISS_CODES.has(err?.code)) throw unreachable();
      }
    }
    return {
      cname: cname === null ? null : cname.slice(0, MAX_NAME),
      a,
      inUse: cname !== null || a.length > 0,
    };
  }

  return { authoritative, checkRecords, lookupLabel };
}
