// 校验 extension/ 目录:manifest.json 合法,且其引用的所有文件都存在。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, "../extension");
const manifest = JSON.parse(readFileSync(path.join(extDir, "manifest.json"), "utf8"));

const refs = new Set();
const add = (p) => p && refs.add(p);

for (const k of ["16", "48", "128"]) add(manifest.icons?.[k]);
add(manifest.action?.default_popup);
for (const k of ["16", "48", "128"]) add(manifest.action?.default_icon?.[k]);
add(manifest.background?.service_worker);
for (const cs of manifest.content_scripts || []) for (const j of cs.js || []) add(j);
for (const war of manifest.web_accessible_resources || []) for (const r of war.resources || []) add(r);

// popup.html 引用的本地资源也检查一下
const popup = manifest.action?.default_popup;
if (popup && existsSync(path.join(extDir, popup))) {
  const html = readFileSync(path.join(extDir, popup), "utf8");
  const dir = path.dirname(popup);
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (!/^https?:/.test(m[1])) add(path.posix.join(dir, m[1]));
  }
}

let missing = 0;
for (const r of [...refs].sort()) {
  const ok = existsSync(path.join(extDir, r));
  console.log((ok ? "  ✅ " : "  ❌ 缺失 ") + r);
  if (!ok) missing++;
}
console.log(missing === 0 ? "\n全部引用文件存在 ✅" : `\n有 ${missing} 个引用文件缺失 ❌`);
process.exit(missing === 0 ? 0 : 1);
