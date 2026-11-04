import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
import { describeCode } from "../../shared/deploy-errors.js";
// "Copy data from the demo" (D58). Fixtures: test/ui-server.js (scenario
// `copy`). No worker runs; the control port writes the task state a worker
// would have written (copyTask).
const password = "Browser test passphrase 2026!";
const KEY = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
const URL = "/installations/00000000-0000-4000-8000-d00000000040/deploy";
const OLD = "mongodb+srv://demo:OldPass91x@cluster0.abcd1.mongodb.net/demo";
const axe = (page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
const control = (path) =>
  fetch(`http://127.0.0.1:8109/pos/${path}`, { method: "POST" });
async function ownerIn(page) {
  await page.goto("/");
  await page.getByLabel("Work email").fill("deploy-owner-copy@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
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
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.40" } });

test("copy data from the demo: save the old database, check, copy; blocked and failed runs", async ({
  page,
}) => {
  test.setTimeout(150000);
  await control("reset?scenario=copy");
  await ownerIn(page);
  await page.goto(URL);
  const panel = page.getByRole("region", { name: "Copy data from the demo" });
  const check = panel.getByRole("button", { name: "Check", exact: true });
  const copy = panel.getByRole("button", { name: "Copy", exact: true });
  await expect(check).toBeDisabled();
  await expect(panel).toContainText("Save the old database first.");

  // The old database: saved encrypted, shown as host / database only.
  await panel.getByRole("textbox", { name: "Old database" }).fill(OLD);
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  const stepUp = page
    .locator("dialog[open]")
    .filter({ hasText: "Confirm it’s you" });
  await stepUp
    .getByLabel("Authenticator code")
    .fill(codeAt(KEY, stepAt(Date.now()) + 1));
  await stepUp.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    panel.getByText("cluster0.abcd1.mongodb.net / demo"),
  ).toBeVisible();
  expect(await page.content()).not.toContain("OldPass91x");
  await expect(panel).toContainText("Pick the From date.");

  // Check: the panel asks the worker, then shows counts and short notes.
  await panel.getByLabel("From date").fill("2026-10-01");
  await panel.getByRole("checkbox", { name: "Staff logins" }).uncheck();
  await expect(copy).toBeDisabled();
  await expect(panel).toContainText("Press Check to see what will be copied.");
  await check.click();
  await expect(panel.getByText("Waiting for the worker…")).toBeVisible();
  await control("task?scenario=copy&kind=data-copy&status=succeeded");
  await expect(panel.getByText("Ready to copy.")).toBeVisible({
    timeout: 20000,
  });
  await expect(
    panel.locator(".copy-group", { hasText: "Bills" }),
  ).toContainText("1,240");
  await expect(
    panel.locator(".copy-group", { hasText: "Bill & print settings" }),
  ).toContainText("✓");
  await expect(
    panel.locator(".copy-group", { hasText: "Staff logins" }),
  ).not.toContainText("3");
  await expect(panel).toContainText(
    "Telegram: connect it again in the new POS.",
  );
  await expect(panel).toContainText("3 customers are older than the date");
  await expect(panel).toContainText("Not copied: dailyRollup (12).");
  await expect(copy).toBeEnabled();
  expect((await axe(page)).violations, "copy panel accessibility").toEqual([]);
  await noOverflow(page, "copy panel");

  // Another date hides the counts until the next Check.
  await panel.getByLabel("From date").fill("2026-10-02");
  await expect(copy).toBeDisabled();
  await expect(panel.getByText("Ready to copy.")).toHaveCount(0);
  await panel.getByLabel("From date").fill("2026-10-01");
  await expect(copy).toBeEnabled();

  // Another old database: the Check of the first one no longer counts.
  await panel.getByRole("button", { name: "Replace", exact: true }).click();
  await panel
    .getByRole("textbox", { name: "Old database" })
    .fill(OLD.replace("cluster0.abcd1", "cluster1.wxyz9"));
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    panel.getByText("cluster1.wxyz9.mongodb.net / demo"),
  ).toBeVisible();
  await expect(panel.getByText("Ready to copy.")).toHaveCount(0);
  await expect(copy).toBeDisabled();
  await check.click();
  // The new run must exist before the "worker" finishes it.
  await expect(panel.getByText("Waiting for the worker…")).toBeVisible();
  await control("task?scenario=copy&kind=data-copy&status=succeeded");
  await expect(panel.getByText("Ready to copy.")).toBeVisible({
    timeout: 20000,
  });

  // Copy: confirm, queued, progress, done.
  await copy.click();
  const modal = page.locator("dialog[open]").last();
  await expect(modal).toContainText("from 2026-10-01");
  await expect(modal).toContainText("The demo is not changed");
  await modal.getByRole("button", { name: "Copy now" }).click();
  await expect(panel.getByText("Waiting for the worker…")).toBeVisible();
  await expect(check).toBeDisabled();
  await control("task?scenario=copy&kind=data-copy&status=running&mode=copy");
  await expect(panel).toContainText("Copying Bills… 640 records so far.", {
    timeout: 20000,
  });
  await control("task?scenario=copy&kind=data-copy&status=succeeded&mode=copy");
  await expect(panel).toContainText("Copied 1,600 records", { timeout: 20000 });
  await expect(panel).toContainText("Open the new POS and check it.");

  // A Check that finds the new POS in use blocks Copy and says why.
  await control(
    "task?scenario=copy&kind=data-copy&status=succeeded&mode=check&blocked=1",
  );
  await expect(panel).toContainText(
    "Copy blocked: the new POS is already in use.",
    { timeout: 20000 },
  );
  await expect(panel).toContainText(
    "New or changed there: 2 bills, 1 customers",
  );
  await expect(copy).toBeDisabled();

  // Staff logins before go-live: the Check says what to do first.
  await control(
    "task?scenario=copy&kind=data-copy&status=succeeded&mode=check&needs=admin",
  );
  await expect(panel).toContainText("Go live first:", { timeout: 20000 });
  await expect(panel.getByText("Ready to copy.")).toHaveCount(0);
  await expect(copy).toBeDisabled();

  // A failed run reads from the shared code table.
  await control(
    "task?scenario=copy&kind=data-copy&status=failed&code=copy-source-unreachable",
  );
  const entry = describeCode("copy-source-unreachable");
  const why = panel.locator(".error-why");
  await expect(why).toContainText(entry.title, { timeout: 20000 });
  await expect(why).toContainText(`What to do: ${entry.action}`);
  expect((await axe(page)).violations, "failed copy accessibility").toEqual([]);
});
