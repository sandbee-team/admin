import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
import { describeCode } from "../../shared/deploy-errors.js";
// "Deploy a commit to all clients" panel on the fleet page (P3). Fixtures:
// test/ui-server.js (seedPos, scenario `demo` is the canary). No worker runs:
// the control port's /pos/rollout moves the row the real start route created,
// the way the worker would.
const password = "Browser test passphrase 2026!";
const KEY = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
// main's head in the fake GitHub (test/ui-server.js).
const SHA = "a".repeat(40);
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
async function adminIn(page) {
  await emailStep(page, "deploy-admin@example.test");
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
const panelOf = (page) => page.locator("section.rollout-panel");
const rowOf = (page, slug) => panelOf(page).locator(`tr[data-slug="${slug}"]`);
const statusOf = (page) => panelOf(page).locator(".rollout-status");
const modalOf = (page) => page.locator("dialog[open]").last();
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
    // .panel clips its content, so check the panel itself too.
    expect(
      await panelOf(page).evaluate((el) => el.scrollWidth <= el.clientWidth),
      `${label} panel overflows at ${width}`,
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
}
async function openFleet(page) {
  await page.goto("/pos-clients");
  await expect(
    page.getByRole("heading", { name: "POS clients", level: 1 }),
  ).toBeVisible();
  await expect(panelOf(page)).toHaveAttribute(
    "data-status",
    /^(idle|running|cancelling|stopped|cancelled|completed)$/,
  );
}
// Opens the picker and previews main.
async function previewMain(page) {
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Choose a commit…" }).click();
  await panel.locator(".branch-option").filter({ hasText: "main" }).click();
  await expect(panel.locator(".rollout-commit")).toContainText(
    "main@aaaaaaa — Main headline — Dev Person",
  );
}
// The slugs of the plan's (or the rollout's) table, in order.
const slugsOf = (page) =>
  panelOf(page)
    .locator("tbody tr")
    .evaluateAll((rows) => rows.map((row) => row.dataset.slug));
// Starts a rollout of main through the real route; returns the target slugs.
async function startRollout(page) {
  // The seeded stalled deploy still holds its lease: the start would be busy.
  await control("job?scenario=stalled&status=clear");
  await openFleet(page);
  await previewMain(page);
  const slugs = await slugsOf(page);
  const panel = panelOf(page);
  await panel
    .getByRole("button", { name: `Deploy to ${slugs.length} clients…` })
    .click();
  await modalOf(page)
    .getByLabel("Type deploy all to confirm")
    .fill("deploy all");
  await modalOf(page)
    .getByRole("button", {
      name: `Deploy to ${slugs.length} clients`,
      exact: true,
    })
    .click();
  await confirmStepUp(page);
  await expect(panel).toHaveAttribute("data-status", "running");
  return slugs;
}
test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.15" } });

test.afterAll(async () => {
  await control("rollout?clear=1");
  await control("freeze?on=0");
  await control("worker?state=online");
  await control("reset?scenario=all");
});
// The start dialog and the authenticator prompt, told apart by their text.
const startDialogOf = (page) =>
  page
    .locator("dialog[open]")
    .filter({ hasText: "Type deploy all to confirm" });
const stepUpOf = (page) =>
  page.locator("dialog[open]").filter({ hasText: "Confirm it’s you" });
// deploy-admin in its own browser context, on the fleet page.
async function adminOn(browser) {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:8108",
    extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.15" },
  });
  const adminPage = await context.newPage();
  await adminIn(adminPage);
  await openFleet(adminPage);
  return { context, adminPage };
}
const startBody = (digest = expect.stringMatching(/^[0-9a-f]{64}$/)) => ({
  branch: "main",
  sha: SHA,
  digest,
  confirm: "deploy all",
});

test("owner previews a commit with its warnings, a changed client list is refused, then the rollout runs", async ({
  page,
}) => {
  test.setTimeout(240000);
  await control("reset?scenario=all");
  await control("worker?state=online");
  await control("freeze?on=1&reason=Rollout check");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const branchReads = [],
    starts = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/pos/branches") branchReads.push(path);
    if (request.method() === "POST" && path === "/api/pos/rollout")
      starts.push(request.postDataJSON());
  });
  try {
    await ownerIn(page, "x");
    await openFleet(page);
    const panel = panelOf(page);
    await expect(panel).toHaveAttribute("data-status", "idle");
    await expect(
      panel.getByRole("heading", { name: "Deploy a commit to all clients" }),
    ).toBeVisible();
    await expect(panel).toContainText(
      "Starts every client’s build at once, then deploys one client at a time — demo first, then A–Z. Stops at the first failure.",
    );
    // Compact until asked: the branch list (rate limited) is not read yet.
    const choose = panel.getByRole("button", { name: "Choose a commit…" });
    await expect(choose).toHaveAttribute("aria-expanded", "false");
    await expect(panel.locator(".branch-option")).toHaveCount(0);
    expect(branchReads).toEqual([]);
    await expect(statusOf(page)).toHaveText("");
    await previewMain(page);
    expect(branchReads).toHaveLength(1);
    // No per-branch build chip: there is no one installation to build for.
    await expect(panel.locator(".branch-cache")).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Close", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    // Demo first, then A-Z.
    const slugs = await slugsOf(page);
    expect(slugs[0]).toBe("demo");
    expect(slugs.slice(1)).toEqual([...slugs.slice(1)].sort());
    expect(slugs.length).toBeGreaterThan(5);
    await expect(panel).toContainText(
      `${slugs.length} clients will get this commit.`,
    );
    await expect(rowOf(page, "demo")).toContainText("Demo Cafe");
    await expect(rowOf(page, "ui-purge-nocut")).toContainText("Not deployed");
    // Clients this commit moves back or replaces, per row and summed up.
    await expect(rowOf(page, "demo")).toContainText("main@6666666");
    await expect(rowOf(page, "demo")).toContainText(
      "Newer commit live — this moves it back",
    );
    await expect(rowOf(page, "ui-diverged")).toContainText(
      "Live commit not on this branch — this replaces it",
    );
    const warnings = panel.locator(".rollout-plan .plan-warnings");
    await expect(warnings).toContainText(
      "1 client runs a newer commit and will be moved back.",
    );
    await expect(warnings).toContainText(
      "1 client runs a commit that is not on this branch; it will be replaced.",
    );
    // Left out, with the reason.
    const excluded = panel.locator(".rollout-excluded");
    await expect(excluded.getByRole("heading")).toHaveText(
      /^Not included \(\d+\)$/,
    );
    await expect(excluded.locator('li[data-slug="ui-unlock"]')).toHaveAttribute(
      "data-code",
      "locked",
    );
    await expect(excluded.locator('li[data-slug="ui-unlock"]')).toContainText(
      "Deploys locked",
    );
    await expect(
      excluded.locator('li[data-slug="ui-unverified"]'),
    ).toContainText("Client not ready: Credentials verified");
    for (const slug of ["ui-unlock", "ui-blocked", "ui-unverified"])
      expect(slugs).not.toContain(slug);
    // Frozen first, then the running deploy that would block the start.
    await expect(panel.locator(".rollout-busy")).toHaveText(
      "Wait for running deploys to finish: ui-stalled.",
    );
    const start = panel.getByRole("button", {
      name: `Deploy to ${slugs.length} clients…`,
    });
    await expect(start).toBeDisabled();
    await expect(panel.locator("#why-rollout-start")).toHaveText(
      "Deploys are frozen.",
    );
    await control("freeze?on=0");
    await page.reload();
    await previewMain(page);
    await expect(start).toBeDisabled();
    await expect(panel.locator("#why-rollout-start")).toHaveText(
      "Wait for running deploys to finish.",
    );
    expect((await axe(page)).violations, "plan accessibility").toEqual([]);
    await noOverflow(page, "plan");
    await control("job?scenario=stalled&status=clear");
    await panel.getByRole("button", { name: "Preview again" }).click();
    await expect(panel.locator(".rollout-busy")).toHaveCount(0);
    await expect(start).toBeEnabled();
    // The dialog: what happens, the warnings again, the typed phrase.
    await start.click();
    const dialog = startDialogOf(page);
    await expect(dialog).toContainText(
      `Deploys main@aaaaaaa to ${slugs.length} clients, one at a time, demo first.`,
    );
    await expect(dialog.locator(".plan-warnings")).toContainText(
      "1 client runs a newer commit and will be moved back.",
    );
    await expect(dialog.locator(".plan-warnings")).toContainText(
      "1 client runs a commit that is not on this branch; it will be replaced.",
    );
    await expect(dialog).toContainText(
      "health check (if it fails, admin rolls back to the previous version when that one was healthy).",
    );
    await expect(dialog).toContainText(
      "Environment variables on Vercel are not changed.",
    );
    const submit = dialog.getByRole("button", {
      name: `Deploy to ${slugs.length} clients`,
      exact: true,
    });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel("Type deploy all to confirm").fill("deploy al");
    await expect(submit).toBeDisabled();
    await dialog.getByLabel("Type deploy all to confirm").fill("deploy all");
    await expect(submit).toBeEnabled();
    expect((await axe(page)).violations, "dialog accessibility").toEqual([]);
    // Cancelling the authenticator prompt leaves the dialog open.
    await submit.click();
    await expect(stepUpOf(page)).toBeVisible();
    await stepUpOf(page).getByRole("button", { name: "Close dialog" }).click();
    await expect(stepUpOf(page)).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(submit).toBeEnabled();
    // A client is locked meanwhile: the start is refused, the plan reloads.
    await control("lock?scenario=ready&on=1");
    await submit.click();
    await confirmStepUp(page);
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole("alert")).toContainText(
      "The list of clients changed. Preview again.",
    );
    await expect(excluded.locator('li[data-slug="ui-ready"]')).toContainText(
      "Deploys locked",
    );
    const final = slugs.filter((slug) => slug !== "ui-ready");
    await expect(panel.locator("tbody tr")).toHaveCount(final.length);
    expect(await slugsOf(page)).toEqual(final);
    await expect(panel.getByRole("alert")).toContainText(
      "The list of clients changed. Preview again.",
    );
    // Two prompts (the cancelled one and the confirmed one), then the refusal;
    // every request carries exactly the previewed plan.
    expect(starts).toHaveLength(3);
    for (const body of starts)
      expect(body).toEqual(startBody(starts[0].digest));
    expect(Object.keys(starts[0]).sort()).toEqual([
      "branch",
      "confirm",
      "digest",
      "sha",
    ]);
    // Again with the new list; the confirmation still counts (10 minutes).
    await panel
      .getByRole("button", { name: `Deploy to ${final.length} clients…` })
      .click();
    await expect(dialog).toContainText(
      `Deploys main@aaaaaaa to ${final.length} clients, one at a time, demo first.`,
    );
    await dialog.getByLabel("Type deploy all to confirm").fill("deploy all");
    await dialog
      .getByRole("button", {
        name: `Deploy to ${final.length} clients`,
        exact: true,
      })
      .click();
    // Running: every client waits its turn, in the plan's order.
    await expect(panel).toHaveAttribute("data-status", "running");
    expect(starts).toHaveLength(4);
    expect(starts[3]).toEqual(startBody());
    expect(starts[3].digest).not.toBe(starts[0].digest);
    await expect(stepUpOf(page)).toHaveCount(0);
    await expect(page.locator("#rollout-title")).toBeFocused();
    // The refusal belonged to the plan; the new state clears it.
    await expect(panel.locator(".error-box")).toHaveCount(0);
    await expect(panel).toContainText(
      `Deploying main@aaaaaaa to ${final.length} clients`,
    );
    await expect(panel).toContainText("Started by deploy owner x");
    await expect(statusOf(page)).toHaveText(`0 of ${final.length} done.`);
    expect(await slugsOf(page)).toEqual(final);
    await expect(
      panel.locator('tbody tr[data-target-status="pending"]'),
    ).toHaveCount(final.length);
    await expect(rowOf(page, "demo").locator(".badge")).toHaveText("Waiting");
    await expect(
      rowOf(page, "demo").getByRole("link", { name: "Open demo" }),
    ).toHaveAttribute(
      "href",
      "/installations/00000000-0000-4000-8000-d00000000030/deploy",
    );
    await expect(
      panel.getByRole("button", { name: "Choose a commit…" }),
    ).toHaveCount(0);
    // A worker that stops answering is called out, and the notice clears.
    await control("worker?state=offline");
    await expect(panel.locator(".rollout-live")).toHaveText(
      "Waiting for the deploy worker (offline).",
    );
    await control("worker?state=online");
    await expect(panel.locator(".rollout-live .notice")).toHaveCount(0);
    // The worker's progress shows on the next fast poll (3 s).
    const second = final[1];
    await control(`rollout?prebuild=${final[2]}:queued`);
    await control("rollout?target=demo&tstatus=building");
    await expect(rowOf(page, "demo")).toHaveAttribute(
      "data-target-status",
      "building",
    );
    await expect(rowOf(page, "demo").locator(".badge")).toHaveText("Building");
    await expect(rowOf(page, final[2])).toContainText("Build ready");
    await control("rollout?target=demo&tstatus=deploying");
    await expect(rowOf(page, "demo").locator(".badge")).toHaveText("Deploying");
    await control("rollout?target=demo&tstatus=succeeded");
    await control(`rollout?target=${second}&tstatus=building`);
    await expect(rowOf(page, "demo").locator(".badge")).toHaveText("Live");
    await expect(rowOf(page, second)).toHaveAttribute(
      "data-target-status",
      "building",
    );
    await expect(statusOf(page)).toHaveText(`1 of ${final.length} done.`);
    expect((await axe(page)).violations, "running accessibility").toEqual([]);
    await noOverflow(page, "running");
    expect(errors).toEqual([]);
  } finally {
    await control("freeze?on=0");
    await control("worker?state=online");
    await control("rollout?clear=1");
  }
});

test("a stopped rollout says why and how to go on, waits while frozen, resumes, and is dismissed after a confirmation", async ({
  browser,
  page,
}) => {
  test.setTimeout(240000);
  await control("reset?scenario=all");
  await control("worker?state=online");
  await control("freeze?on=0");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let admin = null;
  try {
    await ownerIn(page, "y");
    const slugs = await startRollout(page);
    const panel = panelOf(page),
      at = slugs[1],
      alert = panel.locator(".error-why[role=alert]"),
      resumeLine = `Then press Resume to retry ${at} first, or Dismiss to end the rollout.`;
    // A stopped rollout is read every 30 s: reload to see the next stop.
    const stopAt = async (code, extra = "") => {
      await control(`rollout?stop=${at}:${code}${extra}&status=stopped`);
      await page.reload();
      await expect(panel).toHaveAttribute("data-status", "stopped");
      await expect(alert).toHaveAttribute("data-code", code);
    };
    await control("rollout?target=demo&tstatus=succeeded");
    // A job failure whose next step does not mention Resume: the owner's line.
    await stopAt("build-failed");
    const why = describeCode("build-failed");
    await expect(alert).toContainText(`Stopped at ${at}: ${why.title}.`);
    await expect(alert).toContainText(why.plainMessage);
    await expect(alert).toContainText(`What to do: ${why.action}`);
    await expect(alert).toContainText(resumeLine);
    await expect(statusOf(page)).toHaveText(
      `Stopped: 1 updated, 1 failed, ${slugs.length - 2} skipped.`,
    );
    await expect(rowOf(page, at).locator(".badge")).toHaveText("Failed");
    await expect(rowOf(page, slugs[2])).toContainText("Not reached");
    expect((await axe(page)).violations, "stopped accessibility").toEqual([]);
    await noOverflow(page, "stopped");
    // The admin reads the same stop, without the owner's next step.
    admin = await adminOn(browser);
    const adminAlert = panelOf(admin.adminPage).locator(
      ".error-why[role=alert]",
    );
    await expect(adminAlert).toContainText(`Stopped at ${at}:`);
    await expect(adminAlert).toContainText("An owner can Resume or Dismiss.");
    await expect(adminAlert).not.toContainText("Then press Resume");
    await expect(panelOf(admin.adminPage).getByRole("button")).toHaveCount(0);
    await admin.context.close();
    admin = null;
    // A job's "deploy again" reads "press Resume" here; no second line.
    await stopAt("health-failed");
    const health = describeCode("health-failed");
    await expect(alert).toContainText(`Stopped at ${at}: ${health.title}.`);
    await expect(alert).toContainText(
      `What to do: ${health.action.replace(/deploy again/i, "press Resume")}`,
    );
    await expect(alert).toContainText("press Resume after fixing.");
    await expect(alert).not.toContainText(resumeLine);
    // A client that was not ready: what it needs, and the rollout's own step.
    await stopAt("target-not-ready", "&items=verified,host");
    await expect(alert).toContainText(`Stopped at ${at}: Client not ready.`);
    await expect(alert).toContainText(
      "Needs: Credentials verified, Web address.",
    );
    await expect(alert).toContainText(
      `What to do: ${describeCode("target-not-ready").action}`,
    );
    await expect(alert).not.toContainText(resumeLine);
    await expect(rowOf(page, at)).toContainText(
      "Client not ready: Credentials verified, Web address",
    );
    // Lost authority and a freeze skip the client; both say how to go on.
    await stopAt("not-authorized");
    await expect(alert).toContainText(`Stopped at ${at}: Access changed.`);
    await expect(alert).toContainText(
      `What to do: ${describeCode("not-authorized").action}`,
    );
    await expect(alert).not.toContainText(resumeLine);
    await expect(rowOf(page, at).locator(".badge")).toHaveText("Skipped");
    await stopAt("frozen");
    await expect(alert).toContainText(`Stopped at ${at}: Deploys frozen.`);
    await expect(alert).toContainText(
      "What to do: Ask the owner to unfreeze deploys, then press Resume.",
    );
    await expect(alert).not.toContainText("deploy again");
    await expect(alert).not.toContainText(resumeLine);
    await expect(rowOf(page, at).locator(".badge")).toHaveText("Skipped");
    // Frozen: Resume waits, and says why.
    await control("freeze?on=1&reason=Rollout check");
    await page.reload();
    const resume = panel.getByRole("button", { name: "Resume…" });
    await expect(resume).toBeDisabled();
    await expect(panel.locator("#why-rollout-resume")).toHaveText(
      "Deploys are frozen.",
    );
    await control("freeze?on=0");
    await page.reload();
    await expect(resume).toBeEnabled();
    await expect(panel.locator("#why-rollout-resume")).toHaveText(
      `Retries ${at} first, then continues.`,
    );
    await resume.click();
    await expect(modalOf(page)).toContainText(
      `It retries ${at} first, then continues with the clients not reached. A client that is locked when its turn comes is skipped.`,
    );
    const resumed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/pos/rollout/resume",
    );
    await modalOf(page)
      .getByRole("button", { name: "Resume", exact: true })
      .click();
    // The step-up from the start is still fresh (10 minutes).
    expect((await resumed).status()).toBe(200);
    await expect(panel).toHaveAttribute("data-status", "running");
    await expect(page.locator("#rollout-title")).toBeFocused();
    await expect(panel).toContainText("Resumed by deploy owner y");
    await expect(rowOf(page, at)).toHaveAttribute(
      "data-target-status",
      "pending",
    );
    await expect(rowOf(page, "demo")).toHaveAttribute(
      "data-target-status",
      "succeeded",
    );
    // Stops again; Dismiss asks first, since it can no longer be resumed.
    await control(`rollout?stop=${at}:health-failed&status=stopped`);
    await expect(panel).toHaveAttribute("data-status", "stopped");
    const dismiss = panel.getByRole("button", { name: "Dismiss…" });
    await dismiss.click();
    await expect(modalOf(page)).toContainText("Dismiss the stopped rollout?");
    await expect(modalOf(page)).toContainText(
      "It can no longer be resumed; clients not reached keep their current version.",
    );
    await modalOf(page).getByRole("button", { name: "Keep it" }).click();
    await expect(panel).toHaveAttribute("data-status", "stopped");
    await expect(dismiss).toBeFocused();
    await dismiss.click();
    await modalOf(page)
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(panel).toHaveAttribute("data-status", "idle");
    await expect(page.locator("#rollout-title")).toBeFocused();
    await expect(panel.locator("tbody tr")).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Choose a commit…" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    if (admin) await admin.context.close();
    await control("freeze?on=0");
    await control("rollout?clear=1");
  }
});

test("cancel stops after the current client, Dismiss waits for it, and the admin follows read-only", async ({
  browser,
  page,
}) => {
  test.setTimeout(240000);
  await control("reset?scenario=all");
  await control("worker?state=online");
  await control("freeze?on=0");
  let admin = null;
  try {
    await ownerIn(page, "z");
    const slugs = await startRollout(page);
    const panel = panelOf(page);
    // demo is uploading: its own deploy job runs.
    await control("rollout?target=demo&tstatus=deploying&job=1");
    await expect(rowOf(page, "demo").locator(".badge")).toHaveText("Deploying");
    // The admin sees the same rollout, without any action.
    admin = await adminOn(browser);
    const adminPanel = panelOf(admin.adminPage);
    await expect(adminPanel).toHaveAttribute("data-status", "running");
    await expect(adminPanel).toContainText(
      "Read-only: only the owner can start or change a rollout.",
    );
    await expect(adminPanel.getByRole("button")).toHaveCount(0);
    await expect(rowOf(admin.adminPage, "demo").locator(".badge")).toHaveText(
      "Deploying",
    );
    expect(
      (await axe(admin.adminPage)).violations,
      "admin running accessibility",
    ).toEqual([]);
    // The owner cancels.
    const cancelText =
      "Cancels the current client unless its upload already started; the rest are skipped.";
    await expect(panel.locator("#why-rollout-cancel")).toHaveText(cancelText);
    await panel.getByRole("button", { name: "Cancel rollout…" }).click();
    const modal = modalOf(page);
    await expect(modal).toContainText(cancelText);
    await modal
      .getByRole("button", { name: "Cancel rollout", exact: true })
      .click();
    await expect(panel).toHaveAttribute("data-status", "cancelling");
    await expect(panel).toContainText("Cancelling the rollout of main@aaaaaaa");
    await expect(statusOf(page)).toHaveText(
      "Cancelling… the current client finishes if its upload already started.",
    );
    await expect(
      panel.getByRole("button", { name: "Cancel rollout…" }),
    ).toHaveCount(0);
    await expect(page.locator("#rollout-title")).toBeFocused();
    await expect(adminPanel).toHaveAttribute("data-status", "cancelling");
    await expect(adminPanel.getByRole("button")).toHaveCount(0);
    // Dismiss is there while cancelling, but waits for demo's deploy.
    await expect(panel.locator("#why-rollout-dismiss")).toHaveText(
      "Possible once its current client’s deploy has ended; refused until then.",
    );
    await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
    const refused =
      "A client of this rollout is still deploying. Try again when it finishes.";
    await expect(panel.getByRole("alert")).toContainText(refused);
    await expect(panel).toHaveAttribute("data-status", "cancelling");
    // The refusal stays through the next polls (same state, 3 s apart).
    const polled = () =>
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/pos/rollout",
      );
    await polled();
    await polled();
    await expect(panel.getByRole("alert")).toContainText(refused);
    // The worker ends it: the current client finished, the rest skipped.
    await control("rollout?target=demo&tstatus=succeeded&status=cancelled");
    await expect(panel).toHaveAttribute("data-status", "cancelled");
    await expect(panel.locator(".error-box")).toHaveCount(0);
    await expect(statusOf(page)).toHaveText(
      `Cancelled: 1 updated, ${slugs.length - 1} skipped.`,
    );
    await expect(rowOf(page, slugs[1])).toContainText("Cancelled");
    expect((await axe(page)).violations, "cancelled accessibility").toEqual([]);
    await noOverflow(page, "cancelled");
    // Finished: Dismiss clears it at once.
    await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(panel).toHaveAttribute("data-status", "idle");
    await expect(page.locator("#rollout-title")).toBeFocused();
  } finally {
    if (admin) await admin.context.close();
    await control("rollout?clear=1");
  }
});

test("the admin can preview a commit but not start a rollout", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("reset?scenario=all");
  await control("worker?state=online");
  await control("freeze?on=0");
  await adminIn(page);
  await openFleet(page);
  const panel = panelOf(page);
  await expect(panel).toHaveAttribute("data-status", "idle");
  await previewMain(page);
  await expect(rowOf(page, "demo")).toBeVisible();
  await expect(panel.locator(".rollout-plan .plan-warnings")).toBeVisible();
  const start = panel.getByRole("button", { name: /^Deploy to \d+ clients…$/ });
  await expect(start).toBeDisabled();
  await expect(panel.locator("#why-rollout-start")).toHaveText(
    "Only the owner can start a rollout.",
  );
  // Closing the picker keeps focus on its button.
  const toggle = panel.locator('[data-rollout="choose"]');
  await toggle.click();
  await expect(toggle).toHaveText("Choose a commit…");
  await expect(toggle).toBeFocused();
  await expect(panel.locator("tbody tr")).toHaveCount(0);
  expect((await axe(page)).violations, "admin idle accessibility").toEqual([]);
});
