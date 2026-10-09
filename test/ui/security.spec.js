import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
const email = "security-owner@example.test";
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.3" } });
const password = "Browser test passphrase 2026!";
const axe = (page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
async function emailStep(page, who = email) {
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
// One step ahead of the last accepted code: always valid (+/-1 window) and
// never a replay.
const nextCode = (key) => codeAt(key, stepAt(Date.now()) + 1);
async function signOut(page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
}
test("owner enrols an authenticator, saves backup codes and signs in with TOTP and a backup code", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await emailStep(page);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const banner = page.locator(".notice-warning");
  await expect(banner).toContainText("authenticator");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Account security", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Account security", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".notice-warning")).toHaveCount(0);
  await expect(page.getByText("Not set up", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Turn off authenticator" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  const qr = page.getByRole("img", {
    name: "QR code for your authenticator app",
  });
  await expect(qr).toBeVisible();
  expect(await qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
  const shown = await page.locator(".setup-key").innerText();
  expect(shown).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
  const key = base32Decode(shown.replaceAll(" ", ""));
  expect((await axe(page)).violations, "enrol step accessibility").toEqual([]);
  await page
    .getByLabel("6-digit code from your app")
    .fill(codeAt(key, stepAt(Date.now())));
  await page
    .getByRole("button", { name: "Turn on authenticator", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your backup codes" }),
  ).toBeVisible();
  const codes = await page.locator(".backup-codes li").allInnerTexts();
  expect(codes).toHaveLength(10);
  for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const done = page.getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeDisabled();
  expect((await axe(page)).violations, "backup codes accessibility").toEqual(
    [],
  );
  await page
    .getByRole("checkbox", { name: "I saved these backup codes" })
    .check();
  await done.click();
  await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
  await expect(page.getByText("of 10 backup codes left")).toBeVisible();
  await expect(
    page.getByText("Owners must keep the authenticator on."),
  ).toBeVisible();
  expect((await axe(page)).violations, "/account accessibility").toEqual([]);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `/account overflow at ${width}`,
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await signOut(page);
  // Sign in with the authenticator app.
  await emailStep(page);
  await expect(
    page.getByRole("heading", { name: "Confirm with your authenticator" }),
  ).toBeVisible();
  expect((await axe(page)).violations, "totp step accessibility").toEqual([]);
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("incorrect");
  await page.getByLabel("Authenticator code").fill(nextCode(key));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.locator(".notice-warning")).toHaveCount(0);
  await signOut(page);
  // Sign in with a backup code.
  await emailStep(page);
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByLabel("Backup code").fill(codes[0]);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.goto("/account");
  await expect(page.getByText("9", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("of 10 backup codes left")).toBeVisible();
  // A sensitive action asks for step-up in a modal, then retries itself.
  await page
    .getByRole("button", { name: "Regenerate backup codes", exact: true })
    .click();
  const modal = page.getByRole("dialog");
  await expect(
    modal.getByRole("heading", { name: "Confirm it’s you" }),
  ).toBeVisible();
  expect((await axe(page)).violations, "step-up modal accessibility").toEqual(
    [],
  );
  await modal.getByRole("button", { name: "Use a backup code" }).click();
  await modal.getByLabel("Backup code").fill(codes[1]);
  await modal.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your backup codes" }),
  ).toBeVisible();
  const regenerated = await page.locator(".backup-codes li").allInnerTexts();
  expect(regenerated).not.toEqual(codes);
  await page
    .getByRole("checkbox", { name: "I saved these backup codes" })
    .check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("of 10 backup codes left")).toBeVisible();
  // Replacing the authenticator needs a code from the current one too.
  await page
    .getByRole("button", { name: "Replace authenticator", exact: true })
    .click();
  const replacementKey = base32Decode(
    (await page.locator(".setup-key").innerText()).replaceAll(" ", ""),
  );
  await page
    .getByLabel("6-digit code from your app")
    .fill(codeAt(replacementKey, stepAt(Date.now())));
  await page.getByLabel("Code from your current authenticator").fill("000000");
  await page.getByRole("button", { name: "Turn on authenticator" }).click();
  await expect(page.getByRole("alert")).toContainText("incorrect");
  await page
    .getByRole("button", { name: "Use a backup code instead", exact: true })
    .click();
  await page.getByLabel("Current backup code").fill(regenerated[0]);
  await page.getByRole("button", { name: "Turn on authenticator" }).click();
  await expect(
    page.getByRole("heading", { name: "Your backup codes" }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "I saved these backup codes" })
    .check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("of 10 backup codes left")).toBeVisible();
  await signOut(page);
  // The same backup code cannot be used again.
  await emailStep(page);
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByLabel("Backup code").fill(codes[0]);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("already used");
  expect(errors).toEqual([]);
});

test("concurrent step-up prompts share one dialog: success completes both actions, cancel releases both", async ({
  page,
}) => {
  test.setTimeout(90000);
  const who = "stepup-admin@example.test";
  // Enrol through the UI, then sign in again with a backup code so the new
  // session has no step-up (the setup session is stepped up for 10 minutes).
  await emailStep(page, who);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.goto("/account");
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  const key = base32Decode(
    (await page.locator(".setup-key").innerText()).replaceAll(" ", ""),
  );
  await page
    .getByLabel("6-digit code from your app")
    .fill(codeAt(key, stepAt(Date.now())));
  await page.getByRole("button", { name: "Turn on authenticator" }).click();
  await expect(
    page.getByRole("heading", { name: "Your backup codes" }),
  ).toBeVisible();
  const codes = await page.locator(".backup-codes li").allInnerTexts();
  await page
    .getByRole("checkbox", { name: "I saved these backup codes" })
    .check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await signOut(page);
  await emailStep(page, who);
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByLabel("Backup code").fill(codes[0]);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.goto("/account");
  const log = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (
      [
        "/api/auth/step-up",
        "/api/auth/totp/backup-codes",
        "/api/auth/totp/enrol/start",
      ].includes(path)
    )
      log.push(`${path} ${response.status()}`);
  });
  const regenerate = page.getByRole("button", {
    name: "Regenerate backup codes",
    exact: true,
  });
  const replace = page.getByRole("button", {
    name: "Replace authenticator",
    exact: true,
  });
  await expect(regenerate).toBeVisible();
  // Two protected actions fired in the same tick, before any prompt opens.
  const fireBoth = () =>
    page.evaluate(() => {
      for (const name of ["Regenerate backup codes", "Replace authenticator"])
        [...document.querySelectorAll("button")]
          .find((el) => el.textContent.trim() === name)
          .click();
    });
  const dialog = page.getByRole("dialog");
  // Variant 1: cancelling rejects both waiters and frees both buttons.
  await fireBoth();
  await expect(dialog).toHaveCount(1);
  await expect(
    dialog.getByRole("heading", { name: "Confirm it’s you" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(regenerate).toBeEnabled();
  await expect(replace).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "Your backup codes" }),
  ).toHaveCount(0);
  expect(log.sort()).toEqual([
    "/api/auth/totp/backup-codes 428",
    "/api/auth/totp/enrol/start 428",
  ]);
  // Variant 2: one valid code completes both actions after a single prompt.
  log.length = 0;
  await fireBoth();
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole("button", { name: "Use a backup code" }).click();
  await dialog.getByLabel("Backup code").fill(codes[1]);
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => log.filter((line) => line.endsWith(" 200")).length)
    .toBe(3);
  expect(log.sort()).toEqual(
    [
      "/api/auth/step-up 200",
      "/api/auth/totp/backup-codes 200",
      "/api/auth/totp/backup-codes 428",
      "/api/auth/totp/enrol/start 200",
      "/api/auth/totp/enrol/start 428",
    ].sort(),
  );
});
test("leaving the page with unsaved backup codes asks first, then the step-up modal works without a reload", async ({
  page,
}) => {
  test.setTimeout(90000);
  await emailStep(page, "guard-admin@example.test");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.goto("/account");
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  const key = base32Decode(
    (await page.locator(".setup-key").innerText()).replaceAll(" ", ""),
  );
  await page
    .getByLabel("6-digit code from your app")
    .fill(codeAt(key, stepAt(Date.now())));
  await page.getByRole("button", { name: "Turn on authenticator" }).click();
  await expect(
    page.getByRole("heading", { name: "Your backup codes" }),
  ).toBeVisible();
  // In-app navigation is intercepted while the codes are unconfirmed.
  const messages = [];
  page.on("dialog", (dialog) => {
    messages.push(dialog.message());
    dialog.dismiss();
  });
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Customers", exact: true })
    .click();
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toContain("backup codes");
  await expect(page).toHaveURL(new RegExp("/account$"));
  // Browser Back and Sign out are guarded too; cancelling changes nothing.
  await page.evaluate(() => history.back());
  await expect.poll(() => messages.length).toBe(2);
  await expect(
    page.getByRole("heading", { name: "Your backup codes" }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp("/account$"));
  const logouts = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/logout")) logouts.push(request.url());
  });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => messages.length).toBe(3);
  expect(logouts).toHaveLength(0);
  await expect(
    page.getByRole("heading", { name: "Your backup codes" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your backup codes" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/account$/);
  await page
    .getByRole("checkbox", { name: "I saved these backup codes" })
    .check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
  // Free to leave now, and the app already knows the authenticator exists.
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Customers", exact: true })
    .click();
  await expect(page).toHaveURL(/\/customers$/);
  expect(messages).toHaveLength(3);
});
