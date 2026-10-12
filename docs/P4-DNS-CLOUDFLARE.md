# P4 — platform DNS → Cloudflare (owner runbook, D9)

Status: **DEFERRED by the owner 2026-10-12 to the end of the roadmap (D40): the DNS stays at GoDaddy
for now; nothing was changed at GoDaddy or Cloudflare.** Done: read-only review, this runbook (§9
answered: recommended defaults, the existing Cloudflare account, switch any time, 13.206.131.1 is an
Elastic IP), baseline steps 0.1-0.3 (GoDaddy zone export, mail headers, TLS/HTTP). **When P4 resumes:**
repeat step 0 (export, TLS loop) because client records may have been added meanwhile, do step 0.4,
update §2, then steps 1-6. Inventory: Batch 1 `dig` against GoDaddy's own nameserver (SOA serial
`2026100806`), confirmed by the zone export of 2026-10-12 15:56. Owner work, guided one step at a time; code
only if a real gap blocks a step (none found). Binding: `docs/POS-INTEGRATION.md` D9, D11, D14.

Rules for every step: paste results, never secrets. DNS records are public data and may be pasted;
Cloudflare/GoDaddy logins, 2FA codes, API tokens and email bodies may not. Every change at GoDaddy
or Cloudflare is confirmed in chat before it is made.

Goal: sandbee.in (every record) served by a Cloudflare zone with the SAME answers, zero downtime,
no mail loss, so Stage 3 (P5) can add client web addresses through the Cloudflare API.

## 1. What the review found

| #   | Finding | Effect | Handling |
| --- | ------- | ------ | -------- |
| F1  | Registrar **GoDaddy** (RDAP), DNS host **GoDaddy** (`ns27`/`ns28.domaincontrol.com`). Registered 2026-08-28, expires 2027-08-28. | Nameserver change is made in the same GoDaddy account. | Step 4. |
| F2  | **DNSSEC off** (`delegationSigned: false`, no DS record). | No DS removal needed before the switch (Cloudflare: a live DS at switch time breaks resolution). | Keep DNSSEC off in Cloudflare; enabling it is a later, separate decision. |
| F3  | Registry status carries `clientUpdateProhibited` (GoDaddy domain lock). | GoDaddy normally lifts it for its own nameserver change; if the change is refused, the lock is the cause. | Step 4: if refused, Domain lock off → change → lock on again. |
| F4  | Delegation TTL at the `.in` registry **900 s**. Cloudflare's own NS records carry **86 400 s** (fixed on the Free plan; lowering is Enterprise only). | The switch reaches resolvers within ~15-30 min; after a rollback some resolvers can keep asking Cloudflare for up to 24 h. | Both zones stay identical during the whole window; rollback keeps the Cloudflare zone unchanged ≥ 48 h (§6). |
| F5  | **No MX, no SPF, no DKIM, no CAA, no AAAA, no SRV, no wildcard.** Only `_dmarc` (GoDaddy's default: `p=quarantine`, reports to `onsecureserver.net`). | Nothing receives mail at sandbee.in today → no inbound mail can be lost. | Copy `_dmarc` exactly. Do not enable Cloudflare Email Routing (it adds MX records). |
| F6  | Admin sends through `smtp.gmail.com` with `MAIL_FROM` `admin@sandbee.in`, but Gmail **rewrites the sender**: the delivered code email has `From: sandbee.team@gmail.com`, `X-Google-Original-From: admin@sandbee.in`, `Return-Path: sandbee.team@gmail.com` (step 0.2 headers, 2026-10-12). | Admin mail is a gmail.com message: SPF/DKIM/DMARC are Gmail's, sandbee.in's DNS takes no part, so the move cannot affect it. | Step 5.5 checks the same `From`/`Return-Path`. Optional tidy-up later: set `MAIL_FROM` to the Gmail address so the config matches what is sent (Q6). |
| F7  | Caddy (`sandbee-edge-caddy-1`, `/opt/edge/Caddyfile`) has 5 sites and **no** `tls`/`dns`/`acme_*` directives → default automatic HTTPS (HTTP-01 / TLS-ALPN-01 to 13.206.131.1). | Certificates keep issuing and renewing as long as the records point at the box **directly** (DNS only / grey cloud). | Every record DNS only. Proxying (orange) is a later decision (§8). Do not add CAA during the move. |
| F8  | **One POS client address on sandbee.in: `posdemo`** CNAME → `82754187044e37bc.vercel-dns-017.com` (found only by the zone export; no `_vercel` TXT). POS `scripts/go-live/dns-check.mjs:24-41` finds the apex's nameservers at run time. | Losing this record takes the demo POS site down. The local go-live DNS check keeps working with Cloudflare (no POS change, D11). | Copied as R8, DNS only (Vercel issues its own certificate). Stage 3 adds `<label>` CNAME → Vercel (and `_vercel.<label>` TXT when Vercel asks), DNS only. |
| F9  | Names used in code/docs **without** a record: `ocr`, `ecom` (`backend/modules/catalog-seed.js`), `pos`, `notify`, `whatsapp` (company reference), `wa`, `waadmin` (WA project, not deployed). | Pre-existing; unaffected by the move. | Not created in P4. |
| F10 | Admin code holds no DNS logic (Stage 3); the Cloudflare adapter already accepts user- and account-owned tokens (`backend/lib/cloudflare.js`). | No code change for P4. | Token plan for P5 in §7. |
| F11 | TLS/HTTP baseline (step 0.3, 2026-10-12): all six box names Let's Encrypt (YE1/YE2), valid to 2027-01-06; `/` answers 200 on the website, www, admin and store, 404 on gstapi and ocrapi (normal: they serve `/api/health` only). `posdemo` was not in that run (found later). 13.206.131.1 is an **Elastic IP** (owner, EC2 console). | Verification compares against these values (renewals happen around 2026-12-07; re-run when P4 resumes). | Step 5.3. |
| F12 | The zone goes into the owner's **existing** Cloudflare account (`sandbee.team@gmail.com`, Q1). A token in that account whose zone scope is "All zones" would also reach sandbee.in once the zone is added. | A client/realtime token held elsewhere could gain rights on the platform zone. | Step 0.4 lists the account's tokens (names + scopes only) before the zone is created. |

## 2. Record inventory (GoDaddy, 2026-10-12)

| #  | Name | Type | Value | TTL now | Serves | Cloudflare copy |
| -- | ---- | ---- | ----- | ------- | ------ | --------------- |
| R1 | `sandbee.in` (@) | A | 13.206.131.1 | 600 | website (Caddy → `sandbee-website` 127.0.0.1:8099) | DNS only, TTL Auto |
| R2 | `www` | CNAME | `sandbee.in` | 3600 | website (Caddy site `sandbee.in, www.sandbee.in`) | DNS only, TTL Auto |
| R3 | `admin` | A | 13.206.131.1 | 600 | admin (Caddy → 127.0.0.1:8098) | DNS only, TTL Auto |
| R4 | `store` | A | 13.206.131.1 | 600 | Store (`sandbee-platform` 8094; demo 8096) | DNS only, TTL Auto |
| R5 | `gstapi` | A | 13.206.131.1 | 600 | GST API (8095) | DNS only, TTL Auto |
| R6 | `ocrapi` | A | 13.206.131.1 | 600 | OCR licence API (8097) | DNS only, TTL Auto |
| R7 | `_dmarc` | TXT | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` | 3600 | DMARC policy for mail From sandbee.in (none is sent today, F6) | exact copy, TTL Auto |
| R8 | `posdemo` | CNAME | `82754187044e37bc.vercel-dns-017.com` | 3600 | demo POS site on Vercel (F8) | DNS only, TTL Auto |
| —  | `_domainconnect` | CNAME | `_domainconnect.gd.domaincontrol.com` | 3600 | GoDaddy's Domain Connect discovery (GoDaddy default) | **not copied** (Q3) |
| —  | `@` | NS | `ns27`/`ns28.domaincontrol.com` | 3600 (zone), 900 (`.in` delegation) | delegation | replaced by Cloudflare's two names |
| —  | `@` | SOA | GoDaddy | 3600 | zone metadata | Cloudflare creates its own |

Checked and absent: AAAA, MX, apex TXT (no SPF, no site verification), CAA, SRV
(`_autodiscover`, `_submission`, `_imaps`), DKIM selectors `google default selector1 selector2 k1 s1
s2 zoho dkim mail`, `_vercel`, wildcard. The zone export (2026-10-12 15:56) lists exactly R1-R8,
`_domainconnect`, NS and SOA. `_domainconnect` points services to GoDaddy's own Domain Connect API,
which stops being right once GoDaddy no longer serves the zone, so it is left behind. The TTL step
also lowers R8 (3600 s).

## 3. TTL plan and timing

- Values do not change at the switch, so resolvers see the same answers from either provider; TTLs
  only decide how fast a correction or a rollback is seen.
- Web records are already 600 s. **Step 1, at least 1 h before the switch:** lower `www` (CNAME),
  `posdemo` (CNAME) and `_dmarc` (TXT) at GoDaddy from 1 hour to 600 s (GoDaddy "Custom", its minimum); the old TTL (1 h)
  must pass before step 4. Steps 2-3 fit inside that hour.
- Cloudflare copies use **TTL Auto (300 s)** during the move and the monitoring window, so a wrong
  value in Cloudflare is corrected for everyone within ~5 min.
- Fixed by others: `.in` delegation 900 s; Cloudflare NS 86 400 s (F4); negative answers (a name
  missing in the copy) are cached for the SOA minimum, which is why step 3 must show no gap
  **before** the switch.
- Create the Cloudflare zone and switch within 2 days (a Free zone left pending is deleted after
  28 days; a long gap invites drift between the two copies). Owner (Q4): any time; the owner watches
  the hour after the switch.
- After 7 quiet days TTLs may be raised (optional; Auto is fine for this traffic).

## 4. Order, what changes, stop points

| Step | Where | Changes | Stop / rollback |
| ---- | ----- | ------- | --------------- |
| 0 | GoDaddy, Gmail, server, Cloudflare | nothing (baseline) | any record not in §2 or an "All zones" token → stop, decide |
| 1 | GoDaddy | TTL of `www`, `posdemo`, `_dmarc` → 600 s | revert TTL (no effect on service) |
| 2 | Cloudflare | zone `sandbee.in` in the existing account, 8 records, DNS only | delete the zone (no effect: not delegated) |
| 3 | server | nothing (compare GoDaddy vs Cloudflare) | any `DIFF` → fix in Cloudflare, re-run |
| 4 | GoDaddy | **nameservers → Cloudflare's pair** (the only outward change) | §6 rollback |
| 5 | server, browser, Gmail | nothing (verification) | failure → fix in Cloudflare or §6 |
| 6 | server | nothing (monitoring +1 h, +24 h, +72 h) | as step 5 |

## 5. Steps

### Step 0 — baseline (read only)

1. **Zone export.** GoDaddy → My Products → sandbee.in → DNS → DNS Records → the "…"/Actions menu →
   **Export Zone File** (if the menu is missing, a screenshot listing every row is enough). Paste
   the text. Also tell whether the DNS page shows any **Forwarding** (domain or subdomain).
2. **Mail baseline.** Sign in to admin to get an email code. In the receiving Gmail: open that mail →
   ⋮ → **Show original** → paste ONLY the header lines `Return-Path:`, `From:`,
   `X-Google-Original-From:` and, if shown, `SPF:`/`DKIM:`/`DMARC:` (never the body: it holds the
   code). 2026-10-12: `Return-Path` and `From` = the Gmail address, original From `admin@sandbee.in` (F6).
3. **TLS + HTTP baseline** (server):

   ```sh
   for h in sandbee.in www.sandbee.in admin.sandbee.in store.sandbee.in gstapi.sandbee.in ocrapi.sandbee.in posdemo.sandbee.in; do
     printf '%-20s %s ' "$h" "$(curl -sS -o /dev/null -w '%{http_code}' https://$h/)"
     echo | openssl s_client -connect $h:443 -servername $h 2>/dev/null | openssl x509 -noout -issuer -enddate | tr '\n' ' '; echo
   done
   ```

4. **Cloudflare account check** (F12, read only): My Profile → Authentication → two-factor
   authentication is on (authenticator); My Profile → API Tokens and Manage Account → Account API
   Tokens → for each token: name, permission summary, zone resources ("All zones" or a named zone),
   status. Workers & Pages → the Worker names. Paste names and scopes only, never a token value.
   A token with "All zones" scope that does not need sandbee.in is narrowed before step 2 (owner OK
   first; a client token's scope is a change to something that works today, D11).

### Step 1 — lower three TTLs (GoDaddy; at least 1 h before step 4)

GoDaddy → DNS Records → `www` CNAME → Edit → TTL Custom **600** → Save; same for `posdemo` CNAME and
`_dmarc` TXT.
Nothing else is edited. Check: `dig +noall +answer CNAME www.sandbee.in @ns27.domaincontrol.com`
shows 600.

### Step 2 — Cloudflare zone (no effect on live traffic)

1. Cloudflare account for the **platform** (not a client's account), signed in with the platform
   email, authenticator 2FA on (Q1). Never share this login.
2. **Onboard a domain** → `sandbee.in` → choose **manual** record entry (Q2; if the quick scan runs,
   compare with §2 and delete anything else) → plan **Free**.
3. DNS → Records: create R1-R8 exactly as §2. For R1-R6 and R8 set **Proxy status = DNS only**
   (grey cloud), TTL **Auto**. R7 Content = the exact DMARC string; R8 target = the exact Vercel
   name. Nothing else: no `_domainconnect`, no MX, no SPF, no CAA, no Email Routing, no "suggested
   records".
4. DNS → Settings: **DNSSEC stays off**. SSL/TLS, caching and security settings are not touched
   (they apply only to proxied records).
5. Overview: note the two **assigned nameservers** (`<name>.ns.cloudflare.com`); paste them (public).

### Step 3 — compare both copies before the switch (read only)

Cloudflare answers for a pending zone on its assigned nameservers, so the copy can be checked
before any traffic moves. On the server (replace `<cf-ns-1>`):

```sh
CF=<cf-ns-1>; GD=ns27.domaincontrol.com
for r in "sandbee.in A" "www.sandbee.in CNAME" "admin.sandbee.in A" "store.sandbee.in A" "gstapi.sandbee.in A" \
         "ocrapi.sandbee.in A" "posdemo.sandbee.in CNAME" "_dmarc.sandbee.in TXT" "sandbee.in AAAA" "sandbee.in MX" "sandbee.in TXT" "sandbee.in CAA" \
         "zz-nope.sandbee.in A"; do
  set -- $r; g=$(dig +short $2 $1 @$GD | sort); c=$(dig +short $2 $1 @$CF | sort)
  [ "$g" = "$c" ] && echo "same $1 $2" || echo "DIFF $1 $2 godaddy=[$g] cloudflare=[$c]"
done
```

Every line must read `same` (plus any extra names from the export, added to the list). Any `DIFF` →
fix in Cloudflare, run again.

### Step 4 — switch nameservers (GoDaddy; confirm in chat first)

GoDaddy → My Products → sandbee.in → DNS → **Nameservers** → Change nameservers → **I'll use my own
nameservers** → enter the two Cloudflare names exactly (no others) → Save → confirm. **Do not delete
or edit any GoDaddy DNS record** (they are the rollback). If GoDaddy refuses, see F3. Then in
Cloudflare: Overview → **Check nameservers now**. Note the time.

### Step 5 — verification (read only)

1. Delegation: `dig +norecurse +noall +authority NS sandbee.in @$(dig +short NS in. | head -1)`
   shows only the two Cloudflare names; Cloudflare shows the zone **Active** (minutes to a few hours).
2. Public resolvers: for `R in 1.1.1.1 8.8.8.8 9.9.9.9`, the step 3 names via `dig +short @$R`
   give the §2 values (a resolver may answer from the old copy until its cache expires: same values).
3. HTTPS: the step 0.3 loop → same HTTP codes, certificate issuer unchanged, no error.
4. Admin: sign in with password + email code + authenticator; open the dashboard; sign out.
5. Mail: the new code email arrives and its **Show original** shows the same `Return-Path`/`From` as 0.2.
6. Caddy: `docker logs --since 2h sandbee-edge-caddy-1 2>&1 | grep -iE 'error|challenge|obtain' | tail -20`
   shows no new certificate errors.

### Step 6 — monitoring window (72 h)

Repeat 5.2, 5.3 and 5.6 at +1 h, +24 h and +72 h (the 24 h Cloudflare NS cache, F4). The GoDaddy
records stay as they are (no cost); P4 is done after the +72 h check passes.

## 6. Rollback

- **One wrong record** (most likely failure): correct it in Cloudflare; with TTL Auto everyone sees
  the fix within ~5 min. This is preferred over a nameserver rollback.
- **Full rollback** (Cloudflare itself unusable, or several names failing): GoDaddy → Nameservers →
  **GoDaddy nameservers (default)**. The GoDaddy records were never touched (if GoDaddy shows them
  missing, re-enter the eight rows from §2 / the export). Keep the Cloudflare zone and its records
  **unchanged for at least 48 h**: resolvers that cached Cloudflare's NS (24 h) keep asking it.
  Cloudflare marks the zone "Moved" and removes it later on its own.
- The pre-switch state is fully described by §2 + the export, so either provider can be rebuilt.

## 7. Cloudflare API token for Stage 3 (plan only)

- Created only when the zone is on Cloudflare AND admin's code needs it (Q5); nothing in P4 uses a
  token. While the DNS stays at GoDaddy (D40), Stage 3 cannot use it: client records are entered by
  hand at GoDaddy and admin only checks them (an authoritative check works with any DNS host).
  GoDaddy's own API (open to accounts with one active domain, 20,000 calls/month) is not a good
  substitute: its key is account-wide (it can also change nameservers, contacts and transfers), with
  no zone or DNS-only scope; recommended for P5: no GoDaddy key on the server.
- **Account-owned** custom token (Manage Account → Account API Tokens), so it does not depend on a
  person's login. Permission: **Zone → DNS → Edit**, nothing else. Zone resources: **Include →
  Specific zone → sandbee.in**. The zone id is stored as plain config, so Zone:Read is not needed.
  Client IP filter: the box's Elastic IP 13.206.131.1 (Q7). Expiry: 1 year, shown by admin's
  existing token-expiry check.
- Stored only in the server `~/admin/.env` (name chosen in P5) and the password manager; handed only
  to the container that calls Cloudflare (as compose does for `POS_GITHUB_*` today); never in chat,
  logs, errors, URLs, argv or git. Rotation: Roll in the dashboard → update `.env` → restart.
- Admin code must refuse to touch the platform's own names (`@`, `www`, `admin`, `store`, `gstapi`,
  `ocrapi`, `_dmarc`, `_domainconnect`, and the cafe's reserved `app`, `api`, `hub`): DNS Edit can
  change any record in the zone, so the guard lives in admin, with tests; a client label (such as
  `posdemo`) is changed only for its own installation.

## 8. Risks

1. A record missed by the copy breaks that name → export + step 3 compare + no wildcard; fix in
   Cloudflare within ~5 min.
2. A record proxied (orange) by mistake: Caddy's certificate challenges and the client IP change.
   Behind Cloudflare's proxy every request reaches Caddy from Cloudflare's addresses, so admin's
   per-IP rate limits and audit IPs (`TRUST_PROXY_HOPS=1`) would see Cloudflare instead of the user.
   Proxying is therefore a separate later decision (SSL mode Full (strict), Caddy `trusted_proxies`,
   `TRUST_PROXY_HOPS`, tests); P4 is DNS only.
3. Accidental mail change (Email Routing / suggested SPF or MX) → nothing mail-related is added; 5.5
   compares with the baseline.
4. Domain lock refuses the change (F3) → toggle lock, change, lock again.
5. Slow rollback because of the 24 h Cloudflare NS cache (F4) → identical copies; prefer record fixes.
6. Whoever controls the Cloudflare or GoDaddy login controls every sandbee.in name → authenticator
   2FA on both, unique passwords, no shared logins; the Stage 3 token is DNS-only and zone-scoped.
7. A Free zone pending for 28 days is deleted → switch within 2 days of creating it.
8. Pre-existing, unchanged by P4: names without records (F9); admin mail is Gmail's (F6). The box IP
   13.206.131.1 is an Elastic IP (Q7), so it survives a stop/start.

## 9. Owner questions (recommended default in bold)

Answered 2026-10-12: Q1 the existing account `sandbee.team@gmail.com` (step 0.4 still open); Q2,
Q3, Q5, Q6 the recommended defaults (owner: "check it properly"); Q4 any time; Q7 yes, Elastic IP.
Then the owner deferred the move itself to the end of the roadmap (D40).

- Q1 Cloudflare account: **a dedicated platform account (platform email, authenticator 2FA)**, not
  a client's account. Do you already have one?
- Q2 Records: **enter the 8 records by hand** (small zone, nothing proxied by accident) rather than
  the quick scan or a zone-file import.
- Q3 Copy **`_dmarc` exactly as it is**; do **not** copy GoDaddy's `_domainconnect` (the export
  shows it). No other mail record during the move.
- Q4 Switch time: **within 2 days of step 2, an IST evening when you can watch for 1 hour**.
- Q5 API token: **create it in P5**, not now.
- Q6 Mail (F6): Gmail already sends as the Gmail address, so nothing is broken; **optional tidy-up
  any time: `MAIL_FROM` = the Gmail address in `~/admin/.env`** (no DNS change). Real mail from
  sandbee.in would need a sending service that signs for sandbee.in (SPF/DKIM): a separate decision.
- Q7 Is 13.206.131.1 an **Elastic IP** (EC2 → Elastic IPs)? If not, allocating one is a separate
  task before P5.
