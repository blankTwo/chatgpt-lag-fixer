// 把 @assemblyscript/loader 的 UMD 版本同步到 extension/vendor/as-loader.js。
// 它会挂到 window.loader，供 MAIN world 的 main-world.js 使用（无 import，避开 CSP）。
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, "../node_modules/@assemblyscript/loader/umd/index.js");
const dstDir = path.resolve(__dirname, "../extension/vendor");
const dst = path.join(dstDir, "as-loader.js");

mkdirSync(dstDir, { recursive: true });
copyFileSync(src, dst);
console.log("synced as-loader.js ->", dst);
