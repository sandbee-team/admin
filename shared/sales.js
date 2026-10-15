// Sales documents: money math, GST, numbering, text rules. Pure functions used
// by the API, the PDF layouts and the deal editor, so the screen and the PDF
// can never disagree (docs/SALES-DOCS-PLAN.md §4-§6).
//
// Money is integer paise; products use BigInt; every division rounds half up
// to the paisa. Quantities are thousandths, percents and GST rates are basis
// points (1800 = 18 %).

export const DOC_TYPES = ["quotation", "agreement", "invoice"];
export const DOC_TITLES = {
  quotation: "Quotation",
  agreement: "Agreement",
  invoice: "Tax invoice",
};
export const DEAL_STATES = ["draft", "final", "lost"];
export const DISCOUNT_TYPES = ["none", "percent", "amount"];
// Allowed GST rates (basis points). 18 % covers IT services (heading 9983).
export const GST_RATES = [0, 500, 1200, 1800, 2800, 4000];
export const MAX_LINES = 50;
export const MAX_QTY = 100000000; // 1,00,000 units in thousandths
export const MAX_UNIT_PRICE = 1000000000; // Rs. 1 crore in paise
export const INVOICE_NUMBER_MAX = 16; // Rule 46(b) CGST Rules
export const PREFIX_RE = /^[A-Za-z0-9/-]{0,6}$/;
export const SAC_RE = /^\d{4,8}$/;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const PIN_RE = /^[1-9][0-9]{5}$/;
export const UPI_RE = /^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$/;

// GST state codes, e-invoice master list (einvoice1.gst.gov.in/Others/MasterCodes).
// 28 (old Andhra Pradesh) is retired; 96/99 (other countries) are out of scope.
export const STATES = [
  ["01", "Jammu and Kashmir"],
  ["02", "Himachal Pradesh"],
  ["03", "Punjab"],
  ["04", "Chandigarh"],
  ["05", "Uttarakhand"],
  ["06", "Haryana"],
  ["07", "Delhi"],
  ["08", "Rajasthan"],
  ["09", "Uttar Pradesh"],
  ["10", "Bihar"],
  ["11", "Sikkim"],
  ["12", "Arunachal Pradesh"],
  ["13", "Nagaland"],
  ["14", "Manipur"],
  ["15", "Mizoram"],
  ["16", "Tripura"],
  ["17", "Meghalaya"],
  ["18", "Assam"],
  ["19", "West Bengal"],
  ["20", "Jharkhand"],
  ["21", "Odisha"],
  ["22", "Chhattisgarh"],
  ["23", "Madhya Pradesh"],
  ["24", "Gujarat"],
  ["25", "Daman and Diu"],
  ["26", "Dadra and Nagar Haveli and Daman and Diu"],
  ["27", "Maharashtra"],
  ["29", "Karnataka"],
  ["30", "Goa"],
  ["31", "Lakshadweep"],
  ["32", "Kerala"],
  ["33", "Tamil Nadu"],
  ["34", "Puducherry"],
  ["35", "Andaman and Nicobar Islands"],
  ["36", "Telangana"],
  ["37", "Andhra Pradesh"],
  ["38", "Ladakh"],
  ["97", "Other Territory"],
];
const STATE_NAMES = new Map(STATES);
export const stateName = (code) => STATE_NAMES.get(code) ?? "";
// Union territories without a legislature levy UTGST instead of SGST (Rule 46
// names "Union territory tax"); Delhi, Puducherry and J&K levy SGST.
const UT_CODES = new Set(["04", "25", "26", "31", "35", "38", "97"]);
export const localTaxLabel = (placeOfSupply) =>
  UT_CODES.has(placeOfSupply) ? "UTGST" : "SGST";
// The {{tax.note}} sentence. A seller without GST registration may not charge
// or collect GST (CGST Act s.32), so its documents say so instead.
export const taxNoteOf = (registered) =>
  registered
    ? "GST is charged at the rates shown."
    : "GST is not charged: the supplier is not registered under GST.";

// ---- Money -----------------------------------------------------------------
export function roundDiv(a, b) {
  // a >= 0, b > 0 (BigInt): nearest integer, halves up.
  return (a * 2n + b) / (2n * b);
}
// Splits `total` over `weights` in proportion; floors first, then one unit to
// each of the largest remainders (ties: the earlier entry). Sums exactly.
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n || sum === 0n) return weights.map(() => 0n);
  const parts = weights.map((w) => (total * w) / sum),
    rest = weights.map((w, i) => ({ i, r: (total * w) % sum }));
  let left = total - parts.reduce((a, b) => a + b, 0n);
  rest.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
  for (const { i } of rest) {
    if (left === 0n) break;
    parts[i] += 1n;
    left -= 1n;
  }
  return parts;
}
const int = (value, min, max, what) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${what} is out of range.`);
  return BigInt(value);
};
const num = (big) => {
  const n = Number(big);
  if (!Number.isSafeInteger(n)) throw new RangeError("Amount is too large.");
  return n;
};
function discountOf(discount, base, what) {
  const type = discount?.type ?? "none";
  if (type === "none") return 0n;
  if (type === "percent")
    return roundDiv(base * int(discount.value, 0, 10000, what), 10000n);
  if (type === "amount") {
    const value = int(discount.value, 0, Number.MAX_SAFE_INTEGER, what);
    if (value > base)
      throw new RangeError(`${what} is larger than the amount.`);
    return value;
  }
  throw new RangeError(`${what} has an unknown type.`);
}
// deal: {lines, discount, placeOfSupply}; options: {sellerState, roundOff,
// registered}. registered: false (a seller without GST registration) charges
// no tax on any line and returns no rate rows; omitted means registered.
export function computeTotals({ lines, discount, placeOfSupply }, options) {
  const registered = options.registered !== false,
    intra = placeOfSupply === options.sellerState;
  const rows = lines.map((line, n) => {
    const qty = int(line.qty, 0, MAX_QTY, `Line ${n + 1} quantity`),
      price = int(line.unitPrice, 0, MAX_UNIT_PRICE, `Line ${n + 1} price`);
    if (!GST_RATES.includes(line.gstRate))
      throw new RangeError(`Line ${n + 1} GST rate is not allowed.`);
    const gross = roundDiv(qty * price, 1000n),
      off = discountOf(line.discount, gross, `Line ${n + 1} discount`);
    return { gross, discount: off, net: gross - off, rate: line.gstRate };
  });
  const net = rows.reduce((a, r) => a + r.net, 0n),
    overall = discountOf(discount, net, "Overall discount"),
    shares = allocate(
      overall,
      rows.map((r) => r.net),
    );
  const out = rows.map((r, i) => {
    const taxable = r.net - shares[i],
      rate = BigInt(r.rate);
    const cgst = registered && intra ? roundDiv(taxable * rate, 20000n) : 0n,
      sgst = cgst,
      igst = registered && !intra ? roundDiv(taxable * rate, 10000n) : 0n,
      tax = cgst + sgst + igst;
    return {
      gross: num(r.gross),
      discount: num(r.discount),
      net: num(r.net),
      share: num(shares[i]),
      taxable: num(taxable),
      rate: r.rate,
      cgst: num(cgst),
      sgst: num(sgst),
      igst: num(igst),
      tax: num(tax),
      amount: num(taxable + tax),
    };
  });
  const sum = (key) => out.reduce((a, l) => a + l[key], 0);
  const byRate = new Map();
  for (const l of out) {
    const g = byRate.get(l.rate) ?? {
      rate: l.rate,
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
    };
    g.taxable += l.taxable;
    g.cgst += l.cgst;
    g.sgst += l.sgst;
    g.igst += l.igst;
    byRate.set(l.rate, g);
  }
  const total = sum("amount"),
    payable = options.roundOff
      ? num(roundDiv(BigInt(total), 100n) * 100n)
      : total;
  return {
    registered,
    intra,
    lines: out,
    gross: sum("gross"),
    lineDiscount: sum("discount"),
    net: sum("net"),
    overallDiscount: num(overall),
    taxable: sum("taxable"),
    cgst: sum("cgst"),
    sgst: sum("sgst"),
    igst: sum("igst"),
    tax: sum("tax"),
    total,
    roundOff: payable - total,
    payable,
    rates: registered
      ? [...byRate.values()].sort((a, b) => a.rate - b.rate)
      : [],
  };
}

// ---- Formatting ------------------------------------------------------------
const group = (digits) => {
  // Indian grouping: last three, then pairs.
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3),
    tail = digits.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+$)/g, ",")},${tail}`;
};
export function formatPaise(paise) {
  const sign = paise < 0 ? "-" : "",
    abs = Math.abs(paise);
  return `${sign}${group(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, "0")}`;
}
export const formatRs = (paise) => `Rs. ${formatPaise(paise)}`;
export function formatQty(milli) {
  const whole = Math.floor(milli / 1000),
    frac = String(milli % 1000)
      .padStart(3, "0")
      .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
export function formatPercent(bp) {
  const whole = Math.floor(bp / 100),
    frac = String(bp % 100)
      .padStart(2, "0")
      .replace(/0+$/, "");
  return `${frac ? `${whole}.${frac}` : whole}%`;
}
// Editor helpers: "1,234.5" → 123450 paise; "1.5" → 1500 thousandths. Null when
// the text is not a plain non-negative number with at most `places` decimals.
// Commas must group digits the Indian (1,23,456) or Western (123,456) way.
const GROUPED = /^(\d{1,2}(,\d{2})*,\d{3}|\d{1,3}(,\d{3})+)(\.|$)/;
function parseFixed(text, places) {
  const raw = String(text ?? "").trim();
  if (raw.includes(",") && !GROUPED.test(raw)) return null;
  const clean = raw.replaceAll(",", "");
  if (!new RegExp(`^\\d{1,13}(\\.\\d{0,${places}})?$`).test(clean)) return null;
  const [whole, frac = ""] = clean.split(".");
  const value = Number(whole) * 10 ** places + Number(frac.padEnd(places, "0"));
  return Number.isSafeInteger(value) ? value : null;
}
export const parseRupees = (text) => parseFixed(text, 2);
export const parseQty = (text) => parseFixed(text, 3);
export const parsePercent = (text) => parseFixed(text, 2);
export const paiseText = (paise) => {
  const s = formatPaise(paise).replaceAll(",", "");
  return s.endsWith(".00") ? s.slice(0, -3) : s;
};

const ONES = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];
function below100(n) {
  if (n < 20) return ONES[n];
  return n % 10 ? `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}` : TENS[n / 10];
}
function below1000(n) {
  const h = Math.floor(n / 100),
    r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? below100(r) : ""]
    .filter(Boolean)
    .join(" ");
}
function words(n) {
  if (n === 0) return "Zero";
  const parts = [];
  const crore = Math.floor(n / 10000000);
  if (crore) parts.push(`${words(crore)} Crore`);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  n %= 1000;
  if (n) parts.push(below1000(n));
  return parts.join(" ");
}
export function amountInWords(paise) {
  const rupees = Math.floor(paise / 100),
    p = paise % 100;
  return `Rupees ${words(rupees)}${p ? ` and ${below100(p)} ${p === 1 ? "Paisa" : "Paise"}` : ""} Only`;
}

// ---- Dates and numbering (India Standard Time, UTC+5:30, no DST) -----------
const IST_MS = 330 * 60000;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
export const istDate = (at) =>
  new Date(new Date(at).getTime() + IST_MS).toISOString().slice(0, 10);
// "2026-10-31" or a Date → "31 Oct 2026".
export function formatDate(value) {
  const iso =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : istDate(value);
  const [y, m, d] = iso.split("-");
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}
export const addDays = (iso, days) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
export function fyOf(at) {
  const [y, m] = istDate(at).split("-").map(Number),
    start = m >= 4 ? y : y - 1,
    two = (n) => String(n % 100).padStart(2, "0");
  return { start, label: `${two(start)}-${two(start + 1)}` };
}
export const docNumber = (prefix, fyLabel, seq) =>
  `${prefix}${fyLabel}/${String(seq).padStart(4, "0")}`;
export const versionLabel = (doc) =>
  doc.type === "invoice" ? doc.number : `${doc.number} v${doc.version}`;

// ---- Identifiers -------------------------------------------------------------
const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
// 15 characters: state code, PAN-like body, entity, check character (mod 36).
export function validGstin(value) {
  if (typeof value !== "string" || !/^\d{2}[0-9A-Z]{13}$/.test(value))
    return false;
  if (!stateName(value.slice(0, 2))) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = B36.indexOf(value[i]) * ((i % 2) + 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return B36[(36 - (sum % 36)) % 36] === value[14];
}

// ---- Text the PDF fonts can print (WinAnsiEncoding) -------------------------
// Unicode → WinAnsi byte for the 0x80-0x9F block; 0x20-0x7E and 0xA0-0xFF map
// to themselves (soft hyphen excluded).
export const WINANSI_EXTRA = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);
export function winAnsiByte(cp) {
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff && cp !== 0xad))
    return cp;
  return WINANSI_EXTRA.get(cp) ?? -1;
}
export const normalizeText = (value) =>
  String(value ?? "")
    .normalize("NFC")
    .replaceAll("₹", "Rs.")
    .replaceAll(" ", " ")
    .replace(/\r\n?/g, "\n");
// Distinct characters the PDF cannot print, in order of first use.
export function unprintable(value, { multiline = false } = {}) {
  const bad = [];
  for (const ch of String(value)) {
    if (multiline && ch === "\n") continue;
    if (winAnsiByte(ch.codePointAt(0)) < 0 && !bad.includes(ch)) bad.push(ch);
  }
  return bad;
}

// ---- Templates -----------------------------------------------------------------
export const PLACEHOLDERS = [
  "company.legalName",
  "company.address",
  "company.gstin",
  "company.pan",
  "company.email",
  "company.phone",
  "company.jurisdiction",
  "client.name",
  "client.address",
  "client.gstin",
  "client.pan",
  "client.email",
  "deal.title",
  "deal.total",
  "deal.totalWords",
  "deal.validUntil",
  "document.number",
  "document.date",
  "tax.note",
];
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z.]{1,40})\s*\}\}/g;
export const renderTemplate = (text, values) =>
  String(text).replace(PLACEHOLDER_RE, (_, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : "",
  );
export const unknownPlaceholders = (text) =>
  [...String(text).matchAll(PLACEHOLDER_RE)]
    .map((m) => m[1])
    .filter((name) => !PLACEHOLDERS.includes(name));
export const TEMPLATE_KEYS = [
  "quotationTerms",
  "agreementBody",
  "invoiceTerms",
];
export const TEMPLATE_FOR = {
  quotation: "quotationTerms",
  agreement: "agreementBody",
  invoice: "invoiceTerms",
};
