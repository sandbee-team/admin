import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
const CUSTOMER = "/customers/00000000-0000-4000-8000-0000000000c1";
const INSTALLATION = "/installations/00000000-0000-4000-8000-0000000000a1";
const password = "Browser test passphrase 2026!";
const ACCOUNT_KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SECRET_PASSWORD = "Sh0p-Gmail pass!";
const axe = (page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
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
async function signIn(page, who) {
  await emailStep(page, who);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}
// Codes one step ahead of the last accepted one are valid (+/-1 window) and
// never a replay.
const nextCode = (key) => codeAt(key, stepAt(Date.now()) + 1);
const liveCodes = (key) => {
  const step = stepAt(Date.now());
  return [step - 1, step, step + 1].map((n) => codeAt(key, n));
};
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
async function section(page, name, nav = "Customer navigation") {
  await page
    .getByRole("navigation", { name: nav })
    .getByRole("link", { name, exact: true })
    .click();
}
test.describe.configure({ mode: "serial" });
test.use({
  permissions: ["clipboard-read", "clipboard-write"],
  extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.2" },
});
test("owner keeps accounts, files and POS setup; secrets show only briefly", async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const who = "client-owner@example.test";
  // Enrol an authenticator, then sign in again with a backup code so the new
  // session has no step-up yet (the enrolment session is stepped up).
  await signIn(page, who);
  await page.goto("/account");
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  const ownerKey = base32Decode(
    (await page.locator(".setup-key").innerText()).replaceAll(" ", ""),
  );
  await page
    .getByLabel("6-digit code from your app")
    .fill(codeAt(ownerKey, stepAt(Date.now())));
  await page
    .getByRole("button", { name: "Turn on authenticator", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your backup codes" }),
  ).toBeVisible();
  const backup = await page.locator(".backup-codes li").allInnerTexts();
  await page
    .getByRole("checkbox", { name: "I saved these backup codes" })
    .check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await emailStep(page, who);
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByLabel("Backup code").fill(backup[0]);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  // ---- Accounts ----
  await page.clock.install();
  await page.goto(`${CUSTOMER}/accounts`);
  await expect(
    page.getByRole("heading", { name: "Accounts", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No accounts recorded")).toBeVisible();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Label", { exact: true }).fill("Shop Gmail");
  await dialog.getByLabel("Login", { exact: true }).fill("shop@example.test");
  await dialog
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Shop Gmail", exact: true }),
  ).toBeVisible();
  // The list shows flags only.
  await expect(page.getByText("Not set", { exact: true })).toHaveCount(3);
  const setSecret = async (button, label, value) => {
    await page.getByRole("button", { name: button, exact: true }).click();
    await dialog.getByLabel(label, { exact: true }).fill(value);
    await dialog.getByRole("button", { name: /^Save encrypted/ }).click();
    await expect(dialog).toHaveCount(0);
  };
  await setSecret(
    "Set password for Shop Gmail",
    "New password",
    SECRET_PASSWORD,
  );
  await setSecret(
    "Set authenticator key for Shop Gmail",
    "Authenticator key",
    ACCOUNT_KEY,
  );
  await setSecret(
    "Set backup codes for Shop Gmail",
    "Backup codes",
    "AAAA-1111\nBBBB-2222\nCCCC-3333\n",
  );
  await expect(page.getByText("3 of 3 left")).toBeVisible();
  expect(await page.content()).not.toContain(SECRET_PASSWORD);
  // Reveal goes through the step-up modal and hides by itself.
  await page
    .getByRole("button", {
      name: "Reveal password for Shop Gmail",
      exact: true,
    })
    .click();
  const confirm = page.getByRole("dialog");
  await expect(
    confirm.getByRole("heading", { name: "Confirm it’s you" }),
  ).toBeVisible();
  await confirm.getByLabel("Authenticator code").fill(nextCode(ownerKey));
  await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  const shown = page.getByRole("group", {
    name: "password for Shop Gmail",
  });
  await expect(shown.locator(".secret-value")).toHaveText(SECRET_PASSWORD);
  await expect(shown.getByText(/Hides in \d+ s/)).toBeVisible();
  await page.clock.fastForward(31000);
  await expect(page.locator(".secret-value")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Reveal password for Shop Gmail",
      exact: true,
    }),
  ).toBeVisible();
  // The value is not kept in storage or the address bar.
  expect(
    await page.evaluate(
      (value) =>
        JSON.stringify([
          { ...localStorage },
          { ...sessionStorage },
          location.href,
        ]).includes(value),
      SECRET_PASSWORD,
    ),
  ).toBe(false);
  // Show code: a 6-digit authenticator code for the stored key.
  await page
    .getByRole("button", { name: "Show code for Shop Gmail", exact: true })
    .click();
  const codeBox = page.getByRole("group", {
    name: "authenticator code for Shop Gmail",
  });
  const code = await codeBox.locator(".secret-value").innerText();
  expect(code).toMatch(/^\d{6}$/);
  expect(liveCodes(base32Decode(ACCOUNT_KEY))).toContain(code);
  await expect(codeBox.getByText(/Expires in \d+ s/)).toBeVisible();
  await codeBox
    .getByRole("button", { name: "Hide authenticator code for Shop Gmail" })
    .click();
  // Backup codes: reveal, then mark one used.
  await page
    .getByRole("button", {
      name: "Reveal backup codes for Shop Gmail",
      exact: true,
    })
    .click();
  const codes = page.getByRole("group", {
    name: "backup codes for Shop Gmail",
  });
  await expect(codes.locator(".secret-value")).toHaveText([
    "AAAA-1111",
    "BBBB-2222",
    "CCCC-3333",
  ]);
  await codes
    .getByRole("button", { name: "Mark backup code 2 used", exact: true })
    .click();
  await expect(codes.getByText("Used", { exact: true })).toBeVisible();
  await expect(page.getByText("2 of 3 left")).toBeVisible();
  // Layout and accessibility with the vault fully open.
  expect((await axe(page)).violations, "accounts accessibility").toEqual([]);
  await noOverflow(page, "accounts");
  await codes
    .getByRole("button", { name: "Hide backup codes for Shop Gmail" })
    .click();
  // Danger zone: remove one stored secret.
  await page
    .getByRole("button", { name: "Edit Shop Gmail", exact: true })
    .click();
  await dialog.getByLabel("I understand this cannot be undone").check();
  await dialog
    .getByRole("button", { name: "Remove backup codes", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Remove backup codes" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByText("Not set", { exact: true })).toHaveCount(1);
  // ---- Files ----
  await section(page, "Files");
  await expect(
    page.getByRole("heading", { name: "Files", exact: true }),
  ).toBeVisible();
  const picker = page.getByLabel("File", { exact: true });
  await picker.setInputFiles({
    name: "malware.exe",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("nope"),
  });
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("not allowed");
  const bytes = Buffer.from("agreement text\nsecond line\n");
  await picker.setInputFiles({
    name: "agreement.txt",
    mimeType: "text/plain",
    buffer: bytes,
  });
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "agreement.txt", exact: true }),
  ).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download agreement.txt", exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("agreement.txt");
  const stream = await download.createReadStream();
  const received = [];
  for await (const chunk of stream) received.push(chunk);
  expect(Buffer.concat(received).equals(bytes)).toBe(true);
  expect((await axe(page)).violations, "files accessibility").toEqual([]);
  await noOverflow(page, "files");
  await page
    .getByRole("button", { name: "Delete agreement.txt", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete file", exact: true }).click();
  await expect(page.getByText("Deleted", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download agreement.txt" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Restore agreement.txt", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Download agreement.txt" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Test storage", exact: true }).click();
  await expect(page.getByText("Storage test passed")).toBeVisible();
  // ---- Activity ----
  await section(page, "Activity");
  await expect(
    page.getByRole("cell", { name: "account.revealed", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "file.downloaded", exact: true }).first(),
  ).toBeVisible();
  expect((await axe(page)).violations, "activity accessibility").toEqual([]);
  await noOverflow(page, "activity");
  // ---- Installations and POS setup ----
  await section(page, "Installations");
  await page
    .getByRole("link", { name: "Record POS production", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Record POS production" }),
  ).toBeVisible();
  const steps = page.getByRole("region", { name: "Setup steps" });
  await expect(steps.getByText("Done", { exact: true })).toHaveCount(1);
  await expect(
    steps.getByText("Pending", { exact: true }).first(),
  ).toBeVisible();
  await section(page, "POS setup", "Installation navigation");
  await expect(
    page.getByRole("heading", { name: "POS setup", exact: true }),
  ).toBeVisible();
  // Deploys moved to their own tab; the setup page only shows the lock state.
  await expect(
    page
      .getByRole("navigation", { name: "Installation navigation" })
      .getByRole("link", { name: "Deploy", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Deploys — coming in Stage 2")).toHaveCount(0);
  await expect(page.getByLabel("Deploy lock on")).toHaveCount(0);
  const form = page.getByRole("form", { name: "POS configuration" });
  await form.getByLabel("Slug", { exact: true }).fill("record-pos");
  await form.getByLabel("Subdomain", { exact: true }).fill("recordpos");
  await form.getByLabel("Host", { exact: true }).fill("recordpos.example.test");
  await form.getByLabel("Root domain", { exact: true }).fill("example.test");
  await form.getByLabel("Tenant ID", { exact: true }).fill("tenant-1");
  await form.getByLabel("POS admin username").fill("posadmin");
  await form
    .getByRole("button", { name: "Create POS settings", exact: true })
    .click();
  await expect(page.getByText("POS settings saved.")).toBeVisible();
  await form.getByLabel("Vercel project name").fill("record-pos-app");
  await form
    .getByRole("button", { name: "Save POS settings", exact: true })
    .click();
  await expect(page.getByText("Revision 2")).toBeVisible();
  await page
    .getByRole("button", { name: "Set Vercel token", exact: true })
    .click();
  await dialog
    .getByLabel("Vercel token", { exact: true })
    .fill("vercel-token-123");
  await dialog.getByRole("button", { name: "Save encrypted secret" }).click();
  await expect(
    page.getByRole("button", { name: "Replace Vercel token", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reveal Vercel token", exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: "Vercel token" }).locator(".secret-value"),
  ).toHaveText("vercel-token-123");
  expect((await axe(page)).violations, "pos accessibility").toEqual([]);
  await noOverflow(page, "pos setup");
  expect(errors).toEqual([]);
});
test("admin sees the vault but no reveal, download, delete or test controls", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page, "client-admin@example.test");
  await page.goto(`${CUSTOMER}/accounts`);
  await expect(
    page.getByRole("heading", { name: "Shop Gmail", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Replace password for Shop Gmail" }),
  ).toBeVisible();
  for (const name of [/^Reveal/, /^Show code/])
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit Shop Gmail" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit Shop Gmail" }).click();
  await expect(page.getByText("Danger zone")).toHaveCount(0);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.goto(`${CUSTOMER}/files`);
  await expect(
    page.getByRole("cell", { name: "agreement.txt", exact: true }),
  ).toBeVisible();
  for (const name of [/^Download/, /^Delete/, /^Test storage/])
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Upload file", exact: true }),
  ).toBeVisible();
  await page.goto(`${INSTALLATION}/pos`);
  await expect(
    page.getByRole("button", { name: "Replace Vercel token", exact: true }),
  ).toBeVisible();
  for (const name of [/^Reveal/, /^Remove/])
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  for (const route of [
    `${CUSTOMER}`,
    `${CUSTOMER}/installations`,
    `${INSTALLATION}`,
  ]) {
    await page.goto(route);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText("Loading your workspace…")).toHaveCount(0);
    expect((await axe(page)).violations, `${route} accessibility`).toEqual([]);
    await noOverflow(page, route);
  }
});
test("viewer cannot open the vault", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page, "viewer@example.test");
  // List filters live in the URL: typing rewrites it, a reload keeps it.
  await page.goto("/customers");
  await page
    .getByRole("searchbox", { name: /Search customers/ })
    .fill("Record");
  await expect(page).toHaveURL(/\/customers\?search=Record$/);
  await page.goto("/customers?page=9");
  await expect(page).not.toHaveURL(/page=9/);
  await expect(page.getByText(/start here/)).toHaveCount(0);
  await page.goto("/customers?search=Record");
  await page.reload();
  await expect(
    page.getByRole("searchbox", { name: /Search customers/ }),
  ).toHaveValue("Record");
  await expect(
    page.getByRole("link", { name: "Record Customer", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: /Search customers/ })
    .fill("zzzz-none");
  await expect(page.getByText("No matching records")).toBeVisible();
  await page.goto(`${CUSTOMER}/accounts`);
  await expect(page.getByText("Accounts are restricted")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Reveal|Show code|Add account|Edit/ }),
  ).toHaveCount(0);
  await page.goto(`${INSTALLATION}`);
  await expect(
    page.getByRole("heading", { name: "Record POS production" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "POS setup" })).toHaveCount(0);
  await page.goto(`${INSTALLATION}/pos`);
  await expect(page.getByText("POS setup is restricted")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.goto(`${CUSTOMER}/files`);
  await expect(page.getByText("Files are restricted")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Download|Delete|Upload|Test storage/ }),
  ).toHaveCount(0);
  expect((await axe(page)).violations, "viewer accessibility").toEqual([]);
  await noOverflow(page, "viewer files");
});
test("secret fields block copy but accept paste", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page, "client-admin@example.test");
  await page.goto(`${CUSTOMER}/accounts`);
  await page
    .getByRole("button", {
      name: "Replace password for Shop Gmail",
      exact: true,
    })
    .click();
  const field = page.getByRole("dialog").getByLabel("New password");
  await expect(field).toHaveAttribute("writingsuggestions", "false");
  await expect(field).toHaveAccessibleDescription(/Secret value/);
  await page.evaluate(() => navigator.clipboard.writeText("sentinel-clip"));
  await field.fill("typed-secret-1");
  await field.press("Control+A");
  await field.press("Control+C");
  await field.press("Control+X");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "sentinel-clip",
  );
  await expect(field).toHaveValue("typed-secret-1");
  await field.fill("");
  await page.evaluate(() => navigator.clipboard.writeText("pasted-secret-2"));
  await field.press("Control+V");
  await expect(field).toHaveValue("pasted-secret-2");
});
test("a concurrent edit is never silently overwritten after a credential save", async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const route = "/connections/00000000-0000-4000-8000-0000000000b1";
  await signIn(page, "client-admin@example.test");
  await page.goto(route);
  const mine = page.getByLabel("Project / zone / cluster ID");
  await mine.fill("my-unsaved-resource");
  // Someone else saves a different field in the meantime.
  const other = await browser.newPage();
  await signIn(other, "owner@example.test");
  await other.goto(route);
  await other.getByLabel("Account / team ID").fill("team-from-b");
  await other.getByRole("button", { name: "Save changes" }).click();
  await expect(other.getByText("Changes saved.")).toBeVisible();
  // A stores a credential, then saves the form: both must refuse, not absorb.
  await page.getByRole("button", { name: "Store credential" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("New credential", { exact: true })
    .fill("synthetic-credential-1");
  await page.getByRole("button", { name: "Save encrypted credential" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    /changed|reload/i,
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: /changed|Reload/i }),
  ).toBeVisible();
  await expect(mine).toHaveValue("my-unsaved-resource");
  // Loading the latest keeps B's change and lists only A's own typing.
  await page.getByRole("button", { name: "Load latest version" }).click();
  await expect(page.getByLabel("Account / team ID")).toHaveValue("team-from-b");
  await expect(page.locator(".kept-list")).toContainText("my-unsaved-resource");
  await expect(page.locator(".kept-list")).not.toContainText("team-from-b");
  await other.close();
});
