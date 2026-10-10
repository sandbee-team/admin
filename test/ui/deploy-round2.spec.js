import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
// Pre-admin rollback, redeploy of the previous version, cancel of a claimed
// rollback, unhealthy vs rolled-back, the fleet freeze banner, the light fleet
// route, the existing-build message and the builder readiness reasons.
const password = "Browser test passphrase 2026!";
const KEY = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
const N = { ready: 1, redeploy: 3, preadmin: 16 };
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
const PRE = "Version before admin took over (deployed outside admin)";
test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.12" } });

test("a pre-admin previous version can be rolled back to; a claimed rollback cannot be cancelled", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("reset?scenario=all");
  await ownerIn(page, "l");
  await page.goto(url("preadmin"));
  const previous = page.getByRole("region", { name: "Previous version" });
  await expect(previous).toContainText(PRE);
  await expect(previous).not.toContainText("@");
  const roll = previous.getByRole("button", { name: "Roll back to this" });
  await expect(roll).toBeEnabled();
  await roll.click();
  const modal = dialog(page);
  await expect(modal).toContainText(PRE);
  await expect(modal).toContainText("no stored build to fall back on");
  await modal.getByLabel("Type ui-preadmin to confirm").fill("ui-preadmin");
  await modal.getByRole("button", { name: "Roll back", exact: true }).click();
  await confirmStepUp(page);
  await expect(
    page.getByRole("heading", {
      name: "Rolling back to the version before admin took over",
    }),
  ).toBeVisible();
  // Once a worker has claimed the rollback there is no Cancel.
  await control(
    "job?scenario=preadmin&kind=rollback&status=running&step=vercel",
  );
  await expect(page.locator(".progress-status")).toContainText("Now: Go live", {
    timeout: 20000,
  });
  await expect(page.getByRole("button", { name: "Cancel deploy" })).toHaveCount(
    0,
  );
  // A claim that lands after the page last polled: the API refuses honestly.
  await page.goto(url("ready"));
  await control("job?scenario=ready&kind=rollback&status=queued");
  const cancel = page.getByRole("button", { name: "Cancel deploy" });
  await expect(cancel).toBeEnabled({ timeout: 20000 });
  await control(
    "job?scenario=ready&kind=rollback&status=queued&claimed=1&hold=1",
  );
  await cancel.click();
  await expect(
    page.getByText(
      "This rollback has already started and cannot be cancelled.",
    ),
  ).toBeVisible();
});

test("redeploy of the previous commit needs the typed slug", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("reset?scenario=all");
  await ownerIn(page, "m");
  await page.goto(url("redeploy"));
  await control(
    "job?scenario=redeploy&kind=rollback&status=failed&step=vercel",
  );
  const failed = page.locator(".deploy-error");
  await expect(failed).toBeVisible({ timeout: 20000 });
  let sent = null;
  await page.route("**/pos/deploys", (route) => {
    if (route.request().method() === "POST")
      sent = route.request().postDataJSON();
    return route.continue();
  });
  await failed
    .getByRole("button", { name: "Redeploy previous commit (cached)" })
    .click();
  const modal = dialog(page);
  await expect(modal).toContainText("changes production, like a rollback");
  const go = modal.getByRole("button", {
    name: "Redeploy previous",
    exact: true,
  });
  await expect(go).toBeDisabled();
  await modal.getByLabel("Type ui-redeploy to confirm").fill("ui-redeploy");
  await go.click();
  await confirmStepUp(page);
  await expect(page.getByText("Deploy queued.")).toBeVisible();
  expect(sent).toEqual({
    kind: "redeploy",
    of: "previous",
    confirm: "ui-redeploy",
  });
  // A pre-admin previous has no commit to redeploy.
  await page.goto(url("preadmin"));
  await control(
    "job?scenario=preadmin&kind=rollback&status=failed&step=vercel",
  );
  await expect(page.locator(".deploy-error")).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByRole("button", { name: "Redeploy previous commit (cached)" }),
  ).toHaveCount(0);
});

test("fleet and dashboard tell unhealthy from rolled back; freeze banner; light route", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("reset?scenario=all");
  await control("freeze?on=1&reason=Maintenance window");
  const urls = [];
  page.on("request", (request) => urls.push(request.url()));
  try {
    await ownerIn(page, "n");
    await page.goto("/pos-clients");
    await expect(
      page.locator(".notice").filter({ hasText: "Maintenance window" }),
    ).toBeVisible();
    const row = (slug) => page.locator(`tr[data-slug="${slug}"]`);
    await expect(row("ui-unhealthy")).toContainText(
      "Unhealthy — site may be down",
    );
    await expect(row("ui-unhealthy")).toHaveClass(/row-urgent/);
    await expect(row("ui-rolledback")).toContainText(
      "Rolled back — site is fine",
    );
    await expect(row("ui-rolledback")).not.toHaveClass(/row-urgent/);
    await expect(row("ui-failed")).toContainText("Failed");
    // Dashboard: the same split (the overview is cached for 5 s server side).
    const down = page.getByRole("link", { name: /POS site may be down/ });
    await expect
      .poll(
        async () => {
          await page.goto("/");
          await expect(
            page.getByRole("heading", { name: "Dashboard" }),
          ).toBeVisible();
          return down.isVisible();
        },
        { timeout: 30000, intervals: [1000] },
      )
      .toBe(true);
    await expect(down).toHaveClass(/attention-urgent/);
    const back = page.getByRole("link", { name: /POS deploys rolled back/ });
    await expect(back).toBeVisible();
    await expect(back).not.toHaveClass(/attention-urgent/);
    // Customer pages use the light fleet route.
    urls.length = 0;
    await page.goto("/customers/00000000-0000-4000-8000-e00000000001/files");
    await expect(
      page.getByRole("link", { name: "ui-ready", exact: true }),
    ).toBeVisible();
    expect(
      urls.some((u) => /\/api\/pos\/fleet\?light=1&customerId=/.test(u)),
    ).toBe(true);
    expect(urls.some((u) => /\/api\/pos\/fleet\?customerId=/.test(u))).toBe(
      false,
    );
  } finally {
    await control("freeze?on=0");
  }
});

test("an existing build and each builder problem read clearly", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("reset?scenario=all");
  await ownerIn(page, "o");
  await page.goto(url("ready"));
  await page.locator(".branch-option").filter({ hasText: "feature/x" }).click();
  await expect(page.locator(".plan-summary")).toContainText("Will build");
  await page.route("**/pos/builds", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        build: {
          state: "building",
          sha7: "bbbbbbb",
          key8: "abcd1234",
          existing: true,
        },
      }),
    }),
  );
  await page
    .getByRole("button", { name: "Prepare build", exact: true })
    .click();
  await dialog(page)
    .getByRole("button", { name: "Prepare build", exact: true })
    .click();
  await expect(
    page.getByText("A build for this commit already exists (building)."),
  ).toBeVisible();
  const reasons = {
    missing: ["The builder check failed.", "Check pos-builder"],
    notok: ["The builder check failed.", "Check pos-builder"],
    stale: ["The builder check is stale.", "Wait for the next worker check."],
    noconf: [
      "The worker has no builder token.",
      "Set POS_GITHUB_BUILDER_TOKEN",
    ],
  };
  try {
    for (const [mode, [reason, fix]] of Object.entries(reasons)) {
      await control(`worker?state=online&builder=${mode}`);
      await page.goto(url("ready"));
      const item = page.locator('[data-item="builder"]');
      await expect(item).toHaveAttribute("data-state", "blocked");
      await expect(item).toContainText(reason);
      await expect(item).toContainText(fix);
    }
  } finally {
    await control("worker?state=online");
  }
});
