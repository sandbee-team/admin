import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  roundDiv,
  allocate,
  computeTotals,
  formatPaise,
  formatQty,
  formatPercent,
  amountInWords,
  fyOf,
  docNumber,
  validGstin,
  stateName,
  STATES,
  normalizeText,
  unprintable,
  renderTemplate,
  unknownPlaceholders,
  istDate,
  formatDate,
  parseRupees,
  parseQty,
  parsePercent,
  paiseText,
  localTaxLabel,
  taxNoteOf,
  PLACEHOLDERS,
} from "../shared/sales.js";
import { salesSchemas, DEFAULT_TEMPLATES } from "../shared/sales-schemas.js";

const line = (over = {}) => ({
  id: "l1",
  productId: "",
  description: "Item",
  sac: "998314",
  unit: "nos",
  qty: 1000,
  unitPrice: 100000,
  discount: { type: "none", value: 0 },
  gstRate: 1800,
  ...over,
});
const MH = "27",
  GJ = "24";

describe("rounding and allocation", () => {
  it("rounds half up on BigInt", () => {
    assert.equal(roundDiv(5n, 10n), 1n);
    assert.equal(roundDiv(4n, 10n), 0n);
    assert.equal(roundDiv(15n, 10n), 2n);
    assert.equal(roundDiv(14n, 10n), 1n);
    assert.equal(roundDiv(0n, 7n), 0n);
  });
  it("spreads by largest remainder; parts add up exactly; ties go to the earlier line", () => {
    assert.deepEqual(allocate(100n, [1000n, 1000n, 1000n]), [34n, 33n, 33n]);
    assert.deepEqual(allocate(49950n, [900000n, 99000n]), [45000n, 4950n]);
    assert.deepEqual(allocate(0n, [5n, 5n]), [0n, 0n]);
    assert.deepEqual(allocate(0n, [0n, 0n]), [0n, 0n]);
    const parts = allocate(997n, [3n, 7n, 11n, 13n, 0n]);
    assert.equal(
      parts.reduce((a, b) => a + b, 0n),
      997n,
    );
    assert.equal(parts[4], 0n);
  });
});

describe("computeTotals", () => {
  it("intra-state: CGST + SGST half each", () => {
    const t = computeTotals(
      {
        lines: [line({ qty: 2000, unitPrice: 150000 })],
        discount: { type: "none", value: 0 },
        placeOfSupply: MH,
      },
      { sellerState: MH, roundOff: true },
    );
    assert.equal(t.intra, true);
    assert.equal(t.gross, 300000);
    assert.equal(t.taxable, 300000);
    assert.equal(t.cgst, 27000);
    assert.equal(t.sgst, 27000);
    assert.equal(t.igst, 0);
    assert.equal(t.total, 354000);
    assert.equal(t.roundOff, 0);
    assert.equal(t.payable, 354000);
  });
  const discounted = {
    lines: [
      line({
        id: "a",
        qty: 1000,
        unitPrice: 1000000,
        discount: { type: "percent", value: 1000 },
      }),
      line({
        id: "b",
        qty: 3000,
        unitPrice: 33333,
        discount: { type: "amount", value: 999 },
      }),
    ],
    discount: { type: "percent", value: 500 },
    placeOfSupply: MH,
  };
  it("line percent + line amount + overall percent discounts, intra", () => {
    const t = computeTotals(discounted, { sellerState: MH, roundOff: true });
    assert.deepEqual(
      t.lines.map((l) => [l.gross, l.discount, l.net, l.share, l.taxable]),
      [
        [1000000, 100000, 900000, 45000, 855000],
        [99999, 999, 99000, 4950, 94050],
      ],
    );
    assert.deepEqual(
      t.lines.map((l) => [l.cgst, l.sgst, l.igst, l.tax, l.amount]),
      [
        [76950, 76950, 0, 153900, 1008900],
        [8465, 8465, 0, 16930, 110980],
      ],
    );
    assert.equal(t.gross, 1099999);
    assert.equal(t.lineDiscount, 100999);
    assert.equal(t.net, 999000);
    assert.equal(t.overallDiscount, 49950);
    assert.equal(t.taxable, 949050);
    assert.equal(t.tax, 170830);
    assert.equal(t.total, 1119880);
    assert.equal(t.roundOff, 20);
    assert.equal(t.payable, 1119900);
    assert.deepEqual(t.rates, [
      { rate: 1800, taxable: 949050, cgst: 85415, sgst: 85415, igst: 0 },
    ]);
  });
  it("inter-state: IGST, rounding off downward too", () => {
    const t = computeTotals(discounted, { sellerState: GJ, roundOff: true });
    assert.equal(t.intra, false);
    assert.deepEqual(
      t.lines.map((l) => l.igst),
      [153900, 16929],
    );
    assert.equal(t.cgst + t.sgst, 0);
    assert.equal(t.total, 1119879);
    assert.equal(t.payable, 1119900);
    assert.equal(t.roundOff, 21);
    const down = computeTotals(
      {
        lines: [line({ unitPrice: 10042, gstRate: 0 })],
        discount: { type: "amount", value: 0 },
        placeOfSupply: GJ,
      },
      { sellerState: MH, roundOff: true },
    );
    assert.equal(down.total, 10042);
    assert.equal(down.roundOff, -42);
    assert.equal(down.payable, 10000);
  });
  it("a seller without GST registration charges no tax (CGST Act s.32)", () => {
    for (const sellerState of [MH, GJ, ""]) {
      const t = computeTotals(discounted, {
        sellerState,
        roundOff: true,
        registered: false,
      });
      assert.equal(t.registered, false);
      assert.deepEqual(
        t.lines.map((l) => [
          l.taxable,
          l.cgst,
          l.sgst,
          l.igst,
          l.tax,
          l.amount,
        ]),
        [
          [855000, 0, 0, 0, 0, 855000],
          [94050, 0, 0, 0, 0, 94050],
        ],
      );
      assert.equal(t.tax, 0);
      assert.equal(t.total, 949050);
      assert.equal(t.roundOff, 50);
      assert.equal(t.payable, 949100);
      assert.deepEqual(t.rates, []);
    }
    // Registered stays the default, so older callers keep charging GST.
    assert.equal(
      computeTotals(discounted, { sellerState: MH, roundOff: true }).registered,
      true,
    );
  });
  it("round-off off keeps exact paise", () => {
    const t = computeTotals(discounted, { sellerState: MH, roundOff: false });
    assert.equal(t.roundOff, 0);
    assert.equal(t.payable, 1119880);
  });
  it("fractional quantity, overall amount discount spread, mixed rates", () => {
    const t = computeTotals(
      {
        lines: [
          line({ qty: 1500, unitPrice: 99999, gstRate: 1800 }),
          line({ qty: 1000, unitPrice: 50001, gstRate: 500 }),
        ],
        discount: { type: "amount", value: 1000 },
        placeOfSupply: MH,
      },
      { sellerState: MH, roundOff: false },
    );
    assert.equal(t.lines[0].gross, 149999);
    // shares: 1000 × 149999/200000 = 749.995 → 749 (+1 by largest remainder: .995 > .005)
    assert.deepEqual(
      t.lines.map((l) => l.share),
      [750, 250],
    );
    assert.equal(t.overallDiscount, 1000);
    assert.equal(t.rates.length, 2);
    assert.deepEqual(
      t.rates.map((r) => r.rate),
      [500, 1800],
    );
    // 149249 × 9 % = 13432.41 → 13432; 49751 × 2.5 % = 1243.775 → 1244
    assert.deepEqual(
      t.lines.map((l) => l.cgst),
      [13432, 1244],
    );
  });
  it("refuses a discount larger than what it discounts and out-of-range input", () => {
    const bad = (over, discount = { type: "none", value: 0 }) =>
      assert.throws(
        () =>
          computeTotals(
            { lines: [line(over)], discount, placeOfSupply: MH },
            { sellerState: MH, roundOff: true },
          ),
        RangeError,
      );
    bad({ discount: { type: "amount", value: 100001 } });
    bad({ discount: { type: "percent", value: 10001 } });
    bad({}, { type: "amount", value: 100001 });
    bad({ qty: -1 });
    bad({ unitPrice: 1.5 });
    bad({ gstRate: 1700 });
  });
  it("an empty deal totals zero", () => {
    const t = computeTotals(
      { lines: [], discount: { type: "none", value: 0 }, placeOfSupply: MH },
      { sellerState: MH, roundOff: true },
    );
    assert.equal(t.payable, 0);
    assert.deepEqual(t.rates, []);
  });
  it("largest allowed deal stays a safe integer", () => {
    const t = computeTotals(
      {
        lines: Array.from({ length: 50 }, (_, i) =>
          line({
            id: `l${i}`,
            qty: 100000000,
            unitPrice: 1000000000,
            gstRate: 4000,
          }),
        ),
        discount: { type: "none", value: 0 },
        placeOfSupply: MH,
      },
      { sellerState: GJ, roundOff: true },
    );
    assert.ok(Number.isSafeInteger(t.payable));
    assert.equal(t.payable, 7e15);
  });
});

describe("formatting", () => {
  it("formats paise with Indian grouping", () => {
    assert.equal(formatPaise(0), "0.00");
    assert.equal(formatPaise(5), "0.05");
    assert.equal(formatPaise(100000), "1,000.00");
    assert.equal(formatPaise(99999999), "9,99,999.99");
    assert.equal(formatPaise(12345678905), "12,34,56,789.05");
    assert.equal(formatPaise(-20), "-0.20");
  });
  it("formats quantities and percents", () => {
    assert.equal(formatQty(1500), "1.5");
    assert.equal(formatQty(2000), "2");
    assert.equal(formatQty(125), "0.125");
    assert.equal(formatPercent(1800), "18%");
    assert.equal(formatPercent(1250), "12.5%");
    assert.equal(formatPercent(25), "0.25%");
  });
  it("writes amounts in Indian words", () => {
    assert.equal(amountInWords(0), "Rupees Zero Only");
    assert.equal(amountInWords(1), "Rupees Zero and One Paisa Only");
    assert.equal(amountInWords(100), "Rupees One Only");
    assert.equal(
      amountInWords(1119900),
      "Rupees Eleven Thousand One Hundred Ninety-Nine Only",
    );
    assert.equal(
      amountInWords(12345678905),
      "Rupees Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine and Five Paise Only",
    );
    assert.equal(amountInWords(100000000), "Rupees Ten Lakh Only");
    assert.equal(
      amountInWords(1000000000000),
      "Rupees One Thousand Crore Only",
    );
    assert.equal(amountInWords(1111), "Rupees Eleven and Eleven Paise Only");
  });
  it("prints dates in IST, independent of the machine's zone", () => {
    const at = new Date("2026-03-31T18:30:00Z");
    assert.equal(istDate(at), "2026-04-01");
    assert.equal(formatDate(at), "01 Apr 2026");
    assert.equal(formatDate("2026-10-31"), "31 Oct 2026");
  });
});

describe("editor parsing", () => {
  it("parses rupees, quantities and percents exactly, refusing malformed text", () => {
    assert.equal(parseRupees("1,234.5"), 123450);
    assert.equal(parseRupees("1,23,456.78"), 12345678);
    assert.equal(parseRupees("123,456"), 12345600);
    assert.equal(parseRupees(" 10000 "), 1000000);
    assert.equal(parseRupees("0.05"), 5);
    for (const bad of [
      "1,2,3",
      "12,34",
      "1.234",
      "-1",
      "",
      "1e3",
      "abc",
      "1..2",
      ",100",
    ])
      assert.equal(parseRupees(bad), null, bad);
    assert.equal(parseQty("1.5"), 1500);
    assert.equal(parseQty("0.125"), 125);
    assert.equal(parseQty("0.0001"), null);
    assert.equal(parsePercent("12.5"), 1250);
    assert.equal(parsePercent("100"), 10000);
    assert.equal(paiseText(123450), "1234.50");
    assert.equal(paiseText(100), "1");
    assert.equal(paiseText(5), "0.05");
    // Round trip: what the editor shows is what it parses back.
    for (const v of [0, 1, 99, 100, 123456789, 999999999])
      assert.equal(parseRupees(paiseText(v)), v);
  });
  it("names UTGST for union territories without a legislature", () => {
    for (const code of ["04", "25", "26", "31", "35", "38", "97"])
      assert.equal(localTaxLabel(code), "UTGST");
    for (const code of ["07", "34", "01", "27"])
      assert.equal(localTaxLabel(code), "SGST");
  });
});

describe("numbering", () => {
  it("financial year by the IST date", () => {
    assert.deepEqual(fyOf(new Date("2026-03-31T18:29:59Z")), {
      start: 2025,
      label: "25-26",
    });
    assert.deepEqual(fyOf(new Date("2026-03-31T18:30:00Z")), {
      start: 2026,
      label: "26-27",
    });
    assert.deepEqual(fyOf(new Date("2099-12-31T00:00:00Z")), {
      start: 2099,
      label: "99-00",
    });
  });
  it("formats numbers; long sequences grow", () => {
    assert.equal(docNumber("INV/", "26-27", 1), "INV/26-27/0001");
    assert.equal(docNumber("", "26-27", 12345), "26-27/12345");
    assert.equal(docNumber("QT/", "26-27", 7).length, 13);
  });
});

describe("identifiers and text", () => {
  it("checks GSTIN format, checksum and state", () => {
    assert.equal(validGstin("27AAPFU0939F1ZV"), true);
    assert.equal(validGstin("27AAPFU0939F1ZW"), false);
    assert.equal(validGstin("27aapfu0939f1zv"), false);
    assert.equal(validGstin("28AAPFU0939F1ZT"), false);
    assert.equal(validGstin(""), false);
  });
  it("knows the GST state codes", () => {
    assert.equal(stateName("27"), "Maharashtra");
    assert.equal(stateName("38"), "Ladakh");
    assert.equal(stateName("28"), "");
    assert.ok(STATES.every(([code]) => /^\d{2}$/.test(code)));
  });
  it("normalizes the rupee sign and finds characters the PDF cannot print", () => {
    assert.equal(normalizeText("₹500 only\r\n"), "Rs.500 only\n");
    assert.deepEqual(unprintable("Café – “quoted” € • ok"), []);
    assert.deepEqual(unprintable("नमस्ते A"), ["न", "म", "स", "्", "त", "े"]);
    assert.deepEqual(unprintable("a\tb"), ["\t"]);
    assert.deepEqual(unprintable("a\nb", { multiline: true }), []);
    assert.deepEqual(unprintable("a\nb"), ["\n"]);
  });
  it("states whether GST is charged", () => {
    assert.equal(taxNoteOf(true), "GST is charged at the rates shown.");
    assert.equal(
      taxNoteOf(false),
      "GST is not charged: the supplier is not registered under GST.",
    );
    assert.ok(PLACEHOLDERS.includes("tax.note"));
    assert.ok(PLACEHOLDERS.includes("company.jurisdiction"));
  });
  it("renders whitelisted placeholders only", () => {
    assert.equal(
      renderTemplate("Hello {{ client.name }}, {{deal.total}}.", {
        "client.name": "Cafe",
        "deal.total": "Rs. 10.00",
      }),
      "Hello Cafe, Rs. 10.00.",
    );
    assert.equal(renderTemplate("{{client.gstin}}!", {}), "!");
    assert.deepEqual(
      unknownPlaceholders("{{client.nam}} {{ deal.total }} {{x}}"),
      ["client.nam", "x"],
    );
  });
});

describe("schemas", () => {
  const billTo = {
    name: "Cafe Blue",
    address: ["12 MG Road"],
    city: "Pune",
    stateCode: "27",
    pincode: "411001",
    gstin: "27AAPFU0939F1ZV",
    pan: "",
    email: "cafe@example.test",
    phone: "",
  };
  it("accepts a valid deal and refuses unprintable text without echoing it", () => {
    const deal = {
      title: "POS setup",
      billTo,
      placeOfSupply: "27",
      lines: [line()],
      discount: { type: "none", value: 0 },
      validUntil: "2026-10-31",
      notes: "",
    };
    assert.equal(salesSchemas.deal.safeParse(deal).success, true);
    const bad = salesSchemas.deal.safeParse({
      ...deal,
      title: "कैफ़े setup",
    });
    assert.equal(bad.success, false);
    assert.equal(JSON.stringify(bad.error.issues).includes("कैफ़े"), false);
    assert.equal(
      salesSchemas.deal.safeParse({
        ...deal,
        billTo: { ...billTo, gstin: "27AAPFU0939F1ZW" },
      }).success,
      false,
    );
    // GSTIN state must match the bill-to state.
    assert.equal(
      salesSchemas.deal.safeParse({
        ...deal,
        billTo: { ...billTo, stateCode: "24" },
      }).success,
      false,
    );
    assert.equal(
      salesSchemas.deal.safeParse({
        ...deal,
        lines: [line({ discount: { type: "amount", value: 100001 } })],
      }).success,
      false,
    );
    assert.equal(
      salesSchemas.deal.safeParse({ ...deal, extra: 1 }).success,
      false,
    );
    // A description taller than eight lines could not fit a table row.
    assert.equal(
      salesSchemas.deal.safeParse({
        ...deal,
        lines: [line({ description: Array(9).fill("x").join("\n") })],
      }).success,
      false,
    );
  });
  it("defaults to a seller without GST registration, the brand accent and printable texts", () => {
    const base = salesSchemas.settings.parse({});
    assert.equal(base.gst.registered, false);
    assert.equal(base.company.jurisdiction, "");
    assert.equal(base.design.accent, "#355E45");
    assert.equal(
      salesSchemas.settings.parse({ design: { accent: "#1a2b3c" } }).design
        .accent,
      "#1A2B3C",
    );
    for (const accent of ["355E45", "#355E4", "#GGGGGG", "red"])
      assert.equal(
        salesSchemas.settings.safeParse({ design: { accent } }).success,
        false,
        accent,
      );
    // zod does not parse defaults, so the default texts are checked here.
    for (const [key, text] of Object.entries(DEFAULT_TEMPLATES)) {
      assert.deepEqual(unknownPlaceholders(text), [], key);
      assert.deepEqual(unprintable(text, { multiline: true }), [], key);
      assert.equal(base.templates[key], text, key);
      assert.equal(
        salesSchemas.settings.parse({ templates: { [key]: text } }).templates[
          key
        ],
        text,
        key,
      );
      // No address, GSTIN or PAN is assumed: the texts read well without them.
      assert.equal(
        /\{\{\s*(company|client)\.(address|gstin|pan)\s*\}\}/.test(text),
        false,
        key,
      );
      assert.equal(/SAMPLE/.test(text), false, key);
    }
    assert.ok(DEFAULT_TEMPLATES.agreementBody.length <= 20000);
    assert.ok(DEFAULT_TEMPLATES.quotationTerms.length <= 4000);
    assert.ok(DEFAULT_TEMPLATES.invoiceTerms.length <= 4000);
  });
  it("refuses unknown placeholders and long invoice prefixes in settings", () => {
    const base = salesSchemas.settings.parse({});
    assert.equal(base.numbering.invoice.prefix, "INV/");
    assert.equal(
      salesSchemas.settings.safeParse({
        ...base,
        templates: { ...base.templates, quotationTerms: "{{nope}}" },
      }).success,
      false,
    );
    assert.equal(
      salesSchemas.settings.safeParse({
        ...base,
        numbering: { ...base.numbering, invoice: { prefix: "INVOICE" } },
      }).success,
      false,
    );
    assert.equal(
      salesSchemas.settings.safeParse({
        ...base,
        numbering: { ...base.numbering, invoice: { prefix: "IN V" } },
      }).success,
      false,
    );
    // Counters are per type, so equal prefixes would print equal numbers.
    for (const numbering of [
      {
        quotation: { prefix: "SB/" },
        agreement: { prefix: "AG/" },
        invoice: { prefix: "SB/" },
      },
      {
        quotation: { prefix: "" },
        agreement: { prefix: "" },
        invoice: { prefix: "INV/" },
      },
      {
        quotation: { prefix: "QT/" },
        agreement: { prefix: "AG/" },
        invoice: { prefix: "" },
      },
    ])
      assert.equal(
        salesSchemas.settings.safeParse({ ...base, numbering }).success,
        false,
        JSON.stringify(numbering),
      );
    assert.equal(
      salesSchemas.settings.safeParse({
        ...base,
        numbering: {
          quotation: { prefix: "" },
          agreement: { prefix: "A-" },
          invoice: { prefix: "SB/I/" },
        },
      }).success,
      true,
    );
  });
});
