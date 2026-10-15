// A stateful fake `dns` + `Resolver` pair for createDnsCheck({dns, Resolver})
// (backend/lib/dns-check.js). Used by test/stage3-adapters-cf.test.js and the
// go-live worker tests (W5).
//
//   const fake = createFakeDns();                  // apex "sandbee.in"
//   const check = createDnsCheck({ dns: fake.dns, Resolver: fake.Resolver });
//   fake.add("posdemo.sandbee.in", "CNAME", "abcd1234.vercel-dns-017.com");
//   fake.add("_vercel.posdemo.sandbee.in", "TXT", "vc-domain-verify=...");
//   fake.remove("posdemo.sandbee.in", "CNAME");    // or (name, type, value)
//
// Model: ordinary resolution (`dns`: resolveNs of the apex, resolve4 of a
// nameserver host) answers from `nameservers`; the zone's records answer ONLY
// through a Resolver whose setServers() included one of the nameserver IPs
// (anything else times out, ETIMEOUT, like an unreachable server). Per
// name+type: records present -> the answers; name in `nxdomain` -> ENOTFOUND;
// otherwise ENODATA. Switches (all can be flipped between calls):
//   fake.timeouts(true)       every zone query times out (ETIMEOUT)
//   fake.failNs(true)         resolveNs of the apex fails (ESERVFAIL)
//   fake.failNsHost(host)     resolve4 of that nameserver host fails
//   fake.nxdomain(name, true) the whole name does not exist (ENOTFOUND)
//   fake.servfail(name, true) queries for the name answer ESERVFAIL
// Inspect: fake.queries (resolver calls: {server list, type, name}),
// fake.resolvers (constructor options), fake.state.
export function createFakeDns({
  apex = "sandbee.in",
  nameservers = {
    "ns01.fake-dns.test": ["198.51.100.1"],
    "ns02.fake-dns.test": ["198.51.100.2"],
  },
} = {}) {
  const state = {
    apex,
    nameservers: Object.fromEntries(
      Object.entries(nameservers).map(([h, ips]) => [h, [...ips]]),
    ),
    records: new Map(), // "TYPE name" -> string[] (TXT: string[] rows)
    nxdomain: new Set(),
    servfail: new Set(),
    timeouts: false,
    nsFails: false,
    nsHostFails: new Set(),
  };
  const queries = [];
  const resolvers = [];
  const key = (type, name) => `${type} ${String(name).toLowerCase()}`;
  const err = (code) => Object.assign(new Error(code), { code });
  const knownIps = () => new Set(Object.values(state.nameservers).flat());

  const api = {
    state,
    queries,
    resolvers,
    add(name, type, value) {
      const k = key(type, name);
      state.records.set(k, [...(state.records.get(k) ?? []), value]);
      return api;
    },
    remove(name, type, value) {
      const k = key(type, name);
      if (value === undefined) state.records.delete(k);
      else
        state.records.set(
          k,
          (state.records.get(k) ?? []).filter((v) => v !== value),
        );
      return api;
    },
    timeouts: (on = true) => ((state.timeouts = on), api),
    failNs: (on = true) => ((state.nsFails = on), api),
    failNsHost: (host) => (state.nsHostFails.add(host), api),
    nxdomain: (name, on = true) => (
      on ? state.nxdomain.add(name) : state.nxdomain.delete(name),
      api
    ),
    servfail: (name, on = true) => (
      on ? state.servfail.add(name) : state.servfail.delete(name),
      api
    ),
  };

  api.dns = {
    async resolveNs(name) {
      if (state.nsFails || name !== state.apex) throw err("ESERVFAIL");
      return Object.keys(state.nameservers);
    },
    async resolve4(host) {
      if (state.nsHostFails.has(host)) throw err("ESERVFAIL");
      const ips = state.nameservers[host];
      if (!ips) throw err("ENOTFOUND");
      return [...ips];
    },
  };

  api.Resolver = class FakeResolver {
    constructor(options = {}) {
      this.options = options;
      this.servers = [];
      resolvers.push(this);
    }
    setServers(servers) {
      this.servers = [...servers];
    }
    #answer(type, name) {
      queries.push({ servers: [...this.servers], type, name });
      const reachable = this.servers.some((ip) => knownIps().has(ip));
      if (state.timeouts || !reachable) throw err("ETIMEOUT");
      if (state.servfail.has(name)) throw err("ESERVFAIL");
      if (state.nxdomain.has(name)) throw err("ENOTFOUND");
      const found = state.records.get(key(type, name));
      if (!found || found.length === 0) throw err("ENODATA");
      return found;
    }
    async resolveCname(name) {
      return [...this.#answer("CNAME", name)];
    }
    async resolve4(name) {
      return [...this.#answer("A", name)];
    }
    // TXT answers are arrays of chunks; a row given as an array stays chunked.
    async resolveTxt(name) {
      return this.#answer("TXT", name).map((row) =>
        Array.isArray(row) ? [...row] : [row],
      );
    }
  };
  return api;
}
