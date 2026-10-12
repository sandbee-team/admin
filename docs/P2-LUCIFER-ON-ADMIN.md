# P2 — Lucifer on admin (owner runbook)

Status: DEFERRED by the owner 2026-10-12 (Lucifer is handled at the end of the roadmap); the review
below stays valid until the code paths change, the questions in §4 are still open. Owner work, guided one step at a time; code only if a
real gap blocks a step (house method, `docs/ROADMAP.md`). Binding: `docs/POS-INTEGRATION.md` D1-D38
(esp. D3, D5, D11, D14, D15, D25, D28, D37, D38).

Rules for every step: paste results, never secrets. Values go straight from their source (Vercel
dashboard, your local files, password manager) into the admin field. Paste back only names, codes,
counts, ids that start with `dpl_`/`prj_`, and the on-screen status text.

## 1. What the review found (read-only, verified in code)

Paths: admin = this repo, POS = `F:\lucifer` (read only; `clients/*` and `deploy.profiles.json` not read).

| # | Finding | Effect | Handling |
| - | ------- | ------ | -------- |
| F1 | **Function region.** `apps/cafe/vercel.json` sets `regions: ["bom1"]`. The local console deploys with the project's root directory, so the CLI reads that file and sends `bom1`. Admin's deploy root has an empty `apps/cafe` and no `vercel.json`, and passes no `--regions` (`backend/worker/cli-runner.js:95-107`, `backend/worker/deploy.js:613-623`; CLI 63.1.0: `regions = --regions ‖ localConfig.regions`). | Expected (step 0 confirms on demo): an admin deploy runs the functions in the project's default **Function Region** (Vercel default `iad1`, USA) → every DB call crosses continents: slower, not broken. Demo may already be affected. | Step 0 measures it. Fix without code: Project → Settings → Functions → Function Region = **Mumbai (bom1)** before the first admin deploy (Q1). |
| F2 | **No local lock exists for Lucifer.** `scripts/deploy.mjs:155-165` honours `deployLock` only from a `clients/<slug>.json` that owns the profile; `lucifer007` has none (D15). | "deployLock: true in its local client file" cannot be done for Lucifer. | Equivalent stop: remove the `lucifer007` entry from `deploy.profiles.json` (copy kept in the password manager), later revoke the old local Vercel token (Q2). |
| F3 | **Source parity.** Admin builds a pushed commit; the local console uploads the working tree (the POS checkout has uncommitted changes under `apps/cafe` and `packages` today). | If Lucifer's live version contains uncommitted work, an admin deploy removes it. | Step 0.4 + Q4: the branch must contain everything live. |
| F4 | **Verify reads Lucifer's Vercel env.** `TENANT_ID`, `ROOT_DOMAIN`, `MONGODB_URI` must exist (production); PLAIN values are compared with admin (`TENANT_ID`, `ROOT_DOMAIN`, the three `NEXT_PUBLIC_*`); encrypted values are not compared (`backend/worker/verify.js:21,146-179`). | A typo in an encrypted `NEXT_PUBLIC_*` copy would be baked into the build unseen. | Copy image/realtime values exactly (step 1.3). Never change Lucifer's Vercel env without deciding together: env changes take effect at the next deploy. |
| F5 | **Baseline = the project's production record** (last alias request first, `verify.js:183-188`). After dashboard promote/rollback history it can name an older deployment. | Wrong "Before admin" card; on Hobby an automatic rollback could be refused. | Note the live `dpl_` id before deploying (0.2) and compare after (3.3). |
| F6 | Failure-path display lows (no effect on a successful run): a lagging production pointer can be recorded as `rolled-back` (`deploy.js:1252-1273`); after a good rollback with a failed re-probe the text says the old version was not restored (`deploy-error.jsx:39-40`); an unhealthy finalize shows the Live badge "Deployed" (`deploy.js:1083`). | Misleading text only if something fails. | Not fixed in P2; listed for P8. On any failure the Vercel dashboard is the truth. |

Everything else checked out for a second client: nothing hard-codes demo; personal Hobby accounts
work (no `teamId` sent unless the org id starts with `team_`); the only build-time inputs of the cafe
are the three `NEXT_PUBLIC_*` values and admin supplies them from POS setup; `TENANT_ID`,
`ROOT_DOMAIN` and all secrets are read at runtime from Lucifer's Vercel env (admin never writes it).

## 2. Order, what changes, stop points

| Step | Where | Changes | Stop / rollback |
| ---- | ----- | ------- | --------------- |
| 0 Pre-checks | terminal, Vercel dashboard | nothing (+ Function Region if Q1 = yes) | stop on any surprise; region change can be set back |
| 1 Enter Lucifer | admin | admin records only (POS block starts **locked**) | delete the records; nothing outside admin changed |
| 2 Verify → local stop → Unlock | admin, PC | admin lock off; profile entry removed locally | Lock button any time; restore the profile entry from the password manager |
| 3 First deploy + Redeploy | admin | **Lucifer production** | before promote: untouched; health fail: automatic rollback; else Vercel Instant Rollback to the noted `dpl_` id |
| 4 Purge | admin | deletes Lucifer's old source deployments | not undoable; live site and Live/Previous always kept |
| 5 Old token + Usage | Vercel, admin | old token revoked; usage result stored | create a new token if needed |

## 3. Steps

### Step 0 — pre-checks (read only)

1. Region: `curl -sI https://<demo host>/api/health` and the same for Lucifer's host; paste the
   `x-vercel-id` lines (format `<edge>::<function region>::<request id>`). Lucifer (local build)
   should show `bom1` as the function region; demo shows what admin deploys get.
2. Lucifer's Vercel dashboard: Settings → General: **Framework** and **Root Directory** (admin needs
   Next.js and `apps/cafe`); Settings → Functions: **Function Region**; Deployments: the current
   Production deployment id (`dpl_…`) and its commit.
3. Settings → Environment Variables: for each of `TENANT_ID`, `ROOT_DOMAIN`, `MONGODB_URI`,
   `HEALTH_STATS_TOKEN`, `NEXT_PUBLIC_R2_PUBLIC_BASE_URL`, `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`,
   `NEXT_PUBLIC_REALTIME_URL`: present? type (Plain / Encrypted / Sensitive)? Production target? Names only.
4. Is Lucifer's live commit on the branch you will deploy, and was it deployed with uncommitted
   local changes? Any standby profiles (`lucifer007-*`)?

### Step 1 — enter Lucifer by hand (D15)

1. **Customer** (Customers → New): Contact name, Email address (unique), Company, Phone number,
   Status **active**. Expect: saved.
2. **Installation** (Installations → New): Installation name `Lucifer POS`, Customer = Lucifer,
   Product = POS, Environment **production**, Lifecycle `planned`, Endpoint `https://<host>`.
3. **POS setup → POS configuration** (first Save creates the block, locked):

   | Admin field | Value from | Rule / what uses it |
   | ----------- | ---------- | ------------------- |
   | Slug | your choice, `lucifer` | typed in every confirm |
   | Subdomain | first label of the host | informational |
   | Host | Lucifer's live web address that answers directly (no redirect), no `https://` | health check, usage |
   | Root domain | Vercel `ROOT_DOMAIN` value, exactly | verify compares |
   | Tenant ID | Vercel `TENANT_ID` value, exactly | `/api/health` must echo it |
   | POS admin username | optional (D3) | stored only |
   | Vercel project name / project ID / org ID | `lucifer007` profile ids | org ID = personal "Vercel ID" or `team_…` |
   | Vercel team ID | **leave blank** | a username here breaks every Vercel call |
   | "This POS uses a Cloudflare Worker" | on if Lucifer has a Cloudflare account | needed before the Cloudflare token |
   | Cloudflare account ID | Cloudflare dashboard (URL / account home) | 32 lowercase hex, else usage says not set |
   | Worker name / Worker URL | Lucifer's realtime Worker; URL = `https://<host of NEXT_PUBLIC_REALTIME_URL>` | admin derives `wss://<host>/join`; blank if Lucifer has no realtime URL |
   | Image store + Public base URL / Cloud name | `NEXT_PUBLIC_R2_PUBLIC_BASE_URL` or `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, exactly | baked into the build |

4. **Secrets** (Set → modal; each shows only "set" + time afterwards):
   - **Vercel token**: NEW token in Lucifer's Vercel → Account Settings → Tokens (name `sandbee-admin`,
     scope Lucifer's account, expiry your choice; Usage warns 14 days ahead).
   - **MongoDB connection string**: Vercel `MONGODB_URI` value; must end with `/<database>`.
   - **Cloudflare token**: NEW token with only **Account → Account Analytics → Read** on Lucifer's account.
   - **Health stats token**: Vercel `HEALTH_STATS_TOKEN`, only if present, only AFTER Host is saved
     (D37 binds it to the host; re-save after any host change).
   - Skip for now (Q3): Image store keys, Auth secret, Realtime publish secret, POS admin password.
5. **Accounts** (customer → Accounts, D5): one entry per portal login from your notes; password,
   authenticator key (base32 or `otpauth://`) and backup codes in their own fields, never in Notes.

### Step 2 — Verify, local stop, Unlock

1. Deploy tab → **Verify now**. Expect `ok` for vercel, project, env, mongo, health; cloudflare `ok`
   or skipped. A Node-version **warning** is fine (admin builds on Node 22).

   | Problem | Meaning | Fix |
   | ------- | ------- | --- |
   | vercel `Token rejected` / `Access refused` | token wrong or wrong scope | new token for Lucifer's account |
   | project `not-found` | project id not visible to this token, or a team id was entered | check ids, Team ID blank |
   | project `settings` | Framework not Next.js or Root Directory not `apps/cafe` | STOP, paste it |
   | env `missing` / `drift` | required env name absent / plain value differs from admin | fix the admin field; if Vercel is wrong, STOP |
   | mongo `not-atlas` / `auth-failed` / `unreachable` | not `*.mongodb.net` / bad credentials / network | re-copy `MONGODB_URI`; Atlas network access |
   | cloudflare `invalid` | token or account id wrong | new token, check account id |
   | health `unhealthy` / `login failed` | `/api/health` not 200 + ok + db up + tenant, or `/login` not HTML | check Host and Tenant ID; STOP if the site itself fails |

2. **Local stop (Q2):** copy the `lucifer007` entry of `F:\lucifer\deploy.profiles.json` into the
   password manager, delete it from the file, then `npm run deploy -- --list` (lists only; never run
   a deploy to test) must not show `lucifer007`.
3. **Unlock** (needs a clean verify under 24 h): tick "I set deployLock in the local client file"
   (for Lucifer: the profile is removed), type the slug, authenticator code. Expect "Deploys are
   unlocked for this client." and every readiness item ok (build cache may be amber only if off).

### Step 3 — first admin deploy, then Redeploy

Before pressing: Function Region = Mumbai (Q1), branch confirmed (Q4), live `dpl_` id noted.

What happens: **preflight** (lock, customer, project settings, env; baseline = current production +
3 health probes) → **resolve** (build key) → **build** (GitHub Actions on pos-builder, a few minutes;
or a cache hit) → **fetch** (download, scan, seal into S3) → **upload** (`vercel deploy --prebuilt
--prod --skip-domain`: staged, NOT live) → **vercel** (READY, then promote: live on every domain) →
**health** (12 × 5 s: 200, ok, db up, tenant = Tenant ID; then `/login`) → **finalize** (Live = new,
Previous = "Before admin" baseline, cutover date set).
Failure before promote: production untouched. Health fails after promote and the baseline was
healthy: automatic Vercel rollback to the baseline, status `rolled-back`, email. Baseline unhealthy or
rollback refused: the new version stays live (`unhealthy`) → Vercel dashboard → Deployments → the
noted `dpl_` → Instant Rollback.

1. Deploy → branch → plan shows "will build" → type slug → authenticator code. Paste the final status.
2. Checks: `x-vercel-id` shows `bom1`; the Previous card id = the noted `dpl_`; you open Lucifer and
   check login, one sale screen, images, realtime.
3. **Redeploy** (live commit): the plan must say **cached**; no GitHub run; status succeeded. The
   first admin deploy becomes Previous, so the pre-admin version is no longer kept by admin.

### Step 4 — purge old source deployments (D38)

Deploy → Old source deployments → **Preview old deployments** → **Remove N old deployments…** → slug
→ code → "Removed N …". Preview again until "Nothing to remove." Then in Lucifer's Vercel dashboard
only admin's deployments remain, and the live deployment's Source tab shows compiled output only (D29).

### Step 5 — old token, Usage

1. Revoke the old local Vercel token (the one from the `lucifer007` entry) in Lucifer's Vercel →
   Tokens, unless something else still uses it.
2. Usage tab → **Watch** on → **Check now**. Expect: site up + latency; storage from the health stats
   (or "direct", core only, without the stats token); Cloudflare Worker requests today/yesterday (or
   "Analytics permission missing"); Vercel and Cloudflare token expiry. `stats-host-changed` → save the
   Health stats token again.

## 4. Owner questions (recommended default in bold)

1. F1: set the **Function Region to Mumbai (bom1) by hand** on Lucifer's project before its first admin
   deploy (and on demo's, then Redeploy demo, if step 0 shows `iad1`); no code now; record as D41 (D39 went to P3, D40 to P4).
   (Alternative later: admin passes `--regions`, a code change.) **Yes.**
2. F2: the local stop for Lucifer = **remove the `lucifer007` profile before Unlock** (copy in the
   password manager) and revoke the old token in step 5; record as D42. **Yes.**
3. Skip Image store keys, Auth secret, Realtime publish secret and POS admin password for now (stored
   only; nothing in verify, deploy or usage reads them; Stage 3 needs them). **Skip.**
4. Branch for the first deploy: **`main`**, only if Lucifer's live commit is on it and nothing
   uncommitted was live (step 0.4); otherwise commit/push that work first (your POS repo, your call).
5. Standby hosts: **assume none**; if step 0.4 finds `lucifer007-*` profiles, we stop and decide
   (admin does not deploy standbys).
