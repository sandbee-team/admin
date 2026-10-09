import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
const password = "Browser test passphrase 2026!";
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
test("owner sees the key fingerprint, never-verified copies, then a verified copy", async ({
  page,
}) => {
  await signIn(page, "owner@example.test");
  await page.goto("/recovery");
  await expect(
    page.getByRole("heading", { name: "Key copies", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^[a-f0-9]{4}(-[a-f0-9]{4}){3}$/)).toHaveCount(1);
  await expect(page.getByText("Never verified")).toHaveCount(3);
  await expect(
    page.getByText("not used — admin backups are manual mongodumps"),
  ).toBeVisible();
  await expect(
    page.getByText("--kind=vault --copy=password-manager"),
  ).toBeVisible();
  expect(await page.content()).not.toContain("a".repeat(64));
  expect((await axe(page)).violations, "recovery accessibility").toEqual([]);
  await noOverflow(page, "recovery");
  const done = await fetch("http://127.0.0.1:8109/verify-key", {
    method: "POST",
  });
  expect((await done.json()).match).toBe(true);
  await page.reload();
  await expect(page.getByText(/^Verified /)).toHaveCount(1);
  await expect(page.getByText("Never verified")).toHaveCount(2);
  expect((await axe(page)).violations, "verified accessibility").toEqual([]);
  await noOverflow(page, "recovery verified");
});
