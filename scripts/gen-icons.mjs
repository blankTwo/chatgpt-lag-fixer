// 生成简单的占位 PNG 图标（圆角实心方块 + 类似闪电的图形），尺寸 16/48/128 px。
// 纯 Node，无图像依赖：用 zlib 手写最小 PNG。作为占位足够用，后续可替换为正式素材。
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

// RGBA 像素绘制
function makePng(size) {
  const bg = [16, 163, 127]; // 接近 ChatGPT 的青绿色
  const fg = [255, 255, 255];
  const stride = size * 4 + 1; // 每行 +1 个 filter 字节
  const raw = Buffer.alloc(stride * size);
  const radius = Math.floor(size * 0.22);

  const inRounded = (x, y) => {
    // 圆角遮罩
    const corners = [
      [radius, radius],
      [size - radius, radius],
      [radius, size - radius],
      [size - radius, size - radius],
    ];
    if (x >= radius && x < size - radius) return true;
    if (y >= radius && y < size - radius) return true;
    for (const [cx, cy] of corners) {
      const dx = x < radius || x >= size - radius ? x - cx : 0;
      const dy = y < radius || y >= size - radius ? y - cy : 0;
      if (dx * dx + dy * dy <= radius * radius) return true;
    }
    return false;
  };

  // 在归一化坐标下对闪电形状做粗略的多边形判定。
  const inBolt = (x, y) => {
    const nx = x / size;
    const ny = y / size;
    // 两条错位的对角带，构成 Z/闪电形状
    const band1 = Math.abs(nx - (1.05 - ny)) < 0.14 && ny > 0.15 && ny < 0.6;
    const band2 = Math.abs(nx - (0.95 - ny)) < 0.14 && ny >= 0.4 && ny < 0.85;
    return band1 || band2;
  };

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter 类型 0
    for (let x = 0; x < size; x++) {
      const o = y * stride + 1 + x * 4;
      const rounded = inRounded(x, y);
      const bolt = inBolt(x, y);
      let color, alpha;
      if (!rounded) {
        color = [0, 0, 0];
        alpha = 0;
      } else if (bolt) {
        color = fg;
        alpha = 255;
      } else {
        color = bg;
        alpha = 255;
      }
      raw[o] = color[0];
      raw[o + 1] = color[1];
      raw[o + 2] = color[2];
      raw[o + 3] = alpha;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  const png = makePng(size);
  writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`wrote icons/icon${size}.png (${png.length} bytes)`);
}
