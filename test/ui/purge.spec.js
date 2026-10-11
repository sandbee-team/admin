import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
import { describeCode } from "../../shared/deploy-errors.js";
// "Old source deployments" panel on the Deploy tab. Fixtures: test/ui-server.js
// (seedPos, purgeTask). No worker runs; the control port writes the task slot a
// worker would have written.
const password = "Browser test passphrase 2026!";
const KEY = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
const N = { purge: 26, purgebig: 27, purgenocut: 28, purgelocked: 29 };
const iid = (name) =>
  `00000000-0000-4000-8000-d${String(N[name]).padStart(11, "0")}`;
const url = (name) => `/installations/${iid(name)}/deploy`;
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
    // .panel clips its content, so check the panel itself too.
    expect(
      await page
        .locator("section.purge-panel")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
      `${label} panel overflows at ${width}`,
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
}
const panelOf = (page) => page.locator("section.purge-panel");
const previewButton = (page) =>
  panelOf(page).getByRole("button", {
    name: /^Preview (old deployments|again)$/,
  });
const removeButton = (page) =>
  panelOf(page).getByRole("button", { name: /^Remove \d+ old deployments?…$/ });
const statusOf = (page) => panelOf(page).locator(".purge-status");
const finishPreview = (name, extra = "") =>
  control(
    `task?scenario=${name}&kind=purge-preview&status=succeeded&keep=5${extra}`,
  );
test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.14" } });

test("purge panel: guards, a long list at every width, the other outcomes and the 30-minute timer", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("reset?scenario=all");
  // Time flows normally until the timer check at the end fast-forwards it.
  await page.clock.install();
  await ownerIn(page, "u");
  await page.goto(url("purgenocut"));
  await expect(panelOf(page)).toContainText(
    "Available after the first verified admin deploy.",
  );
  await expect(previewButton(page)).toHaveCount(0);
  await page.goto(url("purgelocked"));
  await expect(previewButton(page)).toBeDisabled();
  await expect(page.locator("#why-purge-preview")).toHaveText(
    "Not ready: Deploy lock.",
  );
  // A backup holds the one task slot.
  await control("task?scenario=purge&status=running");
  await page.goto(url("purge"));
  await expect(previewButton(page)).toBeDisabled();
  await expect(page.locator("#why-purge-preview")).toHaveText(
    "Another task (verify or backup) is running for this client.",
  );
  // 340 found, 200 shown: the list scrolls inside its own box.
  await finishPreview("purgebig", "&candidates=200&total=340");
  await page.goto(url("purgebig"));
  const panel = panelOf(page);
  await expect(panel).toContainText(
    "340 old source deployments found, 5 kept.",
  );
  await expect(panel).toContainText("Showing 200 of 340.");
  await expect(panel.locator("tbody tr")).toHaveCount(200);
  await expect(removeButton(page)).toHaveText("Remove 200 old deployments…");
  await expect(removeButton(page)).toBeEnabled();
  await noOverflow(page, "purge list");
  expect((await axe(page)).violations, "purge list accessibility").toEqual([]);
  await control("reset?scenario=purgebig");
  // Nothing found: no Remove, preview again.
  await finishPreview("purge", "&candidates=0&total=0");
  await page.goto(url("purge"));
  await expect(panel).toContainText("No old source deployments found, 5 kept.");
  await expect(removeButton(page)).toHaveCount(0);
  await expect(previewButton(page)).toHaveText("Preview again");
  await expect(previewButton(page)).toBeEnabled();
  // A failed preview explains itself from the shared table.
  await control("task?scenario=purge&kind=purge-preview&status=failed");
  await page.goto(url("purge"));
  await expect(panel.locator(".error-why")).toContainText(
    `Preview failed. ${describeCode("failed").plainMessage}`,
  );
  // A task the worker never picked up.
  await control("task?scenario=purge&kind=purge&status=expired");
  await page.goto(url("purge"));
  await expect(statusOf(page)).toHaveText(
    "The worker did not finish this step. Try again.",
  );
  // Some ids were no longer candidates when the removal ran.
  await control(
    "task?scenario=purge&kind=purge&status=succeeded&deleted=2&skipped=1",
  );
  await page.goto(url("purge"));
  await expect(statusOf(page)).toHaveText(
    "Removed 2 old deployments. 1 skipped (no longer on the list when the removal ran). Preview again to check for more.",
  );
  // The browser's own timer ends the 30 minutes without a reload, even with
  // the dialog open.
  await finishPreview("purge", "&candidates=2");
  await page.goto(url("purge"));
  await removeButton(page).click();
  const dialog = page.locator("dialog[open]").filter({
    hasText: "Remove 2 old deployments?",
  });
  const submit = dialog.getByRole("button", {
    name: "Remove 2 old deployments",
    exact: true,
  });
  await dialog.getByLabel("Type ui-purge to confirm").fill("ui-purge");
  await expect(submit).toBeEnabled();
  // Only the panel's own timer may re-render now: the state poll never answers.
  await page.route("**/pos/deploys", () => {});
  await page.clock.fastForward("30:01");
  await expect(dialog).toContainText(
    "This preview is now older than 30 minutes.",
  );
  await expect(submit).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(removeButton(page)).toHaveCount(0);
  await expect(statusOf(page)).toHaveText(
    "This preview is older than 30 minutes. Preview again before removing anything.",
  );
  // The opener is gone, so focus lands on the panel heading.
  await expect(
    page.getByRole("heading", { name: "Old source deployments" }),
  ).toBeFocused();
  await page.unroute("**/pos/deploys");
  await control("reset?scenario=purge");
});

test("purge panel: preview, typed slug and step-up, then the removal's progress and result", async ({
  page,
}) => {
  test.setTimeout(90000);
  await control("reset?scenario=purge");
  await ownerIn(page, "v");
  await page.goto(url("purge"));
  const panel = panelOf(page);
  await expect(panel).toContainText("every prebuilt deployment");
  await expect(previewButton(page)).toHaveText("Preview old deployments");
  await previewButton(page).click();
  await expect(statusOf(page)).toHaveText(
    "Preview queued. Waiting for the worker.",
  );
  await control("task?scenario=purge&kind=purge-preview&status=running");
  await expect(statusOf(page)).toHaveText(
    "Listing this client’s Vercel deployments…",
  );
  await expect(previewButton(page)).toBeDisabled();
  await finishPreview("purge", "&candidates=3");
  await expect(panel).toContainText("3 old source deployments found, 5 kept.");
  const rows = panel.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("dpl_00000001…");
  await expect(rows.first()).toContainText("Production");
  await expect(rows.nth(1)).toContainText("Preview");
  await expect(panel).toContainText("Use this preview before");
  expect((await axe(page)).violations, "preview accessibility").toEqual([]);
  const sent = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/pos\/purge$/.test(request.url()))
      sent.push(request.postDataJSON());
  });
  await removeButton(page).click();
  const dialog = page.locator("dialog[open]").filter({
    hasText: "Remove 3 old deployments?",
  });
  await expect(dialog).toBeVisible();
  const submit = dialog.getByRole("button", {
    name: "Remove 3 old deployments",
    exact: true,
  });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("Type ui-purge to confirm").fill("ui-purg");
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("Type ui-purge to confirm").fill("ui-purge");
  expect((await axe(page)).violations, "confirm accessibility").toEqual([]);
  await submit.click();
  await confirmStepUp(page);
  await expect(dialog).toHaveCount(0);
  await expect(statusOf(page)).toHaveText(
    "Removal queued. Waiting for the worker.",
  );
  // Exactly what was on screen: the preview id, its digest and the slug.
  expect(sent.length).toBeGreaterThan(0);
  for (const body of sent) {
    expect(Object.keys(body).sort()).toEqual([
      "confirm",
      "digest",
      "previewTaskId",
    ]);
    expect(body.confirm).toBe("ui-purge");
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.previewTaskId).toMatch(/^[0-9a-f-]{36}$/);
  }
  await control("task?scenario=purge&kind=purge&status=running&done=1&total=3");
  await expect(statusOf(page)).toHaveText(
    "Removing old deployments… 1 of 3 done.",
  );
  await control("task?scenario=purge&kind=purge&status=succeeded&deleted=3");
  await expect(statusOf(page)).toHaveText(
    "Removed 3 old deployments. Preview again to check for more.",
  );
  await expect(previewButton(page)).toHaveText("Preview again");
  await expect(previewButton(page)).toBeEnabled();
  await expect(removeButton(page)).toHaveCount(0);
  await control("reset?scenario=purge");
});

test("purge panel: an expired preview, a refused removal and a failed removal", async ({
  page,
}) => {
  test.setTimeout(90000);
  await control("reset?scenario=purge");
  await ownerIn(page, "w");
  await finishPreview("purge", "&candidates=2");
  await page.goto(url("purge"));
  await expect(removeButton(page)).toHaveText("Remove 2 old deployments…");
  await removeButton(page).click();
  const dialog = page.locator("dialog[open]").filter({
    hasText: "Remove 2 old deployments?",
  });
  // The preview ages past 30 minutes on the server while the dialog is open.
  await finishPreview("purge", "&candidates=2&ageMin=31");
  await dialog.getByLabel("Type ui-purge to confirm").fill("ui-purge");
  await dialog
    .getByRole("button", { name: "Remove 2 old deployments", exact: true })
    .click();
  await confirmStepUp(page);
  await expect(dialog).toHaveCount(0);
  const panel = panelOf(page);
  await expect(panel.locator(".error-box")).toContainText(
    "The purge preview is older than 30 minutes. Run it again.",
  );
  await expect(panel).toContainText("This preview is older than 30 minutes.");
  await expect(removeButton(page)).toHaveCount(0);
  await expect(previewButton(page)).toHaveText("Preview again");
  await expect(previewButton(page)).toBeEnabled();
  // Some deletions failed: the shared code table explains it.
  await control(
    "task?scenario=purge&kind=purge&status=failed&code=delete-failed&deleted=2&failed=1",
  );
  await page.goto(url("purge"));
  const entry = describeCode("delete-failed");
  const why = panel.locator(".error-why");
  await expect(why).toHaveAttribute("data-code", "delete-failed");
  await expect(why).toContainText(`Removal failed. ${entry.plainMessage}`);
  await expect(why).toContainText(
    "2 removed, 0 skipped, 1 could not be removed.",
  );
  await expect(why).toContainText(`What to do: ${entry.action}`);
  expect((await axe(page)).violations, "failed accessibility").toEqual([]);
  await control("reset?scenario=purge");
});

test("purge panel: an admin sees the preview but cannot run anything", async ({
  page,
}) => {
  test.setTimeout(60000);
  await control("reset?scenario=purge");
  await finishPreview("purge", "&candidates=3");
  await emailStep(page, "deploy-admin@example.test");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
    timeout: 20000,
  });
  await page.goto(url("purge"));
  await expect(panelOf(page).locator("tbody tr")).toHaveCount(3);
  await expect(removeButton(page)).toBeDisabled();
  await expect(previewButton(page)).toBeDisabled();
  await expect(page.locator("#why-purge-remove")).toHaveText(
    "Only the owner can remove old deployments.",
  );
  await expect(page.locator("#why-purge-preview")).toHaveText(
    "Only the owner can remove old deployments.",
  );
  await control("reset?scenario=purge");
});
