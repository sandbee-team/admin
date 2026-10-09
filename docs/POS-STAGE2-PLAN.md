# POS Stage 2 plan: deploys from admin

This plan builds on `docs/POS-INTEGRATION.md` (D1–D18) and the Stage 1 code at `8949777`. Paths are relative to `d:\sandbee.in\sandbee-final-2026-10-03\sandbee-admin` unless they start with `F:\lucifer` or `pos-builder/`. It changes nothing in lucifer (D11).

## 0. Findings that shape the design

1. **Admins can turn the deploy lock off today.** `deployLock` is part of the config `PUT` (`backend/modules/pos.js:78,103`; `shared/schemas.js:290`), and the form shows it as a checkbox (`frontend/src/pages/installation-workspace.jsx:479-492`). Anyone with the `credentials` role (admins included) can switch it off. Stage 2 removes it from `posConfigSchema`, makes `newPos` always set it to `true`, and adds a separate owner-only unlock route.
2. **A build-time variable is missing.** `nextPublic()` (`pos.js:18-23`) only derives the R2 or Cloudinary key. The cafe also inlines `NEXT_PUBLIC_REALTIME_URL` into its client code (`apps/cafe/hooks/use-realtime.ts`, `lib/realtime-client.ts`); go-live sets it to `wss://<workerHost>/join` (`F:\lucifer\scripts\go-live\realtime.mjs:78-92`). go-live always sets every image key, with `""` for the store not in use (`lib.mjs:366-377`). Stage 2 derives all three `NEXT_PUBLIC_*` keys (`""` when unset), recomputes them at preflight, and checks them against the Vercel project's own values.
3. **`next.config.ts` reads `NEXT_PUBLIC_R2_PUBLIC_BASE_URL` at build time** (`F:\lucifer\apps\cafe\next.config.ts:~26-34`) for the image allow-list and the `/m` CSP. The builder therefore needs the real value, not a dummy.
4. **The edge middleware reads runtime env.** It uses `TENANT_ID` (`middleware.ts:27`) and `ROOT_DOMAIN` (`lib/tenant.ts:32`). If Next inlined these at build time, every page would answer 404 while `/api/health`, which the middleware does not cover, still passed. Two consequences:
   - S1 includes an inlining test with sentinel values.
   - The health check adds a `/login` page probe.
5. **No page is prerendered from the database.** The root layout calls `auth()` (`app/layout.tsx:~51`), so all pages are dynamic. `next/font/google` (`lib/fonts.ts:1`) needs network access at build time.
6. **Root Directory is `apps/cafe`.** The workspace package `@pos/shared` lives outside it (`scripts/deploy.mjs:222-231`). The builder copies the project's settings, including `sourceFilesOutsideRootDirectory`.
7. **The worker deploys output only, with no source tree.** So the build must be `vercel build --standalone`, which "creates a standalone build with all dependencies inlined into function output folders" (https://vercel.com/docs/cli/build). S2 proves this by deploying from a directory with no source.
8. **`posView` returns `deploy` without filtering** (`pos.js:55-59`). Once lease fields exist this must become a whitelist.
9. **No new collection is needed.** The snapshot tool requires an exact collection set (`backend/lib/snapshot.js:4-14,44-49`). Everything new lives inside `installations.pos` plus two `system_state` rows, and `backend/lib/secrets.js` is unchanged.

**Provider facts (all checked against current docs):**

| Fact | Source |
|---|---|
| A dispatch with `return_run_details: true` returns 200 with `workflow_run_id`, `run_url`, `html_url`; without it, 204 | https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids, https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event |
| Dispatch inputs: at most 25 properties and 65,535 characters | https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax |
| Artifact download is a 302 whose URL expires after 1 minute; `archive_format` is `zip` only; artifacts carry a `digest` | https://docs.github.com/en/rest/actions/artifacts |
| `upload-artifact` (v7) adds `archive`, `retention-days`, `compression-level`; hidden files are excluded by default | https://github.com/actions/upload-artifact |
| Fine-grained PAT permissions: Actions write (dispatch, cancel, delete artifact), Actions read (runs, jobs, artifacts, download), Contents read (branches, commits, compare) | https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens |
| Run statuses and `display_title`; cancel returns 202 | https://docs.github.com/en/rest/actions/workflow-runs |
| Retention for private repos is 1–400 days and from 2026-10-01 also covers workflow runs; a setting can require actions pinned to a full SHA | https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository |
| The CLI accepts `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` from env; exit codes 0/1/2 | https://vercel.com/docs/cli/global-options |
| stdout of `vercel deploy` is the deployment URL; `--prebuilt`, `--archive=tgz`, `--skip-domain`, `--meta`; system env vars are missing at build time for prebuilt | https://vercel.com/docs/cli/deploy |
| Global config lives in `XDG_DATA_HOME/com.vercel.cli` | https://vercel.com/docs/project-configuration/global-configuration |
| `VERCEL_TELEMETRY_DISABLED=1` | https://vercel.com/docs/cli/about-telemetry |
| A staged production deployment can be promoted without a rebuild | https://vercel.com/docs/deployments/promoting-a-deployment |
| Hobby can roll back only to the immediately previous deployment; a rollback turns off automatic domain assignment | https://vercel.com/docs/instant-rollback |
| `POST /v1/projects/{id}/rollback/{dpl}` (201) | https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-previous-production-deployment-by-id |
| `POST /v10/projects/{id}/promote/{dpl}` (201/202) | https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment |
| `GET /v13/deployments/{idOrUrl}`: `readyState`, `readySubstate` STAGED/PROMOTED | https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url |
| `GET /v7/deployments` includes `prebuilt`, `isRollbackCandidate`, `target` | https://vercel.com/docs/rest-api/deployments/list-deployments |
| `DELETE /v13/deployments/{id}` | https://vercel.com/docs/rest-api/deployments/delete-a-deployment |
| `GET /v6/deployments/{id}/files` | https://vercel.com/docs/rest-api/deployments/list-deployment-files |
| `GET /v9/projects/{id}`: settings, `lastAliasRequest{toDeploymentId, jobStatus, type}` | https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name |
| `GET /v10/projects/{id}/env` (plain values readable without `decrypt`) | https://vercel.com/docs/rest-api/projects/retrieve-the-environment-variables-of-a-project-by-id-or-name |
| `GET /v2/user` | https://vercel.com/docs/rest-api/user/get-the-user |
| `POST /v11/projects` and `DELETE /v9/projects/{id}` (spike only) | https://vercel.com/docs/rest-api/projects/create-a-new-project, https://vercel.com/docs/rest-api/projects/delete-a-project |
| Standard Protection covers every deployment URL except production domains, so a staged deployment cannot be health-checked without a bypass secret | https://vercel.com/docs/deployment-protection |
| `.vc-config.json` carries `environment` and edge `envVarsInUse`; `.func` folders may be symlinks | https://vercel.com/docs/build-output-api/primitives |
| Cloudflare token verify: `GET /user/tokens/verify` and `GET /accounts/{id}/tokens/verify` | https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/, https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/ |

## 1. Spikes (run first, in pos-builder, on branch `spike`)

**Secrets needed:**
- `LUCIFER_READ_TOKEN`: fine-grained token, lucifer only, Contents read-only.
- `SPIKE_VERCEL_TOKEN`: token for a throwaway Hobby account.

**Helper files** (new, in pos-builder; they print counts, enums and status codes only, never values or file contents):
- `tools/vercel-cli/{package.json,package-lock.json}`: exact CLI version, the same one the admin image uses.
- `scripts/write-project-json.mjs`: writes `src/.vercel/project.json` and `.vercel/.env.production.local`.
- `scripts/build.mjs`: runs the CLI with a minimal env, no shell, and deletes `VERCEL_TOKEN` from the env.
- `scripts/scan-output.mjs`
- `scripts/package.mjs`: writes `output.tgz` and `manifest.json` (CLI and Node versions, output path, sha256, file count).
- `spike/s2.mjs`
- `spike/summary.mjs`

**S1, build without a client token.** Settings come from a hand-written `project.json`: `{framework:"nextjs", rootDirectory:"apps/cafe", installCommand:null, buildCommand:null, outputDirectory:null, nodeVersion:"22.x", sourceFilesOutsideRootDirectory:true}` with dummy ids. If the minimum set fails, `write-project-json` retries with the extra fields from a `vercel pull` file shape. It reports:
- pass/fail and duration;
- whether `npm ci --ignore-scripts` works;
- whether `vercel build` itself runs an install;
- where `.vercel/output` lands;
- size and file count;
- `.func` count and the distinct `runtime` values;
- how many `.vc-config.json` files contain `filePathMap` or `environment` (key names only);
- middleware `envVarsInUse` names;
- the count of static and dynamic routes.

The **sentinel** variant sets every `buildEnv` key (`lib.mjs:346-383`) plus the realtime keys to `SPIKESENTINEL_<KEY>` and reports which keys appear inlined under `static/` or `functions/`.
- **Stop if any secret-type key (Mongo URI, `AUTH_SECRET`, …) is inlined** and escalate to the owner.
- Inlined non-secret keys (`TENANT_ID`, `ROOT_DOMAIN`, `HOSTING_TIER`) become the `build_env` allowlist.

An offline probe rebuilds through an unreachable `HTTPS_PROXY` and reports pass/fail plus whether the failure category is fonts.

**S2, deploy prebuilt output to the throwaway account.** This runs on a fresh runner with no source checkout.
1. Download the artifact through the REST API with `GITHUB_TOKEN`, exactly as the worker will: zip or raw, plus the redirect host suffix.
2. Extract it and create project `spike-<run_id>` with matching settings.
3. `vercel deploy --prebuilt --prod --skip-domain --archive=tgz --meta sandbeeRequest=…`, with the token only in `VERCEL_TOKEN`.
4. Record `readyState`, `readySubstate`, `prebuilt`, `source`.
5. Promote and poll `lastAliasRequest`; record the shape of `targets.production` (key names only).
6. Run the files API: top-level directory names, entry count by type, and counts of `.ts/.tsx/.mts/.map` files, `apps/hub`, `packages/shared/src`, `scripts/`, `workers/`, `.env*`.
7. Deploy a second time and promote, roll back to deployment 1 (status), then try rolling back to deployment 2 (Hobby status probe).
8. Delete the project in an `always()` step.

**S3, scan both outputs.** Counts of:
- `*.map` files;
- `.ts/.tsx/.mts/.cts` outside `node_modules/**/*.d.ts`;
- paths under `apps/hub`, `apps/desktop`, `apps/mobile`, `scripts/`, `workers/`, `clients/`, `.git/`, `.env*`, and any `CLAUDE.md`;
- secret-pattern hits: `github_pat_`, `ghp_`, `mongodb(+srv)://user:pass@`, `-----BEGIN … PRIVATE KEY`, `AKIA…`;
- sentinel hits;
- `sourceMappingURL` references.

**S4, things only the server can verify.** How each is checked later:
- **CLI runs under `read_only`** with `HOME`/`XDG_*`/`TMPDIR` on `/work`. Check: `worker.js --self-check` runs `vercel --version` with the job env.
- **The env token is honoured.** Check: `--self-check --installation=<demo>` runs `vercel whoami`, reports ok only, reads the child's `/proc/<pid>/cmdline` to prove the token is absent, and searches `/work` for the token afterwards (must find nothing).
- **Memory peak.** Check: `docker stats` during the first demo deploy.
- **Outbound access to fixed hosts.** Proved by the first deploy.
- **Kill and recover.** Section 10 step 8.

### `pos-builder/.github/workflows/spike.yml`

```yaml
name: spike
on:
  push: { branches: [spike] }
  workflow_dispatch:
    inputs:
      ref: { description: "lucifer ref", required: false, type: string, default: main }
permissions: { contents: read }
concurrency: { group: spike, cancel-in-progress: true }
env:
  NODE_VERSION: "22.x.y"            # exact, same as build.yml
  VERCEL_TELEMETRY_DISABLED: "1"
  NEXT_TELEMETRY_DISABLED: "1"
  NO_COLOR: "1"
jobs:
  s1-build:
    runs-on: ubuntu-24.04
    timeout-minutes: 35
    strategy: { fail-fast: false, matrix: { variant: [plain, sentinel] } }
    steps:
      - uses: actions/checkout@<FULL_SHA>        # checkout vX.Y.Z
        with: { path: builder, persist-credentials: false }
      - uses: actions/checkout@<FULL_SHA>
        with:
          repository: KartikDesai07/lucifer
          ref: ${{ inputs.ref || 'main' }}
          token: ${{ secrets.LUCIFER_READ_TOKEN }}
          path: src
          fetch-depth: 1
          persist-credentials: false
      - uses: actions/setup-node@<FULL_SHA>      # setup-node vX.Y.Z
        with: { node-version: "${{ env.NODE_VERSION }}" }
      - name: Install Vercel CLI
        run: npm ci --prefix builder/tools/vercel-cli --omit=dev --ignore-scripts --no-audit --no-fund
      - name: Install dependencies
        id: install
        working-directory: src
        run: |
          if npm ci --ignore-scripts --no-audit --no-fund; then echo "mode=ignore-scripts" >> "$GITHUB_OUTPUT"
          else rm -rf node_modules && npm ci --no-audit --no-fund && echo "mode=with-scripts" >> "$GITHUB_OUTPUT"; fi
      - name: Write project.json
        run: node builder/scripts/write-project-json.mjs --root src --dummy-ids --variant ${{ matrix.variant }}
      - name: Build
        run: node builder/scripts/build.mjs --root src --report "$RUNNER_TEMP/build.json" --install-mode "${{ steps.install.outputs.mode }}"
      - name: Offline rebuild probe
        continue-on-error: true
        run: node builder/scripts/build.mjs --root src --offline-probe --report "$RUNNER_TEMP/offline.json"
      - name: Scan output (report only)
        run: node builder/scripts/scan-output.mjs --root src --report "$RUNNER_TEMP/scan.json" --sentinels ${{ matrix.variant == 'sentinel' }}
      - name: Summary
        if: always()
        run: node builder/spike/summary.mjs s1 ${{ matrix.variant }} "$RUNNER_TEMP" >> "$GITHUB_STEP_SUMMARY"
      - name: Package
        if: matrix.variant == 'plain'
        run: node builder/scripts/package.mjs --root src --request-id 00000000-0000-4000-8000-000000000000 --out "$RUNNER_TEMP/out"
      - uses: actions/upload-artifact@<FULL_SHA> # upload-artifact v7.x
        if: matrix.variant == 'plain'
        with: { name: spike-output, path: "${{ runner.temp }}/out/", retention-days: 1, compression-level: 0, if-no-files-found: error }
  s2-deploy:
    needs: s1-build
    runs-on: ubuntu-24.04
    timeout-minutes: 25
    permissions: { contents: read, actions: read }
    steps:
      - uses: actions/checkout@<FULL_SHA>
        with: { path: builder, persist-credentials: false }
      - uses: actions/setup-node@<FULL_SHA>
        with: { node-version: "${{ env.NODE_VERSION }}" }
      - name: Install Vercel CLI
        run: npm ci --prefix builder/tools/vercel-cli --omit=dev --ignore-scripts --no-audit --no-fund
      - name: Prebuilt deploy to throwaway account
        env:
          VERCEL_TOKEN: ${{ secrets.SPIKE_VERCEL_TOKEN }}
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
          GH_RUN_ID: ${{ github.run_id }}
        run: node builder/spike/s2.mjs --work "$RUNNER_TEMP/s2" --report "$RUNNER_TEMP/s2.json"
      - name: Summary
        if: always()
        run: node builder/spike/summary.mjs s2 "$RUNNER_TEMP/s2.json" >> "$GITHUB_STEP_SUMMARY"
```

**Pinning action SHAs.** I did not invent SHAs; the implementer resolves them. Run `gh api repos/actions/<name>/git/ref/tags/<tag> --jq .object` and, if `.type` is `tag`, dereference it with `gh api repos/actions/<name>/git/tags/<sha> --jq .object.sha`. Current majors on 2026-10-09: checkout v7, setup-node v7(?), upload-artifact v7.

## 2. Production builder: `pos-builder/.github/workflows/build.yml`

Step names are stable: the worker maps a failed step name to its message.

```yaml
name: build
run-name: pos-build ${{ inputs.request_id }}
on:
  workflow_dispatch:
    inputs:
      request_id: { description: "Admin deploy request id (UUID)", required: true, type: string }
      sha: { description: "Exact lucifer commit (40 hex)", required: true, type: string }
      settings: { description: "Vercel project settings JSON (non-secret)", required: true, type: string }
      next_public: { description: "NEXT_PUBLIC_* JSON (non-secret)", required: true, type: string }
      build_env: { description: "Allowlisted non-secret build env JSON", required: false, type: string, default: "{}" }
permissions: { contents: read }
concurrency: { group: "pos-build-${{ inputs.request_id }}", cancel-in-progress: false }
env:
  NODE_VERSION: "22.x.y"            # exact; validate-inputs requires settings.nodeVersion == "22.x"
  VERCEL_TELEMETRY_DISABLED: "1"
  NEXT_TELEMETRY_DISABLED: "1"
  NO_COLOR: "1"
jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 25
    steps:
      - name: Checkout builder
        uses: actions/checkout@<FULL_SHA>
        with: { path: builder, persist-credentials: false }
      - name: Setup Node
        uses: actions/setup-node@<FULL_SHA>
        with: { node-version: "${{ env.NODE_VERSION }}" }
      - name: Validate inputs
        env:
          IN_REQUEST_ID: ${{ inputs.request_id }}
          IN_SHA: ${{ inputs.sha }}
          IN_SETTINGS: ${{ inputs.settings }}
          IN_NEXT_PUBLIC: ${{ inputs.next_public }}
          IN_BUILD_ENV: ${{ inputs.build_env }}
        run: node builder/scripts/validate-inputs.mjs --out "$RUNNER_TEMP/inputs.json"
      - name: Checkout source
        uses: actions/checkout@<FULL_SHA>
        with:
          repository: KartikDesai07/lucifer
          ref: ${{ inputs.sha }}
          token: ${{ secrets.LUCIFER_READ_TOKEN }}
          path: src
          fetch-depth: 1
          persist-credentials: false
      - name: Verify source SHA
        env: { IN_SHA: "${{ inputs.sha }}" }
        run: test "$(git -C src rev-parse HEAD)" = "$IN_SHA"
      - name: Install Vercel CLI
        run: npm ci --prefix builder/tools/vercel-cli --omit=dev --ignore-scripts --no-audit --no-fund
      - name: Install dependencies
        working-directory: src
        run: npm ci --no-audit --no-fund        # add --ignore-scripts if S1 proved it works
      - name: Build
        run: node builder/scripts/build.mjs --root src --inputs "$RUNNER_TEMP/inputs.json"
      - name: Scan output
        run: node builder/scripts/scan-output.mjs --root src --delete-maps --fail --summary "$GITHUB_STEP_SUMMARY"
      - name: Package
        run: node builder/scripts/package.mjs --root src --inputs "$RUNNER_TEMP/inputs.json" --out "$RUNNER_TEMP/out"
      - name: Upload artifact
        uses: actions/upload-artifact@<FULL_SHA>
        with:
          name: pos-output-${{ inputs.request_id }}
          path: ${{ runner.temp }}/out/
          retention-days: 1
          compression-level: 0
          if-no-files-found: error
```

- **`validate-inputs`** checks UUID, 40-hex SHA, `framework === "nextjs"`, `rootDirectory === "apps/cafe"`, and `next_public` limited to `NEXT_PUBLIC_R2_PUBLIC_BASE_URL`, `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `NEXT_PUBLIC_REALTIME_URL`. Values must be `""`, `https://`, `wss://` or a cloud-name regex, at most 500 characters, with no control characters. `build_env` uses the S1 allowlist.
- **No client ids go to GitHub.** Dummy org and project ids are used unless S2 shows the output is tied to a project.
- **Secrets are never in env during install or build.** `LUCIFER_READ_TOKEN` appears only in `with:` of the checkout step.
- **Scan output** fails the run on any finding, after deleting `*.map` files.

## 3. Admin configuration and adapters

**`backend/config.js`.** Names-only errors, following the pattern at `config.js:89-106`:

| Variable | Default | Rule |
|---|---|---|
| `POS_GITHUB_SOURCE_REPO` | `KartikDesai07/lucifer` | `^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$` |
| `POS_GITHUB_SOURCE_TOKEN` | `""` | `^github_pat_[A-Za-z0-9_]{50,255}$` |
| `POS_GITHUB_BUILDER_REPO` | `KartikDesai07/pos-builder` | same as source repo |
| `POS_GITHUB_BUILDER_TOKEN` | `""` | same as source token |
| `POS_BUILDER_WORKFLOW` | `build.yml` | |
| `POS_BUILDER_REF` | `main` | |
| `POS_WORK_DIR` | `/work` | |

An empty value disables the feature (503 `code:"not-configured"`); a malformed value stops the boot. Compose blanks the token each container does not need:

| Container | Has | Blanked |
|---|---|---|
| app | source token | `POS_GITHUB_BUILDER_TOKEN: ""` |
| worker | builder token | `POS_GITHUB_SOURCE_TOKEN: ""` |

**Fine-grained PATs** (Metadata read is always included):
1. **`POS_GITHUB_SOURCE_TOKEN`** (server): only lucifer, Contents read-only.
2. **`POS_GITHUB_BUILDER_TOKEN`** (server): only pos-builder, Actions read and write.
3. **`LUCIFER_READ_TOKEN`** (pos-builder secret): only lucifer, Contents read-only. It is a separate token from #1.

**`backend/lib/provider-http.js`** (new): `request({base, path, method, token, body, timeoutMs, signal, fetch})`.
- Fixed bases only: `https://api.github.com`, `https://api.vercel.com`, `https://api.cloudflare.com/client/v4`.
- `redirect:"manual"`; any 3xx is an error. Timeout via `AbortSignal.any([timeout, jobSignal])`; reads at most 2 MB.
- Throws `ProviderError {provider, status, code, retryable}` with the fixed message `"<Provider> request failed (<code>)"`.
- Codes: `unauthorized` 401, `forbidden` 403, `not-found` 404, `conflict` 409, `invalid` 422, `rate-limited` 429 or 403 with rate-limit headers, `unavailable` 5xx, `timeout`, `network`.
- A Vercel `error.code` is kept only if it matches `^[a-z_]{1,40}$`. Bodies never reach messages or logs.
- `fetch` is injectable. Retries (2s, 5s, 10s) only for `retryable`.

**`backend/lib/github.js`**: `createGitHub({sourceRepo, sourceToken, builderRepo, builderToken, fetch})`.
- `listBranches()`: `GET /branches?per_page=100`, cap 30, then `GET /commits/{sha}` per branch (5 at a time). Returns `{name, sha, message(≤120), date}` sorted by date.
- `resolveBranch(name)`
- `compare(base, head)` returns `{aheadBy, behindBy}`.
- `dispatch(inputs)` posts `{ref, inputs, return_run_details: true}` and returns `{runId, htmlUrl}`. On a 204 it falls back to `findRun(requestId)` (list runs for the workflow with `event=workflow_dispatch` and `created>=`, matching `display_title === "pos-build <id>"`).
- `getRun(id)`, `failedStepName(id)` (via `/runs/{id}/jobs`), `cancelRun(id)`.
- `listArtifacts(runId)`, `deleteArtifact(id)`.
- `downloadArtifact(id, file, {maxBytes})`: expects a 302 whose `Location` is https with host suffix `.blob.core.windows.net` or `.actions.githubusercontent.com` (adjusted by S2). The second request has no `Authorization` header and uses `redirect:"error"`. The body streams to disk with sha256 compared to the artifact `digest`; stall timeout 30s, overall 5 minutes.
- Branch names must match `^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$` and are path-encoded.

**`backend/lib/vercel.js`**: `createVercel({token, teamId, fetch})`. `?teamId=` is added when `orgId` starts with `team_`.
- `user()` → `/v2/user`
- `project(id)` → `/v9/projects`, settings plus `lastAliasRequest`
- `projectEnv(id)` → `/v10/.../env`, never with `decrypt`
- `deployment(idOrUrl)` → `/v13/deployments`
- `listDeployments({projectId, until, limit})` → `/v7/deployments`, paginated, cap 500
- `promote(p, d)`, `rollback(p, d)`, `deleteDeployment(d)`
- `files(d)` → `/v6/...files`, used only for counts

**`backend/lib/cloudflare.js`**: `verifyToken(token, accountId)` tries the user endpoint, then the account endpoint, and requires `status === "active"`.

**`backend/lib/redact.js`**: `redact(text, knownSecrets)` removes:
- the exact secret values;
- `vcp_…` and `github_pat_…`;
- `mongodb(\+srv)?://\S+`;
- runs of 32 or more `[A-Za-z0-9+/_=-]` characters.

It also strips control characters and caps the result at 160 characters.

**`backend/lib/safe-https.js`**: `getJson(host, path, {timeoutMs, maxBytes})` using `node:https`.
- A `lookup` hook rejects loopback, private, link-local, CGNAT and ULA addresses (v4 and v6).
- The host must be a DNS name with an alphabetic TLD; IP literals are refused (the apex regex `shared/schemas.js:242-243` allows them).
- No redirects, 10s timeout, at most 64 KB read.

**Branch list.** `GET /pos/branches` (credentials) uses a 60s LRU in the module plus `consume("branches:<staff>",120,3600000)`. Ahead/behind counts come only for the selected branch, via `GET /installations/:id/pos/compare?sha=` against `deploy.last.sha`.

## 4. Worker

**`backend/worker.js`** follows the boot pattern of `server.js:9-38`: `config`, `connect`, `verifyVaultKey`, S3, adapters, then `startWorker(ctx)`.
- `--health` checks that `/work/heartbeat` is less than 60s old.
- `--self-check [--installation=<id>] [--inspect-files=<id>]` prints names, ok flags and counts (S4).
- On SIGTERM it stops claiming. A job in a wait step releases its lease (`leaseUntil = now`). A running CLI gets up to 120s and is then killed, and takeover reconciles.

**New modules:**
- `backend/worker/loop.js`: two lanes, `deploy` (deploy and rollback, concurrency 1 globally, which also serializes per Vercel account) and `task` (concurrency 1). Polls every 3s. Writes the `system_state {_id:"pos-worker", at, workerId, version, cliVersion, builderConfigured}` heartbeat every 30s.
- `backend/worker/lease.js`: pure claim, heartbeat and fence filters.
- `backend/worker/{deploy,rollback,verify,purge,db-backup}.js`
- `backend/worker/artifact.js`: minimal zip reader (central directory; method 0 or 8 via `zlib.createInflateRaw`; `zlib.crc32`). It accepts exactly `output.tgz` and `manifest.json`. It runs `tar -tvzf` validation (rejects absolute paths, `..`, devices, hard links, and symlinks that point outside `.vercel/output`; total ≤1.5 GB), then `tar -xzf --no-same-owner --no-same-permissions`.
- `backend/worker/cli-runner.js`: `runCli({args, cwd, env, timeoutMs, signal}) → {code, stdout(≤64KB), stderrTail(≤4KB)}`. It calls `spawn(process.execPath, ["/opt/vercel-cli/node_modules/vercel/dist/vc.js", ...args], {shell:false, stdio:["ignore","pipe","pipe"]})`, sends SIGTERM and then SIGKILL after 10s, and is the test seam.
- `backend/lib/client-mongo.js`: `openClientDb(uri, {allowHost})`. Atlas only: every host must end with `.mongodb.net`. Uses `serverSelectionTimeoutMS: 8000`, `maxPoolSize: 2`, `appName: "sandbee-admin-worker"`.

**The CLI runs with an allowlisted env only:**
- `PATH`, `HOME=/work/home`, `TMPDIR=/work/tmp`, `XDG_DATA_HOME=/work/jobs/<id>/vc` (a per-job global config, deleted with the job), `XDG_CACHE_HOME=/work/cache`;
- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`;
- `VERCEL_TELEMETRY_DISABLED=1`, `NO_COLOR=1`, `CI=1`, `NODE_OPTIONS=--max-old-space-size=200`.

It never inherits `process.env`. Arguments are only `deploy --prebuilt --prod --skip-domain --archive=tgz --yes --non-interactive --meta sandbeeRequest=<id>`. The deployment comes from the last stdout line matching `^https://[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app/?$`, then `deployment(host)`, which must match the `projectId`, `target === "production"` and `meta.sandbeeRequest`. CLI output is never logged. A failure stores `"Vercel upload failed (exit N): " + redact(lastStderrLine)`.

**Image.** Keep the single image (D18).
- `tools/vercel-cli/{package.json,package-lock.json}` pins the exact CLI version, the same as the builder.
- In `Dockerfile` (runtime stage, after `:15`): `COPY tools/vercel-cli/package*.json /opt/vercel-cli/` then `RUN npm ci --prefix /opt/vercel-cli --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force`, and `RUN mkdir -p /work && chown node:node /work`. A new named volume takes this ownership.
- Why not a separate stage or image: it breaks D18. Why not `npx` at runtime: it downloads code into a read-only container, which is a supply-chain risk.
- Cost: the image grows, measured in S4. The app container never runs the CLI.

**`compose.production.yaml`** adds:

```yaml
  worker:
    image: sandbee-admin:${RELEASE_TAG:-local}
    build: .
    command: ["node", "backend/worker.js"]
    env_file: .env
    environment: { NODE_ENV: production, POS_GITHUB_SOURCE_TOKEN: "", TMPDIR: /work/tmp }
    volumes: ["pos-work:/work"]
    restart: unless-stopped
    init: true
    read_only: true
    tmpfs: ["/tmp:size=32m"]
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    mem_limit: 384m        # lower to measured peak × 1.5 (≥256m) after S4
    cpus: 1.0
    pids_limit: 100
    stop_grace_period: 150s
    healthcheck: { test: ["CMD","node","backend/worker.js","--health"], interval: 30s, timeout: 5s, start_period: 30s }
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
volumes: { pos-work: {} }
```

The worker has no ports. `app` gains `POS_GITHUB_BUILDER_TOKEN: ""`. The worker's Dockerfile `HEALTHCHECK` is replaced by the compose healthcheck above. `/work/tmp` is wiped at boot, and job directories without a live lease are removed. The worker refuses to start a download with less than 2 GB free (`fs.statfs`).

**Job model (D4).** Everything is embedded in `installations.pos`; there is no `jobs` collection. Embedding gives exactly one active job per installation per lane without a unique index, and no history by construction.
- **`deploy.current`**: the active job or the last unsuccessful attempt. Fields: `{id, kind: deploy|rollback, status: queued|running|cancelling|failed|cancelled|rolled-back|unhealthy|expired, step, steps{name:{at,ok}}, branch, sha, target{projectId, orgId, host, tenantId}, baseline{vercelDeploymentId, healthy}, runId, runUrl, artifactId, uploadStartedAt, vercelDeploymentId, url, by, byId, requestedAt, attempt, leaseOwner, leaseUntil, heartbeatAt, cancelRequested, error, finishedAt}`.
- **`deploy.last`**: the live production deployment made by admin.
- **`deploy.previous`**: the rollback target. Both use `{kind, branch, sha, at, by, vercelDeploymentId, url, durationMs, runUrl, status: succeeded|rolled-back-to|pre-admin}`.
- **`deploy.cutoverAt`**: when the first prebuilt deploy was verified.
- **`task`**: `{id, kind: verify|db-backup|purge-preview|purge, status, step, progress, lease…, result, error}`.
- **`verify`**: the latest check flags.
- **`system_state`** gains `pos-deploy-freeze` and `pos-worker`.

This refines §5/§7.4: a failure stays in `current` until it is dismissed or replaced, so `last` always describes what is live. `POS-INTEGRATION.md` must be updated to match.

**Lease rules:**
- **Claim:** atomic `findOneAndUpdate` with filter `id` plus (`status:"queued"`, or an active status with `leaseUntil < now`); sets `leaseOwner`, `leaseUntil = now + 60s`, `$inc attempt`.
- **Heartbeat** every 15s, fenced on `{id, leaseOwner}`. A miss means the lease is lost: abort and kill the child. Every worker write uses the same fence. The worker never touches `pos.rev`, so the config form is never marked stale.
- **Expiry:** a queued job older than 10 minutes becomes `expired`. `attempt > 3` becomes `failed` ("Worker stopped repeatedly").
- **Cancel** is allowed before `upload`. The API sets `cancelling`, or `cancelled` directly if still queued; the worker then cancels the GitHub run and deletes the artifact. Cancelling during upload or later returns 409 "Too late to cancel".
- **Freeze** (`system_state` `pos-deploy-freeze`): queued deploys are not claimed, and running deploys stop before `upload` as `cancelled` ("Deploys frozen"). Rollback, verify and backup are still allowed.
- **Idempotency:** the request id is used as the job id, the run-name, the artifact name and the Vercel meta. The single slot gives 409 for a concurrent enqueue. Indexes go in `db.js:47-82`: partial indexes on `pos.deploy.current.status` and `pos.task.status`.

## 5. Deploy state machine

`queued → preflight → build → upload → vercel → health → finalize`. A step is resumed after a takeover unless marked otherwise.

1. **preflight** (resumable)
   - Re-check the lock, freeze and customer status.
   - Decrypt `vercel.token` in the worker only.
   - `user()` must succeed and `project(projectId)` must be visible. Settings must be nextjs, `apps/cafe` and node `22.x`, else fail with field names.
   - `projectEnv`: the required runtime keys must exist (names only). `NEXT_PUBLIC_*` (plain type) must equal the derived values, and plain `TENANT_ID` must equal `pos.tenantId`. Drift fails with key names.
   - Baseline: the current production id from `lastAliasRequest.toDeploymentId` or `targets.production`, plus a baseline health probe.
2. **build**
   - `dispatch` and store `runId` and `runUrl` at once.
   - Poll every 10s; 15 minutes queued or 30 minutes total means cancel and fail.
   - On a failed conclusion, map `failedStepName`: "Checkout source" → "Builder could not read the POS source (LUCIFER_READ_TOKEN?)", "Install dependencies", "Build", "Scan output" → "Build output failed the safety scan".
   - Takeover without a `runId`: `findRun`, else dispatch again.
3. **upload**
   - Exactly one artifact `pos-output-<id>`, not expired, at most 400 MB, digest required.
   - Download, verify, extract into `/work/jobs/<id>/root`, write `.vercel/project.json` with the real ids and settings.
   - The CLI major version in `manifest.json` must equal the worker's.
   - Run the CLI with a 10-minute timeout, then delete the artifact on GitHub.
   - Takeover (reconcile): list deployments since `uploadStartedAt` with `meta.sandbeeRequest === id`. If found, continue; if not, upload again (re-download if `/work` was lost, rebuild once if the artifact expired).
4. **vercel**
   - Poll `readyState` every 5s up to 10 minutes. `ERROR` or `CANCELED` → `failed`, production untouched.
   - At `READY`/`STAGED`, re-check that production still equals the baseline (else fail: "Production changed outside admin"), then `promote`.
   - Poll the project until `lastAliasRequest.toDeploymentId === id` and `jobStatus === "succeeded"`.
   - Fallback if S2 shows promote is not allowed on Hobby: deploy without `--skip-domain`, and promote only when the project is in rolled-back state.
5. **health**
   - 12 probes, 5s apart, of `https://<host>/api/health`, judged by `healthVerdict(status, body, tenantId)`, ported verbatim to `backend/lib/pos-health.js` with go-live's reasons (`lib.mjs:403-408`, loop `run.mjs:91-106`).
   - Then `/login` must return 200 HTML, which proves the middleware routes the tenant.
   - **On failure, roll back automatically**, but only if the baseline was healthy and production still equals the new id. Call `rollback(baseline)`, then run 6 health probes on it. The result is `rolled-back` if they pass, or `unhealthy` if they fail.
   - If the baseline was already unhealthy, the result is `unhealthy` and nothing is rolled back.
   - **Why roll back automatically:** a single operator is often not watching; a broken POS loses orders during service; the rollback only switches the alias, is instant, and is undone by deploying again.
   - Vercel then disables automatic domain assignment, which the next deploy's explicit promote handles.
6. **finalize** (one transaction, fenced)
   - `previous ← last ?? baseline` (marked `pre-admin`), `last ← new`, `current ← null`.
   - Set `cutoverAt` if empty, write the audit event, clean `/work/jobs/<id>`.
   - Send a best-effort email for failed, rolled-back and unhealthy results, with slug, step and short error only (`modules/mail.js`).

**What the owner sees on failure:** the failed step, a short error of at most 160 characters with redaction, a link to the private GitHub run (`runUrl`, hidden after the 7-day retention), and the time. No log is stored.

## 6. Other Stage 2 operations

**Rollback** runs in the deploy lane with kind `rollback`.
- The API accepts only `previous.vercelDeploymentId`.
- The worker checks that production still equals `last`, calls `rollback`, polls `lastAliasRequest`, runs health, then swaps: `last ← previous (rolled-back-to)`, `previous ← old last (rolledBackFrom)`.
- A Vercel 4xx (the Hobby restriction, which S2 probes) gives: "Vercel did not allow this rollback; deploy that branch again."

**Unlock the deploy lock.** `POST /installations/:id/pos/deploy-lock`:
- `{locked:true}` needs `credentials`.
- `{locked:false, confirm:<slug>, localLocked:true}` needs `secrets`, step-up, a verify with all checks ok within 24 hours, and a token, project and host set.
- It stores `localLockConfirmedAt`, the owner's attestation that local `clients/<slug>.json` now has `deployLock:true` (§8 transition rule).
- Config `PUT` and secret `PUT`/`DELETE` of `vercel.*`, `host`, `tenantId` or `mongo.uri`, and `DELETE pos`, return 409 while a matching lane is active.

**Credential verify** task. Result `pos.verify = {at, by, vercel, project, env, mongo, cloudflare, health}`, where each is `ok`, a fixed code, or `null` when skipped.
- `user()`; `project()`; the env presence and drift check; a Mongo `ping` (Atlas only; codes `unreachable`, `auth-failed`, `not-atlas`); Cloudflare verify if a token is set; one health probe.

**Client database backup** task (`secrets` + step-up; needs S3 and `mongo.uri`).
- Streams every non-system collection: cursor → canonical EJSON line `{"c":name,"d":doc}` → gzip → AES-256-GCM in the `SBF1` format. The header line has db, createdAt and collections; a trailer line holds the counts.
- Stays in memory and **aborts above 20 MB compressed** (`MAX_FILE_BYTES`, so the download path at `files.js:371` works unchanged).
- Progress (collection, documents, bytes) is written every 2s.
- `s3.put`, then the transaction registers file `pos-<slug>-db-<yyyymmdd-hhmm>.ndjson.gz` with category `db-backup` and audit.
- This needs the upload core extracted into `backend/lib/file-store.js`: `sealStream(cid, fid)` and `registerFile(...)`, used by both `files.js:229-343` and the worker.
- Not resumable: a takeover ends as `failed` ("Interrupted — run again"). A possible orphan ciphertext object is covered by the known limit already in `SECURITY.md`.
- Restore: new `scripts/pos-db-restore.js --file <decrypted.gz> --db <name>`, with the URI read from stdin, refusing non-empty target collections.

**Purge old source deployments.**
- `purge-preview`: list deployments and keep the project's production, `last`, `previous`, any `prebuilt:true`, and anything created at or after `cutoverAt`. Candidates are everything else (`prebuilt` false or missing, `createdAt < cutoverAt`). `task.result = {candidates ≤200 [{id, createdAt, target, state}], total, keep}`.
- `purge {previewTaskId, confirm}` (`secrets` + step-up): within 30 minutes of the preview, list again and delete the intersection one at a time, 500 ms apart. A 404 counts as done.
- Returns 409 without `cutoverAt`. Audit records counts only.

## 7. API, audit, frontend

New `backend/modules/deploys.js`, mounted in `app.js:99-107` before `recordRoutes`. Every route requires the `pos` product. `shared/policy.js:2-15` gains `deploy` for the owner only.

| Route | Gate | Audit |
|---|---|---|
| GET `/installations/:id/pos/deploys` (state for polling) | credentials | — |
| GET `/pos/branches`, GET `…/pos/compare?sha=` | credentials, rate limit | — |
| POST `…/pos/deploys {branch, sha, confirm}` | deploy + step-up + slug; 503 when not configured or worker offline for more than 90s; 409 for `frozen`, `locked`, `busy`, `branch-moved`, paused or archived customer, retired installation, missing config (names) | `pos.deploy.requested` |
| POST `…/deploys/cancel {id}`, `…/deploys/dismiss {id}` | deploy | `pos.deploy.cancel-requested`, `.dismissed` |
| POST `…/pos/rollback {to, confirm}` | deploy + step-up + slug | `pos.rollback.requested` |
| POST `…/pos/deploy-lock` | see §6 | `pos.deploy-lock.locked`, `.unlocked` |
| POST `/pos/deploy-freeze {on, reason}` | deploy; turning off also needs step-up | `pos.deploys.frozen`, `.unfrozen` |
| POST `…/pos/verify` | credentials, 12 per hour per installation | `pos.verify.requested` |
| POST `…/pos/db-backup` | secrets + step-up, 6 per hour | `pos.db-backup.requested` |
| POST `…/pos/purge/preview`, `…/pos/purge` | deploy; execute needs secrets + step-up + slug | `pos.purge.previewed`, `.requested` |

- **Worker events** use actor `{_id:"worker", name:"Deploy worker"}`: `pos.deploy.succeeded`, `.failed`, `.rolled-back`, `.unhealthy`, `.interrupted`, `pos.rollback.succeeded`, `.failed`, `pos.verify.completed` (flags), `pos.db-backup.completed`, `.failed` (size), `pos.purge.completed` (counts).
- **Audit detail format:** `branch@sha7 #id8`; no values, URLs or hosts.
- **Response whitelist:** `deployView` (exported from `deploys.js`, used by `posView` at `pos.js:55-59`) leaves out lease internals. Request bodies use zod `.strict()` schemas in new `shared/deploy.js` (states, steps, regexes, `NEXT_PUBLIC_KEYS`, `BUILD_ENV_KEYS`).
- **Overview** (`overview.js:16-92`) adds `pos: {failed, unverified, locked, workerOnline}`.

**Frontend:**
- **New `frontend/src/pages/installation-deploys.jsx`**, added as tab `["deploys","Deploys",CloudUpload]` (`installation-workspace.jsx:34-39`; the placeholder at `:297-307` is removed and the checkbox at `:479-492` becomes a lock badge). It shows:
  - worker online/offline, the freeze toggle, lock and unlock;
  - the current job with a six-step progress, elapsed time, run link, Cancel, and an error box with Dismiss;
  - Live (`last`) and Previous cards, with "Roll back to this";
  - a branch picker (name, short SHA, headline, age, ahead/behind) and a Deploy modal (summary, typed slug, step-up via `withStepUp`);
  - a Verify card and Maintenance (purge preview table and confirm).
- **New `frontend/src/hooks/use-poll.js`**: keeps the last data while refetching; every 2s while a job is active, 15s when idle; pauses while `document.hidden`. `useResource` would blank the data on each reload.
- **`customer-files.jsx` (~`:247-257`)**: "Back up database now" per POS installation, with progress.
- **`overview.jsx:175-207`**: Attention items for failed deploys, unverified credentials, locked deploys (informational) and worker offline.

## 8. Security

| Where a secret could leak | How it is prevented |
|---|---|
| CLI argv and `/proc/<pid>/cmdline` | The token is passed only through env; the self-check asserts it. |
| Child process env | Explicit allowlist; never `VAULT_KEY`, `MONGODB_URI`, GitHub tokens or S3 keys. |
| `/proc/<worker>/environ` (same uid) | Accepted risk (see note below). |
| CLI output | Never logged; the URL is parsed with a strict regex; errors are redacted. |
| CLI global config on disk | Per-job `XDG_DATA_HOME`, deleted afterwards; the self-check searches `/work`. |
| Provider error bodies | Fixed messages and codes only. |
| GitHub run inputs and logs | Non-secret inputs only (validated); no secret env in install or build; `persist-credentials:false`. |
| The artifact | Scanned and failed on findings; 1-day retention; deleted after upload. |
| Artifact redirect | `Authorization` is stripped when following the redirect; host allowlist. |
| Backup temp data | Never on disk; ciphertext only. |
| Audit, responses, overview | Whitelists; `assertNoSecrets`. |
| Worker logs | Event name, job id8 and code only. |

- **`/proc` note:** a compromised CLI release could read the worker's environment. Mitigations: exact pin plus lockfile, `--ignore-scripts`, deliberate upgrades, and the CLI never runs in the API container. A REST-only deployer is noted as possible future hardening.
- **SSRF:** provider bases are fixed. Health checks go through `safe-https` (public IPs only, no redirects). Mongo is Atlas-only. The artifact host is allowlisted.
- **Worker blast radius** equals the app's (`VAULT_KEY`, admin DB, S3 `files/*`), plus Actions read/write on pos-builder (it can start builds that read lucifer). It has no inbound ports. `SECURITY.md:31` ("no outbound fetches to user-entered URLs") must be revised to describe the host guard.

## 9. Tests

**Fakes** (new): `test/fakes/github.js` (dispatch 200/204, run lifecycle, failed step, artifacts with zip built in memory, 302 plus blob host), `test/fakes/vercel.js` (projects, env, deployments with `readyState` progression, promote/rollback with `lastAliasRequest`, Hobby 4xx, list/delete/files), `test/fakes/cli.js` (records argv, env, cwd; scripted stdout and exit; hang), `test/fakes/health.js`. The client database is a second database on the in-memory replica set with `allowHost` injected. `now` and `pollMs` are injected.

- **`test/stage2-adapters.test.js`** (W1): error mapping without bodies; redirect refused; artifact 302 without auth and with a bad host; digest mismatch; timeout; `redact`; the `safe-https` IP matrix; `healthVerdict` cases copied from `F:\lucifer\scripts\go-live\lib.test.mjs:345-349`; branch regex; config names-only errors.
- **`test/stage2-worker.test.js`** (W2):
  - happy path: steps in order, finalize rotation, `cutoverAt`;
  - build failure: production untouched, mapped step message, run link;
  - scan failure;
  - `ERROR` readyState;
  - health failure → auto-rollback → `rolled-back`; baseline unhealthy → `unhealthy` with no rollback;
  - lease takeover after a "kill" (abandon worker A, advance the clock): build resumes with a single dispatch; upload reconciles via meta; vercel and health resume;
  - attempt cap; queued expiry; cancel in build (GitHub cancel called); cancel during upload → 409;
  - freeze before upload;
  - lost lease aborts and no fenced write lands;
  - rollback race (production changed outside admin);
  - Hobby rollback 4xx;
  - zip/tar traversal, symlink and size rejection;
  - CLI env allowlist and argv contain no secret;
  - dispatch inputs contain no token or URI;
  - log capture is clean.
- **`test/stage2-api.test.js`** (W3):
  - role matrix 401/403/428;
  - typed confirm; `busy`, `locked`, `frozen`, `branch-moved`;
  - concurrent enqueue gives 202 + 409; concurrent rollback and deploy give one 202;
  - unlock preconditions;
  - config and secret writes return 409 while active;
  - `deployLock` is no longer accepted by config `PUT` (update `stage1-vault.test.js:244,1887`);
  - `nextPublic` gives all three keys;
  - `assertNoSecrets` over every new response, `/overview`, `/audit` and `audit_events` rows.
- **`test/stage2-backup.test.js`** (W4): roundtrip (decrypt, gunzip, parse, counts equal); size cap abort with no S3 object or file entry; cancel; non-Atlas URI refused; `files.js` behaviour unchanged (existing tests stay green); `pos-db-restore` refuses a non-empty target; purge preview/execute keep-set and re-check.
- **Playwright `test/ui/deploys.spec.js`** (W5): `test/ui-server.js` starts the real worker loop with fakes (200 ms polling) and a control port (pattern `ui-server.js:124-135`). Flow: verify → unlock (step-up, slug) → deploy and watch steps → induce a health failure → "Rolled back" plus run link → manual rollback → purge → customer "Back up database now" → new file row. Run axe and check overflow at 320/390/768/1440 widths.

## 10. Work units, verification, docs, release

**Phase A (parallel):**
- **W1 Adapters and config:** `backend/config.js`, `backend/lib/{provider-http,github,vercel,cloudflare,redact,safe-https,pos-health}.js`, `shared/deploy.js`, `shared/policy.js`, `test/fakes/{github,vercel,health}.js`, `test/stage2-adapters.test.js`, and the `docs/SECURITY.md` worker section.
- **W3 API:** `backend/modules/{deploys,pos,overview}.js`, `backend/app.js`, `backend/db.js`, `shared/schemas.js` (remove `deployLock`), `test/stage2-api.test.js`, `test/stage1-vault.test.js` edits, `docs/API.md`.
- **W5 Frontend:** `frontend/src/pages/{installation-deploys,installation-workspace,customer-files,overview}.jsx`, `frontend/src/hooks/use-poll.js`, `frontend/src/styles/components.css`, `test/ui-server.js`, `test/ui/deploys.spec.js`.

**Phase B (parallel, after W1):**
- **W2 Worker and runtime:** `backend/worker.js`, `backend/worker/{loop,lease,deploy,rollback,verify,purge,artifact,cli-runner}.js`, `backend/lib/client-mongo.js`, `tools/vercel-cli/*`, `Dockerfile`, `compose.production.yaml`, `test/fakes/cli.js`, `test/stage2-worker.test.js`, `docs/DEPLOYMENT.md`, `docs/POS-INTEGRATION.md`.
- **W4 Backup:** `backend/lib/file-store.js`, `backend/modules/files.js` (refactor only), `backend/worker/db-backup.js`, `scripts/pos-db-restore.js`, `test/stage2-backup.test.js`.

**Verify each unit:** `npm test`, `npm run build`, `npm run test:ui`, then `docker build -t sandbee-admin:local .` and `docker run --rm --read-only --tmpfs /tmp -v pw:/work sandbee-admin:local node backend/worker.js --self-check`.

**Docs:** `API.md`, `SECURITY.md`, `DEPLOYMENT.md` (env vars, worker, volume, tokens, Stage 2 checklist, rollback with `--remove-orphans`), `POS-INTEGRATION.md` (status, §5/§7 refinements, new decisions), `VALIDATION.md` (evidence), and a new `docs/POS-STAGE2-PLAN.md` holding this plan.

**Live deployment:**
1. Take a `mongodump` (D13).
2. Add to `~/admin/.env`: `POS_GITHUB_SOURCE_TOKEN`, `POS_GITHUB_BUILDER_TOKEN`; optionally `POS_GITHUB_SOURCE_REPO`, `POS_GITHUB_BUILDER_REPO`.
3. `cd ~/admin && git pull && unset RELEASE_TAG && docker compose -f compose.production.yaml up -d --build`. This builds once and starts app and worker. Compose creates volume `sandbee-admin_pos-work`; check with `docker volume inspect`.
4. `docker image prune -f`. Run `docker compose -f compose.production.yaml ps`; both should be healthy.
5. `docker compose -f compose.production.yaml exec worker node backend/worker.js --self-check --installation=<demo>`.
6. In the UI, for demo: Verify → Unlock → deploy `main`. Sample `docker stats --no-stream` during upload and set `mem_limit` accordingly.
7. `--inspect-files=<demo>` must show output-only counts.
8. Deploy again, `docker compose -f compose.production.yaml kill -s SIGKILL worker` during the build, then `up -d worker`; it must resume and succeed.
9. Roll back, then deploy again.
10. Purge preview, then execute.
11. Back up the database, download it (step-up), and run a restore drill into a scratch database.
12. Owner sets local `clients/demo.json` `deployLock:true`.
13. Release rollback: `git checkout 8949777 && docker compose -f compose.production.yaml up -d --build --remove-orphans`.

**Owner prerequisites:**
- Create private repo `pos-builder` (default branch `main`, no forks). Settings: require actions pinned to a full SHA, default `GITHUB_TOKEN` read-only, artifact and log retention 7 days.
- Create the three fine-grained PATs (§3). Expiry up to 1 year, with an admin task as a rotation reminder.
- Create the throwaway Hobby account and `SPIKE_VERCEL_TOKEN`; delete them after the spikes.
- Run the spike and paste back the summary.
- Free disk on the EC2 Docker root must be at least 3 GB.
- Client projects must be on Node `22.x`.

## 11. Edge cases and chosen handling

1. **Branch moved between list and request:** 409 `branch-moved`. **Force-push:** the build uses the SHA that was resolved.
2. **GitHub queue stuck** (15 minutes queued or 30 minutes total): cancel and fail.
3. **Artifact expired during a long outage:** rebuild once.
4. **CLI major version mismatch between builder and worker:** fail before upload.
5. **Project in rolled-back state, staged deploy:** explicit promote.
6. **Production changed in the Vercel dashboard during a job:** fail and do not touch it.
7. **Previous deployment removed by Vercel retention:** rollback 404 with a message.
8. **Health host DNS not pointing at Vercel:** baseline unhealthy → `unhealthy`, no rollback.
9. **Env drift on the Vercel project:** preflight fails with key names.
10. **Client token expired or revoked:** `unauthorized` in preflight; shown in Attention.
11. **Vercel 429:** backoff with three tries per step.
12. **Worker offline:** deploy request 503; queued jobs expire after 10 minutes.
13. **Worker killed:** lease takeover and step reconcile (§4–§5).
14. **Duplicate deployment after a missed reconcile:** harmless; purge removes it.
15. **Client database over 20 MB compressed:** fails clearly, nothing stored.
16. **S3 not configured:** backup button disabled with 503 `not-configured`.
17. **Atlas M0 load:** polling about 1 op/s total.
18. **Release rollback to Stage 1:** additive data, orphan worker removed.
19. **A secret-type key inlined at build (S1):** stop; requires an owner decision.
20. **Config or secret edits mid-job:** 409.

**Questions for the owner (everything else is decided above):**
1. In-app client database backups are capped at **20 MB compressed**, so the existing download path works unchanged. Is that enough, or should larger backups be supported? That needs a streaming download design.
2. **Automatic rollback** when the health check fails after go-live: on by default (justified in §5). Agree?
3. pos-builder **run and log retention of 7 days**. Since 2026-10-01 this also deletes the run records that the "GitHub run" links point to. 7 days, or 1 day?
4. The **`deploy` permission is owner-only**: admins can verify and lock but cannot deploy, roll back or purge. Agree?

### Critical files for implementation
- d:\sandbee.in\sandbee-final-2026-10-03\sandbee-admin\backend\modules\pos.js
- d:\sandbee.in\sandbee-final-2026-10-03\sandbee-admin\backend\modules\files.js
- d:\sandbee.in\sandbee-final-2026-10-03\sandbee-admin\compose.production.yaml
- d:\sandbee.in\sandbee-final-2026-10-03\sandbee-admin\frontend\src\pages\installation-workspace.jsx
- F:\lucifer\scripts\go-live\lib.mjs (buildEnv `:346-383`, healthVerdict `:403-408`; read only)
