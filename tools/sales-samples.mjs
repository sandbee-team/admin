// Dev only (not part of npm test): writes sample sales PDFs to
// test-results/sales-samples-v2/ and, when a rasteriser is installed
// (poppler's pdftoppm, or Python with PyMuPDF), a PNG of every page.
//   node tools/sales-samples.mjs [dpi]
import { mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { snapshotOf, renderDocument } from "../backend/lib/sales-pdf.js";
import { parseImage } from "../backend/lib/pdf-images.js";
import {
  settingsFixture,
  dealFixture,
  COMPANY,
  BILL_TO,
  LOGO,
  SIGNATURE,
} from "../test/sales-fixtures.js";

const OUT = join("test-results", "sales-samples-v2");
const DPI = Number(process.argv[2] ?? 70);
const ISSUED = new Date("2026-10-14T06:30:00Z");

const sandbee = (over = {}) =>
  settingsFixture({
    company: {
      legalName: "Sandbee",
      email: "hello@sandbee.in",
      phone: "+91 98250 12345",
      jurisdiction: "Ahmedabad",
    },
    bank: {},
    signatory: { name: "A. Founder", title: "Founder" },
    gst: { registered: false },
    ...over,
  });
const cafe = {
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
const line = (id, description, qty, rupees, over = {}) => ({
  id,
  productId: "",
  description,
  sac: "998314",
  unit: "nos",
  qty: qty * 1000,
  unitPrice: Math.round(rupees * 100),
  discount: { type: "none", value: 0 },
  gstRate: 1800,
  ...over,
});
const LINES = [
  line(
    "a",
    "Sandbee POS - one-time setup and onboarding (menu, tables, staff logins, printers and payment modes)",
    1,
    15000,
    { discount: { type: "percent", value: 1000 } },
  ),
  line("b", "Sandbee POS subscription - 1 outlet, billed yearly", 12, 1499, {
    unit: "months",
    sac: "998315",
    discount: { type: "amount", value: 50000 },
  }),
  line("c", "WhatsApp order and bill notifications - setup", 1, 2500),
  line("d", "Additional support and training (on request)", 3, 800, {
    unit: "hours",
    sac: "998313",
  }),
];
const deal = (over = {}) =>
  dealFixture({
    title: "Sandbee POS for Cafe Blue - setup and first year",
    billTo: cafe,
    placeOfSupply: "",
    lines: LINES,
    discount: { type: "percent", value: 500 },
    validUntil: "2026-10-31",
    notes:
      "Prices include onboarding for two staff members. Hosting, domain and WhatsApp charges are paid by Cafe Blue directly to those providers.",
    ...over,
  });
const assets = { logo: parseImage(LOGO), signature: parseImage(SIGNATURE) };
const NUMBERS = {
  quotation: "QT/26-27/0012",
  agreement: "AG/26-27/0004",
  invoice: "INV/26-27/0009",
};
const samples = [
  ["1-quotation", "quotation", sandbee(), deal(), {}],
  [
    "2-agreement",
    "agreement",
    sandbee(),
    deal(),
    { signature: assets.signature },
  ],
  [
    "3-invoice",
    "invoice",
    sandbee({
      bank: {
        accountName: "Sandbee",
        accountNumber: "50200012345678",
        ifsc: "HDFC0001234",
        bankName: "HDFC Bank",
        branch: "Navrangpura, Ahmedabad",
        upiId: "sandbee@hdfcbank",
      },
    }),
    deal(),
    {},
  ],
  [
    "4-tax-invoice-gst",
    "invoice",
    settingsFixture({
      company: { ...COMPANY, jurisdiction: "Pune" },
      signatory: { name: "A. Founder", title: "Director" },
    }),
    deal({ billTo: BILL_TO, placeOfSupply: "27" }),
    assets,
  ],
  [
    "5-quotation-long",
    "quotation",
    sandbee(),
    deal({
      lines: Array.from({ length: 34 }, (_, i) =>
        line(
          `l${i}`,
          i % 3
            ? `Outlet ${i + 1}: Sandbee POS subscription, 12 months`
            : `Outlet ${i + 1}: one-time setup, menu import, staff training and printer configuration at the outlet`,
          i % 3 ? 12 : 1,
          i % 3 ? 1499 : 9500,
          i % 3 ? { unit: "months" } : {},
        ),
      ),
    }),
    {},
  ],
  [
    "6-quotation-gst-draft",
    "quotation",
    settingsFixture({ signatory: { name: "A. Founder", title: "Director" } }),
    deal({ billTo: BILL_TO, placeOfSupply: "27" }),
    assets,
  ],
];

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(join(OUT, f));
const files = [];
for (const [name, type, settings, d, images] of samples) {
  const draft = name.includes("draft");
  const snap = snapshotOf({
    settings,
    overrides: {},
    deal: d,
    type,
    number: draft ? null : NUMBERS[type],
    version: 1,
    issuedAt: ISSUED,
    draft,
    quotationRef: type === "quotation" ? null : "QT/26-27/0012 v1",
  });
  const file = join(OUT, `${name}.pdf`);
  writeFileSync(file, renderDocument(snap, images));
  files.push(file);
}
console.log(`wrote ${files.length} PDFs to ${OUT}`);

const poppler = spawnSync("pdftoppm", ["-v"]);
if (!poppler.error) {
  for (const file of files)
    spawnSync("pdftoppm", ["-png", "-r", String(DPI), file, file.slice(0, -4)]);
} else {
  const python = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-c",
      [
        "import sys, fitz",
        "dpi = int(sys.argv[1])",
        "for p in sys.argv[2:]:",
        "    for i, page in enumerate(fitz.open(p)):",
        "        page.get_pixmap(dpi=dpi).save(p[:-4] + '-' + str(i + 1) + '.png')",
      ].join("\n"),
      String(DPI),
      ...files,
    ],
    { encoding: "utf8" },
  );
  if (python.status !== 0) {
    console.log("No rasteriser (pdftoppm or Python + PyMuPDF): PDFs only.");
    process.exit(0);
  }
}
console.log(
  readdirSync(OUT)
    .filter((f) => f.endsWith(".png"))
    .join("\n"),
);
