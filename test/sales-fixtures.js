// Shared test data for the sales tests: a tiny PNG encoder (all five row
// filters), a PDF text extractor for this repo's own PDF writer, and a sample
// company and deal.
import { deflateSync, inflateSync, crc32 } from "node:zlib";
import { salesSchemas } from "../shared/sales-schemas.js";

const WINANSI_BACK = new Map([
  [0x80, "€"],
  [0x85, "…"],
  [0x91, "‘"],
  [0x92, "’"],
  [0x93, "“"],
  [0x94, "”"],
  [0x95, "•"],
  [0x96, "–"],
  [0x97, "—"],
  [0x99, "™"],
]);
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
}
const paeth = (a, b, c) => {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
// pixel(x, y) → array of channel values; rows use filters 0..4 in turn.
export function makePng(
  width,
  height,
  colorType,
  pixel,
  { palette, trns, depth = 8, interlace = 0 } = {},
) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType],
    stride = width * channels,
    raw = [],
    rows = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) row.push(...pixel(x, y));
    rows.push(row);
    const filter = y % 5,
      prev = rows[y - 1] ?? new Array(stride).fill(0);
    raw.push(filter);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0,
        b = prev[i],
        c = i >= channels ? prev[i - channels] : 0,
        v = row[i];
      raw.push(
        (filter === 0
          ? v
          : filter === 1
            ? v - a
            : filter === 2
              ? v - b
              : filter === 3
                ? v - ((a + b) >> 1)
                : v - paeth(a, b, c)) & 0xff,
      );
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(palette ? [chunk("PLTE", Buffer.from(palette))] : []),
    ...(trns ? [chunk("tRNS", Buffer.from(trns))] : []),
    chunk("IDAT", deflateSync(Buffer.from(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
// A green rounded badge with a transparent background (logo) and a dark
// scribble (signature).
export const LOGO = makePng(120, 48, 6, (x, y) => {
  const inside =
    (x - 24) ** 2 + (y - 24) ** 2 < 20 ** 2 ||
    (x > 30 && x < 116 && y > 14 && y < 34);
  return inside ? [25, 59, 52, 255] : [255, 255, 255, 0];
});
export const SIGNATURE = makePng(140, 40, 4, (x, y) => {
  const on = Math.abs(y - 20 - Math.round(10 * Math.sin(x / 9))) < 2;
  return on ? [20, 255] : [255, 0];
});

// Objects of a PDF made by backend/lib/pdf.js: {num, dict, data}.
export function pdfObjects(pdf) {
  const text = pdf.toString("latin1"),
    out = [],
    re = /(\d+) 0 obj\n([\s\S]*?)(?:\nendobj\n)/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2],
      s = /^<< ([\s\S]*?) \/Length (\d+) >>\nstream\n/.exec(body);
    if (s) {
      const start = m.index + m[0].indexOf("stream\n") + 7,
        data = pdf.subarray(start, start + Number(s[2]));
      out.push({ num: Number(m[1]), dict: s[1], data });
      re.lastIndex = start + Number(s[2]) + "\nendstream\nendobj\n".length;
    } else out.push({ num: Number(m[1]), dict: body, data: null });
  }
  return out;
}
function unescape(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== "\\") {
      bytes.push(str.charCodeAt(i));
      continue;
    }
    const next = str[++i];
    if (/[0-7]/.test(next)) {
      const oct = str.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else bytes.push(next.charCodeAt(0));
  }
  return bytes
    .map((b) => WINANSI_BACK.get(b) ?? String.fromCharCode(b))
    .join("");
}
// Text of each page, in drawing order, one Tj per line.
export function pdfText(pdf) {
  const objects = pdfObjects(pdf),
    byNum = new Map(objects.map((o) => [o.num, o]));
  const pages = objects.filter((o) => !o.data && /\/Type \/Page /.test(o.dict));
  return pages.map((page) => {
    const ref = Number(/\/Contents (\d+) 0 R/.exec(page.dict)[1]),
      ops = inflateSync(byNum.get(ref).data).toString("latin1");
    return [...ops.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
      .map((m) => unescape(m[1]))
      .join("\n");
  });
}

export const COMPANY = {
  legalName: "Sandbee Technologies Private Limited",
  tradeName: "Sandbee",
  address: ["Office 4, Example Business Park", "Baner Road"],
  city: "Pune",
  stateCode: "27",
  pincode: "411045",
  gstin: "27AAACS9999K1ZD",
  pan: "AAACS9999K",
  email: "accounts@example.test",
  phone: "+91 20 0000 0000",
  website: "sandbee.in",
};
export const BANK = {
  accountName: "Sandbee Technologies Private Limited",
  accountNumber: "000123456789",
  ifsc: "HDFC0000001",
  bankName: "Example Bank",
  branch: "Baner, Pune",
  upiId: "sandbee@examplebank",
};
export const settingsFixture = (over = {}) => ({
  ...salesSchemas.settings.parse({
    company: COMPANY,
    bank: BANK,
    signatory: { name: "A. Founder", title: "Director" },
    // The sample company is GST-registered; pass gst: {registered: false}
    // for a seller without registration (the schema's default).
    gst: { registered: true },
    ...over,
  }),
  images: { logo: null, signature: null },
});
export const BILL_TO = {
  name: "Cafe Blue LLP",
  address: ["12 MG Road"],
  city: "Pune",
  stateCode: "27",
  pincode: "411001",
  gstin: "27AABCC1234D1ZB",
  pan: "",
  email: "owner@cafeblue.example",
  phone: "",
};
const line = (over) => ({
  productId: "",
  sac: "998314",
  unit: "nos",
  discount: { type: "none", value: 0 },
  gstRate: 1800,
  ...over,
});
// The discount scenario of test/sales-math.test.js: payable Rs. 11,199.00
// intra-state (round off +0.20), Rs. 11,199.00 inter-state (+0.21).
export const dealFixture = (over = {}) => ({
  _id: "00000000-0000-4000-8000-00000000d001",
  title: "Sandbee POS setup and first-year support",
  billTo: BILL_TO,
  placeOfSupply: "27",
  lines: [
    line({
      id: "a",
      description:
        "Sandbee POS one-time setup (Vercel, MongoDB and Cloudflare accounts of the client)",
      qty: 1000,
      unitPrice: 1000000,
      discount: { type: "percent", value: 1000 },
    }),
    line({
      id: "b",
      description: "Support hours",
      sac: "998313",
      unit: "hours",
      qty: 3000,
      unitPrice: 33333,
      discount: { type: "amount", value: 999 },
    }),
  ],
  discount: { type: "percent", value: 500 },
  validUntil: "2026-10-31",
  notes: "Prices include onboarding for two staff members.",
  ...over,
});
