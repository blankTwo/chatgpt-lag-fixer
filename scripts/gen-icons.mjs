// 使用当前正式图标生成 Chrome 扩展所需尺寸。
// 源图标来自已确认的“绿色消息气泡 + 心跳徽章”设计。
// 为避免每次 build 又覆盖回旧占位图，这里把 48px 源图直接内嵌进构建脚本，
// 再由纯 Node 解码 PNG、缩放并重新编码为 16/32/48/128。
import { deflateSync, inflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE_BASE64 = [
  "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",
  "rkJggg==",
].join("").replace("Fc0F02m", "FcwF02m");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../extension/icons");
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(png) {
  const signature = png.subarray(0, 8);
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("非法 PNG 源图");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`仅支持 8-bit RGBA PNG，当前 bitDepth=${bitDepth}, colorType=${colorType}`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(width * height * bpp);
  let src = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    for (let x = 0; x < stride; x++) {
      const value = raw[src++];
      const left = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[(y - 1) * stride + x - bpp] : 0;
      let out;
      if (filter === 0) out = value;
      else if (filter === 1) out = (value + left) & 255;
      else if (filter === 2) out = (value + up) & 255;
      else if (filter === 3) out = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) out = (value + paeth(left, up, upLeft)) & 255;
      else throw new Error(`不支持 PNG filter ${filter}`);
      pixels[y * stride + x] = out;
    }
  }

  return { width, height, pixels };
}

function resizeRgba(source, targetSize) {
  const { width, height, pixels } = source;
  const out = Buffer.alloc(targetSize * targetSize * 4);
  const sxScale = width / targetSize;
  const syScale = height / targetSize;

  for (let y = 0; y < targetSize; y++) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) * syScale - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < targetSize; x++) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) * sxScale - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const dst = (y * targetSize + x) * 4;

      for (let c = 0; c < 4; c++) {
        const p00 = pixels[(y0 * width + x0) * 4 + c];
        const p10 = pixels[(y0 * width + x1) * 4 + c];
        const p01 = pixels[(y1 * width + x0) * 4 + c];
        const p11 = pixels[(y1 * width + x1) * 4 + c];
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        out[dst + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }

  return out;
}

function encodePng(size, pixels) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const source = decodePng(Buffer.from(SOURCE_BASE64, "base64"));

for (const size of [16, 32, 48, 128]) {
  const pixels = size === source.width && size === source.height
    ? source.pixels
    : resizeRgba(source, size);
  const png = encodePng(size, pixels);
  const filename = `icon${size}.png`;
  writeFileSync(path.join(outDir, filename), png);
  console.log(`wrote icons/${filename} (${png.length} bytes)`);
}
