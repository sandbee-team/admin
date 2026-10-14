// Minimal PDF 1.4 writer (no dependencies): A4 pages, the standard fonts
// Helvetica / Helvetica-Bold in WinAnsiEncoding, text, lines, boxes and
// images from pdf-images.js. Coordinates are points from the TOP-left corner.
// Output is deterministic: the same calls give the same bytes (fixed dates,
// /ID from the content hash, zlib level 9).
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { winAnsiByte } from "../../shared/sales.js";
import { WIDTHS, FIRST } from "./pdf-fonts.js";

export const A4 = { width: 595.28, height: 841.89 };
const FONT_NAMES = { regular: "F1", bold: "F2" };
const BASE_FONTS = { regular: "Helvetica", bold: "Helvetica-Bold" };
const QUESTION = 0x3f;

const n = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};
// Text → WinAnsi bytes; a character the font cannot print becomes "?" (the
// schemas refuse such text before it gets here).
export function encode(text) {
  const out = [];
  for (const ch of String(text)) {
    const b = winAnsiByte(ch.codePointAt(0));
    out.push(b < 0 ? QUESTION : b);
  }
  return Buffer.from(out);
}
function literal(bytes) {
  let s = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c)
      s += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) s += `\\${b.toString(8).padStart(3, "0")}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
}
export function textWidth(text, font = "regular", size = 10) {
  const widths = WIDTHS[font];
  let total = 0;
  for (const b of encode(text)) total += widths[b - FIRST] ?? 0;
  return (total * size) / 1000;
}
// Word wrap to `width`; "\n" starts a new line; a word longer than the line
// is broken by characters. Returns at least one (possibly empty) line.
export function wrap(text, font, size, width) {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, font, size) <= width) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      let piece = "";
      for (const ch of word) {
        if (textWidth(piece + ch, font, size) > width && piece) {
          lines.push(piece);
          piece = "";
        }
        piece += ch;
      }
      line = piece;
    }
    lines.push(line);
  }
  return lines;
}
const rgb = (c) => c.map((v) => n(v)).join(" ");

export class Page {
  constructor(doc) {
    this.doc = doc;
    this.ops = [];
  }
  text(
    str,
    x,
    y,
    { font = "regular", size = 10, color = [0, 0, 0], align = "left" } = {},
  ) {
    const w = textWidth(str, font, size),
      left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    this.ops.push(
      `BT /${FONT_NAMES[font]} ${n(size)} Tf ${rgb(color)} rg ${n(left)} ${n(A4.height - y)} Td ${literal(encode(str))} Tj ET`,
    );
    return w;
  }
  // Rotated text around its start point (watermarks).
  rotated(
    str,
    x,
    y,
    degrees,
    { font = "bold", size = 60, color = [0.9, 0.9, 0.9] } = {},
  ) {
    const r = (degrees * Math.PI) / 180,
      c = Math.cos(r),
      s = Math.sin(r);
    this.ops.push(
      `BT /${FONT_NAMES[font]} ${n(size)} Tf ${rgb(color)} rg ${n(c)} ${n(s)} ${n(-s)} ${n(c)} ${n(x)} ${n(A4.height - y)} Tm ${literal(encode(str))} Tj ET`,
    );
  }
  line(x1, y1, x2, y2, { color = [0, 0, 0], width = 0.5 } = {}) {
    this.ops.push(
      `${n(width)} w ${rgb(color)} RG ${n(x1)} ${n(A4.height - y1)} m ${n(x2)} ${n(A4.height - y2)} l S`,
    );
  }
  rect(x, y, w, h, { fill = null, stroke = null, width = 0.5 } = {}) {
    const box = `${n(x)} ${n(A4.height - y - h)} ${n(w)} ${n(h)} re`;
    if (fill && stroke)
      this.ops.push(`${n(width)} w ${rgb(fill)} rg ${rgb(stroke)} RG ${box} B`);
    else if (fill) this.ops.push(`${rgb(fill)} rg ${box} f`);
    else if (stroke) this.ops.push(`${n(width)} w ${rgb(stroke)} RG ${box} S`);
  }
  image(image, x, y, w, h) {
    const name = this.doc.imageName(image);
    this.ops.push(
      `q ${n(w)} 0 0 ${n(h)} ${n(x)} ${n(A4.height - y - h)} cm /${name} Do Q`,
    );
  }
}

// PDF date for an instant, printed in IST.
function pdfDate(at) {
  const ist = new Date(new Date(at).getTime() + 330 * 60000)
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  return `D:${ist}+05'30'`;
}
const infoString = (value) =>
  literal(encode(String(value ?? "").slice(0, 200)));

export class PdfDocument {
  constructor({
    title = "",
    author = "",
    subject = "",
    createdAt = new Date(0),
  } = {}) {
    this.meta = { title, author, subject, createdAt };
    this.pages = [];
    this.images = [];
  }
  addPage() {
    const page = new Page(this);
    this.pages.push(page);
    return page;
  }
  imageName(image) {
    let index = this.images.indexOf(image);
    if (index < 0) index = this.images.push(image) - 1;
    return `Im${index + 1}`;
  }
  toBuffer() {
    // Index i holds object number i + 1, so push() returns the new number.
    const objects = [];
    const add = (body) => objects.push(body);
    const stream = (dict, data) => ({ dict, data });
    // 1 catalog, 2 pages, 3 info, 4-5 fonts, then images, then pages.
    add("<< /Type /Catalog /Pages 2 0 R >>");
    add(null); // pages, filled below
    const { title, author, subject, createdAt } = this.meta;
    const date = pdfDate(createdAt);
    add(
      `<< /Title ${infoString(title)} /Author ${infoString(author)} /Subject ${infoString(subject)} /Producer (Sandbee Admin) /Creator (Sandbee Admin) /CreationDate (${date}) /ModDate (${date}) >>`,
    );
    for (const key of ["regular", "bold"])
      add(
        `<< /Type /Font /Subtype /Type1 /BaseFont /${BASE_FONTS[key]} /Encoding /WinAnsiEncoding >>`,
      );
    const imageRefs = this.images.map((image) => {
      let smask = "";
      if (image.alpha) {
        const ref = add(
          stream(
            `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
            image.alpha,
          ),
        );
        smask = ` /SMask ${ref} 0 R`;
      }
      return add(
        stream(
          `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.colorSpace} /BitsPerComponent 8 /Filter /${image.filter}${smask}`,
          image.data,
        ),
      );
    });
    const xobjects = imageRefs.length
      ? ` /XObject << ${imageRefs.map((ref, i) => `/Im${i + 1} ${ref} 0 R`).join(" ")} >>`
      : "";
    const resources = `<< /Font << /F1 4 0 R /F2 5 0 R >>${xobjects} >>`;
    const kids = this.pages.map((page) => {
      const content = add(
        stream(
          "/Filter /FlateDecode",
          deflateSync(Buffer.from(page.ops.join("\n"), "latin1"), { level: 9 }),
        ),
      );
      return add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(A4.width)} ${n(A4.height)}] /Resources ${resources} /Contents ${content} 0 R >>`,
      );
    });
    objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

    const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let offset = chunks[0].length;
    const offsets = [];
    objects.forEach((object, i) => {
      offsets.push(offset);
      const parts =
        typeof object === "string"
          ? [Buffer.from(`${i + 1} 0 obj\n${object}\nendobj\n`, "latin1")]
          : [
              Buffer.from(
                `${i + 1} 0 obj\n<< ${object.dict} /Length ${object.data.length} >>\nstream\n`,
                "latin1",
              ),
              object.data,
              Buffer.from("\nendstream\nendobj\n", "latin1"),
            ];
      for (const part of parts) {
        chunks.push(part);
        offset += part.length;
      }
    });
    const id = createHash("sha256")
      .update(Buffer.concat(chunks))
      .digest("hex")
      .slice(0, 32);
    const xref = [
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
      ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`),
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${offset}\n%%EOF\n`,
    ].join("");
    chunks.push(Buffer.from(xref, "latin1"));
    return Buffer.concat(chunks);
  }
}
