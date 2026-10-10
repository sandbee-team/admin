import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
import { describeCode } from "../../shared/deploy-errors.js";
// Fixtures: test/ui-server.js (seedPos). No worker runs; the control port
// writes the task state a worker would have written.
const password = "Browser test passphrase 2026!";
const KEY = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
const N = {
  failed: 6,
  backup: 12,
  backuprun: 13,
  backupdone: 14,
  backupbig: 15,
};
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
const backupButton = (page) =>
  page.getByRole("button", { name: "Back up database now" });
test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.10" } });

test("error panel uses the shared code table; versions show commit info; backup happy path", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("reset?scenario=all");
  await ownerIn(page, "g");
  // The failed job's code comes from the shared table, not from the page.
  await page.goto(url("failed"));
  const entry = describeCode("build-failed");
  const panel = page.locator(".deploy-error");
  await expect(panel).toContainText(entry.title);
  await expect(panel).toContainText(entry.plainMessage);
  await expect(panel).toContainText(`What to do: ${entry.action}`);
  // Version cards: headline and author.
  const live = page.getByRole("region", { name: "Live version" });
  await expect(live).toContainText("Add table QR codes");
  await expect(live).toContainText("Dev");
  // Backup: confirm text, step-up, queued, then the worker finishes.
  await page.goto(url("backup"));
  await expect(backupButton(page)).toBeEnabled();
  expect((await axe(page)).violations, "backup panel accessibility").toEqual(
    [],
  );
  await noOverflow(page, "backup panel");
  await backupButton(page).click();
  const modal = page.locator("dialog[open]").last();
  await expect(modal).toContainText("20 MB");
  await expect(modal).toContainText("about a minute");
  await expect(modal).toContainText("not automatic");
  await modal.getByRole("button", { name: "Back up now" }).click();
  const stepUp = page
    .locator("dialog[open]")
    .filter({ hasText: "Confirm it’s you" });
  await stepUp
    .getByLabel("Authenticator code")
    .fill(codeAt(KEY, stepAt(Date.now()) + 1));
  await stepUp.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Backup queued.")).toBeVisible();
  await expect(backupButton(page)).toBeDisabled();
  await expect(page.locator("#why-backup")).toContainText("already running");
  await control("task?scenario=backup&status=succeeded");
  const link = page.getByRole("link", { name: /Open the file in Files/ });
  await expect(link).toBeVisible({ timeout: 20000 });
  await expect(link).toHaveAttribute(
    "href",
    "/customers/00000000-0000-4000-8000-e00000000012/files",
  );
  // The customer's Files tab points back to the button.
  await link.click();
  await expect(
    page.getByRole("link", { name: "ui-backup", exact: true }),
  ).toBeVisible();
});

test("a running and a too-large backup read honestly", async ({ page }) => {
  test.setTimeout(90000);
  await control("reset?scenario=all");
  await ownerIn(page, "h");
  await page.goto(url("backuprun"));
  await expect(page.getByText(/Backing up… 4 collections/)).toBeVisible();
  await expect(backupButton(page)).toBeDisabled();
  await page.goto(url("backupbig"));
  const why = page.locator(".backup-panel .error-why");
  const entry = describeCode("backup-too-large");
  await expect(why).toContainText(entry.title);
  await expect(why).toContainText(entry.plainMessage);
  await expect(why).toContainText("mongodump");
  expect((await axe(page)).violations, "too-large accessibility").toEqual([]);
  await noOverflow(page, "too-large backup");
  await page.goto(url("backupdone"));
  await expect(page.getByText(/6 collections, 4200 documents/)).toBeVisible();
});

test("an admin cannot back up and a viewer cannot open the page", async ({
  page,
}) => {
  test.setTimeout(60000);
  await emailStep(page, "deploy-admin@example.test");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
    timeout: 20000,
  });
  await page.goto(url("backup"));
  await expect(backupButton(page)).toBeDisabled();
  await expect(page.locator("#why-backup")).toHaveText(
    "Only the owner can back up a client database.",
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  await emailStep(page, "viewer@example.test");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
    timeout: 20000,
  });
  await page.goto(url("backup"));
  await expect(backupButton(page)).toHaveCount(0);
});
