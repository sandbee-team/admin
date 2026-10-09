import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";

const password = "Browser test passphrase 2026!";
const CLIENT = "test/fixtures/pos-client.json";
const PROFILES = "test/fixtures/pos-profiles.json";
const fixture = JSON.parse(readFileSync(CLIENT, "utf8"));
// Every secret in the fixture; none may ever appear in the page.
const SECRETS = [
  fixture.vercel.token,
  fixture.cloudflare.token,
  fixture.cloudflare.publishSecret,
  fixture.mongodbUri,
  "test-mongo-pw-GGGG4444",
  fixture.admin.password,
  fixture.image.accessKeyId,
  fixture.image.secretAccessKey,
  fixture.accounts.vercel.password,
  fixture.accounts.atlas.password,
  fixture.accounts.images.password,
  "test-other-login-TTTT1212",
  fixture.generated.authSecret,
  fixture.generated.healthStatsToken,
  "test-notes-password-UUUU1313",
];
const axe = (page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
async function signIn(page, who) {
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
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
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
async function noSecretsInPage(page, label) {
  const html = await page.content();
  for (const value of SECRETS)
    expect(html.includes(value), `${label} shows a secret`).toBe(false);
}

test("owner imports a go-live file with a masked preview", async ({ page }) => {
  test.setTimeout(90000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, "import-owner@example.test");
  await page.goto("/customers");
  await page.getByRole("link", { name: "Import from go-live file" }).click();
  await expect(
    page.getByRole("heading", { name: "POS import", exact: true }),
  ).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await noOverflow(page, "import page");

  // A bad file is reported locally before anything is sent.
  await page.getByLabel("Go-live client file (JSON)").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("{nope"),
  });
  await expect(page.getByRole("alert")).toContainText("not valid JSON");

  await page.getByLabel("Go-live client file (JSON)").setInputFiles(CLIENT);
  await page
    .getByLabel("Deploy profiles file (optional)")
    .setInputFiles(PROFILES);
  await page
    .getByRole("combobox", { name: "Profile entry", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: "fixture-cafe-env" }),
  ).toBeVisible();
  await page.getByRole("option", { name: "fixture-cafe", exact: true }).click();
  await page.getByRole("button", { name: "Preview import" }).click();

  await expect(page.getByRole("heading", { name: "2. Preview" })).toBeVisible();
  const preview = page.getByRole("region", { name: "2. Preview" });
  await expect(
    preview.getByText("cluster0.fixture.example.test / fixture_pos"),
  ).toBeVisible();
  await expect(
    preview.getByRole("row", { name: /Vercel token Present/ }),
  ).toBeVisible();
  await expect(preview.getByText("notes", { exact: true })).toBeVisible();
  await expect(preview.getByText(/deployLock/)).toBeVisible();
  await noSecretsInPage(page, "preview");
  expect((await axe(page)).violations).toEqual([]);
  await noOverflow(page, "import preview");

  // Email is required for a new customer.
  const confirm = page.getByRole("button", { name: "Import and encrypt" });
  await expect(confirm).toBeDisabled();
  await page
    .getByLabel("Email (required)")
    .fill("import-customer@example.test");
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByText("Imported.")).toBeVisible();
  await noSecretsInPage(page, "after import");
  // Inputs were cleared from the page.
  await expect(
    page.getByRole("button", { name: "Preview import" }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Open the customer workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Fiona Fixture" }).first(),
  ).toBeVisible();

  await page
    .getByRole("navigation", { name: "Customer navigation" })
    .getByRole("link", { name: "Accounts", exact: true })
    .click();
  for (const label of [
    "Vercel account",
    "MongoDB Atlas account",
    "Image storage account",
    "Other logins (imported)",
  ])
    await expect(
      page.getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
  await noSecretsInPage(page, "accounts");

  await page
    .getByRole("navigation", { name: "Customer navigation" })
    .getByRole("link", { name: "Installations", exact: true })
    .click();
  await page.getByRole("link", { name: "Fixture Cafe POS" }).click();
  await page
    .getByRole("navigation", { name: "Installation navigation" })
    .getByRole("link", { name: "POS setup", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Secrets", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Set", { exact: true })).toHaveCount(8);
  await noSecretsInPage(page, "POS setup");
  expect(errors).toEqual([]);
});

test("a non-owner role never sees the import page", async ({ page }) => {
  await signIn(page, "client-admin@example.test");
  await expect(page.getByRole("link", { name: "POS import" })).toHaveCount(0);
  await page.goto("/pos-import");
  await expect(page.getByText("This page is not available")).toBeVisible();
});

test("pagehide clears the file contents and the preview", async ({ page }) => {
  await signIn(page, "import-owner@example.test");
  await page.goto("/pos-import");
  await page.getByLabel("Go-live client file (JSON)").setInputFiles(CLIENT);
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByRole("heading", { name: "2. Preview" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(page.getByRole("heading", { name: "2. Preview" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Preview import" }),
  ).toBeDisabled();
});
