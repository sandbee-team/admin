import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { PdfDocument, textWidth, wrap, encode } from "../backend/lib/pdf.js";
import { parseImage, ImageError } from "../backend/lib/pdf-images.js";
import { snapshotOf, renderDocument } from "../backend/lib/sales-pdf.js";
import {
  makePng,
  pdfObjects,
  pdfText,
  LOGO,
  SIGNATURE,
  settingsFixture,
  dealFixture,
  BILL_TO,
} from "./sales-fixtures.js";

const SAMPLES = join("test-results", "sales-samples");
const ISSUED = new Date("2026-10-14T06:30:00Z");

describe("pdf writer", () => {
  it("pins the Helvetica metrics", () => {
    assert.equal(textWidth("A", "regular", 1000), 667);
    assert.equal(textWidth("W", "regular", 1000), 944);
    assert.equal(textWidth(" ", "regular", 1000), 278);
    assert.equal(textWidth("'", "regular", 1000), 191);
    assert.equal(textWidth("m", "bold", 1000), 889);
    assert.equal(textWidth("€", "regular", 1000), 556);
    assert.equal(textWidth("Rs. 1,000.00", "regular", 10), 56.7);
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

describe("sales documents", () => {
  const assets = { logo: parseImage(LOGO), signature: parseImage(SIGNATURE) };
  const settings = settingsFixture({
    // A client-specific agreement text never leaks into the defaults.
  });
  settings.images = { logo: { sha256: "l" }, signature: { sha256: "s" } };
  const deal = dealFixture();
  const make = (type, extra = {}) => {
    const snap = snapshotOf({
      settings,
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
    return { snap, pdf: renderDocument(snap, assets) };
  };
  const extracted = [];
  const save = (name, pdf) => {
    mkdirSync(SAMPLES, { recursive: true });
    const file = join(SAMPLES, `${name}.pdf`);
    writeFileSync(file, pdf);
    extracted.push(file);
    return pdfText(pdf).join("\n");
  };
  it("quotation with line and overall discounts: every amount printed and totals right", () => {
    const { snap, pdf } = make("quotation");
    assert.equal(snap.totals.payable, 1119900);
    const text = save("quotation", pdf);
    for (const want of [
      "QUOTATION",
      "Not a tax invoice",
      "QT/26-27/0001",
      "14 Oct 2026",
      "31 Oct 2026",
      "Cafe Blue LLP",
      "GSTIN: 27AABCC1234D1ZB",
      "Place of supply: Maharashtra (27)",
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
      "9,490.50", // taxable total
      "18% (9% + 9%)",
      "854.15", // CGST and SGST total
      "CGST 769.50", // line a: tax amount per line (Rule 46)
      "SGST 769.50",
      "CGST 84.65", // line b: 940.50 × 9 % = 84.645 → 84.65
      "Pay only to the account above.",
      "Round off",
      "+0.20",
      "Total (Rs.)",
      "11,199.00",
      "Amount in words: Rupees Eleven Thousand One Hundred Ninety-Nine Only",
      "Terms and conditions",
      "2. This quotation is valid until 31 Oct 2026.",
      "Payment details",
      "HDFC0000001",
      "sandbee@examplebank",
      "For Sandbee Technologies Private Limited",
      "Page 1 of 1",
      "QT/26-27/0001 v1",
    ])
      assert.ok(text.includes(want), `quotation lacks ${want}`);
    assert.equal(
      pdfObjects(pdf).filter((o) => /\/Subtype \/Image/.test(o.dict)).length,
      4,
    );
  });
  it("agreement: parties, client-specific text, schedule and both signatures", () => {
    const { snap, pdf } = make("agreement", {
      overrides: {
        agreementBody:
          "# Special terms\nThis agreement is for {{client.name}} only, total {{deal.total}}.",
      },
    });
    assert.equal(snap.textSource, "client");
    const text = save("agreement", pdf);
    for (const want of [
      "AGREEMENT",
      "AG/26-27/0001",
      "PROVIDER",
      "CLIENT",
      "Special terms",
      "This agreement is for Cafe Blue LLP only, total Rs. 11,199.00.",
      "Schedule A - Commercials",
      "11,199.00",
      "For Cafe Blue LLP",
      "Authorised signatory (name, title)",
      "Director",
      "Quotation ref.",
    ])
      assert.ok(text.includes(want), `agreement lacks ${want}`);
    // The default sample text is used when there is no override.
    assert.ok(
      pdfText(make("agreement").pdf).join("\n").includes("SAMPLE TEXT"),
    );
  });
  it("tax invoice: Rule 46 particulars, intra-state", () => {
    const { snap, pdf } = make("invoice");
    assert.equal(snap.dueDate, "2026-10-21");
    const text = save("invoice", pdf);
    for (const want of [
      "TAX INVOICE",
      "ORIGINAL FOR RECIPIENT",
      "Invoice No.",
      "INV/26-27/0001",
      "Invoice date",
      "Due date",
      "21 Oct 2026",
      "Place of supply",
      "Maharashtra (27)",
      "Reverse charge",
      "GSTIN: 27AAACS9999K1ZD",
      "GSTIN: 27AABCC1234D1ZB",
      "Tax: CGST + SGST (intra-state)",
      "CGST",
      "SGST",
      "854.15",
      "11,199.00",
      "Computer-generated tax invoice",
      "Director",
    ])
      assert.ok(text.includes(want), `invoice lacks ${want}`);
    assert.equal(text.includes("INV/26-27/0001 v1"), false);
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
    const { snap, pdf } = make("invoice", {
      deal: deal2,
      number: "INV/26-27/0002",
    });
    assert.equal(snap.totals.igst, 170829);
    assert.equal(snap.totals.roundOff, 21);
    const text = save("invoice-igst", pdf);
    for (const want of [
      "IGST",
      "1,708.29",
      "18% IGST",
      "IGST 1,539.00",
      "IGST 169.29",
      "+0.21",
      "11,199.00",
      "GSTIN: Unregistered",
      "Karnataka (29)",
      "Tax: IGST (inter-state)",
    ])
      assert.ok(text.includes(want), `IGST invoice lacks ${want}`);
    assert.equal(text.includes("CGST"), false);
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
    const { pdf } = make("quotation", {
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
    assert.ok(pages[1].includes("Item / SAC"));
    assert.ok(pages.join("\n").includes("Line 50:"));
  });
  it("wraps long party and bank details inside their columns", () => {
    const address =
      "Unit 1204, 12th Floor, Shapath Hexa, Opposite Gujarat High Court, S.G. Highway";
    const wide = dealFixture({ billTo: { ...BILL_TO, address: [address] } });
    const local = settingsFixture({
      bank: {
        ...settings.bank,
        bankName: "State Bank of India",
        branch: "Commercial Branch, Ashram Road, Ahmedabad",
      },
    });
    local.images = { logo: null, signature: null };
    for (const type of ["quotation", "agreement"]) {
      const snap = snapshotOf({
        settings: local,
        overrides: {},
        deal: wide,
        type,
        number: "X/1",
        version: 1,
        issuedAt: ISSUED,
      });
      const lines = pdfText(renderDocument(snap)).join("\n").split("\n");
      // No single drawn line holds the whole address; together they do.
      assert.equal(lines.includes(address), false, type);
      assert.ok(lines.join(" ").includes("Opposite Gujarat High"), type);
      assert.ok(lines.join(" ").includes("S.G. Highway"), type);
      if (type === "quotation")
        assert.ok(
          lines.join(" ").includes("Ahmedabad"),
          "bank branch is not cut off",
        );
    }
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
    const snap = snapshotOf({
      settings: ut,
      overrides: {},
      deal: deal4,
      type: "quotation",
      number: "QT/26-27/0009",
      version: 1,
      issuedAt: ISSUED,
    });
    const text = pdfText(renderDocument(snap)).join("\n");
    for (const want of [
      "UTGST 769.50",
      "Tax: CGST + UTGST (intra-state)",
      "UTGST",
    ])
      assert.ok(text.includes(want), want);
    assert.equal(/\bSGST\b/.test(text.replaceAll("UTGST", "")), false);
    const stamped = pdfText(
      renderDocument(snap, {}, { stamp: "CANCELLED" }),
    ).join("\n");
    assert.ok(stamped.includes("CANCELLED"));
    assert.equal(
      pdfText(renderDocument(snap)).join("\n").includes("CANCELLED"),
      false,
    );
  });
  it("re-rendering a snapshot gives the same bytes", () => {
    const { snap, pdf } = make("invoice");
    assert.ok(
      renderDocument(JSON.parse(JSON.stringify(snap)), assets).equals(pdf),
    );
  });
  it("an independent extractor (pdftotext) reads the samples, when installed", (t) => {
    const probe = spawnSync("pdftotext", ["-v"], { encoding: "utf8" });
    if (probe.error) return t.skip("pdftotext is not installed");
    for (const file of extracted) {
      const out = spawnSync("pdftotext", ["-layout", file, "-"], {
        encoding: "utf8",
      });
      assert.equal(out.status, 0, file);
      assert.ok(out.stdout.includes("11,199.00"), file);
      assert.ok(
        out.stdout.includes(
          "Rupees Eleven Thousand One Hundred Ninety-Nine Only",
        ),
        file,
      );
    }
  });
});
