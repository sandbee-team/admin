// FROZEN: the renderer of snapshot format 1 (documents issued before
// 2026-10-15, all GST-registered by construction). Issued documents are
// immutable and are re-rendered from their snapshot (downloads without an
// archive copy, cancelled copies, "Store copy" only when the re-render equals
// the issue hash), so this code must keep producing the same bytes: never
// change it. New documents use format 2 (sales-pdf.js).
import { PdfDocument, A4, wrap, textWidth } from "./pdf.js";
import {
  formatPaise,
  formatQty,
  formatPercent,
  formatDate,
  amountInWords,
  stateName,
  localTaxLabel,
} from "../../shared/sales.js";

// ---- Layout --------------------------------------------------------------------
const M = 40,
  W = A4.width - 2 * M,
  RIGHT = A4.width - M,
  TOP = 40,
  BOTTOM = A4.height - 56;
const INK = [0.1, 0.12, 0.11],
  MUTED = [0.36, 0.41, 0.39],
  RULE = [0.8, 0.84, 0.82],
  BRAND = [0.098, 0.231, 0.204],
  FILL = [0.945, 0.957, 0.949];
const TITLES = {
  quotation: "QUOTATION",
  agreement: "AGREEMENT",
  invoice: "TAX INVOICE",
};
const NUMBER_LABEL = {
  quotation: "Quotation No.",
  agreement: "Agreement No.",
  invoice: "Invoice No.",
};
const FOOTER_NOTE = {
  quotation: "Quotation - not a tax invoice",
  agreement: "Agreement",
  invoice: "Computer-generated tax invoice",
};

class Flow {
  // watermark: text drawn diagonally behind every page, or "".
  constructor(doc, watermark) {
    this.doc = doc;
    this.watermark = watermark;
    this.onBreak = null;
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage();
    if (this.watermark)
      this.page.rotated(this.watermark, 110, 640, 40, {
        size: 54,
        color: [0.88, 0.9, 0.89],
      });
    this.y = TOP;
  }
  // Starts a new page when `h` more points do not fit.
  need(h) {
    if (this.y + h <= BOTTOM) return false;
    this.newPage();
    this.onBreak?.();
    return true;
  }
  // Wrapped text at the cursor, breaking pages between lines.
  para(
    text,
    {
      x = M,
      width = W,
      font = "regular",
      size = 9,
      color = INK,
      leading = 1.38,
    } = {},
  ) {
    const step = size * leading;
    for (const line of wrap(text, font, size, width)) {
      this.need(step);
      this.page.text(line, x, this.y + size * 0.8, { font, size, color });
      this.y += step;
    }
  }
  heading(text) {
    this.need(40);
    this.y += 6;
    this.page.text(text, M, this.y + 8, {
      font: "bold",
      size: 10,
      color: BRAND,
    });
    this.y += 16;
  }
}
// Draws lines of text at (x, y) without page breaks; returns the height used.
function block(page, lines, x, y, { align = "left" } = {}) {
  let h = 0;
  for (const [text, opts = {}] of lines) {
    if (!text) continue;
    const size = opts.size ?? 8.5;
    page.text(text, x, y + h + size * 0.8, {
      color: INK,
      ...opts,
      size,
      align,
    });
    h += size * 1.38;
  }
  return h;
}
const fit = (image, maxW, maxH) => {
  const scale = Math.min(maxW / image.width, maxH / image.height, 1.5);
  return { w: image.width * scale, h: image.height * scale };
};

function partyLines(party, { title, gstinFallback = "" }) {
  return [
    [title, { size: 7.5, color: MUTED, font: "bold" }],
    [party.legalName ?? party.name, { font: "bold", size: 10 }],
    ...(party.tradeName && party.tradeName !== party.legalName
      ? [[party.tradeName, { color: MUTED }]]
      : []),
    ...(party.address ?? []).map((a) => [a]),
    // Rule 46: State name and code.
    [
      [
        [party.city, party.pincode].filter(Boolean).join(" - "),
        party.stateCode
          ? `${stateName(party.stateCode)} (${party.stateCode})`
          : "",
      ]
        .filter(Boolean)
        .join(", "),
    ],
    [
      [
        party.gstin ? `GSTIN: ${party.gstin}` : gstinFallback,
        party.pan ? `PAN: ${party.pan}` : "",
      ]
        .filter(Boolean)
        .join("  |  "),
    ],
    [[party.email, party.phone, party.website].filter(Boolean).join("  |  ")],
  ];
}

function header(flow, s, assets) {
  const page = flow.page,
    leftW = 290;
  let left = TOP;
  if (assets.logo) {
    const { w, h } = fit(assets.logo, 150, 52);
    page.image(assets.logo, M, left, w, h);
    left += h + 8;
  }
  // The agreement repeats the company under "Provider": its header keeps the name only.
  const own = partyLines(s.seller, { title: "" }).slice(1);
  left += block(
    page,
    wrapLines(s.type === "agreement" ? own.slice(0, 1) : own, leftW),
    M,
    left,
  );
  // Right column: title and document facts.
  let right = TOP;
  page.text(TITLES[s.type], RIGHT, right + 15, {
    font: "bold",
    size: 18,
    color: BRAND,
    align: "right",
  });
  right += 22;
  const sub =
    s.type === "invoice"
      ? "ORIGINAL FOR RECIPIENT"
      : s.type === "quotation"
        ? "Not a tax invoice"
        : "";
  if (sub) {
    page.text(sub, RIGHT, right + 8, {
      size: 7.5,
      color: MUTED,
      align: "right",
    });
    right += 14;
  }
  const facts = [
    [NUMBER_LABEL[s.type], s.number ?? "DRAFT"],
    ...(s.type !== "invoice" && s.number
      ? [["Version", String(s.version)]]
      : []),
    [s.type === "invoice" ? "Invoice date" : "Date", formatDate(s.date)],
    ...(s.type === "quotation"
      ? [["Valid until", formatDate(s.deal.validUntil)]]
      : []),
    ...(s.type === "invoice" ? [["Due date", formatDate(s.dueDate)]] : []),
    ...(s.type === "invoice"
      ? [
          [
            "Place of supply",
            `${s.deal.placeOfSupplyName} (${s.deal.placeOfSupply})`,
          ],
          ["Reverse charge", "No"],
        ]
      : []),
    ...(s.quotationRef ? [["Quotation ref.", s.quotationRef]] : []),
  ];
  for (const [label, value] of facts) {
    const labelEnd = 352 + textWidth(label, "regular", 8) + 6,
      size = textWidth(value, "bold", 8.5) > RIGHT - labelEnd ? 7.5 : 8.5;
    page.text(label, 352, right + 8, { size: 8, color: MUTED });
    const over = textWidth(value, "bold", size) > RIGHT - labelEnd,
      parts = over ? wrap(value, "bold", size, RIGHT - 352) : [value];
    // A value too wide for the space beside its label starts below it.
    if (over) right += 11;
    for (const part of parts) {
      page.text(part, RIGHT, right + 8, { font: "bold", size, align: "right" });
      right += over ? 10.5 : 12.5;
    }
    if (over) right += 2;
  }
  flow.y = Math.max(left, right) + 8;
  page.line(M, flow.y, RIGHT, flow.y, { color: BRAND, width: 1 });
  flow.y += 10;
}

// Every entry wrapped to `width`, so nothing runs into the next column.
const wrapLines = (lines, width) =>
  lines.flatMap(([t, o]) =>
    t
      ? wrap(t, o?.font ?? "regular", o?.size ?? 8.5, width).map((part) => [
          part,
          o,
        ])
      : [],
  );
function parties(flow, s) {
  const page = flow.page,
    half = W / 2 - 10;
  let leftH, rightH;
  if (s.type === "agreement") {
    leftH = block(
      page,
      wrapLines(partyLines(s.seller, { title: "PROVIDER" }), half),
      M,
      flow.y,
    );
    rightH = block(
      page,
      wrapLines(
        partyLines(s.buyer, {
          title: "CLIENT",
          gstinFallback: "GSTIN: Unregistered",
        }),
        half,
      ),
      M + half + 20,
      flow.y,
    );
  } else {
    leftH = block(
      page,
      wrapLines(
        partyLines(s.buyer, {
          title: "BILL TO",
          gstinFallback: "GSTIN: Unregistered",
        }),
        half,
      ),
      M,
      flow.y,
    );
    const facts = [
      ["SUBJECT", { size: 7.5, color: MUTED, font: "bold" }],
      [s.deal.title, { font: "bold", size: 10 }],
      [
        `Place of supply: ${s.deal.placeOfSupplyName} (${s.deal.placeOfSupply})`,
      ],
      [
        s.totals.intra
          ? `Tax: CGST + ${localTaxLabel(s.deal.placeOfSupply)} (intra-state)`
          : "Tax: IGST (inter-state)",
      ],
    ];
    rightH = block(page, wrapLines(facts, half), M + half + 20, flow.y);
  }
  flow.y += Math.max(leftH, rightH) + 10;
}

const COLS = [
  { label: "#", w: 16, align: "left" },
  { label: "Item / SAC", w: 0, align: "left" },
  { label: "Qty", w: 40, align: "right" },
  { label: "Rate", w: 60, align: "right" },
  { label: "Discount", w: 54, align: "right" },
  { label: "Taxable", w: 66, align: "right" },
  { label: "GST", w: 66, align: "right" },
  { label: "Amount", w: 70, align: "right" },
];
COLS[1].w = W - COLS.reduce((a, c) => a + c.w, 0);
const PAD = 4;
function cellX(i) {
  let x = M;
  for (let k = 0; k < i; k++) x += COLS[k].w;
  return COLS[i].align === "right" ? x + COLS[i].w - PAD : x + PAD;
}
function tableHead(flow) {
  flow.page.rect(M, flow.y, W, 17, { fill: FILL });
  COLS.forEach((c, i) =>
    flow.page.text(c.label, cellX(i), flow.y + 11.5, {
      font: "bold",
      size: 7.5,
      color: MUTED,
      align: c.align,
    }),
  );
  flow.y += 17;
}
function discountCell(line, row) {
  if (line.discount.type === "percent" && row.discount)
    return [
      formatPercent(line.discount.value),
      `-${formatPaise(row.discount)}`,
    ];
  if (row.discount) return [`-${formatPaise(row.discount)}`];
  return ["-"];
}
// The largest size (≤ `size`, ≥ 5.5) at which `text` fits `width`.
const fitSize = (text, font, size, width) =>
  Math.max(
    5.5,
    Math.min(size, (size * width) / Math.max(textWidth(text, font, size), 1)),
  );
// Rate on the first line, then each tax amount (CGST and SGST/UTGST, or IGST).
function taxCell(s, row) {
  if (!row.tax && !row.rate) return [formatPercent(0)];
  return s.totals.intra
    ? [
        `${formatPercent(row.rate / 2)} + ${formatPercent(row.rate / 2)}`,
        `CGST ${formatPaise(row.cgst)}`,
        `${localTaxLabel(s.deal.placeOfSupply)} ${formatPaise(row.sgst)}`,
      ]
    : [formatPercent(row.rate), `IGST ${formatPaise(row.igst)}`];
}
function linesTable(flow, s) {
  flow.need(60);
  tableHead(flow);
  flow.onBreak = () => tableHead(flow);
  s.lines.forEach((line, i) => {
    const row = s.totals.lines[i],
      desc = wrap(line.description, "regular", 8.5, COLS[1].w - 2 * PAD);
    const cells = [
      [String(i + 1)],
      null,
      [formatQty(line.qty), line.unit],
      [formatPaise(line.unitPrice)],
      discountCell(line, row),
      [formatPaise(row.taxable)],
      taxCell(s, row),
      [formatPaise(row.amount)],
    ];
    const tallest = Math.max(
      ...cells.filter(Boolean).map((c) => c.filter(Boolean).length),
    );
    const h = Math.max(desc.length * 11 + 10, tallest * 11, 2 * 11) + 8;
    flow.need(h);
    const top = flow.y + 4;
    desc.forEach((t, k) =>
      flow.page.text(t, cellX(1), top + 8 + k * 11, { size: 8.5 }),
    );
    flow.page.text(`SAC ${line.sac}`, cellX(1), top + 8 + desc.length * 11, {
      size: 7,
      color: MUTED,
    });
    cells.forEach((cell, c) => {
      if (!cell) return;
      const room = COLS[c].w - 2 * PAD;
      cell.filter(Boolean).forEach((t, k) =>
        flow.page.text(t, cellX(c), top + 8 + k * 11, {
          size: fitSize(t, "regular", k ? 7 : 8.5, room),
          color: k ? MUTED : INK,
          align: COLS[c].align,
        }),
      );
    });
    flow.y += h;
    flow.page.line(M, flow.y, RIGHT, flow.y, { color: RULE });
  });
  flow.onBreak = null;
  flow.y += 8;
}

// Tax by rate (Rule 46: rate and amount of each tax).
function taxSummary(flow, s, x, width) {
  const t = s.totals,
    cols = t.intra
      ? [
          ["Rate", 0.24],
          ["Taxable", 0.2],
          ["CGST", 0.18],
          [localTaxLabel(s.deal.placeOfSupply), 0.18],
          ["Total tax", 0.2],
        ]
      : [
          ["Rate", 0.24],
          ["Taxable", 0.38],
          ["IGST", 0.38],
        ];
  const edges = [];
  let acc = x;
  for (const [, share] of cols) edges.push((acc += share * width));
  const at = (i) => (i ? edges[i] - PAD : x + PAD);
  let y = flow.y;
  flow.page.rect(x, y, width, 15, { fill: FILL });
  cols.forEach(([label], i) =>
    flow.page.text(label, at(i), y + 10.5, {
      font: "bold",
      size: 7.5,
      color: MUTED,
      align: i ? "right" : "left",
    }),
  );
  y += 15;
  for (const r of t.rates) {
    const values = t.intra
      ? [
          `${formatPercent(r.rate)} (${formatPercent(r.rate / 2)} + ${formatPercent(r.rate / 2)})`,
          formatPaise(r.taxable),
          formatPaise(r.cgst),
          formatPaise(r.sgst),
          formatPaise(r.cgst + r.sgst),
        ]
      : [
          `${formatPercent(r.rate)} IGST`,
          formatPaise(r.taxable),
          formatPaise(r.igst),
        ];
    values.forEach((v, i) =>
      flow.page.text(v, at(i), y + 10, {
        size: fitSize(
          v,
          "regular",
          7.5,
          (i ? edges[i] - edges[i - 1] : edges[0] - x) - 2 * PAD,
        ),
        align: i ? "right" : "left",
      }),
    );
    y += 14;
    flow.page.line(x, y, x + width, y, { color: RULE });
  }
  return y - flow.y;
}

function totalsBlock(flow, s) {
  const t = s.totals,
    x = M + W - 215,
    rows = [["Subtotal", formatPaise(t.gross)]];
  if (t.lineDiscount)
    rows.push(["Line discounts", `-${formatPaise(t.lineDiscount)}`]);
  if (t.overallDiscount)
    rows.push([
      s.discount.type === "percent"
        ? `Overall discount (${formatPercent(s.discount.value)})`
        : "Overall discount",
      `-${formatPaise(t.overallDiscount)}`,
    ]);
  rows.push(["Taxable value", formatPaise(t.taxable)]);
  if (t.intra)
    rows.push(
      ["CGST", formatPaise(t.cgst)],
      [localTaxLabel(s.deal.placeOfSupply), formatPaise(t.sgst)],
    );
  else rows.push(["IGST", formatPaise(t.igst)]);
  if (s.roundOff)
    rows.push([
      "Round off",
      `${t.roundOff > 0 ? "+" : ""}${formatPaise(t.roundOff)}`,
    ]);
  const height = rows.length * 13 + 22;
  flow.need(Math.max(height, 20 + t.rates.length * 14) + 40);
  const top = flow.y;
  const summaryH = t.rates.length ? taxSummary(flow, s, M, W - 235) : 0;
  let y = top;
  for (const [label, value] of rows) {
    flow.page.text(label, x, y + 9, { size: 8.5, color: MUTED });
    flow.page.text(value, RIGHT, y + 9, { size: 8.5, align: "right" });
    y += 13;
  }
  flow.page.rect(x - 6, y + 1, 215 + 6, 19, { fill: FILL });
  flow.page.text("Total (Rs.)", x, y + 14, { font: "bold", size: 10 });
  flow.page.text(formatPaise(t.payable), RIGHT, y + 14, {
    font: "bold",
    size: 10,
    align: "right",
  });
  y += 24;
  flow.y = Math.max(y, top + summaryH) + 6;
  flow.para(`Amount in words: ${amountInWords(t.payable)}`, {
    font: "bold",
    size: 8.5,
  });
  flow.y += 4;
}

// Payment details at (x, y) on one page; returns the height used.
function bankBlock(page, s, x, y) {
  const b = s.bank,
    rows = [
      ["Account name", b.accountName],
      ["Account number", b.accountNumber],
      ["IFSC", b.ifsc],
      ["Bank", [b.bankName, b.branch].filter(Boolean).join(", ")],
      ["UPI ID", b.upiId],
    ].filter(([, v]) => v);
  if (!rows.length) return 0;
  page.text("Payment details", x, y + 14, {
    font: "bold",
    size: 10,
    color: BRAND,
  });
  let h = 22;
  for (const [label, value] of rows) {
    page.text(label, x, y + h + 8, { size: 8.5, color: MUTED });
    for (const part of wrap(value, "regular", 8.5, 180)) {
      page.text(part, x + 90, y + h + 8, { size: 8.5 });
      h += 12;
    }
  }
  page.text(
    "Pay only to the account above. Our bank details never change by e-mail or phone.",
    x,
    y + h + 10,
    {
      font: "bold",
      size: 7,
      color: MUTED,
    },
  );
  return h + 14;
}

function textBody(flow, text) {
  for (const raw of String(text).split("\n")) {
    if (!raw.trim()) {
      flow.y += 5;
      continue;
    }
    if (raw.startsWith("# ")) flow.heading(raw.slice(2));
    else flow.para(raw, { size: 9 });
  }
}

function sellerSignature(page, s, assets, x, y0, width) {
  let y = y0;
  for (const part of wrap(`For ${s.seller.legalName}`, "bold", 8.5, width)) {
    page.text(part, x, y + 8, { font: "bold", size: 8.5 });
    y += 12;
  }
  y += 2;
  if (assets.signature) {
    const { w, h } = fit(assets.signature, Math.min(140, width), 46);
    page.image(assets.signature, x, y, w, h);
    y += 48;
  } else y += 34;
  page.line(x, y, x + Math.min(160, width), y, { color: RULE });
  y += 4;
  y += block(
    page,
    wrapLines(
      [
        [s.signatory.name, { font: "bold" }],
        [s.signatory.title || "Authorised Signatory", { color: MUTED }],
      ],
      width,
    ),
    x,
    y,
  );
  return y - y0;
}

// Quotation/invoice: payment details left, the seller's signature right.
// Agreement: both parties' signature blocks.
// Draws nothing: lets a block report its height before it is placed.
const MEASURE = { text() {}, line() {}, image() {}, rect() {} };
function closing(flow, s, assets) {
  const half = W / 2 - 10,
    height =
      s.type !== "agreement"
        ? Math.max(
            bankBlock(MEASURE, s, M, 0),
            sellerSignature(MEASURE, s, assets, 0, 6, 200) + 6,
          )
        : Math.max(sellerSignature(MEASURE, s, assets, 0, 0, half), 110);
  flow.need(height + 12);
  const top = flow.y + 6,
    page = flow.page;
  if (s.type !== "agreement") {
    const left = bankBlock(page, s, M, top),
      right = sellerSignature(page, s, assets, RIGHT - 200, top + 6, 200) + 6;
    flow.y = top + Math.max(left, right);
    return;
  }
  const left = sellerSignature(page, s, assets, M, top, half),
    x = M + half + 20;
  let y = top;
  for (const part of wrap(`For ${s.buyer.name}`, "bold", 8.5, half)) {
    page.text(part, x, y + 8, { font: "bold", size: 8.5 });
    y += 12;
  }
  y += 50;
  page.line(x, y, x + 160, y, { color: RULE });
  y += 4;
  y += block(
    page,
    [
      ["Authorised signatory (name, title)", { color: MUTED }],
      ["Date:", { color: MUTED }],
    ],
    x,
    y,
  );
  flow.y = top + Math.max(left, y - top);
}

function footers(doc, s) {
  const total = doc.pages.length,
    label = s.number
      ? s.type === "invoice"
        ? s.number
        : `${s.number} v${s.version}`
      : "DRAFT - NOT ISSUED";
  doc.pages.forEach((page, i) => {
    const y = A4.height - 34;
    page.line(M, y - 10, RIGHT, y - 10, { color: RULE });
    page.text(label, M, y, { size: 7.5, color: MUTED });
    page.text(FOOTER_NOTE[s.type], A4.width / 2, y, {
      size: 7.5,
      color: MUTED,
      align: "center",
    });
    page.text(`Page ${i + 1} of ${total}`, RIGHT, y, {
      size: 7.5,
      color: MUTED,
      align: "right",
    });
  });
}

// assets: {logo, signature} parsed images (pdf-images.js) or null.
// options.stamp: a watermark for a re-rendered copy (e.g. "CANCELLED").
export function renderFormat1(s, assets = {}, { stamp = "" } = {}) {
  const label = s.number
    ? s.type === "invoice"
      ? s.number
      : `${s.number} v${s.version}`
    : "Draft";
  const doc = new PdfDocument({
    title: `${TITLES[s.type][0]}${TITLES[s.type].slice(1).toLowerCase()} ${label}`,
    author: s.seller.legalName,
    subject: s.deal.title,
    createdAt: s.issuedAt,
  });
  const images = {
    logo: assets.logo ?? null,
    signature: assets.signature ?? null,
  };
  const flow = new Flow(doc, s.draft ? "DRAFT - NOT ISSUED" : stamp);
  header(flow, s, images);
  parties(flow, s);
  if (s.type === "agreement") {
    textBody(flow, s.text);
    flow.heading("Schedule A - Commercials");
    linesTable(flow, s);
    totalsBlock(flow, s);
    if (s.deal.notes) {
      flow.heading("Notes");
      flow.para(s.deal.notes);
    }
  } else {
    linesTable(flow, s);
    totalsBlock(flow, s);
    if (s.deal.notes) {
      flow.heading("Notes");
      flow.para(s.deal.notes);
    }
    if (s.text.trim()) {
      flow.heading(s.type === "invoice" ? "Terms" : "Terms and conditions");
      textBody(flow, s.text);
    }
  }
  closing(flow, s, images);
  footers(doc, s);
  return doc.toBuffer();
}
