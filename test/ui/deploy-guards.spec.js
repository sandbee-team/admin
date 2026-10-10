import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
// Guard rails of the Deploy tab: freeze, plan warnings, the commit snapshot,
// stale-data banner and the stalled-job wording. Fixtures: test/ui-server.js.
const password = "Browser test passphrase 2026!";
const KEY = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
const N = { ready: 1, deploy: 2, stalled: 7, diverged: 10 };
const url = (name) =>
  `/installations/00000000-0000-4000-8000-d${String(N[name]).padStart(11, "0")}/deploy`;
const control = (path) =>
  fetch(`http://127.0.0.1:8109/pos/${path}`, { method: "POST" });
async function ownerIn(page, letter) {
  const who = `deploy-owner-${letter}@example.test`;
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
async function confirmStepUp(page) {
  const dialog = page
    .locator("dialog[open]")
    .filter({ hasText: "Confirm it’s you" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel("Authenticator code")
    .fill(codeAt(KEY, stepAt(Date.now()) + 1));
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
const dialog = (page) => page.locator("dialog[open]").last();
test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.11" } });

test("owner freezes and unfreezes all deploys", async ({ page }) => {
  test.setTimeout(90000);
  await control("reset?scenario=all");
  await ownerIn(page, "i");
  await page.goto(url("ready"));
  await expect(page.getByText("Not frozen", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Freeze deploys…" }).click();
  const modal = dialog(page);
  await expect(modal).toContainText("All deploys, redeploys and builds stop");
  await expect(modal).toContainText("until an owner unfreezes");
  await modal.getByLabel("Reason (optional)").fill("Provider incident");
  await modal
    .getByRole("button", { name: "Freeze deploys", exact: true })
    .click();
  await confirmStepUp(page);
  await expect(
    page
      .locator(".notice")
      .filter({ hasText: "Deploys are frozen for every client" })
      .first(),
  ).toBeVisible();
  await expect(page.getByText("Provider incident").first()).toBeVisible();
  await expect(page.getByText("Frozen", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Redeploy", exact: true }),
  ).toBeDisabled({ timeout: 20000 });
  await expect(page.locator("#why-redeploy")).toContainText("Not ready:");
  await page.getByRole("button", { name: "Unfreeze deploys…" }).first().click();
  await dialog(page)
    .getByRole("button", { name: "Unfreeze deploys", exact: true })
    .click();
  await expect(page.getByText("Not frozen", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Redeploy", exact: true }),
  ).toBeEnabled({ timeout: 20000 });
});

test("the confirm dialog repeats warnings and keeps the commit it opened with", async ({
  page,
}) => {
  test.setTimeout(90000);
  await control("reset?scenario=all");
  await ownerIn(page, "j");
  await page.goto(url("diverged"));
  await page.locator(".branch-option").filter({ hasText: "main" }).click();
  await expect(page.locator(".plan-summary")).toContainText("diverged");
  await page.getByRole("button", { name: "Deploy main" }).click();
  const warnings = dialog(page).getByRole("list", { name: "Warnings" });
  await expect(warnings).toContainText("different history");
  await expect(warnings).toContainText("Settings changed since the live build");
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  // The branch moves between plan and submit: nothing is sent.
  let posted = 0;
  await page.route("**/pos/deploys", (route) => {
    if (route.request().method() === "POST") posted++;
    return route.continue();
  });
  await page.route("**/deploy-plan?*", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      json: { ...body, head: { ...body.head, sha: "c".repeat(40) } },
    });
  });
  await page.getByRole("button", { name: "Deploy main" }).click();
  await expect(dialog(page)).toContainText("main@aaaaaaa");
  await dialog(page)
    .getByLabel("Type ui-diverged to confirm")
    .fill("ui-diverged");
  await dialog(page)
    .getByRole("button", { name: "Deploy", exact: true })
    .click();
  await expect(dialog(page)).toContainText("The branch moved — review again.");
  expect(posted).toBe(0);
  // Unchanged plan: the request carries the commit the dialog showed.
  await page.unroute("**/deploy-plan?*");
  let sent = null;
  await page.route("**/pos/deploys", (route) => {
    if (route.request().method() === "POST")
      sent = route.request().postDataJSON();
    return route.continue();
  });
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  // Reload: the page re-read the (mocked) plan after the refusal.
  await page.reload();
  await page.locator(".branch-option").filter({ hasText: "main" }).click();
  await expect(page.locator(".plan-summary")).toContainText("main@aaaaaaa");
  await page.getByRole("button", { name: "Deploy main" }).click();
  await dialog(page)
    .getByLabel("Type ui-diverged to confirm")
    .fill("ui-diverged");
  await dialog(page)
    .getByRole("button", { name: "Deploy", exact: true })
    .click();
  await confirmStepUp(page);
  await expect(page.getByText("Deploy queued.")).toBeVisible();
  expect(sent).toMatchObject({
    kind: "deploy",
    branch: "main",
    sha: "a".repeat(40),
  });
});

test("a failing poll shows a stale banner that clears; a stalled job names the offline worker", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("reset?scenario=all");
  await ownerIn(page, "k");
  await page.goto(url("ready"));
  await expect(
    page.getByRole("region", { name: "Live version" }),
  ).toBeVisible();
  await control("fail?match=/pos/d");
  try {
    const banner = page.locator(".stale-banner");
    await expect(banner.first()).toContainText(
      /Last updated \d\d:\d\d:\d\d — retrying…/,
      { timeout: 30000 },
    );
    // The Deploy tab and the backup panel each say so.
    await expect(banner).toHaveCount(2);
  } finally {
    await control("fail?match=");
  }
  await expect(page.locator(".stale-banner")).toHaveCount(0, {
    timeout: 30000,
  });
  await page.goto(url("stalled"));
  await expect(page.locator(".progress-status")).toHaveText(
    "Worker restarted — resuming.",
  );
  await control("worker?state=offline");
  try {
    await expect(page.locator(".progress-status")).toHaveText(
      "The deploy worker is offline — the job will resume when it is back.",
      { timeout: 20000 },
    );
  } finally {
    await control("worker?state=online");
  }
});
