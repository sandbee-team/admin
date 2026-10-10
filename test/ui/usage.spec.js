import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
import { describeUsageCode } from "../../shared/usage-codes.js";
// Phase 2 usage checks (docs/PHASE2-PLAN.md §9). Fixtures: test/ui-server.js
// (seedPos, usage scenarios n 21-25). No worker runs here: the control port
// finishes a queued check the way the worker would (pos.usage.last + done).
const password = "Browser test passphrase 2026!";
const KEY = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
const N = {
  ready: 1,
  usageok: 21,
  usagefull: 22,
  usagepaused: 23,
  usagedenied: 24,
  usagenever: 25,
};
const iid = (name) =>
  `00000000-0000-4000-8000-d${String(N[name]).padStart(11, "0")}`;
const usageUrl = (name) => `/installations/${iid(name)}/usage`;
// A worker-side change shows on the next fast poll (fleet 10 s, Usage tab 5 s);
// the in-memory server can take several seconds to answer one read in a
// full-suite run. Without fast polling the pages re-read only every 60 s (15 s
// while a seeded deploy runs on the fleet), so these waits would fail.
const WORKER_WAIT = 20000;
const WAITING = "Waiting for the worker — checks are queued but not running.";
// Counts the page's GET requests to one API path (no query) from now on.
function countReads(page, path) {
  const reads = { count: 0 };
  const listener = (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === `/api${path}`
    )
      reads.count += 1;
  };
  page.on("request", listener);
  reads.stop = () => page.off("request", listener);
  return reads;
}
const axe = (page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
const control = async (path) => {
  const res = await fetch(`http://127.0.0.1:8109/pos/${path}`, {
    method: "POST",
  });
  expect(res.status, `control ${path}`).toBe(200);
};
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
async function shots(page, name) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.screenshot({
      path: `test-results/usage-${name}-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
}
const row = (page, slug) => page.locator(`tr[data-slug="${slug}"]`);
// The fleet table's cell under a column header, by header text.
async function cell(page, slug, header) {
  const headers = await page.locator(".fleet-table thead th").allInnerTexts();
  const index = headers.findIndex(
    (text) => text.trim().toLowerCase() === header.toLowerCase(),
  );
  expect(index, `column ${header}`).toBeGreaterThanOrEqual(0);
  return row(page, slug).locator("td").nth(index);
}
const reloadUntil = (page, check) =>
  expect
    .poll(
      async () => {
        await page.reload();
        await expect(
          page.getByRole("heading", { name: "Dashboard" }),
        ).toBeVisible();
        return check();
      },
      { timeout: 30000, intervals: [1000] },
    )
    .toBe(true);
test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "10.20.0.13" } });

test.afterAll(async () => {
  await control("worker?state=online");
  await control("retention?clear=1");
  await control("reset?scenario=all");
});

test("POS clients: usage columns, watch list and Check watched clients", async ({
  page,
}) => {
  test.setTimeout(270000);
  await control("reset?scenario=all");
  await control("worker?state=online");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ownerIn(page, "r");
  await page.goto("/pos-clients");
  await expect(
    page.getByRole("heading", { name: "POS clients", level: 1 }),
  ).toBeVisible();
  for (const name of ["Watch", "Site", "DB", "Workers", "Checked"])
    await expect(
      page.getByRole("columnheader", { name, exact: true }),
    ).toBeVisible();
  // Seeded results: the critical client is an urgent row.
  await expect(row(page, "ui-usage-full")).toHaveClass(/row-urgent/);
  await expect(await cell(page, "ui-usage-full", "Site")).toContainText("Up");
  await expect(await cell(page, "ui-usage-full", "Site")).toContainText(
    "142 ms",
  );
  await expect(await cell(page, "ui-usage-full", "DB")).toContainText("91%");
  await expect(await cell(page, "ui-usage-full", "DB")).toContainText(
    "Critical",
  );
  await expect(
    (await cell(page, "ui-usage-full", "DB")).locator(".usage-level-critical"),
  ).toBeVisible();
  await expect(await cell(page, "ui-usage-full", "Workers")).toContainText(
    "80%",
  );
  await expect(await cell(page, "ui-usage-full", "Workers")).toContainText(
    "Warning",
  );
  await expect(await cell(page, "ui-usage-full", "Checked")).toContainText(
    "10 min ago",
  );
  await expect(row(page, "ui-usage-ok")).not.toHaveClass(/row-urgent/);
  await expect(await cell(page, "ui-usage-ok", "DB")).toContainText("25%");
  await expect(await cell(page, "ui-usage-ok", "Workers")).toContainText("12%");
  await expect(row(page, "ui-usage-paused")).toHaveClass(/row-urgent/);
  await expect(await cell(page, "ui-usage-paused", "Site")).toContainText(
    "Paused",
  );
  await expect(await cell(page, "ui-usage-paused", "Workers")).toHaveText("—");
  await expect(await cell(page, "ui-usage-never", "Checked")).toHaveText(
    "Not checked",
  );
  await expect(await cell(page, "ui-usage-never", "Site")).toHaveText("—");
  // A client with no usage block at all keeps its old columns untouched.
  await expect(await cell(page, "ui-ready", "Checked")).toHaveText(
    "Not checked",
  );
  await expect(row(page, "ui-ready")).toContainText("Live");
  await expect(page.getByLabel(/^Watch Full Cafe/)).toBeChecked();
  await expect(page.getByLabel(/^Watch Paused Cafe/)).not.toBeChecked();
  const batch = page.getByRole("button", { name: /Check watched clients/ });
  await expect(batch).toHaveText("Check watched clients (4)");
  expect((await axe(page)).violations, "fleet accessibility").toEqual([]);
  await noOverflow(page, "fleet");
  await shots(page, "fleet");
  // The usage columns sit at the right of the scrolling table; the customer
  // column stays in view.
  await page
    .locator(".table-wrap")
    .evaluate((el) => (el.scrollLeft = el.scrollWidth));
  const wrap = await page.locator(".table-wrap").boundingBox();
  const name = await row(page, "ui-usage-full")
    .getByRole("link", { name: "Full Cafe" })
    .boundingBox();
  expect(name.x).toBeGreaterThanOrEqual(wrap.x);
  expect(name.x).toBeLessThan(wrap.x + 60);
  await page.screenshot({
    path: "test-results/usage-fleet-scrolled-1440.png",
    fullPage: true,
  });
  await page.locator(".table-wrap").evaluate((el) => (el.scrollLeft = 0));

  // Keyboard focus never hides under the sticky customer column: a long
  // customer name is capped at the scroll padding that keeps a focused
  // control clear of it. At a narrow (still sticky) width the table scrolls
  // far enough for the Watch box to pass under the column.
  await page.route("**/api/pos/fleet", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.rows.find((r) => r.slug === "ui-usage-full").customerName =
      "Full Cafe and Bakery of the Very Long Customer Name Street";
    await route.fulfill({ response, json });
  });
  await page.reload();
  await page.setViewportSize({ width: 640, height: 950 });
  const fullRow = row(page, "ui-usage-full");
  const sticky = fullRow.locator("td").first(),
    watchBox = fullRow.getByRole("checkbox");
  await expect(sticky).toContainText("Full Cafe and Bakery");
  const padding = await page
    .locator(".table-wrap")
    .evaluate((el) =>
      parseFloat(getComputedStyle(el).scrollPaddingInlineStart),
    );
  expect(padding).toBeGreaterThan(0);
  expect((await sticky.boundingBox()).width).toBeLessThanOrEqual(padding);
  await sticky.getByRole("link").focus();
  // Scrolled so the Watch box sits under the customer column, then Tab to it.
  await page.locator(".table-wrap").evaluate((el) => {
    const box = el
      .querySelector('tr[data-slug="ui-usage-full"]')
      .querySelector('input[type="checkbox"]');
    el.scrollLeft =
      box.getBoundingClientRect().left -
      el.getBoundingClientRect().left +
      el.scrollLeft -
      30;
  });
  const hidden = await watchBox.boundingBox(),
    under = await sticky.boundingBox();
  expect(hidden.x, "Watch box under the customer column").toBeLessThan(
    under.x + under.width,
  );
  await page.keyboard.press("Tab");
  await expect(watchBox).toBeFocused();
  const shown = await watchBox.boundingBox(),
    cover = await sticky.boundingBox();
  expect(
    shown.x,
    "focused Watch box clear of the column",
  ).toBeGreaterThanOrEqual(cover.x + cover.width);
  await page.unroute("**/api/pos/fleet");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();

  // Watch one more client: saved, and still ticked after a reload.
  await page.getByLabel(/^Watch Paused Cafe/).check();
  await expect(page.getByLabel(/^Watch Paused Cafe/)).toBeEnabled();
  await expect(batch).toHaveText("Check watched clients (5)");
  await page.reload();
  await expect(page.getByLabel(/^Watch Paused Cafe/)).toBeChecked();
  await expect(batch).toHaveText("Check watched clients (5)");

  // Check watched clients: five queued, each row says so.
  await batch.click();
  const status = page.locator(".usage-batch-status");
  await expect(status).toContainText("Queued 5, skipped 0.");
  await expect(status).toContainText("Checking: 5 left");
  for (const slug of [
    "ui-usage-ok",
    "ui-usage-full",
    "ui-usage-paused",
    "ui-usage-denied",
    "ui-usage-never",
  ])
    await expect(await cell(page, slug, "Checked")).toHaveText("Queued");
  await expect(await cell(page, "ui-ready", "Checked")).toHaveText(
    "Not checked",
  );
  // No second batch while these run; the hint says why.
  await expect(batch).toBeDisabled();
  await expect(
    page.getByText(
      "Checks are already queued or running. Wait for them to finish.",
    ),
  ).toBeVisible();
  // Fast polling while checks are queued or running: one read every 10 s, so
  // two or three in 25 s (the old 3 s loop made eight).
  const started = Date.now();
  const busyReads = countReads(page, "/pos/fleet");
  // The worker picks one up...
  await control("usage-check?scenario=usagenever&status=running");
  await expect(await cell(page, "ui-usage-never", "Checked")).toHaveText(
    "Checking…",
    { timeout: WORKER_WAIT },
  );
  await page.waitForTimeout(Math.max(0, 25000 - (Date.now() - started)));
  busyReads.stop();
  expect(
    busyReads.count,
    "fleet reads in 25 s while checking",
  ).toBeGreaterThanOrEqual(2);
  expect(
    busyReads.count,
    "fleet reads in 25 s while checking",
  ).toBeLessThanOrEqual(4);
  // ...and finishes them all: the page polls fast and updates on its own.
  await control("usage-finish");
  await expect(await cell(page, "ui-usage-never", "Checked")).toHaveText(
    "just now",
    { timeout: WORKER_WAIT },
  );
  await expect(await cell(page, "ui-usage-never", "Site")).toContainText("Up");
  await expect(await cell(page, "ui-usage-never", "DB")).toContainText("25%");
  await expect(await cell(page, "ui-usage-full", "Checked")).toHaveText(
    "just now",
  );
  await expect(status).not.toContainText("Checking:");
  await expect(batch).toBeEnabled();
  // Done: the fast loop has stopped. Only the normal cadence is left: 15 s
  // while a seeded deploy runs (one read in the 25 s after the last answer),
  // else 60 s; a 10 s loop still running would add a second read.
  const idleReads = countReads(page, "/pos/fleet");
  await page.waitForTimeout(25000);
  idleReads.stop();
  expect(
    idleReads.count,
    "fleet reads in 25 s after the checks",
  ).toBeLessThanOrEqual(1);
  await expect(page.getByText(WAITING, { exact: true })).toHaveCount(0);

  // A long batch: a check still queued while the server says nothing has
  // stalled (another one runs) shows no waiting notice; the page has no clock
  // rule of its own. A retired client is not counted (shape from the real
  // response).
  const stuckRow = (json, stalled) => {
    const stuck = json.rows.find((r) => r.slug === "ui-usage-ok");
    stuck.usage = { ...stuck.usage, check: "queued" };
    json.usageStalled = stalled;
  };
  await page.route("**/api/pos/fleet", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    stuckRow(json, false);
    const retired = json.rows.find((r) => r.slug === "ui-usage-full");
    retired.installationStatus = "retired";
    retired.usage = { ...retired.usage, batchable: false };
    await route.fulfill({ response, json });
  });
  await page.reload();
  await expect(status).toContainText("Checking: 1 left");
  await expect(await cell(page, "ui-usage-ok", "Checked")).toHaveText("Queued");
  await expect(batch).toHaveText("Check watched clients (4)");
  await expect(page.getByText(WAITING, { exact: true })).toHaveCount(0);
  await page.unroute("**/api/pos/fleet");

  // Stalled by the server's answer: a waiting notice (announced politely),
  // no fast polling; and the 100-row cap says what a batch covers.
  await page.route("**/api/pos/fleet", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    stuckRow(json, true);
    json.limited = true;
    await route.fulfill({ response, json });
  });
  await page.reload();
  const waiting = page.getByText(WAITING, { exact: true });
  await expect(waiting).toBeVisible();
  await expect(
    page.locator('[aria-live="polite"]').filter({ has: waiting }),
  ).toHaveCount(1);
  await expect(await cell(page, "ui-usage-ok", "Checked")).toHaveText("Queued");
  await expect(batch).toBeDisabled();
  const limitedText = page.getByText(
    "Showing the first 100 POS clients; a batch checks every watched client.",
  );
  await expect(limitedText).toBeVisible();
  await expect(
    page.locator('[aria-live="polite"]').filter({ has: limitedText }),
  ).toHaveCount(1);
  expect((await axe(page)).violations, "waiting fleet accessibility").toEqual(
    [],
  );
  // The fast loop has stopped: at most the normal 15 s read in 25 s (a 10 s
  // loop would add a second).
  const stalledReads = countReads(page, "/pos/fleet");
  await page.waitForTimeout(25000);
  stalledReads.stop();
  expect(
    stalledReads.count,
    "fleet reads in 25 s while stalled",
  ).toBeLessThanOrEqual(1);
  await expect(waiting).toBeVisible();
  await page.unroute("**/api/pos/fleet");
  await page.reload();
  await expect(page.getByText(WAITING, { exact: true })).toHaveCount(0);
  await expect(batch).toBeEnabled();

  // Untick everyone: the button is disabled with a hint.
  for (const name of [
    "Usage Ok Cafe",
    "Full Cafe",
    "Paused Cafe",
    "Denied Cafe",
    "Never Cafe",
  ]) {
    const box = page.getByLabel(new RegExp(`^Watch ${name}`));
    await box.uncheck();
    await expect(box).toBeEnabled();
  }
  await expect(batch).toHaveText("Check watched clients (0)");
  await expect(batch).toBeDisabled();
  await expect(
    page.getByText("Tick Watch for the clients you want to check."),
  ).toBeVisible();
  // Only the first 100 clients listed: watched ones may be hidden, so the
  // count is unknown and the button stays usable (the server decides).
  await page.route("**/api/pos/fleet", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.limited = true;
    await route.fulfill({ response, json });
  });
  await page.reload();
  await expect(batch).toHaveText("Check watched clients");
  await expect(batch).toBeEnabled();
  await expect(
    page.getByText("Tick Watch for the clients you want to check."),
  ).toHaveCount(0);
  await batch.click();
  await expect(page.getByRole("alert")).toContainText(
    "No clients are on the watch list.",
  );
  await page.unroute("**/api/pos/fleet");
  expect(errors).toEqual([]);
});

test("Usage tab: meters, notices, the honest Vercel box, Check now and worker offline", async ({
  page,
}) => {
  test.setTimeout(180000);
  await control("reset?scenario=all");
  await control("worker?state=online");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ownerIn(page, "s");
  // Never checked: the empty state, reached through the new tab.
  await page.goto(`/installations/${iid("ready")}/deploy`);
  await page
    .getByRole("navigation", { name: "Installation navigation" })
    .getByRole("link", { name: "Usage" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Usage", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Not checked yet")).toBeVisible();
  await expect(page.getByRole("meter")).toHaveCount(0);

  // Storage critical: one meter per cluster, value and level as text.
  await page.goto(usageUrl("usagefull"));
  await expect(
    page.getByRole("heading", { name: "Usage", level: 1 }),
  ).toBeVisible();
  const core = page.getByRole("meter", { name: "core storage" });
  await expect(core).toHaveAttribute("aria-valuenow", "91");
  await expect(core).toHaveAttribute("aria-valuemin", "0");
  await expect(core).toHaveAttribute("aria-valuemax", "100");
  await expect(core).toHaveAttribute(
    "aria-valuetext",
    "466 MB of 512 MB · 91% · Critical",
  );
  await expect(
    page.getByText("466 MB of 512 MB · 91% · Critical", { exact: true }),
  ).toBeVisible();
  const ledger = page.getByRole("meter", { name: "ledger-a storage" });
  await expect(ledger).toHaveAttribute(
    "aria-valuetext",
    "154 MB of 512 MB · 30%",
  );
  await expect(page.locator(".usage-cluster").nth(1)).toContainText("Ledger A");
  await expect(page.locator(".usage-cluster").nth(1)).toContainText("Active");
  await expect(page.getByText("From the POS health stats")).toBeVisible();
  const workers = page.getByRole("meter", { name: "Worker requests today" });
  await expect(workers).toHaveAttribute(
    "aria-valuetext",
    "80,000 of 100,000 requests today · 80% · Warning",
  );
  await expect(page.getByText(/Resets daily at 05:30 IST/)).toBeVisible();
  await expect(page.getByText(/Yesterday: 61,000 requests/)).toBeVisible();
  // Overall level and the alerts of this check.
  const result = page.locator("section", {
    has: page.getByRole("heading", { name: "Latest result" }),
  });
  await expect(result.locator(".badge").first()).toHaveText("Critical");
  await expect(result).toContainText("Checked ");
  const alerts = page.locator(".usage-alerts li");
  await expect(alerts).toHaveCount(2);
  await expect(alerts.nth(0)).toContainText("Database storage");
  await expect(alerts.nth(0)).toContainText("Critical");
  await expect(alerts.nth(0)).toContainText(
    "core at 91% of 512 MB (466 MB used)",
  );
  await expect(alerts.nth(1)).toContainText("Cloudflare Worker requests");
  await expect(alerts.nth(1)).toContainText("Warning");
  // Vercel Hobby: honest about what is not measured.
  await expect(
    page.getByText(
      "Vercel shows no usage numbers on the Hobby plan, so bandwidth, CPU and invocations are not measured here.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(page.getByText("Fast data transfer")).toBeVisible();
  await expect(page.getByText("100 GB / month")).toBeVisible();
  await expect(page.getByText("No expiry")).toBeVisible();
  await expect(page.getByLabel("Watch this client")).toBeChecked();
  expect((await axe(page)).violations, "usage tab accessibility").toEqual([]);
  await noOverflow(page, "usage tab");
  await shots(page, "tab");

  // Stats denied → direct check, Cloudflare permission missing, a token soon
  // to expire.
  await page.goto(usageUrl("usagedenied"));
  const denied = describeUsageCode("stats-denied");
  await expect(page.getByText(denied.title, { exact: true })).toBeVisible();
  await expect(page.getByText(denied.action)).toBeVisible();
  await expect(
    page.getByText("Direct check — core cluster only"),
  ).toBeVisible();
  const cf = describeUsageCode("cf-denied");
  await expect(page.getByText(cf.title, { exact: true })).toBeVisible();
  await expect(page.getByText(cf.action)).toBeVisible();
  await expect(
    page.getByRole("meter", { name: "Worker requests today" }),
  ).toHaveCount(0);
  const tokens = page.locator(".usage-tokens");
  await expect(tokens).toContainText("Expires in 10 days");
  await expect(tokens).toContainText("Warning");
  expect((await axe(page)).violations, "denied tab accessibility").toEqual([]);

  // Paused by Vercel.
  await page.goto(usageUrl("usagepaused"));
  await expect(page.locator(".usage-site .badge").first()).toHaveText("Paused");
  await expect(
    page
      .locator(".usage-site")
      .getByText(describeUsageCode("paused").title, { exact: true }),
  ).toBeVisible();

  // Check now: queued, then the button waits for the worker.
  await page.goto(usageUrl("usagefull"));
  const checkNow = page.getByRole("button", { name: "Check now" });
  await checkNow.click();
  await expect(page.locator(".usage-check-status")).toContainText("Queued");
  await expect(checkNow).toBeDisabled();
  await control("usage-check?scenario=usagefull&status=running");
  await expect(page.locator(".usage-check-status")).toContainText("Checking…", {
    timeout: WORKER_WAIT,
  });
  await control("usage-finish");
  await expect(page.locator(".usage-check-status")).toContainText(
    "Finished just now",
    { timeout: WORKER_WAIT },
  );
  await expect(checkNow).toBeEnabled();

  // Queued, then the worker goes offline: the tab stops polling fast (5 s)
  // and says it is waiting.
  await page.goto(usageUrl("usagepaused"));
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.locator(".usage-check-status")).toContainText("Queued");
  await expect(page.getByText(WAITING, { exact: true })).toHaveCount(0);
  await control("worker?state=offline");
  try {
    // One notice: the offline one (announced politely), not also "queued but
    // not running".
    const offline = page.getByText(/The background worker is offline/);
    await expect(offline).toBeVisible({ timeout: WORKER_WAIT });
    await expect(page.locator(".usage-status .notice")).toHaveCount(1);
    await expect(
      page.locator('[aria-live="polite"]').filter({ has: offline }),
    ).toHaveCount(1);
    await expect(page.getByText(WAITING, { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Check now" }),
    ).toBeDisabled();
    const reads = countReads(
      page,
      `/installations/${iid("usagepaused")}/pos/usage`,
    );
    await page.waitForTimeout(12000);
    reads.stop();
    // A 5 s loop would read twice in 12 s; the idle cadence is 60 s.
    expect(
      reads.count,
      "usage reads in 12 s while waiting",
    ).toBeLessThanOrEqual(1);
    expect((await axe(page)).violations, "waiting tab accessibility").toEqual(
      [],
    );
  } finally {
    await control("worker?state=online");
  }

  // Worker online but the server says the queued check has stalled: the
  // waiting notice alone, announced politely. Never for a running check.
  const usageApi = `**/api/installations/${iid("usagepaused")}/pos/usage`;
  const tabAnswer = (change) =>
    page.route(usageApi, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      change(json);
      await route.fulfill({ response, json });
    });
  await tabAnswer((json) => {
    json.stalled = true;
  });
  await page.reload();
  const waitingTab = page.getByText(WAITING, { exact: true });
  await expect(waitingTab).toBeVisible();
  await expect(page.locator(".usage-check-status")).toContainText("Queued");
  await expect(page.locator(".usage-status .notice")).toHaveCount(1);
  await expect(
    page.locator('[aria-live="polite"]').filter({ has: waitingTab }),
  ).toHaveCount(1);
  await page.unroute(usageApi);
  await tabAnswer((json) => {
    json.check = {
      ...json.check,
      status: "running",
      startedAt: json.check.requestedAt,
    };
    json.stalled = true;
  });
  await page.reload();
  await expect(page.locator(".usage-check-status")).toContainText("Checking…");
  await expect(page.getByText(WAITING, { exact: true })).toHaveCount(0);
  await expect(page.locator(".usage-status .notice")).toHaveCount(0);
  await page.unroute(usageApi);

  // Worker offline: the API refuses (503) and the page says why.
  await page.goto(usageUrl("usagedenied"));
  await expect(page.getByRole("button", { name: "Check now" })).toBeEnabled();
  await control("worker?state=offline");
  try {
    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "The worker is offline",
    );
    await expect(
      page.getByText(/The background worker is offline/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Check now" }),
    ).toBeDisabled();
  } finally {
    await control("worker?state=online");
  }
  expect(errors).toEqual([]);
});

test("dashboard: usage and build-cache retention attention items", async ({
  page,
}) => {
  test.setTimeout(120000);
  await control("reset?scenario=all");
  await control("worker?state=online");
  await control("retention?failed=2&missing=1&hours=2");
  await ownerIn(page, "t");
  const critical = page.getByRole("link", { name: /POS usage critical/ });
  const retention = page.getByRole("link", {
    name: /Build-cache retention failed/,
  });
  // The overview is cached for 5 s server side: reload until it shows.
  await reloadUntil(page, () => retention.isVisible());
  await expect(critical).toBeVisible();
  await expect(critical).toHaveClass(/attention-urgent/);
  // Each client's own latest check: no "newest check" age beside the count.
  await expect(critical).toContainText(
    "1 client critical in their latest check.",
  );
  await expect(critical).not.toContainText("ago");
  await expect(critical).toHaveAttribute("href", "/pos-clients");
  const warning = page.getByRole("link", { name: /POS usage warning/ });
  await expect(warning).toBeVisible();
  await expect(warning).not.toHaveClass(/attention-urgent/);
  await expect(retention).toHaveClass(/attention-urgent/);
  await expect(retention).toContainText("3 builds could not be kept");
  await expect(
    page.getByRole("link", { name: /Usage not checked recently/ }),
  ).toHaveCount(0);
  expect((await axe(page)).violations, "dashboard accessibility").toEqual([]);
  // Stale checks and a sweep that stopped (shape from the real response).
  const day = 86400000;
  await page.route("**/api/overview", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.usage = {
      watched: 3,
      critical: 0,
      warning: 0,
      lastCheckAt: new Date(Date.now() - 9 * day).toISOString(),
    };
    json.retention = {
      failed: 0,
      missing: 0,
      at: new Date(Date.now() - 3 * day).toISOString(),
    };
    json.pos = { ...json.pos, workerOnline: true };
    await route.fulfill({ response, json });
  });
  await page.reload();
  const stale = page.getByRole("link", { name: /Usage not checked recently/ });
  await expect(stale).toBeVisible();
  await expect(stale).toContainText(
    "Last check 9 days ago — run Check watched clients.",
  );
  await expect(
    page.getByRole("link", { name: /Build-cache retention has not run/ }),
  ).toBeVisible();
  await expect(critical).toHaveCount(0);
  await expect(retention).toHaveCount(0);
  await page.unroute("**/api/overview");
  await stale.click();
  await expect(
    page.getByRole("heading", { name: "POS clients", level: 1 }),
  ).toBeVisible();
});
