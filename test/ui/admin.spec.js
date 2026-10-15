import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
const axe = (page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
async function choose(page, name, option) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function login(page, role = "owner") {
  await page.goto("/");
  await page.getByLabel("Work email").fill(`${role}@example.test`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("Browser test passphrase 2026!");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();
  const { code } = JSON.parse(
    readFileSync(`test-results/otp-${role}.json`, "utf8"),
  );
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}
test("the sign-in password can be shown and hidden", async ({ page }) => {
  await page.goto("/");
  const field = page.getByLabel("Password", { exact: true });
  await field.fill("typed-passphrase-1");
  await expect(field).toHaveAttribute("type", "password");
  const show = page.getByRole("button", { name: "Show password" });
  await expect(show).toHaveAttribute("aria-pressed", "false");
  await expect(show).toHaveAttribute("type", "button");
  await show.click();
  await expect(field).toHaveAttribute("type", "text");
  await expect(field).toHaveValue("typed-passphrase-1");
  // The name stays fixed; only aria-pressed changes. It controls the input.
  await expect(show).toHaveAttribute("aria-pressed", "true");
  await expect(show).toHaveAttribute(
    "aria-controls",
    await field.getAttribute("id"),
  );
  // Shown text is kept away from spellcheck and assistants too.
  await expect(field).toHaveAttribute("spellcheck", "false");
  await expect(field).toHaveAttribute("autocapitalize", "off");
  await expect(field).toHaveAttribute("data-gramm", "false");
  // Reachable by keyboard, and it never submits the form.
  await field.focus();
  await page.keyboard.press("Tab");
  await expect(show).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(field).toHaveAttribute("type", "password");
  await expect(show).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  // Visible state does not survive the field being removed.
  await show.click();
  await page.getByRole("button", { name: /forgot your password/ }).click();
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  // The recovery step's new-password field has the same control (the API
  // answers are stubbed so no real account is touched).
  await page.route("**/api/auth/recover", (route) =>
    route.fulfill({ json: { challengeId: "r".repeat(24) } }),
  );
  await page.getByRole("button", { name: /forgot your password/ }).click();
  await page.getByLabel("Work email").fill("someone@example.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();
  const fresh = page.getByLabel("New password", { exact: true });
  await expect(fresh).toHaveAttribute("type", "password");
  const showNew = page.getByRole("button", { name: "Show password" });
  await showNew.click();
  await expect(fresh).toHaveAttribute("type", "text");
  await expect(showNew).toHaveAttribute("aria-pressed", "true");
  expect((await axe(page)).violations, "recovery accessibility").toEqual([]);
  await page.getByRole("button", { name: /Use a different email/ }).click();
  await page.getByRole("button", { name: "Back to sign in" }).click();
  expect((await axe(page)).violations, "sign-in accessibility").toEqual([]);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `sign-in overflows at ${width}`,
    ).toBe(true);
  }
});
test("an expired or used-up authenticator step sends the person back to the password", async ({
  page,
}) => {
  // Stubbed answers: nothing here touches a real challenge.
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      json: { totpRequired: true, challengeId: "t".repeat(24) },
    }),
  );
  let answers = 0;
  await page.route("**/api/auth/verify-totp", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error:
          answers++ === 0
            ? "Code is incorrect."
            : "Code is invalid, expired or has too many attempts.",
      },
    }),
  );
  await page.goto("/");
  await page.getByLabel("Work email").fill("someone@example.test");
  await page.getByLabel("Password", { exact: true }).fill("typed-passphrase-1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm with your authenticator" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Start over" })).toBeVisible();
  // A wrong code stays on the step.
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("Code is incorrect.");
  await expect(
    page.getByRole("heading", { name: "Confirm with your authenticator" }),
  ).toBeVisible();
  // A dead challenge returns to the password step with a short message.
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Enter your password again",
  );
  await expect(page.getByLabel("Work email")).toHaveValue(
    "someone@example.test",
  );
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
});
test("dashboard scopes, brief views and customer search work with populated records", async ({
  page,
}) => {
  // Synthetic response stays inside this browser test; production data is untouched.
  await page.route("**/api/overview", (route) =>
    route.fulfill({
      json: {
        customers: 12,
        products: 4,
        overdue: 2,
        connections: 1,
        installations: [
          { _id: "planned", count: 2 },
          { _id: "ready", count: 1 },
          { _id: "live", count: 3 },
          { _id: "paused", count: 1 },
          { _id: "retired", count: 4 },
        ],
        tasks: [
          {
            _id: "test-task",
            title: "Confirm customer handover",
            dueAt: "2026-10-01",
            priority: "high",
          },
        ],
        activity: [
          {
            _id: "test-event",
            actorName: "Test Owner",
            action: "product.updated",
            createdAt: "2026-09-28T08:00:00Z",
          },
        ],
        latestRecovery: null,
        asOf: "2026-09-28T08:00:00Z",
      },
    }),
  );
  await login(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  const report = page.getByRole("region", { name: "Delivery overview" });
  await expect(report.locator(".delivery-total > strong")).toHaveText("7");
  await choose(page, "Installation scope", "All records");
  await expect(report.locator(".delivery-total > strong")).toHaveText("11");
  await choose(page, "Installation scope", "Active records");
  const brief = page.getByRole("complementary", { name: "Workspace brief" });
  await expect(brief.getByText("43%", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/reference-populated-dashboard.png",
    fullPage: true,
  });
  await brief.getByRole("button", { name: "activity", exact: true }).click();
  await expect(brief.getByText("Test Owner", { exact: true })).toBeVisible();
  await brief.getByRole("button", { name: "products", exact: true }).click();
  await expect(brief.getByText("Sandbee POS", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close workspace brief" }).click();
  await expect(brief).toHaveCount(0);
  await page
    .getByRole("button", { name: "Workspace brief", exact: true })
    .click();
  await expect(brief).toBeVisible();
  await page.getByRole("button", { name: "Refresh dashboard" }).click();
  await expect(report.locator(".delivery-total > strong")).toHaveText("7");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/reference-dashboard-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("textbox", { name: "Search customers" })
    .fill("Example customer");
  await page.getByRole("button", { name: "Search customer registry" }).click();
  await expect(page).toHaveURL(/customers\?search=Example%20customer/);
  await expect(page.locator(".list-toolbar input")).toHaveValue(
    "Example customer",
  );
});

test("login is accessible and exposes no public signup", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page
    .getByRole("button", { name: "First time here or forgot your password?" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Set up or recover access" }),
  ).toBeVisible();
});
test("owner completes customer, connection, installation, task and team workflows", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await page.getByRole("link", { name: "Add customer", exact: true }).click();
  await page.getByLabel("Contact name", { exact: true }).fill("UI Customer");
  await page.getByLabel("Company", { exact: true }).fill("UI Cafe");
  await page
    .getByLabel("Email address", { exact: true })
    .fill("ui-customer@example.test");
  await page
    .getByRole("button", { name: "Create customer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "UI Customer", exact: true }),
  ).toBeVisible();
  await page.goto("/connections/new");
  await page.getByLabel("Connection name").fill("UI Vercel");
  await choose(page, "Customer", "UI Customer");
  await page.getByRole("button", { name: "Create connection" }).click();
  await expect(page.getByRole("heading", { name: "UI Vercel" })).toBeVisible();
  await page.getByRole("button", { name: "Store credential" }).click();
  await page
    .getByLabel("New credential", { exact: true })
    .fill("ui-synthetic-provider-token");
  await page.getByRole("button", { name: "Save encrypted credential" }).click();
  await expect(
    page.getByText("Encrypted credential stored", { exact: true }),
  ).toBeVisible();
  await page.goto("/installations/new");
  await page.getByLabel("Installation name").fill("UI POS production");
  await choose(page, "Customer", "UI Customer");
  await choose(page, "Product", "Sandbee POS");
  await page.getByRole("button", { name: "Create installation" }).click();
  await expect(
    page.getByRole("heading", { name: "UI POS production" }),
  ).toBeVisible();
  await choose(page, "Lifecycle", "ready");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("Complete ownership");
  await page.goto("/tasks/new");
  await page.getByLabel("Task title").fill("Confirm customer handover");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Confirm customer handover" }),
  ).toBeVisible();
  await choose(page, "Progress", "done");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Revision 2", { exact: false })).toBeVisible();
  await page.goto("/team");
  await page.getByRole("button", { name: "Add team member" }).click();
  await page.getByLabel("Full name").fill("UI Operator");
  await page.getByLabel("Work email").fill("ui-operator@example.test");
  await page.getByRole("button", { name: "Create staff access" }).click();
  await expect(
    page.getByText("Staff access created for ui-operator@example.test."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("UI Operator", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("owner console has no horizontal page overflow and meets axe checks", async ({
  page,
}) => {
  test.setTimeout(90000);
  await login(page);
  for (const route of [
    "/",
    "/customers",
    "/products",
    "/installations",
    "/connections",
    "/tasks",
    "/team",
    "/audit",
    "/store",
    "/ecom",
    "/recovery",
    "/customers/new",
    "/installations/new",
  ]) {
    await page.goto(route);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText("Loading your workspace…")).toHaveCount(0);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(results.violations, `${route} accessibility`).toEqual([]);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const overflow = await page.evaluate(() => ({
        width: innerWidth,
        document: document.documentElement.scrollWidth,
        containers: [
          ...document.querySelectorAll(
            ".table-wrap,main,.workspace,.app-shell",
          ),
        ].map((el) => ({
          class: el.className,
          right: el.getBoundingClientRect().right,
          overflow: getComputedStyle(el).overflow,
        })),
        items: [...document.querySelectorAll("body *")]
          .filter(
            (el) =>
              el.getBoundingClientRect().right > innerWidth + 1 &&
              getComputedStyle(el).position !== "fixed",
          )
          .slice(0, 6)
          .map((el) => ({
            tag: el.tagName,
            class: el.className,
            right: el.getBoundingClientRect().right,
          })),
      }));
      expect(
        overflow.document <= overflow.width,
        `${route} width ${width}: ${JSON.stringify(overflow)}`,
      ).toBeTruthy();
    }
  }
  await page.goto("/");
  await page.screenshot({
    path: "test-results/admin-overview-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-collapsed/);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Expand sidebar" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Customers", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Customers", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/admin-customers-mobile.png",
    fullPage: true,
  });
});
test("read-only role cannot edit, access recovery or invite staff", async ({
  page,
}) => {
  await login(page, "viewer");
  await page.goto("/customers");
  await expect(page.getByRole("link", { name: "Add customer" })).toHaveCount(0);
  await page.goto("/customers/new");
  await expect(page.getByLabel("Contact name")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Create customer" }),
  ).toHaveCount(0);
  await page.goto("/team");
  await expect(
    page.getByRole("button", { name: "Add team member" }),
  ).toHaveCount(0);
  await page.goto("/recovery");
  await expect(
    page.getByRole("heading", { name: "This page is not available" }),
  ).toBeVisible();
});

test("product catalog filters, contextual workspace and model-aware installation form", async ({
  page,
}) => {
  await login(page);
  await page.goto("/products/new");
  await page.getByLabel("Product name", { exact: true }).fill("Forecast API");
  await page
    .getByLabel("Product identifier", { exact: true })
    .fill("forecast-api");
  await page.getByLabel("Category", { exact: true }).fill("Developer tools");
  await page
    .getByLabel("Description", { exact: true })
    .fill("A second hosted API for a different business requirement.");
  await choose(page, "Delivery model", "Hosted API");
  await page
    .getByRole("button", { name: "Create product", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Forecast API", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No provider accounts required", { exact: true }),
  ).toBeVisible();
  const productPath = new URL(page.url()).pathname;
  for (const section of ["", "/settings", "/installations"]) {
    await page.goto(`${productPath}${section}`);
    await expect(page.locator("h1")).toBeVisible();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  await page.goto(`${productPath}/settings`);
  await page
    .getByLabel("Description", { exact: true })
    .fill("Updated API operations guide.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Revision 2", { exact: false })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Product navigation" })
    .getByRole("link", { name: "Overview", exact: true })
    .click();
  await expect(
    page.getByText("Updated API operations guide.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/store-aligned-product-workspace.png",
    fullPage: true,
  });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page
    .getByRole("navigation", { name: "Product navigation" })
    .getByRole("link", { name: "Installations", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Add installation", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Product", exact: true }),
  ).toContainText("Forecast API");
  await expect(
    page.getByRole("checkbox", {
      name: "Customer and product access confirmed",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: "Database backup and recovery access confirmed",
    }),
  ).toHaveCount(0);
  await page.goto("/products");
  await choose(page, "Filter by delivery model", "Hosted API");
  await expect(
    page.getByRole("heading", { name: "Forecast API", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sandbee POS", exact: true }),
  ).toHaveCount(0);
  await choose(page, "Filter by delivery model", "All delivery models");
  await expect(
    page.getByRole("heading", { name: "Sandbee POS", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Filter by status", exact: true })
    .focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({
    path: "test-results/store-aligned-products.png",
    fullPage: true,
  });
});
