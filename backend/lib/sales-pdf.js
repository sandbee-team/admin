// Quotation, service agreement and invoice PDFs (docs/SALES-DOCS-PLAN.md
// §5-§6). snapshotOf() freezes everything a document prints; renderDocument()
// turns a snapshot (+ parsed logo/signature) into PDF bytes and never reads
// anything else, so an issued document can always be re-rendered from its
// snapshot. Snapshots of format 1 keep the renderer that issued them
// (sales-pdf-v1.js), so they re-render to the same bytes.
import { PdfDocument, A4, wrap, textWidth } from "./pdf.js";
import { renderFormat1 } from "./sales-pdf-v1.js";
import {
  computeTotals,
  formatPaise,
  formatQty,
  formatPercent,
  formatDate,
  istDate,
  addDays,
  amountInWords,
  stateName,
  renderTemplate,
  TEMPLATE_FOR,
  formatRs,
  localTaxLabel,
  taxNoteOf,
} from "../../shared/sales.js";

// 2: GST registration is optional (gstRegistered), accent colour (design).
export const SNAPSHOT_FORMAT = 2;
export const DEFAULT_ACCENT = "#355E45";
const addressOf = (party) =>
  [
    ...(party.address ?? []),
    [party.city, party.pincode].filter(Boolean).join(" "),
    stateName(party.stateCode),
  ]
    .filter(Boolean)
    .join(", ");

// settings: the sales_settings row; overrides: the client's text overrides;
// deal: the sales_deals row. `number` is null for a draft preview.
export function snapshotOf({
  settings,
  overrides,
  deal,
  type,
  number,
  version,
  issuedAt,
  draft = false,
  quotationRef = null,
}) {
  const registered = settings.gst?.registered === true,
    // A seller without GST registration never prints a GSTIN, even one that
    // is still on file (in its party block or through {{company.gstin}}).
    company = {
      ...settings.company,
      gstin: registered ? settings.company.gstin : "",
    },
    totals = computeTotals(deal, {
      sellerState: company.stateCode,
      roundOff: settings.gst.roundOff,
      registered,
    });
  const date = istDate(issuedAt),
    validUntil =
      deal.validUntil || addDays(date, settings.quotation.validityDays),
    key = TEMPLATE_FOR[type],
    custom = typeof overrides?.[key] === "string";
  const values = {
    "company.legalName": company.legalName,
    "company.address": addressOf(company),
    "company.gstin": company.gstin,
    "company.pan": company.pan,
    "company.email": company.email,
    "company.phone": company.phone,
    // Issuing an agreement requires it; a draft preview falls back to the city.
    "company.jurisdiction": company.jurisdiction || company.city || "",
    "client.name": deal.billTo.name,
    "client.address": addressOf(deal.billTo),
    "client.gstin": deal.billTo.gstin || "Unregistered",
    "client.pan": deal.billTo.pan,
    "client.email": deal.billTo.email,
    "deal.title": deal.title,
    "deal.total": formatRs(totals.payable),
    "deal.totalWords": amountInWords(totals.payable),
    "deal.validUntil": formatDate(validUntil),
    "document.number": number ?? "DRAFT",
    "document.date": formatDate(date),
    "tax.note": taxNoteOf(registered),
  };
  return {
    format: SNAPSHOT_FORMAT,
    type,
    number,
    version,
    draft,
    issuedAt: new Date(issuedAt).toISOString(),
    date,
    gstRegistered: registered,
    design: { accent: settings.design?.accent || DEFAULT_ACCENT },
    seller: { ...company, stateName: stateName(company.stateCode) },
    bank: { ...settings.bank },
    signatory: { ...settings.signatory },
    images: {
      logo: settings.images?.logo?.sha256 ?? null,
      signature: settings.images?.signature?.sha256 ?? null,
    },
    buyer: { ...deal.billTo, stateName: stateName(deal.billTo.stateCode) },
    deal: {
      id: deal._id,
      title: deal.title,
      notes: deal.notes,
      placeOfSupply: deal.placeOfSupply,
      placeOfSupplyName: stateName(deal.placeOfSupply),
      validUntil: type === "quotation" ? validUntil : deal.validUntil || "",
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
    roundOff: settings.gst.roundOff,
    totals,
    text: renderTemplate(
      custom ? overrides[key] : settings.templates[key],
      values,
    ),
    textSource: custom ? "client" : "default",
    dueDate:
      type === "invoice" ? addDays(date, settings.invoice.dueDays) : null,
    quotationRef,
  };
}

// ---- Page geometry and colours (points, from the top-left of an A4 page) -----
const PW = A4.width,
  PH = A4.height,
  M = 44,
  W = PW - 2 * M,
  RIGHT = PW - M,
  TOP = 50,
  FOOT = PH - 44, // footer rule
  BOTTOM = FOOT - 20, // content ends above this
  GAP = 28, // between two columns
  HALF = (W - GAP) / 2;
const INK = [0.11, 0.13, 0.12],
  BODY = [0.24, 0.27, 0.26],
  MUTED = [0.45, 0.48, 0.47],
  FAINT = [0.62, 0.65, 0.64],
  RULE = [0.87, 0.89, 0.88],
  WASH = [0.965, 0.97, 0.968],
  WHITE = [1, 1, 1],
  BLACK = [0, 0, 0];

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
// The accent colour and what is derived from it: text in the accent colour is
// darkened until it reads on white (contrast >= 4.5:1).
function themeOf(accent) {
  const hex = /^#[0-9A-Fa-f]{6}$/.test(accent ?? "") ? accent : DEFAULT_ACCENT;
  const base = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  let text = base;
  for (let i = 0; i < 40 && luminance(text) > 0.18; i++)
    text = mix(text, BLACK, 0.12);
  return { accent: base, text, tint: mix(base, WHITE, 0.9) };
}

const registeredOf = (s) => s.gstRegistered !== false;
const sellerName = (s) => s.seller.legalName || s.seller.tradeName || "";
const TITLES = {
  quotation: () => "QUOTATION",
  agreement: () => "SERVICE AGREEMENT",
  invoice: (reg) => (reg ? "TAX INVOICE" : "INVOICE"),
};
const DOC_NAMES = {
  quotation: () => "Quotation",
  agreement: () => "Service agreement",
  invoice: (reg) => (reg ? "Tax invoice" : "Invoice"),
};
const FOOTER_NOTE = {
  quotation: (reg) =>
    reg ? "Quotation - not a tax invoice" : "Quotation - not an invoice",
  agreement: () => "",
  invoice: (reg) =>
    reg ? "Computer-generated tax invoice" : "Computer-generated invoice",
};

// Baseline of `size`-point text centred in a line box of height `lh` at `top`.
const base = (top, size, lh) => top + (lh - size) / 2 + size * 0.76;
const fitImage = (image, maxW, maxH) => {
  const scale = Math.min(maxW / image.width, maxH / image.height, 1.5);
  return { w: image.width * scale, h: image.height * scale };
};
// The largest size (≤ `size`, ≥ 5.5) at which `text` fits `width`.
const fitSize = (text, font, size, width) =>
  Math.max(
    5.5,
    Math.min(size, (size * width) / Math.max(textWidth(text, font, size), 1)),
  );
// A table cell's text inside `room`: shrunk when a little too wide, wrapped
// in small type when far too wide (an amount near the limits), never cut.
function cellLines(text, size, room) {
  const fitted = fitSize(text, "regular", size, room);
  if (fitted >= 6.4 && textWidth(text, "regular", fitted) <= room + 0.01)
    return [[text, fitted]];
  return wrap(text, "regular", 6.4, room).map((part) => [part, 6.4]);
}
// One line that never leaves `width`: shrunk a little, then shortened.
function clip(text, font, size, width) {
  const fitted = fitSize(text, font, size, width);
  if (textWidth(text, font, fitted) <= width) return [text, fitted];
  let cut = text;
  while (cut && textWidth(`${cut}...`, font, fitted) > width)
    cut = cut.slice(0, -1);
  return [`${cut.trimEnd()}...`, fitted];
}
// Draws nothing: lets a block report its height before it is placed.
const MEASURE = {
  text: () => 0,
  line() {},
  rect() {},
  roundRect() {},
  image() {},
};

class Flow {
  // watermark: text drawn diagonally behind every page, or "".
  constructor(doc, theme, watermark) {
    this.doc = doc;
    this.theme = theme;
    this.watermark = watermark;
    this.onBreak = null;
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage();
    if (this.watermark)
      this.page.rotated(this.watermark, 110, 640, 40, {
        size: 54,
        color: [0.9, 0.91, 0.905],
      });
    this.page.rect(0, 0, PW, 4, { fill: this.theme.accent });
    this.y = TOP;
  }
  breakPage() {
    this.newPage();
    this.onBreak?.();
  }
  // Starts a new page when `h` more points do not fit.
  need(h) {
    if (this.y + h <= BOTTOM) return false;
    this.breakPage();
    return true;
  }
  // Space before a block, dropped at the top of a page.
  space(h) {
    if (this.y > TOP) this.y += h;
  }
  // `count` lines of height `lh`; draw(i, top) draws line i. Never leaves a
  // single line of a paragraph alone at the bottom or the top of a page.
  lines(count, lh, draw) {
    let i = 0;
    while (i < count) {
      const left = count - i;
      let fit = Math.floor((BOTTOM - this.y) / lh + 1e-6);
      if (fit >= left) fit = left;
      else {
        if (left - fit === 1 && fit > 1) fit -= 1;
        if (fit < Math.min(2, left) && this.y > TOP) {
          this.breakPage();
          continue;
        }
      }
      for (let k = 0; k < fit; k++, i++) {
        draw(i, this.y);
        this.y += lh;
      }
      if (i < count) this.breakPage();
    }
  }
}

// Small capitals: a section label in letter-spaced bold.
function label(
  page,
  text,
  x,
  top,
  { color = MUTED, align = "left", size = 7 } = {},
) {
  page.text(text.toUpperCase(), x, base(top, size, 11), {
    font: "bold",
    size,
    color,
    spacing: 0.8,
    align,
  });
  return 11;
}

// Lines of a party block: {text, label?, font, size, color, gap?}.
function partyLines(party, role, reg) {
  const out = [],
    seller = role === "seller";
  out.push({
    text: (seller ? party.legalName || party.tradeName : party.name) || "-",
    font: "bold",
    size: 10.5,
    color: INK,
    lead: 1.35,
  });
  if (
    seller &&
    party.legalName &&
    party.tradeName &&
    party.tradeName !== party.legalName
  )
    out.push({ text: party.tradeName, color: MUTED });
  const address = (party.address ?? []).filter(Boolean),
    place = [party.city, party.pincode].filter(Boolean).join(" "),
    // Rule 46: the State name and code of both parties.
    state = party.stateCode
      ? reg
        ? `${stateName(party.stateCode)} (${party.stateCode})`
        : stateName(party.stateCode)
      : "";
  for (const text of address) out.push({ text });
  // Without GST registration an address is printed only when one is filled.
  if (reg || address.length || place) {
    const where = [place, state].filter(Boolean).join(", ");
    if (where) out.push({ text: where });
  }
  const ids = [];
  if (reg && (party.gstin || !seller))
    ids.push({ label: "GSTIN", text: party.gstin || "Unregistered" });
  else if (!reg && !seller && party.gstin)
    ids.push({ label: "GSTIN", text: party.gstin });
  if (party.pan) ids.push({ label: "PAN", text: party.pan });
  const contact = [party.email, party.phone, seller ? party.website : ""]
    .filter(Boolean)
    .map((text) => ({ text }));
  for (const group of [ids, contact])
    if (group.length) {
      if (out.length > 1) group[0].gap = 4;
      out.push(...group);
    }
  return out;
}
// Draws lines at (x, top) inside `width`; returns the height used.
function drawLines(page, lines, x, top, width) {
  let y = top;
  for (const l of lines) {
    const size = l.size ?? 8.8,
      font = l.font ?? "regular",
      lh = size * (l.lead ?? 1.5);
    y += l.gap ?? 0;
    const lw = l.label ? textWidth(l.label, "regular", 7.8) + 5 : 0;
    if (l.label)
      page.text(l.label, x, base(y, size, lh), { size: 7.8, color: MUTED });
    for (const part of wrap(l.text, font, size, width - lw)) {
      page.text(part, x + lw, base(y, size, lh), {
        font,
        size,
        color: l.color ?? (l.label ? INK : BODY),
      });
      y += lh;
    }
  }
  return y - top;
}

// ---- Header: logo or name, title and the document facts --------------------
function factsOf(s, reg) {
  const number = s.number ?? "DRAFT",
    version = s.number ? [["Version", String(s.version)]] : [],
    supply =
      reg && s.deal.placeOfSupply
        ? [
            [
              "Place of supply",
              `${s.deal.placeOfSupplyName} (${s.deal.placeOfSupply})`,
            ],
          ]
        : [],
    ref = s.quotationRef ? [["Quotation ref.", s.quotationRef]] : [];
  if (s.type === "quotation")
    return [
      ["Quotation No.", number, true],
      ...version,
      ["Date", formatDate(s.date)],
      ...(s.deal.validUntil
        ? [["Valid until", formatDate(s.deal.validUntil)]]
        : []),
      ...supply,
      ...ref,
    ];
  if (s.type === "agreement")
    return [
      ["Agreement No.", number, true],
      ...version,
      ["Effective date", formatDate(s.date)],
      ...ref,
    ];
  return [
    ["Invoice No.", number, true],
    ["Invoice date", formatDate(s.date)],
    ...(s.dueDate ? [["Due date", formatDate(s.dueDate)]] : []),
    ...supply,
    ...(reg ? [["Reverse charge", "No"]] : []),
    ...ref,
  ];
}
function header(flow, s, theme, assets, reg) {
  const page = flow.page,
    gridW = 232,
    gx = RIGHT - gridW,
    leftW = gx - M - GAP;
  // Left: the logo, or the company name as a wordmark.
  let left = TOP;
  if (assets.logo) {
    const { w, h } = fitImage(assets.logo, Math.min(180, leftW), 54);
    page.image(assets.logo, M, TOP, w, h);
    left += h;
  } else {
    const name = s.seller.tradeName || sellerName(s);
    for (const part of wrap(name, "bold", 18, leftW)) {
      page.text(part, M, base(left, 18, 22), {
        font: "bold",
        size: 18,
        color: INK,
      });
      left += 22;
    }
  }
  // Right: the title, a subtitle when GST-registered, then the facts.
  const title = TITLES[s.type](reg),
    size = fitSize(title, "bold", 24, gridW);
  page.text(title, RIGHT, base(TOP - 3, size, 28), {
    font: "bold",
    size,
    color: theme.text,
    align: "right",
  });
  let right = TOP + 27;
  const sub = reg
    ? { invoice: "Original for recipient", quotation: "Not a tax invoice" }[
        s.type
      ]
    : "";
  if (sub) right += label(page, sub, RIGHT, right, { align: "right" }) + 2;
  right += 8;
  const labelW = 84,
    valueW = gridW - labelW;
  for (const [name, value, strong] of factsOf(s, reg)) {
    const font = strong ? "bold" : "regular",
      parts = wrap(value, font, 8.6, valueW);
    page.text(name, gx, base(right, 8.6, 14), { size: 8.2, color: MUTED });
    parts.forEach((part, i) =>
      page.text(part, RIGHT, base(right + i * 12, 8.6, 14), {
        font,
        size: 8.6,
        color: INK,
        align: "right",
      }),
    );
    right += 14 + (parts.length - 1) * 12;
  }
  flow.y = Math.max(left, right) + 26;
}

function parties(flow, s, reg) {
  const [a, b] =
    s.type === "agreement" ? ["Provider", "Client"] : ["From", "Bill to"];
  const blocks = [
    [a, partyLines(s.seller, "seller", reg), M],
    [b, partyLines(s.buyer, "buyer", reg), M + HALF + GAP],
  ];
  const height = Math.max(
    ...blocks.map(([, lines]) => drawLines(MEASURE, lines, 0, 0, HALF)),
  );
  flow.need(height + 16);
  const page = flow.page,
    top = flow.y;
  for (const [name, lines, x] of blocks) {
    label(page, name, x, top);
    drawLines(page, lines, x, top + 16, HALF);
  }
  flow.y = top + 16 + height + 26;
}

// ---- Items table -------------------------------------------------------------
const PADX = 7,
  PADY = 8,
  L1 = 11.8, // a cell's first line (8.8 pt)
  L2 = 10.2; // its secondary lines (7.3 pt)
function columnsOf(s, reg) {
  const discount = s.totals.lines.some((r) => r.discount),
    cols = [
      { id: "n", label: "#", w: reg ? 20 : 22 },
      { id: "item", label: reg ? "Item / SAC" : "Description", w: 0 },
      { id: "qty", label: "Qty", w: reg ? 44 : 66, right: true },
      { id: "rate", label: "Rate", w: reg ? 60 : 76, right: true },
      ...(discount
        ? [{ id: "disc", label: "Discount", w: reg ? 56 : 72, right: true }]
        : []),
      ...(reg
        ? [
            { id: "taxable", label: "Taxable", w: 60, right: true },
            { id: "gst", label: "GST", w: 66, right: true },
          ]
        : []),
      { id: "amount", label: "Amount", w: reg ? 64 : 84, right: true },
    ];
  cols[1].w = W - cols.reduce((sum, c) => sum + c.w, 0);
  let x = M;
  for (const c of cols) {
    c.x = x;
    x += c.w;
  }
  return cols;
}
function tableHead(flow, cols, theme) {
  const page = flow.page,
    h = 22;
  page.rect(M, flow.y, W, h, { fill: theme.tint });
  for (const c of cols)
    label(
      page,
      c.label,
      c.right ? c.x + c.w - PADX : c.x + PADX,
      flow.y + 5.5,
      {
        color: theme.text,
        align: c.right ? "right" : "left",
        size: 6.8,
      },
    );
  flow.y += h;
}
function discountCell(line, row) {
  if (!row.discount) return ["–"];
  return line.discount.type === "percent"
    ? [`-${formatPaise(row.discount)}`, formatPercent(line.discount.value)]
    : [`-${formatPaise(row.discount)}`];
}
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
function tableRow(flow, s, cols, i, reg) {
  const line = s.lines[i],
    row = s.totals.lines[i],
    item = cols.find((c) => c.id === "item"),
    desc = wrap(line.description, "regular", 8.8, item.w - 2 * PADX),
    sac = reg && line.sac ? `SAC ${line.sac}` : "",
    qtyCol = cols.find((c) => c.id === "qty"),
    qty = formatQty(line.qty),
    // "12 months" on one line when it fits, else the unit below.
    inline =
      line.unit &&
      textWidth(`${qty} ${line.unit}`, "regular", 8.8) <= qtyCol.w - PADX - 4;
  const values = {
    n: [String(i + 1)],
    qty: inline ? [`${qty} ${line.unit}`] : [qty, line.unit],
    rate: [formatPaise(line.unitPrice)],
    disc: discountCell(line, row),
    taxable: [formatPaise(row.taxable)],
    gst: reg ? taxCell(s, row) : [],
    // GST: taxable value (after both discounts) plus tax, per Rule 46.
    // Without GST: quantity x rate less the line discount, so the column adds
    // up to the subtotal and the overall discount is applied once, below.
    amount: [formatPaise(reg ? row.amount : row.net)],
  };
  // Per column: [{text, size, lh, muted}], the first value in body type.
  const cells = cols
    .filter((c) => c.id !== "item")
    .map((c) => ({
      c,
      lines: values[c.id].filter(Boolean).flatMap((t, k) =>
        cellLines(t, k ? 7.3 : 8.8, c.w - PADX - 4).map(([text, size]) => ({
          text,
          size,
          lh: k ? L2 : L1,
          muted: c.id === "n" || k > 0 || t === "–",
        })),
      ),
    }));
  const tallest = Math.max(
    ...cells.map(({ lines }) => lines.reduce((sum, l) => sum + l.lh, 0)),
  );
  const h = Math.max(desc.length * L1 + (sac ? L2 : 0), tallest) + 2 * PADY;
  flow.need(h);
  const page = flow.page,
    top = flow.y + PADY;
  desc.forEach((t, k) =>
    page.text(t, item.x + PADX, base(top + k * L1, 8.8, L1), {
      size: 8.8,
      color: INK,
    }),
  );
  if (sac)
    page.text(sac, item.x + PADX, base(top + desc.length * L1, 7.3, L2), {
      size: 7.3,
      color: MUTED,
    });
  for (const { c, lines } of cells) {
    let y = top;
    for (const l of lines) {
      page.text(
        l.text,
        c.right ? c.x + c.w - PADX : c.x + PADX,
        base(y, l.size, l.lh),
        {
          size: l.size,
          color: l.muted ? MUTED : INK,
          align: c.right ? "right" : "left",
        },
      );
      y += l.lh;
    }
  }
  flow.y += h;
  page.line(M, flow.y, RIGHT, flow.y, { color: RULE, width: 0.6 });
}
function itemsTable(flow, s, theme, reg) {
  const cols = columnsOf(s, reg);
  // The title of the deal, the tax regime when GST-registered, and the head
  // of the table stay with the first row.
  const titleLines = wrap(s.deal.title, "bold", 11.5, W - 110),
    taxLine = reg
      ? s.totals.intra
        ? `Tax: CGST + ${localTaxLabel(s.deal.placeOfSupply)} (intra-state)`
        : "Tax: IGST (inter-state)"
      : "";
  flow.need(titleLines.length * 16 + (taxLine ? 14 : 0) + 8 + 22 + 50);
  const page = flow.page;
  for (const t of titleLines) {
    page.text(t, M, base(flow.y, 11.5, 16), {
      font: "bold",
      size: 11.5,
      color: INK,
    });
    flow.y += 16;
  }
  if (taxLine) {
    page.text(taxLine, M, base(flow.y, 8.4, 14), { size: 8.4, color: MUTED });
    flow.y += 14;
  }
  page.text("Amounts in Rs.", RIGHT, flow.y - 3.5, {
    size: 7.6,
    color: MUTED,
    align: "right",
  });
  flow.y += 8;
  tableHead(flow, cols, theme);
  flow.onBreak = () => tableHead(flow, cols, theme);
  s.lines.forEach((_, i) => tableRow(flow, s, cols, i, reg));
  flow.onBreak = null;
  flow.y += 18;
}

// ---- Totals ----------------------------------------------------------------------
// Tax by rate (Rule 46: rate and amount of each tax); returns the height used.
function taxSummary(page, s, theme, x, top, width) {
  const t = s.totals,
    cols = t.intra
      ? [
          ["Rate", 0.27],
          ["Taxable", 0.2],
          ["CGST", 0.17],
          [localTaxLabel(s.deal.placeOfSupply), 0.17],
          ["Total tax", 0.19],
        ]
      : [
          ["Rate", 0.3],
          ["Taxable", 0.35],
          ["IGST", 0.35],
        ];
  const edges = [];
  let acc = x;
  for (const [, share] of cols) edges.push((acc += share * width));
  const at = (i) => (i ? edges[i] - 6 : x + 6),
    room = (i) => (i ? edges[i] - edges[i - 1] : edges[0] - x) - 10;
  let y = top;
  y += label(page, "Tax summary", x, y, { color: theme.text }) + 5;
  page.rect(x, y, width, 18, { fill: WASH });
  cols.forEach(([name], i) =>
    page.text(name, at(i), base(y, 7.4, 18), {
      font: "bold",
      size: fitSize(name, "bold", 7.4, room(i)),
      color: MUTED,
      align: i ? "right" : "left",
    }),
  );
  y += 18;
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
    const cells = values.map((v, i) => cellLines(v, 7.8, room(i))),
      h = Math.max(...cells.map((c) => c.length)) * 11 + 6;
    cells.forEach((lines, i) =>
      lines.forEach(([text, size], k) =>
        page.text(text, at(i), base(y + 3 + k * 11, size, 11), {
          size,
          color: INK,
          align: i ? "right" : "left",
        }),
      ),
    );
    y += h;
    page.line(x, y, x + width, y, { color: RULE, width: 0.6 });
  }
  return y - top;
}
// Subtotal down to the total, amount in words and the GST note; returns the
// height used.
function totalsCard(page, s, theme, x, top, width, reg) {
  const t = s.totals,
    rows = [["Subtotal", formatPaise(reg ? t.gross : t.net)]];
  if (reg && t.lineDiscount)
    rows.push(["Line discounts", `-${formatPaise(t.lineDiscount)}`]);
  if (t.overallDiscount)
    rows.push([
      s.discount.type === "percent"
        ? `Overall discount (${formatPercent(s.discount.value)})`
        : "Overall discount",
      `-${formatPaise(t.overallDiscount)}`,
    ]);
  if (reg) {
    rows.push(["Taxable value", formatPaise(t.taxable)]);
    if (t.intra)
      rows.push(
        ["CGST", formatPaise(t.cgst)],
        [localTaxLabel(s.deal.placeOfSupply), formatPaise(t.sgst)],
      );
    else rows.push(["IGST", formatPaise(t.igst)]);
  }
  if (s.roundOff)
    rows.push([
      "Round off",
      `${t.roundOff > 0 ? "+" : ""}${formatPaise(t.roundOff)}`,
    ]);
  const pad = 10,
    inner = width - 2 * pad;
  let y = top;
  for (const [name, value] of rows) {
    const vw = Math.min(textWidth(value, "regular", 8.8), inner / 2);
    const [shown, size] = clip(name, "regular", 8.8, inner - vw - 8);
    page.text(shown, x + pad, base(y, 8.8, 17), { size, color: MUTED });
    page.text(value, x + width - pad, base(y, 8.8, 17), {
      size: fitSize(value, "regular", 8.8, inner / 2),
      color: INK,
      align: "right",
    });
    y += 17;
  }
  y += 6;
  const total = formatRs(t.payable),
    size = fitSize(total, "bold", 13, inner - 50);
  page.roundRect(x, y, width, 34, 4, { fill: theme.tint });
  page.text("Total", x + pad, base(y, 10, 34), {
    font: "bold",
    size: 10,
    color: theme.text,
  });
  page.text(total, x + width - pad, base(y, size, 34), {
    font: "bold",
    size,
    color: theme.text,
    align: "right",
  });
  y += 34 + 8;
  for (const part of wrap(amountInWords(t.payable), "italic", 8.2, inner)) {
    page.text(part, x + pad, base(y, 8.2, 12), {
      font: "italic",
      size: 8.2,
      color: BODY,
    });
    y += 12;
  }
  y += 3;
  for (const part of wrap(taxNoteOf(reg), "regular", 7.4, inner)) {
    page.text(part, x + pad, base(y, 7.4, 11), { size: 7.4, color: MUTED });
    y += 11;
  }
  return y - top;
}
// The totals on the right; on the left the tax summary (GST) and the payment
// details when they fit on the page where the totals land (else they go next
// to the signature), kept together on one page. Returns whether the payment
// details were placed.
function totals(flow, s, theme, reg, { payment = false } = {}) {
  const cardW = 240,
    cardX = RIGHT - cardW,
    leftW = W - cardW - GAP,
    summary = reg && s.totals.rates.length,
    cardH = totalsCard(MEASURE, s, theme, cardX, 0, cardW, reg),
    summaryH = summary ? taxSummary(MEASURE, s, theme, M, 0, leftW) : 0,
    paymentH = payment ? paymentCard(MEASURE, s, theme, M, 0, leftW) : 0,
    gap = summary ? 20 : 0,
    baseH = Math.max(cardH, summaryH),
    lands = flow.y + baseH <= BOTTOM ? flow.y : TOP,
    beside =
      paymentH > 0 &&
      lands + Math.max(baseH, summaryH + gap + paymentH) <= BOTTOM;
  const draw = (page, top) => {
    totalsCard(page, s, theme, cardX, top, cardW, reg);
    if (summary) taxSummary(page, s, theme, M, top, leftW);
    if (beside) paymentCard(page, s, theme, M, top + summaryH + gap, leftW);
  };
  const height = Math.max(cardH, summaryH + (beside ? gap + paymentH : 0));
  flow.need(height);
  draw(flow.page, flow.y);
  flow.y += height + 24;
  return beside;
}

// ---- Notes, payment details, signatures, terms ------------------------------
function section(flow, theme, name, after = 6) {
  flow.space(4);
  label(flow.page, name, M, flow.y, { color: theme.text });
  flow.y += 11 + after;
}
function paragraph(flow, text, { size = 9, x = M, width = W } = {}) {
  const lh = size * 1.5,
    parts = wrap(text, "regular", size, width);
  flow.lines(parts.length, lh, (i, top) =>
    flow.page.text(parts[i], x, base(top, size, lh), { size, color: BODY }),
  );
}
function notes(flow, s, theme) {
  if (!s.deal.notes?.trim()) return;
  flow.need(11 + 6 + 2 * 13.5);
  section(flow, theme, "Notes");
  paragraph(flow, s.deal.notes);
  flow.y += 20;
}
// Payment details card; returns the height used (0 when nothing is filled).
function paymentCard(page, s, theme, x, top, width) {
  const b = s.bank ?? {},
    rows = [
      ["Account name", b.accountName],
      ["Account number", b.accountNumber],
      ["IFSC", b.ifsc],
      ["Bank", [b.bankName, b.branch].filter(Boolean).join(", ")],
      ["UPI ID", b.upiId],
    ].filter(([, v]) => v);
  if (!rows.length) return 0;
  const pad = 12,
    labelW = 82,
    inner = width - 2 * pad;
  const body = (p, y0) => {
    let y = y0;
    y += label(p, "Payment details", x + pad, y, { color: theme.text }) + 6;
    for (const [name, value] of rows) {
      p.text(name, x + pad, base(y, 8.6, 13), { size: 8, color: MUTED });
      for (const part of wrap(value, "regular", 8.6, inner - labelW)) {
        p.text(part, x + pad + labelW, base(y, 8.6, 13), {
          size: 8.6,
          color: INK,
        });
        y += 13;
      }
    }
    y += 5;
    for (const part of wrap(
      "Pay only to the account above. Our bank details never change by e-mail or phone.",
      "bold",
      7.2,
      inner,
    )) {
      p.text(part, x + pad, base(y, 7.2, 10.5), {
        font: "bold",
        size: 7.2,
        color: MUTED,
      });
      y += 10.5;
    }
    return y - y0;
  };
  const height = body(MEASURE, top + pad) + 2 * pad;
  page.roundRect(x, top, width, height, 5, { fill: WASH });
  body(page, top + pad);
  return height;
}
// "For <company>", the signature image (or room to sign), the signatory.
function sellerSignature(page, s, assets, x, top, width) {
  let y = top;
  for (const part of wrap(`For ${sellerName(s)}`, "bold", 8.8, width)) {
    page.text(part, x, base(y, 8.8, 13), {
      font: "bold",
      size: 8.8,
      color: INK,
    });
    y += 13;
  }
  y += 4;
  if (assets.signature) {
    const { w, h } = fitImage(assets.signature, Math.min(150, width), 44);
    page.image(assets.signature, x, y + 44 - h, w, h);
  }
  y += 48;
  page.line(x, y, x + Math.min(190, width), y, { color: FAINT, width: 0.6 });
  y += 5;
  y += drawLines(
    page,
    [
      ...(s.signatory?.name
        ? [{ text: s.signatory.name, font: "bold", color: INK }]
        : []),
      {
        text: s.signatory?.title || "Authorised Signatory",
        color: MUTED,
        size: 8.2,
      },
    ],
    x,
    y,
    width,
  );
  return y - top;
}
// The seller's signature closes a quotation or an invoice, on the right; the
// payment details on the left when they were not placed beside the totals.
function closing(flow, s, theme, assets, payment) {
  const sigW = Math.min(HALF, 220),
    draw = (page, top) =>
      Math.max(
        payment ? paymentCard(page, s, theme, M, top, HALF) : 0,
        sellerSignature(page, s, assets, RIGHT - sigW, top, sigW),
      );
  const height = draw(MEASURE, 0);
  flow.space(22);
  flow.need(height);
  flow.y += draw(flow.page, flow.y) + 26;
}

// The owner-editable texts: "N. TITLE IN CAPITALS" (or "# Title", up to 80
// characters) is a heading, "N." / "N.N" (up to five levels) starts a
// numbered paragraph with a hanging indent, an empty line is a pause, any
// other line a paragraph. The texts are free text (a client copy needs no
// step-up), so the patterns match a prefix only and each can match in one way
// only: no nested or overlapping quantifiers, no backtracking blow-up.
const HEADING_NUMBER = /^(\d{1,3}\.)\s+/;
const CLAUSE_NUMBER = /^(\d{1,3}(?:(?:\.\d{1,3}){1,4}\.?|\.))\s+/;
const HEADING_MAX = 80;
const isHeading = (t) =>
  t.length <= HEADING_MAX &&
  !/[a-z]/.test(t) &&
  (t.match(/[A-Z]/g) ?? []).length >= 2;
function blocksOf(text) {
  const out = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    let m;
    if (!line) out.push({ kind: "gap" });
    else if (line.startsWith("# ")) {
      const title = line.slice(2).trim();
      out.push({
        kind: title.length <= HEADING_MAX ? "heading" : "para",
        num: "",
        text: title,
      });
    } else if (
      (m = HEADING_NUMBER.exec(line)) &&
      isHeading(line.slice(m[0].length))
    )
      out.push({ kind: "heading", num: m[1], text: line.slice(m[0].length) });
    else if ((m = CLAUSE_NUMBER.exec(line)))
      out.push({ kind: "item", num: m[1], text: line.slice(m[0].length) });
    else out.push({ kind: "para", num: "", text: line });
  }
  return out;
}
const NUMBER_MAX = 56; // the widest hanging indent, points
function textBody(flow, text, theme, { size = 9 } = {}) {
  const lh = size * 1.5,
    hs = size - 0.4, // heading size
    hlh = hs * 1.6,
    // Measured as a heading number is drawn (bold, letter-spaced): the widest.
    numberW = (num) => textWidth(num, "bold", size, 0.6) + 9;
  // A number too wide for the indent column makes a plain paragraph.
  const blocks = blocksOf(text).map((b) =>
    b.num && numberW(b.num) > NUMBER_MAX
      ? { kind: "para", num: "", text: `${b.num} ${b.text}` }
      : b,
  );
  const numW = Math.max(
    16,
    ...blocks.filter((b) => b.num).map((b) => numberW(b.num)),
  );
  const linesOf = (b) =>
    b.kind === "heading"
      ? wrap(b.text, "bold", hs, W - (b.num ? numW : 0), 0.6)
      : wrap(b.text, "regular", size, W - (b.num ? numW : 0));
  blocks.forEach((b, index) => {
    const page = () => flow.page;
    if (b.kind === "gap") return flow.space(size * 0.5);
    const parts = linesOf(b),
      x = b.num ? M + numW : M;
    if (b.kind === "heading") {
      // A heading keeps its first two lines of text with it.
      const next = blocks.slice(index + 1).find((n) => n.kind !== "gap"),
        follow = next ? Math.min(2, linesOf(next).length) * lh : 0;
      flow.need(size + parts.length * hlh + 2 + follow + 0.5);
      flow.space(size);
      // Page breaks between lines too, should a heading ever need them.
      flow.lines(parts.length, hlh, (i, top) => {
        const y = base(top, hs, hlh);
        if (b.num && !i)
          page().text(b.num, M, y, {
            font: "bold",
            size: hs,
            color: theme.text,
            spacing: 0.6,
          });
        page().text(parts[i], x, y, {
          font: "bold",
          size: hs,
          color: theme.text,
          spacing: 0.6,
        });
      });
      flow.y += 2;
      return;
    }
    flow.lines(parts.length, lh, (i, top) => {
      const y = base(top, size, lh);
      if (b.num && !i)
        page().text(b.num, M, y, {
          size,
          color: b.kind === "item" ? INK : BODY,
        });
      page().text(parts[i], x, y, { size, color: BODY });
    });
    flow.y += size * 0.45;
  });
}
// The height textBody() would use on an endless page.
function bodyHeight(text, theme, options) {
  const dry = {
    y: TOP + 1,
    page: MEASURE,
    need: () => false,
    space(h) {
      this.y += h;
    },
    lines(count, lh, draw) {
      for (let i = 0; i < count; i++, this.y += lh) draw(i, this.y);
    },
  };
  textBody(dry, text, theme, options);
  return dry.y - TOP - 1;
}
function terms(flow, s, theme) {
  if (!s.text?.trim()) return;
  // Short terms stay together; long ones start with at least three lines.
  const body = bodyHeight(s.text, theme, { size: 8.6 });
  flow.need(4 + 15 + (body <= 220 ? body : 3 * 13));
  section(
    flow,
    theme,
    s.type === "invoice" ? "Terms" : "Terms and conditions",
    4,
  );
  textBody(flow, s.text, theme, { size: 8.6 });
}

// ---- Agreement ---------------------------------------------------------------
function scheduleHeading(flow, s, theme) {
  // The schedule starts on a new page unless most of a page is left.
  if (BOTTOM - flow.y < 300) flow.breakPage();
  else flow.space(18);
  const page = flow.page;
  page.text("Schedule A - Commercials", M, base(flow.y, 13, 18), {
    font: "bold",
    size: 13,
    color: theme.text,
  });
  flow.y += 22;
  page.line(M, flow.y, RIGHT, flow.y, { color: theme.tint, width: 1.2 });
  flow.y += 16;
}
// One party's signature block: the provider's is filled in (signature image,
// signatory, date), the client's has blank lines to complete.
function signatureBlock(page, s, assets, which, x, top, width) {
  const provider = which === "Provider";
  let y = top;
  y += label(page, which, x, y) + 5;
  y += drawLines(
    page,
    [
      {
        text: provider ? sellerName(s) : s.buyer.name,
        font: "bold",
        size: 10,
        color: INK,
        lead: 1.35,
      },
    ],
    x,
    y,
    width,
  );
  y += 4;
  if (provider && assets.signature) {
    const { w, h } = fitImage(assets.signature, Math.min(150, width), 44);
    page.image(assets.signature, x, y + 44 - h, w, h);
  }
  y += 48;
  page.line(x, y, x + width, y, { color: FAINT, width: 0.6 });
  y += 3;
  page.text("Signature", x, base(y, 7.6, 12), { size: 7.6, color: MUTED });
  y += 18;
  const rows = provider
    ? [
        ["Name", s.signatory?.name ?? ""],
        ["Title", s.signatory?.title || "Authorised Signatory"],
        ["Date", formatDate(s.date)],
      ]
    : [
        ["Name", ""],
        ["Title", ""],
        ["Date", ""],
      ];
  const labelW = 38;
  for (const [name, value] of rows) {
    page.text(name, x, base(y, 8.8, 14), { size: 8, color: MUTED });
    if (value)
      for (const part of wrap(value, "regular", 8.8, width - labelW)) {
        page.text(part, x + labelW, base(y, 8.8, 14), {
          size: 8.8,
          color: INK,
        });
        y += 14;
      }
    else {
      page.line(x + labelW, y + 12, x + width, y + 12, {
        color: RULE,
        width: 0.6,
      });
      y += 14;
    }
    y += 6;
  }
  return y - top;
}
function signatures(flow, s, theme, assets) {
  const draw = (page, top) => {
    let y = top;
    for (const part of wrap(
      "Agreed and accepted by the authorised representatives of the Parties.",
      "bold",
      9.6,
      W,
    )) {
      page.text(part, M, base(y, 9.6, 14), {
        font: "bold",
        size: 9.6,
        color: INK,
      });
      y += 14;
    }
    y += 18;
    return (
      y -
      top +
      Math.max(
        signatureBlock(page, s, assets, "Provider", M, y, HALF),
        signatureBlock(page, s, assets, "Client", M + HALF + GAP, y, HALF),
      )
    );
  };
  const height = draw(MEASURE, 0);
  flow.space(12);
  flow.need(height);
  flow.y += draw(flow.page, flow.y);
}

function footers(doc, s, reg) {
  const total = doc.pages.length,
    ref = s.number
      ? s.type === "invoice"
        ? s.number
        : `${s.number} v${s.version}`
      : "DRAFT - NOT ISSUED",
    contact = [sellerName(s), s.seller.email, s.seller.phone]
      .filter(Boolean)
      .join(" · "),
    note = FOOTER_NOTE[s.type](reg);
  doc.pages.forEach((page, i) => {
    const right = `${ref} · Page ${i + 1} of ${total}`,
      [shownRight, rightSize] = clip(right, "regular", 7.4, W / 2),
      rightW = textWidth(shownRight, "regular", rightSize),
      [shown, size] = clip(contact, "regular", 7.4, W - rightW - 20);
    page.line(M, FOOT, RIGHT, FOOT, { color: RULE, width: 0.6 });
    page.text(shown, M, FOOT + 13, { size, color: MUTED });
    page.text(shownRight, RIGHT, FOOT + 13, {
      size: rightSize,
      color: MUTED,
      align: "right",
    });
    if (note) page.text(note, M, FOOT + 23.5, { size: 6.8, color: FAINT });
  });
}

function renderCurrent(s, assets, stamp) {
  const reg = registeredOf(s),
    theme = themeOf(s.design?.accent),
    label = s.number
      ? s.type === "invoice"
        ? s.number
        : `${s.number} v${s.version}`
      : "Draft";
  const doc = new PdfDocument({
    title: `${DOC_NAMES[s.type](reg)} ${label}`,
    author: sellerName(s),
    subject: s.deal.title,
    createdAt: s.issuedAt,
  });
  const images = {
    logo: assets.logo ?? null,
    signature: assets.signature ?? null,
  };
  const flow = new Flow(doc, theme, s.draft ? "DRAFT - NOT ISSUED" : stamp);
  header(flow, s, theme, images, reg);
  parties(flow, s, reg);
  if (s.type === "agreement") {
    textBody(flow, s.text, theme);
    scheduleHeading(flow, s, theme);
    itemsTable(flow, s, theme, reg);
    totals(flow, s, theme, reg);
    notes(flow, s, theme);
    signatures(flow, s, theme, images);
  } else {
    itemsTable(flow, s, theme, reg);
    const paid = totals(flow, s, theme, reg, { payment: true });
    notes(flow, s, theme);
    terms(flow, s, theme);
    closing(flow, s, theme, images, !paid);
  }
  footers(doc, s, reg);
  return doc.toBuffer();
}

// assets: {logo, signature} parsed images (pdf-images.js) or null.
// options.stamp: a watermark for a re-rendered copy (e.g. "CANCELLED").
export function renderDocument(s, assets = {}, { stamp = "" } = {}) {
  if (!(s.format >= 2)) return renderFormat1(s, assets, { stamp });
  return renderCurrent(s, assets ?? {}, stamp);
}
