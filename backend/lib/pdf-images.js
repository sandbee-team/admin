// Logo and signature images for the PDF writer: baseline/progressive JPEG
// (gray or RGB) is embedded as-is (DCTDecode); 8-bit non-interlaced PNG is
// decoded (inflate + row filters) and re-compressed as RGB/gray plus an
// optional alpha mask. Anything else is refused with a fixed message.
import { inflateSync, deflateSync } from "node:zlib";

export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_SIDE = 2000;
export class ImageError extends Error {}
const refuse = (message) => {
  throw new ImageError(message);
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8)
    return "jpeg";
  return null;
}
function checkSize(width, height) {
  if (!(width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE))
    refuse(`Images must be at most ${MAX_SIDE} × ${MAX_SIDE} pixels.`);
}

function parseJpeg(buf) {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) refuse("This JPEG file is damaged.");
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length)
      refuse("This JPEG file is damaged.");
    const sof =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (length < 8) refuse("This JPEG file is damaged.");
      const bits = buf[i + 4],
        height = buf.readUInt16BE(i + 5),
        width = buf.readUInt16BE(i + 7),
        components = buf[i + 9];
      if (bits !== 8 || ![1, 3].includes(components))
        refuse("Use an RGB or grayscale JPEG (CMYK is not supported).");
      checkSize(width, height);
      return {
        type: "jpeg",
        width,
        height,
        colorSpace: components === 1 ? "DeviceGray" : "DeviceRGB",
        filter: "DCTDecode",
        data: buf,
        alpha: null,
      };
    }
    i += 2 + length;
  }
  return refuse("This JPEG file is damaged.");
}

const paeth = (a, b, c) => {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
function parsePng(buf) {
  let i = 8,
    header = null,
    palette = null,
    trns = null;
  const idat = [];
  while (i + 12 <= buf.length) {
    const length = buf.readUInt32BE(i),
      type = buf.toString("latin1", i + 4, i + 8);
    if (i + 12 + length > buf.length) refuse("This PNG file is damaged.");
    const data = buf.subarray(i + 8, i + 8 + length);
    if (type === "IHDR") {
      if (length !== 13) refuse("This PNG file is damaged.");
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    i += 12 + length;
  }
  if (!header || !idat.length) refuse("This PNG file is damaged.");
  const { width, height, depth, colorType, interlace } = header;
  checkSize(width, height);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (depth !== 8 || !channels || interlace !== 0)
    refuse("Use an 8-bit, non-interlaced PNG or a JPEG.");
  if (colorType === 3 && !palette) refuse("This PNG file is damaged.");
  const stride = width * channels;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat), {
      maxOutputLength: height * (stride + 1),
    });
  } catch {
    refuse("This PNG file is damaged.");
  }
  if (raw.length !== height * (stride + 1)) refuse("This PNG file is damaged.");
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)],
      src = y * (stride + 1) + 1,
      dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[dst + x - channels] : 0,
        b = y > 0 ? pixels[dst - stride + x] : 0,
        c = x >= channels && y > 0 ? pixels[dst - stride + x - channels] : 0;
      const v = raw[src + x];
      pixels[dst + x] =
        filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : filter === 4
                  ? v + paeth(a, b, c)
                  : refuse("This PNG file is damaged.");
    }
  }
  const count = width * height;
  let color,
    alpha = null,
    gray = false;
  if (colorType === 0 || colorType === 4) {
    gray = true;
    color = Buffer.alloc(count);
    if (colorType === 4) alpha = Buffer.alloc(count);
    for (let p = 0; p < count; p++) {
      color[p] = pixels[p * channels];
      if (alpha) alpha[p] = pixels[p * channels + 1];
    }
  } else if (colorType === 2 || colorType === 6) {
    if (colorType === 2) color = pixels;
    else {
      color = Buffer.alloc(count * 3);
      alpha = Buffer.alloc(count);
      for (let p = 0; p < count; p++) {
        pixels.copy(color, p * 3, p * 4, p * 4 + 3);
        alpha[p] = pixels[p * 4 + 3];
      }
    }
  } else {
    color = Buffer.alloc(count * 3);
    if (trns) alpha = Buffer.alloc(count);
    for (let p = 0; p < count; p++) {
      const index = pixels[p];
      if (index * 3 + 2 >= palette.length) refuse("This PNG file is damaged.");
      palette.copy(color, p * 3, index * 3, index * 3 + 3);
      if (alpha) alpha[p] = index < trns.length ? trns[index] : 255;
    }
  }
  // A fully opaque alpha channel is dropped.
  if (alpha && alpha.every((v) => v === 255)) alpha = null;
  return {
    type: "png",
    width,
    height,
    colorSpace: gray ? "DeviceGray" : "DeviceRGB",
    filter: "FlateDecode",
    data: deflateSync(color, { level: 9 }),
    alpha: alpha ? deflateSync(alpha, { level: 9 }) : null,
  };
}

// -> {type, width, height, colorSpace, filter, data, alpha|null}
export function parseImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1)
    refuse("The image is empty.");
  if (buffer.length > MAX_IMAGE_BYTES) refuse("Images can be at most 512 KB.");
  const kind = sniffImage(buffer);
  if (kind === "png") return parsePng(buffer);
  if (kind === "jpeg") return parseJpeg(buffer);
  return refuse("Use a PNG or JPEG image.");
}
