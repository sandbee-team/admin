import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
// Go live tab of a new client (P5 Stage 3, D41-D47). Fixtures: test/ui-server.js
// (GOLIVE_SCENARIOS, goliveAt). No worker runs: the real routes start, check,
// unlock-and-deploy, sync and cancel; the control port moves the slot as the
// go-live worker lane would.
const password = "Browser test passphrase 2026!";
const KEY = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
const N = {
  glstart: 31,
  glwait: 32,
  glfail: 33,
  gllive: 34,
  glworker: 35,
  envmissing: 36,
};
const SLUG = {
  glstart: "ui-gl-start",
  glwait: "ui-gl-wait",
  glfail: "ui-gl-fail",
  gllive: "ui-gl-live",
  glworker: "ui-gl-worker",
};
const CNAME = "0123456789abcdef.vercel-dns-017.com";
const iid = (name) =>
  `00000000-0000-4000-8000-d${String(N[name]).padStart(11, "0")}`;
const url = (name, tab = "golive") =>
  `/installations/${iid(name)}${tab ? `/${tab}` : ""}`;
const axe = (page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
const control = async (path) => {
  const res = await fetch(`http://127.0.0.1:8109/pos/${path}`, {
    method: "POST",
  });
  expect(res.status, `control ${path}`).toBe(200);
};
async function passwordStep(page, who) {
  await page.goto("/");
  await page.getByLabel("Work email").fill(who);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}
async function ownerIn(page, letter) {
  await passwordStep(page, `golive-owner-${letter}@example.test`);
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
// Staff without an authenticator get an email code.
async function adminIn(page) {
  const who = "golive-admin@example.test";
  await passwordStep(page, who);
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();
  const { code } = JSON.parse(
    readFileSync(`test-results/otp-${who.split("@")[0]}.json`, "utf8"),
  );
  await page.getByLabel("Verification code").fill(code);
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
const modalOf = (page) =>
  page.locator("dialog[open]").filter({ hasNotText: "Confirm it’s you" });
const progress = (page) => page.locator("section.golive-progress");
const statusLine = (page) => progress(page).locator(".progress-status");
const records = (page) => page.locator("section.golive-address");
// No page scroll and no panel wider than itself (panels clip their content).
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
    const wide = await page
      .locator(".deploy-stack > section.panel")
      .evaluateAll((panels) =>
        panels
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => el.getAttribute("aria-labelledby")),
      );
    expect(wide, `${label} panels overflow at ${width}`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
}
test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.31" } });
// Never leave a go-live client behind for the fleet and rollout specs.
test.afterAll(async () => {
  await control("reset?scenario=all");
});

test("go-live: start, progress, DNS records, check, unlock and deploy, live, sync env", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await control("worker?state=online");
  await control("reset?scenario=glstart");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ownerIn(page, "a");
  // A new client shows the Go live tab; one admin deployed does not.
  await page.goto(url("glstart", ""));
  const nav = page.getByRole("navigation", { name: "Installation navigation" });
  await expect(nav.getByRole("link", { name: "Go live" })).toBeVisible();
  await nav.getByRole("link", { name: "Go live" }).click();
  await expect(
    page.getByRole("heading", { name: "Go live", level: 1 }),
  ).toBeVisible();
  const checklist = page.locator("section[aria-labelledby=readiness-title]");
  await expect(checklist).toContainText("Is this client ready to go live?");
  await expect(checklist).toContainText("Ready to start");
  await expect(checklist.locator('[data-item="realtime"]')).toHaveAttribute(
    "data-state",
    "warn",
  );
  await expect(checklist.locator('[data-item="new-client"]')).toHaveAttribute(
    "data-state",
    "ok",
  );
  await expect(page.getByText("ui-gl-start.sandbee.in").first()).toBeVisible();
  // main is picked by default.
  await expect(page.locator('input[type="radio"][value="main"]')).toBeChecked();
  expect((await axe(page)).violations, "start page accessibility").toEqual([]);
  // Start: typed slug + step-up.
  await page.getByRole("button", { name: "Start go-live…" }).click();
  const modal = modalOf(page);
  await expect(modal).toContainText("Start the go-live?");
  await expect(modal).toContainText("main@aaaaaaa");
  const submit = modal.getByRole("button", { name: "Start go-live" });
  await expect(submit).toBeDisabled();
  await modal.getByLabel("Type ui-gl-start to confirm").fill("ui-gl-start");
  await submit.click();
  await confirmStepUp(page);
  await expect(page.locator(".notice")).toContainText("Go-live queued.");
  await expect(statusLine(page)).toHaveText(
    "Waiting for the worker to pick this up.",
  );
  await expect(progress(page).locator(".step-item")).toHaveCount(11);
  await expect(
    progress(page).getByRole("button", { name: "Cancel go-live…" }),
  ).toBeVisible();
  // The start panel is gone while the run is active.
  await expect(
    page.getByRole("button", { name: "Start go-live…" }),
  ).toHaveCount(0);
  // The worker is on the web address step.
  await control("golive?scenario=glstart&phase=running&step=domain");
  await expect(statusLine(page)).toHaveText("Now: Web address.");
  await expect(progress(page).locator('[data-step="project"]')).toHaveAttribute(
    "data-state",
    "done",
  );
  await expect(
    progress(page).locator('[data-step="realtime"]'),
  ).toHaveAttribute("data-state", "skipped");
  await expect(progress(page).locator('[data-step="domain"]')).toHaveAttribute(
    "data-state",
    "running",
  );
  // Waiting for DNS: the records to enter, with copy buttons and the reason.
  await control(
    "golive?scenario=glstart&phase=waiting-dns&warnings=dns-pending",
  );
  await expect(statusLine(page)).toContainText("Waiting for DNS");
  const box = records(page);
  await expect(box).toContainText("Waiting for DNS");
  const row = box.locator('tr[data-type="CNAME"]');
  await expect(row).toContainText("ui-gl-start");
  await expect(row).toContainText(CNAME);
  await box.getByRole("button", { name: `Copy CNAME value ${CNAME}` }).click();
  await expect(
    box.getByRole("button", { name: `Copy CNAME value ${CNAME}` }),
  ).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CNAME);
  await box
    .getByRole("button", { name: "Copy CNAME name ui-gl-start" })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "ui-gl-start",
  );
  await expect(box.locator('[data-code="dns-pending"]')).toContainText(
    "DNS not found yet.",
  );
  await expect(box).toContainText("CNAME: not found yet");
  // Check DNS queues a run from the dns step.
  await box.getByRole("button", { name: "Check DNS" }).click();
  await expect(page.locator(".notice")).toContainText("DNS check queued.");
  await expect(page.getByRole("heading", { name: /^DNS check/ })).toBeVisible();
  // DNS ready and the bootstrap verify passed: Unlock and deploy.
  await control("golive?scenario=glstart&phase=waiting-deploy");
  await expect(statusLine(page)).toHaveText(
    "Ready for the first deploy: press Unlock and deploy.",
  );
  await expect(box).toContainText("CNAME: found and correct");
  await expect(box).toContainText("HTTPS: comes with the first deploy");
  await expect(page.locator("section.golive-checks")).toContainText(
    "/api/public/*",
  );
  await expect(page.locator("section.golive-checks")).toContainText(
    "R2 bucket CORS",
  );
  await page.getByRole("button", { name: "Unlock and deploy…" }).click();
  const deploy = modalOf(page);
  await expect(deploy).toContainText("Unlock and deploy this client?");
  await expect(deploy.getByRole("checkbox")).toHaveCount(0);
  await deploy.getByLabel("Type ui-gl-start to confirm").fill("ui-gl-start");
  // The step-up from Start is still fresh (10 minutes).
  await deploy.getByRole("button", { name: "Unlock and deploy" }).click();
  await expect(page.locator(".notice")).toContainText(
    "Deploys are unlocked and the first deploy is queued.",
  );
  await expect(statusLine(page)).toContainText("The first deploy is running.");
  await expect(
    statusLine(page).getByRole("link", { name: "Open the Deploy tab" }),
  ).toBeVisible();
  // The fleet says so.
  await page.goto("/pos-clients");
  await expect(page.locator('tr[data-slug="ui-gl-start"]')).toContainText(
    "Going live — first deploy",
  );
  // Live: owner checks, what admin set up, Sync env.
  await control("golive?scenario=glstart&phase=live");
  await page.goto(url("glstart"));
  await expect(
    page.getByRole("heading", { name: /^This client is live/ }),
  ).toBeVisible();
  await expect(statusLine(page)).toContainText("Live since");
  await expect(page.locator("section.golive-checks")).toContainText(
    "https://ui-gl-start.sandbee.in/login",
  );
  await expect(
    page.locator("section[aria-labelledby=golive-facts-title]"),
  ).toContainText("Vercel project");
  await expect(page.getByRole("button", { name: "Start again…" })).toHaveCount(
    0,
  );
  // Realtime is off for this client: the Worker update explains why.
  await expect(
    page.getByRole("button", { name: "Update realtime Worker…" }),
  ).toBeDisabled();
  await expect(page.locator("#why-realtime")).toHaveText("Needs: Realtime.");
  await page.getByRole("button", { name: "Sync env…" }).click();
  const sync = modalOf(page);
  await expect(sync).toContainText("Sync the environment variables?");
  await sync.getByLabel("Type ui-gl-start to confirm").fill("ui-gl-start");
  await sync.getByRole("button", { name: "Sync env", exact: true }).click();
  await expect(page.locator(".notice")).toContainText("Sync env queued.");
  await expect(page.getByRole("heading", { name: /^Sync env/ })).toBeVisible();
  await expect(progress(page).locator(".step-item")).toHaveCount(2);
  await page.goto(url("glstart", "pos"));
  await expect(
    page.getByRole("heading", { name: "POS setup", level: 1 }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("go-live: waiting for DNS at every width; an admin can only check DNS", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("worker?state=online");
  await control("reset?scenario=glwait");
  await control("reset?scenario=gllive");
  await adminIn(page);
  await page.goto(url("glwait"));
  await expect(page.locator(".deploy-readonly")).toContainText(
    "Only the owner can start, deploy, sync or cancel it.",
  );
  const box = records(page);
  await expect(box.locator("tbody tr")).toHaveCount(2);
  await expect(box.locator('tr[data-type="TXT"]')).toContainText(
    "_vercel.ui-gl-wait",
  );
  await expect(box).toContainText("TXT: not found yet");
  await expect(box.getByRole("button", { name: "Check DNS" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Cancel go-live/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Run all steps/ })).toHaveCount(
    0,
  );
  await expect(
    page.locator("section[aria-labelledby=golive-start-title]"),
  ).toContainText("Only the owner can start a go-live.");
  await noOverflow(page, "waiting for DNS");
  expect((await axe(page)).violations, "waiting accessibility").toEqual([]);
  // The records stack on a phone and stay readable.
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(box.locator('tr[data-type="CNAME"]')).toContainText(CNAME);
  expect((await axe(page)).violations, "phone accessibility").toEqual([]);
  await page.setViewportSize({ width: 1440, height: 960 });
  // Fleet badges: waiting for DNS; a client live once has none.
  await page.goto("/pos-clients");
  await expect(page.locator('tr[data-slug="ui-gl-wait"]')).toContainText(
    "Going live — waiting for DNS",
  );
  await expect(page.locator('tr[data-slug="ui-gl-live"]')).toBeVisible();
  await expect(page.locator('tr[data-slug="ui-gl-live"]')).not.toContainText(
    "Going live",
  );
  // An admin presses Check DNS (credentials permission).
  await page.goto(url("glwait"));
  await records(page).getByRole("button", { name: "Check DNS" }).click();
  await expect(page.locator(".notice")).toContainText("DNS check queued.");
  await expect(statusLine(page)).toHaveText(
    "Waiting for the worker to pick this up.",
  );
  // Waiting for the deploy: the admin can check again but never sees an
  // Unlock and deploy button the server would refuse (403).
  await control("golive?scenario=glwait&phase=waiting-deploy");
  await page.reload();
  const first = page.locator("section.golive-deploy");
  await expect(first).toContainText("Only the owner can do this.");
  await expect(first.getByRole("button")).toHaveCount(0);
  await expect(
    records(page).getByRole("button", { name: "Check DNS" }),
  ).toBeVisible();
  await noOverflow(page, "waiting for deploy");
  expect((await axe(page)).violations, "waiting deploy accessibility").toEqual(
    [],
  );
  // A live client at every width, read-only for the admin.
  await page.goto(url("gllive"));
  await expect(
    page.getByRole("heading", { name: /^This client is live/ }),
  ).toBeVisible();
  // admin-exists: the client keeps their own password; no reveal step.
  await expect(page.locator("section.golive-checks")).toContainText(
    "already had a POS admin",
  );
  await expect(progress(page)).toContainText("Old address not redirected");
  await expect(
    page.locator("section[aria-labelledby=golive-later-title]"),
  ).toContainText("Only the owner can sync env or update the Worker.");
  await noOverflow(page, "live");
  expect((await axe(page)).violations, "live accessibility").toEqual([]);
});

test("go-live: failure, blocked readiness, cancel and env keys missing", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("worker?state=online");
  for (const name of ["glfail", "glworker", "glwait", "envmissing"])
    await control(`reset?scenario=${name}`);
  await ownerIn(page, "b");
  // A failed run says what happened and offers to start again.
  await page.goto(url("glfail"));
  await expect(
    page.getByRole("heading", { name: /^Go-live failed/ }),
  ).toBeVisible();
  const failure = progress(page).locator(".golive-error");
  await expect(failure).toContainText("Vercel project: Project already live");
  await expect(failure).toContainText("Verify and Unlock on the Deploy tab");
  await expect(progress(page).locator('[data-step="project"]')).toHaveAttribute(
    "data-state",
    "failed",
  );
  await expect(
    page.getByRole("button", { name: "Start again…" }),
  ).toBeVisible();
  await noOverflow(page, "failed");
  expect((await axe(page)).violations, "failed accessibility").toEqual([]);
  // Open item 1: a hand-entered Worker URL without a token blocks Start.
  await page.goto(url("glworker"));
  const item = page.locator('[data-item="realtime"]');
  await expect(item).toHaveAttribute("data-state", "blocked");
  await expect(item).toContainText("no Cloudflare token is stored");
  await expect(
    item.getByRole("link", { name: "Fix realtime" }),
  ).toHaveAttribute("href", `/installations/${iid("glworker")}/pos#cloudflare`);
  await expect(
    page.locator("section[aria-labelledby=readiness-title]"),
  ).toContainText("Not ready");
  await expect(
    page.locator("section[aria-labelledby=golive-start-title] .panel-foot"),
  ).toHaveText("Needs: Realtime.");
  await expect(
    page.getByRole("button", { name: "Start go-live…" }),
  ).toHaveCount(0);
  // The fix link lands on the Cloudflare section of POS setup.
  await item.getByRole("link", { name: "Fix realtime" }).click();
  await expect(page.locator("#cloudflare")).toBeInViewport();
  // Cancel a run that waits for DNS: nothing created is removed.
  await page.goto(url("glwait"));
  await progress(page).getByRole("button", { name: "Cancel go-live…" }).click();
  const confirm = modalOf(page);
  await expect(confirm).toContainText("Nothing is deleted");
  await confirm.getByRole("button", { name: "Cancel go-live" }).click();
  await expect(page.locator(".notice")).toContainText(
    "The go-live run was cancelled.",
  );
  await expect(statusLine(page)).toHaveText(
    "Cancelled. What it already created stays as it is.",
  );
  await expect(
    page.getByRole("button", { name: "Start again…" }),
  ).toBeVisible();
  // Verify's names-only env warning on the Deploy tab of an imported client;
  // such a client has no Go live tab.
  await page.goto(url("envmissing", "deploy"));
  const missing = page.locator(".verify-missing");
  await expect(missing).toContainText("Env keys missing");
  await expect(
    missing.getByRole("list", {
      name: "Environment variables missing on Vercel",
    }),
  ).toContainText("REALTIME_URL");
  await expect(missing.locator("li")).toHaveCount(3);
  await expect(
    page
      .getByRole("navigation", { name: "Installation navigation" })
      .getByRole("link", { name: "Go live" }),
  ).toHaveCount(0);
  expect((await axe(page)).violations, "deploy tab accessibility").toEqual([]);
});
