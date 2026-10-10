import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
// Scenario fixtures live in test/ui-server.js (seedPos): one installation per
// scenario so tests do not share state. No worker runs here; a control route
// writes the job state a worker would have written.
const password = "Browser test passphrase 2026!";
const KEY = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
const SCENARIO = {
  ready: 1,
  deploy: 2,
  redeploy: 3,
  unlock: 4,
  blocked: 5,
  failed: 6,
  stalled: 7,
  rolledback: 8,
  settings: 18,
};
const iid = (name) =>
  `00000000-0000-4000-8000-d${String(SCENARIO[name]).padStart(11, "0")}`;
const deployUrl = (name) => `/installations/${iid(name)}/deploy`;
const axe = (page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
const control = (path) =>
  fetch(`http://127.0.0.1:8109/pos/${path}`, { method: "POST" });
async function emailStep(page, who) {
  await page.goto("/");
  await page.getByLabel("Work email").fill(who);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();
  const { code } = JSON.parse(
    readFileSync(`test-results/otp-${who.split("@")[0]}.json`, "utf8"),
  );
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify and continue" }).click();
}
async function ownerIn(page, letter) {
  await emailStep(page, `deploy-owner-${letter}@example.test`);
  await expect(
    page.getByRole("heading", { name: "Confirm with your authenticator" }),
  ).toBeVisible();
  await page
    .getByLabel("Authenticator code")
    .fill(codeAt(KEY, stepAt(Date.now())));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
    timeout: 20000,
  });
}
// The sign-in used this step, so the confirmation uses the next one.
async function confirmStepUp(page) {
  const dialog = page.locator("dialog[open]").filter({
    hasText: "Confirm it’s you",
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel("Authenticator code")
    .fill(codeAt(KEY, stepAt(Date.now()) + 1));
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function noOverflow(page, label) {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${label} overflows at ${width}`,
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
}
const item = (page, id) => page.locator(`[data-item="${id}"]`);
const dialog = (page) => page.locator("dialog[open]").last();
test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.9" } });

test("fleet page, customer merge and overview attention show honest states", async ({
  page,
}) => {
  test.setTimeout(90000);
  await control("reset?scenario=all");
  await control("worker?state=online");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ownerIn(page, "f");
  // Overview points at the fleet.
  const attention = page.getByRole("link", { name: /POS deploys failed/ });
  await expect(attention).toBeVisible();
  await expect(
    page.getByRole("link", { name: /POS clients locked/ }),
  ).toBeVisible();
  await attention.click();
  await expect(
    page.getByRole("heading", { name: "POS clients", level: 1 }),
  ).toBeVisible();
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "POS clients", exact: true })
    .click();
  const row = (slug) => page.locator(`tr[data-slug="${slug}"]`);
  await expect(row("ui-ready")).toBeVisible();
  await expect(row("ui-ready")).toContainText("Ready Cafe");
  await expect(row("ui-ready")).toContainText("main@9999999");
  await expect(row("ui-ready")).toContainText("Behind by 2 commits");
  await expect(row("ui-ready")).toContainText("Cached");
  await expect(row("ui-ready")).toContainText("Live");
  await expect(row("ui-failed")).toContainText("Failed");
  await expect(row("ui-stalled")).toContainText("Deploying");
  await expect(row("ui-blocked")).toContainText("Locked");
  await expect(row("ui-blocked")).toContainText("Not deployed");
  await expect(row("ui-unverified")).toContainText("Unverified");
  await expect(row("ui-diverged")).toContainText("Diverged from branch");
  await expect(row("ui-gone")).toContainText("Branch gone");
  expect((await axe(page)).violations, "fleet accessibility").toEqual([]);
  await noOverflow(page, "fleet");
  // Customer workspace: POS columns beside the installation.
  await page.goto(
    `/customers/00000000-0000-4000-8000-e00000000001/installations`,
  );
  await expect(
    page.getByRole("columnheader", { name: "Behind" }),
  ).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Live" })).toBeVisible();
  // The customer page uses the cheap route: no comparison, so Behind is a dash.
  await expect(page.getByRole("cell", { name: /main@9999999/ })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "—", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Deploy ui-ready" }).click();
  await expect(
    page.getByRole("heading", { name: "Deploy", level: 1 }),
  ).toBeVisible();
  // Opening a client from the fleet lands on its Deploy tab.
  await page.goto("/pos-clients");
  await row("ui-ready").getByRole("link", { name: "Open ui-ready" }).click();
  await expect(
    page.getByRole("heading", { name: "Deploy", level: 1 }),
  ).toBeVisible();
  // A worker that stopped is called out on the dashboard.
  await control("worker?state=offline");
  try {
    // The server caches the overview for 5 s: reload until the cache expires.
    const offline = page.getByRole("link", {
      name: /POS deploy worker offline/,
    });
    await expect
      .poll(
        async () => {
          await page.goto("/");
          await expect(
            page.getByRole("heading", { name: "Dashboard" }),
          ).toBeVisible();
          return offline.isVisible();
        },
        { timeout: 30000, intervals: [1000] },
      )
      .toBe(true);
  } finally {
    await control("worker?state=online");
  }
  expect(errors).toEqual([]);
});

test("readiness checklist shows every blocker with its fix", async ({
  page,
}) => {
  test.setTimeout(90000);
  await control("reset?scenario=blocked");
  await ownerIn(page, "a");
  await page.goto(deployUrl("blocked"));
  await expect(
    page.getByRole("heading", { name: "Deploy", level: 1 }),
  ).toBeVisible();
  const id = iid("blocked");
  await expect(page.getByText("Not ready", { exact: true })).toBeVisible();
  for (const [name, state] of [
    ["worker", "ok"],
    ["authenticator", "ok"],
    ["vercel-token", "blocked"],
    ["project-ids", "blocked"],
    ["host", "blocked"],
    ["verified", "blocked"],
    ["unlocked", "blocked"],
    ["customer-active", "ok"],
  ])
    await expect(item(page, name)).toHaveAttribute("data-state", state);
  await expect(
    item(page, "vercel-token").getByRole("link", { name: "Add token" }),
  ).toHaveAttribute("href", `/installations/${id}/pos#secrets`);
  await expect(
    item(page, "project-ids").getByRole("link", { name: "Add ids" }),
  ).toHaveAttribute("href", `/installations/${id}/pos#vercel`);
  await expect(
    item(page, "host").getByRole("link", { name: "Set host" }),
  ).toHaveAttribute("href", `/installations/${id}/pos#host`);
  await expect(item(page, "verified")).toContainText("Run Verify now");
  // The owner cannot unlock yet and is told why (no dead button).
  await expect(item(page, "unlocked")).toContainText("Before unlocking:");
  await expect(
    item(page, "unlocked").getByRole("button", { name: /Unlock/ }),
  ).toHaveCount(0);
  const deploy = page.getByRole("button", { name: "Deploy", exact: true });
  await expect(deploy).toBeDisabled();
  await expect(page.locator("#why-deploy")).toContainText("Not ready:");
  expect((await axe(page)).violations, "blocked accessibility").toEqual([]);
  await noOverflow(page, "blocked deploy tab");
  // Verify now enqueues the verify task and says so.
  await item(page, "verified")
    .getByRole("button", { name: "Verify now" })
    .click();
  await expect(
    page.getByText("Verifying this client’s credentials…"),
  ).toBeVisible();
  // A fix link lands on the right section of the setup page.
  await item(page, "vercel-token")
    .getByRole("link", { name: "Add token" })
    .click();
  await expect(
    page.getByRole("heading", { name: "POS setup", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("#secrets")).toBeInViewport();
});

test("branch picker, deploy with typed slug and step-up, live progress and cancel", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("reset?scenario=deploy");
  await ownerIn(page, "b");
  await page.goto(deployUrl("deploy"));
  await expect(
    page.getByRole("heading", { name: "Deploy", level: 1 }),
  ).toBeVisible();
  // Versions.
  const live = page.getByRole("region", { name: "Live version" });
  await expect(live).toContainText("main@9999999");
  await expect(live).toContainText("Add table QR codes");
  const previous = page.getByRole("region", { name: "Previous version" });
  await expect(previous).toContainText("main@8888888");
  await expect(
    page.getByText("Ready to deploy", { exact: true }),
  ).toBeVisible();
  // Branches: cached vs will build.
  const main = page.locator(".branch-option").filter({ hasText: "main" });
  const feature = page
    .locator(".branch-option")
    .filter({ hasText: "feature/x" });
  await expect(main).toContainText("Build ready (cached)");
  await expect(feature).toContainText("Will build");
  await expect(
    page.getByRole("button", { name: "Deploy", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#why-deploy")).toContainText(
    "Pick a branch first.",
  );
  await main.click();
  await expect(page.locator(".plan-summary")).toContainText(
    "Build ready (cached",
  );
  await expect(page.locator(".plan-summary")).toContainText(
    "No new build needed",
  );
  await feature.click();
  await expect(page.locator(".plan-summary")).toContainText(
    "Will build first (~3 min)",
  );
  await expect(page.locator(".plan-summary")).toContainText(
    "2 commits newer than live.",
  );
  // Prepare build: no production change, no authenticator needed.
  await page
    .getByRole("button", { name: "Prepare build", exact: true })
    .click();
  await expect(dialog(page)).toContainText("The live site is not changed.");
  await dialog(page)
    .getByRole("button", { name: "Prepare build", exact: true })
    .click();
  await expect(page.getByText("Build queued.")).toBeVisible();
  // Deploy: what will happen, typed slug, then the authenticator.
  await page.getByRole("button", { name: "Deploy feature/x" }).click();
  const modal = dialog(page);
  await expect(modal).toContainText("ui-deploy-app");
  await expect(modal).toContainText("feature/x@bbbbbbb");
  await expect(modal).toContainText("Feature work");
  await expect(modal).toContainText("Will build first (~3 min)");
  await expect(modal).toContainText(
    "Environment variables on Vercel are not changed.",
  );
  const confirm = modal.getByRole("button", { name: "Deploy", exact: true });
  await expect(confirm).toBeDisabled();
  await modal.getByLabel("Type ui-deploy to confirm").fill("ui-deplo");
  await expect(confirm).toBeDisabled();
  await modal.getByLabel("Type ui-deploy to confirm").fill("ui-deploy");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await confirmStepUp(page);
  await expect(page.getByText("Deploy queued.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Deploying feature/x@bbbbbbb" }),
  ).toBeVisible();
  await expect(page.locator(".progress-status")).toHaveText(
    "Waiting for the worker to pick this up.",
  );
  await expect(page.locator(".step-item")).toHaveCount(5);
  // The page polls: the worker moves to the build step.
  await control("job?scenario=deploy&status=running&step=build&run=1");
  await expect(page.locator(".progress-status")).toHaveText("Now: Build.", {
    timeout: 20000,
  });
  const build = page.locator(".step-item").filter({ hasText: "Build" });
  await expect(build).toHaveAttribute("data-state", "running");
  await expect(build).toContainText("GitHub build 2:13");
  const run = build.getByRole("link", { name: /GitHub run/ });
  await expect(run).toHaveAttribute(
    "href",
    "https://github.com/owner/builder/actions/runs/123",
  );
  await expect(run).toHaveAttribute("rel", /noreferrer/);
  expect((await axe(page)).violations, "progress accessibility").toEqual([]);
  await noOverflow(page, "deploy tab with progress");
  // After the upload starts there is no cancelling.
  await control("job?scenario=deploy&status=running&step=upload");
  await expect(page.getByText("Too late to cancel")).toBeVisible({
    timeout: 20000,
  });
  await expect(
    page.getByRole("button", { name: "Cancel deploy" }),
  ).toBeDisabled();
  // Back before the upload: cancel it.
  await control("job?scenario=deploy&status=running&step=build");
  const cancel = page.getByRole("button", { name: "Cancel deploy" });
  await expect(cancel).toBeEnabled({ timeout: 20000 });
  await cancel.click();
  await expect(page.locator(".progress-status")).toHaveText(
    "Cancelling after the current step.",
  );
  await control("job?scenario=deploy&status=cancelled&step=build");
  await expect(
    page.getByRole("heading", { name: "The deploy was cancelled" }),
  ).toBeVisible({ timeout: 20000 });
});

test("redeploy confirms without a typed slug; rollback needs the slug", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("reset?scenario=redeploy");
  await ownerIn(page, "c");
  await page.goto(deployUrl("redeploy"));
  await expect(
    page.getByRole("heading", { name: "Deploy", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Redeploy", exact: true }).click();
  let modal = dialog(page);
  await expect(modal).toContainText("Redeploy the live commit?");
  await expect(modal).toContainText("main@9999999");
  await expect(modal).toContainText("Add table QR codes");
  await expect(modal.getByLabel(/Type .* to confirm/)).toHaveCount(0);
  await modal.getByRole("button", { name: "Redeploy", exact: true }).click();
  await confirmStepUp(page);
  await expect(
    page.getByRole("heading", { name: "Redeploying main@9999999" }),
  ).toBeVisible();
  await control("job?scenario=redeploy&status=clear");
  await expect(page.getByRole("heading", { name: /Redeploying/ })).toHaveCount(
    0,
    {
      timeout: 20000,
    },
  );
  // "Roll back to this" on the previous version opens the same confirmation.
  await page.getByRole("button", { name: "Roll back to this" }).click();
  await expect(dialog(page)).toContainText(
    "Roll back to the previous version?",
  );
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Roll back", exact: true }).click();
  modal = dialog(page);
  await expect(modal).toContainText("main@8888888");
  await expect(modal).toContainText("Fix receipt rounding");
  const go = modal.getByRole("button", { name: "Roll back", exact: true });
  await expect(go).toBeDisabled();
  await modal.getByLabel("Type ui-redeploy to confirm").fill("nope");
  await expect(go).toBeDisabled();
  await modal.getByLabel("Type ui-redeploy to confirm").fill("ui-redeploy");
  await go.click();
  await expect(
    page.getByRole("heading", { name: "Rolling back to main@8888888" }),
  ).toBeVisible();
  // A rollback has only the steps it runs.
  await expect(page.locator(".step-item")).toHaveCount(3);
});

test("failed, stalled and auto-rolled-back jobs are explained honestly", async ({
  page,
}) => {
  test.setTimeout(90000);
  await control("reset?scenario=all");
  await ownerIn(page, "d");
  await page.goto(deployUrl("failed"));
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "The deploy failed" });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("The POS build failed on GitHub");
  await expect(failure).toContainText("Failed at");
  await expect(failure).toContainText("Build");
  await expect(failure).toContainText("build-failed");
  const link = failure.getByRole("link", { name: /Open GitHub run/ });
  await expect(link).toHaveAttribute(
    "href",
    "https://github.com/owner/builder/actions/runs/123",
  );
  await expect(link).toHaveAttribute("rel", /noreferrer/);
  expect((await axe(page)).violations, "error panel accessibility").toEqual([]);
  await failure.getByRole("button", { name: "Dismiss" }).click();
  await expect(failure).toHaveCount(0);
  // The worker restarted: say it is resuming.
  await page.goto(deployUrl("stalled"));
  await expect(page.locator(".progress-status")).toHaveText(
    "Worker restarted — resuming.",
  );
  // Health failed and the previous version was put back; the run link expired.
  await page.goto(deployUrl("rolledback"));
  const back = page.locator(".deploy-error");
  await expect(
    back.getByRole("heading", {
      name: "Health check failed — rolled back to main@8888888",
    }),
  ).toBeVisible();
  await expect(back).toContainText(
    "may have been live for up to about a minute",
  );
  await expect(back).not.toContainText("Customers are not affected");
  await expect(back.getByRole("link", { name: /Open GitHub run/ })).toHaveCount(
    0,
  );
  // No automatic rollback was possible: the site may be down.
  await control("job?scenario=rolledback&status=unhealthy&step=health");
  await expect(
    page.getByRole("heading", {
      name: "Health check failed — the site may be down",
    }),
  ).toBeVisible({ timeout: 20000 });
});

test("unlock needs the slug, the authenticator and a clean verify", async ({
  page,
}) => {
  test.setTimeout(90000);
  await control("reset?scenario=unlock");
  await ownerIn(page, "e");
  await page.goto(deployUrl("unlock"));
  await expect(item(page, "unlocked")).toHaveAttribute("data-state", "blocked");
  await expect(page.locator(".deploy-lock")).toContainText("Locked");
  await item(page, "unlocked").getByRole("button", { name: "Unlock…" }).click();
  const modal = dialog(page);
  const go = modal.getByRole("button", { name: "Unlock", exact: true });
  await expect(go).toBeDisabled();
  await modal.getByLabel("Type ui-unlock to confirm").fill("ui-unlock");
  await modal.getByLabel("I set deployLock in the local client file").check();
  await go.click();
  await confirmStepUp(page);
  await expect(
    page
      .locator(".notice")
      .filter({ hasText: "Deploys are unlocked for this client." }),
  ).toBeVisible();
  await expect(item(page, "unlocked")).toHaveAttribute("data-state", "ok");
  await expect(page.locator(".deploy-lock")).toContainText("Unlocked");
  // And back again.
  await page.getByRole("button", { name: "Lock deploys" }).click();
  await dialog(page).getByRole("button", { name: "Lock deploys" }).click();
  await expect(
    page
      .locator(".notice")
      .filter({ hasText: "Deploys are locked for this client." }),
  ).toBeVisible();
  await expect(item(page, "unlocked")).toHaveAttribute("data-state", "blocked");
  // The setup page shows a badge instead of a checkbox.
  await page.goto(`/installations/${iid("unlock")}/pos`);
  await expect(page.getByLabel("Deploy lock on")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Change it on the Deploy tab" }),
  ).toBeVisible();
});

test("an admin sees status read-only and a viewer cannot open deploy pages", async ({
  page,
}) => {
  test.setTimeout(90000);
  await control("reset?scenario=ready");
  await emailStep(page, "deploy-admin@example.test");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
    timeout: 20000,
  });
  await page.goto(deployUrl("ready"));
  await expect(
    page.getByRole("heading", { name: "Deploy", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Only the owner can deploy")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Live version" }),
  ).toContainText("main@9999999");
  for (const name of ["Redeploy", "Roll back", "Prepare build"])
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await expect(page.locator("#why-redeploy")).toHaveText(
    "Only the owner can do this.",
  );
  await expect(
    page.getByRole("button", { name: "Roll back to this" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Unlock|Lock deploys|Unfreeze/ }),
  ).toHaveCount(0);
  await expect(page.locator(".deploy-lock")).toContainText(
    "Only the owner can lock or unlock",
  );
  expect((await axe(page)).violations, "read-only accessibility").toEqual([]);
  await noOverflow(page, "read-only deploy tab");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  // A viewer has no access to deploy status at all.
  await emailStep(page, "viewer@example.test");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
    timeout: 20000,
  });
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "POS clients" }),
  ).toHaveCount(0);
  await page.goto("/pos-clients");
  await expect(page.getByText("This page is not available")).toBeVisible();
  await page.goto(deployUrl("ready"));
  await expect(
    page.getByRole("heading", { name: "Deploy is restricted" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Installation navigation" })
      .getByRole("link", { name: "Deploy", exact: true }),
  ).toHaveCount(0);
});

test("verify shows the failing project setting with actual and expected, and a Node.js warning", async ({
  page,
}) => {
  test.setTimeout(60000);
  await control("reset?scenario=settings");
  await ownerIn(page, "p");
  await page.goto(deployUrl("settings"));
  const issues = page.locator(".verify-issues");
  await expect(issues).toContainText(
    "Root Directory is 'src', expected 'apps/cafe'",
  );
  await expect(issues).toContainText("Settings, Build and Deployment");
  await expect(issues).toContainText(
    "Node.js version is 24.x on Vercel; admin deploys run on Node 22 from the build (only local-console builds use the project setting).",
  );
  await expect(page.locator(".verify-flags")).toContainText("Project settings");
});
