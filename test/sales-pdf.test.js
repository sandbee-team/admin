import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import {
  PdfDocument,
  A4,
  textWidth,
  wrap,
  encode,
} from "../backend/lib/pdf.js";
import { WIDTHS, FIRST } from "../backend/lib/pdf-fonts.js";
import { parseImage, ImageError } from "../backend/lib/pdf-images.js";
import {
  snapshotOf,
  renderDocument,
  SNAPSHOT_FORMAT,
} from "../backend/lib/sales-pdf.js";
import { computeTotals } from "../shared/sales.js";
import {
  makePng,
  pdfObjects,
  pdfText,
  LOGO,
  SIGNATURE,
  COMPANY,
  BANK,
  settingsFixture,
  dealFixture,
  BILL_TO,
} from "./sales-fixtures.js";

const SAMPLES = join("test-results", "sales-samples");
const ISSUED = new Date("2026-10-14T06:30:00Z");

// Every positioned text run of a PDF made by backend/lib/pdf.js, with its box:
// {page, text, font, size, color, x, y (baseline, from the top), w}.
const FONT_OF = { F1: "regular", F2: "bold", F3: "regular" };
const TEXT_OP =
  /BT \/(F\d) ([\d.]+) Tf ([\d.]+) ([\d.]+) ([\d.]+) rg (?:([\d.-]+) Tc )?([\d.-]+) ([\d.-]+) Td \(((?:\\.|[^\\)])*)\) Tj/g;
function rawBytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== "\\") {
      bytes.push(str.charCodeAt(i));
      continue;
    }
    const next = str[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(str.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(next.charCodeAt(0));
  }
  return bytes;
}
function textRuns(pdf) {
  const objects = pdfObjects(pdf),
    byNum = new Map(objects.map((o) => [o.num, o]));
  return objects
    .filter((o) => !o.data && /\/Type \/Page /.test(o.dict))
    .flatMap((page, index) => {
      const ref = Number(/\/Contents (\d+) 0 R/.exec(page.dict)[1]),
        ops = inflateSync(byNum.get(ref).data).toString("latin1");
      return [...ops.matchAll(TEXT_OP)].map((m) => {
        const bytes = rawBytes(m[9]),
          size = Number(m[2]),
          spacing = Number(m[6] ?? 0),
          widths = WIDTHS[FONT_OF[m[1]]];
        const w =
          (bytes.reduce((a, b) => a + (widths[b - FIRST] ?? 0), 0) * size) /
            1000 +
          spacing * Math.max(bytes.length - 1, 0);
        return {
          page: index,
          text: String.fromCharCode(...bytes),
          font: m[1],
          size,
          color: [m[3], m[4], m[5]].map(Number),
          x: Number(m[7]),
          y: A4.height - Number(m[8]),
          w,
        };
      });
    });
}
// Nothing runs off the page or into the margins, and no two text runs overlap.
function assertClean(pdf, what) {
  const runs = textRuns(pdf);
  for (const r of runs) {
    assert.ok(
      r.x >= 40 && r.x + r.w <= A4.width - 40,
      `${what}: "${r.text}" runs into the side margin (x ${r.x}, w ${r.w.toFixed(1)})`,
    );
    assert.ok(
      r.y - r.size >= 20 && r.y <= A4.height - 14,
      `${what}: "${r.text}" is off the page (y ${r.y})`,
    );
  }
  const box = (r) => [r.x, r.x + r.w, r.y - 0.7 * r.size, r.y + 0.2 * r.size];
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i],
        b = runs[j];
      if (a.page !== b.page || !a.text.trim() || !b.text.trim()) continue;
      const [ax0, ax1, ay0, ay1] = box(a),
        [bx0, bx1, by0, by1] = box(b);
      const overlap =
        Math.min(ax1, bx1) - Math.max(ax0, bx0) > 0.5 &&
        Math.min(ay1, by1) - Math.max(ay0, by0) > 0.5;
      assert.ok(
        !overlap,
        `${what}: "${a.text}" overprints "${b.text}" on page ${a.page + 1}`,
      );
    }
  return runs;
}
const flat = (pdf) => pdfText(pdf).join("\n").split("\n").join(" ");
const squash = (s) => s.replace(/\s+/g, "");
// A hash of everything drawn (streams inflated), so zlib versions do not matter.
function layoutHash(pdf) {
  const h = createHash("sha256");
  for (const o of pdfObjects(pdf)) {
    h.update(o.dict);
    if (o.data)
      h.update(/FlateDecode/.test(o.dict) ? inflateSync(o.data) : o.data);
  }
  return h.digest("hex");
}

describe("pdf writer", () => {
  it("pins the Helvetica metrics", () => {
    assert.equal(textWidth("A", "regular", 1000), 667);
    assert.equal(textWidth("W", "regular", 1000), 944);
    assert.equal(textWidth(" ", "regular", 1000), 278);
    assert.equal(textWidth("'", "regular", 1000), 191);
    assert.equal(textWidth("m", "bold", 1000), 889);
    assert.equal(textWidth("€", "regular", 1000), 556);
    assert.equal(textWidth("Rs. 1,000.00", "regular", 10), 56.7);
    // Helvetica-Oblique has the upright widths; letter spacing adds per gap.
    assert.equal(textWidth("Wm", "italic", 10), textWidth("Wm", "regular", 10));
    assert.equal(
      textWidth("ABC", "bold", 10, 1.5),
      textWidth("ABC", "bold", 10) + 3,
    );
  });
  it("encodes WinAnsi and escapes string delimiters", () => {
    assert.deepEqual(
      [...encode("Café €")],
      [0x43, 0x61, 0x66, 0xe9, 0x20, 0x80],
    );
    assert.deepEqual([...encode("नA")], [0x3f, 0x41]);
    const doc = new PdfDocument();
    doc.addPage().text("a(b)c\\ é", 10, 10);
    const ops = inflateSync(
      pdfObjects(doc.toBuffer()).find(
        (o) => o.data && o.dict === "/Filter /FlateDecode",
      ).data,
    ).toString("latin1");
    assert.match(ops, /\(a\\\(b\\\)c\\\\ \\351\) Tj/);
  });
  it("wraps by words, breaks long words, keeps line breaks", () => {
    const lines = wrap(
      "alpha beta gamma\nsupercalifragilistic",
      "regular",
      10,
      40,
    );
    assert.ok(lines.length >= 4);
    for (const l of lines) assert.ok(textWidth(l, "regular", 10) <= 40, l);
    assert.equal(
      lines.join("").replaceAll(" ", ""),
      "alphabetagammasupercalifragilistic",
    );
    assert.deepEqual(wrap("", "regular", 10, 40), [""]);
  });
  it("writes a valid xref and is byte-for-byte deterministic", () => {
    const make = (at) => {
      const doc = new PdfDocument({ title: "T", createdAt: at });
      doc.addPage().text("Hello", 40, 40);
      doc.addPage().rect(10, 10, 20, 20, { fill: [0, 0, 0] });
      return doc.toBuffer();
    };
    const pdf = make(ISSUED);
    assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
    assert.ok(pdf.toString("latin1").endsWith("%%EOF\n"));
    const text = pdf.toString("latin1"),
      start = Number(/startxref\n(\d+)\n/.exec(text)[1]);
    assert.equal(text.slice(start, start + 4), "xref");
    const offsets = text
      .slice(start)
      .split("\n")
      .filter((l) => / 00000 n $/.test(l))
      .map((l) => Number(l.slice(0, 10)));
    offsets.forEach((o, i) =>
      assert.equal(
        text.slice(o, o + `${i + 1} 0 obj`.length),
        `${i + 1} 0 obj`,
      ),
    );
    assert.match(text, /\/CreationDate \(D:20261014120000\+05'30'\)/);
    assert.match(text, /\/Count 2/);
    assert.ok(make(ISSUED).equals(pdf));
    assert.ok(!make(new Date("2026-10-15T00:00:00Z")).equals(pdf));
  });
  it("letter spacing is reset after its run; the oblique font is added only when used", () => {
    const plain = new PdfDocument();
    plain.addPage().text("ABC", 10, 10, { font: "bold" });
    const plainPdf = plain.toBuffer().toString("latin1");
    assert.equal(/Oblique|\/F3/.test(plainPdf), false);
    const doc = new PdfDocument();
    const page = doc.addPage();
    const w = page.text("LABEL", 100, 10, {
      size: 7,
      spacing: 0.8,
      align: "right",
    });
    assert.equal(w, textWidth("LABEL", "regular", 7, 0.8));
    page.text("words", 10, 30, { font: "italic" });
    page.roundRect(10, 40, 100, 30, 4, { fill: [0.9, 0.9, 0.9] });
    const pdf = doc.toBuffer();
    assert.match(pdf.toString("latin1"), /\/BaseFont \/Helvetica-Oblique/);
    assert.match(pdf.toString("latin1"), /\/F3 \d+ 0 R/);
    const ops = inflateSync(
      pdfObjects(pdf).find((o) => o.data && o.dict === "/Filter /FlateDecode")
        .data,
    ).toString("latin1");
    assert.match(ops, / 0\.8 Tc .*\(LABEL\) Tj 0 Tc ET/);
    assert.match(ops, /\/F3 10 Tf .*\(words\) Tj ET/);
    assert.match(ops, / c .* c .* c .* c .*h f/s);
    const [run] = textRuns(pdf);
    assert.ok(
      Math.abs(run.x + run.w - 100) < 0.02,
      "right-aligned run ends at x",
    );
  });
});

describe("pdf images", () => {
  const unpack = (img) => inflateSync(img.data);
  it("decodes RGBA PNG with every row filter into colour + alpha mask", () => {
    const px = (x, y) => [
      (x * 40) & 255,
      (y * 70) & 255,
      (x * y * 13) & 255,
      x === 0 ? 0 : 200,
    ];
    const img = parseImage(makePng(6, 7, 6, px));
    assert.equal(img.colorSpace, "DeviceRGB");
    assert.equal(img.width, 6);
    const rgb = unpack(img),
      alpha = inflateSync(img.alpha);
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 6; x++) {
        const p = y * 6 + x,
          want = px(x, y);
        assert.deepEqual([...rgb.subarray(p * 3, p * 3 + 3)], want.slice(0, 3));
        assert.equal(alpha[p], want[3]);
      }
  });
  it("decodes gray, gray+alpha and palette (with tRNS); drops an opaque alpha", () => {
    const gray = parseImage(makePng(5, 5, 0, (x, y) => [x * 50 + y]));
    assert.equal(gray.colorSpace, "DeviceGray");
    assert.equal(unpack(gray)[7], 2 * 50 + 1);
    assert.equal(
      parseImage(makePng(3, 3, 6, () => [1, 2, 3, 255])).alpha,
      null,
    );
    const pal = parseImage(
      makePng(4, 2, 3, (x) => [x % 2], {
        palette: [255, 0, 0, 0, 0, 255],
        trns: [0],
      }),
    );
    assert.deepEqual([...unpack(pal).subarray(0, 6)], [255, 0, 0, 0, 0, 255]);
    assert.deepEqual([...inflateSync(pal.alpha).subarray(0, 2)], [0, 255]);
    assert.ok(parseImage(SIGNATURE).alpha);
  });
  it("reads JPEG dimensions and refuses what it cannot embed", () => {
    const sof = (components) =>
      Buffer.from([
        0xff,
        0xd8,
        0xff,
        0xe0,
        0,
        4,
        0,
        0,
        0xff,
        0xc2,
        0,
        8 + 3 * components,
        8,
        0,
        30,
        0,
        50,
        components,
        ...Array(3 * components).fill(1),
        0xff,
        0xda,
        0,
        2,
        0xff,
        0xd9,
      ]);
    const jpeg = parseImage(sof(3));
    assert.deepEqual(
      [jpeg.width, jpeg.height, jpeg.colorSpace, jpeg.filter],
      [50, 30, "DeviceRGB", "DCTDecode"],
    );
    const refused = (buffer, re) =>
      assert.throws(
        () => parseImage(buffer),
        (e) => e instanceof ImageError && re.test(e.message),
      );
    refused(sof(4), /CMYK/);
    refused(
      makePng(2, 2, 2, () => [0, 0, 0], { depth: 16 }),
      /8-bit/,
    );
    refused(
      makePng(2, 2, 2, () => [0, 0, 0], { interlace: 1 }),
      /8-bit/,
    );
    refused(
      makePng(2001, 1, 0, () => [0]),
      /2000/,
    );
    refused(Buffer.alloc(600 * 1024, 1), /512 KB/);
    refused(Buffer.from("GIF89a....."), /PNG or JPEG/);
    refused(
      Buffer.concat([makePng(2, 2, 2, () => [0, 0, 0]).subarray(0, 40)]),
      /damaged/,
    );
  });
});

// A seller without GST registration: name, e-mail and phone only.
const SANDBEE = {
  legalName: "Sandbee",
  email: "hello@sandbee.in",
  phone: "+91 98250 12345",
  jurisdiction: "Ahmedabad",
};
const CAFE = {
  name: "Cafe Blue LLP",
  address: ["12 MG Road", "Camp"],
  city: "Pune",
  stateCode: "",
  pincode: "411001",
  gstin: "",
  pan: "",
  email: "owner@cafeblue.example",
  phone: "+91 98220 00000",
};
const UPI_BANK = {
  accountName: "Sandbee",
  accountNumber: "50200012345678",
  ifsc: "HDFC0001234",
  bankName: "HDFC Bank",
  branch: "Navrangpura, Ahmedabad",
  upiId: "sandbee@hdfcbank",
};
const unregistered = (over = {}) =>
  settingsFixture({
    company: SANDBEE,
    bank: {},
    gst: { registered: false },
    ...over,
  });
const cafeDeal = (over = {}) =>
  dealFixture({ billTo: CAFE, placeOfSupply: "", ...over });
// Nothing on a document of a seller without GST registration mentions GST
// registration particulars or calls it a tax invoice.
const GST_WORDS =
  /GSTIN|tax invoice|CGST|SGST|IGST|UTGST|\bSAC\b|Place of supply|Taxable|Reverse charge|ORIGINAL FOR RECIPIENT/i;
const HEADINGS = [
  "DEFINITIONS",
  "SERVICES",
  "TERM AND RENEWAL",
  "FEES AND PAYMENT",
  "CLIENT ACCOUNTS AND THIRD-PARTY SERVICES",
  "CLIENT RESPONSIBILITIES",
  "SUPPORT AND AVAILABILITY",
  "DATA PROTECTION AND CONFIDENTIALITY",
  "INTELLECTUAL PROPERTY",
  "WARRANTIES",
  "LIMITATION OF LIABILITY",
  "SUSPENSION AND TERMINATION",
  "FORCE MAJEURE",
  "NOTICES",
  "GOVERNING LAW AND DISPUTES",
  "GENERAL",
];

// A snapshot as format 1 stored it (before 2026-10-15: no gstRegistered, no
// design; every seller GST-registered).
function formatOne(type) {
  const deal = dealFixture();
  const totals = computeTotals(deal, { sellerState: "27", roundOff: true });
  delete totals.registered;
  return {
    format: 1,
    type,
    number: {
      quotation: "QT/26-27/0007",
      agreement: "AG/26-27/0007",
      invoice: "INV/26-27/0007",
    }[type],
    version: 1,
    draft: false,
    issuedAt: ISSUED.toISOString(),
    date: "2026-10-14",
    seller: { ...COMPANY, stateName: "Maharashtra" },
    bank: { ...BANK },
    signatory: { name: "A. Founder", title: "Director" },
    images: { logo: null, signature: null },
    buyer: { ...BILL_TO, stateName: "Maharashtra" },
    deal: {
      id: deal._id,
      title: deal.title,
      notes: deal.notes,
      placeOfSupply: "27",
      placeOfSupplyName: "Maharashtra",
      validUntil: deal.validUntil,
    },
    lines: deal.lines.map((l) => ({
      description: l.description,
      sac: l.sac,
      unit: l.unit,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discount: { ...l.discount },
      gstRate: l.gstRate,
    })),
    discount: { ...deal.discount },
    roundOff: true,
    totals,
    text: "# Payment\n1. Please pay by the due date to the bank account or UPI ID shown.\n\n2. Please quote the invoice number with your payment.",
    textSource: "default",
    dueDate: type === "invoice" ? "2026-10-21" : null,
    quotationRef: type === "quotation" ? null : "QT/26-27/0001 v1",
  };
}

describe("sales documents", () => {
  const assets = { logo: parseImage(LOGO), signature: parseImage(SIGNATURE) };
  const settings = settingsFixture();
  settings.images = { logo: { sha256: "l" }, signature: { sha256: "s" } };
  const deal = dealFixture();
  const snap = (type, extra = {}) =>
    snapshotOf({
      settings: extra.settings ?? settings,
      overrides: extra.overrides ?? {},
      deal: extra.deal ?? deal,
      type,
      number:
        extra.number === undefined
          ? `${{ quotation: "QT/", agreement: "AG/", invoice: "INV/" }[type]}26-27/0001`
          : extra.number,
      version: extra.version ?? 1,
      issuedAt: ISSUED,
      draft: extra.draft ?? false,
      quotationRef: type === "quotation" ? null : "QT/26-27/0001 v1",
    });
  const make = (type, extra = {}) => {
    const s = snap(type, extra);
    return { snap: s, pdf: renderDocument(s, extra.assets ?? assets) };
  };
  const extracted = [];
  const save = (name, pdf, amount, words) => {
    mkdirSync(SAMPLES, { recursive: true });
    const file = join(SAMPLES, `${name}.pdf`);
    writeFileSync(file, pdf);
    extracted.push({ file, amount, words });
    return flat(pdf);
  };
  const GST_TOTAL = [
    "11,199.00",
    "Rupees Eleven Thousand One Hundred Ninety-Nine Only",
  ];
  const PLAIN_TOTAL = [
    "9,491.00",
    "Rupees Nine Thousand Four Hundred Ninety-One Only",
  ];
  const lacks = (text, list, what) => {
    for (const want of list)
      assert.ok(text.includes(want), `${what} lacks "${want}"`);
  };

  it("quotation with line and overall discounts: every amount printed and totals right", () => {
    const { snap: s, pdf } = make("quotation");
    assert.equal(s.format, SNAPSHOT_FORMAT);
    assert.equal(SNAPSHOT_FORMAT, 2);
    assert.equal(s.gstRegistered, true);
    assert.equal(s.totals.payable, 1119900);
    const text = save("quotation", pdf, ...GST_TOTAL);
    lacks(
      text,
      [
        "QUOTATION",
        "NOT A TAX INVOICE",
        "QT/26-27/0001",
        "14 Oct 2026",
        "31 Oct 2026",
        "FROM",
        "BILL TO",
        "Sandbee Technologies Private Limited",
        "Cafe Blue LLP",
        "GSTIN 27AABCC1234D1ZB",
        "GSTIN 27AAACS9999K1ZD",
        "PAN AAACS9999K",
        "Pune 411001, Maharashtra (27)",
        "Place of supply Maharashtra (27)",
        "Tax: CGST + SGST (intra-state)",
        "ITEM / SAC",
        "SAC 998314",
        "SAC 998313",
        "10,000.00", // rate line a
        "10%",
        "-1,000.00", // line a discount
        "-9.99", // line b amount discount
        "Overall discount (5%)",
        "-499.50",
        "8,550.00", // taxable a
        "940.50", // taxable b
        "Taxable value 9,490.50",
        "18% (9% + 9%)",
        "CGST 854.15",
        "SGST 854.15",
        "CGST 769.50", // line a: tax amount per line (Rule 46)
        "SGST 769.50",
        "CGST 84.65", // line b: 940.50 × 9 % = 84.645 → 84.65
        "PAYMENT DETAILS",
        "HDFC0000001",
        "sandbee@examplebank",
        "Pay only to the account above.",
        "Round off +0.20",
        "Total Rs. 11,199.00",
        "Rupees Eleven Thousand One Hundred Ninety-Nine Only",
        "GST is charged at the rates shown.",
        "NOTES Prices include onboarding for two staff members.",
        "TERMS AND CONDITIONS",
        "1. All prices are in Indian Rupees (INR). GST is charged at the rates shown.",
        "2. This quotation is valid until 31 Oct 2026. After that date, prices and scope may change.",
        "For Sandbee Technologies Private Limited",
        "A. Founder",
        "Director",
        "QT/26-27/0001 v1",
        "Quotation - not a tax invoice",
      ],
      "quotation",
    );
    assert.match(text, /Page 1 of \d/);
    assert.equal(
      pdfObjects(pdf).filter((o) => /\/Subtype \/Image/.test(o.dict)).length,
      4,
    );
    assertClean(pdf, "quotation");
  });
  it("agreement: parties, client-specific text, schedule and both signatures", () => {
    const { snap: s, pdf } = make("agreement", {
      overrides: {
        agreementBody:
          "# Special terms\nThis agreement is for {{client.name}} only, total {{deal.total}}.",
      },
    });
    assert.equal(s.textSource, "client");
    const text = save("agreement", pdf, ...GST_TOTAL);
    lacks(
      text,
      [
        "SERVICE AGREEMENT",
        "Agreement No. AG/26-27/0001",
        "Effective date 14 Oct 2026",
        "Quotation ref. QT/26-27/0001 v1",
        "PROVIDER",
        "CLIENT",
        "Special terms",
        "This agreement is for Cafe Blue LLP only, total Rs. 11,199.00.",
        "Schedule A - Commercials",
        "Total Rs. 11,199.00",
        "Agreed and accepted by the authorised representatives of the Parties",
        "Director",
        "Date 14 Oct 2026",
      ],
      "agreement",
    );
    assert.equal(text.split("Signature").length - 1, 2, "two signature lines");
    assertClean(pdf, "agreement");
    // The default text is the 16-section Service Agreement.
    const plain = flat(make("agreement").pdf);
    HEADINGS.forEach((h, i) =>
      assert.ok(plain.includes(`${i + 1}. ${h}`), `default lacks ${h}`),
    );
  });
  it("tax invoice: Rule 46 particulars, intra-state", () => {
    const { snap: s, pdf } = make("invoice");
    assert.equal(s.dueDate, "2026-10-21");
    const text = save("invoice", pdf, ...GST_TOTAL);
    lacks(
      text,
      [
        "TAX INVOICE",
        "ORIGINAL FOR RECIPIENT",
        "Invoice No. INV/26-27/0001",
        "Invoice date 14 Oct 2026",
        "Due date 21 Oct 2026",
        "Place of supply Maharashtra (27)",
        "Reverse charge No",
        "Quotation ref. QT/26-27/0001 v1",
        "GSTIN 27AAACS9999K1ZD",
        "GSTIN 27AABCC1234D1ZB",
        "Office 4, Example Business Park",
        "Tax: CGST + SGST (intra-state)",
        "CGST 854.15",
        "SGST 854.15",
        "Total Rs. 11,199.00",
        "Computer-generated tax invoice",
        "For Sandbee Technologies Private Limited",
        "Director",
      ],
      "invoice",
    );
    assert.equal(text.includes("INV/26-27/0001 v1"), false);
    assertClean(pdf, "invoice");
  });
  it("tax invoice: inter-state client gets IGST and an unregistered client says so", () => {
    const deal2 = dealFixture({
      billTo: {
        ...BILL_TO,
        name: "Hotel Green",
        city: "Bengaluru",
        stateCode: "29",
        pincode: "560001",
        gstin: "",
      },
      placeOfSupply: "29",
    });
    const { snap: s, pdf } = make("invoice", {
      deal: deal2,
      number: "INV/26-27/0002",
    });
    assert.equal(s.totals.igst, 170829);
    assert.equal(s.totals.roundOff, 21);
    const text = save("invoice-igst", pdf, ...GST_TOTAL);
    lacks(
      text,
      [
        "IGST 1,708.29",
        "18% IGST",
        "IGST 1,539.00",
        "IGST 169.29",
        "Round off +0.21",
        "Total Rs. 11,199.00",
        "GSTIN Unregistered",
        "Bengaluru 560001, Karnataka (29)",
        "Place of supply Karnataka (29)",
        "Tax: IGST (inter-state)",
      ],
      "IGST invoice",
    );
    assert.equal(text.includes("CGST"), false);
    assertClean(pdf, "IGST invoice");
  });
  it("seller without GST registration: a quotation with no GST particulars", () => {
    const s = snap("quotation", {
      settings: unregistered(),
      deal: cafeDeal(),
    });
    assert.equal(s.format, 2);
    assert.equal(s.gstRegistered, false);
    assert.equal(s.design.accent, "#355E45");
    assert.equal(s.totals.registered, false);
    assert.equal(s.totals.tax, 0);
    assert.equal(s.totals.payable, 949100);
    const pdf = renderDocument(s, {});
    const text = save("quotation-plain", pdf, ...PLAIN_TOTAL);
    lacks(
      text,
      [
        "QUOTATION",
        "FROM Sandbee hello@sandbee.in +91 98250 12345",
        "BILL TO Cafe Blue LLP 12 MG Road Camp Pune 411001 owner@cafeblue.example +91 98220 00000",
        "Sandbee POS setup and first-year support",
        "DESCRIPTION",
        // The amount column is quantity × rate less the line discount, so
        // it adds up to the subtotal; the overall discount follows.
        "1 nos 10,000.00 -1,000.00 10% 9,000.00",
        "3 hours 333.33 -9.99 990.00",
        "Subtotal 9,990.00",
        "Overall discount (5%) -499.50",
        "Round off +0.50",
        "Total Rs. 9,491.00",
        "Rupees Nine Thousand Four Hundred Ninety-One Only",
        "GST is not charged: the supplier is not registered under GST.",
        "TERMS AND CONDITIONS",
        "1. All prices are in Indian Rupees (INR). GST is not charged: the supplier is not registered under GST.",
        "8. To accept this quotation, reply to hello@sandbee.in or call +91 98250 12345, quoting QT/26-27/0001.",
        "For Sandbee",
        "A. Founder",
        "Sandbee · hello@sandbee.in · +91 98250 12345",
      ],
      "plain quotation",
    );
    assert.doesNotMatch(text, GST_WORDS);
    assert.doesNotMatch(text, /Line discounts/);
    // Only filled fields: no PAN, address, website or payment block.
    assert.doesNotMatch(text, /PAN|Maharashtra|PAYMENT DETAILS|Pay only/);
    assertClean(pdf, "plain quotation");
  });
  it("seller without GST registration: an invoice titled INVOICE with payment details", () => {
    const s = snap("invoice", {
      settings: unregistered({ bank: UPI_BANK }),
      deal: cafeDeal({
        billTo: { ...CAFE, stateCode: "27", gstin: "27AABCC1234D1ZB" },
      }),
    });
    const pdf = renderDocument(s, {});
    const text = save("invoice-plain", pdf, ...PLAIN_TOTAL);
    const runs = textRuns(pdf);
    assert.ok(runs.some((r) => r.text === "INVOICE" && r.size >= 20));
    lacks(
      text,
      [
        "Invoice No. INV/26-27/0001",
        "Invoice date 14 Oct 2026",
        "Due date 21 Oct 2026",
        "Quotation ref. QT/26-27/0001 v1",
        "Total Rs. 9,491.00",
        "GST is not charged: the supplier is not registered under GST.",
        "PAYMENT DETAILS",
        "Account name Sandbee",
        "Account number 50200012345678",
        "IFSC HDFC0001234",
        "Bank HDFC Bank, Navrangpura, Ahmedabad",
        "UPI ID sandbee@hdfcbank",
        "Pay only to the account above.",
        "TERMS",
        "2. Please pay the full amount by the due date shown above, quoting INV/26-27/0001 as the payment reference.",
        "Computer-generated invoice",
      ],
      "plain invoice",
    );
    // The client's own GSTIN is printed when it has one; nothing else of GST.
    assert.ok(text.includes("GSTIN 27AABCC1234D1ZB"));
    assert.doesNotMatch(text.replace("GSTIN 27AABCC1234D1ZB", ""), GST_WORDS);
    assert.doesNotMatch(text, /Maharashtra \(27\)/);
    assertClean(pdf, "plain invoice");
  });
  it("seller without GST registration: the 16-section agreement, Schedule A and two signature blocks", () => {
    const s = snap("agreement", {
      settings: unregistered(),
      deal: cafeDeal(),
    });
    const pdf = renderDocument(s, { signature: assets.signature });
    const text = save("agreement-plain", pdf, ...PLAIN_TOTAL);
    lacks(
      text,
      [
        "SERVICE AGREEMENT",
        "Agreement No. AG/26-27/0001",
        "Effective date 14 Oct 2026",
        "PROVIDER Sandbee hello@sandbee.in +91 98250 12345",
        "CLIENT Cafe Blue LLP",
        'This Service Agreement (the "Agreement") is made on 14 Oct 2026 (the "Effective Date") between Sandbee (the "Provider") and Cafe Blue LLP (the "Client"), whose details are set out above.',
        "4.1 The Client will pay the Fees set out in Schedule A, which total Rs. 9,491.00 (Rupees Nine Thousand Four Hundred Ninety-One Only) for the items listed there.",
        "4.3 Invoices are payable by the due date stated on them. GST is not charged: the supplier is not registered under GST.",
        "15.3 A dispute that is not settled will be referred to a sole arbitrator appointed by the Parties under the Arbitration and Conciliation Act, 1996. The seat and venue of arbitration will be Ahmedabad, and the language English.",
        "15.4 Subject to clause 15.3, the courts at Ahmedabad have exclusive jurisdiction.",
        "Schedule A - Commercials",
        "Total Rs. 9,491.00",
        "Agreed and accepted by the authorised representatives of the Parties",
        "PROVIDER Sandbee",
        "CLIENT Cafe Blue LLP",
        "Name A. Founder",
        "Title Director",
        "Date 14 Oct 2026",
      ],
      "plain agreement",
    );
    HEADINGS.forEach((h, i) =>
      assert.ok(text.includes(`${i + 1}. ${h}`), `agreement lacks ${h}`),
    );
    assert.equal(text.split("Signature").length - 1, 2);
    assert.doesNotMatch(text, GST_WORDS);
    // Headings in the accent colour, set in bold.
    const runs = assertClean(pdf, "plain agreement");
    const heading = runs.find((r) => r.text === "DEFINITIONS");
    assert.equal(heading.font, "F2");
    assert.deepEqual(heading.color, [0.21, 0.37, 0.27]);
    // The schedule follows the body; the signatures close the document.
    const order = ["16. GENERAL", "Schedule A - Commercials", "Agreed and"].map(
      (t) => text.indexOf(t),
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
    assert.ok(order.every((i) => i >= 0));
  });
  it("a heading never ends a page: it moves with its first paragraph", () => {
    const filler = "Filler paragraph.";
    let checked = 0;
    for (let k = 0; k < 24; k++) {
      const s = snap("agreement", {
        settings: unregistered(),
        deal: cafeDeal(),
        overrides: {
          agreementBody: `${Array(k).fill(filler).join("\n")}\n${unregistered().templates.agreementBody}`,
        },
      });
      const runs = textRuns(renderDocument(s, {})),
        foot = A4.height - 60;
      for (const h of runs.filter((r) => HEADINGS.includes(r.text))) {
        checked++;
        const below = runs.filter(
          (r) =>
            r.page === h.page &&
            r.y > h.y + 1 &&
            r.y < foot &&
            !HEADINGS.includes(r.text),
        );
        assert.ok(below.length >= 2, `"${h.text}" ends page ${h.page + 1}`);
      }
    }
    assert.ok(checked >= 24 * 16);
  });
  it("format 1 snapshots (issued before GST registration became optional) re-render to the same bytes", () => {
    // Pinned from the renderer that issued them (main @ 99809c8).
    const pinned = {
      quotation:
        "4b258c3120cff28c856d12437987b888ba5acdae4aef141fe76735c633e1b9f1",
      agreement:
        "be58ba9342f0231324af6c6a8b567fc1e9ece76a9f6a99909c9cbfa06155d35d",
      invoice:
        "2677c3f62e8f1ee2e128b1f6a8e8a54765ee076a6c931da80463603168b8b023",
    };
    for (const type of Object.keys(pinned))
      assert.equal(
        layoutHash(
          renderDocument(formatOne(type), type === "invoice" ? {} : assets),
        ),
        pinned[type],
        type,
      );
    const cancelled = renderDocument(
      formatOne("invoice"),
      {},
      { stamp: "CANCELLED" },
    );
    assert.equal(
      layoutHash(cancelled),
      "ec7ed1692aaca7457b3790b2e176f2aff0e991f31b7d490320a1b17d6d2cf6f2",
    );
    const text = flat(renderDocument(formatOne("invoice")));
    lacks(text, ["TAX INVOICE", "CGST", "SGST", "11,199.00"], "format 1");
    // A newer snapshot without the flags is treated the same way: registered,
    // in the default accent colour.
    const s = snap("invoice");
    delete s.gstRegistered;
    delete s.design;
    const pdf = renderDocument(s, {});
    lacks(flat(pdf), ["TAX INVOICE", "CGST 854.15", "GSTIN"], "no flags");
    assert.ok(
      textRuns(pdf).some(
        (r) => r.text === "TAX INVOICE" && r.color.join() === "0.21,0.37,0.27",
      ),
    );
  });
  it("prints in the configured accent colour, darkened when too light to read", () => {
    const runsOf = (accent) =>
      textRuns(
        renderDocument(
          snap("invoice", {
            settings: unregistered({ design: { accent } }),
            deal: cafeDeal(),
          }),
          {},
        ),
      );
    const title = (runs) => runs.find((r) => r.text === "INVOICE");
    assert.deepEqual(title(runsOf("#1a2b3c")).color, [0.1, 0.17, 0.24]);
    const pale = title(runsOf("#FFEE99")).color;
    const lum = 0.2126 * pale[0] + 0.7152 * pale[1] + 0.0722 * pale[2];
    assert.ok(lum < 0.5, `pale accent stays readable (${pale})`);
  });
  it("long deals break pages and repeat the table head; drafts are marked", () => {
    const many = dealFixture({
      lines: Array.from({ length: 50 }, (_, i) => ({
        id: `l${i}`,
        productId: "",
        description: `Line ${i + 1}: a longer description that wraps onto a second line in the item column`,
        sac: "998314",
        unit: "nos",
        qty: 1000,
        unitPrice: 10000 + i,
        discount: { type: "none", value: 0 },
        gstRate: 1800,
      })),
    });
    for (const [settingsOf, head] of [
      [settings, "ITEM / SAC"],
      [unregistered(), "DESCRIPTION"],
    ]) {
      const { pdf } = make("quotation", {
        settings: settingsOf,
        deal: many,
        number: null,
        draft: true,
      });
      const pages = pdfText(pdf);
      assert.ok(pages.length >= 3);
      pages.forEach((p, i) => {
        assert.ok(p.includes(`Page ${i + 1} of ${pages.length}`));
        assert.ok(p.includes("DRAFT - NOT ISSUED"));
      });
      assert.ok(pages[1].includes(head));
      assert.ok(pages.join("\n").includes("Line 50:"));
      assertClean(pdf, `long ${head}`);
    }
  });
  it("party, header, bank and signature values at the schema maxima stay inside their columns", () => {
    const long = (n, word = "Wombat") =>
      Array(200).fill(word).join(" ").slice(0, n).trim();
    const email = `${"w".repeat(64)}@${"w".repeat(63)}.${"w".repeat(63)}.${"w".repeat(57)}.in`;
    const company = {
      legalName: long(160, "Mumbai"),
      tradeName: long(160, "WWW"),
      address: [long(160), long(160, "Avenue"), long(160, "Ward"), long(160)],
      city: long(60, "Wadhwan"),
      stateCode: "26",
      pincode: "396210",
      gstin: "",
      pan: "AAACS9999K",
      email,
      phone: "+91 99999 99999 99999 99999 9999",
      website: `https://${"w".repeat(108)}.in`,
      jurisdiction: long(60, "Wadhwan"),
    };
    const billTo = {
      name: long(160, "Mumbai"),
      address: [long(160), long(160), long(160), long(160)],
      city: long(60, "Wadhwan"),
      stateCode: "26",
      pincode: "396210",
      gstin: "",
      pan: "AAACS9999K",
      email,
      phone: "+91 99999 99999 99999 99999 9999",
    };
    const bank = {
      accountName: long(160, "Mumbai"),
      accountNumber: "W".repeat(24),
      ifsc: "HDFC0001234",
      bankName: long(120, "Wide"),
      branch: long(120, "Branch"),
      upiId: `${"w".repeat(235)}@${"w".repeat(64)}`, // 300 at most
    };
    const signatory = { name: long(120, "Wilma"), title: long(120, "Wise") };
    const deal = dealFixture({
      title: long(160, "Website"),
      billTo,
      placeOfSupply: "26",
      notes: long(2000, "Note"),
      lines: dealFixture().lines.map((l) => ({
        ...l,
        description: Array(8).fill(long(36, "Wombat")).join("\n"), // 295
        unit: "W".repeat(12),
        qty: 100000000,
        unitPrice: 1000000000,
      })),
    });
    for (const registered of [true, false])
      for (const type of ["quotation", "agreement", "invoice"]) {
        const local = settingsFixture({
          company,
          bank,
          signatory,
          gst: { registered },
        });
        const s = snap(type, {
          settings: local,
          deal,
          number: "INV/26-27/9999",
        });
        const pdf = renderDocument(s, assets),
          what = `${type} ${registered ? "GST" : "no GST"}`;
        assertClean(pdf, what);
        const all = squash(flat(pdf));
        for (const value of [
          company.legalName,
          company.address[3],
          billTo.name,
          billTo.address[3],
          email,
          deal.title,
          ...(type === "agreement" ? [] : [bank.upiId, bank.branch]),
          signatory.title,
        ])
          assert.ok(
            all.includes(squash(value)),
            `${what} cuts ${value.slice(0, 20)}`,
          );
        if (registered)
          assert.ok(
            all.includes(
              squash("Dadra and Nagar Haveli and Daman and Diu (26)"),
            ),
            what,
          );
      }
  });
  it("user text cannot break out of its string", () => {
    const evil = "Cafe) Tj ET BT /F2 40 Tf (pwned\\";
    const s = snap("invoice", {
      settings: unregistered(),
      deal: cafeDeal({ billTo: { ...CAFE, name: evil } }),
    });
    const pdf = renderDocument(s, {});
    assert.ok(flat(pdf).includes(evil));
    assert.equal(
      textRuns(pdf).some((r) => r.text === "pwned"),
      false,
    );
  });
  // Owner-editable texts (client copies need no step-up): hostile lines must
  // neither stall the server nor break the layout.
  const agreementWith = (agreementBody) =>
    renderDocument(
      snap("agreement", {
        settings: unregistered(),
        deal: cafeDeal(),
        overrides: { agreementBody },
      }),
      {},
    );
  it("numbered-line parsing has no catastrophic backtracking", () => {
    for (const line of [
      `1.${"1".repeat(60)}x`,
      `1.${"1.".repeat(200)} x`,
      `1.${"1.1".repeat(300)}x`,
      `1.${" ".repeat(5000)}x y`,
      `12.${"12".repeat(500)}`,
    ]) {
      const started = performance.now(),
        pdf = agreementWith(`${line}\n${line}`),
        took = performance.now() - started;
      assert.ok(took < 500, `${line.slice(0, 12)}... took ${took} ms`);
      assertClean(pdf, `${line.slice(0, 12)}...`);
    }
  });
  it("a long '# ' line is a paragraph, not a heading that runs off the page", () => {
    const words = Array(3900).fill("word").join(" ");
    const pdf = agreementWith(`# ${words}\n# Short heading\nText.`);
    assertClean(pdf, "long # line");
    // Every word printed (the paragraph spans pages, between their footers).
    assert.equal(flat(pdf).match(/\bword\b/g).length, 3900);
    const heading = textRuns(pdf).find((r) => r.text === "Short heading");
    assert.equal(heading.font, "F2");
  });
  it("a clause number too wide for the indent column never overprints its text", () => {
    const text = [
      "1. HEADING",
      "1.1 A normal clause that is long enough to wrap onto a second line of the agreement body text.",
      "123.123.123.123. A clause with a very wide number that would not fit the hanging indent column at all.",
      "999.999. A clause with a wider number that still fits the indent column and wraps onto another line.",
      "123.123.123.123.123. FIVE LEVELS",
    ].join("\n");
    const pdf = agreementWith(text);
    assertClean(pdf, "wide numbers");
    const all = flat(pdf);
    for (const want of [
      "1.1 A normal clause",
      "123.123.123.123. A clause with a very wide number",
      "999.999. A clause with a wider number",
      "123.123.123.123.123. FIVE LEVELS",
    ])
      assert.ok(all.includes(want), want);
  });
  it("a seller without GST registration never prints its GSTIN, even when one is on file", () => {
    const local = settingsFixture({
      gst: { registered: false },
      templates: {
        quotationTerms: "1. Our GSTIN is {{company.gstin}}.",
        invoiceTerms: "1. GSTIN: {{company.gstin}}",
        agreementBody: "The Provider (GSTIN {{company.gstin}}) agrees.",
      },
    });
    assert.equal(local.company.gstin, "27AAACS9999K1ZD");
    for (const type of ["quotation", "agreement", "invoice"]) {
      const s = snap(type, { settings: local });
      const pdf = renderDocument(s, {});
      assert.equal(flat(pdf).includes("27AAACS9999K1ZD"), false, type);
      assert.equal(
        pdf.toString("latin1").includes("27AAACS9999K1ZD"),
        false,
        type,
      );
      assert.equal(s.seller.gstin, "", type);
      // The client's own GSTIN is still printed.
      assert.ok(flat(pdf).includes("27AABCC1234D1ZB"), type);
    }
    // A registered seller still prints it, in the party block and the text.
    const reg = settingsFixture({
      templates: { quotationTerms: "1. Our GSTIN is {{company.gstin}}." },
    });
    const text = flat(renderDocument(snap("quotation", { settings: reg }), {}));
    assert.ok(text.includes("GSTIN 27AAACS9999K1ZD"));
    assert.ok(text.includes("Our GSTIN is 27AAACS9999K1ZD."));
  });
  it("prints UTGST for a union territory and stamps a cancelled copy", () => {
    const ut = settingsFixture({
      company: {
        ...settings.company,
        stateCode: "04",
        city: "Chandigarh",
        gstin: "",
      },
    });
    ut.images = { logo: null, signature: null };
    const deal4 = dealFixture({
      billTo: { ...BILL_TO, stateCode: "04", gstin: "" },
      placeOfSupply: "04",
    });
    const s = snapshotOf({
      settings: ut,
      overrides: {},
      deal: deal4,
      type: "quotation",
      number: "QT/26-27/0009",
      version: 1,
      issuedAt: ISSUED,
    });
    const text = flat(renderDocument(s));
    lacks(
      text,
      ["UTGST 769.50", "Tax: CGST + UTGST (intra-state)", "UTGST 854.15"],
      "UT quotation",
    );
    assert.equal(/\bSGST\b/.test(text.replaceAll("UTGST", "")), false);
    const stamped = flat(renderDocument(s, {}, { stamp: "CANCELLED" }));
    assert.ok(stamped.includes("CANCELLED"));
    assert.equal(flat(renderDocument(s)).includes("CANCELLED"), false);
  });
  it("re-rendering a snapshot gives the same bytes", () => {
    for (const settingsOf of [settings, unregistered()]) {
      const { snap: s, pdf } = make("invoice", { settings: settingsOf });
      assert.ok(
        renderDocument(JSON.parse(JSON.stringify(s)), assets).equals(pdf),
      );
      assert.ok(pdf.length < 60 * 1024, `${pdf.length} bytes`);
    }
  });
  it("an independent extractor (pdftotext) reads the samples, when installed", (t) => {
    const probe = spawnSync("pdftotext", ["-v"], { encoding: "utf8" });
    if (probe.error) return t.skip("pdftotext is not installed");
    for (const { file, amount, words } of extracted) {
      const out = spawnSync("pdftotext", ["-layout", file, "-"], {
        encoding: "utf8",
      });
      assert.equal(out.status, 0, file);
      assert.ok(out.stdout.includes(amount), file);
      assert.ok(out.stdout.replace(/\s+/g, " ").includes(words), file);
    }
  });
});
