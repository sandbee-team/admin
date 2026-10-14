import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { base32Decode, codeAt, stepAt } from "../../backend/lib/totp.js";
import { fyOf } from "../../shared/sales.js";
import { LOGO } from "../sales-fixtures.js";
// Fixtures in test/ui-server.js: sales-owner-a/b (authenticator DEPLOY_KEY),
// sales-admin, customer ...c5 "Sales Customer" (company Cafe Blue).
const password = "Browser test passphrase 2026!";
const KEY = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
const CUSTOMER = "/customers/00000000-0000-4000-8000-0000000000c5";
const FY = fyOf(new Date()).label;
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
async function ownerIn(page, letter) {
  await emailStep(page, `sales-owner-${letter}@example.test`);
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
async function signIn(page, who) {
  await emailStep(page, who);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
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
async function choose(scope, name, option) {
  await scope.getByRole("combobox", { name, exact: true }).click();
  // A Locator knows its page; a Page is its own.
  const page = typeof scope.page === "function" ? scope.page() : scope;
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function noViolations(page, label) {
  const { violations } = await axe(page);
  expect(
    violations.map(
      (v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target).join(" ")}`,
    ),
  ).toEqual([]);
}

test.describe.configure({ mode: "serial" });

test("owner fills Sales settings with step-up and uploads a logo", async ({
  page,
}) => {
  await ownerIn(page, "a");
  await page.getByRole("link", { name: "Sales settings" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Sales settings", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText(/Missing before documents can be issued/),
  ).toBeVisible();
  // Not registered under GST (the default): no GSTIN, SAC or rate fields.
  await expect(page.getByLabel("GSTIN")).toHaveCount(0);
  await expect(page.getByLabel("Default SAC")).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Default GST rate", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("switch")).not.toBeChecked();
  await page
    .getByLabel("Legal name")
    .fill("Sandbee Technologies Private Limited");
  await page.getByLabel("Company e-mail").fill("accounts@example.test");
  await page.getByLabel("Phone").fill("+91 20 0000 0000");
  await page.getByLabel("Jurisdiction city").fill("Pune");
  // A text that still speaks of GST is flagged; Restore brings the default back.
  const warning = page.getByText(
    "This text mentions GST, but you are not registered under GST.",
  );
  await page
    .getByRole("textbox", { name: "Quotation terms" })
    .fill("1. GST is charged at the rates shown.");
  await expect(warning).toBeVisible();
  await page
    .getByRole("button", { name: "Restore default text: Quotation terms" })
    .click();
  await expect(warning).toHaveCount(0);
  await page.getByLabel("Account number").fill("000123456789");
  await page.getByRole("button", { name: "Save settings" }).click();
  await confirmStepUp(page);
  await expect(page.getByText(/^Saved .* by sales owner a$/)).toBeVisible();
  await expect(
    page.getByText(/Missing before documents can be issued/),
  ).toHaveCount(0);

  // A deal without GST: no place of supply, SAC or rate, and no tax rows.
  await page.goto(`${CUSTOMER}/sales`);
  // The same GST warning on a client's own text copy.
  await page
    .getByRole("checkbox", { name: "Custom text for this client" })
    .first()
    .check();
  await page
    .getByRole("textbox", { name: "Quotation terms (this client)" })
    .fill("1. GST is charged at the rates shown.");
  await expect(
    page.getByText(
      "This text mentions GST, but you are not registered under GST.",
    ),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Custom text for this client" })
    .first()
    .uncheck();
  await page.getByRole("button", { name: "Save billing details" }).click();
  await expect(page.getByText(/Billing details saved/)).toBeVisible();
  await page.getByRole("button", { name: "New deal" }).click();
  await page.getByLabel("Deal title").fill("Plain deal");
  await page.getByRole("button", { name: "Create deal" }).click();
  await expect(page.getByRole("heading", { name: "Plain deal" })).toBeVisible();
  await expect(page.getByLabel("Place of supply")).toHaveCount(0);
  await page.getByRole("button", { name: "Add free line" }).click();
  const plain = page.getByRole("group", { name: "Line 1" });
  await plain.getByLabel("Description").fill("Setup");
  await plain.getByLabel("Unit price (Rs.)").fill("1000");
  await expect(plain.getByLabel("SAC")).toHaveCount(0);
  await expect(
    plain.getByRole("combobox", { name: "GST rate", exact: true }),
  ).toHaveCount(0);
  const plainTotals = page.getByLabel("Totals");
  await expect(plainTotals).toContainText("Rs. 1,000.00");
  await expect(plainTotals).not.toContainText("CGST");
  await expect(plainTotals).not.toContainText("IGST");
  await expect(plainTotals).not.toContainText("Taxable value");
  await expect(
    page.getByText("GST not charged - not registered under GST."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Issue tax invoice" }),
  ).toHaveCount(0);
  await noViolations(page, "deal without GST");
  await noOverflow(page, "Deal without GST");
  await page.getByRole("button", { name: "Save deal" }).click();
  await expect(page.getByText("Saved draft", { exact: true })).toBeVisible();

  // Registering turns GSTIN, SAC and rate back on; the company then needs an
  // address, a state and a GSTIN.
  await page.getByRole("link", { name: "Sales settings" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Sales settings", level: 1 }),
  ).toBeVisible();
  await page.getByRole("switch").check();
  await expect(page.getByLabel("GSTIN")).toBeVisible();
  await expect(page.getByLabel("Default SAC")).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Default GST rate", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Address")
    .fill("Office 4, Example Business Park\nBaner Road");
  await page.getByLabel("City", { exact: true }).fill("Pune");
  await page.getByLabel("PIN code").fill("411045");
  await choose(page, "State", "Maharashtra (27)");
  await page.getByLabel("GSTIN").fill("27AAACS9999K1ZD");
  await page.getByLabel("IFSC").fill("HDFC0000001");
  await page.getByLabel("UPI ID").fill("sandbee@examplebank");
  await page.getByLabel("Signatory name").fill("A. Founder");
  await expect(page.getByText(`Next new number: INV/${FY}/0001`)).toBeVisible();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(/^Saved .* by sales owner a$/)).toBeVisible();
  await expect(
    page.getByText(/Missing before documents can be issued/),
  ).toHaveCount(0);
  // Logo: the step-up of the first save is still fresh, so no second prompt.
  await page
    .getByLabel("Upload logo")
    .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: LOGO });
  await expect(page.getByText("PNG, 120 × 48, 1 KB")).toBeVisible();
  await noViolations(page, "settings");
  await noOverflow(page, "Sales settings");
  // A GSTIN on file stays visible (and clearable) while not registered.
  await page.getByRole("switch").uncheck();
  await expect(page.getByLabel("GSTIN")).toBeVisible();
  await expect(
    page.getByText("Not printed while you are not registered under GST."),
  ).toBeVisible();
});

test("admin builds a deal with discounts and issues quotation, agreement and invoice", async ({
  page,
}) => {
  // Three issues, a download, an e-mail, two accessibility scans and eight
  // viewport checks: more than the default 30 s on a slow machine.
  test.setTimeout(120000);
  await signIn(page, "sales-admin@example.test");
  // Settings are the owner's: an admin reads them only.
  await page.getByRole("link", { name: "Sales settings" }).first().click();
  await expect(
    page.getByText("Only an owner can change these settings"),
  ).toBeVisible();
  await expect(page.getByLabel("Legal name")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Upload logo")).toHaveCount(0);
  await page.goto(`${CUSTOMER}/sales`);
  await expect(
    page.getByRole("heading", { name: "Sales", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Plain deal")).toBeVisible();
  await page.getByRole("button", { name: "New deal" }).click();
  await page.getByLabel("Deal title").fill("POS setup and support");
  await page.getByRole("button", { name: "Create deal" }).click();
  await expect(
    page.getByRole("heading", { name: "POS setup and support" }),
  ).toBeVisible();
  // Bill-to starts from the customer record; the state sets the place of supply.
  await expect(page.getByLabel("Client name")).toHaveValue("Cafe Blue");
  await choose(page, "State", "Maharashtra (27)");
  await page.getByLabel("GSTIN").fill("27AABCC1234D1ZB");
  await expect(
    page.getByText("Same state as the company: CGST + SGST."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add free line" }).click();
  const one = page.getByRole("group", { name: "Line 1" });
  await one.getByLabel("Description").fill("Sandbee POS one-time setup");
  await one.getByLabel("Unit price (Rs.)").fill("10000");
  await choose(one, "Discount", "Percent (%)");
  await one.getByLabel("Discount %").fill("10");
  await page.getByRole("button", { name: "Add free line" }).click();
  const two = page.getByRole("group", { name: "Line 2" });
  await two.getByLabel("Description").fill("Support hours");
  await two.getByLabel("Quantity").fill("3");
  await two.getByLabel("Unit", { exact: true }).fill("hours");
  await two.getByLabel("Unit price (Rs.)").fill("333.33");
  await choose(two, "Discount", "Amount (Rs.)");
  await two.getByLabel("Discount (Rs.)").fill("9.99");
  await choose(page, "Overall discount", "Percent (%)");
  await page.getByLabel("Overall discount %").fill("5");
  const totals = page
    .getByRole("definition")
    .filter({ hasText: "Rs. 11,199.00" });
  await expect(totals).toBeVisible();
  await expect(page.getByLabel("Totals")).toContainText(
    "Overall discount (5%)",
  );
  await expect(page.getByLabel("Totals")).toContainText("Rs. 854.15");
  await page.getByRole("button", { name: "Save deal" }).click();
  await expect(page.getByText("Saved draft", { exact: true })).toBeVisible();
  await noViolations(page, "deal");
  await noOverflow(page, "Deal editor");

  await page.getByRole("button", { name: "Issue quotation" }).click();
  await expect(
    page.getByText(
      `Quotation QT/${FY}/0001 v1 issued. A copy is stored in Files.`,
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Finalise deal" }).click();
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Title")).toBeDisabled();
  await page.getByRole("button", { name: "Issue agreement" }).click();
  await expect(
    page.getByText(`Agreement AG/${FY}/0001 v1 issued.`, { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Issue tax invoice" }).click();
  const confirm = page.locator("dialog[open]");
  await expect(
    confirm.getByText("It takes the next invoice number"),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Issue tax invoice" }).click();
  await expect(
    page.getByText(`Tax invoice INV/${FY}/0001 issued.`, { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Issue tax invoice" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Reopen as draft" }),
  ).toBeDisabled();
  // Cancelling is the owner's (billing); an admin never sees the button.
  await expect(page.getByRole("button", { name: /^Cancel INV/ })).toHaveCount(
    0,
  );
  // The locked deal with its documents table and actions.
  await noViolations(page, "final deal");
  await noOverflow(page, "Final deal");

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: `Download INV/${FY}/0001` }).click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe(`invoice-INV-${FY}-0001.pdf`);
  expect(
    readFileSync(await file.path())
      .subarray(0, 5)
      .toString(),
  ).toBe("%PDF-");

  await page.getByRole("button", { name: `E-mail INV/${FY}/0001` }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByLabel("To")).toHaveValue("cafe-blue@example.test");
  await dialog
    .getByLabel("Message (optional)")
    .fill("Thank you for your business.");
  await dialog.getByRole("button", { name: "Send e-mail" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("E-mailed 1×")).toBeVisible();
  const mail = JSON.parse(readFileSync("test-results/sales-mail.json", "utf8"));
  expect(mail).toMatchObject({
    to: ["cafe-blue@example.test"],
    filename: `invoice-INV-${FY}-0001.pdf`,
    pdf: "%PDF-",
  });

  await page.goto(`${CUSTOMER}/sales`);
  const issued = page.getByRole("table", { name: "Issued documents" });
  await expect(issued.getByRole("row")).toHaveCount(4);
  await noViolations(page, "sales tab");
  await noOverflow(page, "Customer sales tab");
  await page.goto(`${CUSTOMER}/files`);
  await expect(page.getByText(`invoice-INV-${FY}-0001.pdf`)).toBeVisible();
});

test("owner cancels the invoice with a reason after a step-up", async ({
  page,
}) => {
  await ownerIn(page, "b");
  await page.goto(`${CUSTOMER}/sales`);
  await page.getByRole("button", { name: `Cancel INV/${FY}/0001` }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.getByLabel("Reason").fill("Issued to the wrong GSTIN");
  await dialog.getByRole("button", { name: "Cancel document" }).click();
  await confirmStepUp(page);
  await expect(
    page
      .getByRole("table", { name: "Issued documents" })
      .getByText("cancelled", { exact: true }),
  ).toBeVisible();
});

test("viewer sees neither the sales tab content nor Sales settings", async ({
  page,
}) => {
  await signIn(page, "viewer@example.test");
  await expect(page.getByRole("link", { name: "Sales settings" })).toHaveCount(
    0,
  );
  await page.goto(`${CUSTOMER}/sales`);
  await expect(page.getByText("Sales documents are restricted")).toBeVisible();
  await noViolations(page, "restricted");
});
